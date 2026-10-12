import test from 'node:test';
import assert from 'node:assert/strict';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';

function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: 'WebHTTPFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  // Unauthenticated on purpose: the transport rate limit runs before routing, so only 429 vs not-429 matters.
  const post = async (path: string) => {
    const response = await runtime.request(origin + API + path, {
      method: 'POST',
      headers: {
        origin,
        'content-type': 'application/json',
        'x-csrf-token': 'none',
        'x-fixture-host': 'fixture.invalid',
      },
      body: '{}',
    });
    await response.text();
    return response.status;
  };
  return { runtime, post };
}

test('read-only admin POSTs have their own budget and never consume the write budget', async (t) => {
  const { runtime, post } = setup(t);
  await runtime.call('/fixture/assets');
  // 120 reads would already exhaust the old shared 60/minute write limit.
  for (let n = 0; n < 120; n++) assert.notEqual(await post('/admin/characters/jojo/previews-status'), 429, `read ${n}`);
  // The write budget is untouched by those reads: all 60 writes pass, the 61st is limited.
  for (let n = 0; n < 60; n++) assert.notEqual(await post('/admin/characters/jojo/save'), 429, `write ${n}`);
  assert.equal(await post('/admin/characters/jojo/save'), 429);
  // Exhausted writes do not block reads.
  assert.notEqual(await post('/admin/characters/list'), 429);
});

test('read-only admin POSTs are still capped per IP (300 per minute)', async (t) => {
  const { runtime, post } = setup(t);
  await runtime.call('/fixture/assets');
  for (let n = 0; n < 300; n++) assert.notEqual(await post('/admin/eval-sets/list'), 429, `read ${n}`);
  assert.equal(await post('/admin/eval-sets/list'), 429);
});
