import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WEB_IDENTITY_LIMITS } from '../../../config/web-v1.ts';

const origin = 'https://verify.example.test';
const registration = { requestId: 'register-1', username: 'Owner_One', password: 'synthetic-password-123' };
const keys = { keyId: 'c-synthetic', sealKey: Buffer.alloc(32, 0x41), requestKey: Buffer.alloc(32, 0x42) };
const kdfWorker = fileURLToPath(new URL('./web-identity-kdf-worker.mjs', import.meta.url));

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-identity-'));
  const root = join(parent, 'web'),
    instanceId = randomUUID(),
    epoch = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  });
  store.migrateStages();
  store.migrateAdmissionOrder();
  if (migrate) store.migrateIdentity(epoch);
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = migrate
    ? new WebIdentity(store, { origin, cookieName: '__Host-verify_session', keys, clock })
    : null;
  return {
    store,
    root,
    instanceId,
    epoch,
    clock,
    identity: identity!,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('C-ID 102→103 is explicit, atomic and preserves admission/window/deadline and queue identity', (t) => {
  const f = fixture(t, false),
    player = 'player-old',
    world = 'world-old',
    principal = 'principal-old';
  f.store.transaction(() => {
    f.store.run('INSERT INTO api_players VALUES (?,?)', player, f.clock.now());
    f.store.run('INSERT INTO worlds VALUES (?,?,?,?)', world, player, 'UTC', '{}');
    f.store.run(
      "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
      principal,
      player,
      world,
    );
    f.store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{}');
    f.store.run("INSERT INTO world_characters VALUES (?,?,'new')", world, 'character');
  });
  const admission = new WebAdmission(f.store, f.clock, randomUUID);
  const receipt = admission.admit({
    principalId: principal,
    requestId: 'old-input',
    characterId: 'character',
    text: '合成输入',
    ipHash: 'a'.repeat(64),
  });
  const operationSql =
    'SELECT world_id,conversation_id,input_message_id,ip_window_id,admission_seq,created_at,deadline_at FROM web_operations WHERE id=?';
  const before = f.store.get<Record<string, string | number>>(operationSql, receipt.operationId)!;
  const windowId = before.ip_window_id;
  assert.ok(typeof windowId === 'string');
  const window = f.store.get<{ id: string; reserved: number }>(
    'SELECT id,reserved FROM web_ip_windows WHERE id=?',
    windowId,
  )!;
  const pre = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  try {
    assert.equal(pre.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  } finally {
    pre.close();
  }
  f.store.run('CREATE TABLE web_sessions (collision INTEGER)');
  assert.throws(() => f.store.migrateIdentity(f.epoch), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 102);
  assert.equal(
    f.store.get<{ name: string }>("SELECT name FROM pragma_table_info('web_instance') WHERE name='recovery_epoch'"),
    undefined,
  );
  f.store.run('DROP TABLE web_sessions');
  f.store.migrateIdentity(f.epoch);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
  assert.deepEqual({ ...f.store.get<typeof before>(operationSql, receipt.operationId) }, { ...before });
  assert.deepEqual(
    { ...f.store.get<typeof window>('SELECT id,reserved FROM web_ip_windows WHERE id=?', windowId) },
    { ...window },
  );
  const coordinator = new WebStageQueue(f.store, f.clock, randomUUID).acquireCoordinator('coordinator');
  assert.equal(
    new WebStageQueue(f.store, f.clock, randomUUID).claimText(coordinator, 'worker')?.operationId,
    receipt.operationId,
  );
});

test('C-ID registration is in place, old ordinary bearer revokes at commit, and both lost-response paths recover', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const before = f.identity.authenticate(token);
  await assert.rejects(f.identity.register(token, guest.csrf, 'https://other.test', registration), /ORIGIN_INVALID/);
  await assert.rejects(f.identity.register(token, 'bad-csrf', origin, registration), /CSRF_INVALID/);
  const second = f.identity.bootstrap();
  await assert.rejects(f.identity.register(token, second.csrf, origin, registration), /CSRF_INVALID/);
  const result = await f.identity.register(token, guest.csrf, origin, registration);
  assert.equal(result.receipt.principalId, guest.principalId);
  assert.equal(f.identity.authenticate(result.issuedToken).world_id, before.world_id);
  assert.equal(f.identity.authenticate(result.issuedToken).player_id, before.player_id);
  assert.throws(() => f.identity.authenticate(token), /SESSION_EXPIRED/);
  assert.throws(() => f.identity.bootstrap(token), /SESSION_ROTATED_RECOVERABLE/);
  // Repeating ordinary register with the old bearer is not the recovery API.
  await assert.rejects(f.identity.register(token, guest.csrf, origin, registration), /SESSION_EXPIRED/);
  const challenge = f.identity.receiptChallenge(token).csrf;
  await assert.rejects(
    f.identity.recoverReceipt(token, challenge, 'https://other.test', registration),
    /ORIGIN_INVALID/,
  );
  await assert.rejects(
    f.identity.recoverReceipt(second.issuedToken!, challenge, origin, registration),
    /CSRF_INVALID|RECEIPT_UNAVAILABLE/,
  );
  const lostOld = await f.identity.recoverReceipt(token, challenge, origin, registration);
  assert.equal(lostOld.issuedToken, result.issuedToken);
  assert.deepEqual(lostOld.receipt, result.receipt);
  const newCsrf = f.identity.bootstrap(result.issuedToken).csrf;
  assert.deepEqual(
    f.identity.receiptStatus(result.issuedToken, newCsrf, origin, registration.requestId),
    result.receipt,
  );
  assert.throws(
    () => f.identity.receiptStatus(second.issuedToken!, second.csrf, origin, registration.requestId),
    /RECEIPT_UNAVAILABLE/,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_identity_receipts')?.n, 1);
});

test('C-ID concurrent old-cookie recovery has exactly three successes across two connections and restart', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const registered = await f.identity.register(token, guest.csrf, origin, registration);
  const csrf = f.identity.receiptChallenge(token).csrf;
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const other = new WebIdentity(reopened, { origin, cookieName: '__Host-verify_session', keys, clock: f.clock });
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) => (i % 2 ? other : f.identity).recoverReceipt(token, csrf, origin, registration)),
  );
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    WEB_IDENTITY_LIMITS.receiptSuccessfulRetrievals,
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected' && /RECEIPT_UNAVAILABLE/.test(String(result.reason)))
      .length,
    1,
  );
  assert.equal(
    f.store.get<{ successful_retrievals: number }>('SELECT successful_retrievals FROM web_identity_receipts')
      ?.successful_retrievals,
    3,
  );
  for (const result of results)
    if (result.status === 'fulfilled') assert.equal(result.value.issuedToken, registered.issuedToken);
  assert.deepEqual(
    other.receiptStatus(registered.issuedToken, registered.csrf, origin, registration.requestId),
    registered.receipt,
  );
});

