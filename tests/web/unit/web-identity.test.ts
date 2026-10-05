import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

const origin = 'https://web.example.test';
const input = { requestId: 'register-1', username: 'Example_User', password: 'synthetic-password-only' };
const characterId = 'fixture-character';

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-identity-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const instanceId = randomUUID(), root = join(parent, 'instance');
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages(); store.migrateAdmissionOrder(); store.migrateIdentity(randomUUID());
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const keys = { keyId: 'synthetic-only', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) };
  const identity = new WebIdentity(store, { origin, cookieName: '__Host-build_session', keys, clock });
  return { store, identity, clock, keys, root, instanceId, advance: (ms: number) => { now += ms; } };
}

test('schema103 is explicit and keeps admission tickets, quota windows and queue usable', async t => {
  const { store, identity, clock } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  const principal = identity.authenticate(token);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", principal.world_id, characterId);
  const admission = new WebAdmission(store, clock, randomUUID);
  const result = admission.admit({ principalId: guest.principalId, requestId: 'test', characterId, text: '合成输入', ipHash: 'a'.repeat(64) });
  assert.equal(store.get<{ admission_seq: number }>('SELECT admission_seq FROM web_operations WHERE id=?', result.operationId)?.admission_seq, 1);
  const before = store.get<{ world_id: string; conversation_id: string; input_message_id: string;
    ip_window_id: string; admission_seq: number; deadline_at: number }>(`SELECT world_id,conversation_id,input_message_id,
      ip_window_id,admission_seq,deadline_at FROM web_operations WHERE id=?`, result.operationId)!;
  await identity.register(token, guest.csrf, origin, input);
  assert.deepEqual({ ...store.get<typeof before>(`SELECT world_id,conversation_id,input_message_id,
    ip_window_id,admission_seq,deadline_at FROM web_operations WHERE id=?`, result.operationId) }, { ...before });
  const queue = new WebStageQueue(store, clock, randomUUID), coordinator = queue.acquireCoordinator('coordinator');
  assert.equal(queue.claimText(coordinator, 'worker')?.operationId, result.operationId);
  assert.throws(() => identity.bootstrap(token), /SESSION_ROTATED_RECOVERABLE/);
});

