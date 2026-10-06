import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebLocalExecutor } from '../../../apps/server/platform/web-local-executor.ts';
import { WebLocalServer } from '../../../apps/server/platform/web-local-server.ts';
import { assertLocalRoot } from '../../../apps/server/platform/web-local-config.ts';
import { WebSyntheticPrivateAudio } from '../../../apps/server/audio/web-private-audio.ts';
import { WebPrivateAudioFiles } from '../../../apps/server/audio/web-private-audio-files.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticText, syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { readKnownTextOutput } from '../../../apps/server/platform/web-local-output.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const origin = 'https://127.0.0.1:18461';
const cookieName = '__Host-c_verify';

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-local-'));
  const root = join(parent, 'instance'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  let closed = false;
  t.after(() => {
    if (!closed) store.close();
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
  if (migrate) store.migrateLocalTransport();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin,
    cookieName,
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
  const createGuest = () => {
    const guest = identity.bootstrap(),
      principal = identity.authenticate(guest.issuedToken!);
    store.run("INSERT INTO world_characters VALUES (?,?,'new')", principal.world_id, 'synthetic');
    return { ...guest, principal };
  };
  const guest = createGuest();
  const admission = new WebAdmission(store, clock, randomUUID);
  const admit = (principalId: string, requestId: string) =>
    admission.admit({
      principalId,
      requestId,
      characterId: 'synthetic',
      text: 'C synthetic input',
      ipHash: 'c'.repeat(64),
    });
  return {
    store,
    root,
    instanceId,
    clock,
    identity,
    guest,
    createGuest,
    admission,
    admit,
    advance: (ms: number) => {
      now += ms;
    },
    closeOriginal: () => {
      store.close();
      closed = true;
    },
  };
}

test('C-109: late DDL and final FK faults roll back 108→109, then safe queued rows survive', (t) => {
  const f = fixture(t, false),
    old = f.admit(f.guest.principalId, 'old-queued');
  const oldOperation = f.store.get<{ input_message_id: string } & Record<string, string | number | null>>(
    'SELECT * FROM web_operations WHERE id=?',
    old.operationId,
  )!;
  const oldInput = f.store.get<Record<string, string | number | null>>(
    'SELECT * FROM messages WHERE id=?',
    oldOperation.input_message_id,
  );
  const oldPrincipal = f.store.get<Record<string, unknown>>(
    'SELECT * FROM web_principals WHERE id=?',
    f.guest.principalId,
  );
  f.store.run('CREATE TABLE web_local_guest_budget(collision INTEGER)');
  assert.throws(() => f.store.migrateLocalTransport());
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 108);
  assert.equal(f.store.get("SELECT 1 FROM pragma_table_info('web_operations') WHERE name='failure_code'"), undefined);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_local_text_outputs'"), undefined);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM pragma_table_info('web_local_guest_budget')")!.n, 1);
  f.store.run('DROP TABLE web_local_guest_budget');

  f.store.db.exec('PRAGMA foreign_keys=OFF');
  f.store.run(
    'UPDATE messages SET conversation_id=? WHERE id=?',
    'nonexistent-conversation',
    oldOperation.input_message_id,
  );
  f.store.db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => f.store.migrateLocalTransport(), /WEB_LOCAL_FOREIGN_KEY_INVALID/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 108);
  assert.equal(f.store.get("SELECT 1 FROM pragma_table_info('web_operations') WHERE name='failure_code'"), undefined);
  assert.equal(f.store.get("SELECT 1 FROM sqlite_master WHERE name='web_local_events'"), undefined);
  f.store.run(
    'UPDATE messages SET conversation_id=? WHERE id=?',
    oldInput!.conversation_id!,
    oldOperation.input_message_id,
  );

  f.store.migrateLocalTransport();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 109);
  const migratedOperation = f.store.get<Record<string, string | number | null>>(
    'SELECT * FROM web_operations WHERE id=?',
    old.operationId,
  )!;
  assert.deepEqual(Object.fromEntries(Object.entries(migratedOperation).filter(([key]) => key !== 'failure_code')), {
    ...oldOperation,
  });
  assert.deepEqual(f.store.get('SELECT * FROM messages WHERE id=?', oldOperation.input_message_id), oldInput);
  assert.deepEqual(f.store.get('SELECT * FROM web_principals WHERE id=?', f.guest.principalId), oldPrincipal);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_events')!.n, 0);
});

