import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue, type WebStageClaim } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';

const base = 1_700_000_000_000;
const candidate = {
  narrative: ['合成首片', '合成次片'],
  inputVersion: 'input-1',
  characterVersion: 'character-1',
  templateVersion: 'template-1',
  voiceVersion: 'voice-1',
  accessRevision: 1,
  usage: { synthetic: true },
};
const ip = (n: number) => n.toString(16).padStart(64, '0');

function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-b1b-'));
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
  let now = base;
  const clock = { now: () => now };
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
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
  function admit(principalId: string, requestId: string, number = 1) {
    return admission.admit({ principalId, requestId, characterId: 'character', text: requestId, ipHash: ip(number) });
  }
  function stage(principalId: string, requestId: string, number = 1) {
    const op = admit(principalId, requestId, number);
    const coordinator = queue.acquireCoordinator('coordinator');
    queue.completeText(queue.claimText(coordinator, 'text')!, candidate);
    store.migrateSyntheticVoiceQueue();
    ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 4 });
    return { op, coordinator };
  }
  function send(claim: WebStageClaim, requestId: string) {
    const key = ledger.reserve(claim, {
      phase: 'speech',
      ordinal: claim.ordinal!,
      provider: 'fake',
      providerRequestId: requestId,
    });
    ledger.markSent(claim, key);
    return key;
  }
  function success(key: ReturnType<typeof send>) {
    return ledger.confirm(key, { outcome: 'succeeded', receipt: { id: key.ordinal }, usage: { synthetic: 1 } });
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
    stage,
    send,
    success,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

test('C-B1b late operation-update failure rolls receipt, budget, segment and stage back together', (t) => {
  const f = fixture(t),
    principal = f.guest('atomic'),
    { op, coordinator } = f.stage(principal, 'input');
  const claim = f.queue.claimAudio(coordinator, 'audio')!,
    key = f.send(claim, 'call-1');
  const before = f.store.get<{ stage_version: number; deadline_at: number }>(
    'SELECT stage_version,deadline_at FROM web_operations WHERE id=?',
    op.operationId,
  )!;
  f.store.run(`CREATE TRIGGER reject_synthetic_stage BEFORE UPDATE OF status ON web_operations
    WHEN NEW.status='audio_pending' BEGIN SELECT RAISE(ABORT,'injected stage failure'); END`);
  assert.throws(() => f.success(key), /injected stage failure/);
  assert.deepEqual(
    {
      ...f.store.get<{
        dispatch_state: string;
        outcome: string | null;
        receipt_json: string | null;
        usage_json: string | null;
      }>('SELECT dispatch_state,outcome,receipt_json,usage_json FROM web_external_attempts'),
    },
    { dispatch_state: 'sent', outcome: null, receipt_json: null, usage_json: null },
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.deepEqual(
    {
      ...f.store.get<{ state: string; completed_at: number | null }>(
        'SELECT state,completed_at FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
        op.operationId,
      ),
    },
    { state: 'running', completed_at: null },
  );
  assert.deepEqual(
    {
      ...f.store.get<{ status: string; stage_version: number; deadline_at: number }>(
        'SELECT status,stage_version,deadline_at FROM web_operations WHERE id=?',
        op.operationId,
      ),
    },
    { status: 'audio_running', ...before },
  );
  f.store.run('DROP TRIGGER reject_synthetic_stage');
  assert.deepEqual(f.success(key), { duplicate: false });
  const version = f.store.get<{ stage_version: number }>(
    'SELECT stage_version FROM web_operations WHERE id=?',
    op.operationId,
  )!.stage_version;
  assert.deepEqual(f.success(key), { duplicate: true });
  assert.equal(
    f.store.get<{ stage_version: number }>('SELECT stage_version FROM web_operations WHERE id=?', op.operationId)
      ?.stage_version,
    version,
  );
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
});

test('C-B1b first segment may run 70s; next waits only remaining budget and all-complete stays private', (t) => {
  const f = fixture(t),
    principal = f.guest('partial'),
    { op, coordinator: firstCoordinator } = f.stage(principal, 'input');
  let coordinator = firstCoordinator;
  f.advance(35_000);
  coordinator = f.queue.acquireCoordinator('after-first-wait');
  const first = f.queue.claimAudio(coordinator, 'audio-0')!,
    firstKey = f.send(first, 'call-0');
  for (let i = 0; i < 3; i++) {
    f.advance(20_000);
    coordinator = f.queue.renewCoordinator(coordinator);
  }
  f.advance(10_000);
  assert.deepEqual(f.success(firstKey), { duplicate: false });
  assert.equal(
    f.store.get<{ audio_wait_used_ms: number }>(
      'SELECT audio_wait_used_ms FROM web_operations WHERE id=?',
      op.operationId,
    )?.audio_wait_used_ms,
    35_000,
  );
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      op.operationId,
    )?.state,
    'synthetic_complete',
  );
  const original = f.ledger.fence(op.operationId);
  f.advance(24_999);
  coordinator = f.queue.acquireCoordinator('second-coordinator');
  const second = f.queue.claimAudio(coordinator, 'audio-1')!;
  assert.equal(second.ordinal, 1);
  assert.equal(
    f.store.get<{ audio_wait_used_ms: number }>(
      'SELECT audio_wait_used_ms FROM web_operations WHERE id=?',
      op.operationId,
    )?.audio_wait_used_ms,
    59_999,
  );
  const secondKey = f.send(second, 'call-1');
  assert.deepEqual(f.success(secondKey), { duplicate: false });
  assert.equal(f.ledger.syntheticComplete(op.operationId), true);
  const after = f.ledger.fence(op.operationId);
  assert.equal(after.status, 'audio_pending');
  assert.equal(after.audioWaitStartedAt, null);
  assert.equal(after.deadlineAt, original.deadlineAt);
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', after.ipWindowId)?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.throws(() => f.admission.finalize(op.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
  const next = f.admit(principal, 'queued-next', 2);
  assert.equal(next.status, 'queued');
  assert.equal(f.queue.claimText(coordinator, 'same-principal'), null);
  f.advance(170_001);
  const deadlineCoordinator = f.queue.acquireCoordinator('original-deadline');
  assert.deepEqual(
    f.ledger.terminate(deadlineCoordinator, f.ledger.fence(op.operationId), principal, 'failed', 'expired'),
    { status: 'failed', duplicate: false },
  );
  assert.equal(
    f.store.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', op.operationId)
      ?.deadline_at,
    base + 300_000,
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', after.ipWindowId)?.reserved,
    0,
  );
});

