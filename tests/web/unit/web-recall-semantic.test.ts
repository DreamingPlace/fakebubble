import assert from 'node:assert/strict';
import test from 'node:test';
import { DIALOGUE, RECALL, RECALL_SEMANTIC } from '../../../packages/domain/dialogue.ts';
import { parseWebEmbedConfig } from '../../../config/web-embeddings.ts';
import { OfflineEmbeddings, fixtureVector } from '../../../apps/server/generation/embedding-provider.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { freezeWebV7Request, readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { WebProviderExecutor } from '../../../apps/server/generation/web-provider-executor.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import {
  embeddingHash,
  embeddingText,
  packVector,
  semanticCosines,
  semanticRelevance,
} from '../../../apps/server/memory/memory-embeddings.ts';
import { queryText } from '../../../apps/server/generation/web-embed-ledger.ts';
import { recallMemories } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { memoryStore } from '../fixtures/memory-store.ts';
import { T0, TestClock, addOperation, addPlayer, addTopic, embedStore, type Player } from '../fixtures/embed-store.ts';
import type { Store } from '../../../apps/server/platform/store.ts';

const MODEL = '@cf/baai/bge-m3';
const DAY = 86_400_000;
const NOW = T0 + 30 * DAY;

/** Insert a ready vector row for an existing topic. */
function vectorFor(
  store: Store,
  player: Player,
  key: string,
  vector: Float32Array,
  options: { model?: string; state?: 'ready' | 'unknown' } = {},
) {
  const { worldId, conversationId, characterId } = player.scope;
  store.run(
    `INSERT INTO memory_embeddings VALUES (?,?,?,?,?,1024,?,?,1,?,?)`,
    worldId,
    conversationId,
    characterId,
    key,
    options.model ?? MODEL,
    options.state === 'unknown' ? null : packVector(vector),
    'a'.repeat(64),
    options.state ?? 'ready',
    T0,
  );
}
/** An expired short topic: default recall leaves it out, only a relevant query brings it back. */
const expired = (store: Store, player: Player, key: string, summary: string, importance = 5) =>
  addTopic(store, player, key, summary, { at: T0 - 20 * DAY, importance, tier: 'short' });
const recall = (store: Store, player: Player, query: string, semantic?: Float32Array, limit = 12) =>
  recallMemories(userStore(store), player.scope, NOW, query, limit, semantic && { model: MODEL, vector: semantic });
const keys = (store: Store, player: Player, query: string, semantic?: Float32Array, limit = 12) =>
  recall(store, player, query, semantic, limit).map((memory) => memory.key);
const axis = (weights: Record<number, number>) => fixtureVector(weights);

test('semantic relevance is clamp((cosine - tau) / (1 - tau)); tau is 0.35 and lives next to the pinned RECALL weights', () => {
  assert.equal(RECALL_SEMANTIC.tau, 0.35);
  assert.equal(RECALL_SEMANTIC.topics, 500);
  assert.deepEqual(
    { ...RECALL },
    { weightRelevance: 0.5, weightImportance: 0.3, weightRecency: 0.2, recencyHours: 72, relevanceSaturation: 8 },
    'the existing weights are untouched',
  );
  assert.equal(semanticRelevance(1), 1);
  assert.equal(semanticRelevance(0.35), 0);
  assert.equal(semanticRelevance(0), 0, 'clamped below');
  assert.equal(semanticRelevance(-0.7), 0);
  assert.equal(semanticRelevance(1.2), 1, 'clamped above');
  assert.ok(Math.abs(semanticRelevance(0.675) - 0.5) < 1e-12);
});

test('a topic with no shared words is recalled by meaning; an unrelated topic is not', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  expired(store, a, '猫', '玩家说他家养了一只猫');
  expired(store, a, '天气', '玩家问了天气');
  vectorFor(store, a, '猫', axis({ 0: 1 }));
  vectorFor(store, a, '天气', axis({ 5: 1 }));
  const query = '猫咪最近怎么样';
  assert.deepEqual(keys(store, a, query), [], 'lexically nothing matches and both topics are expired');
  assert.deepEqual(
    keys(store, a, query, axis({ 0: 0.9, 1: Math.sqrt(0.19) })),
    ['猫'],
    'by meaning the cat topic comes back',
  );
  assert.deepEqual(keys(store, a, query, axis({ 5: 0.2, 1: 0.98 })), [], 'cosine below tau is unrelated');
});

