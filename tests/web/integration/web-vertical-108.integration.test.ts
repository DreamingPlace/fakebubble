import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebSyntheticPrivateAudio } from '../../../apps/server/audio/web-private-audio.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebStore } from '../../../apps/server/platform/store.ts';
import { WebVerticalPublisher } from '../../../apps/server/conversation/web-vertical-publisher.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { textRequest } from '../../text-fixtures.ts';
import { tone } from '../../audio-fixtures.ts';

const origin = 'https://c-verify.example.test';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const raceWorker = fileURLToPath(new URL('./web-vertical-publish-race-worker.mjs', import.meta.url));

function fixture(t: test.TestContext, migrate = true) {
  const parent = mkdtempSync(join(realpathSync(tmpdir()), 'web-c-vertical-'));
  const root = join(parent, 'web'),
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
  if (migrate) store.migrateVerticalCandidate();
  let now = 1_700_000_000_000;
  const clock = { now: () => now };
  const identity = new WebIdentity(store, {
    origin,
    cookieName: '__Host-c_session',
    clock,
    keys: { keyId: 'synthetic', sealKey: Buffer.alloc(32, 11), requestKey: Buffer.alloc(32, 12) },
  });
  const guest = identity.bootstrap(),
    token = guest.issuedToken!;
  let currentToken = token;
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'character',
    1,
    JSON.stringify({ ...textRequest().character, id: 'character' }),
  );
  store.run("INSERT INTO world_characters VALUES (?,?,'new')", identity.authenticate(token).world_id, 'character');
  const admission = new WebAdmission(store, clock, randomUUID);
  const queue = new WebStageQueue(store, clock, randomUUID);
  const coordinator = queue.acquireCoordinator('c-verifier');
  const ledger = new WebDispatchLedger(store, clock);
  const publisher = new WebVerticalPublisher(store, clock);
  const audio = new WebSyntheticPrivateAudio(store, clock);
  for (const phase of ['draft', 'review'] as const)
    ledger.configureBudget({ provider: 'fake', stage: 'text', phase, capacity: 3 });
  ledger.configureBudget({ provider: 'fake', stage: 'audio', phase: 'speech', capacity: 3 });
  function admit(input: string) {
    return admission.admit({
      principalId: guest.principalId,
      requestId: randomUUID(),
      characterId: 'character',
      text: input,
      ipHash: 'c'.repeat(64),
    });
  }
  function prepare(
    input: string,
    sensitive = false,
    relationship = false,
    withdrawalAt?: 'before-audio-reserve' | 'before-audio-mark-sent',
  ) {
    const op = admit(input);
    const claim = queue.claimText(coordinator, `text-${input}`)!;
    assert.equal(claim.operationId, op.operationId);
    const request = readWebV7Request(store, op.operationId).request;
    const draft = {
      mode: 'casual',
      utterance: { text: sensitive ? '我听见你想靠着我。' : `关于港口，${input}。`, expression: 'neutral' },
      afterthoughts: input === 'two-bubbles' ? [{ text: '再补充一句。', expression: 'neutral' }] : [],
      endsSession: false,
    };
    const anchor = request.messages.find((message) => message.authorKind === 'character');
    if (relationship) assert(anchor, 'a trusted prior character message is required for this event');
    const review = {
      decision: 'accept',
      replacementBubbles: [],
      factOps: [],
      topics: [
        {
          key: '港口',
          memoryId: null,
          importance: 3,
          summary: `玩家谈到港口：${input}`,
          sourceKind: 'conversation',
          evidenceMessageIds: [claim.inputMessageId],
        },
      ],
      coverage: {
        [claim.inputMessageId]: {
          status: 'answered',
          supportQuote: sensitive ? '靠着' : input,
          missingInformation: '',
        },
      },
      relationshipEvents:
        relationship && anchor
          ? [
              {
                kind: 'support',
                key: '港口互相支持',
                anchor: { messageId: anchor.id, quote: anchor.text },
                evidence: [{ messageId: claim.inputMessageId, quote: input }],
                responseQuote: sensitive ? '靠着我' : '关于港口',
                summary: '接续前序聊天并回应玩家。',
                basis: 'in_chat',
                repairsEventId: null,
              },
            ]
          : [],
      sceneUpdate: sensitive
        ? {
            scene: { kind: 'together', setting: '虚构河边', plan: null, proximity: 'close', speaking: 'quiet' },
            evidence: [{ messageId: claim.inputMessageId, quote: '靠着你' }],
            responseQuote: '靠着我',
          }
        : null,
    };
    for (const phase of ['draft', 'review'] as const) {
      const output = phase === 'draft' ? draft : review;
      const key = ledger.reserve(claim, {
        phase,
        ordinal: -1,
        provider: 'fake',
        providerRequestId: `${phase}-${input}`,
      });
      ledger.markSent(claim, key);
      ledger.confirm(key, {
        outcome: 'succeeded',
        receipt: { origin: 'synthetic_test', outputDigest: digest(output) },
        usage: { calls: 1 },
      });
    }
    queue.completeReviewedText(claim, { draft, review });
    const player = identity.authenticate(currentToken);
    const mediaIds: string[] = [];
    for (let ordinal = 0; ordinal <= draft.afterthoughts.length; ordinal++) {
      const audioClaim = queue.claimAudio(coordinator, `audio-${input}-${ordinal}`)!;
      if (withdrawalAt === 'before-audio-reserve') admit('等等，先别靠近。');
      const key = ledger.reserve(audioClaim, {
        phase: 'speech',
        ordinal,
        provider: 'fake',
        providerRequestId: `speech-${input}-${ordinal}`,
      });
      if (withdrawalAt === 'before-audio-mark-sent') admit('等等，先别靠近。');
      ledger.markSent(audioClaim, key);
      ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
      mediaIds.push(
        audio.stage(
          {
            operationId: op.operationId,
            ordinal,
            principalId: guest.principalId,
            playerId: player.player_id,
            worldId: claim.worldId,
            conversationId: claim.conversationId,
            characterId: claim.characterId,
            inputMessageId: claim.inputMessageId,
          },
          coordinator,
          tone(250),
        ).mediaId,
      );
    }
    return {
      request,
      op,
      mediaIds,
      publicationClaim: publisher.claim(coordinator, op.operationId, `publisher-${input}`),
    };
  }
  function publish(input: string) {
    const prepared = prepare(input);
    return { ...prepared, receipt: publisher.publish(prepared.publicationClaim) };
  }
  return {
    store,
    root,
    instanceId,
    identity,
    token,
    guest,
    admission,
    queue,
    coordinator,
    ledger,
    publisher,
    admit,
    prepare,
    publish,
    closeOriginal: () => {
      store.close();
      closed = true;
    },
    useToken: (next: string) => {
      currentToken = next;
    },
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function racePublish(t: test.TestContext, root: string, instanceId: string, claim: unknown, now: number) {
  const children = [0, 1].map(() =>
    spawn(process.execPath, [raceWorker, root, instanceId, JSON.stringify(claim), String(now)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  );
  t.after(() => {
    for (const child of children) if (child.exitCode === null) child.kill();
  });
  const results = children.map(
    (child) =>
      new Promise<{ ok: boolean; receipt?: { messageIds: string[] }; error?: string }>((resolve, reject) => {
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
          if (code !== 0) reject(new Error(`C publish child ${code}: ${error}`));
          else
            try {
              resolve(JSON.parse(output) as { ok: boolean; receipt?: { messageIds: string[] } });
            } catch {
              reject(new Error(`C publish child output ${output}; ${error}`));
            }
        });
      }),
  );
  for (const child of children) child.stdin.end('go\n');
  return Promise.all(results);
}

test('C-S3-006 A-WEB-009 reservation audit refuses under/over-debits before 107→108 DDL', (t) => {
  const f = fixture(t, false),
    op = f.admit('original');
  const original = f.store.get<{ ip_window_id: string; deadline_at: number; metering_type?: string }>(
    'SELECT * FROM web_operations WHERE id=?',
    op.operationId,
  )!;
  for (const [table, id, column] of [
    ['web_principals', f.guest.principalId, 'trial_reserved'],
    ['web_ip_windows', original.ip_window_id, 'reserved'],
  ] as const) {
    for (const wrong of [0, 2]) {
      f.store.run(`UPDATE ${table} SET ${column}=? WHERE id=?`, wrong, id);
      assert.throws(() => f.store.migrateVerticalCandidate(), /WEB_VERTICAL_TRIAL_RESERVATION_MISMATCH/);
      assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
      assert.equal(
        f.store.get<{ notnull: number }>(
          `SELECT "notnull" FROM pragma_table_info('web_operations') WHERE name='ip_window_id'`,
        )?.notnull,
        1,
      );
      assert.equal(
        f.store.get<{ deadline_at: number }>('SELECT deadline_at FROM web_operations WHERE id=?', op.operationId)
          ?.deadline_at,
        original.deadline_at,
      );
    }
    f.store.run(`UPDATE ${table} SET ${column}=1 WHERE id=?`, id);
  }
  f.store.migrateVerticalCandidate();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
  assert.equal(
    f.store.get<{ metering_type: string; ip_window_id: string }>(
      'SELECT metering_type,ip_window_id FROM web_operations WHERE id=?',
      op.operationId,
    )?.metering_type,
    'trial',
  );
});

test('C-S3-006 R1 sensitive later input blocks both audio reservation and mark-sent before extra provider use', (t) => {
  for (const stage of ['before-audio-reserve', 'before-audio-mark-sent'] as const) {
    const f = fixture(t);
    assert.throws(() => f.prepare('我在虚构河边，想靠着你。', true, false, stage), /SCENE_INPUT_CHANGED/);
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
    assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
    assert.equal(
      f.store.get<{ n: number }>(
        "SELECT count(*) n FROM web_external_attempts WHERE stage='audio' AND sent_at IS NOT NULL",
      )?.n,
      0,
    );
    assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_operations WHERE status='queued'")?.n, 1);
  }
});

test('C-S3-006 two synthetic voice bubbles publish once with scoped history and audio', (t) => {
  const f = fixture(t),
    first = f.publish('two-bubbles');
  assert.equal(first.receipt.messageIds.length, 2);
  assert.deepEqual(f.publisher.publish(first.publicationClaim), first.receipt);
  const principal = f.identity.authenticate(f.token);
  const scope = {
    principalId: f.guest.principalId,
    playerId: principal.player_id,
    worldId: principal.world_id,
    conversationId: first.request.scope.conversationId,
    characterId: first.request.scope.characterId,
  };
  const history = f.publisher.history(scope);
  assert.equal(history.length, 1);
  assert.deepEqual(history[0]!.receipt, first.receipt);
  assert.deepEqual(
    history[0]!.items.map((item) => item.origin),
    ['narrative', 'narrative'],
  );
  for (const mediaId of first.mediaIds) assert.deepEqual(f.publisher.readPublishedAudio(scope, mediaId), tone(250));
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_user_events')?.n, 1);
  assert.equal(
    f.store.get<{ trial_used: number }>('SELECT trial_used FROM web_principals WHERE id=?', f.guest.principalId)
      ?.trial_used,
    1,
  );
});

test('C-S3-006 final event failure rolls back narrative, memory, quota and receipt before same-claim replay', (t) => {
  const f = fixture(t),
    prepared = f.prepare('rollback');
  f.store.run(`CREATE TRIGGER c_reject_event BEFORE INSERT ON web_user_events
    BEGIN SELECT RAISE(ABORT,'C_REJECT_EVENT'); END`);
  assert.throws(() => f.publisher.publish(prepared.publicationClaim), /C_REJECT_EVENT/);
  for (const table of [
    'web_publications',
    'web_publication_items',
    'memory_episodes',
    'memory_mentions',
    'web_user_events',
    'jobs',
    'dialogue_bubbles',
  ])
    assert.equal(f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)?.n, 0, table);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.deepEqual(
    {
      ...f.store.get<{ trial_reserved: number; trial_used: number }>(
        'SELECT trial_reserved,trial_used FROM web_principals WHERE id=?',
        f.guest.principalId,
      ),
    },
    { trial_reserved: 1, trial_used: 0 },
  );
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', prepared.op.operationId)?.status,
    'ready_to_publish',
  );
  f.store.run('DROP TRIGGER c_reject_event');
  const receipt = f.publisher.publish(prepared.publicationClaim);
  assert.equal(receipt.messageIds.length, 1);
  assert.deepEqual(f.publisher.publish(prepared.publicationClaim), receipt);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_user_events')?.n, 1);
});

