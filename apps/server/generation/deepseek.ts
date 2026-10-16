import { providerRequestHash } from '../../../packages/domain/provider-request.ts';
import { finishProviderCall, closeProviderReservation } from '../../../packages/domain/provider-metering.ts';
import { createHash } from 'node:crypto';
import type {
  AcceptedV7StageOutput,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStage,
  TextGenerator,
} from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { dialogueCandidate } from '../../../packages/domain/dialogue.ts';
import { bubbleLimits, BubbleValidationError, inspectBubbles } from '../../../packages/domain/bubbles.ts';
import { groupEvidenceSource } from '../memory/context-evidence.ts';
import { TextGenerationFailure } from './text-generation-error.ts';
import {
  applyTextReview,
  DROP_INVALID_METADATA,
  draftTool,
  parseTextDraft,
  reviewTool,
  validateDialogueEvidence,
} from './accepted-text-protocol.ts';
import type { TextDraft } from './accepted-text-protocol.ts';
import { promptMessages, reviewPromptMessages } from './accepted-text-prompt.ts';
import { createTextGenerationPolicy, generationPolicyHash, textRequestParameters } from './text-generation-policy.ts';
import type { TextGenerationPolicy, TextGenerationPolicyOptions } from './text-generation-policy.ts';
import type {
  ProviderCallObserver,
  ProviderMeter,
  ProviderReservation,
} from '../../../packages/contracts/provider-calls.ts';
import { DEEPSEEK_INPUT_RESERVATION } from './deepseek-usage.ts';
import {
  MAX_REQUEST_BYTES,
  TEXT_ENDPOINTS,
  chatBody,
  chatObservation,
  chatUsage,
  connectFailure,
  isNotBilled,
  outputBound,
  scopeUser,
  statusFailure,
} from './text-wire.ts';
import type { ModelRef, TextProviderId, TextRoute } from './text-wire.ts';
import { PLAYER_MODELS } from '../../../packages/contracts/player-models.ts';
import { SUPPORTED_TEXT_MODELS } from '../platform/config.ts';

