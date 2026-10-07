import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  LATE_TABLES,
  embeddingTableExists,
  releaseUnsentEmbedHolds,
} from '../../../apps/server/budget/web-embed-purge.ts';
import {
  migrateWebProviderEmbeddings,
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

function nodeAt115() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  migrateWebProviderMemory(store);
  return store;
}
const rows = (store: Store, table: string) =>
  store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
const vector = (dims: number, byte = 0) => Buffer.alloc(dims * 4, byte);
const hash = 'a'.repeat(64);

function seed(store: Store, now: number) {
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO character_templates VALUES (?,?,?)', 'character', 1, '{}');
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES ('world','character','new')");
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world','conversation','private','character')",
  );
  store.run("INSERT INTO participants VALUES ('world','conversation','character')");
  store.run("INSERT INTO contacts VALUES ('world','conversation','character','{}')");
  store.run(
    "INSERT INTO memory_topics VALUES ('world','conversation','character','猫',?,?,?,?,?)",
    'long',
    2,
    now,
    now,
    5,
  );
  store.run(
    "INSERT INTO memory_topics VALUES ('world','conversation','character','天气','short',0,?,?,3)",
    now,
    now + 1,
  );
}

test('local runner: 116 is its own step after 115, sets user_version=116 and is not repeatable', (t) => {
  const store = nodeAt115();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 115);
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'memory_embeddings'), undefined);
  migrateWebProviderEmbeddings(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 116);
  for (const table of ['memory_embeddings', 'web_embed_attempts', 'web_embed_metrics'])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', table), table);
  assert.throws(() => migrateWebProviderEmbeddings(store), /WEB_PROVIDER_EMBEDDING_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderEmbeddings(fresh), /WEB_PROVIDER_EMBEDDING_MIGRATION_REQUIRED/);
});

test('a populated 115 database upgrades to 116 keeping every memory row; the new constraints hold', (t) => {
  const store = nodeAt115();
  t.after(() => store.close());
  const now = 1_700_000_000_000;
  seed(store, now);
  const before = Object.fromEntries(
    ['memory_topics', 'memory_catalog', 'memory_facts', 'web_operation_metrics'].map((table) => [
      table,
      rows(store, table),
    ]),
  );
  assert.equal(before.memory_topics!.length, 2);
  migrateWebProviderEmbeddings(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 116);
  for (const table of Object.keys(before)) assert.deepEqual(rows(store, table), before[table], `${table} is unchanged`);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.equal(rows(store, 'memory_embeddings').length, 0, 'nothing is embedded by the migration: indexing is a job');

  const embed = (topic: string, state: string, dims: number, bytes: Buffer | null, model = 'm') =>
    store.run(
      `INSERT INTO memory_embeddings VALUES ('world','conversation','character',?,?,?,?,?,1,?,?)`,
      topic,
      model,
      dims,
      bytes,
      hash,
      state,
      now,
    );
  embed('猫', 'ready', 1024, vector(1024, 1));
  assert.throws(
    () => embed('猫', 'ready', 1024, vector(1024)),
    /UNIQUE|PRIMARY/,
    'one vector per scope, topic and model',
  );
  embed('猫', 'ready', 1024, vector(1024), 'other-model');
  assert.throws(() => embed('天气', 'ready', 1024, vector(1023)), /CHECK/, 'a ready vector is dims*4 bytes');
  assert.throws(() => embed('天气', 'ready', 1024, null), /CHECK/, 'a ready row has a vector');
  assert.throws(() => embed('天气', 'unknown', 1024, vector(1024)), /CHECK/, 'an unknown row carries no vector');
  assert.throws(() => embed('天气', 'pending', 1024, null), /CHECK/, 'only ready and unknown are stored');
  assert.throws(
    () => embed('没有这个主题', 'unknown', 1024, null),
    /FOREIGN KEY/,
    'a vector belongs to an existing topic',
  );
  embed('天气', 'unknown', 1024, null);
  assert.throws(
    () => store.run("UPDATE memory_embeddings SET content_hash='short' WHERE topic_key='猫'"),
    /CHECK/,
    'content_hash is a sha256',
  );

  const attempt = (id: string, kind: string, operation: string | null, extra = '') =>
    store.run(
      `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,operation_id,model,texts,max_units,
      price_micros_per_million,held_micros,state,lease_expires_at,created_at${extra ? ',sent_at' : ''})
      VALUES (?,?,'world','conversation','character',?,'m',1,10,11800,1,${extra ? "'sent'" : "'not_sent'"},?,?${extra ? ',?' : ''})`,
      id,
      kind,
      operation,
      now + 1,
      now,
      ...(extra ? [now] : []),
    );
  attempt('a1', 'query', 'op1');
  assert.throws(() => attempt('a2', 'query', 'op1'), /UNIQUE/, 'at most one query embedding per operation, ever');
  assert.throws(() => attempt('a3', 'index', 'op2'), /CHECK/, 'an index call belongs to no operation');
  assert.throws(() => attempt('a4', 'query', null), /CHECK/, 'a query call names its operation');
  attempt('a5', 'index', null);
  attempt('a6', 'index', null, 'sent');
  assert.throws(
    () => store.run("UPDATE web_embed_attempts SET state='known',outcome='succeeded',settled_at=1 WHERE id='a6'"),
    /CHECK/,
    'a known call carries its usage and charge',
  );
  assert.throws(
    () =>
      store.run(
        "UPDATE web_embed_attempts SET state='known',outcome='succeeded',settled_at=1,usage_units=1,charged_micros=2 WHERE id='a6'",
      ),
    /CHECK/,
    'never charged above the hold',
  );
  assert.throws(
    () => store.run("UPDATE web_embed_attempts SET phase='speech' WHERE id='a6'"),
    /CHECK/,
    "phase is 'embed'",
  );

  store.run("INSERT INTO web_embed_metrics(day,calls) VALUES ('2023-11-14',1)");
  assert.throws(() => store.run("INSERT INTO web_embed_metrics(day) VALUES ('yesterday')"), /CHECK/);
});

