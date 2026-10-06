import type { AcceptedV7StageOutput, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type {
  WebGenerationBinding,
  WebGenerationSession,
  WebKnownDraft,
} from '../../../packages/contracts/web-generation-rpc.ts';
import type { ProviderMeter } from '../../../packages/contracts/provider-calls.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { textPolicyHash } from '../text-generation-policy.ts';
import { TextGenerationFailure } from '../text-generation-error.ts';
import { SpeechFailure } from '../../../workers/audio/validation-error.ts';
import type { FakeFish } from '../web-provider-runner.ts';

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
              return { finish: (value) => callback(() => observer.finish(value)) };
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
  ) {
    ensure(meter, 'WEB_SHARED_BUDGET_REQUIRED');
    return session(this.binding, signal, async (remote) => {
      const result = await remote.text(request, this.policyHash, known, meterCallbacks(meter, signal), (stage) =>
        callback(() => accept(stage)),
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
  ) {
    return this.generate(request, signal, null, accept, meter);
  }
  generateAcceptedReviewFromKnownDraft(
    request: TextGenerationRequest,
    signal: AbortSignal,
    known: WebKnownDraft,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    meter?: ProviderMeter,
  ) {
    return this.generate(request, signal, known, accept, meter);
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