function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_TEXT_RESPONSE');
}
const integer = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function readBody(response: Response): Promise<unknown> {
  ensure(response.body, 'INVALID_TEXT_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 262_144) {
        await reader.cancel();
        throw new DomainError('TEXT_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new DomainError('INVALID_TEXT_RESPONSE');
  }
}

export function parseDeepSeekResponse(
  value: unknown,
  request: TextGenerationRequest,
  model: string,
  elapsedMs: number,
): TextGenerationResult {
  object(value);
  ensure(Array.isArray(value.choices) && value.choices.length === 1, 'INVALID_TEXT_RESPONSE');
  const choice: unknown = value.choices[0];
  object(choice);
  ensure(choice.finish_reason === 'stop', 'TEXT_INCOMPLETE_RESPONSE');
  object(choice.message);
  const message = choice.message;
  ensure(
    message.role === 'assistant' && typeof message.content === 'string' && message.content.trim(),
    'INVALID_TEXT_RESPONSE',
  );
  ensure(
    !message.refusal &&
      (message.tool_calls == null || (Array.isArray(message.tool_calls) && message.tool_calls.length === 0)),
    'TEXT_CONTENT_REJECTED',
  );
  let reply: unknown;
  try {
    reply = JSON.parse(message.content);
  } catch {
    throw new DomainError('INVALID_REPLY_JSON');
  }
  // Map the observed "gentle" tag to the application's "soft" expression, not another voice.
  // Normalize only this known enum alias; arbitrary/missing fields still fail validation.
  if (reply && typeof reply === 'object' && 'bubbles' in reply && Array.isArray(reply.bubbles)) {
    for (const bubble of reply.bubbles) {
      if (bubble && typeof bubble === 'object' && bubble.expression === 'gentle') bubble.expression = 'soft';
    }
  }
  // Preserve, rather than discard, an observed provider mix-up between local message IDs
  // and already-authorized group evidence. Arbitrary IDs are never resolved by a global lookup.
  const clarificationIds = new Set(
    (request.clarifications ?? []).flatMap((item) => item.messages.map((message) => message.id)),
  );
  const localIds = new Set([...request.messages.map((message) => message.id), ...clarificationIds]);
  const aliases = new Map(
    request.evidence.flatMap((evidence) => {
      const source = groupEvidenceSource(evidence);
      return source
        ? [
            [evidence.id, evidence.id],
            [source.sourceMessageId, evidence.id],
          ]
        : [];
    }) as [string, string][],
  );
  if (reply && typeof reply === 'object' && 'topics' in reply && Array.isArray(reply.topics)) {
    for (const topic of reply.topics) {
      if (
        !topic ||
        typeof topic !== 'object' ||
        !Array.isArray(topic.evidenceMessageIds) ||
        (topic.sourceEvidenceIds !== undefined && !Array.isArray(topic.sourceEvidenceIds))
      )
        continue;
      const moved = topic.evidenceMessageIds.filter(
        (id: unknown) => typeof id === 'string' && !localIds.has(id) && aliases.has(id),
      ) as string[];
      if (moved.length) {
        topic.evidenceMessageIds = topic.evidenceMessageIds.filter((id: unknown) => !moved.includes(String(id)));
        topic.sourceEvidenceIds = [
          ...new Set([...(topic.sourceEvidenceIds ?? []), ...moved.map((id) => aliases.get(id)!)]),
        ];
      }
    }
  }
  const candidate = dialogueCandidate(reply, request.requiredMessageIds, request.mustClose, request.deliveryMode);
  validateDialogueEvidence(candidate, request);
  return { ...responseMetadata(value, model, elapsedMs), reply: candidate };
}

function reportedModel(value: unknown): { reportedModel?: string } {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? { reportedModel: value } : {};
}
function responseMetadata(
  value: unknown,
  model: string,
  elapsedMs: number,
  provider: TextProviderId = 'deepseek',
): Omit<TextGenerationResult, 'reply'> {
  object(value);
  let usage: TextGenerationResult['usage'] = null;
  if (value.usage !== undefined && value.usage !== null) {
    object(value.usage);
    const split = chatUsage(provider, value);
    ensure(split.inputTokens !== null && split.outputTokens !== null, 'INVALID_TEXT_USAGE');
    usage = {
      inputTokens: split.inputTokens,
      outputTokens: split.outputTokens,
      totalTokens: split.inputTokens + split.outputTokens,
      ...(split.cacheHitInputTokens === null ? {} : { cacheHitInputTokens: split.cacheHitInputTokens }),
      ...(split.cacheMissInputTokens === null ? {} : { cacheMissInputTokens: split.cacheMissInputTokens }),
    };
  }
  return {
    provider,
    model,
    ...reportedModel(value.model),
    usage,
    elapsedMs,
    requestId: typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.id) ? value.id : null,
  };
}

/** Strict function calls carry output data only. There is no tool dispatcher or execution loop. */
export function parseDeepSeekToolResponse(
  value: unknown,
  expectedName: string,
  provider: TextProviderId = 'deepseek',
): unknown {
  object(value);
  ensure(Array.isArray(value.choices) && value.choices.length === 1, 'INVALID_TEXT_RESPONSE');
  const choice: unknown = value.choices[0];
  object(choice);
  // xAI and Gemini may report the forced function call as "stop"; the call itself is checked below either way.
  ensure(
    choice.finish_reason === 'tool_calls' || (provider !== 'deepseek' && choice.finish_reason === 'stop'),
    'TEXT_INCOMPLETE_RESPONSE',
  );
  object(choice.message);
  const message = choice.message;
  ensure(message.role === 'assistant', 'INVALID_TEXT_RESPONSE');
  ensure(
    !message.refusal &&
      (provider !== 'deepseek' ||
        message.content == null ||
        (typeof message.content === 'string' && !message.content.trim())),
    'TEXT_CONTENT_REJECTED',
  );
  ensure(Array.isArray(message.tool_calls) && message.tool_calls.length === 1, 'INVALID_TEXT_TOOL_RESPONSE');
  const call: unknown = message.tool_calls[0];
  object(call);
  object(call.function);
  ensure(
    call.type === 'function' &&
      call.function.name === expectedName &&
      typeof call.function.arguments === 'string' &&
      call.function.arguments.trim().length > 0,
    'INVALID_TEXT_TOOL_RESPONSE',
  );
  try {
    return JSON.parse(call.function.arguments);
  } catch {
    throw new DomainError('INVALID_REPLY_JSON');
  }
}

