import { providerRequestHash } from '../../packages/domain/provider-request.ts';
import { finishProviderCall, closeProviderReservation } from '../../packages/domain/provider-metering.ts';
import { createHash } from 'node:crypto';
import type {
  AcceptedV7StageOutput,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStage,
  TextGenerator,
} from '../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { promptMessages, reviewPromptMessages } from './text-prompt.ts';
import { dialogueCandidate } from '../../packages/domain/dialogue.ts';
import { bubbleLimits, BubbleValidationError, inspectBubbles } from '../../packages/domain/bubbles.ts';
import { groupEvidenceSource } from './context-evidence.ts';
import { TextGenerationFailure } from './text-generation-error.ts';
import { applyTextReview, draftTool, parseTextDraft, reviewTool, validateDialogueEvidence } from './text-protocol.ts';
import type { TextDraft } from './text-protocol.ts';
import { createTextGenerationPolicy, generationPolicyHash, textRequestParameters } from './text-generation-policy.ts';
import type { TextGenerationPolicy, TextGenerationPolicyOptions } from './text-generation-policy.ts';
import type {
  ProviderCallObserver,
  ProviderMeter,
  ProviderReservation,
} from '../../packages/contracts/provider-calls.ts';
import { DEEPSEEK_INPUT_RESERVATION, deepSeekObservation, deepSeekUsage } from './deepseek-usage.ts';
import * as acceptedPrompt from './accepted-text-prompt.ts';
import * as acceptedProtocol from './accepted-text-protocol.ts';

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
function responseMetadata(value: unknown, model: string, elapsedMs: number): Omit<TextGenerationResult, 'reply'> {
  object(value);
  let usage: TextGenerationResult['usage'] = null;
  if (value.usage !== undefined && value.usage !== null) {
    object(value.usage);
    const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = value.usage;
    ensure(integer(inputTokens) && integer(outputTokens) && integer(totalTokens), 'INVALID_TEXT_USAGE');
    const split = deepSeekUsage(value);
    usage = {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(split.cacheHitInputTokens === null ? {} : { cacheHitInputTokens: split.cacheHitInputTokens }),
      ...(split.cacheMissInputTokens === null ? {} : { cacheMissInputTokens: split.cacheMissInputTokens }),
    };
  }
  return {
    provider: 'deepseek',
    model,
    ...reportedModel(value.model),
    usage,
    elapsedMs,
    requestId: typeof value.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value.id) ? value.id : null,
  };
}

