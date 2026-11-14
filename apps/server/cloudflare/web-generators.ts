import type { AcceptedV7StageOutput, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type {
  WebGenerationBinding,
  WebGenerationSession,
  WebKnownDraft,
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
import { textPolicyHash } from '../generation/text-generation-policy.ts';
import { TextGenerationFailure } from '../generation/text-generation-error.ts';
import { SpeechFailure } from '../../../workers/audio/validation-error.ts';
import type { FakeFish } from '../generation/web-provider-runner.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { clipPromptHash } from '../characters/clip-direction-prompt.ts';
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
  private readonly binding: WebGenerationBinding;
  constructor(binding: WebGenerationBinding) {
    this.binding = binding;
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
        this.policyHash,
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
  return (wire, signal, authorize) => {
    ensure(authorize, 'WEB_PROVIDER_SEND_GATE_REQUIRED');
    return session(binding, signal, async (remote) => {
      const result = await remote.speech(wire, () =>
        callback(async () => {
          ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
          await authorize();
        }),
      );
      if (!result.ok) {
        if (result.generation) throw new SpeechFailure(result.code, result.generation);
        throw new DomainError(result.code);
      }
      const value = result.value;
      ensure(
        value.inputUTF8Bytes === wire.billedTextBytes && value.model === wire.model,
        'WEB_PROVIDER_USAGE_MISMATCH',
      );
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
    });
  };
}

/** Embeddings through the isolated generation Worker; vectors come back to the business object, which alone stores them. */
export function webCloudEmbeddings(binding: WebGenerationBinding): EmbeddingProvider {
  return {
    model: EMBEDDING_MODEL,
    dims: EMBEDDING_DIMS,
    embed: (texts, signal, authorize) => {
      checkEmbeddingInput(texts);
      return session(binding, signal, async (remote) => {
        const result = await remote.embed({ texts: [...texts], model: EMBEDDING_MODEL }, () =>
          callback(async () => {
            ensure(!signal.aborted, 'WEB_PROVIDER_ABORTED');
            await authorize?.();
          }),
        );
        if (!result.ok) throw new EmbeddingFailure(result.code, result.known);
        return {
          vectors: parseEmbeddingVectors(result.value.vectors, texts.length),
          usageTokens: result.value.usageTokens,
          requestId: result.value.requestId,
        };
      });
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
