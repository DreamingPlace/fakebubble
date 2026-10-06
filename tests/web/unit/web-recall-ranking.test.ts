import assert from 'node:assert/strict';
import test from 'node:test';
import { DIALOGUE, RECALL } from '../../../packages/domain/dialogue.ts';
import { recallMemories, recordDialogueMemories } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { NOW, candidate, memoryStore, scope } from '../fixtures/memory-store.ts';

const HOUR = 3_600_000;
type Fixture = ReturnType<typeof memoryStore>;
let sequence = 0;
/** One topic row with a catalog id and one episode, written directly so age, tier and importance are exact. */
function put(
  store: Fixture,
  key: string,
  options: { tier?: 'short' | 'long'; ageHours: number; importance: number; summary?: string; activeForMs?: number },
) {
  const lastSeen = NOW - options.ageHours * HOUR;
  store.run(
    "INSERT INTO memory_topics VALUES ('world','conversation','character',?,?,0,?,?,?)",
    key,
    options.tier ?? 'short',
    lastSeen,
    lastSeen + (options.activeForMs ?? DIALOGUE.shortMemoryMs),
    options.importance,
  );
  store.run(
    "INSERT INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES (?,'world','conversation','character',?)",
    `mem-${++sequence}`,
    key,
  );
  store.run(
    "INSERT INTO memory_episodes VALUES ('world','conversation','character',?,'job1',?,'conversation','[\"p1\"]',?)",
    key,
    options.summary ?? `${key}的摘要`,
    lastSeen,
  );
}
const keys = (store: Fixture, query = '你好', limit = 12) =>
  recallMemories(userStore(store), scope, NOW, query, limit).map((memory) => memory.key);

test('the ranking weights live in one config object next to DIALOGUE; the old recall bonus is gone', () => {
  assert.deepEqual(
    { ...RECALL },
    { weightRelevance: 0.5, weightImportance: 0.3, weightRecency: 0.2, recencyHours: 72, relevanceSaturation: 8 },
  );
  assert.equal(RECALL.weightRelevance + RECALL.weightImportance + RECALL.weightRecency, 1);
  assert.equal('recallStep' in DIALOGUE, false);
  assert.equal('maxRecallBonus' in DIALOGUE, false);
  assert.equal(DIALOGUE.promotionImportance, 7);
});

test('an old importance-9 topic outranks a recent importance-2 small-talk topic when neither matches the input', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  put(store, '身世', { tier: 'long', ageHours: 30 * 24, importance: 9 });
  put(store, '天气', { ageHours: 0, importance: 2 });
  assert.deepEqual(keys(store), ['身世', '天气']);
  // The same two with the importances swapped rank the other way round: it is the importance that decides.
  const swapped = memoryStore();
  t.after(() => swapped.close());
  put(swapped, '身世', { tier: 'long', ageHours: 30 * 24, importance: 2 });
  put(swapped, '天气', { ageHours: 0, importance: 9 });
  assert.deepEqual(keys(swapped), ['天气', '身世']);
});

test('a lexical match outranks importance, and equal topics rank newest first', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  put(store, '身世', { tier: 'long', ageHours: 24, importance: 9 });
  put(store, '蛋糕', { ageHours: 24, importance: 3 });
  assert.deepEqual(keys(store, '我想吃蛋糕'), ['蛋糕', '身世'], 'a topic named in the input comes first');
  assert.deepEqual(keys(store, '你好'), ['身世', '蛋糕']);
  const equal = memoryStore();
  t.after(() => equal.close());
  put(equal, '旧', { ageHours: 40, importance: 5 });
  put(equal, '新', { ageHours: 2, importance: 5 });
  assert.deepEqual(keys(equal), ['新', '旧'], 'recency decays with exp(-age/72h)');
});

test('ranking happens inside the whole scope before the limit: many newer topics cannot hide an important old one', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  for (let i = 0; i < 20; i++) put(store, `闲聊${String(i).padStart(2, '0')}`, { ageHours: i / 10, importance: 1 });
  put(store, '身世', { tier: 'long', ageHours: 90 * 24, importance: 10 });
  put(store, '蛋糕偏好', { tier: 'long', ageHours: 90 * 24, importance: 1 });
  const found = keys(store, '今天吃蛋糕', 12);
  assert.equal(found.length, 12);
  assert.equal(found[0], '蛋糕偏好', 'the lexical match, however old');
  assert.ok(found.includes('身世'), 'the importance-10 topic beats all 20 newer small-talk topics');
});

test('an expired short topic is recalled only when the input matches it', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  put(store, '旧闲聊', { ageHours: 100, importance: 2, activeForMs: HOUR });
  put(store, '旧蛋糕', { ageHours: 100, importance: 2, activeForMs: HOUR });
  assert.deepEqual(keys(store), []);
  assert.deepEqual(keys(store, '蛋糕'), ['旧蛋糕']);
});

test('promotion to long-term: importance >= 7 at once, otherwise two player mentions', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const topic = (key: string, importance: number, message: string) => ({
    key,
    summary: `玩家谈到${key}。`,
    sourceKind: 'player_statement' as const,
    evidenceMessageIds: [message],
    importance,
  });
  const record = (job: string, message: string, ...topics: ReturnType<typeof topic>[]) =>
    recordDialogueMemories(user, scope, job, candidate(topics, { coveredMessageIds: [message] }), [], [message], NOW);
  const tier = (key: string) =>
    store.get<{ tier: string }>('SELECT tier FROM memory_topics WHERE topic_key=?', key)?.tier;
  record('job1', 'p1', topic('病情', 7, 'p1'), topic('偏好', 6, 'p1'), topic('闲聊', 2, 'p1'));
  assert.deepEqual([tier('病情'), tier('偏好'), tier('闲聊')], ['long', 'short', 'short']);
  record('job2', 'p2', topic('偏好', 6, 'p2'));
  assert.equal(tier('偏好'), 'long', 'a second player mention promotes it');
  assert.equal(tier('闲聊'), 'short');
});
