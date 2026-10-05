import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Store } from '../../../apps/server/store.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { WebInvites } from '../../../apps/server/web-invites.ts';
import { requireWebContent, webDataLifecycleEnabled } from '../../../apps/server/web-retention.ts';
import type { WebStore } from '../../../apps/server/store.ts';

function fixture(t: import('node:test').TestContext) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  store.db.exec(`
    CREATE TABLE web_instance(singleton INTEGER PRIMARY KEY, recovery_epoch TEXT NOT NULL);
    INSERT INTO web_instance VALUES (1,'synthetic-epoch');
    CREATE TABLE web_principals(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,world_id TEXT NOT NULL,
      kind TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE web_sessions(id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,account_id TEXT,
      recovery_epoch TEXT NOT NULL,absolute_expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE web_guest_retention(principal_id TEXT PRIMARY KEY,world_id TEXT NOT NULL,
      state TEXT NOT NULL,revision INTEGER NOT NULL,expires_at INTEGER);
  `);
  store.db.exec(readFileSync(new URL('../../../apps/server/web-migrations/111_invite_core.sql',
    import.meta.url), 'utf8'));
  let now = 1_700_000_000_000, ids = 0, codes = 0;
  store.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', 'admin-live', 'synthetic-hash',
    now, now + 10_000);
  const guest = (name: string) => {
    const playerId = `player-${name}`, worldId = `world-${name}`,
      principalId = `principal-${name}`, sessionId = `session-${name}`;
    store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
    store.run("INSERT INTO web_principals VALUES (?,?,?,'guest',1)", principalId, playerId, worldId);
    store.run("INSERT INTO web_sessions VALUES (?,?,NULL,'synthetic-epoch',?,NULL)",
      sessionId, principalId, now + 10_000);
    store.run("INSERT INTO web_guest_retention VALUES (?,?,'active',1,?)",
      principalId, worldId, now + 2000);
    return { principalId, playerId, worldId, sessionId, token: `token-${name}` };
  };
  const actors = new Map<string, ReturnType<typeof guest>>();
  const authorize = (token: string, csrf: string, origin: string) => {
    assert.equal(csrf, 'synthetic-csrf'); assert.equal(origin, 'https://synthetic.local');
    const actor = actors.get(token);
    if (!actor) throw new Error('SESSION_EXPIRED');
    const kind = store.get<{ kind: 'guest' | 'invite' }>(
      'SELECT kind FROM web_principals WHERE id=?', actor.principalId)!.kind;
    return { ...actor, kind };
  };
  const invites = new WebInvites(store, { clock: { now: () => now }, codeKey: Buffer.alloc(32, 0x7a),
    authorize, nextId: () => `invite-id-${++ids}`, random: size => Buffer.alloc(size, ++codes) });
  const makeGuest = (name: string) => {
    const actor = guest(name); actors.set(actor.token, actor); return actor;
  };
  const terms = (requestId: string) => ({ adminSessionId: 'admin-live', requestId,
    redeemBy: now + 1000, accessDurationMs: 5000, batch: 'manual-batch', note: null });
  const redeem = (actor: ReturnType<typeof guest>, code: string, requestId: string) =>
    invites.redeem({ token: actor.token, csrf: 'synthetic-csrf',
      origin: 'https://synthetic.local', code, requestId });
  return { store, invites, makeGuest, terms, redeem,
    advance: (ms: number) => { now += ms; }, now: () => now };
}