test('C-S3-006 A-WEB-011 later real withdrawal prevents a frozen together/close/quiet publication', (t) => {
  const f = fixture(t);
  const prepared = f.prepare('我在虚构河边，想靠着你。', true);
  const withdrawal = f.admit('等等，先别靠近。');
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', withdrawal.operationId)?.status,
    'queued',
  );
  assert.throws(
    () => f.publisher.publish(prepared.publicationClaim),
    /SCENE_INPUT_CHANGED|WEB_PUBLICATION_CONTEXT_CHANGED/,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM scene_events')?.n, 0);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_user_events')?.n, 0);
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_external_attempts WHERE outcome='succeeded'")?.n,
    3,
  );
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', withdrawal.operationId)?.status,
    'queued',
  );
});

test('C-S3-006 later ordinary queued input does not cancel a non-sensitive reply', (t) => {
  const f = fixture(t),
    prepared = f.prepare('ordinary');
  const later = f.admit('later ordinary input');
  assert.equal(f.publisher.publish(prepared.publicationClaim).messageIds.length, 1);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', later.operationId)?.status,
    'queued',
  );
});

test('C-S3-006 same-IP distinct guest has no first guest publication in frozen v7 request', (t) => {
  const f = fixture(t),
    first = f.publish('private-first');
  const other = f.identity.bootstrap(),
    otherToken = other.issuedToken!;
  f.store.run(
    "INSERT INTO world_characters VALUES (?,?,'new')",
    f.identity.authenticate(otherToken).world_id,
    'character',
  );
  const op = f.admission.admit({
    principalId: other.principalId,
    requestId: randomUUID(),
    characterId: 'character',
    text: 'other-first',
    ipHash: 'c'.repeat(64),
  });
  const claim = f.queue.claimText(f.coordinator, 'other-text')!;
  assert.equal(claim.operationId, op.operationId);
  const request = readWebV7Request(f.store, op.operationId).request;
  assert.deepEqual(
    request.messages.map((message) => message.id),
    [claim.inputMessageId],
  );
  assert(!request.messages.some((message) => first.receipt.messageIds.includes(message.id)));
  assert.deepEqual(request.memories, []);
});

