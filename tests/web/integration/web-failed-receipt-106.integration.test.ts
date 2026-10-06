import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue, type WebStageClaim } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const worker = fileURLToPath(new URL('./web-failed-receipt-worker.mjs', import.meta.url));
const base = 1_700_000_000_000;
const ip = (n: number) => n.toString(16).padStart(64, '0');

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-failed-'));
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
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  if (migrate) store.migrateInputSnapshot();
  let now = base;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
  const ledger = new WebDispatchLedger(store, clock);
  store.run(
    'INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)',
    'character',
    1,
    '{"name":"synthetic"}',
  );
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
  function admit(principalId: string, requestId: string, number = 1) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId, ipHash: ip(number) });
  }
  function scope(claim: WebStageClaim) {
    return {
      operation_id: claim.operationId,
      principal_id: claim.principalId,
      world_id: claim.worldId,
      conversation_id: claim.conversationId,
      character_id: claim.characterId,
      input_message_id: claim.inputMessageId,
    };
  }
  function candidate(claim: WebStageClaim, narrative = ['合成首片', '合成次片']) {
    const snapshot = queue.inputSnapshot(scope(claim));
    return {
      narrative,
      inputVersion: snapshot.input_digest,
      characterVersion: String(snapshot.template_version),
      templateVersion: snapshot.template_digest,
      voiceVersion: 'synthetic-voice',
      accessRevision: snapshot.access_revision,
      usage: { synthetic: true },
    };
  }
  function send(claim: WebStageClaim, phase: 'draft' | 'review' | 'speech', requestId: string) {
    const key = ledger.reserve(claim, {
      phase,
      ordinal: phase === 'speech' ? claim.ordinal! : -1,
      provider: 'fake',
      providerRequestId: requestId,
    });
    ledger.markSent(claim, key);
    return key;
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
    scope,
    candidate,
    send,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const failed = { outcome: 'failed' as const, receipt: { id: 'failure' }, usage: { calls: 1 } };

test('C-S3-004 two actual processes settle one sent failure exactly once and unblock same-principal queued input', async (t) => {
  const f = fixture(t),
    principal = f.guest('race');
  const first = f.admit(principal, 'first'),
    next = f.admit(principal, 'next');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.send(claim, 'draft', 'race-call');
  const children = [0, 1].map(() =>
    spawn(
      process.execPath,
      [worker, f.root, f.instanceId, JSON.stringify(key), JSON.stringify(failed), String(f.now())],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    ),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const results = children.map(
    (child) =>
      new Promise<{ ok: boolean; result?: { duplicate: boolean }; error?: string }>((resolve, reject) => {
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
          if (code !== 0) reject(new Error(`receipt worker ${code}: ${error}`));
          else
            try {
              resolve(JSON.parse(output) as { ok: boolean; result?: { duplicate: boolean } });
            } catch {
              reject(new Error(`receipt worker output ${output}; ${error}`));
            }
        });
      }),
  );
  for (const child of children) child.stdin.end('go\n');
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map((row) => row.result?.duplicate).sort(), [false, true], JSON.stringify(settled));
  assert.equal(
    f.store.get<{ status: string; quota_state: string; stage_version: number; lease_token: string | null }>(
      'SELECT status,quota_state,stage_version,lease_token FROM web_operations WHERE id=?',
      first.operationId,
    )?.status,
    'failed',
  );
  assert.equal(
    f.store.get<{ stage_version: number }>('SELECT stage_version FROM web_operations WHERE id=?', first.operationId)
      ?.stage_version,
    claim.stageVersion + 1,
  );
  assert.equal(
    f.store.get<{ lease_token: string | null }>('SELECT lease_token FROM web_operations WHERE id=?', first.operationId)
      ?.lease_token,
    null,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ reserved: number }>(
      'SELECT reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
      first.operationId,
    )?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.throws(
    () => f.ledger.confirm(key, { ...failed, receipt: { id: 'conflict' } }),
    /WEB_DISPATCH_RECEIPT_CONFLICT/,
  );
  assert.equal(f.queue.claimText(coordinator, 'next-worker')?.operationId, next.operationId);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-S3-004 late principal-quota fault rolls receipt, ticket, business status and both reservations back', (t) => {
  const f = fixture(t),
    principal = f.guest('rollback'),
    op = f.admit(principal, 'input');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.send(claim, 'draft', 'failure');
  const fence = f.ledger.fence(op.operationId);
  f.store.run(`CREATE TRIGGER reject_last_release BEFORE UPDATE OF trial_reserved ON web_principals
    WHEN NEW.trial_reserved<OLD.trial_reserved BEGIN SELECT RAISE(ABORT,'injected last release'); END`);
  assert.throws(() => f.ledger.confirm(key, failed), /injected last release/);
  assert.deepEqual(
    {
      ...f.store.get<{ dispatch_state: string; receipt_json: string | null; usage_json: string | null }>(
        'SELECT dispatch_state,receipt_json,usage_json FROM web_external_attempts WHERE operation_id=?',
        op.operationId,
      ),
    },
    { dispatch_state: 'sent', receipt_json: null, usage_json: null },
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', fence.ipWindowId)?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.ledger.fence(op.operationId).status, 'text_running');
  f.store.run('DROP TRIGGER reject_last_release');
  assert.deepEqual(f.ledger.confirm(key, failed), { duplicate: false });
  assert.deepEqual(f.ledger.confirm(key, failed), { duplicate: true });
  assert.equal(f.ledger.fence(op.operationId).status, 'failed');
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', fence.ipWindowId)?.reserved,
    0,
  );
});