test('C-109: 108 published known asset and terminal UNKNOWN survive explicit migration and ordinary reopen', (t) => {
  const f = fixture(t, false),
    queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const audio = new WebSyntheticPrivateAudio(f.store, f.clock);
  const publisher = new WebVerticalPublisher(f.store, f.clock);
  const coordinator = queue.acquireCoordinator('old-108');
  const publishedOp = f.admit(f.guest.principalId, 'old-published');
  const textClaim = queue.claimText(coordinator, 'old-text')!;
  const outputs = syntheticText(readWebV7Request(f.store, publishedOp.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'fake', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(textClaim, { phase, ordinal: -1, provider: 'fake', providerRequestId: `old-${phase}` });
    ledger.markSent(textClaim, key);
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256').update(JSON.stringify(outputs[phase])).digest('hex'),
      },
      usage: { calls: 1 },
    });
  }
  queue.completeReviewedText(textClaim, outputs);
  ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 4 });
  const speech = queue.claimAudio(coordinator, 'old-audio')!;
  const audioKey = ledger.reserve(speech, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'old-speech',
  });
  ledger.markSent(speech, audioKey);
  const tone = syntheticTone();
  ledger.confirm(audioKey, {
    outcome: 'succeeded',
    receipt: { origin: 'synthetic_test', outputDigest: createHash('sha256').update(tone).digest('hex') },
    usage: { calls: 1 },
  });
  const asset = audio.stage(
    {
      operationId: publishedOp.operationId,
      ordinal: 0,
      principalId: f.guest.principalId,
      playerId: f.guest.principal.player_id,
      worldId: textClaim.worldId,
      conversationId: textClaim.conversationId,
      characterId: textClaim.characterId,
      inputMessageId: textClaim.inputMessageId,
    },
    coordinator,
    tone,
  );
  const receipt = publisher.publish(publisher.claim(coordinator, publishedOp.operationId, 'old-publish'));
  assert.equal(receipt.messageIds.length, 1);

  const other = f.createGuest(),
    unknownOp = f.admit(other.principalId, 'old-unknown');
  const unknownClaim = queue.claimText(coordinator, 'unknown-text')!;
  const unknownKey = ledger.reserve(unknownClaim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: 'old-unknown-draft',
  });
  ledger.markSent(unknownClaim, unknownKey);
  f.advance(31_000);
  const successor = queue.acquireCoordinator('old-recovery');
  assert.equal(ledger.recover(successor, ledger.fence(unknownOp.operationId)).status, 'unknown');
  const oldTables = Object.fromEntries(
    [
      'web_operations',
      'web_external_attempts',
      'web_private_audio_assets',
      'web_publications',
      'web_publication_items',
      'web_v7_requests',
      'web_principals',
      'web_ip_windows',
      'messages',
    ].map((table) => [
      table,
      f.store.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => ({ ...row })),
    ]),
  );
  const file = readFileSync(join(f.root, 'private-audio', `${asset.mediaId}.wav`));
  f.closeOriginal();
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 108);
  reopened.migrateLocalTransport();
  assert.equal(reopened.get<{ user_version: number }>('PRAGMA user_version')!.user_version, 109);
  for (const [table, rows] of Object.entries(oldTables)) {
    const current = reopened.all<Record<string, unknown>>(`SELECT * FROM ${table}`).map((row) => ({ ...row }));
    if (table === 'web_operations') for (const row of current) delete row.failure_code;
    assert.deepEqual(current, rows, table);
  }
  assert.deepEqual(readFileSync(join(f.root, 'private-audio', `${asset.mediaId}.wav`)), file);
  assert.equal(reopened.get<{ n: number }>('SELECT count(*) n FROM web_local_events')!.n, 0);
  assert.equal(
    reopened.get<{ status: string; quota_state: string }>(
      'SELECT status,quota_state FROM web_operations WHERE id=?',
      unknownOp.operationId,
    )!.status,
    'unknown',
  );
});

