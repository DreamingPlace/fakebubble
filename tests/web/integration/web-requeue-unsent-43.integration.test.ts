import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WEB_REQUEUE_LIMIT, WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticText, syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const origin = 'https://127.0.0.1:18461';

/** Part 43: after a restart, a stage that provably never crossed the send gate is re-queued instead of failed. */
function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-43-'));
  const root = join(parent, 'instance'),
    instanceId = randomUUID();
  let store = new WebStore(root, { create: true, instanceId });
  const open: WebStore[] = [store];
  t.after(() => {
    for (const s of open) {
      try {
        s.close();
      } catch {
        /* already closed */
      }
    }
    rmSync(parent, { recursive: true, force: true });
  });
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  store.migrateVerticalCandidate();
  store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin,
    cookieName: '__Host-c_verify',
    clock,
    keys: { keyId: 'c-synthetic', sealKey: Buffer.alloc(32, 31), requestKey: Buffer.alloc(32, 32) },
  });
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'synthetic',
    1,
    JSON.stringify({
      id: 'synthetic',
      name: 'C synthetic',
      version: 1,
      fictional: true,
      persona: 'Only an offline test fixture',
      schedule: defaultSchedule(),
    }),
  );
  const guest = identity.bootstrap(),
    principal = identity.authenticate(guest.issuedToken!);
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", principal.world_id, 'synthetic');
  const op = new WebAdmission(store, clock, randomUUID).admit({
    principalId: guest.principalId,
    requestId: 'requeue-43',
    characterId: 'synthetic',
    text: 'C synthetic input',
    ipHash: 'c'.repeat(64),
  });
  const budgets = (s: WebStore) => {
    const ledger = new WebDispatchLedger(s, clock);
    for (const [stage, phase] of [
      ['text', 'draft'],
      ['text', 'review'],
      ['audio', 'speech'],
    ] as const)
      if (
        !s.get(
          'SELECT 1 FROM web_external_budgets WHERE provider=? AND stage=? AND phase=?',
          'synthetic-local',
          stage,
          phase,
        )
      )
        ledger.configureBudget({ provider: 'synthetic-local', stage, phase, capacity: 4 });
  };
  budgets(store);
  return {
    root,
    instanceId,
    clock,
    op,
    get store() {
      return store;
    },
    /** A real restart: the old connection is closed (its stage lease stays behind) and the data directory reopened. */
    restart() {
      store.close();
      store = new WebStore(root, { create: false, instanceId });
      open.push(store);
      return store;
    },
    advance: (ms: number) => {
      now += ms;
    },
    reserved: () => store.get<{ n: number }>('SELECT coalesce(sum(reserved),0) n FROM web_external_budgets')!.n,
    stageAttempts: () =>
      store.all<{ stage: string; attempt: number }>(
        'SELECT stage,attempt FROM web_stage_attempts WHERE operation_id=? ORDER BY stage,attempt',
        op.operationId,
      ),
    status: () =>
      store.get<{ status: string; quota_state: string; failure_code: string | null }>(
        'SELECT status,quota_state,failure_code FROM web_operations WHERE id=?',
        op.operationId,
      )!,
    attempts: () =>
      store.all<Record<string, unknown>>(
        'SELECT stage,phase,ordinal,dispatch_state,outcome FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase',
        op.operationId,
      ),
  };
}
type F = ReturnType<typeof fixture>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** One text claim that reserves its draft and (optionally) crosses the send gate, then is abandoned by a restart. */
function loseDraft(f: F, crossGate: boolean) {
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const lease = queue.acquireCoordinator(`before-${f.clock.now()}`);
  const claim = queue.claimText(lease, 'text')!;
  assert.equal(claim.operationId, f.op.operationId);
  const key = ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'synthetic-local',
    providerRequestId: `${f.op.operationId}:draft`,
  });
  if (crossGate) ledger.markSent(claim, key);
  return ledger.fence(f.op.operationId);
}
function recover(f: F) {
  f.advance(91_000);
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const lease = queue.acquireCoordinator(`after-${f.clock.now()}`);
  const result = ledger.recover(lease, ledger.fence(f.op.operationId));
  queue.releaseCoordinator(lease);
  return { result };
}
function publish(f: F) {
  const executor = new WebLocalExecutor(f.store, f.clock);
  executor.start();
  for (let step = 0; step < 12 && f.status().status !== 'published'; step++) executor.pump();
  executor.stop();
  assert.equal(f.status().status, 'published');
}