test('manual one-use issuance requires explicit terms and live administrator, stores only digest', t => {
  const f = fixture(t);
  assert.throws(() => f.invites.issue({ ...f.terms('missing'), accessDurationMs: undefined } as never),
    /WEB_INVITE_TERMS_REQUIRED/);
  assert.throws(() => f.invites.issue({ ...f.terms('bad-admin'), adminSessionId: 'other' }),
    /ADMIN_UNAUTHORIZED/);
  const issued = f.invites.issue(f.terms('issue-once'));
  assert.match(issued.code!, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(f.invites.issue(f.terms('issue-once')),
    { inviteId: issued.inviteId, code: null, duplicate: true });
  assert.throws(() => f.invites.issue({ ...f.terms('issue-once'), batch: 'changed' }),
    /IDEMPOTENCY_CONFLICT/);
  const row = f.store.get<{ code_digest: string; capacity: number; redeemed_count: number }>(
    'SELECT code_digest,capacity,redeemed_count FROM web_invite_codes WHERE id=?', issued.inviteId)!;
  assert.equal(row.capacity, 1); assert.equal(row.redeemed_count, 0);
  assert.notEqual(row.code_digest, issued.code);
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM web_invite_codes').all()).includes(issued.code!),
    false, 'original code is never stored');
});

test('one code upgrades original guest exactly once; replay, scope, expiry and revocations stay distinct', t => {
  const f = fixture(t), first = f.makeGuest('first'), other = f.makeGuest('other');
  const issued = f.invites.issue(f.terms('issue'));
  const result = f.redeem(first, issued.code!, 'redeem-once');
  assert.equal(result.duplicate, false);
  assert.equal(result.principalId, first.principalId);
  assert.equal(result.playerId, first.playerId);
  assert.equal(result.worldId, first.worldId);
  assert.equal(result.expiresAt, f.now() + 5000);
  assert.equal(f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?',
    first.principalId)?.kind, 'invite');
  assert.equal(f.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?',
    first.principalId)?.state, 'protected');
  assert.deepEqual(f.redeem(first, issued.code!, 'redeem-once'), { ...result, duplicate: true });
  assert.throws(() => f.redeem(first, 'A'.repeat(43), 'redeem-once'), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.redeem(other, issued.code!, 'other-request'), /WEB_INVITE_UNAVAILABLE/);
  assert.equal(f.store.get<{ redeemed_count: number }>(
    'SELECT redeemed_count FROM web_invite_codes WHERE id=?', issued.inviteId)?.redeemed_count, 1);
  assert.equal(f.store.get<{ kind: string }>(
    'SELECT kind FROM web_principals WHERE id=?', other.principalId)?.kind, 'guest');
  f.invites.revokeCode('admin-live', issued.inviteId);
  assert.deepEqual(f.redeem(first, issued.code!, 'redeem-once'), { ...result, duplicate: true },
    'revoking the code does not rewrite its previous receipt');
  assert.equal(f.store.get<{ revoked_at: number | null }>(
    'SELECT revoked_at FROM web_invite_grants WHERE id=?', result.grantId)?.revoked_at, null);
  f.invites.revokeGrant('admin-live', result.grantId);
  assert.equal(f.store.get<{ revoked_at: number | null }>(
    'SELECT revoked_at FROM web_invite_grants WHERE id=?', result.grantId)?.revoked_at, f.now());
});

test('wrong code, expired code, expired trial, stale scope and failed grant write leave no half upgrade', t => {
  const f = fixture(t), first = f.makeGuest('first');
  const issued = f.invites.issue(f.terms('issue'));
  assert.throws(() => f.redeem(first, 'B'.repeat(43), 'wrong'), /WEB_INVITE_UNAVAILABLE/);
  f.advance(1000);
  assert.throws(() => f.redeem(first, issued.code!, 'at-deadline'), /WEB_INVITE_UNAVAILABLE/);
  const valid = f.invites.issue({ ...f.terms('new'), redeemBy: null, accessDurationMs: null });
  f.advance(1001);
  assert.throws(() => f.redeem(first, valid.code!, 'trial-expired'), /TRIAL_EXPIRED/);
  assert.equal(f.store.get<{ kind: string }>(
    'SELECT kind FROM web_principals WHERE id=?', first.principalId)?.kind, 'guest');
  assert.equal(f.store.get<{ redeemed_count: number }>(
    'SELECT redeemed_count FROM web_invite_codes WHERE id=?', valid.inviteId)?.redeemed_count, 0);
  f.store.run("UPDATE web_guest_retention SET expires_at=? WHERE principal_id=?", f.now() + 1000,
    first.principalId);
  f.store.run("UPDATE web_principals SET world_id='wrong-world' WHERE id=?", first.principalId);
  assert.throws(() => f.redeem(first, valid.code!, 'scope'), /WEB_INVITE_SCOPE_INVALID/);
  f.store.run('UPDATE web_principals SET world_id=? WHERE id=?', first.worldId, first.principalId);
  f.store.db.exec(`CREATE TRIGGER synthetic_grant_failure BEFORE INSERT ON web_invite_grants
    BEGIN SELECT RAISE(ABORT,'synthetic grant failure'); END`);
  assert.throws(() => f.redeem(first, valid.code!, 'fault'), /synthetic grant failure/);
  assert.equal(f.store.get<{ redeemed_count: number }>(
    'SELECT redeemed_count FROM web_invite_codes WHERE id=?', valid.inviteId)?.redeemed_count, 0);
  assert.equal(f.store.get<{ kind: string }>(
    'SELECT kind FROM web_principals WHERE id=?', first.principalId)?.kind, 'guest');
  assert.equal(f.store.get('SELECT 1 FROM web_invite_redemptions WHERE principal_id=?', first.principalId),
    undefined);
});

