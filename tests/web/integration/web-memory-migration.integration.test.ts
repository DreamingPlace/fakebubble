import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

function nodeAt114() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  return store;
}

const rows = (store: Store, table: string) =>
  store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);

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
    `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
    VALUES ('input','world','conversation','player','player','我养了一只猫',?,'text',0)`,
    now,
  );
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  store.run(
    "INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at) VALUES ('window','ip',?,?)",
    now - 1,
    now + 999_999,
  );
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at)
    VALUES ('operation','principal','request','payload','world','conversation','character','input',
      'window','published','used',?,?)`,
    now,
    now + 100_000,
  );
  store.run(
    `INSERT INTO jobs(id,world_id,conversation_id,character_id,kind,epoch,status,created_at,lease_until,
    covered_ids_json,requested_delivery) VALUES ('job','world','conversation','character','reply',1,'published',?,?,'[]','voice')`,
    now,
    now,
  );
  store.run("INSERT INTO memory_topics VALUES ('world','conversation','character','猫',?,?,?,?)", 'long', 2, now, now);
  store.run("INSERT INTO memory_topics VALUES ('world','conversation','character','天气','short',0,?,?)", now, now + 1);
  store.run(
    "INSERT INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES ('m1','world','conversation','character','猫')",
  );
  store.run(
    "INSERT INTO memory_episodes VALUES ('world','conversation','character','猫','job','玩家养了一只猫','player_statement',?,?)",
    '["input"]',
    now,
  );
  store.run("INSERT INTO memory_mentions VALUES ('world','conversation','character','猫','input')");
  store.run('INSERT INTO web_operation_metrics(operation_id,day) VALUES (?,?)', 'operation', '2023-11-14');
}

test('local runner: 115 is its own step after 114, sets user_version=115 and is not repeatable', (t) => {
  const store = nodeAt114();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 114);
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'memory_facts'), undefined);
  migrateWebProviderMemory(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 115);
  assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', 'memory_facts'));
  assert.throws(() => migrateWebProviderMemory(store), /WEB_PROVIDER_MEMORY_MIGRATION_REQUIRED/);
});

test('a populated 114 database upgrades to 115 keeping every memory and metrics row', (t) => {
  const store = nodeAt114();
  t.after(() => store.close());
  const now = 1_700_000_000_000;
  seed(store, now);
  const before = Object.fromEntries(
    ['memory_topics', 'memory_episodes', 'memory_mentions', 'memory_catalog', 'web_operation_metrics'].map((table) => [
      table,
      rows(store, table),
    ]),
  );
  assert.equal(before.memory_topics!.length, 2);
  migrateWebProviderMemory(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 115);
  for (const table of ['memory_episodes', 'memory_mentions', 'memory_catalog'])
    assert.deepEqual(rows(store, table), before[table], `${table} is unchanged`);
  // Existing topics and metrics keep every old column value and gain only the new column's default.
  assert.deepEqual(
    rows(store, 'memory_topics').map(({ importance, ...old }) => ({ importance, old: { ...old } })),
    (before.memory_topics as Record<string, unknown>[]).map((old) => ({ importance: 3, old: { ...old } })),
  );
  assert.deepEqual(
    rows(store, 'web_operation_metrics').map(({ review_changed, ...old }) => ({ review_changed, old: { ...old } })),
    (before.web_operation_metrics as Record<string, unknown>[]).map((old) => ({
      review_changed: null,
      old: { ...old },
    })),
  );
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  // The new constraints hold.
  assert.throws(() => store.run("UPDATE memory_topics SET importance=11 WHERE topic_key='猫'"), /CHECK/);
  assert.throws(() => store.run('UPDATE web_operation_metrics SET review_changed=2'), /CHECK/);
  const fact = (id: string, key: string, retired: number | null = null) =>
    store.run(
      `INSERT INTO memory_facts VALUES ('world','conversation','character',?,?,?,?,?,?,?,?,NULL)`,
      id,
      key,
      '玩家养了一只猫',
      8,
      '["input"]',
      now,
      now,
      retired,
    );
  fact('f1', '宠物');
  assert.throws(() => fact('f2', '宠物'), /UNIQUE/, 'one active fact per scope and key');
  fact('f3', '宠物', now);
  assert.throws(() => store.run("UPDATE memory_facts SET importance=0 WHERE id='f1'"), /CHECK/);
  assert.throws(() => store.run("UPDATE memory_facts SET statement=? WHERE id='f1'", 'x'.repeat(241)), /CHECK/);
});

test('Cloudflare runner: an existing authority at 114 upgrades to 115 through the normal path (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      review: { importance: boolean; facts: boolean; reviewChanged: boolean };
    }>(`/upgrade?mode=${mode}&through=114&object=memory-${mode}`);
    assert.equal(result.before.length, 39, mode);
    assert.equal(result.before.at(-1)?.startsWith('114:'), true, mode);
    assert.deepEqual(result.after.slice(0, 39), result.before, `${mode}: applied steps are untouched`);
    // Opening the authority applies every newer step in order: 115, 116, 117, then 118 (see web-embedding-migration and
    // web-cocreation-migration). Extended for migration 118.
    assert.equal(result.after.length, 43, mode);
    assert.equal(result.after.at(-4)?.startsWith('115:'), true, mode);
    assert.equal(result.after.at(-3)?.startsWith('116:'), true, mode);
    assert.equal(result.after.at(-2)?.startsWith('117:'), true, mode);
    assert.equal(result.after.at(-1)?.startsWith('118:'), true, mode);
    assert.deepEqual(result.version, { user_version: 118 }, mode);
    assert.deepEqual(result.review, { importance: true, facts: true, reviewChanged: true }, mode);
  }
});

test('the lifecycle audit knows memory_facts: a source world passes, a fact surviving a purge fails the cleared audit', (t) => {
  const store = nodeAt114();
  t.after(() => store.close());
  migrateWebProviderMemory(store);
  const now = 1_700_000_000_000;
  store.db.exec('PRAGMA foreign_keys=ON');
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
    "INSERT INTO memory_facts VALUES ('world','conversation','character','f1','宠物','玩家养了一只猫',8,'[]',?,?,NULL,NULL)",
    now,
    now,
  );
  const world = store as unknown as Parameters<typeof auditWebLifecycleWorld>[0];
  auditWebLifecycleWorld(world, 'world', 'source');
  assert.throws(() => auditWebLifecycleWorld(world, 'world', 'cleared'), /WEB_RETENTION_UNEXPECTED_WORLD_DATA/);
  store.run('DELETE FROM memory_facts');
  auditWebLifecycleWorld(world, 'world', 'cleared');
});