test('C-S3-006 guest third turn retains short dialogue but cannot receive promoted long-term memory', (t) => {
  const f = fixture(t);
  const first = f.publish('first');
  const second = f.publish('second');
  const topic = f.store.get<{ tier: string; player_mentions: number }>(
    "SELECT tier,player_mentions FROM memory_topics WHERE topic_key='港口'",
  )!;
  assert.deepEqual({ ...topic }, { tier: 'long', player_mentions: 2 });
  const third = f.admit('third');
  const claim = f.queue.claimText(f.coordinator, 'text-third')!;
  assert.equal(claim.operationId, third.operationId);
  const request = readWebV7Request(f.store, third.operationId).request;
  assert(request.messages.some((message) => message.id === first.receipt.messageIds[0]));
  assert(request.messages.some((message) => message.id === second.receipt.messageIds[0]));
  assert(request.shortTermTurns?.some((turn) => turn.id === first.receipt.operationId));
  assert(
    !request.memories?.some((memory) => memory.tier === 'long'),
    'guest is not entitled to long-term memory recall even when the topic was promoted',
  );
});

test('C-S3-006 real account upgrade retains same world and unlocks promoted memory in the next request', async (t) => {
  const f = fixture(t);
  const first = f.publish('first'),
    second = f.publish('second');
  const before = f.identity.authenticate(f.token);
  const registered = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: randomUUID(),
    username: 'c_verifier_account',
    password: 'synthetic-password',
  });
  const after = f.identity.authenticate(registered.issuedToken);
  assert.equal(after.kind, 'account');
  assert.equal(after.world_id, before.world_id);
  assert.equal(after.player_id, before.player_id);
  const op = f.admit('third-account'),
    claim = f.queue.claimText(f.coordinator, 'account-text')!;
  assert.equal(claim.operationId, op.operationId);
  const request = readWebV7Request(f.store, op.operationId).request;
  assert(request.memories?.some((memory) => memory.tier === 'long' && memory.key === '港口'));
  assert(request.messages.some((message) => message.id === first.receipt.messageIds[0]));
  assert(request.messages.some((message) => message.id === second.receipt.messageIds[0]));
});

