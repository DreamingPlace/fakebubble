import type { AcceptedV7StageOutput, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type {
  WebGenerationBinding,
  WebGenerationSession,
  WebKnownDraft,
  WebTextJob,
  WebTextRun,
} from '../../../packages/contracts/web-generation-rpc.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import type { TextRoute } from '../../../packages/contracts/text-route.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MODEL,
  EmbeddingFailure,
  checkEmbeddingInput,
  parseEmbeddingVectors,
  type EmbeddingProvider,
} from '../generation/embedding-provider.ts';
import {
  textPolicyHash,
  textWriterPolicyHash,
  textWriterProfilePolicyHash,
  textWriterMemesPolicyHash,
} from '../generation/text-generation-policy.ts';
import { TextGenerationFailure } from '../generation/text-generation-error.ts';
import { SpeechFailure } from '../../../workers/audio/validation-error.ts';
import type { FakeFish } from '../generation/web-provider-runner.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { clipPromptHash } from '../characters/clip-direction-prompt.ts';
import { cocreationTidyHash, COCREATION_TIDY_PROMPT } from '../cocreation/web-cocreation-tidy-prompt.ts';
import { cocreationWordingsHash, COCREATION_WORDINGS_PROMPT } from '../cocreation/web-cocreation-wordings-prompt.ts';
import type { ClipDirectionModel } from '../characters/web-clip-direction.ts';
import type { RehearsalJudgeModel } from '../characters/web-rehearsal-runner.ts';

async function session<T>(
  binding: WebGenerationBinding,
  signal: AbortSignal,
  work: (remote: WebGenerationSession) => Promise<T>,
) {
  ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
  const remote = await binding.open();
  const cancel = () => {
    void remote.cancel().catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    if (signal.aborted) {
      await remote.cancel();
      throw new DomainError('WEB_PROVIDER_ABORTED');
    }
    return await work(remote);
  } finally {
    signal.removeEventListener('abort', cancel);
    remote[Symbol.dispose]();
  }
}
/**
 * Part 54: the business object never waits for generation longer than the call can legitimately take. Generation enforces a
 * limit on each provider call and returns a structured result, so this only fires when the call itself is lost; the caller then
 * treats the call as UNKNOWN (held, never retried).
 */
export function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('WEB_GENERATION_CALL_TIMEOUT')), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}
async function callback<T>(work: () => T | Promise<T>) {
  try {
    return await work();
  } catch (error) {
    throw new Error(error instanceof DomainError ? error.code : 'WEB_GENERATION_CALLBACK_FAILED');
  }
}
function meterCallbacks(meter: ProviderMeter, signal: AbortSignal): ProviderMeter {
  return {
    reserve: (specs) =>
      callback(async () => {
        ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
        const reservation = await meter.reserve(specs);
        return {
          start: (stage, hash, bytes) =>
            callback(async () => {
              ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
              const observer = await reservation.start(stage, hash, bytes);
              ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
              // Bill callbacks remain valid after cancellation and must not be dropped.
              return {
                finish: (value) => callback(() => observer.finish(value)),
                // Admin-preview diagnosis only: forwarded best effort, it can neither throw nor change the bill.
                rejected: (output) => {
                  try {
                    if (typeof output?.raw === 'string' && typeof output.errorCode === 'string')
                      observer.rejected?.({ raw: output.raw, errorCode: output.errorCode });
                  } catch {
                    /* diagnosis only */
                  }
                },
              };
            }),
          close: () => callback(() => reservation.close()),
        };
      }),
  };
}