test('Cloudflare runner: an existing authority at 115 upgrades to 116 through the normal path (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      embeddings: { vectors: boolean; attempts: boolean; metrics: boolean };
    }>(`/upgrade?mode=${mode}&through=115&object=embedding-${mode}`);
    assert.equal(result.before.length, 40, mode);
    assert.equal(result.before.at(-1)?.startsWith('115:'), true, mode);
    assert.deepEqual(result.after.slice(0, 40), result.before, `${mode}: applied steps are untouched`);
    assert.equal(result.after.length, 41, mode);
    assert.equal(result.after.at(-1)?.startsWith('116:'), true, mode);
    assert.deepEqual(result.version, { user_version: 116 }, mode);
    assert.deepEqual(result.embeddings, { vectors: true, attempts: true, metrics: true }, mode);
  }
});

test('the lifecycle audit knows both embedding tables: a source world passes, leftovers fail the cleared audit', (t) => {
  const store = nodeAt115();
  t.after(() => store.close());
  migrateWebProviderEmbeddings(store);
  const now = 1_700_000_000_000;
  seed(store, now);
  store.run(
    "INSERT INTO memory_embeddings VALUES ('world','conversation','character','猫','m',1024,?,?,1,'ready',?)",
    vector(1024, 1),
    hash,
    now,
  );
  const world = store as unknown as Parameters<typeof auditWebLifecycleWorld>[0];
  auditWebLifecycleWorld(world, 'world', 'source');
  assert.throws(() => auditWebLifecycleWorld(world, 'world', 'cleared'), /WEB_RETENTION_UNEXPECTED_WORLD_DATA/);
  store.run('DELETE FROM memory_embeddings');
  store.run(
    `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,
    price_micros_per_million,held_micros,state,lease_expires_at,created_at)
    VALUES ('a','index','world','conversation','character','m',1,10,11800,1,'not_sent',?,?)`,
    now,
    now,
  );
  auditWebLifecycleWorld(world, 'world', 'source');
  assert.throws(() => auditWebLifecycleWorld(world, 'world', 'cleared'), /WEB_RETENTION_UNEXPECTED_WORLD_DATA/);
  store.run('DELETE FROM web_embed_attempts');
  store.run('DELETE FROM memory_topics');
  auditWebLifecycleWorld(world, 'world', 'cleared');
});

test('purge helper: only never-sent holds come back, scoped to the world or conversation; older schemas are a no-op', (t) => {
  const old = nodeAt115();
  t.after(() => old.close());
  releaseUnsentEmbedHolds(old, 'world');
  assert.equal(embeddingTableExists(old, 'web_embed_attempts'), false);
  assert.deepEqual([...LATE_TABLES].sort(), ['memory_embeddings', 'memory_facts', 'web_embed_attempts']);

  const store = nodeAt115();
  t.after(() => store.close());
  migrateWebProviderEmbeddings(store);
  const now = 1_700_000_000_000;
  store.run("INSERT INTO web_provider_spending(provider,currency,limit_micros) VALUES ('cloudflare','USD',1000000)");
  const attempt = (id: string, world: string, conversation: string, state: string, held: number) => {
    store.run(
      `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,
      price_micros_per_million,held_micros,state,sent_at,lease_expires_at,created_at)
      VALUES (?,'index',?,?,'character','m',1,10,11800,?,?,?,?,?)`,
      id,
      world,
      conversation,
      held,
      state,
      state === 'not_sent' ? null : now,
      now,
      now,
    );
    store.run("UPDATE web_provider_spending SET held_micros=held_micros+? WHERE provider='cloudflare'", held);
  };
  attempt('a', 'w1', 'c1', 'not_sent', 5);
  attempt('b', 'w1', 'c1', 'sent', 3);
  attempt('c', 'w1', 'c2', 'not_sent', 7);
  attempt('d', 'w2', 'c1', 'not_sent', 11);
  attempt('e', 'w1', 'c1', 'unknown', 13);
  const held = () => store.get<{ held_micros: number }>('SELECT held_micros FROM web_provider_spending')!.held_micros;
  assert.equal(held(), 39);
  // A purge deletes the rows right after the release, so the release is not repeatable on its own.
  releaseUnsentEmbedHolds(store, 'w1', 'c1');
  store.run("DELETE FROM web_embed_attempts WHERE world_id='w1' AND conversation_id='c1'");
  assert.equal(held(), 34, 'one conversation: only its never-sent call (5)');
  releaseUnsentEmbedHolds(store, 'w1');
  assert.equal(held(), 27, 'the whole world: the other conversation (7) too; sent and UNKNOWN holds stay');
  releaseUnsentEmbedHolds(store, 'unknown-world');
  assert.equal(held(), 27);
});