test('C-109: rejected admission cannot leave event/quota side effects; event cursor is principal-bound', (t) => {
  const f = fixture(t),
    other = f.createGuest();
  f.store.run(`CREATE TRIGGER c_reject_local_event BEFORE INSERT ON web_local_events
    BEGIN SELECT RAISE(ABORT,'C_EVENT_FAIL'); END`);
  assert.throws(() => f.admit(f.guest.principalId, 'rollback'), /C_EVENT_FAIL/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_events')!.n, 0);
  assert.equal(
    f.store.get<{ trial_reserved: number }>(
      'SELECT trial_reserved FROM web_principals WHERE id=?',
      f.guest.principalId,
    )!.trial_reserved,
    0,
  );
  f.store.run('DROP TRIGGER c_reject_local_event');
  const first = f.admit(f.guest.principalId, 'first');
  f.admit(other.principalId, 'second');
  const app = Object.create(WebLocalServer.prototype) as WebLocalServer & Record<string, unknown>;
  Object.assign(app, {
    store: f.store,
    config: {
      instanceId: f.store.instanceId,
      recoveryEpoch: f.store.get<{ recovery_epoch: string }>(
        'SELECT recovery_epoch FROM web_instance WHERE singleton=1',
      )!.recovery_epoch,
      cursorKey: Buffer.alloc(32, 33).toString('base64url'),
    },
  });
  const events = (
    app as unknown as {
      events: (
        principal: unknown,
        after: number,
      ) => {
        events: { payload: { operationId?: string } }[];
        cursor: string;
      };
    }
  ).events(f.guest.principal, 0);
  assert.ok(events.events.length > 0);
  assert.equal(
    events.events.some((event) => event.payload.operationId === first.operationId),
    true,
  );
  assert.equal(
    events.events.some((event) => event.payload.operationId && event.payload.operationId !== first.operationId),
    false,
  );
  const parse = (app as unknown as { parseCursor: (raw: string, principalId: string) => number }).parseCursor;
  assert.throws(() => parse.call(app, events.cursor, other.principalId), /INVALID_CURSOR/);
  assert.throws(() => parse.call(app, `${events.cursor}x`, f.guest.principalId), /INVALID_CURSOR/);
});

test('C-109: persisted known text resumes after closing its Store without redispatch', (t) => {
  const f = fixture(t),
    op = f.admit(f.guest.principalId, 'resume-known');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const lease = queue.acquireCoordinator('before-close'),
    claim = queue.claimText(lease, 'text')!;
  const outputs = syntheticText(readWebV7Request(f.store, op.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(claim, {
      phase,
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${op.operationId}:${phase}`,
    });
    ledger.markSent(claim, key);
    const output = outputs[phase];
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      },
      usage: { calls: 1 },
      output,
    });
  }
  const attempts = f.store
    .all<Record<string, string | number | null>>(
      'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY phase',
      op.operationId,
    )
    .map((row) => ({ ...row }));
  f.closeOriginal();
  f.advance(31_000);
  const reopened = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopened.close());
  assert.deepEqual(readKnownTextOutput(reopened, op.operationId, 'draft'), outputs.draft);
  assert.deepEqual(readKnownTextOutput(reopened, op.operationId, 'review'), outputs.review);
  const executor = new WebLocalExecutor(reopened, f.clock);
  t.after(() => executor.stop());
  executor.start();
  for (
    let step = 0;
    step < 10 && !reopened.get('SELECT 1 FROM web_publications WHERE operation_id=?', op.operationId);
    step++
  )
    executor.pump();
  assert.equal(
    reopened.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)!.status,
    'published',
  );
  assert.deepEqual(
    reopened
      .all<Record<string, string | number | null>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY phase',
        op.operationId,
      )
      .filter((row) => row.stage === 'text')
      .map((row) => ({ ...row })),
    attempts,
  );
});

for (const mode of ['sent', 'known'] as const)
  test(`C-109 actual child-process exit after ${mode} speech resumes without any redispatch`, (t) => {
    const f = fixture(t),
      op = f.admit(f.guest.principalId, `crash-${mode}`);
    const now = f.clock.now();
    f.closeOriginal();
    const worker = fileURLToPath(new URL('./web-local-c-crash-worker.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [worker, f.root, f.instanceId, String(now), mode], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.equal(result.status, mode === 'sent' ? 85 : 86, result.stderr);
    f.advance(31_000);
    const restarted = new WebStore(f.root, { create: false, instanceId: f.instanceId });
    t.after(() => restarted.close());
    const original = restarted
      .all<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase',
        op.operationId,
      )
      .map((row) => ({ ...row }));
    assert.equal(original.length, 3);
    const executor = new WebLocalExecutor(restarted, f.clock);
    t.after(() => executor.stop());
    executor.start();
    if (mode === 'sent') {
      assert.equal(
        restarted.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)!.status,
        'unknown',
      );
      for (let step = 0; step < 27; step++) {
        f.advance(10_000);
        executor.pump();
      }
      assert.deepEqual(
        {
          ...restarted.get<{ status: string; quota_state: string }>(
            'SELECT status,quota_state FROM web_operations WHERE id=?',
            op.operationId,
          )!,
        },
        { status: 'failed', quota_state: 'released' },
      );
      assert.equal(
        restarted.get<{ n: number }>(
          'SELECT count(*) n FROM web_local_audio_outputs WHERE operation_id=?',
          op.operationId,
        )!.n,
        0,
      );
      assert.equal(restarted.get('SELECT 1 FROM web_publications WHERE operation_id=?', op.operationId), undefined);
    } else {
      for (
        let step = 0;
        step < 10 && !restarted.get('SELECT 1 FROM web_publications WHERE operation_id=?', op.operationId);
        step++
      )
        executor.pump();
      assert.equal(
        restarted.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)!.status,
        'published',
      );
      assert.equal(
        restarted.get<{ n: number }>(
          'SELECT count(*) n FROM web_private_audio_assets WHERE operation_id=? AND state=?',
          op.operationId,
          'synthetic_asset_verified',
        )!.n,
        1,
      );
    }
    const after = restarted
      .all<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase',
        op.operationId,
      )
      .map((row) => ({ ...row }));
    assert.deepEqual(
      after,
      mode === 'sent'
        ? original.map((row) => (row.stage === 'audio' ? { ...row, dispatch_state: 'unknown' } : row))
        : original,
    );
  });

test('checkout-local root passes while a sibling checkout remains forbidden', () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const parent = join(sourceRoot, 'runtime/web-v1/public/db');
  const root = join(parent, 'local-isolation-audit');
  mkdirSync(parent, { recursive: true });
  assert.doesNotThrow(() => assertLocalRoot(root));
  const otherRoot = join(dirname(sourceRoot), 'other-checkout/runtime/web-v1/public/db/local-isolation-audit');
  assert.throws(() => assertLocalRoot(otherRoot), /WEB_LOCAL_ROOT_REQUIRED/);
});

test('A-WEB-014 C reproduction: delayed send body after real logout must have no admission', async (t) => {
  const f = fixture(t);
  const app = Object.create(WebLocalServer.prototype) as WebLocalServer & Record<string, unknown>;
  Object.assign(app, {
    store: f.store,
    clock: f.clock,
    identity: f.identity,
    admission: f.admission,
    config: { origin, cookieName, ipKey: Buffer.alloc(32, 34).toString('base64url') },
  });
  const req = new PassThrough() as PassThrough & Record<string, unknown>;
  Object.assign(req, {
    method: 'POST',
    url: '/api/web/local/characters/synthetic/operations',
    headers: {
      cookie: `${cookieName}=${f.guest.issuedToken}`,
      origin,
      'x-csrf-token': f.guest.csrf,
      'content-type': 'application/json',
    },
    socket: { remoteAddress: '127.0.0.1' },
  });
  let status = 0,
    response = '';
  const res = {
    headersSent: false,
    setHeader() {
      return this;
    },
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(data?: string) {
      response = String(data ?? '');
      return this;
    },
  };
  const pending = (app as unknown as { handle: (request: unknown, reply: unknown) => Promise<void> }).handle(req, res);
  await Promise.resolve();
  f.identity.logout(f.guest.issuedToken!, f.guest.csrf, origin);
  assert.throws(() => f.identity.authenticate(f.guest.issuedToken!), /SESSION_EXPIRED/);
  req.end(JSON.stringify({ requestId: 'after-logout', text: 'C delayed input', delivery: 'voice' }));
  await pending;
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n,
    0,
    `post-logout response status=${status}, body=${response}`,
  );
  assert.equal(status, 401, `status=${status}, body=${response}`);
});

test('A-WEB-015 C reproduction: original deadline ends UNKNOWN business reservation, not external uncertainty', (t) => {
  const f = fixture(t),
    op = f.admit(f.guest.principalId, 'unknown');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const old = queue.acquireCoordinator('before-crash'),
    claim = queue.claimText(old, 'draft')!;
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase: 'draft', capacity: 4 });
  const key = ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'synthetic-local',
    providerRequestId: 'c-unknown',
  });
  ledger.markSent(claim, key);
  f.advance(31_000);
  const executor = new WebLocalExecutor(f.store, f.clock);
  t.after(() => executor.stop());
  executor.start();
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)!.status,
    'unknown',
  );
  for (let step = 0; step < 27; step++) {
    f.advance(10_000);
    executor.pump();
  }
  const business = f.store.get<{ status: string; quota_state: string; failure_code: string | null }>(
    'SELECT status,quota_state,failure_code FROM web_operations WHERE id=?',
    op.operationId,
  )!;
  const external = f.store.get<{ dispatch_state: string }>(
    'SELECT dispatch_state FROM web_external_attempts WHERE operation_id=?',
    op.operationId,
  )!;
  assert.equal(external.dispatch_state, 'unknown');
  assert.equal(
    f.store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='text' AND phase='draft'`)!.reserved,
    1,
  );
  assert.deepEqual({ ...business }, { status: 'failed', quota_state: 'released', failure_code: 'OPERATION_EXPIRED' });
  assert.equal(
    f.store.get<{ trial_reserved: number }>(
      'SELECT trial_reserved FROM web_principals WHERE id=?',
      f.guest.principalId,
    )!.trial_reserved,
    0,
  );
  assert.equal(
    f.store.get<{ reserved: number }>(
      'SELECT reserved FROM web_ip_windows WHERE id=(SELECT ip_window_id FROM web_operations WHERE id=?)',
      op.operationId,
    )!.reserved,
    0,
  );
  const settled = {
    outcome: 'succeeded' as const,
    receipt: { origin: 'synthetic_test', outputDigest: 'late-unknown' },
    usage: { calls: 1 },
  };
  assert.equal(ledger.confirm(key, settled).duplicate, false);
  assert.equal(ledger.confirm(key, settled).duplicate, true);
  executor.pump();
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)!.status,
    'failed',
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_text_outputs WHERE operation_id=?', op.operationId)!.n,
    0,
  );
  assert.equal(f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', op.operationId), undefined);
});

test('A-WEB-017 C reproduction: old coordinator late receipt only settles external cost, not reusable output', (t) => {
  const f = fixture(t),
    op = f.admit(f.guest.principalId, 'stale-output');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const old = queue.acquireCoordinator('old-owner'),
    claim = queue.claimText(old, 'draft')!;
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase: 'draft', capacity: 4 });
  const key = ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'synthetic-local',
    providerRequestId: 'old-owner-result',
  });
  ledger.markSent(claim, key);
  const output = syntheticText(readWebV7Request(f.store, op.operationId).request).draft;
  f.advance(31_000);
  const successor = queue.acquireCoordinator('new-owner');
  assert.notEqual(successor.epoch, old.epoch);
  ledger.confirm(key, {
    outcome: 'succeeded',
    receipt: {
      origin: 'synthetic_test',
      outputDigest: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
    },
    usage: { calls: 1 },
    output,
  });
  assert.equal(
    f.store.get<{ dispatch_state: string }>(
      'SELECT dispatch_state FROM web_external_attempts WHERE operation_id=?',
      op.operationId,
    )!.dispatch_state,
    'known',
  );
  assert.equal(
    f.store.get<{ reserved: number }>(`SELECT reserved FROM web_external_budgets
    WHERE provider='synthetic-local' AND stage='text' AND phase='draft'`)!.reserved,
    0,
  );
  const reusable = f.store.get<{ n: number }>(
    'SELECT count(*) n FROM web_local_text_outputs WHERE operation_id=?',
    op.operationId,
  )!.n;
  assert.equal(reusable, 0, `old coordinator minted ${reusable} reusable output`);
});