test('C-B1b cumulative waits 35s+25s expire at equality after reopening without replaying first success', (t) => {
  const f = fixture(t),
    principal = f.guest('boundary'),
    { op } = f.stage(principal, 'input');
  f.advance(35_000);
  let coordinator = f.queue.acquireCoordinator('first-audio');
  const first = f.queue.claimAudio(coordinator, 'audio-0')!,
    key = f.send(first, 'call-0');
  f.advance(10_000);
  assert.deepEqual(f.success(key), { duplicate: false });
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const queue = new WebStageQueue(reopened, f.clock, randomUUID),
    ledger = new WebDispatchLedger(reopened, f.clock);
  f.advance(25_000);
  coordinator = queue.acquireCoordinator('after-restart');
  assert.equal(queue.claimAudio(coordinator, 'audio-1'), null);
  assert.deepEqual(ledger.terminate(coordinator, ledger.fence(op.operationId), principal, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(
    reopened.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      op.operationId,
    )?.state,
    'synthetic_complete',
  );
  assert.equal(
    reopened.get<{ n: number }>('SELECT count(*) n FROM web_external_attempts WHERE operation_id=?', op.operationId)?.n,
    1,
  );
  assert.equal(reopened.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 0);
});

test('C-B1b late success after epoch takeover and terminal only settles external ticket', (t) => {
  const f = fixture(t),
    principal = f.guest('unknown'),
    { op, coordinator: initial } = f.stage(principal, 'input');
  const first = f.queue.claimAudio(initial, 'audio-0')!,
    key0 = f.send(first, 'call-0');
  f.success(key0);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  const queue = new WebStageQueue(reopened, f.clock, randomUUID),
    ledger = new WebDispatchLedger(reopened, f.clock);
  const second = queue.claimAudio(initial, 'audio-1')!,
    key1 = ledger.reserve(second, { phase: 'speech', ordinal: 1, provider: 'fake', providerRequestId: 'call-1' });
  ledger.markSent(second, key1);
  f.advance(31_000);
  const takeover = queue.acquireCoordinator('takeover');
  assert.equal(ledger.recover(takeover, ledger.fence(op.operationId)).status, 'unknown');
  assert.equal(reopened.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.deepEqual(ledger.confirm(key1, { outcome: 'succeeded', receipt: { late: true }, usage: { synthetic: 1 } }), {
    duplicate: false,
  });
  assert.equal(
    reopened.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=1',
      op.operationId,
    )?.state,
    'running',
  );
  assert.equal(ledger.syntheticComplete(op.operationId), false);
  assert.equal(reopened.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(reopened.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.equal(queue.claimAudio(takeover, 'no-automatic-retry'), null);
  f.advance(269_000);
  const final = queue.acquireCoordinator('final');
  assert.deepEqual(ledger.terminate(final, ledger.fence(op.operationId), principal, 'failed', 'expired'), {
    status: 'failed',
    duplicate: false,
  });
  assert.equal(reopened.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows')?.reserved, 0);
});

test('C-B1b releasing one of four slots picks fifth user before same-user second segment', (t) => {
  const f = fixture(t),
    principals = Array.from({ length: 5 }, (_, i) => f.guest(`fair-${i}`));
  const ops = principals.map((principal, i) => f.admit(principal, `input-${i}`, i + 1));
  const coordinator = f.queue.acquireCoordinator('coordinator');
  for (let i = 0; i < 5; i++) f.queue.completeText(f.queue.claimText(coordinator, 'text')!, candidate);
  f.store.migrateSyntheticVoiceQueue();
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 4 });
  const claims = Array.from({ length: 4 }, (_, i) => f.queue.claimAudio(coordinator, `audio-${i}`)!);
  assert.equal(f.queue.claimAudio(coordinator, 'fifth-before-free'), null);
  const key = f.send(claims[0]!, 'first');
  f.success(key);
  const next = f.queue.claimAudio(coordinator, 'fifth-after-free')!;
  assert.equal(next.operationId, ops[4]!.operationId);
  assert.equal(next.ordinal, 0);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='audio_running'")?.n, 4);
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      ops[0]!.operationId,
    )?.state,
    'synthetic_complete',
  );
});

