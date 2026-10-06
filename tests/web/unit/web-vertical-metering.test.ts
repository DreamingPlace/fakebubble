import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { textRequest } from '../../text-fixtures.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { WebSyntheticPrivateAudio } from '../../../apps/server/audio/web-private-audio.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { tone } from '../../audio-fixtures.ts';
import { dialogueCandidate } from '../../../packages/domain/dialogue.ts';

const origin = 'https://web.example.test';
function fixture(t: test.TestContext) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-vertical-metering-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, 'instance'),
    instanceId = randomUUID();
  const store = new WebStore(root, { create: true, instanceId });
  t.after(() => store.close());
  store.migrateStages();
  store.migrateAdmissionOrder();
  store.migrateIdentity(randomUUID());
  store.migrateDispatchLedger();
  store.migrateSyntheticVoiceQueue();
  store.migrateInputSnapshot();
  store.migrateSyntheticPrivateAudio();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin,
    cookieName: '__Host-vertical_session',
    clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
  });
  const admission = new WebAdmission(store, clock, randomUUID),
    queue = new WebStageQueue(store, clock, randomUUID);
  const ledger = new WebDispatchLedger(store, clock);
  const guest = identity.bootstrap(),
    token = guest.issuedToken!;
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'character',
    1,
    JSON.stringify({ ...textRequest().character, id: 'character' }),
  );
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", identity.authenticate(token).world_id, 'character');
  const admit = (requestId: string) =>
    admission.admit({
      principalId: guest.principalId,
      requestId,
      characterId: 'character',
      text: requestId,
      ipHash: 'a'.repeat(64),
    });
  return {
    store,
    root,
    instanceId,
    clock,
    identity,
    admission,
    queue,
    ledger,
    guest,
    token,
    admit,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function readyToPublish(
  t: test.TestContext,
  scene = false,
  afterTextReady?: (
    f: ReturnType<typeof fixture>,
    coordinator: ReturnType<WebStageQueue['acquireCoordinator']>,
  ) => void,
  afterAudioReserved?: (f: ReturnType<typeof fixture>) => void,
) {
  const f = fixture(t);
  f.store.migrateVerticalCandidate();
  const inputText = scene ? '我在虚构河边，想靠着你。' : 'ready';
  const admitted = f.admission.admit({
    principalId: f.guest.principalId,
    requestId: 'ready',
    characterId: 'character',
    text: inputText,
    ipHash: 'a'.repeat(64),
  });
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const textClaim = f.queue.claimText(coordinator, 'text-worker')!;
  const reply = scene ? '嗯，靠过来一点。' : '你好，ready。';
  const draft = {
    mode: 'casual',
    utterance: { text: reply, expression: 'neutral' },
    afterthoughts: [],
    endsSession: false,
  };
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    factOps: [],
    topics: [
      {
        key: '问候',
        memoryId: null,
        importance: 3,
        summary: '玩家先说 ready，角色回应。',
        sourceKind: 'conversation',
        evidenceMessageIds: [textClaim.inputMessageId],
      },
    ],
    coverage: { [textClaim.inputMessageId]: { status: 'answered', supportQuote: reply, missingInformation: '' } },
    relationshipEvents: [],
    sceneUpdate: scene
      ? {
          scene: { kind: 'together', setting: '虚构河边', plan: null, proximity: 'close', speaking: 'quiet' },
          evidence: [{ messageId: textClaim.inputMessageId, quote: inputText }],
          responseQuote: reply,
        }
      : null,
  };
  for (const phase of ['draft', 'review'] as const) {
    f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase, capacity: 1 });
    const key = f.ledger.reserve(textClaim, { phase, ordinal: -1, provider: 'fake', providerRequestId: phase });
    f.ledger.markSent(textClaim, key);
    f.ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256')
          .update(JSON.stringify(phase === 'draft' ? draft : review))
          .digest('hex'),
      },
      usage: { calls: 1 },
    });
  }
  f.queue.completeReviewedText(textClaim, { draft, review });
  afterTextReady?.(f, coordinator);
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audioClaim = f.queue.claimAudio(coordinator, 'audio-worker')!;
  const key = f.ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'speech',
  });
  afterAudioReserved?.(f);
  f.ledger.markSent(audioClaim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
  const wav = tone(250),
    staged = new WebSyntheticPrivateAudio(f.store, f.clock).stage(
      {
        operationId: admitted.operationId,
        ordinal: 0,
        principalId: f.guest.principalId,
        playerId: f.identity.authenticate(f.token).player_id,
        worldId: textClaim.worldId,
        conversationId: textClaim.conversationId,
        characterId: textClaim.characterId,
        inputMessageId: textClaim.inputMessageId,
      },
      coordinator,
      wav,
    );
  const publisher = new WebVerticalPublisher(f.store, f.clock);
  const publishClaim = publisher.claim(coordinator, admitted.operationId, 'publisher');
  return { ...f, admitted, coordinator, textClaim, publisher, publishClaim, staged, wav };
}

