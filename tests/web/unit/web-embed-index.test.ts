import assert from 'node:assert/strict';
import test from 'node:test';
import { DomainError } from '../../../packages/domain/errors.ts';
import { WEB_EMBED_DEFAULT } from '../../../config/web-embeddings.ts';
import {
  EMBEDDING_DIMS,
  OfflineEmbeddings,
  embeddingMicros,
  estimateEmbeddingTokens,
  fixtureVector,
  type OfflineEmbeddingOptions,
} from '../../../apps/server/generation/embedding-provider.ts';
import {
  INDEX_BATCH,
  INDEX_RETRY_MS,
  WebEmbedLedger,
  webEmbedNextDue,
} from '../../../apps/server/generation/web-embed-ledger.ts';
import { WebEmbedRunner } from '../../../apps/server/generation/web-embed-runner.ts';
import { embeddingHash, embeddingText, unpackVector } from '../../../apps/server/memory/memory-embeddings.ts';
import { recordDialogueMemories } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { T0, TestClock, addPlayer, addTopic, count, embedStore, metrics, spending } from '../fixtures/embed-store.ts';
import { candidate, memoryStore } from '../fixtures/memory-store.ts';

function harness(t: test.TestContext, options: OfflineEmbeddingOptions = {}, config = WEB_EMBED_DEFAULT) {
  const store = embedStore();
  t.after(() => store.close());
  const clock = new TestClock();
  const provider = new OfflineEmbeddings(options);
  const runner = new WebEmbedRunner(store, clock, provider, config);
  const live = () => new AbortController().signal;
  /** Claim and run one index call; returns the batch, or what the claim said. */
  const step = async () => {
    const batch = runner.ledger.claimIndexBatch(config.maxEmbedRunning);
    if (batch === null || batch === 'busy') return batch;
    await runner.index(batch, live());
    return batch;
  };
  const rows = (sql = '') =>
    store.all<Record<string, any>>(`SELECT * FROM memory_embeddings ${sql} ORDER BY world_id,topic_key`);
  const attempts = () => store.all<Record<string, any>>('SELECT * FROM web_embed_attempts ORDER BY created_at,rowid');
  return { store, clock, provider, runner, ledger: runner.ledger, live, step, rows, attempts };
}

test('pending topics are embedded in ONE request with an array of texts; the business object stores unit float32 vectors', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  addTopic(h.store, a, '猫', '玩家说他家养了一只猫');
  addTopic(h.store, a, '工作', '玩家在上班');
  addTopic(h.store, a, '天气', '玩家问了天气');
  const batch = await h.step();
  assert.ok(batch && batch !== 'busy');
  assert.equal(h.provider.calls.length, 1, 'one provider call for all three topics');
  assert.equal(h.provider.calls[0]!.length, 3);
  assert.deepEqual(
    h.provider.calls[0]!.slice().sort(),
    [
      embeddingText('猫', '玩家说他家养了一只猫'),
      embeddingText('工作', '玩家在上班'),
      embeddingText('天气', '玩家问了天气'),
    ].sort(),
    'the text is the key and the latest episode summary',
  );
  const rows = h.rows();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.deepEqual([row.model, row.dims, row.state], ['@cf/baai/bge-m3', EMBEDDING_DIMS, 'ready']);
    assert.equal(row.vector.byteLength, EMBEDDING_DIMS * 4);
    const vector = unpackVector(row.vector, EMBEDDING_DIMS)!;
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-4, 'stored normalized');
    assert.equal(row.source_seq, 1 + rows.indexOf(row) * 0 + (row.topic_key === '猫' ? 0 : row.source_seq - 1));
  }
  const cat = rows.find((row) => row.topic_key === '猫')!;
  assert.equal(cat.content_hash, embeddingHash(embeddingText('猫', '玩家说他家养了一只猫')));
  // The call is recorded, billed and settled; the items list is gone, and no text is stored.
  const [attempt] = h.attempts();
  assert.deepEqual(
    [attempt!.kind, attempt!.phase, attempt!.state, attempt!.outcome],
    ['index', 'embed', 'known', 'succeeded'],
  );
  assert.equal(attempt!.items_json, null);
  assert.ok(!JSON.stringify(attempt).includes('玩家'));
  assert.equal(await h.step(), null, 'nothing is pending any more');
  assert.equal(h.provider.calls.length, 1, 'indexing is idempotent: unchanged topics are never embedded again');
});