test('C-S3-006 R1 third guest reply adds exactly one synthetic footer, never narrative context', async (t) => {
  const f = fixture(t);
  f.publish('first');
  f.publish('second');
  const footerMediaId = f.publisher.registerSyntheticFooter('character', tone(200));
  const third = f.publish('third');
  assert.equal(third.receipt.messageIds.length, 1);
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
  assert.equal(
    f.store.get<{ n: number }>(
      'SELECT count(*) n FROM memory_mentions WHERE message_id=?',
      third.receipt.footerMessageId,
    )?.n,
    0,
  );
  assert.equal(
    f.store.get<{ n: number }>(
      "SELECT count(*) n FROM web_publication_items WHERE media_id=? AND origin='trial_footer'",
      footerMediaId,
    )?.n,
    1,
  );
  assert.throws(() => f.admit('fourth-guest'), /TRIAL_EXHAUSTED/);
  const upgraded = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: randomUUID(),
    username: 'c_footer_account',
    password: 'synthetic-password',
  });
  f.useToken(upgraded.issuedToken);
  const fourth = f.admit('fourth-account'),
    claim = f.queue.claimText(f.coordinator, 'after-footer')!;
  assert.equal(claim.operationId, fourth.operationId);
  const request = readWebV7Request(f.store, fourth.operationId).request;
  assert(request.messages.some((message) => message.id === third.receipt.messageIds[0]));
  assert(!request.messages.some((message) => message.id === third.receipt.footerMessageId));
  assert(
    !request.shortTermTurns
      ?.flatMap((turn) => turn.messages)
      .some((message) => message.id === third.receipt.footerMessageId),
  );
});