test('108 preserves queued trial and registered account sends entitled without an IP window', async (t) => {
  const f = fixture(t),
    old = f.admit('old-trial');
  const oldRow = f.store.get<{ ip_window_id: string; deadline_at: number; admission_seq: number }>(
    'SELECT * FROM web_operations WHERE id=?',
    old.operationId,
  )!;
  f.store.migrateVerticalCandidate();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
  assert.equal(
    f.store.get<{ metering_type: string }>('SELECT * FROM web_operations WHERE id=?', old.operationId)?.metering_type,
    'trial',
  );
  const registered = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'register',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  assert.equal(f.identity.authenticate(registered.issuedToken).kind, 'account');
  const newer = f.admit('account-new');
  const newRow = f.store.get<{ metering_type: string; ip_window_id: string | null }>(
    'SELECT * FROM web_operations WHERE id=?',
    newer.operationId,
  )!;
  assert.deepEqual(
    { metering: newRow.metering_type, window: newRow.ip_window_id },
    { metering: 'entitled', window: null },
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', oldRow.ip_window_id)?.reserved,
    1,
  );
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', f.guest.principalId)
      ?.trial_reserved,
    1,
  );
  assert.equal(f.admit('old-trial').operationId, old.operationId);
  assert.equal(
    f.store.get<{ deadline_at: number; admission_seq: number }>(
      'SELECT * FROM web_operations WHERE id=?',
      old.operationId,
    )?.deadline_at,
    oldRow.deadline_at,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n, 1);
});

test('108 entitled known failure and cancel release no trial counters', async (t) => {
  const f = fixture(t);
  f.store.migrateVerticalCandidate();
  const registered = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'register',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  assert.equal(f.identity.authenticate(registered.issuedToken).kind, 'account');
  const first = f.admit('first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  assert.equal(claim.operationId, first.operationId);
  assert.throws(
    () =>
      f.queue.completeText(claim, {
        narrative: ['legacy string'],
        inputVersion: 'i',
        characterVersion: 'c',
        templateVersion: 't',
        voiceVersion: 'v',
        accessRevision: 1,
        usage: {},
      }),
    /WEB_FULL_REVIEW_REQUIRED/,
  );
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  const key = f.ledger.reserve(claim, { phase: 'draft', ordinal: -1, provider: 'fake', providerRequestId: 'req-one' });
  f.ledger.markSent(claim, key);
  f.ledger.confirm(key, { outcome: 'failed', receipt: { known: true }, usage: { calls: 1 } });
  assert.deepEqual(
    {
      ...f.store.get<{ status: string; quota_state: string }>(
        'SELECT status,quota_state FROM web_operations WHERE id=?',
        first.operationId,
      ),
    },
    { status: 'failed', quota_state: 'released' },
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n, 0);
  assert.equal(
    f.store.get<{ trial_reserved: number }>('SELECT trial_reserved FROM web_principals WHERE id=?', f.guest.principalId)
      ?.trial_reserved,
    0,
  );
  const second = f.admit('second'),
    fence = f.ledger.fence(second.operationId);
  assert.equal(fence.meteringType, 'entitled');
  assert.equal(fence.ipWindowId, null);
  assert.equal(f.ledger.terminate(coordinator, fence, f.guest.principalId, 'cancelled', 'cancel').status, 'cancelled');
  assert.equal(f.ledger.terminate(coordinator, fence, f.guest.principalId, 'cancelled', 'cancel').duplicate, true);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n, 0);
});