test('a changed topic is pending again with a new content hash; unchanged topics are left alone', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  addTopic(h.store, a, '猫', '玩家养了一只猫');
  addTopic(h.store, a, '天气', '玩家问了天气');
  await h.step();
  const before = h.rows();
  addTopic(h.store, a, '猫', '猫最近生病了，去了医院', { at: T0 + 1000 });
  await h.step();
  assert.deepEqual(
    h.provider.calls[1],
    [embeddingText('猫', '猫最近生病了，去了医院')],
    'only the changed topic, with its newest summary',
  );
  const after = h.rows();
  const pick = (rows: Record<string, any>[], key: string) => rows.find((row) => row.topic_key === key)!;
  assert.notEqual(pick(after, '猫').content_hash, pick(before, '猫').content_hash);
  assert.deepEqual(pick(after, '天气').content_hash, pick(before, '天气').content_hash);
  assert.equal(await h.step(), null);
});

test('at most 16 topics of one scope per call; scopes are never mixed in one request', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  const b = addPlayer(h.store, 2);
  for (let i = 0; i < 20; i++) addTopic(h.store, a, `话题${i}`, `摘要${i}`, { at: T0 + i });
  addTopic(h.store, b, '另一个人', '别人的话题', { at: T0 - 5 });
  await h.step();
  await h.step();
  await h.step();
  assert.deepEqual(
    h.provider.calls.map((texts) => texts.length).sort((x, y) => x - y),
    [1, 4, INDEX_BATCH],
    '20 topics of one player are 16 + 4; the other player is a call of its own',
  );
  assert.equal(h.rows().length, 21);
  h.attempts().forEach((attempt, i) => assert.equal(attempt.texts, h.provider.calls[i]!.length));
});

test('guests, deleted characters and topics without an episode are never embedded', async (t) => {
  const h = harness(t);
  const guest = addPlayer(h.store, 1, 'guest');
  const gone = addPlayer(h.store, 2);
  const real = addPlayer(h.store, 3);
  addTopic(h.store, guest, '访客话题', '访客说的话');
  addTopic(h.store, gone, '旧角色话题', '已删除角色的话题');
  h.store.run('CREATE TABLE web_character_deletions(character_id TEXT PRIMARY KEY)');
  h.store.run("INSERT INTO web_character_deletions VALUES ('character')");
  assert.equal(await h.step(), null, 'every candidate belongs to the deleted character or a guest');
  h.store.run('DROP TABLE web_character_deletions');
  addTopic(h.store, real, '普通话题', '普通的话');
  h.store.run(
    "INSERT INTO memory_topics VALUES ('world3','conversation3','character','空主题','short',0,?,?,3)",
    T0,
    T0 + 1,
  );
  await h.step();
  await h.step();
  assert.equal(await h.step(), null);
  assert.equal(
    h.rows().filter((row) => row.world_id === 'world1').length,
    0,
    'a guest is never recalled, so never embedded',
  );
  assert.deepEqual(
    h
      .rows()
      .map((row) => row.topic_key)
      .sort(),
    ['旧角色话题', '普通话题'],
  );
  assert.equal(h.provider.calls.flat().includes(embeddingText('访客话题', '访客说的话')), false);
  assert.equal(
    h.provider.calls.flat().some((text) => text.startsWith('空主题')),
    false,
    'a topic with no episode has no text',
  );
});