/** The model's own words in a provider response (the tool-call arguments, else any text), for admin diagnosis only. */
export function rawModelOutput(value: unknown): string {
  try {
    const message = (value as { choices?: Array<{ message?: Record<string, unknown> }> }).choices?.[0]?.message;
    const calls = message?.tool_calls as Array<{ function?: { arguments?: unknown } }> | undefined;
    const args = calls?.[0]?.function?.arguments;
    if (typeof args === 'string') return args;
    return typeof message?.content === 'string' ? message.content : '';
  } catch {
    return '';
  }
}

/** Every model id a draft may legitimately carry once a player can choose (a resumed review checks the stored draft's model). */
const KNOWN_DRAFT_MODELS: ReadonlySet<string> = new Set([
  ...SUPPORTED_TEXT_MODELS,
  ...Object.values(PLAYER_MODELS).map((item) => item.model),
]);

export class DeepSeekTextGenerator implements TextGenerator {
  readonly providerCalls = 'external' as const;
  #apiKey: string;
  #keys: Readonly<Partial<Record<Exclude<TextProviderId, 'deepseek'>, string>>>;
  #fetch: typeof fetch;
  #policy: TextGenerationPolicy;
  get policy() {
    return this.#policy;
  }
  get model() {
    return this.#policy.stages.draft.model;
  }
  get reviewModel() {
    return this.#policy.stages.review.model;
  }
  get timeoutMs() {
    return this.#policy.timeoutMs;
  }
  get maxTokens() {
    return this.#policy.stages.draft.max_tokens;
  }
  get reviewMaxTokens() {
    return this.#policy.stages.review.max_tokens;
  }
  get textProtocol() {
    return this.#policy.textProtocol;
  }
  get policyHash() {
    return generationPolicyHash(this.#policy);
  }

  constructor(
    options: TextGenerationPolicyOptions & {
      apiKey: string;
      baseUrl?: string;
      fetch?: typeof fetch;
      /** xAI / Gemini keys. A missing key makes that model unavailable (answered as definitely-not-billed), never a crash. */
      keys?: { xai?: string | undefined; gemini?: string | undefined };
    },
  ) {
    ensure(typeof options.apiKey === 'string' && options.apiKey.trim().length > 0, 'DEEPSEEK_KEY_MISSING');
    ensure(options.apiKey.length <= 512 && !/[\r\n]/.test(options.apiKey), 'INVALID_DEEPSEEK_KEY');
    let base: URL;
    try {
      base = new URL(options.baseUrl ?? 'https://api.deepseek.com');
    } catch {
      throw new DomainError('UNAPPROVED_DEEPSEEK_ENDPOINT');
    }
    ensure(
      base.origin === 'https://api.deepseek.com' &&
        !base.username &&
        !base.password &&
        !base.search &&
        !base.hash &&
        ['/', '/v1', '/v1/', '/beta', '/beta/'].includes(base.pathname),
      'UNAPPROVED_DEEPSEEK_ENDPOINT',
    );
    // Strict Chat Completions is available on the official beta path, not /v1.
    // Existing approved root/v1 configuration stays valid without forwarding credentials elsewhere.
    this.#apiKey = options.apiKey.trim();
    const optional = (key: string | undefined) => {
      const value = typeof key === 'string' ? key.trim() : '';
      return value.length > 0 && value.length <= 512 && !/[\r\n]/.test(value) ? value : undefined;
    };
    const keys: Partial<Record<'xai' | 'gemini', string>> = {};
    const xai = optional(options.keys?.xai),
      gemini = optional(options.keys?.gemini);
    if (xai) keys.xai = xai;
    if (gemini) keys.gemini = gemini;
    this.#keys = Object.freeze(keys);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#policy = createTextGenerationPolicy(options);
  }

  async generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
    meter?: ProviderMeter,
  ): Promise<TextGenerationResult> {
    return this.run(request, signal, meter);
  }

  /** The caller must durably accept each validated tool payload before the next provider stage starts. */
  async generateAcceptedStages(
    request: TextGenerationRequest,
    signal: AbortSignal,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
    route?: TextRoute,
  ): Promise<TextGenerationResult> {
    ensure(typeof accept === 'function', 'TEXT_STAGE_PROTOCOL_REQUIRED');
    return this.run(request, signal, meter, accept, undefined, route);
  }

