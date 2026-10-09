import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebInvites } from '../../../apps/server/invites/web-invites.ts';
import { WebInviteActions } from '../../../apps/server/invites/web-invite-actions.ts';
import { WebInviteAdmin } from '../../../apps/server/invites/web-invite-admin.ts';

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

const DAY = 24 * 60 * 60_000;
const ip = (digit: string) => digit.repeat(64);

/** Redeems a fresh invite and returns the invited player's live token + csrf. */
function invited(f: ReturnType<typeof fixture>) {
  // Production codes carry no access deadline (accessDurationMs null), so the grant never expires on its own.
  const issued = f.invites.issue({
      adminSessionId: 'admin',
      requestId: `issue-${f.guest.principalId}`,
      redeemBy: null,
      accessDurationMs: null,
      batch: 'stay-signed-in',
      note: null,
    }),
    result = f.redeem(issued.code!);
  if (result.duplicate) throw new Error('unexpected duplicate');
  return { grantId: result.grantId, token: result.identity!.issuedToken, csrf: result.identity!.csrf };
}
const sessionDigest = (token: string) =>
  createHmac('sha256', Buffer.alloc(32, 2)).update('session\0').update(token).digest('hex');

test('an invited session older than 24h still authenticates and bootstraps; a guest session expires', (t) => {
  const f = fixture(t),
    player = invited(f);
  f.advance(25 * 60 * 60_000);
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
  assert.equal(f.identity.bootstrap(player.token).issuedToken, null);
  assert.equal(f.identity.isInvitedSession(player.token), true);
  // Far beyond any old deadline: nothing but the administrator ends it.
  f.advance(500 * DAY);
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
  const guest = f.identity.bootstrap();
  assert.equal(f.identity.isInvitedSession(guest.issuedToken!), false);
  f.advance(25 * 60 * 60_000);
  assert.throws(() => f.identity.authenticate(guest.issuedToken!), /SESSION_EXPIRED/);
  assert.equal(f.identity.expiredGuest(guest.issuedToken!), true);
  // A read-only classification: the invited cookie is never a discardable expired guest.
  assert.equal(f.identity.expiredGuest(player.token), false);
});

test('an already-expired invited session revives while its grant is active, and not after revocation', (t) => {
  const f = fixture(t),
    player = invited(f);
  f.store.run('UPDATE web_sessions SET absolute_expires_at=? WHERE revoked_at IS NULL', 1);
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
  f.invites.revokeGrant('admin', player.grantId);
  assert.throws(() => f.identity.authenticate(player.token), /SESSION_EXPIRED/);
});

test('recovery epoch and session revocation still end an invited session', (t) => {
  const f = fixture(t),
    player = invited(f);
  f.store.run("UPDATE web_instance SET recovery_epoch='other-epoch'");
  assert.throws(() => f.identity.authenticate(player.token), /SESSION_EXPIRED/);
  f.store.run("UPDATE web_instance SET recovery_epoch='synthetic-epoch'");
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
  f.store.run('UPDATE web_sessions SET revoked_at=1 WHERE token_digest=?', sessionDigest(player.token));
  assert.throws(() => f.identity.authenticate(player.token), /SESSION_EXPIRED/);
});