test('Part 43: restart before the draft send gate → re-queued, budget reserved again, published exactly once', (t) => {
  const f = fixture(t);
  loseDraft(f, false);
  assert.equal(f.reserved(), 1, 'the lost intent holds one ticket');
  assert.deepEqual(
    f.attempts().map((a) => [a.phase, a.dispatch_state]),
    [['draft', 'not_sent']],
  );
  f.restart();
  const { result } = recover(f);
  assert.deepEqual({ ...result }, { status: 'queued', requeued: true });
  // Ledger positions: the never-used ticket was released once; quota is untouched; the operation is back in the queue.
  assert.equal(f.reserved(), 0);
  assert.deepEqual(
    f.attempts().map((a) => [a.phase, a.dispatch_state, a.outcome]),
    [['draft', 'known', 'not_dispatched']],
  );
  assert.deepEqual({ ...f.status() }, { status: 'queued', quota_state: 'reserved', failure_code: null });
  assert.deepEqual(
    f.stageAttempts().map((r) => ({ ...r })),
    [{ stage: 'text', attempt: 1 }],
  );
  // The next claim reserves budget again, exactly like a first attempt (a second ticket is taken, never skipped).
  {
    const queue = new WebStageQueue(f.store, f.clock, randomUUID);
    const ledger = new WebDispatchLedger(f.store, f.clock);
    const lease = queue.acquireCoordinator('again');
    const claim = queue.claimText(lease, 'text-again')!;
    const key = ledger.reserve(claim, {
      phase: 'draft',
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${f.op.operationId}:draft`,
    });
    assert.equal(f.reserved(), 1, 'reserved again before any send');
    assert.equal(f.attempts()[0]!.dispatch_state, 'not_sent');
    // Abandon this second claim again so the executor below finishes it (the bound is not reached: one more loss).
    void key;
    f.restart();
    f.advance(91_000);
    const q2 = new WebStageQueue(f.store, f.clock, randomUUID);
    const l2 = new WebDispatchLedger(f.store, f.clock);
    const lease2 = q2.acquireCoordinator('second-recovery');
    assert.equal(l2.recover(lease2, l2.fence(f.op.operationId)).status, 'queued');
    q2.releaseCoordinator(lease2);
  }
  assert.equal(f.reserved(), 0);
  assert.deepEqual(
    f.stageAttempts().map((r) => ({ ...r })),
    [
      { stage: 'text', attempt: 1 },
      { stage: 'text', attempt: 2 },
    ],
  );
  publish(f);
  assert.equal(f.status().quota_state, 'used');
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications WHERE operation_id=?', f.op.operationId)!.n,
    1,
  );
  assert.equal(
    f.store.get<{ n: number }>(
      "SELECT count(*) n FROM web_local_events WHERE operation_id=? AND kind='publication'",
      f.op.operationId,
    )!.n,
    1,
    'no duplicate bubble: one publication event',
  );
  assert.equal(f.reserved(), 0);
  assert.deepEqual(
    f
      .attempts()
      .filter((a) => a.stage === 'text')
      .map((a) => [a.phase, a.dispatch_state, a.outcome]),
    [
      ['draft', 'known', 'succeeded'],
      ['review', 'known', 'succeeded'],
    ],
  );
});

test('Part 43: restart after the send gate stays UNKNOWN, is never resent and keeps its ticket and quota', (t) => {
  const f = fixture(t);
  loseDraft(f, true);
  f.restart();
  const { result } = recover(f);
  assert.equal(result.status, 'failed'); // Part 54 NAMED EXCEPTION: the reply ends now (see below)
  const before = f.attempts().map((a) => ({ ...a }));
  assert.deepEqual(
    before.map((a) => [a.phase, a.dispatch_state]),
    [['draft', 'unknown']],
  );
  // Part 54 NAMED EXCEPTION: the UNKNOWN call keeps its money held and is never resent, but frees its running-slot ticket, and
  // its reply ends as failed (quota released) so the player's next message is served. Everything else here is unchanged.
  assert.equal(f.reserved(), 0, 'the UNKNOWN call no longer keeps its running-slot ticket');
  assert.equal(f.status().quota_state, 'released');
  assert.deepEqual(f.stageAttempts(), [], 'nothing was re-queued');
  // An executor pass never resends it.
  const executor = new WebLocalExecutor(f.store, f.clock);
  executor.start();
  for (let step = 0; step < 6; step++) executor.pump();
  executor.stop();
  assert.deepEqual(
    f.attempts().map((a) => ({ ...a })),
    before,
  );
  assert.equal(f.status().status, 'failed');
  assert.equal(f.reserved(), 0);
});

test('Part 43: text already known and a clip unsent → only the clip is re-queued, text unchanged', (t) => {
  const f = fixture(t);
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const lease = queue.acquireCoordinator('before');
  const text = queue.claimText(lease, 'text')!;
  const outputs = syntheticText(readWebV7Request(f.store, f.op.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    const key = ledger.reserve(text, {
      phase,
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${f.op.operationId}:${phase}`,
    });
    ledger.markSent(text, key);
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: { origin: 'synthetic_test', outputDigest: digest(outputs[phase]) },
      usage: { calls: 1 },
      output: outputs[phase],
    });
  }
  queue.completeReviewedText(text, { draft: outputs.draft, review: outputs.review });
  const audio = queue.claimAudio(lease, 'audio')!;
  assert.ok(audio, 'a clip is claimed');
  const key = ledger.reserve(audio, {
    phase: 'speech',
    ordinal: audio.ordinal!,
    provider: 'synthetic-local',
    providerRequestId: `${f.op.operationId}:speech:${audio.ordinal}`,
  });
  void key;
  const textRows = () =>
    f.store
      .all<Record<string, unknown>>(
        'SELECT * FROM web_local_text_outputs WHERE operation_id=? ORDER BY phase',
        f.op.operationId,
      )
      .map((r) => ({ ...r }));
  const textAttempts = () =>
    f
      .attempts()
      .filter((a) => a.stage === 'text')
      .map((a) => ({ ...a }));
  const textBefore = textRows(),
    textAttemptsBefore = textAttempts();
  assert.equal(f.reserved(), 1, 'only the clip holds a ticket');
  f.restart();
  const { result } = recover(f);
  assert.deepEqual({ ...result }, { status: 'audio_pending', requeued: true });
  assert.equal(f.reserved(), 0);
  assert.deepEqual(
    f.stageAttempts().map((r) => ({ ...r })),
    [{ stage: 'audio', attempt: 1 }],
  );
  assert.deepEqual(textRows(), textBefore, 'the known text is byte-for-byte unchanged');
  assert.deepEqual(textAttempts(), textAttemptsBefore);
  assert.equal(
    f.store.get<{ state: string }>(
      'SELECT state FROM web_synthetic_voice_segments WHERE operation_id=? AND ordinal=?',
      f.op.operationId,
      audio.ordinal!,
    )!.state,
    'pending',
  );
  publish(f);
  assert.deepEqual(textRows(), textBefore, 'still unchanged after publication');
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications WHERE operation_id=?', f.op.operationId)!.n,
    1,
  );
  assert.equal(f.status().quota_state, 'used');
  assert.equal(f.reserved(), 0);
  void syntheticTone;
});

