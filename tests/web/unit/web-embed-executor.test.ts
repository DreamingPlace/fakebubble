import assert from 'node:assert/strict';
import test from 'node:test';
import { WEB_EMBED_DEFAULT, parseWebEmbedConfig } from '../../../config/web-embeddings.ts';
import { OfflineEmbeddings, type OfflineEmbeddingOptions } from '../../../apps/server/generation/embedding-provider.ts';
import { INDEX_RETRY_MS } from '../../../apps/server/generation/web-embed-ledger.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { T0, TestClock, addPlayer, addTopic, embedStore, spending } from '../fixtures/embed-store.ts';

function harness(t: test.TestContext, options: OfflineEmbeddingOptions = {}, config = WEB_EMBED_DEFAULT, embed = true) {
  const store = embedStore();
  const clock = new TestClock();
  const provider = new OfflineEmbeddings(options);
  const text = { textProtocol: 'accepted-v7', policyHash: 'f'.repeat(64) } as never;
  const runner = new WebProviderRunner(
    store,
    clock,
    text,
    async () => {
      throw new Error('no speech in this test');
    },
    undefined,
    embed ? { provider, config } : undefined,
  );
  const held: Promise<void>[] = [];
  let wakes = 0;
  const executor = new WebProviderExecutor(store, clock, runner, {
    hold: (task) => held.push(task),
    settled: async () => {
      wakes++;
    },
  });
  t.after(async () => {
    await executor.close();
    store.close();
  });
  /** One scheduler pass, then wait for every provider task it started. */
  const pass = async () => {
    held.length = 0;
    executor.managedPass('test-owner');
    await Promise.all(held);
    return held.length;
  };
  const rows = () =>
    store
      .all<Record<string, any>>('SELECT topic_key,state FROM memory_embeddings ORDER BY topic_key')
      .map((row) => ({ ...row }));
  return { store, clock, provider, runner, executor, pass, rows, wakes: () => wakes, held };
}

test('a scheduler pass indexes pending topics in a tracked task and wakes the scheduler when it settles', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  addTopic(h.store, a, '猫', '玩家养了一只猫');
  addTopic(h.store, a, '工作', '玩家在上班');
  assert.equal(await h.pass(), 1, 'one tracked provider task');
  assert.equal(h.provider.calls.length, 1);
  assert.deepEqual(h.rows(), [
    { topic_key: '工作', state: 'ready' },
    { topic_key: '猫', state: 'ready' },
  ]);
  assert.ok(h.wakes() >= 1, 'a settled task wakes the scheduler so the next batch is not left waiting');
  assert.equal(h.executor.lastError, null);
});

test('an idle scan is not repeated for 5 s unless something changed; a finished call re-arms the next scan', async (t) => {
  const h = harness(t);
  const a = addPlayer(h.store, 1);
  addTopic(h.store, a, '猫', '玩家养了一只猫');
  await h.pass();
  await h.pass(); // finds nothing and starts the idle wait
  addTopic(h.store, a, '天气', '玩家问了天气');
  assert.equal(await h.pass(), 0, 'within the idle wait nothing scans');
  h.clock.advance(5_001);
  assert.equal(await h.pass(), 1);
  assert.equal(h.rows().length, 2);
  assert.equal(h.provider.calls.length, 2);
});

test('a known failure is retried only after the retry delay; an UNKNOWN call is never retried', async (t) => {
  const failing = harness(t, { outcome: (i) => (i === 0 ? 'known' : 'ok') });
  addTopic(failing.store, addPlayer(failing.store, 1), '猫', '玩家养了一只猫');
  await failing.pass();
  assert.equal(failing.rows().length, 0);
  assert.equal(spending(failing.store).held_micros, 0);
  for (let i = 0; i < 3; i++) assert.equal(await failing.pass(), 0, 'waiting out the delay');
  failing.clock.advance(INDEX_RETRY_MS + 1);
  assert.equal(await failing.pass(), 1);
  assert.deepEqual(failing.rows(), [{ topic_key: '猫', state: 'ready' }]);

  const unknown = harness(t, { outcome: () => 'unknown' });
  addTopic(unknown.store, addPlayer(unknown.store, 1), '猫', '玩家养了一只猫');
  await unknown.pass();
  assert.deepEqual(unknown.rows(), [{ topic_key: '猫', state: 'unknown' }]);
  for (const wait of [0, 5_001, INDEX_RETRY_MS + 1, 3_600_000]) {
    unknown.clock.advance(wait);
    assert.equal(await unknown.pass(), 0, `no retry after ${wait} ms`);
  }
  assert.equal(unknown.provider.calls.length, 1);
  assert.ok(spending(unknown.store).held_micros > 0, 'the hold stays');
});

test('an exhausted allowance pauses indexing for a minute and never touches the reply path', async (t) => {
  const h = harness(t);
  addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
  h.store.run("UPDATE web_provider_spending SET limit_micros=1,spent_micros=1 WHERE provider='cloudflare'");
  assert.equal(await h.pass(), 0);
  assert.equal(h.executor.lastError, 'WEB_PROVIDER_BUDGET_EXHAUSTED');
  assert.equal(h.provider.calls.length, 0);
  h.store.run("UPDATE web_provider_spending SET limit_micros=1000000 WHERE provider='cloudflare'");
  assert.equal(await h.pass(), 0, 'paused');
  h.clock.advance(60_001);
  assert.equal(await h.pass(), 1);
  assert.equal(h.rows().length, 1);
});

test('without an embedder the pass does nothing: no allowance row, no call, no table touched', async (t) => {
  const h = harness(t, {}, WEB_EMBED_DEFAULT, false);
  addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
  assert.equal(h.runner.embedding, undefined);
  assert.equal(await h.pass(), 0);
  assert.equal(h.rows().length, 0);
  assert.equal(h.store.get('SELECT 1 FROM web_embed_attempts'), undefined);
});

test('embedding concurrency is its own configured limit: with 3 slots two index calls run, the third scope waits', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const h = harness(t, { onCall: () => gate }, parseWebEmbedConfig({ maxEmbedRunning: 3 }));
  for (const n of [1, 2, 3]) addTopic(h.store, addPlayer(h.store, n), `话题${n}`, `摘要${n}`);
  h.executor.managedPass('test-owner');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.provider.calls.length, 2, 'two concurrent index calls (one slot stays free for a reply-time query)');
  assert.equal(h.store.all("SELECT 1 FROM web_embed_attempts WHERE state='sent'").length, 2);
  release();
  await Promise.all(h.held);
  h.clock.advance(5_001);
  await h.pass();
  assert.equal(h.provider.calls.length, 3);
  assert.equal(h.rows().length, 3);
  assert.ok(T0);
});

test('stopping the coordinator aborts an in-flight embedding call: UNKNOWN, never resent', async (t) => {
  const h = harness(t, { outcome: () => 'hang' });
  addTopic(h.store, addPlayer(h.store, 1), '猫', '玩家养了一只猫');
  h.executor.managedPass('test-owner');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.provider.calls.length, 1);
  h.executor.stop();
  await Promise.all(h.held);
  assert.deepEqual(h.rows(), [{ topic_key: '猫', state: 'unknown' }]);
  assert.equal(h.store.get<{ state: string }>('SELECT state FROM web_embed_attempts')?.state, 'unknown');
  h.clock.advance(3_600_000);
  assert.equal(await h.pass(), 0);
  assert.equal(h.provider.calls.length, 1);
});