test('relevance = max(lexical, semantic), never their sum; importance and recency are unchanged', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  // Age 0, importance 5: recency 1, importance 0.5*... => score = 0.5*relevance + 0.3*0.5 + 0.2.
  addTopic(store, a, '蛋糕', '玩家喜欢蛋糕', { at: NOW, importance: 5, tier: 'long' });
  addTopic(store, a, '旅行', '玩家想去旅行', { at: NOW, importance: 5, tier: 'long' });
  vectorFor(store, a, '蛋糕', axis({ 0: 1 }));
  vectorFor(store, a, '旅行', axis({ 0: 1 }));
  const weight = (query: string, semantic?: Float32Array) =>
    Object.fromEntries(recall(store, a, query, semantic).map((memory) => [memory.key, memory.recallWeight]));
  const base = 0.3 * 0.5 + 0.2;
  const round = (score: number) => 1 + Math.round(score * 100) / 100;
  assert.deepEqual(
    weight('你好'),
    { 旅行: round(base), 蛋糕: round(base) },
    'no semantic, no lexical: only importance and recency',
  );
  // Lexical only: '蛋糕' is named in the input (key hit 4 + summary hit 1 = 5 of 8).
  assert.equal(weight('我想吃蛋糕')['蛋糕'], round(0.5 * (5 / 8) + base));
  // Semantic only: cosine 0.675 is 0.5 relevance for both topics (they share the vector).
  const half = axis({ 0: 0.675, 1: Math.sqrt(1 - 0.675 * 0.675) });
  assert.deepEqual(weight('你好', half), { 旅行: round(0.5 * 0.5 + base), 蛋糕: round(0.5 * 0.5 + base) });
  // Both: the larger of the two counts, so a weaker semantic score does not add to a stronger lexical one...
  assert.equal(weight('我想吃蛋糕', half)['蛋糕'], round(0.5 * (5 / 8) + base), 'lexical 0.625 beats semantic 0.5');
  // ...and a stronger semantic score replaces a weaker lexical one.
  const strong = axis({ 0: 0.9, 1: Math.sqrt(0.19) });
  assert.equal(weight('我想吃蛋糕', strong)['蛋糕'], round(0.5 * semanticRelevance(0.9) + base));
  assert.ok(Math.abs(semanticRelevance(0.9) - 0.846153846) < 1e-6);
  // Saturated lexical (relevance >= 8) and perfect semantic is still 1, not 2.
  assert.ok(weight('蛋糕蛋糕', axis({ 0: 1 }))['蛋糕']! <= round(0.5 + base));
});

test('ranking is inside the whole authorized scope before the limit: a semantic match outranks newer unrelated topics', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  for (let i = 0; i < 20; i++)
    addTopic(store, a, `近期${i}`, `最近的闲聊${i}`, { at: NOW - i * 1000, importance: 3, tier: 'long' });
  expired(store, a, '猫', '玩家说他家养了一只猫', 3);
  vectorFor(store, a, '猫', axis({ 0: 1 }));
  assert.equal(keys(store, a, '你好', undefined, 12).includes('猫'), false);
  assert.equal(
    keys(store, a, '猫咪最近怎么样', axis({ 0: 1 }), 12)[0],
    '猫',
    'it is found first, not hidden by 20 newer topics',
  );
});

test('at most the 500 most recently seen topics are compared', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  const { worldId, conversationId } = a.scope;
  store.transaction(() => {
    for (let i = 0; i < 502; i++) {
      const lastSeen = NOW - 100 * DAY + i * 1000;
      store.run(
        "INSERT INTO memory_topics VALUES (?,?,'character',?,'short',0,?,?,3)",
        worldId,
        conversationId,
        `主题${i}`,
        lastSeen,
        lastSeen + 1,
      );
      store.run(
        "INSERT INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES (?,?,?,'character',?)",
        `cat${i}`,
        worldId,
        conversationId,
        `主题${i}`,
      );
      vectorFor(store, a, `主题${i}`, axis({ 0: 1 }));
    }
  });
  const scores = semanticCosines(userStore(store), a.scope, { model: MODEL, vector: axis({ 0: 1 }) });
  assert.equal(scores.size, RECALL_SEMANTIC.topics);
  assert.equal(scores.has('主题501'), true, 'the newest is compared');
  assert.equal(scores.has('主题2'), true, 'the 500th newest is compared');
  assert.equal(scores.has('主题1'), false, 'older topics are not');
  assert.equal(scores.has('主题0'), false);
  const found = keys(store, a, '你好', axis({ 0: 1 }), 12);
  assert.equal(found.length, 12);
  assert.ok(!found.includes('主题0') && !found.includes('主题1'));
});

