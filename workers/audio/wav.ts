import { Buffer } from 'node:buffer';
import type { PCMInfo } from '../../packages/contracts/audio.ts';
import { ensure } from '../../packages/domain/errors.ts';

const PCM_GUID = Buffer.from('0100000000001000800000aa00389b71', 'hex');
/** Strict RIFF/WAVE PCM16 parser, including Apple's WAVE_FORMAT_EXTENSIBLE output. */
export function inspectPCM(bytes: Uint8Array, maximumMs = 600_000): PCMInfo {
  ensure(Number.isFinite(maximumMs) && maximumMs > 0, 'INVALID_AUDIO_LIMIT');
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  ensure(
    buffer.length >= 44 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE',
    'INVALID_WAV',
  );
  const declared = buffer.readUInt32LE(4);
  ensure(declared === buffer.length - 8 || declared === 0xffffffff, 'INCOMPLETE_WAV');
  let format: { channels: number; sampleRate: number; blockAlign: number } | undefined;
  let data: { dataOffset: number; dataLength: number } | undefined;
  for (let offset = 12; offset < buffer.length; ) {
    ensure(offset + 8 <= buffer.length, 'INCOMPLETE_WAV');
    const tag = buffer.toString('ascii', offset, offset + 4);
    const length = buffer.readUInt32LE(offset + 4);
    const payload = offset + 8;
    const size = tag === 'data' && length === 0xffffffff ? buffer.length - payload : length;
    ensure(payload + size <= buffer.length, 'INCOMPLETE_WAV');
    if (tag === 'fmt ') {
      ensure(!format && size >= 16, 'INVALID_WAV');
      const encoding = buffer.readUInt16LE(payload);
      const channels = buffer.readUInt16LE(payload + 2);
      const sampleRate = buffer.readUInt32LE(payload + 4);
      const byteRate = buffer.readUInt32LE(payload + 8);
      const blockAlign = buffer.readUInt16LE(payload + 12);
      const bits = buffer.readUInt16LE(payload + 14);
      const extensiblePCM =
        encoding === 0xfffe &&
        size >= 40 &&
        buffer.readUInt16LE(payload + 16) >= 22 &&
        buffer.readUInt16LE(payload + 16) + 18 <= size &&
        buffer.readUInt16LE(payload + 18) === 16 &&
        buffer.subarray(payload + 24, payload + 40).equals(PCM_GUID);
      ensure(
        (encoding === 1 || extensiblePCM) &&
          bits === 16 &&
          [1, 2].includes(channels) &&
          [8000, 16000, 22050, 24000, 32000, 44100, 48000, 96000].includes(sampleRate) &&
          blockAlign === channels * 2 &&
          byteRate === sampleRate * blockAlign,
        'UNSUPPORTED_WAV',
      );
      format = { channels, sampleRate, blockAlign };
    }
    if (tag === 'data') {
      ensure(!data && size > 0, 'INVALID_WAV');
      data = { dataOffset: payload, dataLength: size };
    }
    offset = payload + size + (size % 2);
    ensure(offset <= buffer.length, 'INCOMPLETE_WAV');
  }
  ensure(format && data && data.dataLength % format.blockAlign === 0, 'INVALID_WAV');
  const frames = data.dataLength / format.blockAlign;
  const durationMs = (frames / format.sampleRate) * 1000;
  ensure(durationMs > 0 && durationMs <= maximumMs, 'AUDIO_DURATION_LIMIT');
  return { ...data, channels: format.channels, sampleRate: format.sampleRate, frames, durationMs };
}

/** Call only after Fish's bounded HTTP body reaches EOF; never repairs a finite, truncated WAV. */
export function finalizeFishWav(bytes: Uint8Array): { audio: Buffer; finalized: boolean } {
  const audio = Buffer.from(bytes);
  let finalized = false;
  if (
    audio.length > 44 &&
    audio.toString('ascii', 0, 4) === 'RIFF' &&
    audio.toString('ascii', 8, 16) === 'WAVEfmt ' &&
    audio.readUInt32LE(16) === 16 &&
    audio.toString('ascii', 36, 40) === 'data'
  ) {
    const riffSize = audio.readUInt32LE(4);
    const dataSize = audio.readUInt32LE(40);
    // Empty upstream header, UINT_MAX, or the exact hosted-API streaming pair captured in QA.
    if (
      (riffSize === 36 && dataSize === 0) ||
      (riffSize === 0xffffffff && dataSize === 0xffffffff) ||
      (riffSize === 0xffffff24 && dataSize === 0xffffff00)
    ) {
      audio.writeUInt32LE(audio.length - 8, 4);
      audio.writeUInt32LE(audio.length - 44, 40);
      finalized = true;
    }
  }
  inspectPCM(audio, 60_000);
  return { audio, finalized };
}

/** Strip container metadata and preserve the selected PCM exactly; never modifies the original. */
export function slicePCM(bytes: Uint8Array, startMs: number, endMs: number, maximumSourceMs = 600_000): Buffer {
  const info = inspectPCM(bytes, maximumSourceMs);
  ensure(
    Number.isFinite(startMs) && Number.isFinite(endMs) && startMs >= 0 && endMs > startMs && endMs <= info.durationMs,
    'INVALID_AUDIO_RANGE',
  );
  const start = Math.round((startMs * info.sampleRate) / 1000);
  const end = Math.round((endMs * info.sampleRate) / 1000);
  const length = (end - start) * info.channels * 2;
  ensure(length > 0, 'INVALID_AUDIO_RANGE');
  const result = Buffer.alloc(44 + length);
  result.write('RIFF', 0);
  result.writeUInt32LE(36 + length, 4);
  result.write('WAVEfmt ', 8);
  result.writeUInt32LE(16, 16);
  result.writeUInt16LE(1, 20);
  result.writeUInt16LE(info.channels, 22);
  result.writeUInt32LE(info.sampleRate, 24);
  result.writeUInt32LE(info.sampleRate * info.channels * 2, 28);
  result.writeUInt16LE(info.channels * 2, 32);
  result.writeUInt16LE(16, 34);
  result.write('data', 36);
  result.writeUInt32LE(length, 40);
  Buffer.from(bytes).copy(
    result,
    44,
    info.dataOffset + start * info.channels * 2,
    info.dataOffset + end * info.channels * 2,
  );
  return result;
}

export function pcmLevels(bytes: Uint8Array) {
  const info = inspectPCM(bytes);
  const data = Buffer.from(bytes);
  let squares = 0;
  let peak = 0;
  let clipped = 0;
  for (let offset = info.dataOffset; offset < info.dataOffset + info.dataLength; offset += 2) {
    const sample = data.readInt16LE(offset) / 32768;
    squares += sample * sample;
    peak = Math.max(peak, Math.abs(sample));
    if (Math.abs(sample) >= 0.999) clipped++;
  }
  const count = info.dataLength / 2;
  return { rms: Math.sqrt(squares / count), peak, clippedRatio: clipped / count };
}
