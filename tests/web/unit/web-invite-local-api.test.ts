import assert from 'node:assert/strict';
import test from 'node:test';
import { InviteLocalApi, InviteLocalApiError } from '../../../apps/player-web/src/services/invite-local-api.ts';

test('opt-in invite client sends proofs only in no-store same-origin POST bodies', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init! });
    const path = String(url);
    if (path.endsWith('/invites/redeem')) return Response.json({ grantId: 'grant-1',
      principalId: 'principal-1', expiresAt: null, csrf: 'next-csrf' });
    if (path.endsWith('/identity/invite-receipt-challenge'))
      return Response.json({ csrf: 'receipt-csrf' });
    if (path.endsWith('/identity/invite-receipt-status'))
      return Response.json({ grantId: 'grant-1', principalId: 'principal-1', expiresAt: null });
    if (path.endsWith('/invites/recover')) return Response.json({ grantId: 'grant-1',
      principalId: 'principal-1', expiresAt: null, csrf: 'recovered-csrf',
      recoverySecret: 'B'.repeat(43), duplicate: false });
    throw new Error(`unexpected test path ${path}`);
  };
  const api = new InviteLocalApi(fetcher), code = 'A'.repeat(43);
  assert.equal((await api.redeem(code, 'req-1', 'old-csrf')).csrf, 'next-csrf');
  assert.equal(await api.receiptChallenge(), 'receipt-csrf');
  assert.equal((await api.receiptStatus('req-1', 'next-csrf')).grantId, 'grant-1');
  assert.equal((await api.recoverWithCredential('C'.repeat(43), 'recover-1')).csrf,
    'recovered-csrf');
  assert.equal(calls.length, 4);
  for (const { url, init } of calls) {
    assert.ok(!url.includes(code) && !url.includes('C'.repeat(43)));
    assert.equal(init.method, 'POST'); assert.equal(init.cache, 'no-store');
    assert.equal(init.credentials, 'same-origin');
  }
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { code, requestId: 'req-1' });
  assert.equal((calls[0]!.init.headers as Record<string, string>)['X-CSRF-Token'], 'old-csrf');
  assert.deepEqual(JSON.parse(String(calls[3]!.init.body)),
    { secret: 'C'.repeat(43), requestId: 'recover-1' });
});

test('invite transport preserves explicit rejection codes and never treats failed/non-JSON HTTP as success', async () => {
  const denied = new InviteLocalApi(async () => Response.json({ error: { code: 'WEB_INVITE_UNAVAILABLE' } },
    { status: 409 }));
  await assert.rejects(() => denied.redeem('A'.repeat(43), 'req', 'csrf'), error =>
    error instanceof InviteLocalApiError && error.status === 409 &&
    error.code === 'WEB_INVITE_UNAVAILABLE');
  const malformed = new InviteLocalApi(async () => new Response('not-json', { status: 200 }));
  await assert.rejects(() => malformed.redeem('A'.repeat(43), 'req', 'csrf'),
    /WEB_INVITE_PROTOCOL_INVALID/);
});

test('invite bootstrap and access require explicit local-3 data, not legacy local-2', async () => {
  const access = { kind: 'invite', principalId: 'principal-1', playerId: 'player-1',
    worldId: 'world-1', revision: 2, grantId: 'grant-1', status: 'active',
    expiresAt: null, canSend: true, canChooseText: false, trialCharacterId: null,
    trialRemaining: null, trialReserved: null, retentionState: 'protected', trialExpiresAt: null };
  const bootstrap = { contractVersion: 'web-v1-local-3', mode: 'synthetic-local',
    region: 'local-test', instanceId: 'instance-1', recoveryEpoch: 'epoch-1',
    csrf: 'csrf', syncCursor: 'cursor', access, characters: [], conversations: [],
    activeOperations: [], unsupported: [] };
  const calls: string[] = [];
  const api = new InviteLocalApi(async (url, init) => {
    calls.push(`${String(url)}:${init?.cache}:${init?.credentials}`);
    return Response.json(String(url).endsWith('/bootstrap') ? bootstrap : access);
  });
  assert.equal((await api.bootstrap()).bootstrap.access.grantId, 'grant-1');
  assert.equal((await api.access()).status, 'active');
  assert.deepEqual(calls, ['/api/web/local/bootstrap:no-store:same-origin',
    '/api/web/local/access:no-store:same-origin']);
  const old = new InviteLocalApi(async () => Response.json({ ...bootstrap,
    contractVersion: 'web-v1-local-2' }));
  await assert.rejects(() => old.bootstrap(), /WEB_INVITE_PROTOCOL_INVALID/);
});