test("a query never reads another scope's vectors: two players with identical topics and identical vectors", (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  const b = addPlayer(store, 2);
  for (const player of [a, b]) {
    expired(store, player, '猫', '玩家说他家养了一只猫');
    vectorFor(store, player, '猫', axis({ 0: 1 }));
  }
  // Player B has a second topic that only exists (and has a vector) in B's scope.
  expired(store, b, '秘密', 'B一个人的话题');
  vectorFor(store, b, '秘密', axis({ 0: 1 }));
  const query = axis({ 0: 1 });
  assert.deepEqual(keys(store, a, '猫咪最近怎么样', query), ['猫']);
  assert.deepEqual(keys(store, b, '猫咪最近怎么样', query).sort(), ['猫', '秘密']);
  assert.deepEqual([...semanticCosines(userStore(store), a.scope, { model: MODEL, vector: query }).keys()], ['猫']);
  // The same player's other conversation and character are separate scopes too.
  store.run("INSERT INTO character_templates VALUES ('other',1,'{}')");
  store.run("INSERT INTO world_characters VALUES ('world1','other','new')");
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world1','conversation1b','private','other')",
  );
  store.run("INSERT INTO participants VALUES ('world1','conversation1b','other')");
  store.run("INSERT INTO contacts VALUES ('world1','conversation1b','other','{}')");
  const other = { ...a, scope: { ...a.scope, conversationId: 'conversation1b', characterId: 'other' } };
  assert.deepEqual([...semanticCosines(userStore(store), other.scope, { model: MODEL, vector: query }).keys()], []);
  assert.deepEqual(keys(store, other, '猫咪最近怎么样', query), []);
});

test('only ready vectors of the right model and width count; UNKNOWN rows, old schemas and a missing vector change nothing', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  expired(store, a, '猫', '玩家说他家养了一只猫');
  expired(store, a, '狗', '玩家说他家养了一只狗');
  expired(store, a, '鱼', '玩家说他家养了一条鱼');
  vectorFor(store, a, '猫', axis({ 0: 1 }), { model: 'another-model' });
  vectorFor(store, a, '狗', axis({ 0: 1 }), { state: 'unknown' });
  assert.deepEqual(keys(store, a, '你好', axis({ 0: 1 })), [], 'wrong model and unknown rows are ignored');
  vectorFor(store, a, '鱼', axis({ 0: 1 }));
  assert.deepEqual(keys(store, a, '你好', axis({ 0: 1 })), ['鱼']);
  assert.deepEqual(
    recallMemories(userStore(store), a.scope, NOW, '你好', 12, { model: MODEL, vector: new Float32Array(8) }).map(
      (m) => m.key,
    ),
    [],
    'a query vector of another width matches nothing',
  );
  // A schema-115 database has no embedding table: the semantic argument is simply ignored.
  const old = memoryStore();
  t.after(() => old.close());
  old.run("INSERT INTO memory_topics VALUES ('world','conversation','character','猫','long',0,?,?,5)", NOW, NOW);
  old.run(
    "INSERT INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES ('m','world','conversation','character','猫')",
  );
  const scope = { playerId: 'player', worldId: 'world', conversationId: 'conversation', characterId: 'character' };
  assert.deepEqual(
    recallMemories(userStore(old), scope, NOW, '你好', 12, { model: MODEL, vector: axis({ 0: 1 }) }).map((m) => m.key),
    ['猫'],
  );
});

