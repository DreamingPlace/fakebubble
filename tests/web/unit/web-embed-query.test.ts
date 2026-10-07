import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWebEmbedConfig } from '../../../config/web-embeddings.ts';
import { OfflineEmbeddings, type OfflineEmbeddingOptions } from '../../../apps/server/generation/embedding-provider.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { embeddingHash } from '../../../apps/server/memory/memory-embeddings.ts';
import { queryText } from '../../../apps/server/generation/web-embed-ledger.ts';
import {
  T0,
  TestClock,
  addOperation,
  addPlayer,
  addTopic,
  count,
  embedStore,
  metrics,
  spending,
} from '../fixtures/embed-store.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The generator is a stub that fails at once: these tests are about what happens BEFORE the text call. */
function harness(
  t: test.TestContext,
  options: OfflineEmbeddingOptions = {},
  config = parseWebEmbedConfig({ queryTimeoutMs: 200 }),
) {
  const store = embedStore();
  const clock = new TestClock();
  const provider = new OfflineEmbeddings(options);
  const text = {
    textProtocol: 'accepted-v7',
    policyHash: 'f'.repeat(64),
    generateAcceptedStages: async () => {
      throw new Error('STUB_TEXT_PROVIDER');
    },
    generateAcceptedReviewFromKnownDraft: async () => {
      throw new Error('STUB_TEXT_PROVIDER');
    },
  } as never;
  const runner = new WebProviderRunner(
    store,
    clock,
    text,
    async () => {
      throw new Error('no speech in this test');
    },
    undefined,
    { provider, config },
  );
  const held: Promise<void>[] = [];
  const executor = new WebProviderExecutor(store, clock, runner, {
    hold: (task) => held.push(task),
    settled: async () => {},
  });
  t.after(async () => {
    await executor.close();
    store.close();
  });
  const pass = async () => {
    held.length = 0;
    executor.managedPass('test-owner');
    await Promise.all(held);
  };
  /** A pass without waiting for the provider tasks it starts. */
  const kick = () => {
    held.length = 0;
    executor.managedPass('test-owner');
  };
  /** The embedding pass, then (once its task settled and woke the scheduler) the pass that can claim the operation. */
  const settle = async () => {
    await pass();
    await pass();
  };
  const frozen = (id: string) => !!store.get('SELECT 1 FROM web_v7_requests WHERE operation_id=?', id);
  const status = (id: string) =>
    store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', id)?.status;
  const attempts = () =>
    store.all<Record<string, any>>("SELECT * FROM web_embed_attempts WHERE kind='query'").map((row) => ({ ...row }));
  return { store, clock, provider, runner, executor, held, pass, settle, kick, frozen, status, attempts };
}

/** An account whose scope already has a ready vector, with one queued operation. */
function scene(h: ReturnType<typeof harness>, body = '猫咪最近怎么样') {
  const player = addPlayer(h.store, 1);
  addTopic(h.store, player, '猫', '玩家说他家养了一只猫');
  h.store.run(
    `INSERT INTO memory_embeddings VALUES ('world1','conversation1','character','猫','@cf/baai/bge-m3',1024,?,?,1,'ready',?)`,
    Buffer.alloc(4096, 1),
    'a'.repeat(64),
    T0,
  );
  return { player, op: addOperation(h.store, player, body) };
}

test('the claim waits for the query embedding: the request is frozen only after it has settled', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness(t, { onCall: () => gate }, parseWebEmbedConfig({ queryTimeoutMs: 5000 }));
  const { op } = scene(h);
  h.kick();
  await sleep(20);
  assert.equal(h.provider.calls.length, 1, 'one call, started by the scheduler before any claim');
  assert.deepEqual(h.provider.calls[0], ['猫咪最近怎么样'], 'exactly the player input, nothing else');
  assert.equal(h.attempts()[0]!.state, 'sent');
  assert.equal(h.frozen(op.id), false, 'not frozen while the embedding is in flight');
  assert.equal(h.status(op.id), 'queued', 'and not claimed');
  h.executor.managedPass('test-owner');
  assert.equal(h.status(op.id), 'queued', 'another pass does not claim it either');
  release();
  await Promise.all(h.held);
  assert.equal(h.attempts()[0]!.state, 'known');
  await h.pass();
  assert.equal(h.frozen(op.id), true, 'frozen after the embedding settled');
  assert.equal(h.provider.calls.length, 1, 'one query embedding per operation');
  assert.deepEqual(h.runner.embedding!.ledger.queryCandidates(10), [], 'a frozen operation is never a candidate again');
});

test('the query is embedded within the budget, stored nowhere and bills the reported or estimated tokens', async (t) => {
  const h = harness(t);
  const { op } = scene(h);
  const before = { ...spending(h.store) };
  await h.settle();
  const [attempt] = h.attempts();
  assert.deepEqual(
    [attempt!.kind, attempt!.phase, attempt!.state, attempt!.outcome, attempt!.operation_id],
    ['query', 'embed', 'known', 'succeeded', op.id],
  );
  assert.equal(before.held_micros, 0);
  assert.deepEqual({ ...spending(h.store) }, { held_micros: 0, spent_micros: attempt!.charged_micros });
  assert.ok(attempt!.charged_micros >= 1);
  // The player's words and the vector are in no embedding table and no ledger row.
  const dump = JSON.stringify([
    h.store.all('SELECT * FROM web_embed_attempts'),
    h.store.all('SELECT * FROM web_embed_metrics'),
    h.store.all('SELECT topic_key,state,content_hash FROM memory_embeddings'),
  ]);
  assert.ok(!dump.includes('猫咪最近怎么样'));
  assert.equal(count(h.store, 'SELECT 1 FROM memory_embeddings'), 1, 'no vector row was added for the query');
  assert.equal(attempt!.items_json, null);
  assert.equal(h.frozen(op.id), true);
  assert.equal(embeddingHash(queryText('猫咪最近怎么样')).length, 64);
});

