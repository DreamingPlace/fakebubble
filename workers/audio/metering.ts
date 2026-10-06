import { closeProviderReservation } from '../../packages/domain/provider-metering.ts';
import type { FishModel, SpeechResult } from '../../packages/contracts/audio.ts';
import type {
  ProviderCallObserver,
  ProviderMeter,
  ProviderReservation,
} from '../../packages/contracts/provider-calls.ts';
import { DomainError } from '../../packages/domain/errors.ts';
import { audioGeneration, SpeechFailure } from './validation-error.ts';

/** Runs in the parent when using SpeechProcess; no callbacks or ledger data enter its child. */
export async function meteredSpeech(
  meter: ProviderMeter | undefined,
  model: FishModel,
  bytes: number,
  requestHash: string,
  action: () => Promise<SpeechResult>,
): Promise<SpeechResult> {
  let reservation: ProviderReservation | undefined,
    observer: ProviderCallObserver | undefined,
    recorded = false;
  let knownGeneration: ReturnType<typeof audioGeneration> | null = null;
  const finish = async (generation: ReturnType<typeof audioGeneration> | null, error: unknown) => {
    if (!observer) return;
    const code = error instanceof DomainError ? error.code : error ? 'AUDIO_NETWORK_ERROR' : null;
    try {
      await observer.finish({
        outcome: code ? (/ABORTED|TIMEOUT/.test(code) ? 'interrupted' : 'failed') : 'succeeded',
        errorCode: code,
        providerRequestId: generation?.requestId ?? null,
        reportedModel: generation?.model ?? null,
        usage: {
          unit: 'utf8_bytes',
          bytes: generation?.model === model && generation.inputUTF8Bytes === bytes ? bytes : null,
        },
      });
    } catch {
      if (generation) throw new SpeechFailure('COST_RECORDING_FAILED', generation);
      throw new DomainError('COST_RECORDING_FAILED');
    }
  };
  try {
    reservation = await meter?.reserve([
      { provider: 'fish', model, stage: 'speech', bounds: { unit: 'utf8_bytes', bytes } },
    ]);
    observer = await reservation?.start('speech', requestHash);
    const result = await action(),
      generation = audioGeneration(result);
    knownGeneration = generation;
    recorded = true;
    await finish(generation, null);
    return result;
  } catch (error) {
    if (error instanceof SpeechFailure) knownGeneration = error.generation;
    if (!recorded) await finish(knownGeneration, error);
    throw error;
  } finally {
    try {
      await closeProviderReservation(reservation);
    } catch {
      if (knownGeneration) throw new SpeechFailure('COST_RECORDING_FAILED', knownGeneration);
      throw new DomainError('COST_RECORDING_FAILED');
    }
  }
}
