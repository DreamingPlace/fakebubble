import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';
const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-generation-client.ts',
    {},
    [],
    [
      {
        binding: 'GENERATION',
        entry: 'tests/web/fixtures/cloudflare-generation-worker.ts',
        entrypoint: 'SyntheticWebGenerationService',
      },
    ],
  );
type Result = {
  ok: boolean;
  code?: string;
  starts: { stage: string; hash: string; bytes: number }[];
  stages: string[];
  calls: string[];
  gates: number;
  closes: number;
  result?: { bytes: number; usageUnits: number };
  generation?: { provider: string; inputUTF8Bytes: number; requestId: string };
};

test('isolated web generator RPC awaits exact-byte send gates and accepted-stage callbacks; known draft resumes review only', async (t) => {
  const f = setup(t);
  const value = await f.call<Result>('/', {});
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.deepEqual(value.stages, ['draft', 'review']);
  assert.equal(value.closes, 1);
  assert.ok(value.starts.every((row) => row.bytes > 0 && /^[a-f0-9]{64}$/.test(row.hash)));
  const resumed = await f.call<Result>('/', { mode: 'resume' });
  assert.equal(resumed.ok, true);
  assert.deepEqual(resumed.stages, ['draft', 'review', 'review']);
  assert.equal(resumed.calls.length, 1);
  const rejected = await f.call<Result>('/', { mode: 'accept-failed' });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.calls.length, 1, 'a failed durable draft callback must block paid review');
});

test('isolated generation is explicit-live, single transport, wire-bound, cancellable and propagates closed gates', async (t) => {
  const f = setup(t);
  for (const speech of [false, true]) {
    const disabled = await f.call<Result>('/', { mode: 'disabled', speech });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.code, 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    assert.deepEqual(disabled.calls, []);
    const gate = await f.call<Result>('/', { mode: 'gate', speech });
    assert.equal(gate.ok, false);
    assert.deepEqual(gate.calls, []);
    assert.equal(gate.code, speech ? 'WEB_PROVIDER_CLAIM_STALE' : 'WEB_SHARED_BUDGET_EXHAUSTED');
    const slow = await f.call<Result>('/', { mode: 'slow', speech });
    assert.equal(slow.ok, false);
    assert.equal(slow.calls.length, 1);
    assert.match(slow.code!, /ABORTED/);
  }
  const tampered = await f.call<Result>('/', { mode: 'tamper', speech: true });
  assert.equal(tampered.code, 'WEB_PROVIDER_WIRE_MISMATCH');
  assert.deepEqual(tampered.calls, []);
  assert.equal(tampered.gates, 0);
  const voice = await f.call<Result>('/', { speech: true });
  assert.equal(voice.ok, true);
  assert.equal(voice.gates, 1);
  assert.equal(voice.calls.length, 1);
  assert.ok(voice.result!.bytes > 44 && voice.result!.usageUnits > 0);
  const rejected = await f.call<Result>('/', { mode: 'invalid-audio', speech: true });
  assert.equal(rejected.code, 'INVALID_WAV');
  assert.equal(rejected.calls.length, 1);
  assert.equal(rejected.generation!.provider, 'fish');
  assert.equal(rejected.generation!.inputUTF8Bytes, voice.result!.usageUnits);
  assert.equal(rejected.generation!.requestId, 'offline-speech');
  const large = await f.call<Result>('/', { mode: 'large-audio', speech: true });
  assert.equal(large.ok, true);
  assert.equal(large.calls.length, 1);
  assert.equal(large.result!.bytes, 44 + 60 * 24000 * 2);
});
