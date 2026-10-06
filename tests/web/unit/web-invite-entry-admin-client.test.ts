import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalApi } from '../../../apps/player-web/src/services/local-api.ts';
import { InviteAdminApi } from '../../../apps/player-web/src/services/invite-admin-api.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';

const common = {
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'instance-1',
  recoveryEpoch: 'epoch-1',
  csrf: 'csrf',
  syncCursor: 'cursor',
  characters: [],
  conversations: [],
  activeOperations: [],
};

test('one bootstrap request selects local-2 guest and local-3 invite without protocol probing', async () => {
  const guest = {
    ...common,
    contractVersion: 'web-v1-local-2',
    unsupported: ['login'],
    access: {
      kind: 'guest',
      principalId: 'principal-1',
      playerId: 'player-1',
      worldId: 'world-1',
      revision: 1,
      trialCharacterId: null,
      trialRemaining: 3,
      trialReserved: 0,
      canSend: true,
      canChooseText: false,
      retentionState: 'unstarted',
      trialExpiresAt: null,
    },
  };
  const invite = {
    ...common,
    contractVersion: 'web-v1-local-3',
    unsupported: ['login'],
    access: {
      kind: 'invite',
      principalId: 'principal-1',
      playerId: 'player-1',
      worldId: 'world-1',
      revision: 2,
      grantId: 'grant-1',
      status: 'active',
      expiresAt: null,
      canSend: true,
      canChooseText: false,
      trialCharacterId: null,
      trialRemaining: null,
      trialReserved: null,
      retentionState: 'protected',
      trialExpiresAt: null,
    },
  };
  let calls = 0;
  const api = new LocalApi(async (url, init) => {
    calls++;
    assert.equal(String(url), '/api/web/local/bootstrap');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    return Response.json(calls === 1 ? guest : invite);
  });
  const session = new LocalSession();
  const first = await api.bootstrapAny();
  assert.equal(calls, 1);
  assert.equal(first.bootstrap.contractVersion, 'web-v1-local-2');
  assert.equal(first.capabilities.invite, true);
  session.install(first);
  assert.equal(session.scope?.accessKind, 'guest');
  const second = await api.bootstrapAny();
  assert.equal(calls, 2);
  assert.equal(second.bootstrap.contractVersion, 'web-v1-local-3');
  session.install(second);
  assert.equal(session.currentInviteView?.bootstrap.access.grantId, 'grant-1');
  assert.equal(session.scope?.accessKind, 'invite');
});

test('admin client keeps CSRF in memory and sends issue terms with explicit cutoff', async () => {
  const csrf = 'a'.repeat(64),
    token = 'b'.repeat(43);
  const calls: { path: string; init: RequestInit }[] = [];
  const api = new InviteAdminApi(async (url, init) => {
    const path = String(url);
    calls.push({ path, init: init! });
    if (path.endsWith('/login') || path.endsWith('/session')) return Response.json({ csrf, expiresAt: 1000 });
    if (path.endsWith('/invites/issue'))
      return Response.json({ inviteId: 'invite-1', code: 'c'.repeat(43), duplicate: false });
    if (path.endsWith('/logout')) return Response.json({ loggedOut: true });
    throw new Error('unexpected route');
  });
  await assert.rejects(
    () => api.issue({ requestId: 'req-1', redeemBy: 500, batch: 'synthetic', note: null }),
    /WEB_INVITE_ADMIN_SESSION_REQUIRED/,
  );
  assert.deepEqual(await api.login(token), { csrf, expiresAt: 1000 });
  const issued = await api.issue({ requestId: 'req-1', redeemBy: 500, batch: 'synthetic', note: null });
  assert.equal(issued.code, 'c'.repeat(43));
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), {
    requestId: 'req-1',
    redeemBy: 500,
    batch: 'synthetic',
    note: null,
    accessDurationMs: null,
  });
  assert.equal((calls[1]!.init.headers as Record<string, string>)['X-CSRF-Token'], csrf);
  await api.logout();
  await assert.rejects(
    () => api.issue({ requestId: 'req-2', redeemBy: 500, batch: 'synthetic', note: null }),
    /WEB_INVITE_ADMIN_SESSION_REQUIRED/,
  );
  assert.deepEqual(await api.restore(), { csrf, expiresAt: 1000 });
  for (const { path, init } of calls) {
    assert.ok(!path.includes(token));
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
  }
});