/** Business retains the existing stage callbacks and ledger; the provider Worker cannot write SQL. */
export class WebCloudTextGenerator {
  readonly textProtocol = 'accepted-v7' as const;
  readonly policyHash = textPolicyHash();
  /** Part 37a: what a v8 reply's policy hashes to (the resolved policy plus the pinned v8 prompts, protocol and sampling). */
  readonly writerPolicyHash = textWriterPolicyHash();
  /** Part 37b: a 新+档案 reply's policy hash. */
  readonly writerProfilePolicyHash = textWriterProfilePolicyHash();
  /** Part 37c-1: a 新+档案+梗 reply's policy hash. */
  readonly writerMemesPolicyHash = textWriterMemesPolicyHash();
  private readonly binding: WebGenerationBinding;
  constructor(binding: WebGenerationBinding) {
    this.binding = binding;
  }
  /**
   * Part 54: the reply path. One call, one result: nothing in `job` is a function and generation never calls back while it runs.
   * The runner has reserved the money for every stage before this call and settles from the returned record after it.
   */
  supportsRunText() {
    return typeof this.binding.runText === 'function';
  }
  async runText(job: WebTextJob): Promise<WebTextRun> {
    ensure(this.binding.runText, 'WEB_GENERATION_ROUTE_MISSING');
    return withDeadline(this.binding.runText(job), 2 * job.callTimeoutMs + 10_000);
  }
  private generate(
    request: TextGenerationRequest,
    signal: AbortSignal,
    known: WebKnownDraft | null,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
    route?: TextRoute,
  ) {
    ensure(meter, 'WEB_SHARED_BUDGET_REQUIRED');
    return session(this.binding, signal, async (remote) => {
      const result = await remote.text(
        request,
        request.writer === 'v8'
          ? request.writerMemes === true
            ? this.writerMemesPolicyHash
            : request.writerProfile === true
              ? this.writerProfilePolicyHash
              : this.writerPolicyHash
          : this.policyHash,
        known,
        meterCallbacks(meter, signal),
        (stage) => callback(() => accept(stage)),
        ...(route ? [route] : []),
      );
      if (result.ok) return result.value;
      if (result.generation) throw new TextGenerationFailure(result.code, result.generation);
      throw new DomainError(result.code);
    });
  }
  generateAcceptedStages(
    request: TextGenerationRequest,
    signal: AbortSignal,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
    route?: TextRoute,
  ) {
    return this.generate(request, signal, null, accept, meter, route);
  }
  generateAcceptedReviewFromKnownDraft(
    request: TextGenerationRequest,
    signal: AbortSignal,
    known: WebKnownDraft,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
    route?: TextRoute,
  ) {
    return this.generate(request, signal, known, accept, meter, route);
  }
}
export function webCloudSpeech(binding: WebGenerationBinding): FakeFish {
  return async (wire, signal, authorize, options) => {
    ensure(authorize, 'WEB_PROVIDER_SEND_GATE_REQUIRED');
    // Part 54: one call, one result, no callback. The send gate is checked HERE, immediately before the call: if it refuses,
    // nothing was sent.
    ensure(binding.runSpeech, 'WEB_GENERATION_ROUTE_MISSING');
    ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
    await authorize();
    ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
    const callTimeoutMs = options?.callTimeoutMs ?? 50_000;
    const result = await withDeadline(
      binding.runSpeech({ reservationId: wire.wireRequestHash, wire, callTimeoutMs }),
      callTimeoutMs + 10_000,
    );
    if (!result.ok) {
      if (result.generation) throw new SpeechFailure(result.code, result.generation);
      throw new DomainError(result.code);
    }
    const value = result.value;
    ensure(value.inputUTF8Bytes === wire.billedTextBytes && value.model === wire.model, 'WEB_PROVIDER_USAGE_MISMATCH');
    return {
      audio: value.audio,
      usageUnits: wire.billedTextBytes,
      receipt: {
        requestId: value.requestId,
        elapsedMs: value.elapsedMs,
        durationMs: value.durationMs,
        containerNormalization: value.containerNormalization ?? null,
      },
    };
  };
}

/** Embeddings through the isolated generation Worker; vectors come back to the business object, which alone stores them. */
export function webCloudEmbeddings(binding: WebGenerationBinding): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    dims: EMBEDDING_DIMS,
    embed: async (texts, signal, authorize) => {
      checkEmbeddingInput(texts);
      // Part 54: one call, one result. The gate (the ledger's send check) is made here, immediately before the call.
      ensure(binding.runEmbed, 'WEB_GENERATION_ROUTE_MISSING');
      ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
      try {
        await authorize?.();
      } catch (error) {
        throw new EmbeddingFailure(error instanceof DomainError ? error.code : 'WEB_GENERATION_CALLBACK_FAILED', true);
      }
      const result = await withDeadline(
        binding.runEmbed({ reservationId: 'embed', wire: { texts: [...texts], model: EMBEDDING_MODEL } }),
        60_000,
      );
      if (!result.ok) throw new EmbeddingFailure(result.code, result.known);
      return {
        vectors: parseEmbeddingVectors(result.value.vectors, texts.length),
        usageTokens: result.value.usageTokens,
        requestId: result.value.requestId,
      };
    },
  };
}

