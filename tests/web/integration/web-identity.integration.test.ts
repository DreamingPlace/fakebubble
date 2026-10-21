import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const origin = 'https://verify.example.test';
const registration = { requestId: 'register-1', username: 'Owner_One', password: 'synthetic-password-123' };
const keys = { keyId: 'c-synthetic', sealKey: Buffer.alloc(32, 0x41), requestKey: Buffer.alloc(32, 0x42) };

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

test('C-ID registration is in place and the old ordinary bearer revokes at commit', async (t) => {
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
  assert.throws(() => f.identity.bootstrap(token), /SESSION_EXPIRED/);
  // Repeating register with the old bearer is refused: nothing recovers a lost response any more.
  await assert.rejects(f.identity.register(token, guest.csrf, origin, registration), /SESSION_EXPIRED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_accounts')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_identity_receipts')?.n, 0);
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