test('C-S3-004 failed review and later audio leave earlier successes/candidate private while freeing original quota', (t) => {
  const f = fixture(t),
    principal = f.guest('partial'),
    first = f.admit(principal, 'review');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    text = f.queue.claimText(coordinator, 'text')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'review', capacity: 1 });
  const draft = f.send(text, 'draft', 'draft');
  f.ledger.confirm(draft, { outcome: 'succeeded', receipt: { id: 'draft' }, usage: { calls: 1 } });
  const review = f.send(text, 'review', 'review');
  f.ledger.confirm(review, failed);
  assert.equal(f.ledger.fence(first.operationId).status, 'failed');
  assert.equal(
    f.store.get<{ outcome: string }>(
      "SELECT outcome FROM web_external_attempts WHERE operation_id=? AND phase='draft'",
      first.operationId,
    )?.outcome,
    'succeeded',
  );
  const second = f.admit(principal, 'audio'),
    text2 = f.queue.claimText(coordinator, 'text-2')!;
  assert.equal(text2.operationId, second.operationId);
  f.queue.completeText(text2, f.candidate(text2));
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audio0 = f.queue.claimAudio(coordinator, 'audio-0')!,
    key0 = f.send(audio0, 'speech', 'audio-0');
  f.ledger.confirm(key0, { outcome: 'succeeded', receipt: { id: 'audio-0' }, usage: { calls: 1 } });
  const audio1 = f.queue.claimAudio(coordinator, 'audio-1')!,
    key1 = f.send(audio1, 'speech', 'audio-1');
  f.ledger.confirm(key1, failed);
  assert.equal(f.ledger.fence(second.operationId).status, 'failed');
  assert.deepEqual(
    f.store
      .all<{ ordinal: number; state: string }>(
        'SELECT ordinal,state FROM web_synthetic_voice_segments WHERE operation_id=? ORDER BY ordinal',
        second.operationId,
      )
      .map((row) => ({ ...row })),
    [
      { ordinal: 0, state: 'synthetic_complete' },
      { ordinal: 1, state: 'running' },
    ],
  );
  assert.ok(f.store.get('SELECT 1 FROM web_reviewed_candidates WHERE operation_id=?', second.operationId));
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-S3-004 original rolled IP window releases once without changing newer reservation or used count', (t) => {
  const f = fixture(t),
    early = f.guest('early'),
    principal = f.guest('current'),
    later = f.guest('later');
  const seed = f.admit(early, 'seed');
  const oldCoordinator = f.queue.acquireCoordinator('old');
  f.ledger.terminate(oldCoordinator, f.ledger.fence(seed.operationId), early, 'cancelled', 'cancel');
  f.advance(24 * 60 * 60_000 - 1_000);
  const op = f.admit(principal, 'current');
  const coordinator = f.queue.acquireCoordinator('new'),
    claim = f.queue.claimText(coordinator, 'worker')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.send(claim, 'draft', 'rolled-window-failure');
  const original = f.ledger.fence(op.operationId).ipWindowId;
  f.store.run('UPDATE web_ip_windows SET used=1 WHERE id=?', original);
  f.advance(2_000);
  const laterOp = f.admit(later, 'later');
  const newer = f.ledger.fence(laterOp.operationId).ipWindowId;
  assert.notEqual(original, newer);
  f.ledger.confirm(key, failed);
  assert.deepEqual(
    {
      ...f.store.get<{ used: number; reserved: number }>(
        'SELECT used,reserved FROM web_ip_windows WHERE id=?',
        original,
      ),
    },
    { used: 1, reserved: 0 },
  );
  assert.deepEqual(
    {
      ...f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows WHERE id=?', newer),
    },
    { used: 0, reserved: 1 },
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', later)
      ?.trial_reserved,
    1,
  );
});

