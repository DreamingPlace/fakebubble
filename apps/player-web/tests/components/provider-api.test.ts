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

  replies.push(
    Response.json(
      { grantId: 'grant', principalId: 'p', expiresAt: null, duplicate: false, csrf: 'csrf-2' },
      { status: 201 },
    ),
  );
  assert.deepEqual(await api.redeemInvite({ requestId: 'r2', code: 'CODE' }), {
    grantId: 'grant',
    principalId: 'p',
    expiresAt: null,
    duplicate: false,
    csrf: 'csrf-2',
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

test('receipt endpoints use exact payloads and purpose-specific CSRF without accepting malformed success', async () => {
  const replies: Response[] = [],
    calls: { url: string; init: RequestInit }[] = [];
  const api = new ProviderApi(async (url, init) => {
    calls.push({ url: String(url), init: init! });
    return replies.shift()!;
  });
  replies.push(Response.json({ ...syntheticProviderBootstrap(), csrf: 'active-1' }));
  await api.bootstrap();
  replies.push(Response.json({ csrf: 'C'.repeat(43) }));
  const challenge = await api.inviteReceiptChallenge();
  replies.push(Response.json({ grantId: 'g', principalId: 'p', expiresAt: null, csrf: 'active-2' }));
  await api.recoverInviteReceipt({ code: 'A'.repeat(43), requestId: 'same' }, challenge);
  replies.push(Response.json({ grantId: 'g', principalId: 'p', expiresAt: null }));
  await api.inviteReceiptStatus('same');
  assert.deepEqual(
    calls.slice(1).map((c) => c.url),
    [
      '/api/web/provider/identity/invite-receipt-challenge',
      '/api/web/provider/identity/invite-receipt-recover',
      '/api/web/provider/identity/invite-receipt-status',
    ],
  );
  assert.deepEqual(
    calls.slice(1).map((c) => (c.init.headers as Record<string, string>)['X-CSRF-Token']),
    ['active-1', 'C'.repeat(43), 'active-2'],
  );
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)), { requestId: 'same' });
  for (const value of [
    { grantId: 'g', duplicate: false },
    { grantId: 'g', principalId: 'p', expiresAt: null, csrf: 'c', duplicate: false, extra: true },
  ]) {
    replies.push(Response.json(value));
    await assert.rejects(
      api.redeemInvite({ code: 'A'.repeat(43), requestId: 'same' }),
      (error: unknown) => error instanceof ProviderApiError && error.code === 'PROTOCOL_INVALID',
    );
  }
});
