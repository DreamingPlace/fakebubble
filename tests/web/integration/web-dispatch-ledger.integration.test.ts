import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/store.ts';

const worker = fileURLToPath(new URL('./web-dispatch-race-worker.mjs', import.meta.url));
const ip = (n: number) => n.toString(16).padStart(64, '0');

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-dispatch-'));
  const root = join(parent, 'web'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => {
    store.close();
    rmSync(parent, { recursive: true, force: true });
  });
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  if (migrate) store.migrateDispatchLedger();
  let now = 1_700_000_000_000;
  const clock = { now: () => now },
    nextId = randomUUID;
  const admission = new WebAdmission(store, clock, nextId);
  const queue = new WebStageQueue(store, clock, nextId);
  const ledger = new WebDispatchLedger(store, clock);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', 'character', 1, '{}');
  function guest(name: string) {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, 'character');
    });
    admission.registerGuest({ principalId, playerId, worldId });
    return principalId;
  }
  function admit(principalId: string, requestId: string, n = 1) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId, ipHash: ip(n) });
  }
  return {
    root,
    instanceId,
    store,
    clock,
    admission,
    queue,
    ledger,
    guest,
    admit,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('C-S3-002 explicit 103→104 migration rolls back mid-DDL and preserves old scoped operation', (t) => {
  const f = fixture(t, false),
    principal = f.guest('old');
  const op = f.admit(principal, 'old-input');
  const before = f.store.get<{
    input_message_id: string;
    ip_window_id: string;
    admission_seq: number;
    created_at: number;
    deadline_at: number;
  }>(
    `SELECT input_message_id,ip_window_id,admission_seq,created_at,deadline_at
      FROM web_operations WHERE id=?`,
    op.operationId,
  )!;
  const ordinary = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  try {
    assert.equal(ordinary.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
  } finally {
    ordinary.close();
  }
  f.store.run('CREATE TABLE web_external_attempts (collision INTEGER)');
  assert.throws(() => f.store.migrateDispatchLedger(), /already exists/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
  assert.equal(
    f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_external_budgets'"),
    undefined,
    'earlier DDL must roll back',
  );
  f.store.run('DROP TABLE web_external_attempts');
  f.store.migrateDispatchLedger();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  assert.deepEqual(
    {
      ...f.store.get<typeof before>(
        `SELECT input_message_id,ip_window_id,admission_seq,created_at,deadline_at
    FROM web_operations WHERE id=?`,
        op.operationId,
      ),
    },
    { ...before },
  );
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  try {
    assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 104);
  } finally {
    reopened.close();
  }
  const lease = f.queue.acquireCoordinator('coordinator');
  assert.equal(f.queue.claimText(lease, 'worker')?.operationId, op.operationId);
  assert.throws(() => f.admission.finalize(op.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('C-S3-002 old running and nonempty legacy attempt each block 104 migration without erasure', (t) => {
  const f = fixture(t, false),
    principal = f.guest('old'),
    op = f.admit(principal, 'input');
  f.store.run("UPDATE web_operations SET status='text_running' WHERE id=?", op.operationId);
  assert.throws(() => f.store.migrateDispatchLedger(), /WEB_DISPATCH_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
  f.store.run("UPDATE web_operations SET status='queued' WHERE id=?", op.operationId);
  f.store.run(
    `INSERT INTO web_stage_attempts(operation_id,stage,attempt,dispatch_state,provider_request_id,created_at)
    VALUES (?,'text',1,'sent','old-provider-request',?)`,
    op.operationId,
    f.now(),
  );
  assert.throws(() => f.store.migrateDispatchLedger(), /WEB_DISPATCH_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_stage_attempts')?.n, 1);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 103);
});

test('C-S3-002 existing schema103 account session and receipt remain scoped after explicit 104 upgrade', async (t) => {
  const f = fixture(t, false);
  const origin = 'https://verify.example.test';
  const keys = { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) };
  const beforeIdentity = new WebIdentity(f.store, {
    origin,
    cookieName: '__Host-verify_session',
    keys,
    clock: f.clock,
  });
  const guest = beforeIdentity.bootstrap(),
    token = guest.issuedToken!;
  const input = { requestId: 'register', username: 'test_owner', password: 'synthetic-password' };
  const registered = await beforeIdentity.register(token, guest.csrf, origin, input);
  const principal = beforeIdentity.authenticate(registered.issuedToken);
  const session = f.store.get<{ id: string; recovery_epoch: string; principal_id: string }>(
    'SELECT id,recovery_epoch,principal_id FROM web_sessions WHERE account_id IS NOT NULL',
  )!;
  f.store.migrateDispatchLedger();
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const afterIdentity = new WebIdentity(reopened, {
    origin,
    cookieName: '__Host-verify_session',
    keys,
    clock: f.clock,
  });
  assert.deepEqual(afterIdentity.authenticate(registered.issuedToken), principal);
  assert.deepEqual(
    {
      ...reopened.get<typeof session>(
        'SELECT id,recovery_epoch,principal_id FROM web_sessions WHERE account_id IS NOT NULL',
      ),
    },
    { ...session },
  );
  assert.deepEqual(
    afterIdentity.receiptStatus(registered.issuedToken, registered.csrf, origin, input.requestId),
    registered.receipt,
  );
  assert.throws(() => afterIdentity.authenticate(token), /SESSION_EXPIRED/);
});

test('C-S3-002 two processes cannot reserve one operation twice or consume unknown capacity', async (t) => {
  const f = fixture(t),
    principal = f.guest('race');
  f.admit(principal, 'input');
  const lease = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(lease, 'worker')!;
  assert.throws(
    () => f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'missing', providerRequestId: 'missing' }),
    /WEB_EXTERNAL_CAPACITY_UNAVAILABLE/,
  );
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const children = ['one', 'two'].map((name) =>
    spawn(process.execPath, [worker, f.root, f.instanceId, JSON.stringify(claim), name, String(f.now())], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const results = children.map(
    (child) =>
      new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
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
          if (code !== 0) reject(new Error(`race worker ${code}: ${error}`));
          else
            try {
              resolve(JSON.parse(output) as { ok: boolean; error?: string });
            } catch {
              reject(new Error(`race worker output ${output}; ${error}`));
            }
        });
      }),
  );
  for (const child of children) child.stdin.end('go\n');
  const settled = await Promise.all(results);
  assert.equal(settled.filter((result) => result.ok).length, 1, JSON.stringify(settled));
  assert.match(
    settled.find((result) => !result.ok)?.error ?? '',
    /WEB_DISPATCH_IN_FLIGHT|WEB_EXTERNAL_CAPACITY_UNAVAILABLE/,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts')?.n, 1);
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
});

test('C-S3-002 not-sent intent cannot confirm; cancellation releases original quota and external ticket once', (t) => {
  const f = fixture(t),
    principal = f.guest('unsent'),
    op = f.admit(principal, 'input');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const lease = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(lease, 'worker')!;
  const key = f.ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'request-1',
  });
  assert.throws(() => f.ledger.confirm(key, { outcome: 'succeeded', receipt: {}, usage: {} }), /WEB_DISPATCH_NOT_SENT/);
  const fence = f.ledger.fence(op.operationId);
  assert.throws(() => f.ledger.terminate(lease, fence, 'wrong-principal', 'cancelled', 'cancel'), /WEB_SCOPE_MISMATCH/);
  assert.deepEqual(f.ledger.terminate(lease, fence, principal, 'cancelled', 'cancel'), {
    status: 'cancelled',
    duplicate: false,
  });
  assert.deepEqual(f.ledger.terminate(lease, fence, principal, 'cancelled', 'cancel'), {
    status: 'cancelled',
    duplicate: true,
  });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ outcome: string }>('SELECT outcome FROM web_external_attempts')?.outcome,
    'not_dispatched',
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', fence.ipWindowId)?.reserved,
    0,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    0,
  );
  assert.throws(() => f.ledger.markSent(claim, key), /WEB_STAGE_STALE/);
});

