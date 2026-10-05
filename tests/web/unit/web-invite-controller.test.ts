import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBootstrap } from '../../../packages/contracts/web-local-client.ts';
import { InviteLocalApi } from '../../../apps/player-web/src/services/invite-local-api.ts';
import { LocalInviteController } from '../../../apps/player-web/src/session/invite-controller.ts';
import { LocalSession } from '../../../apps/player-web/src/session/local-session.ts';

const guest = {
  contractVersion: 'web-v1-local-2',
  mode: 'synthetic-local',
  region: 'local-test',
  instanceId: 'instance-1',
  recoveryEpoch: 'epoch-1',
  csrf: 'guest-csrf',
  access: {
    kind: 'guest',
    principalId: 'principal-1',
    playerId: 'player-1',
    worldId: 'world-1',
    revision: 1,
    trialCharacterId: 'character-1',
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
  syncCursor: 'cursor',
  unsupported: ['invite'],
};
const invite = {
  ...guest,
  contractVersion: 'web-v1-local-3',
  csrf: 'invite-csrf',
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
    trialCharacterId: 'character-1',
    trialRemaining: null,
    trialReserved: null,
    trialExpiresAt: null,
    retentionState: 'protected',
  },
  unsupported: [],
};
const receipt = { grantId: 'grant-1', principalId: 'principal-1', expiresAt: null, csrf: 'invite-csrf' };

function setup(fetcher: typeof fetch, now: () => number = () => 1000) {
  const session = new LocalSession(now);
  session.install(parseBootstrap(guest));
  return { session, controller: new LocalInviteController(new InviteLocalApi(fetcher), session) };
}

test('redeem installs only after a matching trusted local-3 bootstrap, preserving world', async () => {
  const calls: string[] = [];
  const { session, controller } = setup(async (url, init) => {
    calls.push(String(url));
    if (String(url).endsWith('/invites/redeem')) {
      assert.equal((init?.headers as Record<string, string>)['X-CSRF-Token'], 'guest-csrf');
      return Response.json(receipt);
    }
    return Response.json(invite);
  });
  assert.deepEqual(await controller.redeem('A'.repeat(43), 'req-1'), {
    principalId: 'principal-1',
    grantId: 'grant-1',
  });
  assert.deepEqual(calls, ['/api/web/local/invites/redeem', '/api/web/local/bootstrap']);
  assert.equal(session.scope?.accessKind, 'invite');
  assert.equal(session.scope?.worldId, 'world-1');
  session.invalidate();
});

test('mismatched bootstrap is rejected without replacing the guest session', async () => {
  const { session, controller } = setup(async (url) =>
    Response.json(
      String(url).endsWith('/invites/redeem')
        ? receipt
        : { ...invite, access: { ...invite.access, worldId: 'other-world' } },
    ),
  );
  await assert.rejects(() => controller.redeem('A'.repeat(43), 'req-1'), /WEB_INVITE_SCOPE_MISMATCH/);
  assert.equal(session.scope?.accessKind, 'guest');
  session.invalidate();
});

test('redeem rejects changed instance, recovery epoch and player even when receipt IDs match', async () => {
  for (const changed of [
    { ...invite, instanceId: 'other-instance' },
    { ...invite, recoveryEpoch: 'other-epoch' },
    { ...invite, access: { ...invite.access, playerId: 'other-player' } },
  ]) {
    const { session, controller } = setup(async (url) =>
      Response.json(String(url).endsWith('/invites/redeem') ? receipt : changed),
    );
    await assert.rejects(() => controller.redeem('A'.repeat(43), 'req-1'), /WEB_INVITE_SCOPE_MISMATCH/);
    assert.equal(session.scope?.accessKind, 'guest');
    session.invalidate();
  }
});

for (const code of ['SESSION_ROTATED_RECOVERABLE', 'SESSION_EXPIRED'])
  test(`explicit ${code} recovery uses challenge and recover, never replays redeem`, async () => {
    const calls: string[] = [];
    const { session, controller } = setup(async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/bootstrap') && calls.filter((v) => v.endsWith('/bootstrap')).length === 1)
        return Response.json({ error: { code } }, { status: 409 });
      if (path.endsWith('/identity/invite-receipt-challenge')) return Response.json({ csrf: 'recovery-csrf' });
      if (path.endsWith('/identity/invite-receipt-recover')) return Response.json(receipt);
      if (path.endsWith('/bootstrap')) return Response.json(invite);
      throw new Error('unexpected path');
    });
    assert.deepEqual(await controller.recover('A'.repeat(43), 'req-1'), {
      principalId: 'principal-1',
      grantId: 'grant-1',
    });
    assert.equal(
      calls.some((path) => path.endsWith('/invites/redeem')),
      false,
    );
    assert.equal(session.scope?.accessKind, 'invite');
    session.invalidate();
  });

test('expired local guest may recover only an already accepted server receipt, not initiate redeem', async () => {
  const calls: string[] = [];
  const { session, controller } = setup(
    async (url) => {
      const path = String(url);
      calls.push(path);
      if (path.endsWith('/bootstrap')) return Response.json(invite);
      if (path.endsWith('/identity/invite-receipt-status'))
        return Response.json({ grantId: 'grant-1', principalId: 'principal-1', expiresAt: null });
      throw new Error('unexpected path');
    },
    () => 5000,
  );
  assert.equal(session.contentAvailable(), false);
  await assert.rejects(() => controller.redeem('A'.repeat(43), 'new-request'), /WEB_INVITE_GUEST_REQUIRED/);
  assert.deepEqual(await controller.recover('A'.repeat(43), 'existing-request'), {
    principalId: 'principal-1',
    grantId: 'grant-1',
  });
  assert.equal(
    calls.some((path) => path.endsWith('/invites/redeem')),
    false,
  );
  assert.equal(session.scope?.accessKind, 'invite');
  session.invalidate();
});
