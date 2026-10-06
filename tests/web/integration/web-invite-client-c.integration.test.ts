import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { InviteLocalApi } from '../../../apps/player-web/src/services/invite-local-api.ts';
import { StaleLocalIdentityError } from '../../../apps/player-web/src/services/local-api.ts';
import { LocalInviteController } from '../../../apps/player-web/src/session/invite-controller.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';

// C-owned protocol fixture: injected fetch only; no service, cookie jar or production state.
const guest = {
  contractVersion: 'web-v1-local-2',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'instance-c',
  recoveryEpoch: 'epoch-c',
  csrf: 'guest-csrf-c',
  access: {
    kind: 'guest',
    principalId: 'principal-c',
    playerId: 'player-c',
    worldId: 'world-c',
    revision: 1,
    trialCharacterId: 'character-c',
    trialRemaining: 2,
    trialReserved: 0,
    canSend: true,
    canChooseText: false,
    trialExpiresAt: 5000,
    retentionState: 'active',
  },
  characters: [],
  conversations: [],
  activeOperations: [],
  syncCursor: 'cursor-c',
  unsupported: ['invite'],
};
const invite = {
  ...guest,
  contractVersion: 'web-v1-local-3',
  csrf: 'invite-csrf-c',
  access: {
    kind: 'invite',
    principalId: 'principal-c',
    playerId: 'player-c',
    worldId: 'world-c',
    revision: 2,
    grantId: 'grant-c',
    status: 'active',
    expiresAt: null,
    canSend: true,
    canChooseText: false,
    trialCharacterId: 'character-c',
    trialRemaining: null,
    trialReserved: null,
    trialExpiresAt: null,
    retentionState: 'protected',
  },
  unsupported: [],
};
const receipt = { grantId: 'grant-c', principalId: 'principal-c', expiresAt: null, csrf: 'invite-csrf-c' };
const status = { grantId: 'grant-c', principalId: 'principal-c', expiresAt: null };
const code = 'C'.repeat(43);
type Call = { path: string; init: RequestInit | undefined };
type Reply = (path: string, init?: RequestInit) => Promise<Response> | Response;
function fixture(reply: Reply, now: () => number = () => 1000) {
  const calls: Call[] = [];
  const fetcher = ((path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return reply(path, init);
  }) as typeof fetch;
  const session = new LocalSession(now);
  session.install(parseBootstrap(guest));
  return { session, calls, controller: new LocalInviteController(new InviteLocalApi(fetcher), session) };
}
const pathIs = (path: string, suffix: string) => path === `/api/web/local${suffix}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('C invite client: trusted in-place install is delayed until bootstrap and rotates generation', async () => {
  const gate = deferred<Response>();
  const { session, controller, calls } = fixture((path) =>
    pathIs(path, '/invites/redeem') ? Response.json(receipt) : gate.promise,
  );
  const old = session.scope!;
  const pending = controller.redeem(code, 'original-request');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(session.scope?.accessKind, 'guest');
  assert.equal(session.currentInviteView, null);
  gate.resolve(Response.json(invite));
  assert.deepEqual(await pending, { principalId: 'principal-c', grantId: 'grant-c' });
  assert.equal(session.currentView, null);
  assert.notEqual(session.currentInviteView, null);
  assert.equal(session.scope?.worldId, old.worldId);
  assert.equal(session.scope?.principalId, old.principalId);
  assert.equal(session.scope?.generation, old.generation + 1);
  assert.equal(session.contentAvailable(), true);
  assert.deepEqual(
    calls.map((v) => v.path),
    ['/api/web/local/invites/redeem', '/api/web/local/bootstrap'],
  );
  assert.equal(calls[0]!.init?.credentials, 'same-origin');
  assert.equal(calls[0]!.init?.cache, 'no-store');
  assert.equal((calls[0]!.init?.headers as Record<string, string>)['X-CSRF-Token'], 'guest-csrf-c');
  assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { code, requestId: 'original-request' });
  assert.equal(calls[1]!.init?.cache, 'no-store');
  session.invalidate();
});

test('C invite client: every identity/receipt scope mismatch rejects without installing local-3', async () => {
  const variants: [string, unknown, unknown][] = [
    ['instance', { ...invite, instanceId: 'other-instance' }, receipt],
    ['epoch', { ...invite, recoveryEpoch: 'other-epoch' }, receipt],
    ['player', { ...invite, access: { ...invite.access, playerId: 'other-player' } }, receipt],
    ['principal', { ...invite, access: { ...invite.access, principalId: 'other-principal' } }, receipt],
    ['world', { ...invite, access: { ...invite.access, worldId: 'other-world' } }, receipt],
    ['grant', { ...invite, access: { ...invite.access, grantId: 'other-grant' } }, receipt],
    ['receipt principal', invite, { ...receipt, principalId: 'other-principal' }],
    ['receipt expiry', { ...invite, access: { ...invite.access, expiresAt: 4000 } }, receipt],
    ['inactive status', { ...invite, access: { ...invite.access, status: 'revoked', canSend: false } }, receipt],
  ];
  for (const [name, candidate, candidateReceipt] of variants) {
    const { session, controller, calls } = fixture((path) =>
      Response.json(pathIs(path, '/invites/redeem') ? candidateReceipt : candidate),
    );
    const old = session.scope!;
    await assert.rejects(controller.redeem(code, `request-${name}`), /WEB_INVITE_SCOPE_MISMATCH/, name);
    assert.deepEqual(session.scope, old, name);
    assert.equal(session.currentInviteView, null, name);
    assert.equal(session.contentAvailable(), true, name);
    assert.equal(calls.length, 2, name);
    session.invalidate();
  }
});

test('C invite client: expired guest cannot start a new redeem; only original server receipt restores access', async () => {
  let now = 4999;
  const lost = fixture(
    (path) => {
      if (pathIs(path, '/invites/redeem')) return Promise.reject(new Error('response lost after commit'));
      if (pathIs(path, '/bootstrap')) return Response.json(invite);
      if (pathIs(path, '/identity/invite-receipt-status')) return Response.json(status);
      throw new Error('unexpected request');
    },
    () => now,
  );
  await assert.rejects(lost.controller.redeem(code, 'accepted-request'), /response lost after commit/);
  assert.equal(lost.session.scope?.accessKind, 'guest');
  now = 5001;
  assert.equal(lost.session.contentAvailable(), false);
  await assert.rejects(lost.controller.redeem(code, 'new-request'), /WEB_INVITE_GUEST_REQUIRED/);
  assert.equal(lost.calls.filter((v) => pathIs(v.path, '/invites/redeem')).length, 1);
  assert.deepEqual(await lost.controller.recover(code, 'accepted-request'), {
    principalId: 'principal-c',
    grantId: 'grant-c',
  });
  assert.equal(lost.session.contentAvailable(), true);
  assert.deepEqual(
    lost.calls.map((v) => v.path),
    ['/api/web/local/invites/redeem', '/api/web/local/bootstrap', '/api/web/local/identity/invite-receipt-status'],
  );
  assert.equal(lost.calls[2]!.init?.method, 'POST');
  assert.equal((lost.calls[2]!.init?.headers as Record<string, string>)['X-CSRF-Token'], 'invite-csrf-c');
  assert.deepEqual(JSON.parse(String(lost.calls[2]!.init?.body)), { requestId: 'accepted-request' });
  lost.session.invalidate();
});

test('C invite client: missing or conflicting receipt never locally unlocks expired guest', async () => {
  for (const answer of [
    Response.json({ error: { code: 'RECEIPT_NOT_FOUND' } }, { status: 404 }),
    Response.json({ ...status, grantId: 'foreign-grant' }),
  ]) {
    const now = 5000;
    const rejected = fixture(
      (path) => (pathIs(path, '/identity/invite-receipt-status') ? answer : Response.json(invite)),
      () => now,
    );
    await assert.rejects(rejected.controller.recover(code, 'unaccepted-request'));
    assert.equal(rejected.session.scope?.accessKind, 'guest');
    assert.equal(rejected.session.contentAvailable(), false);
    assert.equal(
      rejected.calls.some((v) => pathIs(v.path, '/invites/redeem')),
      false,
    );
    rejected.session.invalidate();
  }
});

test('C invite client: rotated-cookie recovery uses challenge and same receipt, never another redeem', async () => {
  let bootstraps = 0;
  const { session, controller, calls } = fixture(
    (path, init) => {
      if (pathIs(path, '/bootstrap'))
        return ++bootstraps === 1
          ? Response.json({ error: { code: 'SESSION_ROTATED_RECOVERABLE' } }, { status: 409 })
          : Response.json(invite);
      if (pathIs(path, '/identity/invite-receipt-challenge')) return Response.json({ csrf: 'challenge-csrf' });
      if (pathIs(path, '/identity/invite-receipt-recover')) {
        assert.equal((init?.headers as Record<string, string>)['X-CSRF-Token'], 'challenge-csrf');
        assert.deepEqual(JSON.parse(String(init?.body)), { code, requestId: 'accepted-request' });
        return Response.json(receipt);
      }
      throw new Error('unexpected request');
    },
    () => 5000,
  );
  assert.deepEqual(await controller.recover(code, 'accepted-request'), {
    principalId: 'principal-c',
    grantId: 'grant-c',
  });
  assert.deepEqual(
    calls.map((v) => v.path),
    [
      '/api/web/local/bootstrap',
      '/api/web/local/identity/invite-receipt-challenge',
      '/api/web/local/identity/invite-receipt-recover',
      '/api/web/local/bootstrap',
    ],
  );
  assert.equal(session.scope?.accessKind, 'invite');
  session.invalidate();
});

test('C invite client: late old-generation bootstrap cannot overwrite newly installed identity', async () => {
  const gate = deferred<Response>();
  const { session, controller, calls } = fixture((path) =>
    pathIs(path, '/invites/redeem') ? Response.json(receipt) : gate.promise,
  );
  const pending = controller.redeem(code, 'old-request');
  await new Promise<void>((resolve) => setImmediate(resolve));
  session.install(
    parseBootstrap({
      ...guest,
      access: { ...guest.access, principalId: 'new-principal', playerId: 'new-player', worldId: 'new-world' },
    }),
  );
  const newer = session.scope!;
  gate.resolve(Response.json(invite));
  await assert.rejects(pending, StaleLocalIdentityError);
  assert.deepEqual(session.scope, newer);
  assert.equal(session.currentInviteView, null);
  assert.equal(calls.length, 2);
  session.invalidate();
});
