import { createHash } from 'node:crypto';
import type { SpeechRequest, SpeechResult } from '../../packages/contracts/audio.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { inspectPCM, pcmLevels } from '../../workers/audio/wav.ts';
import { audioGeneration } from '../../workers/audio/validation-error.ts';
import type { BusinessStore as Store } from './store-contract.ts';

export const maximumAudioBytes = 6_000_000;
export const safeAudioError = (error: unknown) =>
  error instanceof DomainError && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.code) ? error.code : 'AUDIO_GENERATION_FAILED';
// Both callers check and claim inside the same SQLite write transaction.
export const runningAudioCount = (store: Store) =>
  store.get<{ n: number }>(`SELECT
  (SELECT count(*) FROM speech_tasks WHERE state='generating') +
  (SELECT count(*) FROM admin_voice_previews WHERE state='generating') n`)!.n;

export function speechMetadata(result: SpeechResult) {
  ensure(
    result.containerNormalization === undefined || result.containerNormalization === 'stream_length_fields',
    'INVALID_AUDIO_METADATA',
  );
  return { ...audioGeneration(result), containerNormalization: result.containerNormalization ?? null };
}
export function validateSpeech(result: SpeechResult, request: SpeechRequest) {
  ensure(
    result.jobId === request.jobId &&
      result.voice?.profileId === request.voice.profileId &&
      result.voice.version === request.voice.version &&
      result.voice.referenceId === request.voice.referenceId &&
      result.provider === 'fish' &&
      result.model === request.model &&
      result.mime === 'audio/wav',
    'AUDIO_IDENTITY_MISMATCH',
  );
  ensure(
    result.audio instanceof Uint8Array && result.audio.byteLength <= maximumAudioBytes,
    'AUDIO_RESPONSE_TOO_LARGE',
  );
  const info = inspectPCM(result.audio, 60_000);
  ensure(
    info.channels === 1 && info.sampleRate === 24000 && pcmLevels(result.audio).rms > 0.00001,
    'INVALID_GENERATED_AUDIO',
  );
  return {
    durationMs: Math.round(info.durationMs),
    byteLength: result.audio.byteLength,
    sha256: createHash('sha256').update(result.audio).digest('hex'),
  };
}
