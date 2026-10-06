import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderInviteController } from '../../src/session/provider-invite-controller.ts';
import { ProviderApiError } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap, type WebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';

function fixture() {
  let current = syntheticProviderBootstrap(),
    installed = 0,
    ids = 0;
  const status = { grantId: 'grant', principalId: current.access.principalId, expiresAt: null };
  const receipt = { ...status, csrf: 'active', duplicate: false };
  const active = (): WebProviderBootstrap => ({
    ...current,
    access: {
      ...current.access,
      kind: 'invite',
      grantId: status.grantId,
      status: 'active',
      canSend: true,
      lockedCharacterId: null,
      remainingReplies: null,
      reservedReplies: null,
      trialExpiresAt: null,
    },
  });
  const calls = {
    redeem: [] as { requestId: string; code: string }[],
    recover: [] as { requestId: string; code: string }[],
    status: [] as string[],
    challenge: 0,
  };
  const handlers = {
    bootstrap: async () => active(),
    redeem: async () => receipt,
    status: async () => status,
    recover: async () => receipt,
  };
  const api = {
    bootstrap: () => handlers.bootstrap(),
    redeemInvite: async (input: { requestId: string; code: string }) => {
      calls.redeem.push(input);
      return handlers.redeem();
    },
    inviteReceiptStatus: async (id: string) => {
      calls.status.push(id);
      return handlers.status();
    },
    inviteReceiptChallenge: async () => {
      calls.challenge++;
      return 'receipt';
    },
    recoverInviteReceipt: async (input: { requestId: string; code: string }, csrf: string) => {
      assert.equal(csrf, 'receipt');
      calls.recover.push(input);
      return handlers.recover();
    },
  };
  const controller = new ProviderInviteController(
    api,
    () => current,
    (view) => {
      current = view;
      installed++;
    },
    () => {},
    () => `id-${++ids}`,
  );
  return { controller, handlers, calls, active, status, installed: () => installed, current: () => current };
}
const code = 'A'.repeat(43);
test('successful in-place invite installs only its receipt; accepted cannot redeem again', async () => {
  const f = fixture();
  assert.equal(await f.controller.redeem(code), true);
  assert.equal(f.controller.state.phase, 'accepted');
  assert.equal(f.installed(), 1);
  assert.equal(await f.controller.redeem(code), false);
  assert.equal(f.calls.redeem.length, 1);
});
test('invalid code stays editable, transactional unavailable permits a new intent', async () => {
  const f = fixture();
  await f.controller.redeem('bad');
  assert.equal(f.calls.redeem.length, 0);
  f.handlers.redeem = async () => {
    throw new ProviderApiError(409, 'WEB_INVITE_UNAVAILABLE');
  };
  await f.controller.redeem(code);
  assert.equal(f.controller.state.phase, 'entry');
  await f.controller.redeem('B'.repeat(43));
  assert.deepEqual(
    f.calls.redeem.map((r) => r.requestId),
    ['id-1', 'id-2'],
  );
});
test('body loss with installed cookie recovers by status, never redeem or receipt challenge', async () => {
  const f = fixture();
  f.handlers.redeem = async () => {
    throw Error('lost');
  };
  await f.controller.redeem(code);
  assert.equal(f.controller.state.phase, 'uncertain');
  assert.equal(await f.controller.recover(), true);
  assert.deepEqual(f.calls.status, ['id-1']);
  assert.equal(f.calls.redeem.length, 1);
  assert.equal(f.calls.challenge, 0);
});
test('lost whole response recovers fixed code and request, recovery itself is single flight', async () => {
  const f = fixture();
  f.handlers.redeem = async () => {
    throw Error('lost');
  };
  let boots = 0;
  f.handlers.bootstrap = async () => {
    if (++boots === 1) throw new ProviderApiError(401, 'SESSION_ROTATED_RECOVERABLE');
    return f.active();
  };
  await f.controller.redeem(code);
  const recovering = f.controller.recover();
  assert.equal(await f.controller.recover(), false);
  assert.equal(await f.controller.redeem('B'.repeat(43)), false);
  assert.equal(await recovering, true);
  assert.deepEqual(f.calls.recover, f.calls.redeem);
});
test('unavailable receipt and post-accept bootstrap errors never authorize a fresh redemption', async () => {
  const f = fixture();
  f.handlers.bootstrap = async () => {
    throw new ProviderApiError(409, 'WEB_INVITE_UNAVAILABLE');
  };
  await f.controller.redeem(code);
  assert.equal(f.controller.state.phase, 'uncertain');
  f.handlers.bootstrap = async () => f.active();
  f.handlers.status = async () => {
    throw new ProviderApiError(404, 'RECEIPT_UNAVAILABLE');
  };
  assert.equal(await f.controller.recover(), false);
  assert.equal(f.controller.state.phase, 'uncertain');
  assert.equal(await f.controller.redeem(code), false);
  assert.equal(f.calls.redeem.length, 1);
  assert.equal(f.installed(), 0);
});
for (const field of [
  'instance',
  'epoch',
  'principal',
  'player',
  'world',
  'grant',
  'receipt-principal',
  'revoked',
] as const) {
  test(`invite fails closed on ${field} mismatch without installing a different identity`, async () => {
    const f = fixture();
    f.handlers.bootstrap = async () => {
      const view = f.active();
      if (field === 'instance') view.instanceId = 'other';
      if (field === 'epoch') view.recoveryEpoch = 'other';
      if (field === 'principal') view.access.principalId = 'other';
      if (field === 'player') view.access.playerId = 'other';
      if (field === 'world') view.access.worldId = 'other';
      if (field === 'receipt-principal') f.status.principalId = 'other';
      if (view.access.kind === 'invite' && field === 'grant') view.access.grantId = 'other';
      if (view.access.kind === 'invite' && field === 'revoked') view.access.status = 'revoked';
      return view;
    };
    if (field === 'receipt-principal')
      f.handlers.redeem = async () => ({ ...f.status, principalId: 'other', csrf: 'active', duplicate: false });
    assert.equal(await f.controller.redeem(code), false);
    assert.equal(f.controller.state.phase, 'blocked');
    assert.equal(f.installed(), 0);
    assert.equal(await f.controller.recover(), false);
  });
}