test('108 unsafe active state, custom trigger and DDL failure rollback keep 107 intact', (t) => {
  const f = fixture(t),
    first = f.admit('first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  f.queue.claimText(coordinator, 'worker');
  assert.throws(() => f.store.migrateVerticalCandidate(), /WEB_VERTICAL_MIGRATION_UNSAFE/);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
  const fence = f.ledger.fence(first.operationId);
  assert.equal(f.ledger.terminate(coordinator, fence, f.guest.principalId, 'cancelled', 'cancel').status, 'cancelled');
  f.store.run(`CREATE TRIGGER extra_operation_trigger AFTER UPDATE ON web_operations BEGIN SELECT 1; END`);
  assert.throws(() => f.store.migrateVerticalCandidate(), /WEB_VERTICAL_UNRECOGNIZED_REFERENCE/);
  f.store.run('DROP TRIGGER extra_operation_trigger');
  f.store.db.exec('ALTER TABLE web_operations ADD COLUMN metering_type TEXT');
  assert.throws(() => f.store.migrateVerticalCandidate(), /duplicate column/);
  assert.equal(
    f.store.get<{ n: number }>(`SELECT "notnull" n FROM pragma_table_info('web_operations') WHERE name='ip_window_id'`)
      ?.n,
    1,
  );
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
});

test('108 rejects both missing and orphaned trial reservations before DDL', (t) => {
  const f = fixture(t),
    admitted = f.admit('trial');
  const window = f.store.get<{ ip_window_id: string }>(
    'SELECT ip_window_id FROM web_operations WHERE id=?',
    admitted.operationId,
  )!.ip_window_id;
  for (const [table, id] of [
    ['web_principals', f.guest.principalId],
    ['web_ip_windows', window],
  ] as const) {
    for (const reserved of [0, 2]) {
      f.store.run(
        `UPDATE ${table} SET ${table === 'web_principals' ? 'trial_reserved' : 'reserved'}=? WHERE id=?`,
        reserved,
        id,
      );
      assert.throws(() => f.store.migrateVerticalCandidate(), /WEB_VERTICAL_TRIAL_RESERVATION_MISMATCH/);
      assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
      assert.equal(
        f.store.get<{ n: number }>(
          `SELECT "notnull" n FROM pragma_table_info('web_operations') WHERE name='ip_window_id'`,
        )?.n,
        1,
      );
    }
    f.store.run(`UPDATE ${table} SET ${table === 'web_principals' ? 'trial_reserved' : 'reserved'}=1 WHERE id=?`, id);
  }
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const fence = f.ledger.fence(admitted.operationId);
  f.ledger.terminate(coordinator, fence, f.guest.principalId, 'cancelled', 'cancel');
  f.store.run('UPDATE web_principals SET trial_reserved=1 WHERE id=?', f.guest.principalId);
  assert.throws(() => f.store.migrateVerticalCandidate(), /WEB_VERTICAL_TRIAL_RESERVATION_MISMATCH/);
});

test('108 keeps original trial debits across an account upgrade and expired window', async (t) => {
  const f = fixture(t),
    first = f.admit('trial');
  const originalWindow = f.store.get<{ ip_window_id: string }>(
    'SELECT ip_window_id FROM web_operations WHERE id=?',
    first.operationId,
  )!.ip_window_id;
  await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'register',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  f.advance(24 * 60 * 60 * 1000);
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', originalWindow)?.reserved,
    1,
  );
  f.store.migrateVerticalCandidate();
  assert.equal(
    f.store.get<{ metering_type: string }>('SELECT metering_type FROM web_operations WHERE id=?', first.operationId)
      ?.metering_type,
    'trial',
  );
});

test('108 reservation audit accounts for two principals sharing one original IP window', (t) => {
  const f = fixture(t),
    other = f.identity.bootstrap();
  const otherWorld = f.identity.authenticate(other.issuedToken!).world_id;
  f.store.run("INSERT INTO world_characters VALUES (?,?,'new')", otherWorld, 'character');
  const first = f.admit('first');
  const second = f.admission.admit({
    principalId: other.principalId,
    requestId: 'second',
    characterId: 'character',
    text: 'second',
    ipHash: 'a'.repeat(64),
  });
  const firstWindow = f.store.get<{ ip_window_id: string }>(
    'SELECT ip_window_id FROM web_operations WHERE id=?',
    first.operationId,
  )?.ip_window_id;
  assert.equal(
    f.store.get<{ ip_window_id: string }>('SELECT ip_window_id FROM web_operations WHERE id=?', second.operationId)
      ?.ip_window_id,
    firstWindow,
  );
  assert.equal(
    f.store.get<{ reserved: number }>('SELECT reserved FROM web_ip_windows WHERE id=?', firstWindow!)?.reserved,
    2,
  );
  f.store.migrateVerticalCandidate();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
});