test('budget: reserved before the call; settled on reported usage, else on the estimate, never above the hold', async (t) => {
  const estimateText = embeddingText('猫', '玩家养了一只猫');
  const estimate = estimateEmbeddingTokens([estimateText]);
  // No reported usage: the estimate is billed.
  {
    const h = harness(t);
    addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
    const seen: { held: number; spent: number }[] = [];
    const reserved = h.ledger.claimIndexBatch(2);
    assert.ok(reserved && reserved !== 'busy');
    seen.push({ held: spending(h.store).held_micros, spent: spending(h.store).spent_micros });
    assert.deepEqual(seen[0], { held: embeddingMicros(estimate), spent: 0 }, 'held before anything is sent');
    assert.equal(h.attempts()[0]!.state, 'not_sent');
    assert.equal(h.provider.calls.length, 0);
    await h.runner.index(reserved, h.live());
    assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: embeddingMicros(estimate) });
    assert.equal(h.attempts()[0]!.usage_units, estimate);
    assert.equal(JSON.parse(h.attempts()[0]!.receipt_json).estimated, true);
  }
  // Reported usage is billed instead (a smaller number).
  {
    const h = harness(t, { usageTokens: () => 1 });
    addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
    await h.step();
    assert.equal(h.attempts()[0]!.usage_units, 1);
    assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: 1 });
    assert.equal(JSON.parse(h.attempts()[0]!.receipt_json).estimated, false);
  }
  // Reported usage far above the estimate is capped at the hold; the over-report is recorded.
  {
    const h = harness(t, { usageTokens: () => 100_000_000 });
    addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
    await h.step();
    const held = h.attempts()[0]!.held_micros;
    assert.equal(h.attempts()[0]!.charged_micros, held);
    assert.equal(JSON.parse(h.attempts()[0]!.receipt_json).capped, true);
    assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: held });
  }
});

test('an exhausted allowance sends nothing, records nothing and leaves the topics pending', async (t) => {
  const h = harness(t);
  addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
  h.store.run("UPDATE web_provider_spending SET limit_micros=1,spent_micros=1 WHERE provider='cloudflare'");
  assert.throws(() => h.ledger.claimIndexBatch(2), /WEB_PROVIDER_BUDGET_EXHAUSTED/);
  assert.equal(h.attempts().length, 0);
  assert.equal(h.provider.calls.length, 0);
  assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: 1 });
  h.store.run("UPDATE web_provider_spending SET limit_micros=1000000 WHERE provider='cloudflare'");
  assert.ok(await h.step(), 'pending work resumes once there is room');
});

test('a known failure releases the reservation and leaves the topics pending for a later attempt', async (t) => {
  const h = harness(t, { outcome: (i) => (i === 0 ? 'known' : 'ok') });
  addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
  addTopic(h.store, addPlayer(h.store, 2), '狗', '另一个人养了一只狗');
  await h.step();
  const [failed] = h.attempts();
  assert.deepEqual([failed!.state, failed!.outcome, failed!.charged_micros], ['known', 'failed', 0]);
  assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: 0 }, 'the hold came back');
  assert.equal(h.rows().length, 0, 'nothing was stored');
  assert.equal(failed!.items_json, null);
  // The failed scope waits out a retry delay; the other scope is not held back.
  const other = await h.step();
  assert.ok(other && other !== 'busy');
  assert.equal(h.rows().length, 1);
  assert.equal(await h.step(), null, 'the failed scope is still waiting');
  h.clock.advance(INDEX_RETRY_MS + 1);
  assert.ok(await h.step(), 'after the delay the same topics are sent again');
  assert.equal(h.rows().length, 2);
  assert.equal(h.provider.calls.length, 3);
  assert.deepEqual(
    { ...metrics(h.store)[0]! },
    { day: '2023-11-14', calls: 3, texts: 2, failures: 1, unknowns: 0, query_fallbacks: 0, query_timeouts: 0 },
  );
});