test('identity migration is explicit, reopens without changing epoch and rolls back on schema conflict', t => {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-identity-migration-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'good'), id = randomUUID(), epoch = randomUUID();
  const first = new WebStore(root, { create: true, instanceId: id });
  first.migrateStages(); first.migrateAdmissionOrder(); first.close();
  const second = new WebStore(root, { create: false, instanceId: id });
  assert.equal(second.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  second.migrateIdentity(epoch);
  assert.throws(() => second.migrateIdentity(randomUUID()), /WEB_IDENTITY_MIGRATION_REQUIRED/);
  second.close();
  const reopened = new WebStore(root, { create: false, instanceId: id });
  assert.equal(reopened.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance')?.recovery_epoch, epoch);
  reopened.close();
  const bad = new WebStore(join(parent, 'bad'), { create: true, instanceId: randomUUID() });
  t.after(() => bad.close());
  bad.migrateStages(); bad.migrateAdmissionOrder();
  bad.db.exec('CREATE TABLE web_accounts(x INTEGER)');
  assert.throws(() => bad.migrateIdentity(randomUUID()));
  assert.equal(bad.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  assert.equal(bad.get<{ name: string }>("SELECT name FROM pragma_table_info('web_instance') WHERE name='recovery_epoch'"), undefined);
});

test('new registration upgrades in place, revokes old ordinary auth and recovers one committed receipt both ways', async t => {
  const { store, identity } = fixture(t);
  const guest = identity.bootstrap(), oldToken = guest.issuedToken!;
  const before = identity.authenticate(oldToken);
  assert.deepEqual(identity.bootstrap(oldToken), { principalId: guest.principalId, csrf: guest.csrf, issuedToken: null });
  assert.throws(() => identity.bootstrap(oldToken + 'x'), /SESSION_EXPIRED/);
  await assert.rejects(identity.register(oldToken, guest.csrf, 'https://evil.test', input), /ORIGIN_INVALID/);
  await assert.rejects(identity.register(oldToken, 'wrong', origin, input), /CSRF_INVALID/);
  const registered = await identity.register(oldToken, guest.csrf, origin, input);
  assert.equal(registered.receipt.principalId, guest.principalId);
  assert.equal(identity.authenticate(registered.issuedToken).world_id, before.world_id);
  assert.equal(identity.authenticate(registered.issuedToken).player_id, before.player_id);
  assert.equal(identity.authenticate(registered.issuedToken).kind, 'account');
  assert.throws(() => identity.authenticate(oldToken), /SESSION_EXPIRED/);
  assert.throws(() => identity.bootstrap(oldToken), /SESSION_ROTATED_RECOVERABLE/);
  const recoveryCsrf = identity.receiptChallenge(oldToken).csrf;
  for (let i = 0; i < 3; i++) {
    const replay = await identity.recoverReceipt(oldToken, recoveryCsrf, origin, input);
    assert.equal(replay.issuedToken, registered.issuedToken);
    assert.deepEqual(replay.receipt, registered.receipt);
  }
  await assert.rejects(identity.recoverReceipt(oldToken, recoveryCsrf, origin, input), /RECEIPT_UNAVAILABLE/);
  assert.throws(() => identity.bootstrap(oldToken), /SESSION_EXPIRED/);
  assert.deepEqual(identity.receiptStatus(registered.issuedToken, registered.csrf, origin, input.requestId), registered.receipt);
  assert.equal(store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', guest.principalId)?.kind, 'account');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_identity_receipts')?.n, 1);
  const raw = store.get<{ public_receipt: string }>('SELECT public_receipt FROM web_identity_receipts')!;
  assert.ok(!raw.public_receipt.includes(input.password) && !raw.public_receipt.includes(registered.issuedToken));
});

test('invite write authorization binds the active guest session, CSRF and Origin', t => {
  const { store, identity } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  const original = identity.authenticate(token);
  const actor = identity.authorizeInviteAction(token, guest.csrf, origin);
  assert.equal(actor.principalId, guest.principalId);
  assert.equal(actor.playerId, original.player_id);
  assert.equal(actor.worldId, original.world_id);
  assert.equal(actor.kind, 'guest');
  assert.equal(store.get<{ principal_id: string }>(
    'SELECT principal_id FROM web_sessions WHERE id=?', actor.sessionId)?.principal_id, guest.principalId);
  assert.throws(() => identity.authorizeInviteAction(token, 'wrong', origin), /CSRF_INVALID/);
  assert.throws(() => identity.authorizeInviteAction(token, guest.csrf, 'https://evil.test'), /ORIGIN_INVALID/);
  store.run("UPDATE web_principals SET kind='invite' WHERE id=?", guest.principalId);
  assert.equal(identity.authorizeInviteAction(token, guest.csrf, origin).kind, 'invite');
  store.run('UPDATE web_sessions SET revoked_at=? WHERE id=?', 1_700_000_000_000, actor.sessionId);
  assert.throws(() => identity.authorizeInviteAction(token, guest.csrf, origin), /SESSION_EXPIRED/);
});

test('wrong secret, tampered AEAD, changed security revision, logout and epoch cannot reissue identity', async t => {
  const { store, identity, keys } = fixture(t);
  const guest = identity.bootstrap(), oldToken = guest.issuedToken!;
  const registered = await identity.register(oldToken, guest.csrf, origin, input);
  const challenge = identity.receiptChallenge(oldToken).csrf;
  await assert.rejects(identity.recoverReceipt(oldToken, challenge, origin, { ...input, password: 'different-password' }), /RECEIPT_UNAVAILABLE/);
  assert.equal(store.get<{ successful_retrievals: number }>('SELECT successful_retrievals FROM web_identity_receipts')?.successful_retrievals, 0);
  const wrongKey = new WebIdentity(store, { origin, cookieName: '__Host-build_session', clock: { now: () => 1_700_000_000_000 },
    keys: { ...keys, sealKey: Buffer.alloc(32, 3) } });
  await assert.rejects(wrongKey.recoverReceipt(oldToken, challenge, origin, input), /RECEIPT_UNAVAILABLE/);
  store.run('UPDATE web_accounts SET security_revision=security_revision+1');
  await assert.rejects(identity.recoverReceipt(oldToken, challenge, origin, input), /RECEIPT_UNAVAILABLE/);
  assert.throws(() => identity.authenticate(registered.issuedToken), /SESSION_EXPIRED/);
});

test('bad recovery proof is separately throttled without consuming successful retrievals', async t => {
  const { store, identity, advance } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  await identity.register(token, guest.csrf, origin, input);
  const csrf = identity.receiptChallenge(token).csrf;
  for (let i = 0; i < 5; i++) {
    await assert.rejects(identity.recoverReceipt(token, csrf, origin,
      { ...input, password: 'different-password' }), /RECEIPT_UNAVAILABLE/);
  }
  await assert.rejects(identity.recoverReceipt(token, csrf, origin, input), /WEB_IDENTITY_RATE_LIMITED/);
  assert.equal(store.get<{ successful_retrievals: number }>('SELECT successful_retrievals FROM web_identity_receipts')?.successful_retrievals, 0);
  advance(30_000);
  assert.equal((await identity.recoverReceipt(token, csrf, origin, input)).receipt.accountId,
    store.get<{ id: string }>('SELECT id FROM web_accounts')?.id);
});

test('concurrent wrong receipt proofs reserve five DB slots across connections before KDF', async t => {
  const { store, identity, root, instanceId, clock, keys, advance } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  const account = await identity.register(token, guest.csrf, origin, input);
  const csrf = identity.receiptChallenge(token).csrf;
  const secondStore = new WebStore(root, { create: false, instanceId });
  t.after(() => secondStore.close());
  const other = new WebIdentity(secondStore, { origin, cookieName: '__Host-build_session', clock, keys });
  const outcomes = await Promise.allSettled(Array.from({ length: 10 }, (_, i) =>
    (i % 2 ? other : identity).recoverReceipt(token, csrf, origin,
      { ...input, password: 'wrong-synthetic-secret' })));
  assert.equal(outcomes.filter(item => item.status === 'rejected' && /RECEIPT_UNAVAILABLE/.test(String(item.reason))).length, 5);
  assert.equal(outcomes.filter(item => item.status === 'rejected' && /WEB_IDENTITY_RATE_LIMITED/.test(String(item.reason))).length, 5);
  assert.deepEqual({ ...store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts') },
  { failed_attempts: 5, successful_retrievals: 0 });
  advance(30_000);
  assert.equal((await other.recoverReceipt(token, csrf, origin, input)).issuedToken, account.issuedToken);
  assert.deepEqual({ ...store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts') },
  { failed_attempts: 0, successful_retrievals: 1 });
});

test('logout during valid receipt KDF cannot reissue token and releases its reserved validation slot', async t => {
  const { store, identity } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  const account = await identity.register(token, guest.csrf, origin, input);
  const csrf = identity.receiptChallenge(token).csrf;
  const pending = identity.recoverReceipt(token, csrf, origin, input);
  const rejected = assert.rejects(pending, /RECEIPT_UNAVAILABLE/);
  identity.logout(account.issuedToken, account.csrf, origin);
  await rejected;
  assert.deepEqual({ ...store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts') },
  { failed_attempts: 0, successful_retrievals: 0 });
});

test('a slow valid proof releases only its original window, not a new window failure', async t => {
  const { store, identity, advance } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  await identity.register(token, guest.csrf, origin, input);
  const csrf = identity.receiptChallenge(token).csrf;
  const valid = identity.recoverReceipt(token, csrf, origin, input);
  advance(30_000);
  const invalid = assert.rejects(identity.recoverReceipt(token, csrf, origin,
    { ...input, password: 'wrong-synthetic-secret' }), /RECEIPT_UNAVAILABLE/);
  await valid;
  await invalid;
  assert.deepEqual({ ...store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts') },
  { failed_attempts: 1, successful_retrievals: 1 });
});

test('web recovery epoch change invalidates active sessions and old receipt recovery', async t => {
  const { store, identity } = fixture(t);
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  const registered = await identity.register(token, guest.csrf, origin, input);
  const csrf = identity.receiptChallenge(token).csrf;
  store.run('UPDATE web_instance SET recovery_epoch=?', randomUUID());
  assert.throws(() => identity.authenticate(registered.issuedToken), /SESSION_EXPIRED/);
  assert.throws(() => identity.receiptChallenge(token), /RECEIPT_UNAVAILABLE/);
  await assert.rejects(identity.recoverReceipt(token, csrf, origin, input), /RECEIPT_UNAVAILABLE/);
});

test('restart with same instance and keys preserves committed account session and receipt scope', async t => {
  const { store, identity, root, instanceId, clock, keys } = fixture(t);
  const guest = identity.bootstrap(), account = await identity.register(guest.issuedToken!, guest.csrf, origin, input);
  const reopened = new WebStore(root, { create: false, instanceId });
  t.after(() => reopened.close());
  const another = new WebIdentity(reopened, { origin, cookieName: '__Host-build_session', clock, keys });
  assert.equal(another.authenticate(account.issuedToken).principalId, guest.principalId);
  assert.deepEqual(another.receiptStatus(account.issuedToken, account.csrf, origin, input.requestId), account.receipt);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
});

test('logout and receipt deadline block replay; no guest idle expiry before 24h', async t => {
  const { identity, advance } = fixture(t);
  const guest = identity.bootstrap(), oldToken = guest.issuedToken!;
  advance(31 * 60_000);
  assert.equal(identity.authenticate(oldToken).principalId, guest.principalId);
  const registered = await identity.register(oldToken, guest.csrf, origin, input);
  const challenge = identity.receiptChallenge(oldToken).csrf;
  identity.logout(registered.issuedToken, registered.csrf, origin);
  await assert.rejects(identity.recoverReceipt(oldToken, challenge, origin, input), /RECEIPT_UNAVAILABLE/);
  assert.throws(() => identity.authenticate(registered.issuedToken), /SESSION_EXPIRED/);
  assert.throws(() => identity.receiptStatus(registered.issuedToken, registered.csrf, origin, input.requestId), /SESSION_EXPIRED/);
});

test('guest absolute and account idle expiry are distinct, while explicit bootstrap renews account idle', async t => {
  const { identity, advance } = fixture(t);
  const guest = identity.bootstrap(), guestToken = guest.issuedToken!;
  advance(24 * 60 * 60_000);
  assert.throws(() => identity.authenticate(guestToken), /SESSION_EXPIRED/);
  const another = identity.bootstrap(), account = await identity.register(another.issuedToken!, another.csrf, origin,
    { ...input, requestId: 'later-registration', username: 'later_user' });
  advance(20 * 60_000);
  assert.equal(identity.bootstrap(account.issuedToken).csrf, account.csrf);
  advance(20 * 60_000);
  assert.equal(identity.authenticate(account.issuedToken).kind, 'account');
  advance(10 * 60_000);
  assert.throws(() => identity.authenticate(account.issuedToken), /SESSION_EXPIRED/);
});

test('identity transaction failure rolls back account, principal upgrade and revocation', async t => {
  const { store, clock, keys } = fixture(t);
  let calls = 0;
  const identity = new WebIdentity(store, { origin, cookieName: '__Host-build_session', clock, keys,
    random: size => { if (++calls === 6) throw new Error('synthetic seal nonce failure'); return Buffer.alloc(size, calls); } });
  const guest = identity.bootstrap(), token = guest.issuedToken!;
  await assert.rejects(identity.register(token, guest.csrf, origin, input), /synthetic seal nonce failure/);
  assert.equal(store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', guest.principalId)?.kind, 'guest');
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 0);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_identity_receipts')?.n, 0);
  assert.equal(identity.authenticate(token).principalId, guest.principalId);
});

test('receipt boundary expires at 300 seconds; another account cannot read its receipt', async t => {
  const { identity, advance } = fixture(t);
  const first = identity.bootstrap(), second = identity.bootstrap();
  const account = await identity.register(first.issuedToken!, first.csrf, origin, input);
  assert.throws(() => identity.receiptStatus(second.issuedToken!, second.csrf, origin, input.requestId), /RECEIPT_UNAVAILABLE/);
  const challenge = identity.receiptChallenge(first.issuedToken!).csrf;
  advance(300_000);
  await assert.rejects(identity.recoverReceipt(first.issuedToken!, challenge, origin, input), /RECEIPT_UNAVAILABLE/);
  assert.deepEqual(identity.receiptStatus(account.issuedToken, account.csrf, origin, input.requestId), account.receipt);
});

test('native Argon2 scheduler admits two active plus eight waiting registrations, not an unbounded queue', async t => {
  const { identity, store } = fixture(t);
  const work = Array.from({ length: 11 }, (_, i) => {
    const guest = identity.bootstrap();
    return identity.register(guest.issuedToken!, guest.csrf, origin,
      { ...input, requestId: `request-${i}`, username: `account_${i}` });
  });
  const settled = await Promise.allSettled(work);
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 10);
  assert.equal(settled.filter(result => result.status === 'rejected' && /WEB_KDF_BUSY/.test(String(result.reason))).length, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 10);
});

test('concurrent same username has one winner; revocation during KDF cannot commit upgrade', async t => {
  const { store, identity } = fixture(t);
  const first = identity.bootstrap(), second = identity.bootstrap();
  const attempts = await Promise.allSettled([
    identity.register(first.issuedToken!, first.csrf, origin, input),
    identity.register(second.issuedToken!, second.csrf, origin, { ...input, requestId: 'register-2' }),
  ]);
  assert.equal(attempts.filter(attempt => attempt.status === 'fulfilled').length, 1);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 1);

  const third = identity.bootstrap(), pending = identity.register(third.issuedToken!, third.csrf, origin,
    { ...input, requestId: 'register-3', username: 'another_user' });
  const rejected = assert.rejects(pending, /SESSION_EXPIRED/);
  const digest = store.get<{ token_digest: string }>('SELECT token_digest FROM web_sessions WHERE principal_id=?', third.principalId)!.token_digest;
  store.run('UPDATE web_sessions SET revoked_at=? WHERE token_digest=?', 1_700_000_000_000, digest);
  await rejected;
  assert.equal(store.get<{ n: number }>("SELECT count(*) n FROM web_accounts WHERE username_norm='another_user'")?.n, 0);
});


test('expired guest classification is read-only and excludes active, revoked, account and wrong-epoch identities', t => {
  const f = fixture(t), boot = f.identity.bootstrap(), token = boot.issuedToken!;
  const before = f.store.get<{ n:number }>('SELECT count(*) n FROM web_sessions')!.n;
  assert.equal(f.identity.expiredGuest(token), false);
  f.advance(24 * 60 * 60_000);
  assert.equal(f.identity.expiredGuest(token), true);
  assert.throws(() => f.identity.authenticate(token), /SESSION_EXPIRED/);
  assert.equal(f.identity.expiredGuest('invalid'), false);
  assert.equal(f.identity.expiredGuest('z'.repeat(43)), false);
  f.store.run('UPDATE web_sessions SET revoked_at=? WHERE principal_id=?', f.clock.now(), boot.principalId);
  assert.equal(f.identity.expiredGuest(token), false);
  f.store.run('UPDATE web_sessions SET revoked_at=NULL WHERE principal_id=?', boot.principalId);
  f.store.run("UPDATE web_principals SET kind='account' WHERE id=?", boot.principalId);
  assert.equal(f.identity.expiredGuest(token), false);
  f.store.run("UPDATE web_principals SET kind='guest' WHERE id=?", boot.principalId);
  f.store.run("UPDATE web_sessions SET recovery_epoch='different-epoch' WHERE principal_id=?", boot.principalId);
  assert.equal(f.identity.expiredGuest(token), false);
  assert.equal(f.store.get<{ n:number }>('SELECT count(*) n FROM web_sessions')!.n,before);
});