test('108 freezes the v7 request and releases text only for two known audited fake receipts', async (t) => {
  const f = fixture(t);
  f.store.migrateVerticalCandidate();
  const admitted = f.admit('first');
  const coordinator = f.queue.acquireCoordinator('coordinator');
  const claim = f.queue.claimText(coordinator, 'worker')!;
  const { request, row } = readWebV7Request(f.store, admitted.operationId);
  assert.equal(request.jobId, admitted.operationId);
  assert.deepEqual(request.requiredMessageIds, [claim.inputMessageId]);
  assert.equal(request.messages.at(-1)?.text, 'first');
  assert.equal(row.principal_id, f.guest.principalId);
  const draft = {
    mode: 'casual',
    utterance: { text: '你好，first。', expression: 'neutral' },
    afterthoughts: [],
    endsSession: false,
  };
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    factOps: [],
    topics: [],
    coverage: { [claim.inputMessageId]: { status: 'answered', supportQuote: 'first', missingInformation: '' } },
    relationshipEvents: [],
    sceneUpdate: null,
  };
  assert.throws(() => f.queue.completeReviewedText(claim, { draft, review }), /WEB_TEXT_RECEIPTS_INCOMPLETE/);
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'draft', capacity: 1 });
  f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase: 'review', capacity: 1 });
  for (const phase of ['draft', 'review'] as const) {
    const key = f.ledger.reserve(claim, { phase, ordinal: -1, provider: 'fake', providerRequestId: phase });
    f.ledger.markSent(claim, key);
    f.ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256')
          .update(JSON.stringify(phase === 'draft' ? draft : review))
          .digest('hex'),
      },
      usage: { calls: 1 },
    });
  }
  assert.throws(
    () => f.queue.completeReviewedText(claim, { draft, review: { ...review, coverage: {} } }),
    /INCOMPLETE_COVERAGE/,
  );
  assert.throws(
    () =>
      f.queue.completeReviewedText(claim, {
        draft: { ...draft, utterance: { text: '不同的 first。', expression: 'neutral' } },
        review,
      }),
    /WEB_TEXT_RECEIPT_OUTPUT_MISMATCH/,
  );
  const completed = f.queue.completeReviewedText(claim, { draft, review });
  assert.equal(completed.status, 'text_ready');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_v7_candidates')?.n, 1);
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_synthetic_voice_segments WHERE asset_eligible=1')?.n,
    1,
  );
  assert.throws(() => f.queue.completeReviewedText(claim, { draft, review }), /WEB_STAGE_STALE/);
  const registered = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'register-during-generation',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  assert.equal(f.identity.authenticate(registered.issuedToken).kind, 'account');
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const audioClaim = f.queue.claimAudio(coordinator, 'audio-worker')!;
  const key = f.ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: 'speech-after-upgrade',
  });
  f.ledger.markSent(audioClaim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
  new WebSyntheticPrivateAudio(f.store, f.clock).stage(
    {
      operationId: admitted.operationId,
      ordinal: 0,
      principalId: f.guest.principalId,
      playerId: f.identity.authenticate(registered.issuedToken).player_id,
      worldId: claim.worldId,
      conversationId: claim.conversationId,
      characterId: claim.characterId,
      inputMessageId: claim.inputMessageId,
    },
    coordinator,
    tone(250),
  );
  const publisher = new WebVerticalPublisher(f.store, f.clock);
  const receipt = publisher.publish(publisher.claim(coordinator, admitted.operationId, 'publisher'));
  assert.equal(receipt.footerMessageId, null);
  assert.equal(
    f.store.get<{ metering_type: string; quota_state: string }>(
      'SELECT metering_type,quota_state FROM web_operations WHERE id=?',
      admitted.operationId,
    )?.metering_type,
    'trial',
  );
  assert.equal(f.store.get<{ used: number; reserved: number }>('SELECT used,reserved FROM web_ip_windows')?.used, 1);
  const entitled = f.admit('after-upgrade');
  assert.equal(
    f.store.get<{ metering_type: string; ip_window_id: string | null }>(
      'SELECT metering_type,ip_window_id FROM web_operations WHERE id=?',
      entitled.operationId,
    )?.metering_type,
    'entitled',
  );
});

