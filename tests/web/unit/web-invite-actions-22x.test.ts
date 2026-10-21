import assert from 'node:assert/strict';
import test from 'node:test';
import { WebInviteActions } from '../../../apps/server/invites/web-invite-actions.ts';
import { routeWebInvite } from '../../../apps/server/invites/web-invite-routes.ts';
import { origin, tiersFixture } from '../fixtures/invite-tiers.ts';

/**
 * Part 22x. The security assertions the removed legacy-invite identity tests carried that still apply to the remaining code: the
 * administrator actions authenticate the real cookie hash and CSRF, a redemption is charged to its own trusted-IP budget, and the
 * route core separates administrator and player credentials and never takes a secret from the URL.
 */
function setup(t: test.TestContext) {
  const f = tiersFixture(t);
  const actions = new WebInviteActions(f.store, { now: f.clock }, origin, f.tiers);
  return { f, actions };
}
const code = (expected: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
const ipHash = 'd'.repeat(64);

test('22x an administrator action checks the real cookie hash, CSRF and Origin', (t) => {
  const { f, actions } = setup(t);
  const { cookie, csrf } = f.owner;
  assert.throws(() => actions.listBatches('E'.repeat(43), csrf, origin), code('ADMIN_UNAUTHORIZED'));
  assert.throws(() => actions.listBatches(cookie, 'wrong', origin), code('ADMIN_CSRF_REQUIRED'));
  assert.throws(() => actions.listBatches(cookie, '界'.repeat(64), origin), code('ADMIN_CSRF_REQUIRED'));
  assert.throws(() => actions.listBatches(cookie, csrf, 'https://wrong.local'), code('ADMIN_UNAUTHORIZED'));
  assert.deepEqual(actions.listBatches(cookie, csrf, origin), { batches: [] });
  const created = actions.createBatch(cookie, csrf, origin, {
    requestId: 'batch-1',
    name: 'synthetic',
    count: 1,
    tier: { kind: 'unlimited' },
    durationDays: null,
    redeemBy: null,
  });
  assert.match(created.codes![0]!, /^[A-Za-z0-9_-]{43}$/);
});

test('22x a redemption is charged to its own trusted-IP budget: 20 attempts a minute, then WEB_INVITE_RATE_LIMITED', (t) => {
  const { f, actions } = setup(t);
  const batch = f.create(f.owner, { tier: { kind: 'unlimited' }, count: 1 });
  const who = f.player('ann', { signedUp: true });
  for (let i = 0; i < 19; i++)
    assert.throws(
      () => actions.redeemTier(who.token, 'csrf', origin, ipHash, { requestId: `wrong-${i}`, code: 'A'.repeat(43) }),
      code('WEB_INVITE_UNAVAILABLE'),
    );
  const redeemed = actions.redeemTier(who.token, 'csrf', origin, ipHash, { requestId: 'use', code: batch.codes![0]! });
  assert.equal(redeemed.duplicate, false);
  assert.throws(
    () => actions.redeemTier(who.token, 'csrf', origin, ipHash, { requestId: 'over', code: batch.codes![0]! }),
    code('WEB_INVITE_RATE_LIMITED'),
  );
  // Another address has its own budget.
  assert.equal(
    actions.redeemTier(who.token, 'csrf', origin, 'e'.repeat(64), { requestId: 'use', code: batch.codes![0]! })
      .duplicate,
    true,
  );
});

test('22x the route core separates administrator and player credentials and takes no secret from the URL', (t) => {
  const { f, actions } = setup(t);
  const { cookie, csrf } = f.owner;
  const created = routeWebInvite(actions, {
    method: 'POST',
    path: '/api/web/local/admin/invites/batch-create',
    origin,
    csrf,
    adminCookie: cookie,
    body: {
      requestId: 'route-batch',
      name: 'synthetic',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
    },
  });
  assert.equal(created.status, 201);
  const secret = (created.body as { codes: string[] }).codes[0]!;
  const who = f.player('ann', { signedUp: true });
  const redeem = {
    method: 'POST',
    origin,
    csrf: 'csrf',
    playerToken: who.token,
    trustedIpHash: ipHash,
    body: { requestId: 'route-redeem', code: secret },
  };
  assert.throws(
    () => routeWebInvite(actions, { ...redeem, path: `/api/web/local/invites/redeem?code=${secret}` }),
    code('NOT_FOUND'),
  );
  assert.throws(
    () =>
      routeWebInvite(actions, { ...redeem, path: '/api/web/local/invites/redeem', body: { ...redeem.body, extra: 1 } }),
    code('INVALID_REQUEST'),
  );
  // A player's token is not an administrator's cookie.
  assert.throws(
    () =>
      routeWebInvite(actions, {
        method: 'POST',
        path: '/api/web/local/admin/invites/batch-list',
        origin,
        csrf: 'csrf',
        playerToken: who.token,
        body: {},
      }),
    code('ADMIN_UNAUTHORIZED'),
  );
  const redeemed = routeWebInvite(actions, { ...redeem, path: '/api/web/local/invites/redeem' });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.issuedToken, undefined, 'an entitlement never rotates the session');
  assert.ok(!JSON.stringify(redeemed.body).includes(secret));
});
