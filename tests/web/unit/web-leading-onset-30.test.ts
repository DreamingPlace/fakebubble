import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import {
  NO_ONSET_CODE,
  ONSET_HOLD_MS,
  SILENCE_MS,
  VOICE_START_MS,
  findOnset,
  onsetMsOf,
  placeVoiceStart,
} from '../../../workers/audio/leading-onset.ts';
import { inspectPCM } from '../../../workers/audio/wav.ts';

/** Part 30 section 4 (correction): the voice of a generated take starts at 300 ms whatever Fish's own lead was. */
const RATE = 24000;
const ms = (n: number) => Math.round((n * RATE) / 1000);
function wav(samples: Int16Array) {
  const body = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => body.writeInt16LE(v, i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + body.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(body.length, 40);
  return new Uint8Array(Buffer.concat([head, body]));
}
/** Fish-like audio: `lead` ms of faint room noise (-60 dBFS), then 700 ms of a 220 Hz voice that ramps in over 8 ms. */
function speech(lead: number, tail = ms(100), clickAt?: number) {
  const out = new Int16Array(ms(lead) + ms(700) + tail);
  for (let i = 0; i < ms(lead); i++) out[i] = Math.round(30 * Math.sin(i * 1.7));
  for (let i = 0; i < ms(700); i++)
    out[ms(lead) + i] = Math.round(9000 * Math.min(1, i / ms(8)) * Math.sin((2 * Math.PI * 220 * i) / RATE));
  if (clickAt !== undefined) for (let i = 0; i < 24; i++) out[ms(clickAt) + i] = 26000;
  return out;
}
function samplesOf(bytes: Uint8Array) {
  const info = inspectPCM(bytes, 60_000),
    view = Buffer.from(bytes);
  return Int16Array.from({ length: info.dataLength / 2 }, (_, i) => view.readInt16LE(info.dataOffset + i * 2));
}

for (const lead of [0, 120, 300, 800, 1500])
  test(`${lead} ms of leading silence: the voice starts at 300 ms ± 10 ms`, () => {
    const before = wav(speech(lead));
    assert.ok(Math.abs((onsetMsOf(before) ?? -1) - lead) <= 10, 'the onset is found');
    const { audio } = placeVoiceStart(before);
    const after = onsetMsOf(audio)!;
    assert.ok(Math.abs(after - VOICE_START_MS) <= 10, `onset ${after}`);
    // the rest of the audio is the original from the onset on: nothing after it changed length
    assert.equal(inspectPCM(audio, 60_000).sampleRate, 24000);
  });

test('the first 280 ms are exact zero samples, and the pre-roll fades in without a step', () => {
  for (const lead of [0, 120, 800]) {
    const out = samplesOf(placeVoiceStart(wav(speech(lead))).audio);
    assert.ok(out.subarray(0, ms(SILENCE_MS)).every((v) => v === 0), `lead ${lead}: the first 280 ms are zero`);
    let jump = 0;
    for (let i = 1; i < out.length; i++) jump = Math.max(jump, Math.abs(out[i]! - out[i - 1]!));
    // a 220 Hz tone of amplitude 9000 moves at most ~519 per sample; a splice step would be far above that
    assert.ok(jump < 700, `largest sample-to-sample jump ${jump}`);
  }
});

test('shorter leads are padded and longer ones cut: the length follows the original from the onset on', () => {
  const lead = (n: number) => samplesOf(placeVoiceStart(wav(speech(n))).audio).length;
  // the onset is found to within one hop and the pre-roll is whole or (at 0 ms) absent: the lengths agree within 10 ms
  assert.ok(Math.abs(lead(0) - lead(1500)) <= ms(10));
  assert.ok(Math.abs(lead(120) - lead(800)) <= ms(10));
});

test('an isolated click before the speech is not taken as the onset', () => {
  const input = speech(900, ms(100), 400);
  const found = onsetMsOf(wav(input))!;
  assert.ok(found > 850, `onset ${found} must be the voice, not the click at 400 ms`);
  const out = placeVoiceStart(wav(input)).audio;
  assert.ok(Math.abs(onsetMsOf(out)! - 300) <= 10);
  // the click was in the cut part
  assert.ok(!samplesOf(out).some((v) => v === 26000));
});

test('silent or nearly silent audio has no onset', () => {
  assert.equal(findOnset(new Int16Array(ms(1000)), RATE), null);
  const faint = new Int16Array(ms(1000));
  for (let i = 0; i < faint.length; i++) faint[i] = Math.round(20 * Math.sin(i));
  assert.throws(
    () => placeVoiceStart(wav(faint)),
    (error: unknown) => (error as { code?: string }).code === NO_ONSET_CODE,
  );
});

test('the constants are the documented ones', () => {
  assert.equal(VOICE_START_MS, 300);
  assert.equal(SILENCE_MS, 280);
  assert.equal(ONSET_HOLD_MS, 50);
});