test('108 publishes a complete audited synthetic voice turn atomically and replays its receipt', async (t) => {
  const f = fixture(t);
  f.store.migrateVerticalCandidate();
  const admitted = f.admit('first'),
    coordinator = f.queue.acquireCoordinator('coordinator');
  const textClaim = f.queue.claimText(coordinator, 'text-worker')!;
  const early = f.admit('second');
  assert(
    !readWebV7Request(f.store, admitted.operationId).request.messages.some(
      (message) => message.id === early.inputMessageId,
    ),
  );
  const draft = {
    mode: 'casual',
    utterance: { text: '你好，first。', expression: 'neutral' },
    afterthoughts: [{ text: '再聊一句。', expression: 'neutral' }],
    endsSession: false,
  };
  const review = {
    decision: 'accept',
    replacementBubbles: [],
    factOps: [],
    topics: [
      {
        key: '问候',
        memoryId: null,
        importance: 3,
        summary: '玩家先说 first，角色回应。',
        sourceKind: 'conversation',
        evidenceMessageIds: [textClaim.inputMessageId],
      },
    ],
    coverage: { [textClaim.inputMessageId]: { status: 'answered', supportQuote: 'first', missingInformation: '' } },
    relationshipEvents: [],
    sceneUpdate: null,
  };
  for (const phase of ['draft', 'review'] as const) {
    f.ledger.configureBudget({ provider: 'fake', stage: 'text', phase, capacity: 1 });
    const key = f.ledger.reserve(textClaim, { phase, ordinal: -1, provider: 'fake', providerRequestId: phase });
    f.ledger.markSent(textClaim, key);
    f.ledger.confirm(key, {
      outcome: 'succeeded',
      receipt: {
        origin: 'synthetic_test',
        outputDigest: createHash('sha256')
          .update(JSON.stringify(phase === 'draft' ? draft : review))
          .digest('hex'),
      },
      usage: { calls: 1 },
    });
  }
  f.queue.completeReviewedText(textClaim, { draft, review });
  f.ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 1 });
  const wav = tone(250),
    audio = new WebSyntheticPrivateAudio(f.store, f.clock);
  const staged: Array<{ mediaId: string }> = [];
  for (const ordinal of [0, 1]) {
    const audioClaim = f.queue.claimAudio(coordinator, 'audio-worker')!;
    assert.equal(audioClaim.ordinal, ordinal);
    const audioKey = f.ledger.reserve(audioClaim, {
      phase: 'speech',
      ordinal,
      provider: 'fake',
      providerRequestId: `speech-${ordinal}`,
    });
    f.ledger.markSent(audioClaim, audioKey);
    f.ledger.confirm(audioKey, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
    staged.push(
      audio.stage(
        {
          operationId: admitted.operationId,
          ordinal,
          principalId: f.guest.principalId,
          playerId: f.identity.authenticate(f.token).player_id,
          worldId: textClaim.worldId,
          conversationId: textClaim.conversationId,
          characterId: textClaim.characterId,
          inputMessageId: textClaim.inputMessageId,
        },
        coordinator,
        wav,
      ),
    );
    if (ordinal === 0)
      assert.throws(
        () => new WebVerticalPublisher(f.store, f.clock).claim(coordinator, admitted.operationId, 'publisher'),
        /WEB_PUBLICATION_NOT_READY/,
      );
  }
  const publisher = new WebVerticalPublisher(f.store, f.clock);
  const publishClaim = publisher.claim(coordinator, admitted.operationId, 'publisher');
  const receipt = publisher.publish(publishClaim);
  assert.equal(receipt.messageIds.length, 2);
  assert.equal(receipt.footerMessageId, null);
  assert.deepEqual(publisher.publish(publishClaim), receipt);
  assert.deepEqual(
    publisher.readPublishedAudio(
      {
        principalId: f.guest.principalId,
        playerId: f.identity.authenticate(f.token).player_id,
        worldId: textClaim.worldId,
        conversationId: textClaim.conversationId,
        characterId: textClaim.characterId,
      },
      staged[0]!.mediaId,
    ),
    wav,
  );
  const other = f.identity.bootstrap();
  assert.throws(
    () =>
      publisher.readPublishedAudio(
        {
          principalId: other.principalId,
          playerId: f.identity.authenticate(other.issuedToken!).player_id,
          worldId: textClaim.worldId,
          conversationId: textClaim.conversationId,
          characterId: textClaim.characterId,
        },
        staged[0]!.mediaId,
      ),
    /WEB_PUBLISHED_AUDIO_NOT_FOUND/,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 1);
  assert.equal(
    f.store.get<{ trial_used: number; trial_reserved: number }>(
      'SELECT trial_used,trial_reserved FROM web_principals WHERE id=?',
      f.guest.principalId,
    )?.trial_used,
    1,
  );
  const continueTurn = (requestId: string, preAdmitted?: ReturnType<typeof f.admit>) => {
    const next = preAdmitted ?? f.admit(requestId),
      claim = f.queue.claimText(coordinator, 'text-worker')!;
    const frozen = readWebV7Request(f.store, next.operationId).request;
    const nextDraft = {
      mode: 'casual',
      utterance: { text: `你好，${requestId}。`, expression: 'neutral' },
      afterthoughts: [],
      endsSession: false,
    };
    const nextReview = {
      decision: 'accept',
      replacementBubbles: [],
      factOps: [],
      topics:
        requestId === 'second'
          ? [
              {
                key: '问候',
                memoryId: null,
                importance: 3,
                summary: '玩家第二次问候。',
                sourceKind: 'conversation',
                evidenceMessageIds: [claim.inputMessageId],
              },
            ]
          : [],
      coverage: { [claim.inputMessageId]: { status: 'answered', supportQuote: requestId, missingInformation: '' } },
      relationshipEvents: [],
      sceneUpdate: null,
    };
    for (const phase of ['draft', 'review'] as const) {
      const key = f.ledger.reserve(claim, {
        phase,
        ordinal: -1,
        provider: 'fake',
        providerRequestId: `${phase}-${requestId}`,
      });
      f.ledger.markSent(claim, key);
      f.ledger.confirm(key, {
        outcome: 'succeeded',
        receipt: {
          origin: 'synthetic_test',
          outputDigest: createHash('sha256')
            .update(JSON.stringify(phase === 'draft' ? nextDraft : nextReview))
            .digest('hex'),
        },
        usage: { calls: 1 },
      });
    }
    f.queue.completeReviewedText(claim, { draft: nextDraft, review: nextReview });
    const audioClaim = f.queue.claimAudio(coordinator, 'audio-worker')!;
    const audioKey = f.ledger.reserve(audioClaim, {
      phase: 'speech',
      ordinal: 0,
      provider: 'fake',
      providerRequestId: `speech-${requestId}`,
    });
    f.ledger.markSent(audioClaim, audioKey);
    f.ledger.confirm(audioKey, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
    audio.stage(
      {
        operationId: next.operationId,
        ordinal: 0,
        principalId: f.guest.principalId,
        playerId: f.identity.authenticate(f.token).player_id,
        worldId: claim.worldId,
        conversationId: claim.conversationId,
        characterId: claim.characterId,
        inputMessageId: claim.inputMessageId,
      },
      coordinator,
      tone(250),
    );
    return { frozen, receipt: publisher.publish(publisher.claim(coordinator, next.operationId, 'publisher')) };
  };
  const forgedId = randomUUID();
  f.store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,
    body,created_at,delivery) VALUES (?,?,?,'character',?,? ,?,'text')`,
    forgedId,
    textClaim.worldId,
    textClaim.conversationId,
    textClaim.characterId,
    'untrusted manual text',
    f.clock.now(),
  );
  const second = continueTurn('second', early);
  assert(!second.frozen.messages.some((message) => message.id === forgedId));
  assert(
    second.frozen.messages.some((message) => message.id === receipt.messageIds[0] && message.text === '你好，first。'),
  );
  assert(
    second.frozen.messages.findIndex((message) => message.id === receipt.messageIds[1]) <
      second.frozen.messages.findIndex((message) => message.id === early.inputMessageId),
  );
  assert(second.frozen.shortTermTurns?.some((turn) => turn.id === admitted.operationId));
  assert.deepEqual(second.frozen.memories, []);
  publisher.registerSyntheticFooter('character', tone(200));
  const third = continueTurn('third');
  assert.deepEqual(third.frozen.memories, []);
  assert.equal(
    f.store.get<{ tier: string }>(
      `SELECT tier FROM memory_topics
    WHERE world_id=? AND conversation_id=? AND character_id=? AND topic_key='问候'`,
      textClaim.worldId,
      textClaim.conversationId,
      textClaim.characterId,
    )?.tier,
    'long',
  );
  assert(third.receipt.footerMessageId);
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_publication_items WHERE origin='trial_footer'")?.n,
    1,
  );
  assert.equal(
    f.store.get<{ n: number }>(
      'SELECT count(*) n FROM dialogue_bubbles WHERE message_id=?',
      third.receipt.footerMessageId,
    )?.n,
    0,
  );
  assert.throws(() => f.admit('fourth'), /TRIAL_EXHAUSTED/);
  const historyScope = {
    principalId: f.guest.principalId,
    playerId: publishClaim.playerId,
    worldId: textClaim.worldId,
    conversationId: textClaim.conversationId,
    characterId: textClaim.characterId,
  };
  const history = publisher.history(historyScope);
  assert.equal(history.length, 3);
  assert.deepEqual(
    history.map((turn) => turn.items.filter((item) => item.origin === 'trial_footer').length),
    [0, 0, 1],
  );
  assert.deepEqual(
    publisher.readPublishedAudio(
      historyScope,
      history[2]!.items.find((item) => item.origin === 'trial_footer')!.media_id,
    ),
    tone(200),
  );
  assert.equal(publisher.history({ ...historyScope, principalId: other.principalId }).length, 0);
  assert.equal(publisher.userEvents(f.guest.principalId, publishClaim.playerId).length, 3);
  assert.equal(publisher.userEvents(f.guest.principalId, publishClaim.playerId, history[1]!.seq).length, 1);
  const upgraded = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'upgrade-after-third',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  assert.equal(f.identity.authenticate(upgraded.issuedToken).kind, 'account');
  const fourth = f.admit('fourth-entitled');
  const fourthClaim = f.queue.claimText(coordinator, 'text-worker')!;
  assert.equal(fourthClaim.operationId, fourth.operationId);
  const fourthRequest = readWebV7Request(f.store, fourth.operationId).request;
  assert(fourthRequest.messages.some((message) => message.id === third.receipt.messageIds[0]));
  assert(!fourthRequest.messages.some((message) => message.id === third.receipt.footerMessageId));
  assert(fourthRequest.memories?.some((memory) => memory.key === '问候' && memory.tier === 'long'));
  f.advance(24 * 60 * 60 * 1000);
  assert.deepEqual(publisher.publish(publishClaim), receipt);
  assert.deepEqual(
    publisher.readPublishedAudio(
      {
        principalId: f.guest.principalId,
        playerId: publishClaim.playerId,
        worldId: textClaim.worldId,
        conversationId: textClaim.conversationId,
        characterId: textClaim.characterId,
      },
      staged[0]!.mediaId,
    ),
    wav,
  );
});

test('108 publication rolls back every narrative and debit when the final user event fails', (t) => {
  const f = readyToPublish(t);
  for (const [table, timing] of [
    ['memory_episodes', 'INSERT'],
    ['web_ip_windows', 'UPDATE'],
    ['web_publications', 'INSERT'],
    ['web_user_events', 'INSERT'],
  ] as const) {
    f.store.run(`CREATE TRIGGER fail_vertical_step BEFORE ${timing} ON ${table}
      BEGIN SELECT RAISE(ABORT,'injected publication failure'); END`);
    assert.throws(() => f.publisher.publish(f.publishClaim), /injected publication failure/, table);
    assert.equal(
      f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n,
      0,
      table,
    );
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM jobs')?.n, 0, table);
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM memory_episodes')?.n, 0, table);
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0, table);
    assert.deepEqual(
      {
        ...f.store.get<{ trial_used: number; trial_reserved: number }>(
          'SELECT trial_used,trial_reserved FROM web_principals WHERE id=?',
          f.guest.principalId,
        ),
      },
      { trial_used: 0, trial_reserved: 1 },
      table,
    );
    assert.equal(
      f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', f.admitted.operationId)?.status,
      'ready_to_publish',
      table,
    );
    f.store.run('DROP TRIGGER fail_vertical_step');
  }
  assert.equal(f.publisher.publish(f.publishClaim).messageIds.length, 1);
});

test('108 stale template and coordinator cannot publish a fully staged candidate', (t) => {
  const f = readyToPublish(t);
  f.store.run(
    `UPDATE character_templates SET config_json=? WHERE id='character'`,
    JSON.stringify({ ...textRequest().character, id: 'character', persona: 'changed' }),
  );
  assert.throws(() => f.publisher.publish(f.publishClaim), /WEB_INPUT_SNAPSHOT_STALE/);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  f.store.run(
    `UPDATE character_templates SET config_json=? WHERE id='character'`,
    JSON.stringify({ ...textRequest().character, id: 'character' }),
  );
  f.advance(30_000);
  const newer = f.queue.acquireCoordinator('new-coordinator');
  assert.throws(() => f.publisher.publish(f.publishClaim), /WEB_COORDINATOR_STALE/);
  f.publisher.recover(newer, f.admitted.operationId);
  const reClaim = f.publisher.claim(newer, f.admitted.operationId, 'publisher-new');
  assert.equal(f.publisher.publish(reClaim).messageIds.length, 1);
});

test('108 later player withdrawal blocks a staged sensitive scene but retains the newer input', (t) => {
  const f = readyToPublish(t, true);
  const later = f.admission.admit({
    principalId: f.guest.principalId,
    requestId: 'withdraw',
    characterId: 'character',
    text: '等等，先别靠近。',
    ipHash: 'a'.repeat(64),
  });
  assert.throws(() => f.publisher.publish(f.publishClaim), /SCENE_INPUT_CHANGED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM scene_events')?.n, 0);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', later.operationId)?.status,
    'queued',
  );
  const fence = f.ledger.fence(f.admitted.operationId);
  assert.equal(
    f.ledger.terminate(f.coordinator, fence, f.guest.principalId, 'cancelled', 'cancel').status,
    'cancelled',
  );
  assert.equal(f.queue.claimText(f.coordinator, 'next-worker')?.operationId, later.operationId);
});

test('108 later withdrawal is checked before a paid sensitive audio attempt', (t) => {
  let state: ReturnType<typeof fixture> | undefined;
  let newerOperationId: string | undefined;
  assert.throws(
    () =>
      readyToPublish(t, true, (f) => {
        state = f;
        newerOperationId = f.admission.admit({
          principalId: f.guest.principalId,
          requestId: 'withdraw-before-audio',
          characterId: 'character',
          text: '等等，先别靠近。',
          ipHash: 'a'.repeat(64),
        }).operationId;
      }),
    /SCENE_INPUT_CHANGED/,
  );
  assert(state && newerOperationId);
  assert.equal(
    state.store.get<{ n: number }>("SELECT count(*) n FROM web_external_attempts WHERE stage='audio'")?.n,
    0,
  );
  assert.equal(
    state.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', newerOperationId)?.status,
    'queued',
  );
});

test('108 withdrawal after reservation still blocks markSent before speech', (t) => {
  let state: ReturnType<typeof fixture> | undefined;
  assert.throws(
    () =>
      readyToPublish(t, true, undefined, (f) => {
        state = f;
        f.admission.admit({
          principalId: f.guest.principalId,
          requestId: 'withdraw-before-send',
          characterId: 'character',
          text: '等等，先别靠近。',
          ipHash: 'a'.repeat(64),
        });
      }),
    /SCENE_INPUT_CHANGED/,
  );
  assert(state);
  assert.equal(
    state.store.get<{ dispatch_state: string }>("SELECT dispatch_state FROM web_external_attempts WHERE stage='audio'")
      ?.dispatch_state,
    'not_sent',
  );
  assert.equal(state.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
});

test('108 revoked account entitlement blocks an already staged trial publication', async (t) => {
  const f = readyToPublish(t);
  const registered = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: 'upgrade-before-publish',
    username: 'synthetic_user',
    password: 'synthetic-password',
  });
  assert.equal(f.identity.authenticate(registered.issuedToken).kind, 'account');
  f.store.run('UPDATE web_accounts SET active=0 WHERE principal_id=?', f.guest.principalId);
  assert.throws(() => f.publisher.publish(f.publishClaim), /WEB_PUBLICATION_ENTITLEMENT_CHANGED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  f.store.run('UPDATE web_accounts SET active=1 WHERE principal_id=?', f.guest.principalId);
  assert.equal(f.publisher.publish(f.publishClaim).footerMessageId, null);
});

test('108 checks full WAV bytes before any publication write', (t) => {
  const f = readyToPublish(t),
    path = join(f.root, 'private-audio', `${f.staged.mediaId}.wav`);
  writeFileSync(path, tone(300));
  assert.throws(() => f.publisher.publish(f.publishClaim), /WEB_PRIVATE_AUDIO_INTEGRITY/);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  writeFileSync(path, f.wav);
  assert.equal(f.publisher.publish(f.publishClaim).messageIds.length, 1);
});

test('108 two local processes race one publication and converge on one receipt', async (t) => {
  const f = readyToPublish(t);
  const childPath = fileURLToPath(new URL('../fixtures/publish-child.ts', import.meta.url));
  const runChild = () =>
    new Promise<{ operationId: string; messageIds: string[] }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [childPath, f.root, f.instanceId, JSON.stringify(f.publishClaim), String(f.clock.now())],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '',
        error = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => {
        output += chunk;
      });
      child.stderr.setEncoding('utf8').on('data', (chunk) => {
        error += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error))));
    });
  const [first, second] = await Promise.all([runChild(), runChild()]);
  assert.deepEqual(second, first);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 1);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 1);
});