test('A-WEB-017 audio: old coordinator receipt cannot mint reusable bytes after epoch turnover', (t) => {
  const f = fixture(t),
    op = f.admit(f.guest.principalId, 'stale-audio');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const old = queue.acquireCoordinator('old-owner'),
    textClaim = queue.claimText(old, 'text')!;
  const outputs = syntheticText(readWebV7Request(f.store, op.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(textClaim, {
      phase,
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${op.operationId}:${phase}`,
    });
    ledger.markSent(textClaim, key);
    const output = outputs[phase];
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      },
      usage: { calls: 1 },
      output,
    });
  }
  queue.completeReviewedText(textClaim, outputs);
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'audio', phase: 'speech', capacity: 4 });
  const audioClaim = queue.claimAudio(old, 'audio')!,
    bytes = syntheticTone();
  const key = ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'synthetic-local',
    providerRequestId: `${op.operationId}:speech`,
  });
  ledger.markSent(audioClaim, key);
  f.advance(31_000);
  const successor = queue.acquireCoordinator('new-owner');
  assert.notEqual(successor.epoch, old.epoch);
  const receipt = {
    outcome: 'succeeded' as const,
    receipt: { origin: 'synthetic_test', outputDigest: createHash('sha256').update(bytes).digest('hex') },
    usage: { calls: 1 },
    output: bytes,
  };
  assert.equal(ledger.confirm(key, receipt).duplicate, false);
  assert.equal(ledger.confirm(key, receipt).duplicate, true);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_local_audio_outputs WHERE operation_id=?', op.operationId)!
      .n,
    0,
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_private_audio_assets WHERE operation_id=?', op.operationId)!
      .n,
    0,
  );
  assert.equal(f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', op.operationId), undefined);
});

test('A-WEB-016 C reproduction: one corrupt preparing WAV cannot prevent another user publishing', (t) => {
  const f = fixture(t),
    broken = f.admit(f.guest.principalId, 'broken-media');
  const queue = new WebStageQueue(f.store, f.clock, randomUUID);
  const ledger = new WebDispatchLedger(f.store, f.clock);
  const oldCoordinator = queue.acquireCoordinator('old-audio');
  const textClaim = queue.claimText(oldCoordinator, 'text')!;
  const outputs = syntheticText(readWebV7Request(f.store, broken.operationId).request);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configureBudget({ provider: 'synthetic-local', stage: 'text', phase, capacity: 4 });
    const key = ledger.reserve(textClaim, {
      phase,
      ordinal: -1,
      provider: 'synthetic-local',
      providerRequestId: `${broken.operationId}:${phase}`,
    });
    ledger.markSent(textClaim, key);
    const output = outputs[phase];
    ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256').update(JSON.stringify(output)).digest('hex'),
      },
      usage: { calls: 1 },
      output,
    });
  }
  queue.completeReviewedText(textClaim, outputs);
  ledger.configureBudget({ provider: 'synthetic-local', stage: 'audio', phase: 'speech', capacity: 4 });
  const audioClaim = queue.claimAudio(oldCoordinator, 'audio')!,
    bytes = syntheticTone();
  const key = ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'synthetic-local',
    providerRequestId: `${broken.operationId}:speech`,
  });
  ledger.markSent(audioClaim, key);
  ledger.confirm(key, {
    outcome: 'succeeded',
    receipt: { origin: 'synthetic_test', outputDigest: createHash('sha256').update(bytes).digest('hex') },
    usage: { calls: 1 },
    output: bytes,
  });
  const files = new WebPrivateAudioFiles(f.store.root),
    realWrite = files.write.bind(files);
  files.write = (mediaId, data, expected) => {
    realWrite(mediaId, data, expected);
    const path = join(f.store.root, 'private-audio', `${mediaId}.wav`);
    const damaged = readFileSync(path);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    writeFileSync(path, damaged);
    throw new Error('C_INJECTED_CRASH_BEFORE_ATTACH');
  };
  assert.throws(
    () =>
      new WebSyntheticPrivateAudio(f.store, f.clock, randomUUID, files).stage(
        {
          operationId: broken.operationId,
          ordinal: 0,
          principalId: f.guest.principalId,
          playerId: f.guest.principal.player_id,
          worldId: f.guest.principal.world_id,
          conversationId: textClaim.conversationId,
          characterId: 'synthetic',
          inputMessageId: textClaim.inputMessageId,
        },
        oldCoordinator,
        bytes,
      ),
    /C_INJECTED_CRASH_BEFORE_ATTACH/,
  );
  const attempts = f.store
    .all<Record<string, string | number | null>>(
      'SELECT * FROM web_external_attempts WHERE operation_id=?',
      broken.operationId,
    )
    .map((row) => ({ ...row }));
  queue.releaseCoordinator(oldCoordinator);
  const healthy = f.createGuest(),
    good = f.admit(healthy.principalId, 'healthy-user');
  const executor = new WebLocalExecutor(f.store, f.clock);
  t.after(() => executor.stop());
  let startError: unknown;
  try {
    executor.start();
  } catch (error) {
    startError = error;
  }
  assert.equal(f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', broken.operationId), undefined);
  assert.deepEqual(
    f.store
      .all<Record<string, string | number | null>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=?',
        broken.operationId,
      )
      .map((row) => ({ ...row })),
    attempts,
  );
  assert.equal(startError, undefined, `healthy user blocked by one corrupt asset: ${String(startError)}`);
  for (
    let step = 0;
    step < 10 && !f.store.get('SELECT 1 FROM web_publications WHERE operation_id=?', good.operationId);
    step++
  )
    executor.pump();
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', good.operationId)!.status,
    'published',
  );
  assert.deepEqual(
    {
      ...f.store.get<{ status: string; quota_state: string }>(
        'SELECT status,quota_state FROM web_operations WHERE id=?',
        broken.operationId,
      )!,
    },
    { status: 'failed', quota_state: 'released' },
  );
  for (let step = 0; step < 5; step++) executor.pump();
  assert.deepEqual(
    f.store
      .all<Record<string, string | number | null>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=?',
        broken.operationId,
      )
      .map((row) => ({ ...row })),
    attempts,
  );
});
