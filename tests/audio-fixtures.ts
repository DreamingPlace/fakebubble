import { Buffer } from 'node:buffer';
/** Synthetic tone, not a cloned voice or acceptance sample. */
export function tone(durationMs = 1000, sampleRate = 24000, channels = 1, silent = false): Buffer {
  const frames = Math.round(durationMs * sampleRate / 1000); const size = frames * channels * 2;
  const wav = Buffer.alloc(44 + size); wav.write('RIFF', 0); wav.writeUInt32LE(36 + size, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(channels, 22); wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * 2, 28); wav.writeUInt16LE(channels * 2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(size, 40);
  for (let i = 0; i < frames; i++) for (let channel = 0; channel < channels; channel++) {
    wav.writeInt16LE(silent ? 0 : Math.round(Math.sin(i / sampleRate * 440 * 2 * Math.PI) * 6000), 44 + (i * channels + channel) * 2);
  }
  return wav;
}
export function extensible(wav: Buffer): Buffer {
  const fmt = Buffer.alloc(48); fmt.write('fmt '); fmt.writeUInt32LE(40, 4); wav.copy(fmt, 8, 20, 36);
  fmt.writeUInt16LE(0xfffe, 8); fmt.writeUInt16LE(22, 24); fmt.writeUInt16LE(16, 26); fmt.writeUInt32LE(4, 28);
  Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(fmt, 32);
  const junk = Buffer.alloc(12); junk.write('JUNK'); junk.writeUInt32LE(3, 4); junk.write('PII', 8);
  const result = Buffer.concat([wav.subarray(0, 12), fmt, junk, wav.subarray(36)]);
  result.writeUInt32LE(result.length - 8, 4); return result;
}