test('C-S3-006 R1 in-flight Argon2 upgrade settles original trial without footer; next entitled turn publishes', async (t) => {
  const f = fixture(t);
  f.publish('first');
  f.publish('second');
  f.publisher.registerSyntheticFooter('character', tone(200));
  const pending = f.prepare('third-before-upgrade');
  const trial = f.store.get<{ metering_type: string; ip_window_id: string }>(
    'SELECT metering_type,ip_window_id FROM web_operations WHERE id=?',
    pending.op.operationId,
  )!;
  assert.equal(trial.metering_type, 'trial');
  const upgraded = await f.identity.register(f.token, f.guest.csrf, origin, {
    requestId: randomUUID(),
    username: 'c_inflight_account',
    password: 'synthetic-password',
  });
  f.useToken(upgraded.issuedToken);
  const receipt = f.publisher.publish(pending.publicationClaim);
  assert.equal(receipt.footerMessageId, null);
  assert.equal(
    f.store.get<{ used: number; reserved: number }>(
      'SELECT used,reserved FROM web_ip_windows WHERE id=?',
      trial.ip_window_id,
    )?.used,
    3,
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_publication_items WHERE origin='trial_footer'")?.n,
    0,
  );
  const entitled = f.publish('entitled-fourth');
  assert.equal(entitled.receipt.messageIds.length, 1);
  assert.equal(
    f.store.get<{ metering_type: string; ip_window_id: string | null }>(
      'SELECT metering_type,ip_window_id FROM web_operations WHERE id=?',
      entitled.op.operationId,
    )?.metering_type,
    'entitled',
  );
  assert.equal(
    f.store.get<{ ip_window_id: string | null }>(
      'SELECT ip_window_id FROM web_operations WHERE id=?',
      entitled.op.operationId,
    )?.ip_window_id,
    null,
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_ip_windows')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 4);
});

test('C-S3-006 R1 late event fault also rolls back nonempty scene and relationship ledgers', (t) => {
  const f = fixture(t),
    first = f.publish('first');
  const pending = f.prepare('我在虚构河边，想靠着你。', true, true);
  assert(pending.request.messages.some((message) => message.id === first.receipt.messageIds[0]));
  f.store.run(`CREATE TRIGGER c_reject_second_event BEFORE INSERT ON web_user_events
    BEGIN SELECT RAISE(ABORT,'C_REJECT_SECOND_EVENT'); END`);
  assert.throws(() => f.publisher.publish(pending.publicationClaim), /C_REJECT_SECOND_EVENT/);
  for (const table of ['scene_events', 'relationship_events', 'relationship_reviews', 'relationship_daily_budgets'])
    assert.equal(f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)?.n, 0, table);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 1);
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 1);
  assert.equal(
    f.store.get<{ trial_used: number; trial_reserved: number }>(
      'SELECT trial_used,trial_reserved FROM web_principals WHERE id=?',
      f.guest.principalId,
    )?.trial_used,
    1,
  );
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', pending.op.operationId)?.status,
    'ready_to_publish',
  );
  f.store.run('DROP TRIGGER c_reject_second_event');
  assert.equal(f.publisher.publish(pending.publicationClaim).messageIds.length, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM scene_events')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM relationship_events')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM relationship_daily_budgets')?.n, 1);
});