for (const [name, outcome, timeout] of [
  ['fails with a known provider rejection', 'known', false],
  ['has an UNKNOWN outcome', 'unknown', false],
  ['returns an unusable body', 'invalid', false],
  ['times out', 'hang', true],
] as const)
  test(`when the query embedding ${name} the reply is frozen with lexical recall and the call is never repeated`, async (t) => {
    const h = harness(t, { outcome: () => outcome });
    const { op } = scene(h);
    const started = Date.now();
    await h.settle();
    const [attempt] = h.attempts();
    assert.equal(h.provider.calls.length, 1);
    if (outcome === 'known')
      assert.deepEqual([attempt!.state, attempt!.outcome, attempt!.charged_micros], ['known', 'failed', 0]);
    else assert.equal(attempt!.state, 'unknown');
    // known: the hold came back; unknown or timed out: the reservation is never released.
    assert.equal(spending(h.store).held_micros, outcome === 'known' ? 0 : attempt!.held_micros);
    assert.equal(h.frozen(op.id), true, 'the request was frozen and the reply continues');
    assert.ok(['text_running', 'failed', 'queued'].includes(h.status(op.id)!));
    assert.ok(Date.now() - started < 3000, 'never held back for long');
    // Not now, not later: no second attempt for this operation exists or can be made.
    h.clock.advance(3_600_000);
    await h.pass();
    await h.pass();
    assert.equal(h.provider.calls.length, 1);
    assert.equal(h.attempts().length, 1);
    const day = metrics(h.store)[0]!;
    assert.equal(day.query_fallbacks, 1);
    assert.equal(day.query_timeouts, timeout ? 1 : 0);
    assert.equal(day.failures, outcome === 'known' ? 1 : 0);
    assert.equal(day.unknowns, outcome === 'known' ? 0 : 1);
  });

test('a timeout is a short wait, not a stuck reply: the reply continues the moment the timeout ends', async (t) => {
  const h = harness(t, { outcome: () => 'hang' }, parseWebEmbedConfig({ queryTimeoutMs: 200 }));
  const { op } = scene(h);
  const started = Date.now();
  h.kick();
  await sleep(50);
  assert.equal(h.frozen(op.id), false);
  await Promise.all(h.held);
  const waited = Date.now() - started;
  assert.ok(waited >= 190 && waited < 1500, `waited ${waited} ms`);
  h.kick();
  assert.equal(h.frozen(op.id), true);
});

test('no query embedding is made for a guest, for a scope without vectors, for a frozen operation or without an allowance', async (t) => {
  const h = harness(t);
  const guest = addPlayer(h.store, 1, 'guest');
  addOperation(h.store, guest, '访客的话');
  const empty = addPlayer(h.store, 2);
  addOperation(h.store, empty, '没有记忆的玩家');
  await h.pass();
  assert.equal(h.provider.calls.length, 0, 'nothing to compare against, so nothing is sent');
  assert.equal(h.attempts().length, 0);
  assert.equal(count(h.store, 'SELECT 1 FROM web_v7_requests'), 2, 'both replies were frozen without delay');

  const none = harness(t);
  const { op } = scene(none);
  none.store.run("DELETE FROM web_provider_spending WHERE provider='cloudflare'");
  await none.pass();
  assert.equal(none.provider.calls.length, 0);
  assert.equal(none.frozen(op.id), true, 'embedding is switched off by the missing allowance, replies are not');

  const spent = harness(t);
  const scene2 = scene(spent);
  spent.store.run("UPDATE web_provider_spending SET limit_micros=1,spent_micros=1 WHERE provider='cloudflare'");
  await spent.pass();
  assert.equal(spent.provider.calls.length, 0, 'an exhausted allowance sends nothing');
  assert.equal(spent.frozen(scene2.op.id), true);
  assert.equal(count(spent.store, 'SELECT 1 FROM web_embed_attempts'), 0);
});

test('the embedding limit is shared with indexing but a query always keeps a slot; a query without a free slot proceeds lexically', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness(t, { onCall: () => gate }, parseWebEmbedConfig({ maxEmbedRunning: 2, queryTimeoutMs: 5000 }));
  const a = scene(h);
  const second = addPlayer(h.store, 2);
  addTopic(h.store, second, '狗', '另一个玩家的狗');
  h.store.run(
    `INSERT INTO memory_embeddings VALUES ('world2','conversation2','character','狗','@cf/baai/bge-m3',1024,?,?,1,'ready',?)`,
    Buffer.alloc(4096, 1),
    'b'.repeat(64),
    T0,
  );
  const b = addOperation(h.store, second, '狗狗怎么样');
  const third = addPlayer(h.store, 3);
  addTopic(h.store, third, '鸟', '第三个玩家的鸟');
  h.store.run(
    `INSERT INTO memory_embeddings VALUES ('world3','conversation3','character','鸟','@cf/baai/bge-m3',1024,?,?,1,'ready',?)`,
    Buffer.alloc(4096, 1),
    'c'.repeat(64),
    T0,
  );
  const c = addOperation(h.store, third, '小鸟怎么样');
  h.kick();
  await sleep(20);
  assert.equal(h.provider.calls.length, 2, 'two slots: two query embeddings in flight');
  assert.equal(h.frozen(c.id), true, 'the third operation had no free slot and was frozen lexically right away');
  assert.equal(h.frozen(a.op.id) || h.frozen(b.id), false);
  release();
  await Promise.all(h.held);
});
