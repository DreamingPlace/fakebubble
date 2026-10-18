import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderInviteController } from '../../src/session/provider-invite-controller.ts';
import { ProviderApiError } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';

/** Part 22a: a signed-in player's code adds an entitlement; a guest's code is refused and stays unused. */
function fixture(redeem: () => Promise<unknown>) {
  const view = syntheticProviderBootstrap();
  const installed: unknown[] = [];
  const redeems: { requestId: string; code: string }[] = [];
  let ids = 0;
  const controller = new ProviderInviteController(
    {
      bootstrap: async () => view,
      redeemInvite: (async (input: { requestId: string; code: string }) => {
        redeems.push(input);
        return redeem();
      }) as never,
      inviteReceiptStatus: async () => {
        throw new Error('not used');
      },
      inviteReceiptChallenge: async () => {
        throw new Error('not used');
      },
      recoverInviteReceipt: async () => {
        throw new Error('not used');
      },
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