/**
 * Part 30: 按反馈重录's text call through the isolated generation Worker (the only provider caller). The model is the draft model
 * that Worker's DeepSeek generator uses (no model option, so DEFAULT_TEXT_MODELS.draft); the business object prices the hold for it
 * and refuses an answer from any other model. An older Worker without `complete` fails the call (nothing is sent).
 */
export function webCloudDirection(binding: WebGenerationBinding): ClipDirectionModel {
  return {
    model: DEFAULT_TEXT_MODELS.draft,
    completePlain: (input, signal, authorize) =>
      session(binding, signal, async (remote) => {
        ensure(remote.complete, 'WEB_GENERATION_ROUTE_MISSING');
        const result = await remote.complete(
          {
            system: input.system,
            systemSha256: clipPromptHash(input.system),
            user: input.user,
            maxTokens: input.maxTokens,
          },
          () =>
            callback(async () => {
              ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
              await authorize?.();
            }),
        );
        if (!result.ok) throw new DomainError(result.code);
        return result.value;
      }),
  };
}

/**
 * Part 39: 整理's text call, the same plain-completion route as 按反馈重录 with its own pinned prompt (text and hash). Anything but the
 * pinned co-creation prompt is refused by the generation Worker before anything is sent.
 */
export function webCloudTidy(binding: WebGenerationBinding): ClipDirectionModel {
  return {
    model: DEFAULT_TEXT_MODELS.draft,
    completePlain: (input, signal, authorize) =>
      session(binding, signal, async (remote) => {
        ensure(remote.complete, 'WEB_GENERATION_ROUTE_MISSING');
        ensure(input.system === COCREATION_TIDY_PROMPT, 'WEB_PROVIDER_WIRE_MISMATCH');
        const result = await remote.complete(
          {
            system: input.system,
            systemSha256: cocreationTidyHash(input.system),
            user: input.user,
            maxTokens: input.maxTokens,
          },
          () =>
            callback(async () => {
              ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
              await authorize?.();
            }),
        );
        if (!result.ok) throw new DomainError(result.code);
        return result.value;
      }),
  };
}

/**
 * Part 39b: 生成's text call (the wording pool), the same plain-completion route with its own pinned prompt (text and hash). Anything but
 * the pinned prompt is refused by the generation Worker before anything is sent.
 */
export function webCloudWordings(binding: WebGenerationBinding): ClipDirectionModel {
  return {
    model: DEFAULT_TEXT_MODELS.draft,
    completePlain: (input, signal, authorize) =>
      session(binding, signal, async (remote) => {
        ensure(remote.complete, 'WEB_GENERATION_ROUTE_MISSING');
        ensure(input.system === COCREATION_WORDINGS_PROMPT, 'WEB_PROVIDER_WIRE_MISMATCH');
        const result = await remote.complete(
          {
            system: input.system,
            systemSha256: cocreationWordingsHash(input.system),
            user: input.user,
            maxTokens: input.maxTokens,
          },
          () =>
            callback(async () => {
              ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
              await authorize?.();
            }),
        );
        if (!result.ok) throw new DomainError(result.code);
        return result.value;
      }),
  };
}

/**
 * Part 35: the 多轮预演 judge through the isolated generation Worker. The model is named by the caller (a house reviewer) and the
 * Worker runs only the pinned judge prompts. An older Worker without `judge` fails the call (nothing is sent).
 */
export function webCloudJudge(binding: WebGenerationBinding): RehearsalJudgeModel {
  return {
    completeJson: (input, signal, authorize) =>
      session(binding, signal, async (remote) => {
        ensure(remote.judge, 'WEB_GENERATION_ROUTE_MISSING');
        const result = await remote.judge(input, () =>
          callback(async () => {
            ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
            await authorize?.();
          }),
        );
        if (!result.ok) throw new DomainError(result.code);
        return result.value;
      }),
  };
}