test(`Part 43: the re-queue bound (${WEB_REQUEUE_LIMIT}) then fails with RECOVERED_NOT_SENT, ledger positions intact`, (t) => {
  const f = fixture(t);
  for (let loss = 1; loss <= WEB_REQUEUE_LIMIT; loss++) {
    loseDraft(f, false);
    assert.equal(f.reserved(), 1);
    f.restart();
    assert.equal(recover(f).result.status, 'queued', `loss ${loss} is re-queued`);
    assert.equal(f.reserved(), 0);
  }
  loseDraft(f, false);
  f.restart();
  assert.equal(recover(f).result.status, 'failed', 'one loss more than the bound fails as before');
  assert.deepEqual(
    { ...f.status() },
    { status: 'failed', quota_state: 'released', failure_code: 'RECOVERED_NOT_SENT' },
  );
  assert.equal(f.reserved(), 0);
  assert.equal(f.stageAttempts().length, WEB_REQUEUE_LIMIT);
  assert.deepEqual(
    f.attempts().map((a) => [a.phase, a.dispatch_state, a.outcome]),
    [['draft', 'known', 'not_dispatched']],
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications WHERE operation_id=?', f.op.operationId)!.n,
    0,
  );
});

test('Part 43: past the operation deadline an unsent stage still fails as before (never re-queued)', (t) => {
  const f = fixture(t);
  loseDraft(f, false);
  f.restart();
  f.advance(300_000);
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const lease = queue.acquireCoordinator('late');
  assert.equal(ledger.recover(lease, ledger.fence(f.op.operationId)).status, 'failed');
  assert.equal(f.status().failure_code, 'RECOVERED_NOT_SENT');
  assert.deepEqual(f.stageAttempts(), []);
  assert.equal(f.reserved(), 0);
});

test('Part 43: a stage with a known failed attempt is not re-queued (no hidden second paid call)', (t) => {
  const f = fixture(t);
  const fence = loseDraft(f, true);
  void fence;
  // The draft was sent and answered with a known failure; the stage then lost its lease.
  f.store.run(
    `UPDATE web_external_attempts SET dispatch_state='known',outcome='failed',receipt_json='{}',usage_json='{}',settled_at=?
    WHERE operation_id=? AND phase='draft'`,
    f.clock.now(),
    f.op.operationId,
  );
  f.restart();
  assert.equal(recover(f).result.status, 'failed');
  assert.equal(f.status().failure_code, 'RECOVERED_NOT_SENT');
  assert.deepEqual(f.stageAttempts(), []);
});