test('C-ID registration rechecks revocation after asynchronous KDF and cannot create account', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const pending = f.identity.register(token, guest.csrf, origin, registration);
  f.store.run('UPDATE web_sessions SET revoked_at=? WHERE principal_id=?', f.clock.now(), guest.principalId);
  await assert.rejects(pending, /SESSION_EXPIRED/);
  assert.equal(
    f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', guest.principalId)?.kind,
    'guest',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_identity_receipts')?.n, 0);
});

test('C-ID epoch, key/AAD, security revision and logout fail closed for old recovery', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const registered = await f.identity.register(token, guest.csrf, origin, registration);
  const challenge = f.identity.receiptChallenge(token).csrf;
  const wrongKey = new WebIdentity(f.store, {
    origin,
    cookieName: '__Host-verify_session',
    clock: f.clock,
    keys: { ...keys, sealKey: Buffer.alloc(32, 0x43) },
  });
  await assert.rejects(wrongKey.recoverReceipt(token, challenge, origin, registration), /RECEIPT_UNAVAILABLE/);
  f.store.run('UPDATE web_identity_receipts SET request_id=?', 'tampered-id');
  await assert.rejects(
    f.identity.recoverReceipt(token, challenge, origin, { ...registration, requestId: 'tampered-id' }),
    /RECEIPT_UNAVAILABLE/,
  );
  f.store.run('UPDATE web_identity_receipts SET request_id=?', registration.requestId);
  f.store.run('UPDATE web_accounts SET security_revision=security_revision+1');
  await assert.rejects(f.identity.recoverReceipt(token, challenge, origin, registration), /RECEIPT_UNAVAILABLE/);
  f.store.run('UPDATE web_accounts SET security_revision=security_revision-1');
  f.identity.logout(registered.issuedToken, registered.csrf, origin);
  await assert.rejects(f.identity.recoverReceipt(token, challenge, origin, registration), /RECEIPT_UNAVAILABLE/);
  assert.throws(() => f.identity.authenticate(registered.issuedToken), /SESSION_EXPIRED/);
  f.store.run('UPDATE web_instance SET recovery_epoch=?', randomUUID());
  await assert.rejects(f.identity.recoverReceipt(token, challenge, origin, registration), /RECEIPT_UNAVAILABLE/);
});