test('C-B1b cancellation then duplicate late receipt settles only the external ticket once', (t) => {
  const f = fixture(t),
    principal = f.guest('cancel'),
    { op, coordinator } = f.stage(principal, 'input');
  const audio = f.queue.claimAudio(coordinator, 'audio')!,
    key = f.send(audio, 'call-0');
  const before = f.ledger.fence(op.operationId);
  assert.deepEqual(f.ledger.terminate(coordinator, before, principal, 'cancelled', 'cancel'), {
    status: 'cancelled',
    duplicate: false,
  });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 1);
  assert.deepEqual(f.success(key), { duplicate: false });
  assert.deepEqual(f.success(key), { duplicate: true });
  assert.equal(f.store.get<{ reserved: number }>('SELECT reserved FROM web_external_budgets')?.reserved, 0);
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', before.ipWindowId)?.reserved,
    0,
  );
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)?.status,
    'cancelled',
  );
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=0',
      op.operationId,
    )?.state,
    'running',
  );
  assert.equal(f.ledger.syntheticComplete(op.operationId), false);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-B1b account upgrade during sent synthetic audio preserves original scope and reservation', async (t) => {
  const f = fixture(t),
    origin = 'https://verify.example.test';
  const identity = new WebIdentity(f.store, {
    origin,
    cookieName: '__Host-verify_session',
    clock: f.clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 5), requestKey: Buffer.alloc(32, 6) },
  });
  const bootstrap = identity.bootstrap(),
    principal = bootstrap.principalId;
  const world = f.store.get<{ world_id: string }>(
    'SELECT world_id FROM web_principals WHERE id=?',
    principal,
  )!.world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,'character','new')", world);
  const { op, coordinator } = f.stage(principal, 'guest-input');
  const before = f.ledger.fence(op.operationId);
  const audio = f.queue.claimAudio(coordinator, 'audio')!,
    key = f.send(audio, 'pre-upgrade-call');
  const account = await identity.register(bootstrap.issuedToken!, bootstrap.csrf, origin, {
    requestId: 'upgrade-during-audio',
    username: 'b1b_owner',
    password: 'synthetic-password',
  });
  assert.deepEqual(f.success(key), { duplicate: false });
  const after = f.ledger.fence(op.operationId);
  assert.deepEqual(
    {
      principalId: after.principalId,
      worldId: after.worldId,
      conversationId: after.conversationId,
      inputMessageId: after.inputMessageId,
      ipWindowId: after.ipWindowId,
      deadlineAt: after.deadlineAt,
    },
    {
      principalId: before.principalId,
      worldId: before.worldId,
      conversationId: before.conversationId,
      inputMessageId: before.inputMessageId,
      ipWindowId: before.ipWindowId,
      deadlineAt: before.deadlineAt,
    },
  );
  assert.equal(identity.authenticate(account.issuedToken).principalId, principal);
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', principal)
      ?.trial_reserved,
    1,
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', before.ipWindowId)?.reserved,
    1,
  );
  assert.equal(after.status, 'audio_pending');
  assert.equal(f.ledger.syntheticComplete(op.operationId), false);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});