  /** A trusted business ledger must supply an already-confirmed draft with its frozen bindings. */
  async generateAcceptedReviewFromKnownDraft(
    request: TextGenerationRequest,
    signal: AbortSignal,
    known: { payload: unknown; metadata: TextGenerationStage; requestDigest: string; policyHash: string },
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
    route?: TextRoute,
  ): Promise<TextGenerationResult> {
    ensure(typeof accept === 'function', 'TEXT_STAGE_PROTOCOL_REQUIRED');
    return this.run(request, signal, meter, accept, known, route);
  }

  /** A route is data from the business object; refuse anything that is not exactly a supported provider/model pair. */
  private checkRoute(route: TextRoute) {
    for (const stage of ['draft', 'review'] as const) {
      const chain = route[stage];
      ensure(Array.isArray(chain) && chain.length > 0 && chain.length <= 3, 'TEXT_ROUTE_INVALID');
      ensure(new Set(chain.map((ref) => ref.provider)).size === chain.length, 'TEXT_ROUTE_INVALID');
      for (const ref of chain)
        ensure(
          ref.provider === 'deepseek'
            ? ref.model === this.#policy.stages[stage].model
            : ref.provider === 'xai'
              ? ref.model === PLAYER_MODELS.xai.model
              : ref.provider === 'gemini' && ref.model === PLAYER_MODELS.gemini.model,
          'TEXT_ROUTE_INVALID',
        );
    }
  }