test('C-S3-006 R1 reopen reuses frozen request, reviewed candidate and audio without provider replay', (t) => {
  const f = fixture(t),
    pending = f.prepare('restart');
  const attempts = f.store
    .all<Record<string, unknown>>(
      'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase,ordinal',
      pending.op.operationId,
    )
    .map((row) => ({ ...row }));
  const player = f.identity.authenticate(f.token);
  f.closeOriginal();
  const reopen = new WebStore(f.root, { create: false, instanceId: f.instanceId });
  t.after(() => reopen.close());
  assert.equal(reopen.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
  assert.deepEqual(readWebV7Request(reopen, pending.op.operationId).request, pending.request);
  assert.equal(
    reopen.get<{ n: number }>('SELECT count(*) n FROM web_v7_candidates WHERE operation_id=?', pending.op.operationId)
      ?.n,
    1,
  );
  assert.equal(
    reopen.get<{ n: number }>(
      'SELECT count(*) n FROM web_private_audio_assets WHERE operation_id=?',
      pending.op.operationId,
    )?.n,
    1,
  );
  const publisher = new WebVerticalPublisher(reopen, { now: f.now });
  const receipt = publisher.publish(pending.publicationClaim);
  assert.deepEqual(publisher.publish(pending.publicationClaim), receipt);
  assert.deepEqual(
    reopen
      .all<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase,ordinal',
        pending.op.operationId,
      )
      .map((row) => ({ ...row })),
    attempts,
  );
  f.advance(24 * 60 * 60 * 1000);
  const scope = {
    principalId: f.guest.principalId,
    playerId: player.player_id,
    worldId: player.world_id,
    conversationId: pending.request.scope.conversationId,
    characterId: pending.request.scope.characterId,
  };
  assert.equal(publisher.history(scope).length, 1);
  assert.deepEqual(publisher.readPublishedAudio(scope, pending.mediaIds[0]!), tone(250));
});

test('C-S3-006 R1 two actual Node processes converge on one publication and one memory/event debit', async (t) => {
  const f = fixture(t),
    pending = f.prepare('race');
  const settled = await racePublish(t, f.root, f.instanceId, pending.publicationClaim, f.now());
  assert(
    settled.every((result) => result.ok),
    JSON.stringify(settled),
  );
  assert.deepEqual(settled[0]!.receipt, settled[1]!.receipt);
  for (const table of [
    'web_publications',
    'web_publication_items',
    'memory_episodes',
    'memory_mentions',
    'web_user_events',
    'jobs',
  ])
    assert.equal(f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)?.n, 1, table);
  assert.equal(
    f.store.get<{ trial_used: number; trial_reserved: number }>(
      'SELECT trial_used,trial_reserved FROM web_principals WHERE id=?',
      f.guest.principalId,
    )?.trial_used,
    1,
  );
});

test('C-S3-006 R2 two processes publish one nonempty relationship and consume daily budget once', async (t) => {
  const f = fixture(t);
  f.publish('first');
  const pending = f.prepare('我在虚构河边，想靠着你。', true, true);
  const settled = await racePublish(t, f.root, f.instanceId, pending.publicationClaim, f.now());
  assert(
    settled.every((result) => result.ok),
    JSON.stringify(settled),
  );
  assert.deepEqual(settled[0]!.receipt, settled[1]!.receipt);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM relationship_events')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM relationship_reviews')?.n, 1);
  assert.deepEqual(
    {
      ...f.store.get<{ positive_used: number; negative_used: number }>(
        'SELECT positive_used,negative_used FROM relationship_daily_budgets',
      ),
    },
    { positive_used: 1, negative_used: 0 },
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM scene_events')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 2);
  assert.equal(
    f.store.get<{ trial_used: number }>('SELECT trial_used FROM web_principals WHERE id=?', f.guest.principalId)
      ?.trial_used,
    2,
  );
});

