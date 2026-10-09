import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebInvites } from '../../../apps/server/invites/web-invites.ts';
import { WebInviteActions } from '../../../apps/server/invites/web-invite-actions.ts';
import type { WebStore, Store } from '../../../apps/server/platform/store.ts';

const sourceRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const origin = 'https://synthetic.local',
  sameIp = 'a'.repeat(64);

class MemoryStore {
  readonly db = new DatabaseSync(':memory:');
  readonly instanceId = 'c-invite-instance';
  private depth = 0;
  constructor() {
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE web_instance(singleton INTEGER PRIMARY KEY,recovery_epoch TEXT NOT NULL);
      INSERT INTO web_instance VALUES (1,'c-invite-epoch');
      CREATE TABLE api_players(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
      CREATE TABLE worlds(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,timezone TEXT NOT NULL,
        config_json TEXT NOT NULL);
      CREATE TABLE web_principals(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,world_id TEXT NOT NULL,
        kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE web_sessions(id TEXT PRIMARY KEY,token_digest TEXT NOT NULL UNIQUE,
        principal_id TEXT NOT NULL,account_id TEXT,recovery_epoch TEXT NOT NULL,
        security_revision INTEGER NOT NULL,csrf_seed BLOB NOT NULL,created_at INTEGER NOT NULL,
        last_active_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,revoked_at INTEGER);
      CREATE TABLE web_guest_retention(principal_id TEXT PRIMARY KEY,world_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'unstarted',revision INTEGER NOT NULL DEFAULT 1,
        started_at INTEGER,expires_at INTEGER);
      CREATE TABLE admin_sessions(id TEXT PRIMARY KEY,secret_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,revoked_at INTEGER);
      PRAGMA user_version=112;`);
    for (const name of ['111_invite_core.sql', '112_invite_identity.sql'])
      this.db.exec(readFileSync(join(sourceRoot, 'apps/server/web-migrations', name), 'utf8'));
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(work: () => T): T {
    const depth = this.depth++,
      savepoint = `c_nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec(depth ? `RELEASE ${savepoint}` : 'COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec(depth ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
      throw error;
    } finally {
      this.depth--;
    }
  }
  close() {
    this.db.close();
  }
}
const code = (expected: string) => (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
function fixture(t: { after(callback: () => void): void }) {
  const store = new MemoryStore();
  t.after(() => store.close());
  let now = 1_700_000_000_000,
    id = 0,
    random = 1;
  const clock = { now: () => now },
    nextId = () => `c-id-${++id}`;
  const bytes = (size: number) => Buffer.alloc(size, random++ % 255);
  const identity = new WebIdentity(store as unknown as WebStore, {
    origin,
    cookieName: '__Host-synthetic',
    clock,
    keys: { keyId: 'c-synthetic', sealKey: Buffer.alloc(32, 21), requestKey: Buffer.alloc(32, 22) },
    nextId,
    random: bytes,
  });
  const invites = new WebInvites(store as unknown as Store, {
    clock,
    codeKey: Buffer.alloc(32, 23),
    authorize: identity.authorizeInviteAction.bind(identity),
    identity,
    nextId,
    random: bytes,
  });
  const actions = new WebInviteActions(store as unknown as Store, clock, origin, invites, identity);
  const adminCookie = 'D'.repeat(43),
    adminCsrf = createHash('sha256').update(`bubble-admin-csrf:${adminCookie}`).digest('hex');
  store.run(
    'INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)',
    'c-admin',
    createHash('sha256').update(adminCookie).digest('hex'),
    now,
    now + 86_400_000,
  );
  const firstRaw = identity.bootstrap(),
    secondRaw = identity.bootstrap();
  assert.ok(firstRaw.issuedToken && secondRaw.issuedToken);
  const first = { ...firstRaw, issuedToken: firstRaw.issuedToken };
  const second = { ...secondRaw, issuedToken: secondRaw.issuedToken };
  const issue = (requestId: string) =>
    actions.issue(adminCookie, adminCsrf, origin, {
      requestId,
      redeemBy: now + 60_000,
      accessDurationMs: null,
      batch: 'c-synthetic',
      note: null,
    });
  const redeem = (guest: { issuedToken: string; csrf: string }, inviteCode: string, requestId: string) => {
    const result = actions.redeem(guest.issuedToken, guest.csrf, origin, sameIp, { code: inviteCode, requestId });
    assert.equal(result.duplicate, false);
    assert.ok(result.identity);
    return { ...result, identity: result.identity };
  };
  return {
    store,
    identity,
    invites,
    actions,
    first,
    second,
    issue,
    redeem,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('one code upgrades only its principal in place; same-IP second world stays separate', (t) => {
  const f = fixture(t),
    a = f.identity.authenticate(f.first.issuedToken),
    b = f.identity.authenticate(f.second.issuedToken);
  assert.notEqual(a.principalId, b.principalId);
  assert.notEqual(a.world_id, b.world_id);
  const issued = f.issue('c-issue-a');
  assert.match(issued.code!, /^[A-Za-z0-9_-]{43}$/);
  const rawCodeRow = JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_codes').all());
  assert.ok(!rawCodeRow.includes(issued.code!));
  const redeemed = f.redeem(f.first, issued.code!, 'c-redeem-a');
  assert.equal(redeemed.duplicate, false);
  assert.deepEqual(
    [redeemed.principalId, redeemed.playerId, redeemed.worldId],
    [a.principalId, a.player_id, a.world_id],
  );
  assert.equal(f.identity.authenticate(redeemed.identity!.issuedToken).kind, 'invite');
  const replay = f.actions.redeem(redeemed.identity!.issuedToken, redeemed.identity!.csrf, origin, sameIp, {
    code: issued.code!,
    requestId: 'c-redeem-a',
  });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.grantId, redeemed.grantId);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 1);
  assert.equal(f.identity.authenticate(f.second.issuedToken).kind, 'guest');
  assert.equal(
    f.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', a.principalId)?.state,
    'protected',
  );
  assert.equal(
    f.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', b.principalId)?.state,
    'unstarted',
  );
  assert.throws(() => f.redeem(f.second, issued.code!, 'c-steal-code'), code('WEB_INVITE_UNAVAILABLE'));
  assert.throws(() => f.identity.authenticate(issued.code!), code('SESSION_EXPIRED'));
  assert.throws(
    () => f.invites.inviteReceiptStatus(f.second.issuedToken, f.second.csrf, origin, 'c-redeem-a'),
    code('RECEIPT_UNAVAILABLE'),
  );
  const secondCode = f.issue('c-issue-b');
  const secondRedeemed = f.redeem(f.second, secondCode.code!, 'c-redeem-b');
  assert.deepEqual([secondRedeemed.principalId, secondRedeemed.worldId], [b.principalId, b.world_id]);
  assert.notEqual(secondRedeemed.grantId, redeemed.grantId);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 2);
});

test('receipt insert failure rolls back code use, identity rotation and retention upgrade together', (t) => {
  const f = fixture(t),
    issued = f.issue('c-issue-failure');
  f.store.db.exec(`CREATE TRIGGER c_receipt_abort BEFORE INSERT ON web_invite_identity_receipts
    BEGIN SELECT RAISE(ABORT,'c synthetic receipt abort'); END`);
  assert.throws(() => f.redeem(f.first, issued.code!, 'c-redeem-failure'), /c synthetic receipt abort/);
  assert.equal(
    f.store.get<{ redeemed_count: number }>('SELECT redeemed_count FROM web_invite_codes WHERE id=?', issued.inviteId)
      ?.redeemed_count,
    0,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_redemptions')?.n, 0);
  assert.equal(
    f.store.get<{ attempts: number }>(
      `SELECT attempts FROM web_invite_attempt_windows
    WHERE purpose='redeem' AND ip_hash=?`,
      sameIp,
    )?.attempts,
    1,
  );
  assert.equal(f.identity.authenticate(f.first.issuedToken).kind, 'guest');
  assert.equal(
    f.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', f.first.principalId)
      ?.state,
    'unstarted',
  );
});

test('rotated old cookie recovers only its sealed receipt with bounded requests and time', (t) => {
  const f = fixture(t),
    issued = f.issue('c-issue-receipt'),
    redeemed = f.redeem(f.first, issued.code!, 'c-redeem-receipt');
  assert.throws(() => f.identity.authenticate(f.first.issuedToken), code('SESSION_EXPIRED'));
  const next = redeemed.identity!;
  const challenge = f.actions.redemptionChallenge(f.first.issuedToken, origin);
  assert.throws(
    () =>
      f.actions.recoverRedemption(f.first.issuedToken, challenge.csrf, origin, {
        code: issued.code!,
        requestId: 'wrong-id',
      }),
    code('RECEIPT_UNAVAILABLE'),
  );
  assert.throws(
    () =>
      f.actions.recoverRedemption(f.first.issuedToken, challenge.csrf, origin, {
        code: 'A'.repeat(43),
        requestId: 'c-redeem-receipt',
      }),
    code('RECEIPT_UNAVAILABLE'),
  );
  assert.throws(
    () =>
      f.actions.recoverRedemption(f.second.issuedToken, f.second.csrf, origin, {
        code: issued.code!,
        requestId: 'c-redeem-receipt',
      }),
    code('RECEIPT_UNAVAILABLE'),
  );
  for (let i = 0; i < 3; i++) {
    const recovered = f.actions.recoverRedemption(f.first.issuedToken, challenge.csrf, origin, {
      code: issued.code!,
      requestId: 'c-redeem-receipt',
    });
    assert.equal(recovered.issuedToken, next.issuedToken);
    assert.deepEqual(recovered.receipt, next.receipt);
  }
  assert.throws(
    () =>
      f.actions.recoverRedemption(f.first.issuedToken, challenge.csrf, origin, {
        code: issued.code!,
        requestId: 'c-redeem-receipt',
      }),
    code('RECEIPT_UNAVAILABLE'),
  );
  assert.deepEqual(f.actions.redemptionStatus(next.issuedToken, next.csrf, origin, 'c-redeem-receipt'), next.receipt);
  assert.throws(
    () => f.actions.redemptionStatus(f.second.issuedToken, f.second.csrf, origin, 'c-redeem-receipt'),
    code('RECEIPT_UNAVAILABLE'),
  );
  const sealed = JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_identity_receipts').all());
  assert.ok(!sealed.includes(next.issuedToken) && !sealed.includes(issued.code!));
  f.invites.revokeGrant('c-admin', redeemed.grantId);
  assert.throws(() => f.actions.redemptionChallenge(f.first.issuedToken, origin), code('RECEIPT_UNAVAILABLE'));
  // The grant's sessions end with it, so the new cookie is rejected before any receipt is consulted.
  assert.throws(
    () => f.actions.redemptionStatus(next.issuedToken, next.csrf, origin, 'c-redeem-receipt'),
    code('SESSION_EXPIRED'),
  );

  const expiry = fixture(t),
    expCode = expiry.issue('c-issue-expiry'),
    expRedeem = expiry.redeem(expiry.first, expCode.code!, 'c-redeem-expiry');
  assert.ok(expRedeem.identity);
  expiry.advance(300_000);
  assert.throws(
    () => expiry.actions.redemptionChallenge(expiry.first.issuedToken, origin),
    code('RECEIPT_UNAVAILABLE'),
  );
});

test('separate recovery credential rotates secret and session; consumed code cannot log in', (t) => {
  const f = fixture(t),
    issued = f.issue('c-issue-credential'),
    redeemed = f.redeem(f.first, issued.code!, 'c-redeem-credential');
  const next = redeemed.identity!;
  const credential = f.actions.createRecoveryCredential(next.issuedToken, next.csrf, origin);
  assert.match(credential.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(credential.secret, issued.code);
  assert.ok(
    !JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_credentials').all()).includes(credential.secret),
  );
  assert.throws(
    () => f.actions.recoverInvite(origin, sameIp, { secret: issued.code!, requestId: 'c-code-as-proof' }),
    code('WEB_INVITE_RECOVERY_UNAVAILABLE'),
  );
  const restored = f.actions.recoverInvite(origin, sameIp, { secret: credential.secret, requestId: 'c-recover' });
  assert.equal(restored.duplicate, false);
  assert.equal(restored.principalId, redeemed.principalId);
  assert.notEqual(restored.recoverySecret, credential.secret);
  assert.throws(() => f.identity.authenticate(next.issuedToken), code('SESSION_EXPIRED'));
  assert.equal(f.identity.authenticate(restored.issuedToken).world_id, redeemed.worldId);
  const replay = f.actions.recoverInvite(origin, sameIp, { secret: credential.secret, requestId: 'c-recover' });
  assert.equal(replay.duplicate, true);
  assert.equal(replay.issuedToken, restored.issuedToken);
  assert.equal(replay.recoverySecret, restored.recoverySecret);
  assert.throws(
    () => f.actions.recoverInvite(origin, sameIp, { secret: credential.secret, requestId: 'different-request' }),
    code('WEB_INVITE_RECOVERY_UNAVAILABLE'),
  );
});
