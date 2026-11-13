import { Buffer } from 'node:buffer';
import { DomainError } from '../../packages/domain/errors.ts';
import { inspectPCM } from './wav.ts';

/**
 * Part 30 section 4: in every GENERATED welcome/footer take the character's voice starts at exactly VOICE_START_MS.
 * Fish's own audio has leading silence of any length (0 ms ... a second), so adding a fixed amount in front is wrong:
 * the onset is FOUND and the start is rebuilt around it. Uploaded takes never pass through here.
 *
 * Onset: the start of the first ONSET_WINDOW_MS window whose RMS is above ONSET_DBFS and that is followed by ONSET_HOLD_MS
 * in which MORE THAN HALF of the windows are also above it (a single click or pop is therefore not an onset). Windows
 * advance by ONSET_HOP_MS, so the onset is found to within that hop; PREROLL_MS of audio before it is kept to absorb it.
 */
export const VOICE_START_MS = 300;
/** Digital silence, then the pre-roll, then the audio from the onset on: VOICE_START_MS = SILENCE_MS + PREROLL_MS. */
export const PREROLL_MS = 20;
export const SILENCE_MS = VOICE_START_MS - PREROLL_MS;
export const ONSET_WINDOW_MS = 10;
export const ONSET_HOP_MS = 5;
export const ONSET_DBFS = -45;
export const ONSET_HOLD_MS = 50;

/** Raised when the audio has no voice at all; callers store the take as unusable with this code. */
export const NO_ONSET_CODE = 'WEB_SPEECH_NO_ONSET';

const FULL_SCALE = 32768;
const threshold = 10 ** (ONSET_DBFS / 20);

/** The sample index where the voice starts, or null when there is none. Mono PCM16 samples. */
export function findOnset(samples: Int16Array, sampleRate: number): number | null {
  const window = Math.round((ONSET_WINDOW_MS * sampleRate) / 1000),
    hop = Math.round((ONSET_HOP_MS * sampleRate) / 1000),
    hold = Math.round((ONSET_HOLD_MS * sampleRate) / 1000);
  if (samples.length < window) return null;
  // Running sum of squares per window start (cheap enough: a clip is at most 60 s).
  const loud = (start: number) => {
    let squares = 0;
    for (let i = start; i < start + window; i++) {
      const v = samples[i]! / FULL_SCALE;
      squares += v * v;
    }
    return Math.sqrt(squares / window) > threshold;
  };
  const last = samples.length - window;
  for (let start = 0; start <= last; start += hop) {
    if (!loud(start)) continue;
    let following = 0,
      above = 0;
    for (let next = start + hop; next <= Math.min(start + hold, last); next += hop) {
      following++;
      if (loud(next)) above++;
    }
    // A clip that ends inside the hold window is judged on the windows it has (a single short word is still a word).
    if (following > 0 && above * 2 > following) return start;
    if (following === 0) return start;
  }
  return null;
}

/** Rebuild the start of a PCM16 mono WAV so the onset sits at VOICE_START_MS. Throws DomainError(NO_ONSET_CODE) when none. */
export function placeVoiceStart(wav: Uint8Array): { audio: Buffer; onsetMs: number } {
  const info = inspectPCM(wav, 60_000);
  if (info.channels !== 1) throw new DomainError('INVALID_MATERIAL_AUDIO');
  const view = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  const count = info.dataLength / 2,
    samples = new Int16Array(count);
  for (let i = 0; i < count; i++) samples[i] = view.readInt16LE(info.dataOffset + i * 2);
  const onset = findOnset(samples, info.sampleRate);
  if (onset === null) throw new DomainError(NO_ONSET_CODE);
  const start = Math.round((VOICE_START_MS * info.sampleRate) / 1000),
    preroll = Math.min(onset, Math.round((PREROLL_MS * info.sampleRate) / 1000)),
    zeros = start - preroll,
    rest = samples.length - (onset - preroll);
  const out = new Int16Array(zeros + rest);
  // zeros are already 0; the pre-roll fades in linearly from silence, the rest is the original, untouched.
  for (let i = 0; i < preroll; i++) out[zeros + i] = Math.round(samples[onset - preroll + i]! * (i / preroll));
  out.set(samples.subarray(onset), zeros + preroll);
  const body = Buffer.alloc(out.length * 2);
  for (let i = 0; i < out.length; i++) body.writeInt16LE(out[i]!, i * 2);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + body.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(info.sampleRate, 24);
  header.writeUInt32LE(info.sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(body.length, 40);
  return { audio: Buffer.concat([header, body]), onsetMs: (onset / info.sampleRate) * 1000 };
}

/** Where the voice starts in a WAV (ms), or null: for the report and for tests. */
export function onsetMsOf(wav: Uint8Array): number | null {
  const info = inspectPCM(wav, 600_000);
  const view = Buffer.from(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = new Int16Array(info.dataLength / 2 / info.channels);
  for (let i = 0; i < samples.length; i++) samples[i] = view.readInt16LE(info.dataOffset + i * 2 * info.channels);
  const onset = findOnset(samples, info.sampleRate);
  return onset === null ? null : (onset / info.sampleRate) * 1000;
}