/** Strict function calls carry output data only. There is no tool dispatcher or execution loop. */
export function parseDeepSeekToolResponse(value: unknown, expectedName: string): unknown {
  object(value);
  ensure(Array.isArray(value.choices) && value.choices.length === 1, 'INVALID_TEXT_RESPONSE');
  const choice: unknown = value.choices[0];
  object(choice);
  ensure(choice.finish_reason === 'tool_calls', 'TEXT_INCOMPLETE_RESPONSE');
  object(choice.message);
  const message = choice.message;
  ensure(message.role === 'assistant', 'INVALID_TEXT_RESPONSE');
  ensure(
    !message.refusal && (message.content == null || (typeof message.content === 'string' && !message.content.trim())),
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

export class DeepSeekTextGenerator implements TextGenerator {
  readonly providerCalls = 'external' as const;
  #apiKey: string;
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

  constructor(options: TextGenerationPolicyOptions & { apiKey: string; baseUrl?: string; fetch?: typeof fetch }) {
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
  ): Promise<TextGenerationResult> {
    ensure(this.textProtocol === 'accepted-v7' && typeof accept === 'function', 'TEXT_STAGE_PROTOCOL_REQUIRED');
    return this.run(request, signal, meter, accept);
  }

  /** A trusted business ledger must supply an already-confirmed draft with its frozen bindings. */
  async generateAcceptedReviewFromKnownDraft(
    request: TextGenerationRequest,
    signal: AbortSignal,
    known: { payload: unknown; metadata: TextGenerationStage; requestDigest: string; policyHash: string },
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
  ): Promise<TextGenerationResult> {
    ensure(this.textProtocol === 'accepted-v7' && typeof accept === 'function', 'TEXT_STAGE_PROTOCOL_REQUIRED');
    return this.run(request, signal, meter, accept, known);
  }

  private async run(
    request: TextGenerationRequest,
    signal: AbortSignal,
    meter?: ProviderMeter,
    accept?: (stage: AcceptedV7StageOutput) => Promise<void>,
    knownDraft?: { payload: unknown; metadata: TextGenerationStage; requestDigest: string; policyHash: string },
  ): Promise<TextGenerationResult> {
    ensure(!signal.aborted, 'TEXT_REQUEST_ABORTED');
    // A caller changing its request while draft generation awaits cannot broaden the review's scope.
    const frozen = structuredClone(request);
    const requestDigest = createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    const prompts = this.textProtocol === 'accepted-v7' ? acceptedPrompt : { promptMessages, reviewPromptMessages };
    const protocol =
      this.textProtocol === 'accepted-v7'
        ? acceptedProtocol
        : { draftTool, reviewTool, parseTextDraft, applyTextReview };
    if (knownDraft)
      ensure(
        knownDraft.requestDigest === requestDigest &&
          knownDraft.policyHash === this.policyHash &&
          knownDraft.metadata.stage === 'draft' &&
          knownDraft.metadata.status === 'succeeded' &&
          knownDraft.metadata.model === this.model,
        'TEXT_STAGE_RESUME_INVALID',
      );
    const knownParsedDraft = knownDraft ? protocol.parseTextDraft(structuredClone(knownDraft.payload), frozen) : null;
    const messages = prompts.promptMessages(frozen);
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
        provider: 'deepseek',
        model: this.model,
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
    const call = async <T extends TextDraft>(
      stage: TextGenerationStage['stage'],
      messages: ReturnType<typeof promptMessages>,
      outputTool: ReturnType<typeof draftTool>,
      parse: (value: unknown) => T,
    ): Promise<T> => {
      ensure(!combined.aborted, errorCode(null));
      const stageStarted = performance.now();
      const model = stage === 'draft' ? this.model : this.reviewModel;
      let value: unknown;
      let observer: ProviderCallObserver | undefined,
        recorded = false;
      let parsed!: T;
      let handoff: AcceptedV7StageOutput | undefined;
      try {
        const body = JSON.stringify({
          ...textRequestParameters(this.#policy, stage, outputTool.function.name),
          messages,
          tools: [outputTool],
          user_id: createHash('sha256')
            .update(JSON.stringify([frozen.scope.worldId, frozen.scope.conversationId, frozen.scope.characterId]))
            .digest('hex'),
        });
        const wireRequestHash = providerRequestHash(this.#policy.endpoint, model, body);
        observer = await reservation?.start(stage, wireRequestHash, Buffer.byteLength(body, 'utf8'));
        ensure(!combined.aborted, errorCode(null));
        const response = await this.#fetch(this.#policy.endpoint, {
          method: 'POST',
          redirect: 'error',
          signal: combined,
          headers: { Authorization: `Bearer ${this.#apiKey}`, 'Content-Type': 'application/json' },
          body,
        });
        if (!response.ok) {
          await response.body?.cancel();
          const code =
            response.status === 401
              ? 'DEEPSEEK_AUTH_FAILED'
              : response.status === 402
                ? 'DEEPSEEK_BALANCE_REQUIRED'
                : response.status === 429
                  ? 'DEEPSEEK_RATE_LIMITED'
                  : response.status >= 500
                    ? 'DEEPSEEK_UNAVAILABLE'
                    : 'DEEPSEEK_REQUEST_REJECTED';
          throw new DomainError(code);
        }
        value = await readBody(response);
        ensure(!combined.aborted, errorCode(null));
        const payload = parseDeepSeekToolResponse(value, outputTool.function.name);
        const captured = accept ? structuredClone(payload) : undefined;
        parsed = parse(payload);
        const meta = responseMetadata(value, model, Math.round(performance.now() - stageStarted));
        recorded = true;
        await finishProviderCall(observer, deepSeekObservation(value, 'succeeded', null));
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
        const reported =
          response.usage && typeof response.usage === 'object' ? (response.usage as Record<string, unknown>) : {};
        const { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: totalTokens } = reported;
        const split = deepSeekUsage(value);
        stages.push({
          stage,
          model,
          ...reportedModel(response.model),
          status: 'failed',
          errorCode: errorCode(error),
          elapsedMs: Math.round(performance.now() - stageStarted),
          requestId: typeof response.id === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(response.id) ? response.id : null,
          usage:
            integer(inputTokens) && integer(outputTokens) && integer(totalTokens)
              ? {
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  ...(split.cacheHitInputTokens === null ? {} : { cacheHitInputTokens: split.cacheHitInputTokens }),
                  ...(split.cacheMissInputTokens === null ? {} : { cacheMissInputTokens: split.cacheMissInputTokens }),
                }
              : null,
          ...(error instanceof BubbleValidationError ? { presentation: error.presentation } : {}),
        });
        if (!recorded)
          await finishProviderCall(
            observer,
            deepSeekObservation(value, combined.aborted ? 'interrupted' : 'failed', errorCode(error)),
          );
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
    try {
      try {
        reservation = await meter?.reserve([
          ...(!knownDraft
            ? [
                {
                  provider: 'deepseek',
                  model: this.model,
                  stage: 'draft' as const,
                  bounds: {
                    unit: 'tokens' as const,
                    inputTokens: DEEPSEEK_INPUT_RESERVATION,
                    outputTokens: this.maxTokens,
                  },
                },
              ]
            : []),
          {
            provider: 'deepseek',
            model: this.reviewModel,
            stage: 'review',
            bounds: { unit: 'tokens', inputTokens: DEEPSEEK_INPUT_RESERVATION, outputTokens: this.reviewMaxTokens },
          },
        ]);
        if (knownDraft) stages.push(structuredClone(knownDraft.metadata));
        const draft =
          knownParsedDraft ??
          (await call('draft', messages, protocol.draftTool(frozen.deliveryMode), (value) =>
            protocol.parseTextDraft(value, frozen),
          ));
        const reply = await call(
          'review',
          prompts.reviewPromptMessages(frozen, draft),
          protocol.reviewTool(frozen, draft),
          (value) => protocol.applyTextReview(value, draft, frozen),
        );
        return { ...metadata(), reply };
      } finally {
        await closeProviderReservation(reservation);
      }
    } catch (error) {
      // No draft fallback or hidden third call; retain known first-stage usage if review fails.
      throw new TextGenerationFailure(errorCode(error), metadata());
    }
  }
}