test('two scheduled contenders for a single-use code yield one grant and one unchanged guest', async t => {
  const f = fixture(t), first = f.makeGuest('first'), other = f.makeGuest('other');
  const issued = f.invites.issue(f.terms('single'));
  const attempts = await Promise.allSettled([first, other].map((actor, index) =>
    new Promise<ReturnType<typeof f.redeem>>((resolve, reject) => setImmediate(() => {
      try { resolve(f.redeem(actor, issued.code!, `race-${index}`)); }
      catch (error) { reject(error); }
    }))));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_redemptions')?.n, 1);
  assert.equal(f.store.get<{ redeemed_count: number }>(
    'SELECT redeemed_count FROM web_invite_codes WHERE id=?', issued.inviteId)?.redeemed_count, 1);
  assert.equal(f.store.get<{ n: number }>(
    "SELECT count(*) n FROM web_principals WHERE kind='guest'")?.n, 1);
});

test('unredeemed code revocation is idempotent and does not issue a grant', t => {
  const f = fixture(t), actor = f.makeGuest('first');
  const issued = f.invites.issue({ ...f.terms('revoke'), redeemBy: null,
    accessDurationMs: null });
  assert.deepEqual(f.invites.revokeCode('admin-live', issued.inviteId),
    { inviteId: issued.inviteId, duplicate: false });
  assert.deepEqual(f.invites.revokeCode('admin-live', issued.inviteId),
    { inviteId: issued.inviteId, duplicate: true });
  assert.throws(() => f.redeem(actor, issued.code!, 'after-revoke'), /WEB_INVITE_UNAVAILABLE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')?.n, 0);
  assert.equal(f.store.get<{ state: string }>(
    'SELECT state FROM web_guest_retention WHERE principal_id=?', actor.principalId)?.state, 'active');
});

test('schema111 private-content predicate requires an active matching grant, not protected retention alone', t => {
  const f = fixture(t), actor = f.makeGuest('first'), other = f.makeGuest('other');
  f.store.db.exec('PRAGMA user_version=111');
  const store = f.store as unknown as WebStore, clock = { now: f.now };
  assert.equal(webDataLifecycleEnabled(store), true);
  const issued = f.invites.issue({ ...f.terms('entitlement'), redeemBy: null,
    accessDurationMs: 1000 });
  const grant = f.redeem(actor, issued.code!, 'redeem');
  assert.equal(requireWebContent(store, clock, actor.principalId, actor.worldId)?.state, 'protected');
  f.store.run('UPDATE web_invite_grants SET player_id=? WHERE id=?', other.playerId, grant.grantId);
  assert.throws(() => requireWebContent(store, clock, actor.principalId, actor.worldId),
    /WEB_INVITE_ACCESS_REQUIRED/);
  f.store.run('UPDATE web_invite_grants SET player_id=? WHERE id=?', actor.playerId, grant.grantId);
  f.advance(1000);
  assert.throws(() => requireWebContent(store, clock, actor.principalId, actor.worldId),
    /WEB_INVITE_ACCESS_REQUIRED/);
  assert.equal(f.store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?',
    actor.principalId)?.state, 'protected', 'expiry does not erase the original world');
  const second = f.invites.issue({ ...f.terms('revocation'), redeemBy: null,
    accessDurationMs: null });
  const otherGrant = f.redeem(other, second.code!, 'other-redeem');
  assert.equal(requireWebContent(store, clock, other.principalId, other.worldId)?.state, 'protected');
  f.invites.revokeGrant('admin-live', otherGrant.grantId);
  assert.throws(() => requireWebContent(store, clock, other.principalId, other.worldId),
    /WEB_INVITE_ACCESS_REQUIRED/);
  f.store.db.exec('PRAGMA user_version=113');
  assert.throws(() => requireWebContent(store, clock, actor.principalId, actor.worldId),
    /WEB_SCHEMA_UNSUPPORTED/);
});


