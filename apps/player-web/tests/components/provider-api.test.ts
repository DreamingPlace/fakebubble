import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import type { WebProviderOperation } from '../../../../packages/contracts/web-provider.ts';

test('provider UNKNOWN stops polling without retrying or claiming a refunded trial', async () => {
  let gets = 0,
    waits = 0;
  const initial = { operationId: 'op', requestId: 'r', conversationId: 'c', status: 'queued' } as WebProviderOperation;
  const api = new ProviderApi(async (_url, init) => {
    assert.equal(init?.method, undefined);
    gets++;
    return Response.json({ ...initial, status: 'unknown', canRetry: false });
  });
  const result = await api.waitForOperation(initial, async () => {
    waits++;
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.canRetry, false);
  assert.equal(gets, 1);
  assert.equal(waits, 1);
  assert.equal(
    await api.waitForOperation(result, async () => {
      waits++;
    }),
    result,
  );
  assert.equal(gets, 1);
  assert.equal(waits, 1);
});

test('provider api keeps CSRF in memory, maps errors and recovers an uncertain send by requestId', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies: Response[] = [];
  const api = new ProviderApi(async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return replies.shift()!;
  });
  replies.push(Response.json({ ...syntheticProviderBootstrap(), csrf: 'csrf-1' }));
  const view = await api.bootstrap();
  assert.equal(view.csrf, 'csrf-1');
  assert.equal(calls[0]!.url, '/api/web/provider/bootstrap');
  assert.equal(calls[0]!.init.credentials, 'same-origin');

  replies.push(
    Response.json({ error: { code: 'TRIAL_CHARACTER_LOCKED', requestId: null, retryAfterMs: null } }, { status: 403 }),
  );
  await assert.rejects(
    api.submit({ requestId: 'r1', characterId: 'jojo', text: '你好', delivery: 'voice' }),
    (error: unknown) =>
      error instanceof ProviderApiError && error.status === 403 && error.code === 'TRIAL_CHARACTER_LOCKED',
  );
  assert.equal((calls[1]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'csrf-1');
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { requestId: 'r1', text: '你好', delivery: 'voice' });

  replies.push(Response.json({ operationId: 'op', requestId: 'r1', conversationId: 'c', status: 'queued' }));
  assert.equal((await api.byRequest('r1')).operationId, 'op');
  assert.equal(calls[2]!.url, '/api/web/provider/operations/by-request/r1');

  replies.push(Response.json({ entitlement: { kind: 'unlimited', expiresAt: null }, duplicate: false }, { status: 201 }));
  assert.deepEqual(await api.redeemInvite({ requestId: 'r2', code: 'CODE' }), {
    entitlement: { kind: 'unlimited', expiresAt: null },
    duplicate: false,
  });
  replies.push(Response.json({ error: { code: 'NOT_FOUND' } }, { status: 404 }));
  await assert.rejects(api.operation('missing'));
  assert.equal((calls[4]!.init.headers as Record<string, string>)['X-CSRF-Token'], undefined, 'GET carries no CSRF');
  replies.push(new Response('not json', { status: 502 }));
  await assert.rejects(
    api.bootstrap(),
    (error: unknown) => error instanceof ProviderApiError && error.code === 'PROTOCOL_INVALID',
  );
});

test('a redemption answer must be exactly an entitlement and a duplicate flag; anything else is a protocol failure', async () => {
  const replies: Response[] = [];
  const api = new ProviderApi(async () => replies.shift()!);
  for (const value of [
    { grantId: 'g', principalId: 'p', expiresAt: null, csrf: 'c', duplicate: false },
    { entitlement: { kind: 'unlimited', expiresAt: null } },
    { duplicate: false },
  ]) {
    replies.push(Response.json(value));
    await assert.rejects(
      api.redeemInvite({ code: 'A'.repeat(43), requestId: 'same' }),
      (error: unknown) => error instanceof ProviderApiError && error.code === 'PROTOCOL_INVALID',
    );
  }
});
