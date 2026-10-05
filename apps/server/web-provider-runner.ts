import { randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import type { ProviderCallSpec, ProviderMeter, ProviderObservation } from '../../packages/contracts/provider-calls.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { providerRequestHash } from '../../packages/domain/provider-request.ts';
import type { FishModel, SpeechRequest } from '../../packages/contracts/audio.ts';
import { FishAudio, fishSpeechRequest } from '../../workers/audio/fish.ts';
import { finalizeFishWav, inspectPCM, pcmLevels } from '../../workers/audio/wav.ts';
import { SpeechFailure } from '../../workers/audio/validation-error.ts';
import type { DeepSeekTextGenerator } from './deepseek.ts';
import type { WebSpeechWire } from '../../packages/contracts/web-generation-rpc.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import type { WebRuntimeStore as WebStore } from './web-store-contract.ts';
import { checkWebV7SceneAtDispatch, readWebV7Request } from './web-v7-request.ts';
import type { WebStageClaim, WebCoordinatorLease } from './web-stage-queue.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { WebVerticalPublisher } from './web-vertical-publisher.ts';
import { requireWebContent } from './web-retention.ts';
import type { WebAttemptBudget } from './web-provider-budget-contract.ts';
import type { ProviderAudioCache } from './web-provider-media.ts';

type Phase = 'draft' | 'review';
type Scope = { principalId: string; playerId: string; worldId: string;
  conversationId: string; characterId: string; inputMessageId: string };
export type FakeFish = (request: WebSpeechWire, signal: AbortSignal, authorize?: () => void | Promise<void>) =>
  Promise<{ audio: Uint8Array; receipt: unknown; usageUnits: number }>;
type WebTextGenerator = Pick<DeepSeekTextGenerator, 'textProtocol' | 'policyHash' |
  'generateAcceptedStages' | 'generateAcceptedReviewFromKnownDraft'>;

/** Explicit live adapter. Constructing it does not send or read credentials. */
export function fishTransport(audio: FishAudio): FakeFish {
  return async (request, signal) => {
    const prepared = fishSpeechRequest(request.speech, request.model);
    ensure(audio.model === request.model && prepared.body === request.body &&
      prepared.bytes === request.billedTextBytes &&
      prepared.requestHash === request.wireRequestHash,
    'WEB_PROVIDER_WIRE_MISMATCH');
    const result = await audio.generate(request.speech, signal);
    ensure(result.inputUTF8Bytes === request.billedTextBytes && result.model === request.model,
      'WEB_PROVIDER_USAGE_MISMATCH');
    return { audio: result.audio, receipt: { requestId: result.requestId,
      elapsedMs: result.elapsedMs, durationMs: result.durationMs,
      containerNormalization: result.containerNormalization ?? null },
      usageUnits: request.billedTextBytes };
  };
}

/** Schema113 memory-only business runner. Injected transports cannot write the database. */
export class WebProviderRunner {
  private readonly ledger: WebProviderOffline;
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly text: WebTextGenerator;
  private readonly fish: FakeFish;
  private readonly budget: WebAttemptBudget | undefined;
  private readonly recovery: Promise<void>;
  private recovered: boolean;
  constructor(store: Store, clock: Clock, text: WebTextGenerator, fish: FakeFish,
    budget?: WebAttemptBudget) {
    this.store = store; this.clock = clock; this.text = text; this.fish = fish;
    this.ledger = new WebProviderOffline(store, clock);
    this.budget = budget;
    const recovery = budget?.recoverKnown(store);
    this.recovered = recovery === undefined;
    this.recovery = Promise.resolve(recovery).then(() => { this.recovered = true; });
    // The owner may not start a runner immediately; whenReady/run* still observe the rejection.
    void this.recovery.catch(() => {});
  }
  whenReady() { return this.recovery; }
  private frozen(operationId: string) {
    const { request, row } = readWebV7Request(this.store as WebStore, operationId);
    const scope: Scope = { principalId: row.principal_id, playerId: row.player_id,
      worldId: row.world_id, conversationId: row.conversation_id,
      characterId: row.character_id, inputMessageId: row.input_message_id };
    return { request, row, scope };
  }
  async runText(claim: WebStageClaim, signal: AbortSignal) {
    await this.whenReady();
    ensure(claim.stage === 'text' && this.text.textProtocol === 'accepted-v7',
      'WEB_PROVIDER_STAGE_INVALID');
    const { request, row, scope } = this.frozen(claim.operationId);
    const draftKey = { operationId: claim.operationId, phase: 'draft' as const, ordinal: -1 };
    const reviewKey = { operationId: claim.operationId, phase: 'review' as const, ordinal: -1 };
    const draftState = this.ledger.attemptState(draftKey, scope);
    const reviewState = this.ledger.attemptState(reviewKey, scope);
    ensure((draftState === null || draftState === 'known') &&
      (reviewState === null || reviewState === 'known') &&
      (reviewState === null || draftState === 'known'), 'WEB_PROVIDER_RECOVERY_UNKNOWN');
    if (reviewState === 'known') {
      this.ledger.readKnownTextStage(draftKey, scope);
      this.ledger.readKnownTextStage(reviewKey, scope);
      return this.ledger.commitReviewed(claim, scope);
    }
    const knownDraft = draftState === 'known' ? this.ledger.readKnownTextStage(draftKey, scope) : null;
    const specs = new Map<Phase, ProviderCallSpec>();
    const observations = new Map<Phase, ProviderObservation>();
    const started = new Set<Phase>();
    const meter: ProviderMeter = { reserve: calls => {
      for (const call of calls) {
        ensure((call.stage === 'draft' || call.stage === 'review') && call.provider === 'deepseek' &&
          call.bounds.unit === 'tokens', 'WEB_PROVIDER_STAGE_INVALID');
        specs.set(call.stage, call);
      }
      return { start: async (stage, requestHash, requestBytes) => {
        ensure((stage === 'draft' || stage === 'review') && requestHash &&
          /^[a-f0-9]{64}$/.test(requestHash) && Number.isSafeInteger(requestBytes) &&
          requestBytes! > 0, 'WEB_PROVIDER_STAGE_INVALID');
        const spec = specs.get(stage);
        ensure(spec && spec.bounds.unit === 'tokens', 'WEB_PROVIDER_STAGE_INVALID');
        const key = { operationId: claim.operationId, phase: stage, ordinal: -1 };
        // Byte-level BPE never yields more prompt tokens than wire bytes (tools and messages are
        // inside the body); the 2^20 context ceiling stays as the outer bound.
        const maxUnits = Math.min(spec.bounds.inputTokens, requestBytes!) + spec.bounds.outputTokens;
        ensure(Number.isSafeInteger(maxUnits), 'WEB_PROVIDER_STAGE_INVALID');
        this.ledger.reserveForClaim(claim, { ...key, ...scope, requestDigest: row.request_digest,
          policyHash: this.text.policyHash, wireRequestHash: requestHash,
          voiceVersion: row.voice_version, provider: 'deepseek', model: spec.model, maxUnits });
        await this.budget?.beginAttempt(this.store, key);
        ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
        this.ledger.markSentForClaim(claim, key, scope);
        started.add(stage);
        return { finish: async observation => {
          observations.set(stage, observation);
          if (observation.outcome !== 'succeeded') {
            const usage = observation.usage;
            if (usage.unit === 'tokens' && usage.inputTokens !== null && usage.outputTokens !== null) {
              this.ledger.confirm(key, scope, { outcome: 'failed', receipt: observation,
                usageUnits: usage.inputTokens + usage.outputTokens });
              await this.budget?.settleAttempt(this.store, key);
            }
            else this.ledger.markUnknown(key, scope);
          }
        } };
      }, close: () => {} };
    } };
    const accept = async (stage: import('../../packages/contracts/index.ts').AcceptedV7StageOutput) => {
      const key = { operationId: claim.operationId, phase: stage.stage, ordinal: -1 };
      const observed = observations.get(stage.stage);
      ensure(stage.jobId === claim.operationId && stage.requestDigest === row.request_digest &&
        stage.policyHash === this.text.policyHash && observed?.outcome === 'succeeded' &&
        observed.usage.unit === 'tokens' && observed.usage.inputTokens !== null &&
        observed.usage.outputTokens !== null, 'WEB_PROVIDER_STAGE_UNCONFIRMED');
      const attempt = this.store.get<{ wire_request_hash: string }>(`SELECT wire_request_hash
        FROM web_provider_attempts WHERE operation_id=? AND phase=? AND ordinal=-1`,
      claim.operationId, stage.stage);
      ensure(attempt?.wire_request_hash === stage.wireRequestHash,
        'WEB_PROVIDER_STAGE_UNCONFIRMED');
      this.ledger.confirm(key, scope, { outcome: 'succeeded', receipt: observed,
        usageUnits: observed.usage.inputTokens + observed.usage.outputTokens,
        output: stage.payload, metadata: stage.metadata });
      await this.budget?.settleAttempt(this.store, key);
    };
    try {
      if (knownDraft) await this.text.generateAcceptedReviewFromKnownDraft(request, signal,
        knownDraft, accept, meter);
      else await this.text.generateAcceptedStages(request, signal, accept, meter);
    } catch (error) {
      for (const phase of started) {
        const key = { operationId: claim.operationId, phase, ordinal: -1 };
        if (this.ledger.attemptState(key, scope) === 'sent') this.ledger.markUnknown(key, scope);
      }
      throw error;
    }
    return this.ledger.commitReviewed(claim, scope);
  }
  async runSpeech(claim: WebStageClaim, signal: AbortSignal) {
    await this.whenReady();
    ensure(claim.stage === 'audio' && Number.isSafeInteger(claim.ordinal),
      'WEB_PROVIDER_STAGE_INVALID');
    const { row, scope } = this.frozen(claim.operationId);
    const voice = this.store.get<{ voice_version: string; voice_revision: number; profile_id: string;
      reference_id: string; model: FishModel; approved: number; source: string }>(
      'SELECT * FROM web_provider_voice_bindings WHERE character_id=?', scope.characterId);
    ensure(voice?.approved === 1 &&
      ['synthetic_fixture','user_selected'].includes(voice.source) &&
      ['s2.1-pro','s2-pro'].includes(voice.model) &&
      voice.voice_version === row.voice_version && claim.voiceVersion === row.voice_version,
    'WEB_PROVIDER_VOICE_UNAPPROVED');
    const key = { operationId: claim.operationId, phase: 'speech' as const, ordinal: claim.ordinal! };
    const state = this.ledger.attemptState(key, scope);
    ensure(state === null || state === 'known', 'WEB_PROVIDER_RECOVERY_UNKNOWN');
    const audioCache: ProviderAudioCache = new Map();
    if (state === 'known') {
      if ((this.store as WebStore).providerAudio) await this.ledger.loadKnownAudio(key, scope, audioCache);
      return this.ledger.attachKnownSpeech(claim, scope, audioCache);
    }
    const candidate = this.store.get<{ candidate_json: string }>(
      'SELECT candidate_json FROM web_provider_candidates WHERE operation_id=?', claim.operationId);
    ensure(candidate, 'WEB_PROVIDER_CANDIDATE_INVALID');
    const bubble = (JSON.parse(candidate.candidate_json) as {
      bubbles: { text: string; expression: SpeechRequest['expression'] }[] }).bubbles[key.ordinal];
    ensure(bubble && typeof bubble.text === 'string', 'WEB_PROVIDER_CANDIDATE_INVALID');
    const deliveryStyle = checkWebV7SceneAtDispatch(this.store as WebStore,
      claim.operationId, this.clock.now());
    const speech: SpeechRequest = { jobId: `${claim.operationId}-${key.ordinal}`,
      text: bubble.text, expression: bubble.expression, speed: 1,
      voice: { profileId: voice.profile_id, referenceId: voice.reference_id,
        version: voice.voice_revision }, model: voice.model,
      // The user heard and selected these voices with Fish quality-guard on (verified on import).
      ...(voice.source === 'user_selected' ? { qualityGuard: true } : {}),
      deliveryStyle };
    const prepared = fishSpeechRequest(speech, voice.model);
    const { body, bytes: maxUnits, requestHash: wireRequestHash } = prepared;
    this.ledger.reserveForClaim(claim, { ...key, ...scope, requestDigest: row.request_digest,
      policyHash: providerRequestHash('fish://offline-policy', voice.model,
        JSON.stringify([voice.profile_id, voice.reference_id, voice.voice_version])),
      wireRequestHash, voiceVersion: row.voice_version, provider: 'fish', model: voice.model,
      maxUnits });
    await this.budget?.beginAttempt(this.store, key);
    ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
    // markSentForClaim rechecks lease, entitlement, input and scene after the remote await.
    this.ledger.markSentForClaim(claim, key, scope);
    let knownReceipt: { providerReceipt: unknown; usageUnits: number } | undefined;
    let storingAudio = false;
    try {
      const result = await this.fish({ body, wireRequestHash, model: voice.model,
        billedTextBytes: maxUnits, speech }, signal, () => {
        ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
        this.ledger.validateSentForClaim(claim, key, scope);
      });
      ensure(result.usageUnits === maxUnits, 'WEB_PROVIDER_USAGE_MISMATCH');
      knownReceipt = { providerReceipt: result.receipt, usageUnits: result.usageUnits };
      const { audio } = finalizeFishWav(result.audio);
      const info = inspectPCM(audio, 60_000);
      ensure(info.channels === 1 && info.sampleRate === 24000 &&
        pcmLevels(audio).rms > 0.00001, 'WEB_PROVIDER_AUDIO_INVALID');
      storingAudio = true;
      const audioReference = await this.ledger.stageAudio(key, scope, audio);
      storingAudio = false;
      this.ledger.confirm(key, scope, { outcome: 'succeeded', receipt: result.receipt,
        usageUnits: result.usageUnits, output: audio, spokenText: bubble.text,
        ...(audioReference ? { audioReference } : {}) });
      await this.budget?.settleAttempt(this.store, key);
    } catch (error) {
      // A complete but rejected provider response is still a known bill. Network failures
      // without bounded usage remain UNKNOWN; neither case permits regeneration.
      if (error instanceof SpeechFailure && error.generation.model === voice.model &&
        error.generation.inputUTF8Bytes === maxUnits &&
        error.generation.inputCharacters === [...bubble.text].length)
        knownReceipt = { providerReceipt: error.generation, usageUnits: maxUnits };
      if (knownReceipt && ['sent','unknown'].includes(this.ledger.attemptState(key, scope)!)) {
        this.ledger.confirm(key, scope, { outcome: 'failed', receipt: {
          providerReceipt: knownReceipt.providerReceipt, failure: storingAudio ? 'WEB_AUDIO_STORAGE_FAILED' :
            error instanceof DomainError ? error.code : 'WEB_PROVIDER_AUDIO_INVALID',
        }, usageUnits: knownReceipt.usageUnits });
        await this.budget?.settleAttempt(this.store, key);
      }
      if (this.ledger.attemptState(key, scope) === 'sent') this.ledger.markUnknown(key, scope);
      throw error;
    }
    if ((this.store as WebStore).providerAudio) await this.ledger.loadKnownAudio(key, scope, audioCache);
    return this.ledger.attachKnownSpeech(claim, scope, audioCache);
  }
  private publication(operationId: string) {
    ensure(this.recovered, 'WEB_SHARED_RECOVERY_PENDING');
    const { row, scope } = this.frozen(operationId);
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    const prior = this.store.get<{ receipt_json: string }>(`SELECT receipt_json FROM web_publications
      WHERE operation_id=? AND principal_id=? AND player_id=? AND world_id=?
        AND conversation_id=? AND character_id=? AND input_message_id=?`,
    operationId, scope.principalId, scope.playerId, scope.worldId, scope.conversationId,
    scope.characterId, scope.inputMessageId);
    const receipt = prior ? JSON.parse(prior.receipt_json) as { operationId: string;
      messageIds: string[]; footerMessageId: string | null } : null;
    const ordinals = this.store.all<{ ordinal: number }>(`SELECT ordinal FROM web_provider_voice_segments
      WHERE operation_id=? ORDER BY ordinal`, operationId).map(item => item.ordinal);
    return { receipt, ordinals, row, scope };
  }
  publish(coordinator: WebCoordinatorLease, operationId: string) {
    const { receipt, ordinals, row, scope } = this.publication(operationId);
    if (receipt) return receipt;
    this.ledger.validatePublication(operationId, scope, ordinals, row.voice_version);
    const publisher = new WebVerticalPublisher(this.store as WebStore, this.clock, randomUUID);
    return publisher.publish(publisher.claim(coordinator, operationId, 'provider-publisher'));
  }
  async publishAsync(coordinator: WebCoordinatorLease, operationId: string) {
    await this.whenReady();
    const { receipt, ordinals, row, scope } = this.publication(operationId);
    if (receipt) return receipt;
    const audio: ProviderAudioCache = new Map();
    if ((this.store as WebStore).providerAudio) for (const ordinal of ordinals)
      await this.ledger.loadKnownAudio({ operationId, phase: 'speech', ordinal }, scope, audio);
    this.ledger.validatePublication(operationId, scope, ordinals, row.voice_version, audio);
    const publisher = new WebVerticalPublisher(this.store as WebStore, this.clock, randomUUID);
    return publisher.publishAsync(publisher.claim(coordinator, operationId, 'provider-publisher'), audio);
  }
}
