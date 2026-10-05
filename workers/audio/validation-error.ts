import { Buffer } from 'node:buffer';
import type { SpeechResult } from '../../packages/contracts/audio.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';

export type AudioGeneration = Pick<
  SpeechResult,
  | 'provider'
  | 'model'
  | 'elapsedMs'
  | 'requestId'
  | 'inputCharacters'
  | 'inputUTF8Bytes'
  | 'billedAmount'
  | 'qualityGuardRequested'
>;
/** Keep only observed, bounded provider metadata. Never serialize raw responses or private audio in errors. */
export function audioGeneration(value: unknown): AudioGeneration {
  ensure(value && typeof value === 'object', 'INVALID_AUDIO_METADATA');
  const v = value as Record<string, unknown>;
  ensure(
    v.provider === 'fish' &&
      (v.model === 's2.1-pro' || v.model === 's2-pro') &&
      Number.isSafeInteger(v.elapsedMs) &&
      Number(v.elapsedMs) >= 0 &&
      Number(v.elapsedMs) <= 300_000 &&
      Number.isSafeInteger(v.inputCharacters) &&
      Number(v.inputCharacters) > 0 &&
      Number(v.inputCharacters) <= 700 &&
      (v.requestId === null || (typeof v.requestId === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v.requestId))) &&
      v.billedAmount === null,
    'INVALID_AUDIO_METADATA',
  );
  ensure(
    v.qualityGuardRequested === undefined || typeof v.qualityGuardRequested === 'boolean',
    'INVALID_AUDIO_METADATA',
  );
  ensure(
    v.inputUTF8Bytes === undefined ||
      (Number.isSafeInteger(v.inputUTF8Bytes) && Number(v.inputUTF8Bytes) > 0 && Number(v.inputUTF8Bytes) <= 8192),
    'INVALID_AUDIO_METADATA',
  );
  return {
    provider: 'fish',
    model: v.model,
    elapsedMs: Number(v.elapsedMs),
    inputCharacters: Number(v.inputCharacters),
    requestId: v.requestId as string | null,
    billedAmount: null,
    ...(v.inputUTF8Bytes === undefined ? {} : { inputUTF8Bytes: Number(v.inputUTF8Bytes) }),
    ...(v.qualityGuardRequested === undefined ? {} : { qualityGuardRequested: v.qualityGuardRequested as boolean }),
  };
}
export class SpeechFailure extends DomainError {
  readonly generation: AudioGeneration;
  constructor(code: string, generation: AudioGeneration) {
    super(code);
    this.generation = audioGeneration(generation);
  }
}

/** Complete rejected audio for private QA recording; binary data stays out of serialized errors. */
export class AudioValidationFailure extends SpeechFailure {
  #audio: Buffer;
  constructor(code: string, audio: Uint8Array, generation: AudioValidationFailure['generation']) {
    super(code, generation);
    this.#audio = Buffer.from(audio);
  }
  rejectedAudio() {
    return Buffer.from(this.#audio);
  }
}