test('granular invite actions, metadata-only paginated list and scope checks use current durable membership', t => {
  const f=fixture(t),origin='https://admin.fixture.invalid',admin=new WebAccountAdmin(f.store,{now:f.now},origin);
  const owner=admin.login(admin.issueLoginGrant().token,origin),auth=[owner.cookie,owner.csrf,origin] as const;
  const adminSessionId=admin.authorize(...auth).sessionId;
  const issue=(id:string)=>f.invites.issue({...f.terms(id),adminSessionId});
  const codes=Array.from({length:55},(_,i)=>issue('page-'+i));
  const first=admin.inviteRecords(...auth,null);assert.equal(first.records.length,50);assert.ok(first.next);
  const second=admin.inviteRecords(...auth,first.next);assert.equal(second.records.length,5);assert.equal(second.next,null);
  assert.equal(new Set([...first.records,...second.records].map(r=>r.inviteId)).size,55);
  assert.throws(()=>admin.inviteRecords(...auth,'missing'),/INVALID_CURSOR/);
  const grant=admin.issueMember(...auth,{requestId:'reader',label:'Reader',memberId:null,permissions:['invites.read','invites.revoke-code']});
  const member=admin.login(grant.token,origin),memberAuth=[member.cookie,member.csrf,origin] as const;
  const memberId=admin.authorize(...memberAuth).sessionId;
  assert.equal(admin.inviteRecords(...memberAuth,null).records.length,50);
  const player=f.makeGuest('record'),redeemed=f.redeem(player,codes[0]!.code!,'redeem-record');
  f.invites.revokeCode(memberId,codes[1]!.inviteId);
  assert.throws(()=>f.invites.revokeGrant(memberId,redeemed.grantId),/ADMIN_PERMISSION_REQUIRED/);
  admin.setPermissions(...auth,member.member.id,['invites.read','invites.revoke-access']);
  assert.throws(()=>f.invites.revokeCode(memberId,codes[2]!.inviteId),/ADMIN_PERMISSION_REQUIRED/);
  f.invites.revokeGrant(memberId,redeemed.grantId);
  const rows=[...admin.inviteRecords(...auth,null).records,...admin.inviteRecords(...auth,first.next).records];
  const record=rows.find(r=>r.inviteId===codes[0]!.inviteId)!;
  assert.equal(record.grantId,redeemed.grantId);assert.equal(record.accessRevokedAt,f.now());assert.equal(record.accessExpiresAt,f.now()+5000);
  const encoded=JSON.stringify(rows);assert.ok(codes.every(c=>!encoded.includes(c.code!)));
  assert.ok(!encoded.includes(player.playerId));assert.ok(!encoded.includes(player.worldId));assert.ok(!encoded.includes('digest'));
  admin.setPermissions(...auth,member.member.id,[]);
  assert.throws(()=>admin.inviteRecords(...memberAuth,null),/ADMIN_PERMISSION_REQUIRED/);assert.equal(admin.session(member.cookie).member.id,member.member.id);
});
