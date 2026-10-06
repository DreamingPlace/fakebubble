import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Clock,
  DialogueCandidate,
  TextGenerationRequest,
  TextGenerationStage,
} from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { inspectPCM } from '../../../workers/audio/wav.ts';
import { parseTextDraft, applyTextReview, protocolFingerprint } from './accepted-text-protocol.ts';
import { textPromptHash } from './accepted-text-prompt.ts';
import { requireWebContent, webCloudContentExpired } from '../admission/web-retention.ts';
import type { WebStageClaim } from '../admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../budget/web-dispatch-ledger.ts';
import { requireWebRuntime, type WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { requireCurrentInputSnapshot } from './web-input-snapshot.ts';
import { checkWebV7SceneAtDispatch } from './web-v7-request.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../conversation/web-vertical-publisher.ts';
import { webWelcomeLine } from '../characters/web-character-catalog.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import type { MediaObjectReference } from '../cloudflare/media-objects.ts';
import {
  checkAudioReference,
  fixedObjectScope,
  loadProviderAudio,
  providerAudioBytes,
  speechObjectScope,
  type ProviderAudioCache,
  type ProviderAudioRow,
} from '../audio/web-provider-media.ts';

type Phase = 'draft' | 'review' | 'speech';
type Scope = {
  principalId: string;
  playerId: string;
  worldId: string;
  conversationId: string;
  characterId: string;
  inputMessageId: string;
};
type Key = { operationId: string; phase: Phase; ordinal: number };
type Reserve = Key &
  Scope & {
    requestDigest: string;
    policyHash: string;
    wireRequestHash: string;
    voiceVersion: string;
    provider: string;
    model: string;
    maxUnits: number;
  };
type Attempt = {
  operation_id: string;
  phase: Phase;
  ordinal: number;
  principal_id: string;
  player_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  request_digest: string;
  policy_hash: string;
  wire_request_hash: string;
  voice_version: string;
  provider: string;
  model: string;
  price_id: string;
  max_units: number;
  held_micros: number;
  stage_version: number | null;
  lease_epoch: number | null;
  lease_token: string | null;
  state: string;
  outcome: string | null;
  usage_units: number | null;
  charged_micros: number | null;
  receipt_json: string | null;
  metadata_json: string | null;
  output_digest: string | null;
  output_proof?: string | null;
};
type Price = { id: string; upper_micros_per_unit: number; unit: string };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const digest = (value: string) => /^[a-f0-9]{64}$/.test(value);
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const scopeArgs = (scope: Scope) =>
  [
    scope.principalId,
    scope.playerId,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
    scope.inputMessageId,
  ] as const;
const sameScope = (attempt: Attempt, scope: Scope) =>
  attempt.principal_id === scope.principalId &&
  attempt.player_id === scope.playerId &&
  attempt.world_id === scope.worldId &&
  attempt.conversation_id === scope.conversationId &&
  attempt.character_id === scope.characterId &&
  attempt.input_message_id === scope.inputMessageId;

/** Offline provenance and conservative USD upper-bound ledger; not a real provider runner. */
export class WebProviderOffline {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly capacity: WebDispatchLedger;
  constructor(store: Store, clock: Clock) {
    this.store = store;
    this.clock = clock;
    this.check();
    this.capacity = new WebDispatchLedger(store as WebStore, clock);
  }
  private check() {
    requireWebRuntime(this.store, 'provider');
    ensure(
      this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 113,
      'WEB_PROVIDER_MIGRATION_REQUIRED',
    );
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private attempt(key: Key) {
    const row = this.store.get<Attempt>(
      `SELECT * FROM web_provider_attempts
      WHERE operation_id=? AND phase=? AND ordinal=?`,
      key.operationId,
      key.phase,
      key.ordinal,
    );
    ensure(row, 'WEB_PROVIDER_ATTEMPT_NOT_FOUND');
    return row;
  }
  private liveClaim(claim: WebStageClaim, scope: Scope) {
    const now = this.now();
    ensure(
      claim.principalId === scope.principalId &&
        claim.worldId === scope.worldId &&
        claim.conversationId === scope.conversationId &&
        claim.characterId === scope.characterId &&
        claim.inputMessageId === scope.inputMessageId,
      'WEB_PROVIDER_CLAIM_STALE',
    );
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    ensure(
      this.store.get(
        `SELECT 1 FROM web_operations o JOIN web_principals p
      ON p.id=o.principal_id AND p.world_id=o.world_id
      JOIN web_scheduler_state s ON s.singleton=1
      WHERE o.id=? AND o.principal_id=? AND p.player_id=? AND o.world_id=?
        AND o.conversation_id=? AND o.character_id=? AND o.input_message_id=?
        AND o.status=? AND o.stage_version=? AND o.lease_epoch=? AND o.lease_token=?
        AND o.lease_owner=? AND o.lease_expires_at>? AND o.deadline_at>?
        AND s.epoch=? AND s.coordinator_token IS NOT NULL AND s.coordinator_expires_at>?`,
        claim.operationId,
        ...scopeArgs(scope),
        claim.stage === 'text' ? 'text_running' : 'audio_running',
        claim.stageVersion,
        claim.epoch,
        claim.token,
        claim.owner,
        now,
        now,
        claim.epoch,
        now,
      ),
      'WEB_PROVIDER_CLAIM_STALE',
    );
    if (claim.stage === 'audio')
      ensure(
        this.store.get(
          `SELECT 1 FROM web_provider_voice_segments
      WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?
        AND claim_epoch=? AND claim_token=? AND text_digest=? AND voice_version=?`,
          claim.operationId,
          claim.ordinal!,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.textDigest!,
          claim.voiceVersion!,
        ),
        'WEB_PROVIDER_CLAIM_STALE',
      );
  }
  configureBudget(provider: string, limitMicros: number | null) {
    this.check();
    ensure(
      /^[A-Za-z0-9_-]{1,128}$/.test(provider) &&
        (limitMicros === null
          ? !!(this.store as WebStore).providerAudio
          : positive(limitMicros) && limitMicros <= 3_000_000),
      'WEB_PROVIDER_BUDGET_INVALID',
    );
    this.store.transaction(() => {
      const prior = this.store.get<{ limit_micros: number | null }>(
        'SELECT limit_micros FROM web_provider_spending WHERE provider=?',
        provider,
      );
      if (prior) ensure(prior.limit_micros === limitMicros, 'WEB_PROVIDER_BUDGET_CONFLICT');
      else
        this.store.run(
          "INSERT INTO web_provider_spending(provider,currency,limit_micros) VALUES (?,'USD',?)",
          provider,
          limitMicros,
        );
    });
  }
  configurePrice(input: {
    id: string;
    provider: string;
    model: string;
    phase: Phase;
    currency: 'USD';
    unit: 'token' | 'byte' | 'call';
    upperMicrosPerUnit: number;
    validFrom: number;
    validUntil: number;
    version: number;
  }) {
    this.check();
    ensure(
      /^[A-Za-z0-9_.:-]{1,128}$/.test(input.id) &&
        /^[A-Za-z0-9_.:-]{1,128}$/.test(input.model) &&
        ['draft', 'review', 'speech'].includes(input.phase) &&
        input.currency === 'USD' &&
        ['token', 'byte', 'call'].includes(input.unit) &&
        positive(input.upperMicrosPerUnit) &&
        Number.isSafeInteger(input.validFrom) &&
        input.validFrom >= 0 &&
        Number.isSafeInteger(input.validUntil) &&
        input.validUntil > input.validFrom &&
        positive(input.version),
      'WEB_PROVIDER_PRICE_INVALID',
    );
    this.store.transaction(() => {
      ensure(
        this.store.get('SELECT 1 FROM web_provider_spending WHERE provider=?', input.provider),
        'WEB_PROVIDER_BUDGET_REQUIRED',
      );
      ensure(
        !this.store.get(
          `SELECT 1 FROM web_provider_prices WHERE provider=? AND model=? AND phase=?
        AND valid_from<? AND valid_until>?`,
          input.provider,
          input.model,
          input.phase,
          input.validUntil,
          input.validFrom,
        ),
        'WEB_PROVIDER_PRICE_OVERLAP',
      );
      this.store.run(
        `INSERT INTO web_provider_prices VALUES (?,?,?,?,?,?,?,?,?,?)`,
        input.id,
        input.provider,
        input.model,
        input.phase,
        input.currency,
        input.unit,
        input.upperMicrosPerUnit,
        input.validFrom,
        input.validUntil,
        input.version,
      );
    });
  }
  configureVoice(input: {
    characterId: string;
    voiceVersion: string;
    voiceRevision: number;
    profileId: string;
    referenceId: string;
    model: 's2.1-pro' | 's2-pro';
    approved: true;
  }) {
    this.check();
    ensure(
      input.approved === true &&
        [input.characterId, input.voiceVersion, input.profileId, input.referenceId, input.model].every(
          (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value),
        ) &&
        Number.isSafeInteger(input.voiceRevision) &&
        input.voiceRevision > 0 &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.profileId) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.referenceId) &&
        ['s2.1-pro', 's2-pro'].includes(input.model),
      'WEB_PROVIDER_VOICE_UNAPPROVED',
    );
    this.store.transaction(() => {
      ensure(
        this.store.get('SELECT 1 FROM character_templates WHERE id=?', input.characterId),
        'WEB_CHARACTER_UNAVAILABLE',
      );
      const prior = this.store.get<{
        voice_version: string;
        voice_revision: number;
        profile_id: string;
        reference_id: string;
        model: string;
      }>('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', input.characterId);
      if (prior)
        ensure(
          prior.voice_version === input.voiceVersion &&
            prior.voice_revision === input.voiceRevision &&
            prior.profile_id === input.profileId &&
            prior.reference_id === input.referenceId &&
            prior.model === input.model,
          'WEB_PROVIDER_VOICE_CONFLICT',
        );
      else
        this.store.run(
          `INSERT INTO web_provider_voice_bindings VALUES (?,?,?,?,?,?,'synthetic_fixture',1,NULL)`,
          input.characterId,
          input.voiceVersion,
          input.voiceRevision,
          input.profileId,
          input.referenceId,
          input.model,
        );
    });
  }
  reserve(input: Reserve) {
    this.check();
    ensure(
      ['draft', 'review', 'speech'].includes(input.phase) &&
        (input.phase === 'speech' ? Number.isSafeInteger(input.ordinal) && input.ordinal >= 0 : input.ordinal === -1) &&
        [input.requestDigest, input.policyHash, input.wireRequestHash].every(digest) &&
        positive(input.maxUnits) &&
        input.voiceVersion.length > 0,
      'WEB_PROVIDER_RESERVATION_INVALID',
    );
    return this.store.transaction(() => {
      const now = this.now();
      requireWebContent(this.store, this.clock, input.principalId, input.worldId);
      const op = this.store.get<{ request_digest: string; voice_version: string }>(
        `SELECT r.request_digest,r.voice_version
        FROM web_operations o JOIN web_v7_requests r ON r.operation_id=o.id
        JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
        WHERE o.id=? AND o.principal_id=? AND p.player_id=? AND o.world_id=? AND o.conversation_id=?
          AND o.character_id=? AND o.input_message_id=? AND r.principal_id=? AND r.player_id=?
          AND r.world_id=? AND r.conversation_id=? AND r.character_id=? AND r.input_message_id=?
          AND o.deadline_at>? AND o.status NOT IN ('published','cancelled','failed')`,
        input.operationId,
        ...scopeArgs(input),
        ...scopeArgs(input),
        now,
      );
      ensure(
        op && op.request_digest === input.requestDigest && op.voice_version === input.voiceVersion,
        'WEB_PROVIDER_SCOPE_INVALID',
      );
      const prior = this.store.get<Attempt>(
        `SELECT * FROM web_provider_attempts WHERE operation_id=? AND phase=? AND ordinal=?`,
        input.operationId,
        input.phase,
        input.ordinal,
      );
      if (prior) {
        ensure(
          sameScope(prior, input) &&
            prior.request_digest === input.requestDigest &&
            prior.policy_hash === input.policyHash &&
            prior.wire_request_hash === input.wireRequestHash &&
            prior.voice_version === input.voiceVersion &&
            prior.provider === input.provider &&
            prior.model === input.model &&
            prior.max_units === input.maxUnits,
          'WEB_PROVIDER_ATTEMPT_CONFLICT',
        );
        return { duplicate: true as const, heldMicros: prior.held_micros };
      }
      const price = this.store.get<Price>(
        `SELECT id,upper_micros_per_unit,unit FROM web_provider_prices
        WHERE provider=? AND model=? AND phase=? AND currency='USD' AND valid_from<=? AND valid_until>?`,
        input.provider,
        input.model,
        input.phase,
        now,
        now,
      );
      ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
      const held = price.upper_micros_per_unit * input.maxUnits;
      ensure(
        positive(held) &&
          this.store.run(
            `UPDATE web_provider_spending SET held_micros=held_micros+?
        WHERE provider=? AND currency='USD' AND (limit_micros IS NULL OR held_micros+spent_micros+?<=limit_micros)
        AND held_micros<=?-spent_micros-?`,
            held,
            input.provider,
            held,
            Number.MAX_SAFE_INTEGER,
            held,
          ).changes === 1,
        'WEB_PROVIDER_BUDGET_EXHAUSTED',
      );
      this.store.run(
        `INSERT INTO web_provider_attempts(operation_id,phase,ordinal,principal_id,player_id,
        world_id,conversation_id,character_id,input_message_id,request_digest,policy_hash,
        wire_request_hash,voice_version,provider,model,price_id,max_units,held_micros,state,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'not_sent',?)`,
        input.operationId,
        input.phase,
        input.ordinal,
        ...scopeArgs(input),
        input.requestDigest,
        input.policyHash,
        input.wireRequestHash,
        input.voiceVersion,
        input.provider,
        input.model,
        price.id,
        input.maxUnits,
        held,
        now,
      );
      return { duplicate: false as const, heldMicros: held };
    });
  }
  /** Stage lease, active grant and monetary hold share the same SQLite write transaction. */
  reserveForClaim(claim: WebStageClaim, input: Reserve) {
    this.check();
    ensure(
      claim.operationId === input.operationId &&
        (claim.stage === 'text'
          ? input.phase !== 'speech' && input.ordinal === -1
          : input.phase === 'speech' && claim.ordinal === input.ordinal && claim.voiceVersion === input.voiceVersion),
      'WEB_PROVIDER_CLAIM_STALE',
    );
    return this.store.transaction(() => {
      this.liveClaim(claim, input);
      const reserved = this.reserve(input);
      if (!reserved.duplicate) {
        this.capacity.reserve(claim, {
          phase: input.phase,
          ordinal: input.ordinal,
          provider: input.provider,
          providerRequestId: `${input.operationId}:${input.phase}:${input.ordinal}`,
        });
        this.store.run(
          `UPDATE web_provider_attempts SET stage_version=?,
          lease_epoch=?,lease_token=? WHERE operation_id=? AND phase=? AND ordinal=?
            AND state='not_sent' AND stage_version IS NULL`,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          input.operationId,
          input.phase,
          input.ordinal,
        );
      }
      return reserved;
    });
  }
  markSentForClaim(claim: WebStageClaim, key: Key, scope: Scope) {
    this.check();
    return this.store.transaction(() => {
      this.liveClaim(claim, scope);
      const row = this.attempt(key);
      ensure(
        row.stage_version === claim.stageVersion && row.lease_epoch === claim.epoch && row.lease_token === claim.token,
        'WEB_PROVIDER_CLAIM_STALE',
      );
      this.capacity.markSent(claim, {
        operationId: key.operationId,
        stage: claim.stage,
        phase: key.phase,
        ordinal: key.ordinal,
      });
      this.markSent(key, scope);
    });
  }
  markSent(key: Key, scope: Scope) {
    this.check();
    return this.store.transaction(() => {
      const row = this.attempt(key);
      ensure(sameScope(row, scope) && row.state === 'not_sent', 'WEB_PROVIDER_SCOPE_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_provider_attempts SET state='sent',sent_at=?
        WHERE operation_id=? AND phase=? AND ordinal=? AND state='not_sent'`,
          this.now(),
          key.operationId,
          key.phase,
          key.ordinal,
        ).changes === 1,
        'WEB_PROVIDER_ATTEMPT_STALE',
      );
    });
  }
  /** Private remote transports recheck the original lease after their RPC await, without resending the intent. */
  validateSentForClaim(claim: WebStageClaim, key: Key, scope: Scope) {
    this.check();
    return this.store.transaction(() => {
      this.liveClaim(claim, scope);
      const row = this.attempt(key);
      ensure(
        sameScope(row, scope) &&
          row.state === 'sent' &&
          row.stage_version === claim.stageVersion &&
          row.lease_epoch === claim.epoch &&
          row.lease_token === claim.token,
        'WEB_PROVIDER_CLAIM_STALE',
      );
      requireCurrentInputSnapshot(this.store as WebStore, {
        operation_id: key.operationId,
        principal_id: scope.principalId,
        world_id: scope.worldId,
        conversation_id: scope.conversationId,
        character_id: scope.characterId,
        input_message_id: scope.inputMessageId,
      });
      if (claim.stage === 'audio') checkWebV7SceneAtDispatch(this.store as WebStore, key.operationId, this.now());
    });
  }
  markUnknown(key: Key, scope: Scope) {
    this.check();
    return this.store.transaction(() => {
      const row = this.attempt(key);
      ensure(sameScope(row, scope) && (row.state === 'sent' || row.state === 'unknown'), 'WEB_PROVIDER_SCOPE_INVALID');
      if (row.state === 'sent')
        this.store.run(
          `UPDATE web_provider_attempts SET state='unknown'
        WHERE operation_id=? AND phase=? AND ordinal=?`,
          key.operationId,
          key.phase,
          key.ordinal,
        );
    });
  }
  /** Release only a reservation proven never to have crossed the dispatch boundary. */
  releaseUnsent(key: Key, scope: Scope) {
    this.check();
    return this.store.transaction(() => {
      const row = this.attempt(key);
      ensure(sameScope(row, scope) && row.state === 'not_sent', 'WEB_PROVIDER_ATTEMPT_STALE');
      if (row.stage_version !== null)
        this.capacity.abandonProviderUnsent(
          {
            operationId: key.operationId,
            stage: key.phase === 'speech' ? 'audio' : 'text',
            phase: key.phase,
            ordinal: key.ordinal,
          },
          {
            principalId: scope.principalId,
            worldId: scope.worldId,
            conversationId: scope.conversationId,
            inputMessageId: scope.inputMessageId,
          },
        );
      ensure(
        this.store.run(
          `UPDATE web_provider_attempts SET state='known',outcome='not_dispatched',
        usage_units=0,charged_micros=0,receipt_json='{}',settled_at=?
        WHERE operation_id=? AND phase=? AND ordinal=? AND state='not_sent'`,
          this.now(),
          key.operationId,
          key.phase,
          key.ordinal,
        ).changes === 1,
        'WEB_PROVIDER_ATTEMPT_STALE',
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros-?
        WHERE provider=? AND held_micros>=?`,
          row.held_micros,
          row.provider,
          row.held_micros,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_CONFLICT',
      );
    });
  }
  confirm(
    key: Key,
    scope: Scope,
    result: {
      outcome: 'succeeded' | 'failed';
      receipt: unknown;
      usageUnits: number;
      output?: unknown;
      spokenText?: string;
      metadata?: TextGenerationStage;
      audioReference?: MediaObjectReference;
    },
  ) {
    this.check();
    ensure(
      Number.isSafeInteger(result.usageUnits) && result.usageUnits >= 0 && result.receipt !== undefined,
      'WEB_PROVIDER_RECEIPT_INVALID',
    );
    return this.store.transaction(() => {
      const row = this.attempt(key);
      ensure(sameScope(row, scope), 'WEB_PROVIDER_SCOPE_INVALID');
      const receipt = JSON.stringify(result.receipt);
      const metadata = result.metadata === undefined ? null : JSON.stringify(result.metadata);
      ensure(receipt !== undefined && receipt.length <= 262_144, 'WEB_PROVIDER_RECEIPT_INVALID');
      ensure(metadata === null || metadata.length <= 16_384, 'WEB_PROVIDER_RECEIPT_INVALID');
      if (row.stage_version !== null && key.phase !== 'speech' && result.outcome === 'succeeded')
        ensure(
          result.metadata?.stage === key.phase &&
            result.metadata.status === 'succeeded' &&
            result.metadata.model === row.model,
          'WEB_PROVIDER_RECEIPT_INVALID',
        );
      const body =
        key.phase === 'speech'
          ? result.output instanceof Uint8Array
            ? Buffer.from(result.output)
            : null
          : result.output === undefined
            ? null
            : JSON.stringify(result.output);
      if (result.outcome === 'succeeded')
        ensure(
          body && (typeof body === 'string' ? body.length <= 262_144 : body.length <= 6_000_000),
          'WEB_PROVIDER_OUTPUT_INVALID',
        );
      else ensure(result.output === undefined, 'WEB_PROVIDER_OUTPUT_INVALID');
      ensure(
        key.phase === 'speech' && result.outcome === 'succeeded'
          ? typeof result.spokenText === 'string' && result.spokenText.length > 0 && result.spokenText.length <= 2000
          : result.spokenText === undefined,
        'WEB_PROVIDER_OUTPUT_INVALID',
      );
      if (key.phase === 'speech' && body instanceof Buffer) {
        const info = inspectPCM(body, 60_000);
        ensure(info.channels === 1 && info.sampleRate === 24_000, 'WEB_PROVIDER_OUTPUT_INVALID');
      }
      const outputDigest = body ? hash(body) : null;
      const cloud = !!(this.store as WebStore).providerAudio;
      const expired =
        webCharacterDeleted(this.store, scope.characterId) ||
        webCloudContentExpired(this.store, this.now(), scope.principalId, scope.worldId);
      const proofEnabled =
        cloud || !!this.store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletion_schema'");
      const proof = proofEnabled
        ? (this.store as WebStore).webReceiptDigest(
            'receipt',
            JSON.stringify([outputDigest, result.spokenText ?? null]),
          )
        : null;
      const externalAudio = body instanceof Buffer && !!(this.store as WebStore).providerAudio;
      ensure(externalAudio === (result.audioReference !== undefined), 'WEB_AUDIO_REFERENCE_INVALID');
      if (result.audioReference)
        checkAudioReference(
          result.audioReference,
          speechObjectScope(this.store as WebStore, key.operationId, key.ordinal, scope),
          body as Buffer,
        );
      if (row.state === 'known') {
        const saved = this.store.get<{ spoken_text: string | null }>(
          `SELECT spoken_text FROM web_provider_outputs WHERE operation_id=? AND phase=? AND ordinal=?`,
          key.operationId,
          key.phase,
          key.ordinal,
        );
        ensure(
          row.outcome === result.outcome &&
            row.usage_units === result.usageUnits &&
            row.receipt_json === receipt &&
            row.metadata_json === metadata &&
            row.output_digest === outputDigest &&
            (proofEnabled
              ? row.output_proof === proof
              : result.outcome === 'succeeded'
                ? saved?.spoken_text === (result.spokenText ?? null)
                : !saved),
          'WEB_PROVIDER_RECEIPT_CONFLICT',
        );
        return { duplicate: true as const, chargedMicros: row.charged_micros! };
      }
      ensure(row.state === 'sent' || row.state === 'unknown', 'WEB_PROVIDER_ATTEMPT_STALE');
      const price = this.store.get<Price>(
        `SELECT id,upper_micros_per_unit,unit FROM web_provider_prices WHERE id=?`,
        row.price_id,
      );
      ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
      const charge = result.usageUnits * price.upper_micros_per_unit;
      ensure(
        Number.isSafeInteger(charge) && charge >= 0 && result.usageUnits <= row.max_units && charge <= row.held_micros,
        'WEB_PROVIDER_CHARGE_EXCEEDS_HOLD',
      );
      if (body && !expired)
        this.store.run(
          `INSERT INTO web_provider_outputs(operation_id,phase,ordinal,payload_json,
        audio_bytes,spoken_text,sha256,provider,model,request_digest,policy_hash,wire_request_hash,voice_version
        ${externalAudio ? ',audio_ref_json' : ''}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?${externalAudio ? ',?' : ''})`,
          key.operationId,
          key.phase,
          key.ordinal,
          typeof body === 'string' ? body : null,
          body instanceof Buffer && !externalAudio ? body : null,
          result.spokenText ?? null,
          outputDigest!,
          row.provider,
          row.model,
          row.request_digest,
          row.policy_hash,
          row.wire_request_hash,
          row.voice_version,
          ...(externalAudio ? [JSON.stringify(result.audioReference)] : []),
        );
      this.store.run(
        `UPDATE web_provider_attempts SET state='known',outcome=?,usage_units=?,
        charged_micros=?,receipt_json=?,metadata_json=?,output_digest=?,settled_at=?${proofEnabled ? ',output_proof=?' : ''}
        WHERE operation_id=? AND phase=? AND ordinal=? AND state IN ('sent','unknown')`,
        result.outcome,
        result.usageUnits,
        charge,
        receipt,
        metadata,
        outputDigest,
        this.now(),
        ...(proofEnabled ? [proof] : []),
        key.operationId,
        key.phase,
        key.ordinal,
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros-?,
        spent_micros=spent_micros+? WHERE provider=? AND held_micros>=?`,
          row.held_micros,
          charge,
          row.provider,
          row.held_micros,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_CONFLICT',
      );
      if (row.stage_version !== null)
        this.capacity.confirm(
          {
            operationId: key.operationId,
            stage: key.phase === 'speech' ? 'audio' : 'text',
            phase: key.phase,
            ordinal: key.ordinal,
          },
          { outcome: result.outcome, receipt: result.receipt, usage: { units: result.usageUnits } },
        );
      return { duplicate: false as const, chargedMicros: charge };
    });
  }
  private knownOutput(key: Key, scope: Scope) {
    this.check();
    const row = this.attempt(key);
    ensure(
      sameScope(row, scope) && row.state === 'known' && row.outcome === 'succeeded' && row.output_digest,
      'WEB_PROVIDER_OUTPUT_UNAVAILABLE',
    );
    ensure(
      this.store.get(
        `SELECT 1 FROM web_operations o JOIN web_v7_requests r ON r.operation_id=o.id
      JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
      WHERE o.id=? AND o.principal_id=? AND p.player_id=? AND o.world_id=? AND o.conversation_id=?
        AND o.character_id=? AND o.input_message_id=? AND r.principal_id=? AND r.player_id=?
        AND r.world_id=? AND r.conversation_id=? AND r.character_id=? AND r.input_message_id=?
        AND r.request_digest=? AND r.voice_version=?`,
        key.operationId,
        ...scopeArgs(scope),
        ...scopeArgs(scope),
        row.request_digest,
        row.voice_version,
      ),
      'WEB_PROVIDER_OUTPUT_UNAVAILABLE',
    );
    const output = this.store.get<
      ProviderAudioRow & {
        payload_json: string | null;
        sha256: string;
        provider: string;
        model: string;
        request_digest: string;
        policy_hash: string;
        wire_request_hash: string;
        voice_version: string;
      }
    >(
      `SELECT * FROM web_provider_outputs WHERE operation_id=? AND phase=? AND ordinal=?`,
      key.operationId,
      key.phase,
      key.ordinal,
    );
    ensure(
      output &&
        output.provider === row.provider &&
        output.model === row.model &&
        output.request_digest === row.request_digest &&
        output.policy_hash === row.policy_hash &&
        output.wire_request_hash === row.wire_request_hash &&
        output.voice_version === row.voice_version &&
        output.sha256 === row.output_digest,
      'WEB_PROVIDER_OUTPUT_INVALID',
    );
    return output;
  }
  readKnown(key: Key, scope: Scope, audio?: ProviderAudioCache) {
    const output = this.knownOutput(key, scope);
    const body = key.phase === 'speech' ? providerAudioBytes(output, audio) : output.payload_json;
    ensure(body && hash(body) === output.sha256, 'WEB_PROVIDER_OUTPUT_INVALID');
    return typeof body === 'string' ? (JSON.parse(body) as unknown) : Buffer.from(body);
  }
  async loadKnownAudio(key: Key, scope: Scope, cache: ProviderAudioCache) {
    ensure(key.phase === 'speech', 'WEB_PROVIDER_STAGE_INVALID');
    const authorize = async () => {
      this.knownOutput(key, scope);
      requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    };
    await loadProviderAudio(
      this.store as WebStore,
      this.knownOutput(key, scope),
      speechObjectScope(this.store as WebStore, key.operationId, key.ordinal, scope),
      authorize,
      cache,
    );
    return this.readKnown(key, scope, cache) as Buffer;
  }
  /** Persist a returned output without requiring an unexpired lease; attachment still needs one. */
  async stageAudio(key: Key, scope: Scope, bytes: Buffer) {
    const media = (this.store as WebStore).providerAudio;
    if (!media) return undefined;
    const objectScope = speechObjectScope(this.store as WebStore, key.operationId, key.ordinal, scope);
    const reference = JSON.stringify({ ...objectScope, byteLength: bytes.length, sha256: hash(bytes) });
    return media.stage(objectScope, bytes, async () =>
      this.store.transaction(() => {
        const row = this.attempt(key);
        ensure(sameScope(row, scope) && ['sent', 'unknown'].includes(row.state), 'WEB_PROVIDER_SCOPE_INVALID');
        ensure(
          !webCharacterDeleted(this.store, scope.characterId) &&
            !webCloudContentExpired(this.store, this.now(), scope.principalId, scope.worldId),
          'TRIAL_EXPIRED',
        );
        const prior = this.store.get<{ reference_json: string; erased_at: number | null }>(
          'SELECT reference_json,erased_at FROM cf_web_audio_objects WHERE operation_id=? AND ordinal=?',
          key.operationId,
          key.ordinal,
        );
        if (prior) ensure(prior.reference_json === reference && prior.erased_at === null, 'WEB_AUDIO_INTENT_IMMUTABLE');
        else
          this.store.run(
            'INSERT INTO cf_web_audio_objects VALUES (?,?,?,?,?,NULL)',
            key.operationId,
            key.ordinal,
            scope.principalId,
            scope.worldId,
            reference,
          );
      }),
    );
  }
  readKnownTextStage(key: Key, scope: Scope) {
    this.check();
    ensure(key.phase === 'draft' || key.phase === 'review', 'WEB_PROVIDER_OUTPUT_UNAVAILABLE');
    const row = this.attempt(key);
    ensure(sameScope(row, scope) && row.metadata_json, 'WEB_PROVIDER_OUTPUT_UNAVAILABLE');
    const metadata = JSON.parse(row.metadata_json) as TextGenerationStage;
    ensure(
      metadata.stage === key.phase && metadata.status === 'succeeded' && metadata.model === row.model,
      'WEB_PROVIDER_OUTPUT_INVALID',
    );
    return {
      payload: this.readKnown(key, scope),
      metadata,
      requestDigest: row.request_digest,
      policyHash: row.policy_hash,
      wireRequestHash: row.wire_request_hash,
    };
  }
  attemptState(key: Key, scope: Scope) {
    this.check();
    const row = this.store.get<Attempt>(
      `SELECT * FROM web_provider_attempts
      WHERE operation_id=? AND phase=? AND ordinal=?`,
      key.operationId,
      key.phase,
      key.ordinal,
    );
    if (!row) return null;
    ensure(sameScope(row, scope), 'WEB_PROVIDER_SCOPE_INVALID');
    return row.state;
  }
  /** Release the text lease only after both immutable, accepted-v7 stages are known. */
  commitReviewed(claim: WebStageClaim, scope: Scope): DialogueCandidate {
    this.check();
    ensure(claim.stage === 'text', 'WEB_PROVIDER_CLAIM_STALE');
    return this.store.transaction(() => {
      this.liveClaim(claim, scope);
      requireCurrentInputSnapshot(this.store as WebStore, {
        operation_id: claim.operationId,
        principal_id: scope.principalId,
        world_id: scope.worldId,
        conversation_id: scope.conversationId,
        character_id: scope.characterId,
        input_message_id: scope.inputMessageId,
      });
      const frozen = this.store.get<{
        request_json: string;
        request_digest: string;
        protocol_digest: string;
        prompt_digest: string;
        voice_version: string;
      }>('SELECT * FROM web_v7_requests WHERE operation_id=?', claim.operationId);
      ensure(
        frozen &&
          hash(frozen.request_json) === frozen.request_digest &&
          hash(JSON.stringify(protocolFingerprint())) === frozen.protocol_digest &&
          textPromptHash() === frozen.prompt_digest,
        'WEB_V7_REQUEST_INVALID',
      );
      let request: TextGenerationRequest;
      try {
        request = JSON.parse(frozen.request_json) as TextGenerationRequest;
      } catch {
        ensure(false, 'WEB_V7_REQUEST_INVALID');
      }
      ensure(
        request.jobId === claim.operationId &&
          request.scope.worldId === scope.worldId &&
          request.scope.conversationId === scope.conversationId &&
          request.scope.characterId === scope.characterId &&
          request.deliveryMode === 'voice' &&
          request.requiredMessageIds.length === 1 &&
          request.requiredMessageIds[0] === scope.inputMessageId,
        'WEB_V7_REQUEST_INVALID',
      );
      const draft = this.readKnown({ operationId: claim.operationId, phase: 'draft', ordinal: -1 }, scope);
      const review = this.readKnown({ operationId: claim.operationId, phase: 'review', ordinal: -1 }, scope);
      const candidate = applyTextReview(review, parseTextDraft(draft, request), request);
      const candidateJson = JSON.stringify(candidate),
        candidateDigest = hash(candidateJson);
      const output = this.store.all<{ phase: string; output_digest: string }>(
        `SELECT phase,output_digest
        FROM web_provider_attempts WHERE operation_id=? AND phase IN ('draft','review')
          AND state='known' AND outcome='succeeded'`,
        claim.operationId,
      );
      ensure(output.length === 2, 'WEB_PROVIDER_OUTPUT_UNAVAILABLE');
      this.store.run(
        `INSERT INTO web_provider_candidates VALUES (?,?,?,?,?,?,?,?)`,
        claim.operationId,
        frozen.request_digest,
        candidateJson,
        candidateDigest,
        frozen.voice_version,
        output.find((row) => row.phase === 'draft')!.output_digest,
        output.find((row) => row.phase === 'review')!.output_digest,
        this.now(),
      );
      candidate.bubbles.forEach((bubble, ordinal) =>
        this.store.run(
          `INSERT INTO web_provider_voice_segments(operation_id,ordinal,text_digest,voice_version,state)
          VALUES (?,?,?,?,'pending')`,
          claim.operationId,
          ordinal,
          hash(bubble.text),
          frozen.voice_version,
        ),
      );
      const now = this.now();
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='text_ready',stage_version=stage_version+1,
        audio_queued_at=?,audio_wait_used_ms=0,audio_wait_started_at=?,
        lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='text_running' AND stage_version=? AND lease_epoch=?
          AND lease_token=? AND lease_owner=? AND lease_expires_at>? AND deadline_at>?`,
          now,
          now,
          claim.operationId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.owner,
          now,
          now,
        ).changes === 1,
        'WEB_PROVIDER_CLAIM_STALE',
      );
      return candidate;
    });
  }
  /** Byte-complete in-memory provider asset; a late receipt never advances an expired claim. */
  attachKnownSpeech(claim: WebStageClaim, scope: Scope, audio?: ProviderAudioCache) {
    this.check();
    ensure(claim.stage === 'audio' && Number.isSafeInteger(claim.ordinal), 'WEB_PROVIDER_CLAIM_STALE');
    return this.store.transaction(() => {
      this.liveClaim(claim, scope);
      const ordinal = claim.ordinal!;
      const row = this.store.get<{ candidate_json: string; voice_version: string }>(
        'SELECT candidate_json,voice_version FROM web_provider_candidates WHERE operation_id=?',
        claim.operationId,
      );
      ensure(row && row.voice_version === claim.voiceVersion, 'WEB_PROVIDER_CANDIDATE_INVALID');
      const candidate = JSON.parse(row.candidate_json) as DialogueCandidate;
      const bubble = candidate.bubbles[ordinal];
      ensure(bubble && hash(bubble.text) === claim.textDigest, 'WEB_PROVIDER_CANDIDATE_INVALID');
      const output = this.store.get<ProviderAudioRow & { spoken_text: string; sha256: string }>(
        `SELECT * FROM web_provider_outputs
          WHERE operation_id=? AND phase='speech' AND ordinal=?`,
        claim.operationId,
        ordinal,
      );
      ensure(output && output.spoken_text === bubble.text, 'WEB_PROVIDER_OUTPUT_INVALID');
      const bytes = this.readKnown({ operationId: claim.operationId, phase: 'speech', ordinal }, scope, audio);
      ensure(bytes instanceof Buffer && hash(bytes) === output.sha256, 'WEB_PROVIDER_OUTPUT_INVALID');
      const info = inspectPCM(bytes, 60_000),
        durationMs = Math.round(info.durationMs);
      ensure(durationMs > 0, 'WEB_PROVIDER_OUTPUT_INVALID');
      const mediaId = randomUUID(),
        now = this.now();
      const external = !!output.audio_ref_json;
      this.store.run(
        `INSERT INTO web_provider_media_assets(operation_id,ordinal,media_id,origin,principal_id,
        player_id,world_id,conversation_id,character_id,input_message_id,text_digest,voice_version,sha256,
        byte_length,duration_ms,audio_bytes,verified_at${external ? ',audio_ref_json' : ''})
        VALUES (?,?,?,'provider',?,?,?,?,?,?,?,?,?,?,?,?,?${external ? ',?' : ''})`,
        claim.operationId,
        ordinal,
        mediaId,
        ...scopeArgs(scope),
        claim.textDigest!,
        claim.voiceVersion!,
        output.sha256,
        bytes.length,
        durationMs,
        external ? null : bytes,
        now,
        ...(external ? [output.audio_ref_json!] : []),
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_voice_segments SET state='complete',completed_at=?
        WHERE operation_id=? AND ordinal=? AND state='running' AND claim_stage_version=?
          AND claim_epoch=? AND claim_token=?`,
          now,
          claim.operationId,
          ordinal,
          claim.stageVersion,
          claim.epoch,
          claim.token,
        ).changes === 1,
        'WEB_PROVIDER_CLAIM_STALE',
      );
      const pending = !!this.store.get(
        `SELECT 1 FROM web_provider_voice_segments
        WHERE operation_id=? AND state='pending'`,
        claim.operationId,
      );
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='audio_pending',stage_version=stage_version+1,
        audio_wait_started_at=?,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='audio_running' AND stage_version=? AND lease_epoch=?
          AND lease_token=? AND lease_owner=? AND lease_expires_at>? AND deadline_at>?`,
          pending ? now : null,
          claim.operationId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          claim.owner,
          now,
          now,
        ).changes === 1,
        'WEB_PROVIDER_CLAIM_STALE',
      );
      return mediaId;
    });
  }
  /** Installs a digest-verified user selection (see verifySelectedVoiceSetup); never uploads. */
  configureSelectedVoice(input: {
    characterId: string;
    voiceVersion: string;
    voiceRevision: number;
    profileId: string;
    referenceId: string;
    model: 's2.1-pro' | 's2-pro';
    evidence: Record<string, string>;
  }) {
    this.check();
    ensure(
      [input.characterId, input.voiceVersion].every((value) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) &&
        Number.isSafeInteger(input.voiceRevision) &&
        input.voiceRevision > 0 &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.profileId) &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.referenceId) &&
        ['s2.1-pro', 's2-pro'].includes(input.model) &&
        /^[a-f0-9]{64}$/.test(input.evidence.selectionSHA256 ?? '') &&
        /^[a-f0-9]{64}$/.test(input.evidence.voiceSHA256 ?? ''),
      'WEB_PROVIDER_VOICE_UNAPPROVED',
    );
    const evidence = JSON.stringify(input.evidence);
    this.store.transaction(() => {
      ensure(
        this.store.get('SELECT 1 FROM character_templates WHERE id=?', input.characterId),
        'WEB_CHARACTER_UNAVAILABLE',
      );
      const prior = this.store.get<{
        voice_version: string;
        voice_revision: number;
        profile_id: string;
        reference_id: string;
        model: string;
        source: string;
        evidence_json: string | null;
      }>('SELECT * FROM web_provider_voice_bindings WHERE character_id=?', input.characterId);
      if (prior)
        ensure(
          prior.source === 'user_selected' &&
            prior.voice_version === input.voiceVersion &&
            prior.voice_revision === input.voiceRevision &&
            prior.profile_id === input.profileId &&
            prior.reference_id === input.referenceId &&
            prior.model === input.model &&
            prior.evidence_json === evidence,
          'WEB_PROVIDER_VOICE_CONFLICT',
        );
      else
        this.store.run(
          `INSERT INTO web_provider_voice_bindings VALUES (?,?,?,?,?,?,'user_selected',1,?)`,
          input.characterId,
          input.voiceVersion,
          input.voiceRevision,
          input.profileId,
          input.referenceId,
          input.model,
          evidence,
        );
    });
  }
  /** Browse-card welcome clip in the bound voice; text must be the user's fixed line. */
  registerWelcome(input: {
    characterId: string;
    voiceVersion: string;
    body: string;
    wav: Uint8Array;
    audioReference?: MediaObjectReference;
  }) {
    this.check();
    const line = webWelcomeLine(this.store, input.characterId);
    ensure(line && input.body === line.text && input.wav.byteLength <= 6_000_000, 'WEB_PROVIDER_WELCOME_INVALID');
    const bytes = Buffer.from(input.wav),
      info = inspectPCM(bytes, 60_000);
    const durationMs = Math.round(info.durationMs),
      sha256 = hash(bytes);
    ensure(durationMs > 0 && info.channels === 1 && info.sampleRate === 24_000, 'WEB_PROVIDER_WELCOME_INVALID');
    const external = !!(this.store as WebStore).providerAudio;
    ensure(external === !!input.audioReference, 'WEB_AUDIO_REFERENCE_INVALID');
    if (input.audioReference)
      checkAudioReference(
        input.audioReference,
        fixedObjectScope(this.store as WebStore, 'welcome', input.characterId, input.voiceVersion),
        bytes,
      );
    return this.store.transaction(() => {
      ensure(
        this.store.get(
          `SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?
        AND voice_version=?`,
          input.characterId,
          input.voiceVersion,
        ),
        'WEB_PROVIDER_VOICE_UNAPPROVED',
      );
      const prior = this.store.get<{ media_id: string; sha256: string }>(
        `SELECT media_id,sha256
        FROM web_provider_welcome_assets WHERE character_id=? AND voice_version=?`,
        input.characterId,
        input.voiceVersion,
      );
      if (prior) {
        ensure(prior.sha256 === sha256, 'WEB_PROVIDER_WELCOME_CONFLICT');
        return prior.media_id;
      }
      const mediaId = randomUUID();
      this.store.run(
        `INSERT INTO web_provider_welcome_assets(character_id,voice_version,text_version,body,
        media_id,origin,sha256,byte_length,duration_ms,audio_bytes,created_at${external ? ',audio_ref_json' : ''})
        VALUES (?,?,?,?,?,'operator_approved',?,?,?,?,?${external ? ',?' : ''})`,
        input.characterId,
        input.voiceVersion,
        line.version,
        input.body,
        mediaId,
        sha256,
        bytes.length,
        durationMs,
        external ? null : bytes,
        this.now(),
        ...(external ? [JSON.stringify(input.audioReference)] : []),
      );
      return mediaId;
    });
  }
  /** Trial footer in the bound voice (fixture in tests, provider-rendered clip in runtime). */
  registerApprovedFooter(input: {
    characterId: string;
    voiceVersion: string;
    body: string;
    wav: Uint8Array;
    approved: true;
    audioReference?: MediaObjectReference;
  }) {
    this.check();
    ensure(
      input.approved === true &&
        input.body === SYNTHETIC_TRIAL_FOOTER &&
        input.voiceVersion.length > 0 &&
        input.wav.byteLength <= 6_000_000,
      'WEB_PROVIDER_FOOTER_INVALID',
    );
    const bytes = Buffer.from(input.wav),
      info = inspectPCM(bytes, 60_000);
    const durationMs = Math.round(info.durationMs),
      sha256 = hash(bytes);
    ensure(durationMs > 0 && info.channels === 1 && info.sampleRate === 24_000, 'WEB_PROVIDER_FOOTER_INVALID');
    const external = !!(this.store as WebStore).providerAudio;
    ensure(external === !!input.audioReference, 'WEB_AUDIO_REFERENCE_INVALID');
    if (input.audioReference)
      checkAudioReference(
        input.audioReference,
        fixedObjectScope(this.store as WebStore, 'footer', input.characterId, input.voiceVersion),
        bytes,
      );
    return this.store.transaction(() => {
      ensure(
        this.store.get('SELECT 1 FROM character_templates WHERE id=?', input.characterId),
        'WEB_CHARACTER_UNAVAILABLE',
      );
      const prior = this.store.get<{ media_id: string; sha256: string; body: string }>(
        'SELECT media_id,sha256,body FROM web_provider_footer_assets WHERE character_id=? AND voice_version=?',
        input.characterId,
        input.voiceVersion,
      );
      if (prior) {
        ensure(prior.sha256 === sha256 && prior.body === input.body, 'WEB_PROVIDER_FOOTER_CONFLICT');
        return prior.media_id;
      }
      const mediaId = randomUUID();
      this.store.run(
        `INSERT INTO web_provider_footer_assets(character_id,voice_version,media_id,origin,
        body,sha256,byte_length,duration_ms,audio_bytes,created_at${external ? ',audio_ref_json' : ''})
        VALUES (?,?,?,'operator_approved',?,?,?,?,?,?${external ? ',?' : ''})`,
        input.characterId,
        input.voiceVersion,
        mediaId,
        input.body,
        sha256,
        bytes.length,
        durationMs,
        external ? null : bytes,
        this.now(),
        ...(external ? [JSON.stringify(input.audioReference)] : []),
      );
      return mediaId;
    });
  }
  async registerFixedAudio(
    kind: 'welcome' | 'footer',
    input: {
      characterId: string;
      voiceVersion: string;
      body: string;
      wav: Uint8Array;
    },
  ) {
    const bytes = Buffer.from(input.wav);
    ensure(
      kind === 'welcome'
        ? input.body === webWelcomeLine(this.store, input.characterId)?.text
        : kind === 'footer' && input.body === SYNTHETIC_TRIAL_FOOTER,
      'WEB_PROVIDER_FIXED_AUDIO_INVALID',
    );
    const info = inspectPCM(bytes, 60_000);
    ensure(
      bytes.length <= 6_000_000 && info.channels === 1 && info.sampleRate === 24_000 && Math.round(info.durationMs) > 0,
      'WEB_PROVIDER_FIXED_AUDIO_INVALID',
    );
    const audioReference = await (this.store as WebStore).providerAudio?.stage(
      fixedObjectScope(this.store as WebStore, kind, input.characterId, input.voiceVersion),
      bytes,
      async () => {
        ensure(
          this.store.get(
            `SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?
          AND voice_version=? AND approved=1`,
            input.characterId,
            input.voiceVersion,
          ),
          'WEB_PROVIDER_VOICE_UNAPPROVED',
        );
      },
    );
    const value = { ...input, wav: bytes, ...(audioReference ? { audioReference } : {}) };
    return kind === 'welcome' ? this.registerWelcome(value) : this.registerApprovedFooter({ ...value, approved: true });
  }
  /** Only approved browse-card audio is public; footer/narrative IDs never match this lookup. */
  async readWelcomeAudio(mediaId: string) {
    this.check();
    const read = () =>
      this.store.get<
        ProviderAudioRow & {
          character_id: string;
          voice_version: string;
          body: string;
          text_version: string;
          sha256: string;
          byte_length: number;
          duration_ms: number;
        }
      >(
        `SELECT w.* FROM web_provider_welcome_assets w JOIN web_provider_voice_bindings v
        ON v.character_id=w.character_id AND v.voice_version=w.voice_version
        WHERE w.media_id=? AND w.origin='operator_approved' AND v.source='user_selected' AND v.approved=1`,
        mediaId,
      );
    const row = read();
    ensure(!row || !webCharacterDeleted(this.store, row.character_id), 'NOT_FOUND');
    ensure(
      row &&
        row.body === webWelcomeLine(this.store, row.character_id)?.text &&
        row.text_version === webWelcomeLine(this.store, row.character_id)?.version,
      'WEB_PROVIDER_WELCOME_UNAVAILABLE',
    );
    const authorize = async () => {
      const current = read();
      ensure(!webCharacterDeleted(this.store, row.character_id), 'NOT_FOUND');
      ensure(
        current?.sha256 === row.sha256 &&
          current.voice_version === row.voice_version &&
          row.body === webWelcomeLine(this.store, row.character_id)?.text &&
          row.text_version === webWelcomeLine(this.store, row.character_id)?.version &&
          current.audio_ref_json === row.audio_ref_json,
        'WEB_PROVIDER_WELCOME_UNAVAILABLE',
      );
    };
    const cache: ProviderAudioCache = new Map();
    const bytes = await loadProviderAudio(
      this.store as WebStore,
      row,
      fixedObjectScope(this.store as WebStore, 'welcome', row.character_id, row.voice_version),
      authorize,
      cache,
    );
    ensure(
      bytes.length === row.byte_length &&
        hash(bytes) === row.sha256 &&
        Math.round(inspectPCM(bytes, 60_000).durationMs) === row.duration_ms,
      'WEB_PROVIDER_WELCOME_INVALID',
    );
    return bytes;
  }
  /** Offline output-completeness gate only; live entitlement/publisher wiring is not present. */
  validatePublication(
    operationId: string,
    scope: Scope,
    speechOrdinals: number[],
    voiceVersion: string,
    audio?: ProviderAudioCache,
  ) {
    this.check();
    ensure(
      speechOrdinals.length > 0 &&
        new Set(speechOrdinals).size === speechOrdinals.length &&
        speechOrdinals.every((ordinal, index) => ordinal === index),
      'WEB_PROVIDER_PUBLICATION_INVALID',
    );
    ensure(
      this.store.get(
        `SELECT 1 FROM web_operations o JOIN web_principals p
      ON p.id=o.principal_id AND p.world_id=o.world_id
      WHERE o.id=? AND o.principal_id=? AND p.player_id=? AND o.world_id=? AND o.conversation_id=?
        AND o.character_id=? AND o.input_message_id=? AND o.deadline_at>?
        AND o.status NOT IN ('published','cancelled','failed')`,
        operationId,
        ...scopeArgs(scope),
        this.now(),
      ),
      'WEB_PROVIDER_PUBLICATION_INVALID',
    );
    const frozen = this.store.get<{
      request_json: string;
      request_digest: string;
      protocol_digest: string;
      prompt_digest: string;
      voice_version: string;
    }>(
      'SELECT request_json,request_digest,protocol_digest,prompt_digest,voice_version FROM web_v7_requests WHERE operation_id=?',
      operationId,
    );
    ensure(
      frozen &&
        hash(frozen.request_json) === frozen.request_digest &&
        hash(JSON.stringify(protocolFingerprint())) === frozen.protocol_digest &&
        textPromptHash() === frozen.prompt_digest &&
        frozen.voice_version === voiceVersion,
      'WEB_PROVIDER_PUBLICATION_INVALID',
    );
    let request: TextGenerationRequest;
    try {
      request = JSON.parse(frozen.request_json) as TextGenerationRequest;
    } catch {
      ensure(false, 'WEB_PROVIDER_PUBLICATION_INVALID');
    }
    ensure(
      request.jobId === operationId &&
        request.scope.worldId === scope.worldId &&
        request.scope.conversationId === scope.conversationId &&
        request.scope.characterId === scope.characterId &&
        request.deliveryMode === 'voice' &&
        request.requiredMessageIds.length === 1 &&
        request.requiredMessageIds[0] === scope.inputMessageId,
      'WEB_PROVIDER_PUBLICATION_INVALID',
    );
    const draftKey = { operationId, phase: 'draft' as const, ordinal: -1 };
    const reviewKey = { operationId, phase: 'review' as const, ordinal: -1 };
    const draft = this.readKnown(draftKey, scope);
    const review = this.readKnown(reviewKey, scope);
    const candidate = applyTextReview(review, parseTextDraft(draft, request), request);
    ensure(candidate.bubbles.length === speechOrdinals.length, 'WEB_PROVIDER_PUBLICATION_INVALID');
    ensure(
      this.store.get<{ n: number }>(
        `SELECT count(*) AS n FROM web_provider_outputs
      WHERE operation_id=? AND phase='speech'`,
        operationId,
      )?.n === speechOrdinals.length,
      'WEB_PROVIDER_PUBLICATION_INVALID',
    );
    for (const key of [
      draftKey,
      reviewKey,
      ...speechOrdinals.map((ordinal) => ({ operationId, phase: 'speech' as const, ordinal })),
    ]) {
      const row = this.attempt(key);
      ensure(
        row.voice_version === voiceVersion &&
          row.request_digest ===
            this.store.get<{ request_digest: string }>(
              'SELECT request_digest FROM web_v7_requests WHERE operation_id=?',
              operationId,
            )?.request_digest,
        'WEB_PROVIDER_PUBLICATION_INVALID',
      );
      if (key.phase === 'speech') {
        this.readKnown(key, scope, audio);
        const output = this.store.get<{ spoken_text: string }>(
          `SELECT spoken_text FROM web_provider_outputs WHERE operation_id=? AND phase='speech' AND ordinal=?`,
          operationId,
          key.ordinal,
        );
        ensure(output?.spoken_text === candidate.bubbles[key.ordinal]?.text, 'WEB_PROVIDER_PUBLICATION_INVALID');
      }
    }
    return true;
  }
}