  private async run(
    request: TextGenerationRequest,
    signal: AbortSignal,
    meter?: ProviderMeter,
    accept?: (stage: AcceptedV7StageOutput) => Promise<void>,
    knownDraft?: { payload: unknown; metadata: TextGenerationStage; requestDigest: string; policyHash: string },
    route?: TextRoute,
  ): Promise<TextGenerationResult> {
    ensure(!signal.aborted, 'TEXT_REQUEST_ABORTED');
    // No route = exactly the historical behaviour: DeepSeek writes and reviews, nothing is retried elsewhere.
    const chains: TextRoute = route ?? {
      draft: [{ provider: 'deepseek', model: this.model }],
      review: [{ provider: 'deepseek', model: this.reviewModel }],
    };
    this.checkRoute(chains);
    const used: Partial<Record<'draft' | 'review', ModelRef>> = {};
    // A caller changing its request while draft generation awaits cannot broaden the review's scope.
    const frozen = structuredClone(request);
    const requestDigest = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    if (knownDraft)
      ensure(
        knownDraft.requestDigest === requestDigest &&
          knownDraft.policyHash === this.policyHash &&
          knownDraft.metadata.stage === 'draft' &&
          knownDraft.metadata.status === 'succeeded' &&
          (route
            ? knownDraft.metadata.model !== undefined && KNOWN_DRAFT_MODELS.has(knownDraft.metadata.model)
            : knownDraft.metadata.model === this.model),
        'TEXT_STAGE_RESUME_INVALID',
      );
    const knownParsedDraft = knownDraft ? parseTextDraft(structuredClone(knownDraft.payload), frozen) : null;
    const messages = promptMessages(frozen);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    const started = performance.now();
    const stages: TextGenerationStage[] = [];
    let reservation: ProviderReservation | undefined;
    const metadata = (): Omit<TextGenerationResult, 'reply'> => {
      const usage =
        stages.length && stages.every((stage) => stage.usage !== null)
          ? stages.reduce(
              (sum, stage) => ({
                inputTokens: sum.inputTokens + stage.usage!.inputTokens,
                outputTokens: sum.outputTokens + stage.usage!.outputTokens,
                totalTokens: sum.totalTokens + stage.usage!.totalTokens,
              }),
              { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
            )
          : null;
      return {
        provider: used.draft?.provider ?? 'deepseek',
        model: used.draft?.model ?? this.model,
        ...reportedModel(stages.find((stage) => stage.stage === 'draft')?.reportedModel),
        elapsedMs: Math.round(performance.now() - started),
        requestId: stages.at(-1)?.requestId ?? null,
        usage: usage && Object.values(usage).every(integer) ? usage : null,
        stages: [...stages],
      };
    };
    const errorCode = (error: unknown) =>
      error instanceof DomainError && error.code === 'COST_RECORDING_FAILED'
        ? error.code
        : signal.aborted
          ? 'TEXT_REQUEST_ABORTED'
          : timeout.aborted
            ? 'TEXT_REQUEST_TIMEOUT'
            : error instanceof DomainError
              ? error.code
              : 'TEXT_NETWORK_ERROR';
    const reservations: ProviderReservation[] = [];
    const specFor = (stage: 'draft' | 'review', ref: ModelRef) => ({
      provider: ref.provider,
      model: ref.model,
      stage,
      bounds: {
        unit: 'tokens' as const,
        inputTokens: DEEPSEEK_INPUT_RESERVATION,
        outputTokens: outputBound(ref.provider, stage === 'draft' ? this.maxTokens : this.reviewMaxTokens),
      },
    });
    /** One provider call for one stage with one model. A failure that proves nothing was billed is reported to the observer first. */
    const attemptCall = async <T extends TextDraft>(
      stage: TextGenerationStage['stage'],
      ref: ModelRef,
      reservationFor: ProviderReservation | undefined,
      willRetry: (error: unknown) => boolean,
      messages: ReturnType<typeof promptMessages>,
      outputTool: ReturnType<typeof draftTool>,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      ensure(!combined.aborted, errorCode(null));
      const stageStarted = performance.now();
      const model = ref.model;
      let value: unknown;
      let observer: ProviderCallObserver | undefined,
        recorded = false;
      let parsed!: T;
      let handoff: AcceptedV7StageOutput | undefined;
      try {
        const body =
          ref.provider === 'deepseek'
            ? JSON.stringify({
                ...textRequestParameters(this.#policy, stage, outputTool.function.name),
                messages,
                tools: [outputTool],
                user_id: createHash('sha256')
                  .update(JSON.stringify([frozen.scope.worldId, frozen.scope.conversationId, frozen.scope.characterId]))
                  .digest('hex'),
              })
            : (() => {
                // No key = this model is unavailable. Checked before anything is reserved or sent.
                if (!this.#keys[ref.provider]) throw new DomainError('MODEL_UNAVAILABLE');
                return chatBody(ref.provider, {
                  model,
                  messages,
                  tool: outputTool,
                  maxTokens: stage === 'draft' ? this.maxTokens : this.reviewMaxTokens,
                  user: scopeUser([frozen.scope.worldId, frozen.scope.conversationId, frozen.scope.characterId]),
                });
              })();
        const endpoint = ref.provider === 'deepseek' ? this.#policy.endpoint : TEXT_ENDPOINTS[ref.provider];
        const bytes = Buffer.byteLength(body, 'utf8');
        const cap = MAX_REQUEST_BYTES[ref.provider];
        if (cap !== undefined && bytes > cap) throw new DomainError('MODEL_REQUEST_TOO_LARGE');
        const wireRequestHash = providerRequestHash(endpoint, model, body);
        observer = await reservationFor?.start(stage, wireRequestHash, bytes);
        ensure(!combined.aborted, errorCode(null));
        const key = ref.provider === 'deepseek' ? this.#apiKey : this.#keys[ref.provider]!;
        let response: Response;
        try {
          response = await this.#fetch(endpoint, {
            method: 'POST',
            redirect: 'manual',
            signal: combined,
            headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
            body,
          });
        } catch (error) {
          throw connectFailure(error) ?? error;
        }
        if (!response.ok) {
          let text = '';
          if (ref.provider === 'deepseek') await response.body?.cancel();
          else
            try {
              text = (await response.text()).slice(0, 4096);
            } catch {
              /* classification hint only */
            }
          throw new DomainError(statusFailure(ref.provider, response.status, text));
        }
        value = await readBody(response);
        ensure(!combined.aborted, errorCode(null));
        const payload = parseDeepSeekToolResponse(value, outputTool.function.name, ref.provider);
        const captured = accept ? structuredClone(payload) : undefined;
        parsed = parse(payload);
        const meta = responseMetadata(value, model, Math.round(performance.now() - stageStarted), ref.provider);
        recorded = true;
        await finishProviderCall(observer, chatObservation(ref.provider, value, 'succeeded', null));
        const stageMetadata: TextGenerationStage = {
          stage,
          model,
          ...reportedModel(meta.reportedModel),
          status: 'succeeded',
          requestId: meta.requestId,
          usage: meta.usage,
          elapsedMs: meta.elapsedMs,
          presentation: inspectBubbles(parsed.bubbles, bubbleLimits(frozen.deliveryMode)[parsed.mode]),
        };
        stages.push(stageMetadata);
        used[stage] = ref;
        if (accept)
          handoff = {
            jobId: frozen.jobId,
            requestDigest,
            policyHash: this.policyHash,
            wireRequestHash,
            stage,
            payload: captured,
            metadata: structuredClone(stageMetadata),
          };
      } catch (error) {
        const response = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const split = chatUsage(ref.provider, value);
        // A definitely-not-billed failure that the next model will answer is not a stage of the reply.
        if (!willRetry(error))
          stages.push({
            stage,
            model,
            ...reportedModel(response.model),
            status: 'failed',
            errorCode: errorCode(error),
            elapsedMs: Math.round(performance.now() - stageStarted),
            requestId:
              typeof response.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(response.id) ? response.id : null,
            usage:
              split.inputTokens !== null && split.outputTokens !== null
                ? {
                    inputTokens: split.inputTokens,
                    outputTokens: split.outputTokens,
                    totalTokens: split.inputTokens + split.outputTokens,
                    ...(split.cacheHitInputTokens === null ? {} : { cacheHitInputTokens: split.cacheHitInputTokens }),
                    ...(split.cacheMissInputTokens === null
                      ? {}
                      : { cacheMissInputTokens: split.cacheMissInputTokens }),
                  }
                : null,
            ...(error instanceof BubbleValidationError ? { presentation: error.presentation } : {}),
          });
        if (!recorded) {
          // Complete response, failed validation: offer the model's raw words to an observer that wants them (a
          // preview). Best effort and before finish(); it can neither change the observation nor throw.
          if (value !== undefined && typeof observer?.rejected === 'function') {
            try {
              observer.rejected({ raw: rawModelOutput(value), errorCode: errorCode(error) });
            } catch {
              /* diagnosis only */
            }
          }
          await finishProviderCall(
            observer,
            chatObservation(ref.provider, value, combined.aborted ? 'interrupted' : 'failed', errorCode(error)),
          );
        }
        throw error;
      }
      if (handoff && accept) {
        try {
          await accept(handoff);
        } catch {
          throw new DomainError('TEXT_STAGE_CONFIRMATION_FAILED');
        }
      }
      return parsed;
    };
    /** Walk the stage's model chain: only a definitely-not-billed failure moves on, and only to the next model. */
    const call = async <T extends TextDraft>(
      stage: TextGenerationStage['stage'],
      messages: ReturnType<typeof promptMessages>,
      outputTool: ReturnType<typeof draftTool>,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      const chain = chains[stage];
      for (let index = 0; ; index++) {
        const ref = chain[index]!;
        const next = (error: unknown) =>
          route !== undefined &&
          index + 1 < chain.length &&
          error instanceof DomainError &&
          !combined.aborted &&
          isNotBilled(error.code);
        let current = index === 0 ? reservation : undefined;
        if (index > 0 && meter) {
          current = await meter.reserve([specFor(stage, ref)]);
          reservations.push(current);
        }
        try {
          return await attemptCall(stage, ref, current, next, messages, outputTool, parse);
        } catch (error) {
          if (next(error)) continue;
          throw error;
        }
      }
    };
    try {
      try {
        reservation = await meter?.reserve([
          ...(!knownDraft ? [specFor('draft', chains.draft[0]!)] : []),
          specFor('review', chains.review[0]!),
        ]);
        if (reservation) reservations.push(reservation);
        if (knownDraft) stages.push(structuredClone(knownDraft.metadata));
        const draft =
          knownParsedDraft ??
          (await call('draft', messages, draftTool(frozen.deliveryMode), (value) => parseTextDraft(value, frozen)));
        const reply = await call('review', reviewPromptMessages(frozen, draft), reviewTool(frozen), (value) =>
          applyTextReview(value, draft, frozen, DROP_INVALID_METADATA),
        );
        return { ...metadata(), reply };
      } finally {
        for (const item of reservations) await closeProviderReservation(item);
      }
    } catch (error) {
      // No draft fallback or hidden third call; retain known first-stage usage if review fails.
      throw new TextGenerationFailure(errorCode(error), metadata());
    }
  }
}
