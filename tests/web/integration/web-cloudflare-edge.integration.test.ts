import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { WEB_CLOUD_COMPATIBILITY_FLAGS } from '../../../workers/web-cloudflare/edge.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

test('actual workerd public edge → private DO Fetch preserves cookie, CSRF, Alarm publication and SSE cancellation', async t => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-edge-worker.ts', { STATE: 'WebEdgeFixture' }, ['MEDIA'], [],
    WEB_CLOUD_COMPATIBILITY_FLAGS.filter(flag => flag !== 'nodejs_compat'));
  const origin = 'https://fixture.invalid', api = '/api/web/provider';
  await f.call('/fixture/assets');
  const entry = await f.request(origin + '/?mode=provider'); assert.equal(entry.status, 200);
  assert.match(await entry.text(), /OFFLINE EDGE FIXTURE/);
  for (const path of ['/player-manifest.json','/?mode=preview','/api/web/local/bootstrap','/admin-grant']) {
    const response = await f.request(origin + path); assert.equal(response.status, 404); await response.text();
  }
  const boot = await f.request(origin + api + '/bootstrap'); assert.equal(boot.status, 200);
  const cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
  assert.match(cookie, /^__Host-fixture=/);
  const initial = parseWebProviderBootstrap(await boot.json()); assert.equal(initial.mode, 'provider-cloud');
  const send = await f.request(origin + api + '/characters/wei-guagua/operations', { method: 'POST',
    headers: { cookie, origin, 'x-csrf-token': initial.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: randomUUID(), text: '通过真实边缘转发', delivery: 'voice' }) });
  assert.equal(send.status, 202);
  const { operation } = await send.json() as { operation: { operationId: string } };
  const stream = await f.request(origin + api + '/events?cursor=' + initial.syncCursor, { headers: { cookie } });
  assert.equal(stream.status, 200); const reader = stream.body!.getReader(); let events = '';
  try {
    const end = Date.now() + 20_000;
    while (!events.includes('"kind":"publication"')) {
      const chunk = await reader.read(); assert.equal(chunk.done, false);
      events += new TextDecoder().decode(chunk.value); assert.ok(Date.now() < end, events);
    }
    assert.ok(events.includes(operation.operationId));
  } finally { await reader.cancel(); }
  await sleep(1100);
  t.diagnostic(JSON.stringify(await f.call('/fixture/streams')));
  const reconnect = await f.request(origin + api + '/events', { headers: { cookie } });
  assert.equal(reconnect.status, 200); await reconnect.body!.cancel();
  await f.restart();
  const replay = await f.request(origin + api + '/operations/' + operation.operationId, { headers: { cookie } });
  assert.equal(replay.status, 200); assert.equal((await replay.json() as { status: string }).status, 'published');
});
