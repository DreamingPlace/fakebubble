import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { listenBar, NO_VOICE_REASON, type ListenHost } from '../../src/features/admin/preview/listen.ts';
import { speechClips, speechEstimate } from '../../src/services/speech-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const el = (node: unknown) => node as FakeElement;
const wav = Buffer.from('RIFF-fake-wav-bytes');
const sha = createHash('sha256').update(wav).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

function setup(t: test.TestContext, over: { voice?: boolean; spoken?: boolean } = {}) {
  installFakeDom(t);
  const calls: { listen: unknown[]; played: string[]; estimates: number } = { listen: [], played: [], estimates: 0 };
  let spoken = over.spoken ?? false;
  const host: ListenHost = {
    api: {
      speechEstimate: async () => {
        calls.estimates++;
        return { ok: true, calls: 2, characters: 8, bytes: 40, estimateMicros: 600, model: 's2.1-pro' };
      },
      clips: async () =>
        spoken ? [{ callId: 'c1', ordinal: 0, durationMs: 900, byteLength: wav.length, sha256: sha }] : [],
      listen: async (_id, input) => {
        calls.listen.push(input);
        spoken = true;
        return [{ callId: 'c1', ordinal: 0, durationMs: 900, byteLength: wav.length, sha256: sha }];
      },
      clipAudio: async () => ({ base64: wav.toString('base64'), sha256: sha }),
    },
    characterId: 'jojo',
    previewId: 'p1',
    available: () => true,
    hasVoice: () => over.voice ?? true,
    allowed: () => true,
    run: async (work) => work(),
    newId: () => 'req-1',
    disposed: () => false,
    play: async (url) => {
      calls.played.push(url);
    },
    setTimer: () => 0,
    clearTimer: () => {},
  };
  const bar = listenBar(host);
  const button = () => el(bar.root.querySelector('[data-pw-send]'));
  return {
    bar,
    calls,
    button,
    reason: () => el(bar.root.querySelector('.pw-reason')),
    play: () => el(bar.root.querySelector('[data-pw-play]')),
  };
}

test('试听: no voice reference turns the button off with the one sentence, and reads no estimate', async (t) => {
  const f = setup(t, { voice: false });
  await tick();
  assert.equal(f.button().disabled, true);
  assert.equal(f.reason().textContent, NO_VOICE_REASON);
  assert.equal(NO_VOICE_REASON, '先填音色 referenceId');
  assert.equal(f.calls.estimates, 0);
});

test('试听: the first click only asks (the cost on the button), the second pays once, then plays, and a replay is free', async (t) => {
  const f = setup(t);
  await tick();
  assert.equal(f.button().textContent, '试听 · 约 600 µ$');
  f.button().click();
  assert.equal(f.calls.listen.length, 0, 'a first click calls nothing');
  assert.equal(f.button().textContent, '确认付费 · 600 µ$');
  f.button().click();
  // Part 29 (named exception, no assertion changed): this waited three fixed ticks for a clip whose hash is computed on the
  // thread pool (crypto.subtle), so it flaked on main as well (2 of 12 runs). It now waits, bounded, until the clip is played.
  for (let i = 0; i < 400 && f.calls.played.length === 0; i++) await tick();
  assert.deepEqual(f.calls.listen, [{ requestId: 'req-1', previewId: 'p1', acknowledgeMicros: 600 }]);
  assert.equal(f.calls.played.length, 1, 'the clips are played after they are spoken');
  assert.equal(f.play().hidden, false, 'a free 播放 replaces the paid button');
  f.play().click();
  for (let i = 0; i < 400 && f.calls.played.length < 2; i++) await tick();
  assert.equal(f.calls.played.length, 2);
  assert.equal(f.calls.listen.length, 1, 'playing again never pays again');
});

test('试听: a 预演 that was spoken before opens with the free 播放 and reads no estimate', async (t) => {
  const f = setup(t, { spoken: true });
  await tick();
  assert.equal(f.play().hidden, false);
  assert.equal(f.calls.estimates, 0);
});

test('the speech answers are strict about shape', () => {
  assert.deepEqual(speechEstimate({ ok: false, reason: 'PRICE_MISSING' }), { ok: false, reason: 'PRICE_MISSING' });
  assert.throws(() => speechEstimate({ ok: true, calls: 1 }), /PROTOCOL/);
  assert.throws(() => speechEstimate({ ok: 'yes' }), /PROTOCOL/);
  assert.throws(() => speechClips({ clips: [{ callId: 1 }] }), /PROTOCOL/);
});
