import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderInviteController } from '../../src/session/provider-invite-controller.ts';
import { ProviderApiError } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap, type WebProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';

/** Part 22a: a signed-in player's code adds an entitlement; a guest's code is refused and stays unused. */
function fixture(redeem: () => Promise<unknown>, bootstrap?: () => Promise<WebProviderBootstrap>) {
  const view = syntheticProviderBootstrap();
  const installed: unknown[] = [];
  const redeems: { requestId: string; code: string }[] = [];
  let ids = 0;
  const controller = new ProviderInviteController(
    {
      bootstrap: bootstrap ?? (async () => view),
      redeemInvite: (async (input: { requestId: string; code: string }) => {
        redeems.push(input);
        return redeem();
      }) as never,
    },
    () => view,
    (next) => installed.push(next),
    () => {},
    () => `request-${++ids}`,
  );
  return { controller, redeems, installed };
}

test('22a an entitlement answer is accepted without any invite-principal check: same principal, same session', async () => {
  const f = fixture(async () => ({
    entitlement: { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null },
    duplicate: false,
  }));
  assert.equal(await f.controller.redeem('A'.repeat(43)), true);
  assert.equal(f.controller.state.phase, 'accepted');
  assert.equal(f.installed.length, 1);
  assert.equal(f.redeems.length, 1);
});

test('22a a guest’s code is refused with PLAYER_LOGIN_REQUIRED: the player may edit and try again (nothing was consumed)', async () => {
  const f = fixture(async () => {
    throw new ProviderApiError(409, 'PLAYER_LOGIN_REQUIRED');
  });
  assert.equal(await f.controller.redeem('A'.repeat(43)), false);
  assert.deepEqual(f.controller.state, { phase: 'entry', errorCode: 'PLAYER_LOGIN_REQUIRED' });
  assert.equal(f.controller.locked, false);
  // Not "uncertain": a second attempt is a fresh request with a new id, not a locked recovery.
  assert.equal(await f.controller.redeem('B'.repeat(43)), false);
  assert.deepEqual(
    f.redeems.map((r) => r.requestId),
    ['request-1', 'request-2'],
  );
});

test('22a a lost response is still uncertain and never resent', async () => {
  const f = fixture(async () => {
    throw new Error('lost');
  });
  assert.equal(await f.controller.redeem('A'.repeat(43)), false);
  assert.equal(f.controller.state.phase, 'uncertain');
  await f.controller.redeem('B'.repeat(43));
  assert.equal(f.redeems.length, 1);
});

/** Part 22x: the assertions of the removed legacy-invite controller test that still apply to the entitlement path. */
const answer = async () => ({ entitlement: { kind: 'unlimited', expiresAt: null }, duplicate: false });

test('22x an accepted redemption cannot be redeemed again', async () => {
  const f = fixture(answer);
  assert.equal(await f.controller.redeem('A'.repeat(43)), true);
  assert.equal(await f.controller.redeem('A'.repeat(43)), false);
  assert.equal(f.redeems.length, 1);
});

test('22x an invalid code stays editable and sends nothing; an explicit rejection permits a new request', async () => {
  let reject = false;
  const f = fixture(async () => {
    if (reject) throw new ProviderApiError(409, 'WEB_INVITE_UNAVAILABLE');
    return answer();
  });
  await f.controller.redeem('bad');
  assert.equal(f.redeems.length, 0);
  assert.deepEqual(f.controller.state, { phase: 'entry', errorCode: 'INVALID_CODE' });
  reject = true;
  await f.controller.redeem('A'.repeat(43));
  assert.equal(f.controller.state.phase, 'entry');
  await f.controller.redeem('B'.repeat(43));
  assert.deepEqual(
    f.redeems.map((r) => r.requestId),
    ['request-1', 'request-2'],
  );
});

test('22x an uncertain redemption is settled by the SAME request, once, and nothing else can start meanwhile', async () => {
  let lose = true;
  const f = fixture(async () => {
    if (lose) throw new Error('lost');
    return answer();
  });
  await f.controller.redeem('A'.repeat(43));
  assert.equal(f.controller.state.phase, 'uncertain');
  lose = false;
  const recovering = f.controller.recover();
  assert.equal(await f.controller.recover(), false, 'recovery is single flight');
  assert.equal(await f.controller.redeem('B'.repeat(43)), false, 'no fresh redemption while one is unsettled');
  assert.equal(await recovering, true);
  assert.equal(f.controller.state.phase, 'accepted');
  assert.deepEqual(f.redeems[1], f.redeems[0], 'the recovery repeated the original code and request id');
  assert.equal(f.redeems.length, 2);
});

test('22x an unconfirmed answer after the redemption stays uncertain and never authorizes a new request', async () => {
  let fail = true;
  const view = syntheticProviderBootstrap();
  const f = fixture(answer, async () => {
    if (fail) throw new ProviderApiError(500, 'INTERNAL_ERROR');
    return view;
  });
  await f.controller.redeem('A'.repeat(43));
  assert.equal(f.controller.state.phase, 'uncertain');
  assert.equal(f.installed.length, 0);
  assert.equal(await f.controller.redeem('B'.repeat(43)), false);
  fail = false;
  assert.equal(await f.controller.recover(), true);
  assert.deepEqual(
    f.redeems.map((r) => r.requestId),
    ['request-1', 'request-1'],
  );
});

for (const field of ['instance', 'epoch', 'principal', 'player', 'world'] as const) {
  test(`22x the redemption fails closed on a ${field} mismatch without installing a different identity`, async () => {
    const f = fixture(answer, async () => {
      const view = syntheticProviderBootstrap();
      if (field === 'instance') view.instanceId = 'other';
      if (field === 'epoch') view.recoveryEpoch = 'other';
      if (field === 'principal') view.access.principalId = 'other';
      if (field === 'player') view.access.playerId = 'other';
      if (field === 'world') view.access.worldId = 'other';
      return view;
    });
    assert.equal(await f.controller.redeem('A'.repeat(43)), false);
    assert.equal(f.controller.state.phase, 'blocked');
    assert.equal(f.installed.length, 0);
    assert.equal(await f.controller.recover(), false);
  });
}
