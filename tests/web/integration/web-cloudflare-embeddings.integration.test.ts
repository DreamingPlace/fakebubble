import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-embed-client.ts',
    {},
    [],
    [
      {
        binding: 'GENERATION',
        entry: 'tests/web/fixtures/cloudflare-embed-worker.ts',
        entrypoint: 'SyntheticEmbedService',
      },
    ],
  );
type Result = {
  ok: boolean;
  code?: string;
  known?: boolean | null;
  count?: number;
  dims?: number[];
  axes?: number[];
  usageTokens?: number | null;
  gates: number;
  calls: string[][];
};

test('embeddings RPC: one call carries the whole array, the send gate runs first and vectors come back to the caller', async (t) => {
  const f = setup(t);
  const value = await f.call<Result>('/', { texts: ['猫', '工作', 'dog'] });
  assert.equal(value.ok, true, JSON.stringify(value));
  assert.equal(value.count, 3);
  assert.deepEqual(value.dims, [1024, 1024, 1024]);
  assert.deepEqual(value.axes, [0, 1, 2], 'vectors keep the input order');
  assert.equal(value.gates, 1);
  assert.deepEqual(value.calls, [['猫', '工作', 'dog']], 'one provider call for the whole array');
  assert.equal(value.usageTokens, null, 'no reported usage: the caller bills its estimate');
  assert.equal((await f.call<Result>('/', { mode: 'usage' })).usageTokens, 7);
});

test('embeddings RPC: disabled Workers and closed gates send nothing; failures are classified known or unknown', async (t) => {
  const f = setup(t);
  for (const mode of ['disabled', 'off']) {
    const value = await f.call<Result>('/', { mode });
    assert.equal(value.ok, false, mode);
    assert.equal(value.known, true, `${mode}: refused before anything was sent`);
    assert.deepEqual(value.calls, [], mode);
    assert.equal(value.gates, 0, mode);
  }
  const gate = await f.call<Result>('/', { mode: 'gate' });
  assert.equal(gate.ok, false);
  assert.equal(gate.known, true);
  assert.equal(gate.code, 'WEB_PROVIDER_CLAIM_STALE');
  assert.deepEqual(gate.calls, []);
  const capacity = await f.call<Result>('/', { mode: 'capacity' });
  assert.deepEqual([capacity.ok, capacity.known, capacity.code], [false, true, 'EMBEDDING_PROVIDER_REJECTED']);
  const boom = await f.call<Result>('/', { mode: 'boom' });
  assert.deepEqual([boom.ok, boom.known, boom.code], [false, false, 'EMBEDDING_PROVIDER_ERROR']);
  const invalid = await f.call<Result>('/', { mode: 'invalid' });
  assert.deepEqual([invalid.ok, invalid.known], [false, false], 'a billed call with an unusable body is not retryable');
  const slow = await f.call<Result>('/', { mode: 'slow' });
  assert.equal(slow.ok, false);
  assert.equal(slow.known, false, 'an abort after the call started is an UNKNOWN outcome');
  assert.equal(slow.calls.length, 1);
});