test('C-S3-006 R1 old epoch and original 300-second deadline fence publication without duplicate cost', (t) => {
  const f = fixture(t),
    pending = f.prepare('lease');
  const before = f.store
    .all<Record<string, unknown>>(
      'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase,ordinal',
      pending.op.operationId,
    )
    .map((row) => ({ ...row }));
  f.advance(30_000);
  const takeover = f.queue.acquireCoordinator('takeover');
  assert.throws(() => f.publisher.publish(pending.publicationClaim), /WEB_COORDINATOR_STALE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  f.publisher.recover(takeover, pending.op.operationId);
  const reClaim = f.publisher.claim(takeover, pending.op.operationId, 'reclaimed');
  assert.equal(f.publisher.publish(reClaim).messageIds.length, 1);
  assert.deepEqual(
    f.store
      .all<Record<string, unknown>>(
        'SELECT * FROM web_external_attempts WHERE operation_id=? ORDER BY stage,phase,ordinal',
        pending.op.operationId,
      )
      .map((row) => ({ ...row })),
    before,
  );

  const late = fixture(t),
    expiring = late.prepare('expires');
  late.advance(300_000);
  assert.throws(() => late.publisher.publish(expiring.publicationClaim), /WEB_COORDINATOR_STALE|WEB_STAGE_STALE/);
  assert.equal(late.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')?.n, 0);
  assert.equal(late.store.get<{ n: number }>("SELECT count(*) n FROM messages WHERE author_kind='character'")?.n, 0);
});

test('C-S3-006 R1 107→108 keeps queued input and terminal UNKNOWN external ticket unchanged', (t) => {
  const f = fixture(t, false),
    first = f.admit('first'),
    second = f.admit('second');
  const claim = f.queue.claimText(f.coordinator, 'unknown-worker')!;
  assert.equal(claim.operationId, first.operationId);
  const key = f.ledger.reserve(claim, {
    phase: 'draft',
    ordinal: -1,
    provider: 'fake',
    providerRequestId: randomUUID(),
  });
  f.ledger.markSent(claim, key);
  f.ledger.terminate(f.coordinator, f.ledger.fence(first.operationId), f.guest.principalId, 'cancelled', 'cancel');
  const tables = [
    'web_operations',
    'web_external_attempts',
    'web_external_budgets',
    'web_input_snapshots',
    'web_principals',
    'web_ip_windows',
    'messages',
  ];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      f.store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => ({ ...row })),
    ]),
  );
  f.store.migrateVerticalCandidate();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
  for (const table of tables) {
    const after = f.store
      .all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`)
      .map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'metering_type')));
    assert.deepEqual(after, before[table], table);
  }
  assert.equal(
    f.store.get<{ metering_type: string; status: string }>(
      'SELECT metering_type,status FROM web_operations WHERE id=?',
      second.operationId,
    )?.metering_type,
    'trial',
  );
  assert.equal(
    f.store.get<{ dispatch_state: string }>(
      "SELECT dispatch_state FROM web_external_attempts WHERE operation_id=? AND stage='text'",
      first.operationId,
    )?.dispatch_state,
    'unknown',
  );
});

test('C-S3-006 R2 107→108 late DDL and final FK faults roll every schema change back', (t) => {
  const ddl = fixture(t, false);
  ddl.store.run('CREATE TABLE web_v7_requests(collision INTEGER)');
  assert.throws(() => ddl.store.migrateVerticalCandidate(), /already exists/);
  assert.equal(ddl.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
  assert.equal(
    ddl.store.get<{ notnull: number }>(
      `SELECT "notnull" FROM pragma_table_info('web_operations') WHERE name='ip_window_id'`,
    )?.notnull,
    1,
  );
  assert.equal(
    ddl.store.get(`SELECT 1 FROM pragma_table_info('web_operations') WHERE name='metering_type'`),
    undefined,
  );
  assert.equal(ddl.store.get<{ n: number }>(`SELECT count(*) n FROM pragma_table_info('web_v7_requests')`)?.n, 1);

  const fk = fixture(t, false),
    op = fk.admit('orphan');
  fk.store.db.exec('PRAGMA foreign_keys=OFF');
  fk.store.run('UPDATE messages SET conversation_id=? WHERE id=?', 'orphan', op.inputMessageId);
  fk.store.db.exec('PRAGMA foreign_keys=ON');
  assert.throws(() => fk.store.migrateVerticalCandidate(), /WEB_VERTICAL_FOREIGN_KEY_INVALID/);
  assert.equal(fk.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 107);
  assert.equal(
    fk.store.get<{ notnull: number }>(
      `SELECT "notnull" FROM pragma_table_info('web_operations') WHERE name='ip_window_id'`,
    )?.notnull,
    1,
  );
  assert.equal(fk.store.get(`SELECT 1 FROM pragma_table_info('web_operations') WHERE name='metering_type'`), undefined);
  assert.equal(fk.store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_publications'), undefined);
  assert.equal(
    fk.store.get<{ conversation_id: string }>('SELECT conversation_id FROM messages WHERE id=?', op.inputMessageId)
      ?.conversation_id,
    'orphan',
  );
});

test('C-S3-006 R2 107 terminal known receipt and verified private bytes survive explicit 108 migration', (t) => {
  const f = fixture(t, false),
    op = f.admit('legacy-asset');
  const text = f.queue.claimText(f.coordinator, 'legacy-text')!;
  const snapshot = f.queue.inputSnapshot({
    operation_id: text.operationId,
    principal_id: text.principalId,
    world_id: text.worldId,
    conversation_id: text.conversationId,
    character_id: text.characterId,
    input_message_id: text.inputMessageId,
  });
  f.queue.completeText(text, {
    narrative: ['旧合成片'],
    inputVersion: snapshot.input_digest,
    characterVersion: String(snapshot.template_version),
    templateVersion: snapshot.template_digest,
    voiceVersion: 'synthetic-voice',
    accessRevision: snapshot.access_revision,
    usage: {},
  });
  const audioClaim = f.queue.claimAudio(f.coordinator, 'legacy-audio')!;
  const key = f.ledger.reserve(audioClaim, {
    phase: 'speech',
    ordinal: 0,
    provider: 'fake',
    providerRequestId: randomUUID(),
  });
  f.ledger.markSent(audioClaim, key);
  f.ledger.confirm(key, { outcome: 'succeeded', receipt: { origin: 'synthetic_test' }, usage: { calls: 1 } });
  const principal = f.identity.authenticate(f.token),
    bytes = tone(250);
  const staged = new WebSyntheticPrivateAudio(f.store, { now: f.now }).stage(
    {
      operationId: op.operationId,
      ordinal: 0,
      principalId: f.guest.principalId,
      playerId: principal.player_id,
      worldId: text.worldId,
      conversationId: text.conversationId,
      characterId: text.characterId,
      inputMessageId: text.inputMessageId,
    },
    f.coordinator,
    bytes,
  );
  f.ledger.terminate(f.coordinator, f.ledger.fence(op.operationId), f.guest.principalId, 'cancelled', 'cancel');
  const tables = [
    'web_operations',
    'web_external_attempts',
    'web_private_audio_assets',
    'web_reviewed_candidates',
    'web_synthetic_voice_segments',
    'web_input_snapshots',
    'web_principals',
    'web_ip_windows',
    'messages',
  ];
  const before = Object.fromEntries(
    tables.map((table) => [
      table,
      f.store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).map((row) => ({ ...row })),
    ]),
  );
  const mediaPath = join(f.root, 'private-audio', `${staged.mediaId}.wav`);
  assert.deepEqual(readFileSync(mediaPath), bytes);
  f.store.migrateVerticalCandidate();
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 108);
  for (const table of tables) {
    const after = f.store
      .all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`)
      .map((row) => Object.fromEntries(Object.entries(row).filter(([name]) => name !== 'metering_type')));
    assert.deepEqual(after, before[table], table);
  }
  assert.deepEqual(readFileSync(mediaPath), bytes);
  assert.equal(
    f.store.get<{ state: string }>('SELECT state FROM web_private_audio_assets WHERE media_id=?', staged.mediaId)
      ?.state,
    'synthetic_asset_verified',
  );
});