/** Executor + fixture embedder: index the topics, embed the query, freeze the reply; what the frozen request recalled. */
async function reply(options: { outcome?: 'ok' | 'known' | 'unknown' | 'hang'; embeddings?: boolean; query?: string }) {
  const store = embedStore();
  const clock = new TestClock(NOW);
  const a = addPlayer(store, 1);
  const query = options.query ?? '猫咪最近怎么样';
  expired(store, a, '猫', '玩家说他家养了一只猫');
  expired(store, a, '工作', '玩家抱怨工作很累');
  expired(store, a, '天气', '玩家问了天气');
  const fixtures = new Map<string, Float32Array>([
    [embeddingText('猫', '玩家说他家养了一只猫'), axis({ 0: 1 })],
    [embeddingText('工作', '玩家抱怨工作很累'), axis({ 1: 1 })],
    [embeddingText('天气', '玩家问了天气'), axis({ 5: 1 })],
    [queryText('猫咪最近怎么样'), axis({ 0: 0.9, 3: Math.sqrt(0.19) })],
    [queryText('今天上班累不累'), axis({ 1: 0.8, 3: 0.6 })],
  ]);
  let calls = 0;
  const provider = new OfflineEmbeddings({
    fixtures,
    // The first call is the index call (always fine); the query call is the one the scenario breaks.
    outcome: () => (calls++ === 0 ? 'ok' : (options.outcome ?? 'ok')),
  });
  const text = {
    textProtocol: 'accepted-v7',
    policyHash: 'f'.repeat(64),
    generateAcceptedStages: async () => {
      throw new Error('STUB_TEXT_PROVIDER');
    },
  } as never;
  const runner = new WebProviderRunner(
    store,
    clock,
    text,
    async () => {
      throw new Error('no speech');
    },
    undefined,
    options.embeddings === false ? undefined : { provider, config: parseWebEmbedConfig({ queryTimeoutMs: 250 }) },
  );
  const held: Promise<void>[] = [];
  const executor = new WebProviderExecutor(store, clock, runner, {
    hold: (task) => held.push(task),
    settled: async () => {},
  });
  const pass = async () => {
    held.length = 0;
    executor.managedPass('test-owner');
    await Promise.all(held);
  };
  // The topics are indexed first (after "publications"), then a new reply arrives.
  await pass();
  const op = addOperation(store, a, query, { queuedAt: NOW });
  await pass();
  await pass();
  const status = store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.id)!.status;
  const memories = readWebV7Request(store as never, op.id).request.memories ?? [];
  const attempt = store.get<{ state: string }>("SELECT state FROM web_embed_attempts WHERE kind='query'");
  await executor.close();
  store.close();
  return {
    keys: memories.map((memory) => memory.key),
    status,
    queryState: attempt?.state ?? null,
    calls: provider.calls.length,
  };
}

test('end to end: "我家的猫" earlier, "猫咪最近怎么样" now: the frozen request recalls the cat topic with no shared words', async () => {
  const withMeaning = await reply({});
  assert.deepEqual(withMeaning.keys, ['猫'], 'recalled by meaning, and only that topic');
  assert.equal(withMeaning.queryState, 'known');
  assert.equal(withMeaning.calls, 2, 'one index call for the three topics, one query call');
  const without = await reply({ embeddings: false });
  assert.deepEqual(
    without.keys,
    [],
    'without embeddings the same reply recalls nothing: the difference is the vectors',
  );
  assert.equal(without.calls, 0);
  assert.ok(['text_running', 'failed'].includes(without.status), 'the reply was claimed and went on either way');
});

test('end to end: "工作" vs "上班"', async () => {
  const result = await reply({ query: '今天上班累不累' });
  assert.deepEqual(result.keys, ['工作']);
});

for (const outcome of ['known', 'unknown', 'hang'] as const)
  test(`end to end: a query embedding that ${outcome === 'hang' ? 'times out' : outcome === 'known' ? 'fails' : 'is UNKNOWN'} gives exactly the lexical result and the reply still goes on`, async () => {
    const baseline = await reply({ embeddings: false });
    const result = await reply({ outcome });
    assert.deepEqual(result.keys, baseline.keys, 'identical to lexical-only recall');
    assert.equal(result.status, 'text_running', 'the reply was claimed and published its way on');
    assert.equal(result.queryState, outcome === 'known' ? 'known' : 'unknown');
    assert.equal(result.calls, 2, 'no retry');
  });

test('the frozen request only accepts a vector computed for exactly its input', (t) => {
  const store = embedStore();
  t.after(() => store.close());
  const a = addPlayer(store, 1);
  expired(store, a, '猫', '玩家说他家养了一只猫');
  vectorFor(store, a, '猫', axis({ 0: 1 }));
  const vector = axis({ 0: 1 });
  const body = '猫咪最近怎么样';
  const freeze = (digest: string) => {
    const op = addOperation(store, a, body, { queuedAt: NOW });
    store.transaction(() => {
      freezeInputSnapshot(store as never, op.id, NOW);
      freezeWebV7Request(store as never, op.id, NOW, { model: MODEL, vector, digest });
    });
    return readWebV7Request(store as never, op.id).request.memories?.map((memory) => memory.key);
  };
  assert.deepEqual(freeze(embeddingHash(queryText(body))), ['猫']);
  assert.deepEqual(freeze(embeddingHash('另一句话')), [], 'a vector of some other text is ignored, not trusted');
  assert.equal(DIALOGUE.shortMemoryMs > 0, true);
});