test('revoking the grant ends every session of the principal and disables its recovery code, atomically', (t) => {
  const f = fixture(t),
    player = invited(f),
    credential = f.identity.createInviteCredential(player.token, player.csrf, origin);
  // A second live session of the same principal (e.g. another device) must die as well.
  const other = 'S'.repeat(43);
  f.store.run(
    `INSERT INTO web_sessions SELECT 'extra-session',?,principal_id,account_id,recovery_epoch,security_revision,
    csrf_seed,created_at,last_active_at,absolute_expires_at,NULL FROM web_sessions WHERE token_digest=?`,
    sessionDigest(other),
    sessionDigest(player.token),
  );
  assert.equal(f.identity.authenticate(other).kind, 'invite');
  const revoked = f.invites.revokeGrant('admin', player.grantId);
  assert.equal(revoked.duplicate, false);
  for (const token of [player.token, other]) assert.throws(() => f.identity.authenticate(token), /SESSION_EXPIRED/);
  assert.equal(
    f.store.get<{ n: number }>(
      'SELECT count(*) n FROM web_sessions WHERE revoked_at IS NULL AND principal_id IN (SELECT principal_id FROM web_invite_grants)',
    )?.n,
    0,
  );
  assert.notEqual(
    f.store.get<{ revoked_at: number | null }>('SELECT revoked_at FROM web_invite_credentials')?.revoked_at,
    null,
  );
  assert.throws(
    () =>
      f.identity.recoverInviteCredential({
        origin,
        requestId: 'after-revoke',
        secret: credential.secret,
        ipHash: ip('a'),
      }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  assert.throws(() => f.identity.regenerateInviteCredential(player.token, player.csrf, origin), /SESSION_EXPIRED/);
  // Idempotent, and an unredeemed code revocation is the unchanged separate path.
  assert.equal(f.invites.revokeGrant('admin', player.grantId).duplicate, true);
});

test('revoking an unredeemed code leaves redeemed players untouched', (t) => {
  const f = fixture(t),
    player = invited(f),
    second = f.invites.issue({
      adminSessionId: 'admin',
      requestId: 'issue-2',
      redeemBy: null,
      accessDurationMs: null,
      batch: 'b',
      note: null,
    });
  f.invites.revokeCode('admin', second.inviteId);
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
});

test('redeem → code shown once → cookie lost → recover → same principal and history → old code dead → new code works', (t) => {
  const f = fixture(t),
    player = invited(f),
    before = f.identity.authenticate(player.token);
  const first = f.identity.regenerateInviteCredential(player.token, player.csrf, origin);
  assert.match(first.secret, /^[A-Za-z0-9_-]{43}$/);
  // "clear the cookie": a brand-new browser has no token, only the code.
  f.advance(3 * DAY);
  const restored = f.identity.recoverInviteCredential({
    origin,
    requestId: 'r1',
    secret: first.secret,
    ipHash: ip('b'),
  });
  assert.equal(restored.principalId, before.principalId);
  assert.equal(restored.duplicate, false);
  const after = f.identity.authenticate(restored.issuedToken);
  assert.deepEqual(
    [after.principalId, after.world_id, after.player_id],
    [before.principalId, before.world_id, before.player_id],
  );
  assert.throws(() => f.identity.authenticate(player.token), /SESSION_EXPIRED/);
  assert.notEqual(restored.recoverySecret, first.secret);
  // Each code works once: the used one gives the same neutral failure as a wrong one.
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'r2', secret: first.secret, ipHash: ip('b') }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'r3', secret: 'Z'.repeat(43), ipHash: ip('b') }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  const again = f.identity.recoverInviteCredential({
    origin,
    requestId: 'r4',
    secret: restored.recoverySecret,
    ipHash: ip('b'),
  });
  assert.equal(again.principalId, before.principalId);
  assert.equal(f.identity.authenticate(again.issuedToken).kind, 'invite');
});

test('regenerate replaces the previous code at once, keeps sessions, and needs CSRF, origin and an active invited session', (t) => {
  const f = fixture(t),
    player = invited(f);
  const first = f.identity.regenerateInviteCredential(player.token, player.csrf, origin);
  const second = f.identity.regenerateInviteCredential(player.token, player.csrf, origin);
  assert.notEqual(first.secret, second.secret);
  assert.equal(f.identity.authenticate(player.token).kind, 'invite');
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'old', secret: first.secret, ipHash: ip('c') }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
  assert.throws(() => f.identity.regenerateInviteCredential(player.token, 'x'.repeat(43), origin), /CSRF_INVALID/);
  assert.throws(
    () => f.identity.regenerateInviteCredential(player.token, player.csrf, 'https://evil.example'),
    /ORIGIN_INVALID/,
  );
  assert.throws(() => f.identity.regenerateInviteCredential('T'.repeat(43), player.csrf, origin), /SESSION_EXPIRED/);
  // A guest has no grant to attach a credential to.
  const guest = f.identity.bootstrap();
  assert.throws(
    () => f.identity.regenerateInviteCredential(guest.issuedToken!, guest.csrf, origin),
    /WEB_INVITE_ACCESS_REQUIRED/,
  );
  const restored = f.identity.recoverInviteCredential({
    origin,
    requestId: 'new',
    secret: second.secret,
    ipHash: ip('c'),
  });
  assert.equal(f.identity.authenticate(restored.issuedToken).kind, 'invite');
});

test('wrong recovery codes stay throttled per trusted IP after the new flows, with the same neutral error', (t) => {
  const f = fixture(t),
    player = invited(f);
  f.identity.regenerateInviteCredential(player.token, player.csrf, origin);
  for (let i = 0; i < 20; i++)
    assert.throws(
      () => f.identity.recoverInviteCredential({ origin, requestId: `w${i}`, secret: 'Q'.repeat(43), ipHash: ip('d') }),
      /WEB_INVITE_RECOVERY_UNAVAILABLE/,
    );
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'w-last', secret: 'Q'.repeat(43), ipHash: ip('d') }),
    /WEB_IDENTITY_RATE_LIMITED/,
  );
  // Another IP is unaffected.
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'w-other', secret: 'Q'.repeat(43), ipHash: ip('e') }),
    /WEB_INVITE_RECOVERY_UNAVAILABLE/,
  );
});