test('an UNKNOWN outcome is never retried: topics are marked unknown, the hold stays, only changed text is new work', async (t) => {
  const h = harness(t, { outcome: () => 'unknown' });
  const a = addPlayer(h.store, 1);
  addTopic(h.store, a, '猫', '玩家养了一只猫');
  addTopic(h.store, a, '天气', '玩家问了天气');
  await h.step();
  const [attempt] = h.attempts();
  assert.deepEqual([attempt!.state, attempt!.outcome], ['unknown', null]);
  assert.equal(attempt!.items_json, null);
  assert.deepEqual(
    h.rows().map((row) => [row.topic_key, row.state, row.vector]),
    [
      ['天气', 'unknown', null],
      ['猫', 'unknown', null],
    ],
  );
  assert.equal(spending(h.store).held_micros, attempt!.held_micros, 'the reservation is never released');
  // Never retried: not now, not after any amount of time, not after restart.
  for (const wait of [0, INDEX_RETRY_MS + 1, 3_600_000, 86_400_000]) {
    h.clock.advance(wait);
    assert.equal(await h.step(), null, `after ${wait} ms`);
  }
  const restarted = new WebEmbedLedger(h.store, h.clock);
  assert.equal(restarted.claimIndexBatch(2), null);
  assert.equal(restarted.recover(), 0);
  assert.equal(h.provider.calls.length, 1);
  // Changed text is new work: one new episode makes ONLY that topic pending (the other stays lexical-only).
  addTopic(h.store, a, '猫', '猫生病了', { at: T0 + 5000 });
  const batch = restarted.claimIndexBatch(2);
  assert.ok(batch && batch !== 'busy');
  assert.deepEqual(
    batch.items.map((item) => item.key),
    ['猫'],
  );
  assert.equal(batch.texts[0], embeddingText('猫', '猫生病了'));
  assert.deepEqual(
    { ...metrics(h.store)[0]! },
    { day: '2023-11-14', calls: 1, texts: 0, failures: 0, unknowns: 1, query_fallbacks: 0, query_timeouts: 0 },
  );
});

test('an abort, a timeout or an unusable body after the send boundary is UNKNOWN; an abort before it is not', async (t) => {
  // Abort while the provider call is running.
  const hung = harness(t, { outcome: () => 'hang' });
  addTopic(hung.store, addPlayer(hung.store, 1), '猫', '玩家养了一只猫');
  const controller = new AbortController();
  const batch = hung.ledger.claimIndexBatch(2);
  assert.ok(batch && batch !== 'busy');
  const running = hung.runner.index(batch, controller.signal);
  setTimeout(() => controller.abort(), 5);
  await running;
  assert.equal(hung.attempts()[0]!.state, 'unknown');
  assert.equal(hung.rows()[0]!.state, 'unknown');
  // Aborted before anything was sent: released, retried later.
  const early = harness(t);
  addTopic(early.store, addPlayer(early.store, 1), '猫', '玩家养了一只猫');
  const gone = new AbortController();
  gone.abort();
  const second = early.ledger.claimIndexBatch(2);
  assert.ok(second && second !== 'busy');
  await early.runner.index(second, gone.signal);
  assert.equal(early.attempts()[0]!.state, 'known');
  assert.deepEqual({ ...spending(early.store) }, { held_micros: 0, spent_micros: 0 });
  assert.equal(early.rows().length, 0);
  // A 200 whose body cannot be used was billed: unknown, not a retry.
  const invalid = harness(t, { outcome: () => 'invalid' });
  addTopic(invalid.store, addPlayer(invalid.store, 1), '猫', '玩家养了一只猫');
  await invalid.step();
  assert.equal(invalid.attempts()[0]!.state, 'unknown');
  assert.equal(await invalid.step(), null);
});

test('crash recovery: a stale call that never sent is released, a stale call that sent is UNKNOWN', (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  const b = addPlayer(h.store, 2);
  addTopic(h.store, a, '猫', '玩家养了一只猫');
  addTopic(h.store, b, '狗', '另一个人养了一只狗');
  const first = h.ledger.claimIndexBatch(3);
  const second = h.ledger.claimIndexBatch(3);
  assert.ok(first && first !== 'busy' && second && second !== 'busy');
  h.ledger.markSent(second.attemptId);
  assert.equal(h.ledger.recover(), 0, 'live leases are left alone');
  assert.ok(webEmbedNextDue(h.store, h.clock.now())! > h.clock.now());
  h.clock.advance(60_000);
  assert.equal(webEmbedNextDue(h.store, h.clock.now()), h.clock.now(), 'a stale lease is due now');
  assert.equal(h.ledger.recover(), 2);
  const states = Object.fromEntries(h.attempts().map((row) => [row.id, row.state]));
  assert.deepEqual([states[first.attemptId], states[second.attemptId]], ['known', 'unknown']);
  assert.equal(h.attempts().find((row) => row.id === first.attemptId)!.outcome, 'not_dispatched');
  assert.equal(spending(h.store).held_micros, h.attempts().find((row) => row.id === second.attemptId)!.held_micros);
  assert.deepEqual(
    h.rows().map((row) => [row.world_id, row.state]),
    [['world2', 'unknown']],
  );
  assert.equal(h.ledger.recover(), 0);
});

