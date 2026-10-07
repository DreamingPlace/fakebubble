import assert from 'node:assert/strict';
import test from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WEB_EMBED_DEFAULT, parseWebEmbedConfig } from '../../../config/web-embeddings.ts';
import { OfflineEmbeddings } from '../../../apps/server/generation/embedding-provider.ts';
import { WebEmbedRunner } from '../../../apps/server/generation/web-embed-runner.ts';
import { T0, TestClock, addPlayer, addTopic, embedStore, metrics } from '../fixtures/embed-store.ts';

const origin = 'https://admin.fixture.invalid';

test("the owner-only stage-latency view reports the day's embedding counters, including a day with no reply", async (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const clock = new TestClock(T0);
  const admin = new WebAccountAdmin(store, clock, origin);
  const owner = admin.login(admin.issueLoginGrant().token, origin);
  const auth = [owner.cookie, owner.csrf, origin] as const;
  const live = new AbortController().signal;
  const players = [1, 2, 3].map((n) => addPlayer(store, n));
  players.forEach((player, i) => {
    addTopic(store, player, `话题${i}`, `摘要${i}`);
    addTopic(store, player, `另一个${i}`, `另一个摘要${i}`);
  });
  // Day 1: one good call (2 texts), one known failure, one UNKNOWN; then two query fallbacks (one a timeout).
  const outcomes = ['ok', 'known', 'unknown'] as const;
  const runner = new WebEmbedRunner(
    store,
    clock,
    new OfflineEmbeddings({ outcome: (i) => outcomes[i]! }),
    WEB_EMBED_DEFAULT,
  );
  for (let i = 0; i < 3; i++) {
    const batch = runner.ledger.claimIndexBatch(3);
    assert.ok(batch && batch !== 'busy');
    await runner.index(batch, live);
  }
  runner.ledger.recordQueryFallback(false);
  runner.ledger.recordQueryFallback(true);
  assert.equal(metrics(store).length, 1);
  const day1 = (admin.stageLatency(...auth, 7) as { days: Record<string, any>[] }).days;
  assert.deepEqual(
    day1.map((d) => d.day),
    ['2023-11-14'],
    'a day with embedding calls is listed even without a single reply',
  );
  assert.deepEqual(day1[0]!.embedding, {
    calls: 3,
    texts: 2,
    failures: 1,
    unknowns: 1,
    queryFallbacks: 2,
    queryTimeouts: 1,
  });
  assert.equal(day1[0]!.operations, 0);
  assert.deepEqual(day1[0]!.textQueueWait, { samples: 0, p50Ms: null, p95Ms: null });
  // Day 2: another day with counters; days are newest first and the limit applies to the union.
  store.run('INSERT INTO web_embed_metrics(day,calls,texts) VALUES (?,?,?)', '2023-11-15', 4, 9);
  const both = (admin.stageLatency(...auth, 7) as { days: Record<string, any>[] }).days;
  assert.deepEqual(
    both.map((d) => d.day),
    ['2023-11-15', '2023-11-14'],
  );
  assert.deepEqual([both[0]!.embedding.calls, both[0]!.embedding.texts, both[0]!.embedding.failures], [4, 9, 0]);
  assert.equal((admin.stageLatency(...auth, 1) as { days: unknown[] }).days.length, 1);
  // Counters hold no content: nothing in the table can name a player, a topic or a text.
  assert.deepEqual(
    store.all<{ name: string }>("SELECT name FROM pragma_table_info('web_embed_metrics')").map((c) => c.name),
    ['day', 'calls', 'texts', 'failures', 'unknowns', 'query_fallbacks', 'query_timeouts'],
  );
  // Owner only, with the usual session, CSRF and origin checks.
  assert.throws(() => admin.stageLatency(owner.cookie, 'wrong-csrf', origin, 7));
  assert.throws(() => admin.stageLatency(owner.cookie, owner.csrf, 'https://evil.invalid', 7));
  assert.ok(parseWebEmbedConfig({}));
});