test('C-S3-004 cancelled, old epoch and UNKNOWN failures settle external only without reviving work', (t) => {
  const f = fixture(t),
    a = f.guest('cancel'),
    b = f.guest('epoch'),
    c = f.guest('unknown');
  const opA = f.admit(a, 'a', 1),
    opB = f.admit(b, 'b', 2),
    opC = f.admit(c, 'c', 3);
  const initial = f.queue.acquireCoordinator('initial');
  const claims = [0, 1, 2].map((i) => f.queue.claimText(initial, `worker-${i}`)!);
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 3 });
  const keys = claims.map((claim, i) => f.send(claim, 'draft', `call-${i}`));
  f.ledger.terminate(initial, f.ledger.fence(opA.operationId), a, 'cancelled', 'cancel');
  f.ledger.confirm(keys[0]!, failed);
  f.advance(30_001);
  const takeover = f.queue.acquireCoordinator('takeover');
  f.ledger.confirm(keys[1]!, failed);
  assert.equal(f.ledger.recover(takeover, f.ledger.fence(opC.operationId)).status, 'unknown');
  f.ledger.confirm(keys[2]!, failed);
  assert.equal(f.ledger.fence(opA.operationId).status, 'cancelled');
  assert.equal(f.ledger.fence(opB.operationId).status, 'text_running');
  assert.equal(f.ledger.fence(opC.operationId).status, 'unknown');
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', b)?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-S3-004 actual account upgrade and sent-after material change still release original failed attempt', async (t) => {
  const f = fixture(t),
    origin = 'https://verify.example.test';
  const identity = new WebIdentity(f.store, {
    origin,
    cookieName: '__Host-verify_session',
    clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 9), requestKey: Buffer.alloc(32, 10) },
  });
  const bootstrap = identity.bootstrap(),
    principal = bootstrap.principalId;
  const world = f.store.get<{ world_id: string }>(
    'SELECT world_id FROM web_principals WHERE id=?',
    principal,
  )!.world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,'character','new')", world);
  const op = f.admit(principal, 'input');
  const coordinator = f.queue.acquireCoordinator('coordinator'),
    claim = f.queue.claimText(coordinator, 'worker')!;
  const original = f.ledger.fence(op.operationId),
    frozen = f.queue.inputSnapshot(f.scope(claim));
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.send(claim, 'draft', 'upgrade-failure');
  const account = await identity.register(bootstrap.issuedToken!, bootstrap.csrf, origin, {
    requestId: 'upgrade',
    username: 'failure_owner',
    password: 'synthetic-password',
  });
  f.store.run('UPDATE messages SET body=? WHERE id=?', 'changed-after-sent', op.inputMessageId);
  f.store.run('UPDATE character_templates SET version=2,config_json=? WHERE id=?', '{}', 'character');
  assert.deepEqual(f.ledger.confirm(key, failed), { duplicate: false });
  assert.equal(identity.authenticate(account.issuedToken).principalId, principal);
  assert.deepEqual({ ...f.queue.inputSnapshot(f.scope(claim)) }, { ...frozen });
  const terminal = f.ledger.fence(op.operationId);
  assert.equal(terminal.status, 'failed');
  assert.equal(terminal.principalId, original.principalId);
  assert.equal(terminal.worldId, original.worldId);
  assert.equal(terminal.ipWindowId, original.ipWindowId);
  assert.equal(terminal.deadlineAt, original.deadlineAt);
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    0,
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', original.ipWindowId)?.reserved,
    0,
  );
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-S3-004 missing committed scope, old known receipt and schema105 do not gain a terminal shortcut', (t) => {
  const f = fixture(t),
    a = f.guest('missing'),
    b = f.guest('old-known');
  const opA = f.admit(a, 'a', 1),
    opB = f.admit(b, 'b', 2);
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claimA = f.queue.claimText(coordinator, 'worker-a')!,
    claimB = f.queue.claimText(coordinator, 'worker-b')!;
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 2 });
  const keyA = f.send(claimA, 'draft', 'missing'),
    keyB = f.send(claimB, 'draft', 'old-known');
  f.store.run('DROP TRIGGER web_input_snapshots_no_delete');
  f.store.run('DELETE FROM web_input_snapshots WHERE operation_id=?', opA.operationId);
  f.ledger.confirm(keyA, failed);
  assert.equal(f.ledger.fence(opA.operationId).status, 'text_running');
  f.store.transaction(() => {
    f.store.run(
      `UPDATE web_external_attempts SET dispatch_state='known',outcome='failed',
      receipt_json=?,usage_json=?,settled_at=? WHERE operation_id=?`,
      JSON.stringify(failed.receipt),
      JSON.stringify(failed.usage),
      f.now(),
      opB.operationId,
    );
    f.store.run(
      "UPDATE web_external_budgets SET reserved=reserved-1 WHERE provider='fake' AND stage='text' AND phase='draft'",
    );
  });
  assert.deepEqual(f.ledger.confirm(keyB, failed), { duplicate: true });
  assert.equal(f.ledger.fence(opB.operationId).status, 'text_running');
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', b)?.trial_reserved,
    1,
  );
  const old = fixture(t, false),
    oldPrincipal = old.guest('105'),
    oldOp = old.admit(oldPrincipal, 'old');
  const oldClaim = old.queue.claimText(old.queue.acquireCoordinator('coordinator'), 'worker')!;
  old.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  old.ledger.confirm(old.send(oldClaim, 'draft', '105-old'), failed);
  assert.equal(old.ledger.fence(oldOp.operationId).status, 'text_running');
  assert.equal(old.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

test('C-S3-004 original 300s timeline: failed at 299999ms terminals, at 300000ms settles external only', (t) => {
  for (const [label, finalMs, expected] of [
    ['before', 299_999, 'failed'],
    ['at', 300_000, 'audio_running'],
  ] as const) {
    const f = fixture(t),
      principal = f.guest(`timeline-${label}`),
      op = f.admit(principal, `input-${label}`);
    let coordinator = f.queue.acquireCoordinator('coordinator');
    for (let i = 0; i < 2; i++) {
      f.advance(20_000);
      coordinator = f.queue.renewCoordinator(coordinator);
    }
    f.advance(10_000);
    coordinator = f.queue.renewCoordinator(coordinator);
    const text = f.queue.claimText(coordinator, 'text')!;
    for (let i = 0; i < 4; i++) {
      f.advance(20_000);
      coordinator = f.queue.renewCoordinator(coordinator);
    }
    f.queue.completeText(text, f.candidate(text, ['单片合成']));
    for (let i = 0; i < 2; i++) {
      f.advance(20_000);
      coordinator = f.queue.renewCoordinator(coordinator);
    }
    f.advance(10_000);
    coordinator = f.queue.renewCoordinator(coordinator);
    const audio = f.queue.claimAudio(coordinator, 'audio')!;
    assert.equal(audio.leaseExpiresAt, base + 300_000);
    f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
    const key = f.send(audio, 'speech', `timeline-${label}`);
    for (let i = 0; i < 5; i++) {
      f.advance(20_000);
      coordinator = f.queue.renewCoordinator(coordinator);
    }
    f.advance(finalMs - 280_000);
    assert.equal(f.now(), base + finalMs);
    assert.equal(f.ledger.fence(op.operationId).deadlineAt, base + 300_000);
    f.ledger.confirm(key, failed);
    assert.equal(f.ledger.fence(op.operationId).status, expected);
    assert.equal(
      f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
        ?.trial_reserved,
      expected === 'failed' ? 0 : 1,
    );
    assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  }
});