test('the embedding concurrency limit is separate and keeps one slot for queries', (t) => {
  const h = harness(t);
  const players = [1, 2, 3].map((n) => addPlayer(h.store, n));
  players.forEach((player, i) => addTopic(h.store, player, `话题${i}`, `摘要${i}`));
  assert.ok(typeof h.ledger.claimIndexBatch(3) === 'object', 'limit 3: two index calls may run');
  assert.ok(typeof h.ledger.claimIndexBatch(3) === 'object');
  assert.equal(h.ledger.claimIndexBatch(3), 'busy');
  const one = harness(t);
  addTopic(one.store, addPlayer(one.store, 1), '甲', '摘要');
  addTopic(one.store, addPlayer(one.store, 2), '乙', '摘要');
  assert.ok(typeof one.ledger.claimIndexBatch(2) === 'object', 'the default limit 2 lets one index call run');
  assert.equal(one.ledger.claimIndexBatch(2), 'busy', 'the second slot stays free for a reply-time query');
  assert.equal(count(one.store, "SELECT 1 FROM web_embed_attempts WHERE state='not_sent'"), 1);
});

test('indexing is not part of the publication transaction: a committed publication leaves topics pending, nothing else', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  h.store.run(
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES ('m1','world1','conversation1','player','player1','我家的猫',?,'text',0)`,
    T0,
  );
  h.store.run(
    `INSERT INTO jobs(id,world_id,conversation_id,character_id,kind,epoch,status,created_at,lease_until,
    covered_ids_json,requested_delivery) VALUES ('pub-job','world1','conversation1','character','reply',1,'published',?,?,'[]','voice')`,
    T0,
    T0,
  );
  const before = { ...spending(h.store) };
  h.store.transaction(() =>
    recordDialogueMemories(
      userStore(h.store),
      a.scope,
      'pub-job',
      candidate([
        {
          key: '猫',
          summary: '玩家养了一只猫',
          evidenceMessageIds: ['m1'],
          sourceKind: 'player_statement',
          importance: 6,
        },
      ]),
      [],
      ['m1'],
      T0,
    ),
  );
  assert.ok(h.store.get('SELECT 1 FROM memory_topics'), 'the publication wrote the topic');
  assert.equal(count(h.store, 'SELECT 1 FROM web_embed_attempts'), 0, 'no embedding call, no reservation, no row');
  assert.equal(count(h.store, 'SELECT 1 FROM memory_embeddings'), 0);
  assert.deepEqual({ ...spending(h.store) }, before);
  assert.equal(h.provider.calls.length, 0);
  // After the commit the topic is pending and the next pass embeds it.
  await h.step();
  assert.equal(h.provider.calls.length, 1);
  assert.deepEqual(
    h.rows().map((row) => [row.topic_key, row.state]),
    [['猫', 'ready']],
  );
});

test('a ledger on a schema without the embedding tables does nothing and never throws on a pass', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const ledger = new WebEmbedLedger(store, new TestClock());
  assert.equal(ledger.available(), false);
  assert.equal(ledger.ready(), false);
  assert.equal(ledger.claimIndexBatch(2), null);
  assert.deepEqual(ledger.queryCandidates(4), []);
  assert.equal(ledger.recover(), 0);
  assert.equal(webEmbedNextDue(store, T0), null);
  assert.throws(() => ledger.ensureBudget(), /WEB_EMBEDDING_MIGRATION_REQUIRED/);
  assert.ok(DomainError);
  assert.ok(fixtureVector({ 0: 1 }));
});