test('C-S3-002 sent cancellation keeps external ticket unknown; late receipt settles once without business resurrection', (t) => {
  const f = fixture(t),
    principal = f.guest('sent'),
    op = f.admit(principal, 'input');
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const lease = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(lease, 'worker')!;
  const key = f.ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'request-1',
  });
  f.ledger.markSent(claim, key);
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM messages')?.n;
  const fence = f.ledger.fence(op.operationId);
  assert.deepEqual(f.ledger.terminate(lease, fence, principal, 'cancelled', 'cancel'), {
    status: 'cancelled',
    duplicate: false,
  });
  assert.equal(
    f.store.get<{ dispatch_state: string }>('SELECT dispatch_state FROM web_external_attempts')?.dispatch_state,
    'unknown',
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const afterRestart = new WebDispatchLedger(reopened, f.clock);
  assert.deepEqual(afterRestart.confirm(key, { outcome: 'succeeded', receipt: { fake: true }, usage: { calls: 1 } }), {
    duplicate: false,
  });
  assert.deepEqual(f.ledger.confirm(key, { outcome: 'succeeded', receipt: { fake: true }, usage: { calls: 1 } }), {
    duplicate: true,
  });
  assert.throws(
    () => f.ledger.confirm(key, { outcome: 'failed', receipt: {}, usage: {} }),
    /WEB_DISPATCH_RECEIPT_CONFLICT/,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM messages')?.n, before);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)?.status,
    'cancelled',
  );
  assert.throws(() => f.admission.finalize(op.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
});

test('C-S3-002 expired terminal requires original scope/version and releases only the original IP window', (t) => {
  const f = fixture(t),
    a = f.guest('old'),
    b = f.guest('fresh');
  const seed = f.admit(a, 'seed', 1);
  const seedLease = f.queue.acquireCoordinator('seed-coordinator');
  f.ledger.terminate(seedLease, f.ledger.fence(seed.operationId), a, 'cancelled', 'cancel');
  f.advance(24 * 60 * 60_000 - 30_000);
  const old = f.admit(a, 'old-input', 1);
  const original = f.ledger.fence(old.operationId);
  const oldWindow = original.ipWindowId;
  f.advance(30_001);
  const fresh = f.admit(b, 'fresh-input', 1);
  const newWindow = f.ledger.fence(fresh.operationId).ipWindowId;
  assert.notEqual(oldWindow, newWindow);
  const lease = f.queue.acquireCoordinator('coordinator');
  assert.throws(
    () => f.ledger.terminate(lease, { ...original, stageVersion: original.stageVersion + 1 }, a, 'failed', 'expired'),
    /WEB_OPERATION_STALE/,
  );
  assert.throws(() => f.ledger.terminate(lease, original, b, 'failed', 'expired'), /WEB_SCOPE_MISMATCH/);
  assert.throws(() => f.ledger.terminate(lease, original, a, 'failed', 'expired'), /WEB_OPERATION_NOT_EXPIRED/);
  f.advance(30_000);
  const renewed = f.queue.acquireCoordinator('renewed');
  assert.deepEqual(f.ledger.terminate(renewed, original, a, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', oldWindow)?.reserved,
    0,
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', newWindow)?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ quota_state: string }>('SELECT quota_state FROM web_operations WHERE id=?', fresh.operationId)
      ?.quota_state,
    'reserved',
  );
});

test('C-S3-002 new epoch fences old markSent; unsent recovery fails business, sent recovery stays unknown', (t) => {
  const f = fixture(t),
    a = f.guest('a'),
    b = f.guest('b');
  const first = f.admit(a, 'first', 1),
    second = f.admit(b, 'second', 2);
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const lease = f.queue.acquireCoordinator('first');
  const claims = [f.queue.claimText(lease, 'worker-a')!, f.queue.claimText(lease, 'worker-b')!];
  const keyA = f.ledger.reserve(claims[0]!, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'a' });
  const keyB = f.ledger.reserve(claims[1]!, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'b' });
  f.ledger.markSent(claims[1]!, keyB);
  const fenceA = f.ledger.fence(first.operationId),
    fenceB = f.ledger.fence(second.operationId);
  f.advance(90_000);
  const recovered = f.queue.acquireCoordinator('recovered');
  assert.throws(() => f.ledger.markSent(claims[0]!, keyA), /WEB_COORDINATOR_STALE|WEB_STAGE_STALE/);
  assert.equal(f.ledger.recover(recovered, fenceA).status, 'failed');
  assert.equal(f.ledger.recover(recovered, fenceB).status, 'unknown');
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(
    f.store.get<{ outcome: string }>("SELECT outcome FROM web_external_attempts WHERE provider_request_id='a'")
      ?.outcome,
    'not_dispatched',
  );
  assert.equal(
    f.store.get<{ dispatch_state: string }>(
      "SELECT dispatch_state FROM web_external_attempts WHERE provider_request_id='b'",
    )?.dispatch_state,
    'unknown',
  );
  assert.equal(
    f.store.get<{ quota_state: string }>('SELECT quota_state FROM web_operations WHERE id=?', second.operationId)
      ?.quota_state,
    'reserved',
  );
  f.advance(210_000);
  const finalLease = f.queue.acquireCoordinator('final');
  assert.deepEqual(f.ledger.terminate(finalLease, f.ledger.fence(second.operationId), b, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(
    f.store.get<{ quota_state: string }>('SELECT quota_state FROM web_operations WHERE id=?', second.operationId)
      ?.quota_state,
    'released',
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
});