test('C-ID concurrent failed recovery proofs cannot exceed configured failure-window attempt budget', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  await f.identity.register(token, guest.csrf, origin, registration);
  const challenge = f.identity.receiptChallenge(token).csrf;
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const other = new WebIdentity(reopened, { origin, cookieName: '__Host-verify_session', keys, clock: f.clock });
  const wrong = { ...registration, password: 'wrong-synthetic-password' };
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? other : f.identity).recoverReceipt(token, challenge, origin, wrong)),
  );
  const throttled = results.filter(
    (result) => result.status === 'rejected' && /WEB_IDENTITY_RATE_LIMITED/.test(String(result.reason)),
  ).length;
  const failed = f.store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts',
  )!;
  t.diagnostic(`parallel wrong proofs: attempts=${failed.failed_attempts}, throttled=${throttled}`);
  await assert.rejects(f.identity.recoverReceipt(token, challenge, origin, wrong), /WEB_IDENTITY_RATE_LIMITED/);
  assert.ok(
    failed.failed_attempts <= WEB_IDENTITY_LIMITS.receiptFailedAttempts,
    `failed_attempts=${failed.failed_attempts} exceeds window cap=${WEB_IDENTITY_LIMITS.receiptFailedAttempts}`,
  );
  assert.ok(throttled >= 3, `expected at least three throttled requests, got ${throttled}`);
  assert.equal(failed.successful_retrievals, 0);
});

test('C-ID excess concurrent proofs are rejected before native Argon2 starts', async () => {
  const result = await new Promise<{ kdfCalls: number; limited: number; attempts: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [kdfWorker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`KDF worker exit ${code}: ${error}`));
      else
        try {
          resolve(JSON.parse(output) as { kdfCalls: number; limited: number; attempts: number });
        } catch {
          reject(new Error(`KDF worker output ${output}; ${error}`));
        }
    });
  });
  assert.deepEqual(result, {
    kdfCalls: WEB_IDENTITY_LIMITS.receiptFailedAttempts,
    limited: 3,
    attempts: WEB_IDENTITY_LIMITS.receiptFailedAttempts,
  });
});

test('C-ID KDF callback failure releases reservation without consuming a valid recovery', async () => {
  const result = await new Promise<{ error: string; attempts: number; recovered: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [kdfWorker, 'fail-kdf'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '',
      error = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      error += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) reject(new Error(`KDF worker exit ${code}: ${error}`));
      else
        try {
          resolve(JSON.parse(output) as { error: string; attempts: number; recovered: boolean });
        } catch {
          reject(new Error(`KDF worker output ${output}; ${error}`));
        }
    });
  });
  assert.deepEqual(result, { error: 'INJECTED_KDF', attempts: 0, recovered: true });
});

test('C-ID a slow valid proof releases only its original failed-attempt window', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  await f.identity.register(token, guest.csrf, origin, registration);
  const challenge = f.identity.receiptChallenge(token).csrf;
  const oldWindowProof = f.identity.recoverReceipt(token, challenge, origin, registration);
  f.advance(WEB_IDENTITY_LIMITS.receiptFailedWindowMs);
  const newWindowWrong = f.identity.recoverReceipt(token, challenge, origin, {
    ...registration,
    password: 'wrong-new-window',
  });
  const wrongRejection = assert.rejects(newWindowWrong, /RECEIPT_UNAVAILABLE/);
  await oldWindowProof;
  await wrongRejection;
  const state = f.store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts',
  )!;
  assert.deepEqual({ ...state }, { failed_attempts: 1, successful_retrievals: 1 });
});

test('C-ID logout during receipt KDF cannot reissue identity or leave a failed-proof slot', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const account = await f.identity.register(token, guest.csrf, origin, registration);
  const challenge = f.identity.receiptChallenge(token).csrf;
  const pending = f.identity.recoverReceipt(token, challenge, origin, registration);
  f.identity.logout(account.issuedToken, account.csrf, origin);
  await assert.rejects(pending, /RECEIPT_UNAVAILABLE/);
  const state = f.store.get<{ failed_attempts: number; successful_retrievals: number }>(
    'SELECT failed_attempts,successful_retrievals FROM web_identity_receipts',
  )!;
  assert.deepEqual({ ...state }, { failed_attempts: 0, successful_retrievals: 0 });
  assert.throws(() => f.identity.authenticate(account.issuedToken), /SESSION_EXPIRED/);
});

test('C-ID an orphaned reserved proof has a finite original window and does not lock recovery forever', async (t) => {
  const f = fixture(t),
    guest = f.identity.bootstrap(),
    token = guest.issuedToken!;
  const account = await f.identity.register(token, guest.csrf, origin, registration);
  const challenge = f.identity.receiptChallenge(token).csrf;
  // Simulate a crashed verifier after five durable reservations, before callbacks.
  f.store.run(
    'UPDATE web_identity_receipts SET failed_attempts=?,failed_window_at=?',
    WEB_IDENTITY_LIMITS.receiptFailedAttempts,
    f.clock.now(),
  );
  await assert.rejects(f.identity.recoverReceipt(token, challenge, origin, registration), /WEB_IDENTITY_RATE_LIMITED/);
  f.advance(WEB_IDENTITY_LIMITS.receiptFailedWindowMs);
  assert.equal(
    (await f.identity.recoverReceipt(token, challenge, origin, registration)).issuedToken,
    account.issuedToken,
  );
  assert.equal(
    f.store.get<{ failed_attempts: number }>('SELECT failed_attempts FROM web_identity_receipts')?.failed_attempts,
    0,
  );
});
