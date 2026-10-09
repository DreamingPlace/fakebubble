import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebInvites } from '../../../apps/server/invites/web-invites.ts';
import { WebInviteActions } from '../../../apps/server/invites/web-invite-actions.ts';
import { WebInviteAdmin } from '../../../apps/server/invites/web-invite-admin.ts';
import { routeWebInvite } from '../../../apps/server/invites/web-invite-routes.ts';

const origin = 'https://synthetic.local';
function fixture(t: test.TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  Object.assign(store, { instanceId: 'synthetic-instance' });
  store.db.exec(`
    CREATE TABLE web_instance(singleton INTEGER PRIMARY KEY,recovery_epoch TEXT NOT NULL);
    INSERT INTO web_instance VALUES (1,'synthetic-epoch');
    CREATE TABLE web_principals(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,world_id TEXT NOT NULL,
      kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE web_sessions(id TEXT PRIMARY KEY,token_digest TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL,account_id TEXT,recovery_epoch TEXT NOT NULL,
      security_revision INTEGER NOT NULL,csrf_seed BLOB NOT NULL,created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE web_identity_receipts(new_session_id TEXT,revoked_at INTEGER);
    CREATE TABLE web_guest_retention(principal_id TEXT PRIMARY KEY,world_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unstarted',revision INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER,expires_at INTEGER);
    PRAGMA user_version=112;
  `);
  for (const name of ['111_invite_core.sql', '112_invite_identity.sql'])
    store.db.exec(readFileSync(new URL(`../../../apps/server/web-migrations/${name}`, import.meta.url), 'utf8'));
  let now = 1_700_000_000_000,
    counter = 0;
  const adminCookie = 'D'.repeat(43);
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  store.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', 'admin', hash(adminCookie), now, now + 60_000);
  const clock = { now: () => now },
    webStore = store as unknown as WebStore;
  const identity = new WebIdentity(webStore, {
    origin,
    cookieName: '__Host-synthetic',
    clock,
    keys: { keyId: 'synthetic-only', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
    nextId: () => `identity-${++counter}`,
  });
  const invites = new WebInvites(store, {
    clock,
    codeKey: Buffer.alloc(32, 3),
    authorize: identity.authorizeInviteAction.bind(identity),
    identity,
    nextId: () => `invite-${++counter}`,
  });
  const actions = new WebInviteActions(store, clock, origin, invites, identity);
  const guest = identity.bootstrap(),
    token = guest.issuedToken!;
  const issue = () =>
    invites.issue({
      adminSessionId: 'admin',
      requestId: 'issue',
      redeemBy: now + 10_000,
      accessDurationMs: 30_000,
      batch: 'synthetic',
      note: null,
    });
  const redeem = (code: string) => invites.redeem({ token, csrf: guest.csrf, origin, code, requestId: 'redeem' });
  return {
    store,
    identity,
    invites,
    actions,
    guest,
    token,
    issue,
    redeem,
    adminCookie,
    adminCsrf: hash(`bubble-admin-csrf:${adminCookie}`),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('real identity authorizer rotates old session and seals the new bearer in the redemption transaction', (t) => {
  const f = fixture(t),
    before = f.identity.authenticate(f.token),
    issued = f.issue();
  const result = f.redeem(issued.code!);
  assert.equal(result.duplicate, false);
  if (result.duplicate) throw new Error('unexpected duplicate');
  assert.equal(result.identity?.receipt.grantId, result.grantId);
  assert.equal(result.principalId, before.principalId);
  assert.equal(result.playerId, before.player_id);
  assert.equal(result.worldId, before.world_id);
  assert.throws(() => f.identity.authenticate(f.token), /SESSION_EXPIRED/);
  const next = result.identity!.issuedToken;
  assert.equal(f.identity.authenticate(next).principalId, before.principalId);
  assert.equal(f.identity.authenticate(next).kind, 'invite');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_identity_receipts')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 1);
  const challenge = f.invites.inviteReceiptChallenge(f.token);
  assert.throws(
    () =>
      f.invites.recoverRedemption({
        oldToken: f.token,
        csrf: challenge.csrf,
        origin,
        requestId: 'redeem',
        code: 'A'.repeat(43),
      }),
    /RECEIPT_UNAVAILABLE/,
  );
  for (let i = 0; i < 3; i++) {
    const recovered = f.invites.recoverRedemption({
      oldToken: f.token,
      csrf: challenge.csrf,
      origin,
      requestId: 'redeem',
      code: issued.code!,
    });
    assert.equal(recovered.issuedToken, next);
    assert.deepEqual(recovered.receipt, result.identity!.receipt);
  }
  assert.throws(
    () =>
      f.invites.recoverRedemption({
        oldToken: f.token,
        csrf: challenge.csrf,
        origin,
        requestId: 'redeem',
        code: issued.code!,
      }),
    /RECEIPT_UNAVAILABLE/,
  );
  assert.deepEqual(
    f.invites.inviteReceiptStatus(next, result.identity!.csrf, origin, 'redeem'),
    result.identity!.receipt,
  );
  const raw = JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_identity_receipts').all());
  assert.ok(!raw.includes(next) && !raw.includes(issued.code!));
});

test('revoked grant disables both old-cookie recovery and new-cookie status', (t) => {
  const f = fixture(t),
    issued = f.issue(),
    result = f.redeem(issued.code!);
  if (result.duplicate) throw new Error('unexpected duplicate');
  const challenge = f.invites.inviteReceiptChallenge(f.token);
  f.invites.revokeGrant('admin', result.grantId);
  assert.throws(
    () =>
      f.invites.recoverRedemption({
        oldToken: f.token,
        csrf: challenge.csrf,
        origin,
        requestId: 'redeem',
        code: issued.code!,
      }),
    /RECEIPT_UNAVAILABLE/,
  );
  assert.throws(
    () => f.invites.inviteReceiptStatus(result.identity!.issuedToken, result.identity!.csrf, origin, 'redeem'),
    // Revoking a grant now also ends the player's sessions, so the new cookie is rejected before any receipt lookup.
    /SESSION_EXPIRED/,
  );
});

test('identity receipt failure rolls back code use, grant, protected retention and old-session revocation', (t) => {
  const f = fixture(t),
    issued = f.issue();
  f.store.db.exec(`CREATE TRIGGER synthetic_receipt_failure BEFORE INSERT ON web_invite_identity_receipts
    BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
  assert.throws(() => f.redeem(issued.code!), /synthetic receipt failure/);
  assert.equal(f.identity.authenticate(f.token).kind, 'guest');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 0);
  assert.equal(
    f.store.get<{ redeemed_count: number }>('SELECT redeemed_count FROM web_invite_codes WHERE id=?', issued.inviteId)
      ?.redeemed_count,
    0,
  );
  assert.equal(f.store.get<{ state: string }>('SELECT state FROM web_guest_retention')?.state, 'unstarted');
});

test('separate recovery credential rotates secret and session without using the consumed invite code', (t) => {
  const f = fixture(t),
    issued = f.issue(),
    redeemed = f.redeem(issued.code!);
  if (redeemed.duplicate) throw new Error('unexpected duplicate');
  const oldToken = redeemed.identity!.issuedToken;
  const saved = f.identity.createInviteCredential(oldToken, redeemed.identity!.csrf, origin);
  assert.match(saved.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(saved.secret, issued.code);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_credentials').all()).includes(saved.secret));
  const ipHash = 'a'.repeat(64);
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'restore', secret: 'B'.repeat(43), ipHash }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  const recovered = f.identity.recoverInviteCredential({ origin, requestId: 'restore', secret: saved.secret, ipHash });
  assert.equal(recovered.duplicate, false);
  assert.equal(recovered.principalId, redeemed.principalId);
  assert.notEqual(recovered.recoverySecret, saved.secret);
  assert.throws(() => f.identity.authenticate(oldToken), /SESSION_EXPIRED/);
  assert.throws(
    () => f.invites.inviteReceiptChallenge(f.token),
    /RECEIPT_UNAVAILABLE/,
    'later credential rotation invalidates the old redemption receipt target',
  );
  assert.equal(f.identity.authenticate(recovered.issuedToken).principalId, redeemed.principalId);
  const duplicate = f.identity.recoverInviteCredential({ origin, requestId: 'restore', secret: saved.secret, ipHash });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.issuedToken, recovered.issuedToken);
  assert.equal(duplicate.recoverySecret, recovered.recoverySecret);
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'different', secret: saved.secret, ipHash }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  f.invites.revokeGrant('admin', redeemed.grantId);
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'restore', secret: saved.secret, ipHash }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
});

test('logout revokes sealed invite receipt recovery rather than leaving its old cookie usable', (t) => {
  const f = fixture(t),
    issued = f.issue(),
    redeemed = f.redeem(issued.code!);
  if (redeemed.duplicate) throw new Error('unexpected duplicate');
  const target = redeemed.identity!;
  f.identity.logout(target.issuedToken, target.csrf, origin);
  assert.throws(() => f.invites.inviteReceiptChallenge(f.token), /RECEIPT_UNAVAILABLE/);
  assert.throws(
    () => f.invites.inviteReceiptStatus(target.issuedToken, target.csrf, origin, 'redeem'),
    /SESSION_EXPIRED/,
  );
});

test('wrong recovery proofs consume a bounded trusted-IP window before looking up credentials', (t) => {
  const f = fixture(t),
    ipHash = 'c'.repeat(64);
  for (let i = 0; i < 20; i++)
    assert.throws(
      () => f.identity.recoverInviteCredential({ origin, requestId: `wrong-${i}`, secret: 'C'.repeat(43), ipHash }),
      /WEB_INVITE_RECOVERY_UNAVAILABLE/,
    );
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'limit', secret: 'C'.repeat(43), ipHash }),
    /WEB_IDENTITY_RATE_LIMITED/,
  );
  f.advance(60_000);
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'new-window', secret: 'C'.repeat(43), ipHash }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
});

test('administrator action uses real cookie hash and CSRF; redeem charges a separate trusted-IP budget', (t) => {
  const f = fixture(t),
    body = {
      requestId: 'admin-action',
      redeemBy: null,
      accessDurationMs: null as null,
      batch: 'synthetic',
      note: null,
    };
  assert.throws(
    () =>
      routeWebInvite(f.actions, {
        method: 'POST',
        path: '/api/web/local/admin/invites/issue',
        origin,
        csrf: f.adminCsrf,
        adminCookie: f.adminCookie,
        body: { ...body, accessDurationMs: 1000 },
      }),
    /WEB_INVITE_TERMS_REQUIRED/,
  );
  assert.throws(() => f.actions.issue('E'.repeat(43), f.adminCsrf, origin, body), /ADMIN_UNAUTHORIZED/);
  assert.throws(() => f.actions.issue(f.adminCookie, 'wrong', origin, body), /ADMIN_CSRF_REQUIRED/);
  assert.throws(() => f.actions.issue(f.adminCookie, '界'.repeat(64), origin, body), /ADMIN_CSRF_REQUIRED/);
  assert.throws(() => f.actions.issue(f.adminCookie, f.adminCsrf, 'https://wrong.local', body), /ADMIN_UNAUTHORIZED/);
  const issued = f.actions.issue(f.adminCookie, f.adminCsrf, origin, body);
  assert.match(issued.code!, /^[A-Za-z0-9_-]{43}$/);
  const ipHash = 'd'.repeat(64);
  for (let i = 0; i < 19; i++)
    assert.throws(
      () => f.actions.redeem(f.token, f.guest.csrf, origin, ipHash, { requestId: `wrong-${i}`, code: 'A'.repeat(43) }),
      /WEB_INVITE_UNAVAILABLE/,
    );
  const redeemed = f.actions.redeem(f.token, f.guest.csrf, origin, ipHash, { requestId: 'use', code: issued.code! });
  assert.equal(redeemed.duplicate, false);
  assert.throws(
    () => f.actions.redeem(f.token, f.guest.csrf, origin, ipHash, { requestId: 'over-limit', code: issued.code! }),
    /WEB_INVITE_RATE_LIMITED/,
  );
});

test('same-Web-instance local administrator grant logs in once, issues a code and revokes its session', (t) => {
  const f = fixture(t);
  f.store.run("UPDATE admin_sessions SET revoked_at=1 WHERE id='admin'");
  let now = 1_700_000_000_000,
    counter = 0;
  const admin = new WebInviteAdmin(f.store, { now: () => now }, origin, undefined, () => `web-admin-${++counter}`);
  const grant = admin.issueLoginGrant();
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(
    JSON.stringify(f.store.db.prepare('SELECT * FROM admin_login_grants').all()).includes(grant.token),
    false,
  );
  assert.throws(() => admin.login('X'.repeat(43), origin), /ADMIN_INVALID_GRANT/);
  assert.throws(() => admin.login(grant.token, 'https://wrong.local'), /ADMIN_UNAUTHORIZED/);
  const login = admin.login(grant.token, origin);
  assert.throws(() => admin.login(grant.token, origin), /ADMIN_INVALID_GRANT/);
  assert.throws(() => admin.authorize(f.token, login.csrf, origin), /ADMIN_UNAUTHORIZED/);
  assert.throws(() => admin.authorize(login.cookie, login.csrf, 'https://wrong.local'), /ADMIN_UNAUTHORIZED/);
  assert.throws(() => admin.authorize(login.cookie, 'wrong', origin), /ADMIN_CSRF_REQUIRED/);
  assert.throws(() => admin.authorize(login.cookie, '界'.repeat(64), origin), /ADMIN_CSRF_REQUIRED/);
  assert.equal(admin.authorize(login.cookie, login.csrf, origin).sessionId, 'web-admin-1');
  const issued = f.actions.issue(login.cookie, login.csrf, origin, {
    requestId: 'local-admin-issue',
    redeemBy: now + 30_000,
    accessDurationMs: null,
    batch: 'synthetic',
    note: null,
  });
  assert.match(issued.code!, /^[A-Za-z0-9_-]{43}$/);
  admin.logout(login.cookie);
  assert.throws(
    () =>
      f.actions.issue(login.cookie, login.csrf, origin, {
        requestId: 'after-logout',
        redeemBy: null,
        accessDurationMs: null,
        batch: 'synthetic',
        note: null,
      }),
    /ADMIN_UNAUTHORIZED/,
  );
  const routeGrant = admin.issueLoginGrant();
  const routeLogin = routeWebInvite(
    f.actions,
    { method: 'POST', path: '/api/web/local/admin/login', origin, body: { token: routeGrant.token } },
    admin,
  );
  assert.equal(routeLogin.status, 200);
  assert.equal(JSON.stringify(routeLogin.body).includes(routeLogin.issuedAdminCookie!), false);
  const routeCookie = routeLogin.issuedAdminCookie!;
  const routeCsrf = (routeLogin.body as { csrf: string }).csrf;
  const routeIssue = routeWebInvite(
    f.actions,
    {
      method: 'POST',
      path: '/api/web/local/admin/invites/issue',
      origin,
      csrf: routeCsrf,
      adminCookie: routeCookie,
      body: { requestId: 'route-admin-issue', redeemBy: null, accessDurationMs: null, batch: 'synthetic', note: null },
    },
    admin,
  );
  assert.equal(routeIssue.status, 201);
  assert.equal(
    routeWebInvite(
      f.actions,
      {
        method: 'POST',
        path: '/api/web/local/admin/logout',
        origin,
        csrf: routeCsrf,
        adminCookie: routeCookie,
        body: {},
      },
      admin,
    ).status,
    200,
  );
  assert.throws(
    () =>
      f.actions.issue(routeCookie, routeCsrf, origin, {
        requestId: 'route-after-logout',
        redeemBy: null,
        accessDurationMs: null,
        batch: 'synthetic',
        note: null,
      }),
    /ADMIN_UNAUTHORIZED/,
  );
  now += 10 * 60_000;
  assert.throws(() => admin.login(grant.token, origin), /ADMIN_INVALID_GRANT/);
});

test('unconsumed local admin grant and independent session expire at their own deadlines', (t) => {
  const f = fixture(t);
  let now = 1_700_000_000_000;
  const admin = new WebInviteAdmin(f.store, { now: () => now }, origin);
  const unused = admin.issueLoginGrant();
  now = unused.expiresAt;
  assert.throws(() => admin.login(unused.token, origin), /ADMIN_INVALID_GRANT/);
  const fresh = admin.issueLoginGrant();
  const login = admin.login(fresh.token, origin);
  now = login.expiresAt;
  assert.throws(() => admin.authorize(login.cookie, login.csrf, origin), /ADMIN_UNAUTHORIZED/);
});

test('unserved local-3 route core separates administrator and player cookies without URL secrets', (t) => {
  const f = fixture(t);
  const issued = routeWebInvite(f.actions, {
    method: 'POST',
    path: '/api/web/local/admin/invites/issue',
    origin,
    csrf: f.adminCsrf,
    adminCookie: f.adminCookie,
    body: { requestId: 'route-issue', redeemBy: null, accessDurationMs: null, batch: 'synthetic', note: null },
  });
  assert.equal(issued.status, 201);
  const code = (issued.body as { code: string }).code;
  assert.throws(
    () =>
      routeWebInvite(f.actions, {
        method: 'POST',
        path: `/api/web/local/invites/redeem?code=${code}`,
        origin,
        csrf: f.guest.csrf,
        playerToken: f.token,
        trustedIpHash: 'd'.repeat(64),
        body: {},
      }),
    /NOT_FOUND/,
  );
  assert.throws(
    () =>
      routeWebInvite(f.actions, {
        method: 'POST',
        path: '/api/web/local/admin/invites/revoke-code',
        origin,
        csrf: f.guest.csrf,
        playerToken: f.token,
        body: { id: (issued.body as { inviteId: string }).inviteId },
      }),
    /ADMIN_UNAUTHORIZED/,
  );
  const redeemed = routeWebInvite(f.actions, {
    method: 'POST',
    path: '/api/web/local/invites/redeem',
    origin,
    csrf: f.guest.csrf,
    playerToken: f.token,
    trustedIpHash: 'd'.repeat(64),
    body: { requestId: 'route-redeem', code },
  });
  assert.equal(redeemed.status, 201);
  assert.equal(typeof redeemed.issuedToken, 'string');
  assert.ok(!JSON.stringify(redeemed.body).includes(redeemed.issuedToken!));
});
