import assert from 'node:assert/strict';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';

const setup = (t: test.TestContext) =>
  localRuntime(
    t,
    'tests/web/fixtures/cloudflare-writer-37a-client.ts',
    {},
    [],
    [
      {
        binding: 'GENERATION',
        entry: 'tests/web/fixtures/cloudflare-writer-37a-worker.ts',
        entrypoint: 'SyntheticWriterService',
      },
    ],
  );
type Out = { result: { ok: boolean; code?: string }; calls: { plain: boolean; temperature: unknown }[] };

test('the generation Worker runs a v8 request on the same route: a plain draft at the pinned temperature, then one forced tool', async (t) => {
  const f = setup(t);
  const out = await f.call<Out>('/', { writer: 'v8', hash: 'v8' });
  assert.equal(out.result.ok, true, JSON.stringify(out));
  assert.deepEqual(out.calls, [{ plain: true, temperature: 0.9 }, { plain: false }]);
});

test('the Worker refuses a v8 request whose policy hash is not the pinned v8 one (an older business object, or v7 bytes): nothing is sent', async (t) => {
  const f = setup(t);
  for (const hash of ['v7', 'junk'] as const) {
    const out = await f.call<Out>('/', { writer: 'v8', hash });
    assert.deepEqual(out.result, { ok: false, code: 'WEB_PROVIDER_WIRE_MISMATCH' }, hash);
    assert.deepEqual(out.calls, [], hash);
  }
  // And the reverse: a v7 request cannot ride the v8 hash.
  const reverse = await f.call<Out>('/', { writer: 'v7', hash: 'v8' });
  assert.deepEqual(reverse.result, { ok: false, code: 'WEB_PROVIDER_WIRE_MISMATCH' });
  assert.deepEqual(reverse.calls, []);
});
