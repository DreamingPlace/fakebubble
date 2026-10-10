import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';

// SHA-256 of the version-113 step as the Cloudflare runner applied it on main (inline and R2 authorities).
const MAIN_113 = {
  inline: 'c007e0ae9e96c8e9022184634dfa46f248e8f0f4cd7c3467bc743a47f4945572',
  r2: '9b77476087f7f99de14252af68469029404e0532c032cc44ef048788ed8400ca',
};
// Extended for migration 117: the ledger now runs 100..117 (18 steps).
const ledgerVersions = Array.from({ length: 24 }, (_, i) => i + 1).concat(
  Array.from({ length: 18 }, (_, i) => 100 + i),
);

function nodeAt113() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  return store;
}

const items = (store: Store) => store.all('SELECT * FROM web_publication_items ORDER BY operation_id,ordinal');
const itemTriggers = (store: Store) =>
  store.all<{ name: string; sql: string }>(
    "SELECT name,sql FROM sqlite_master WHERE type='trigger' AND tbl_name='web_publication_items' ORDER BY name",
  );

test('local runner: 114 is its own step after 113, sets user_version=114 and is not repeatable', (t) => {
  const store = nodeAt113();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 113);
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_operation_metrics'), undefined);
  migrateWebProviderMetrics(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 114);
  for (const name of ['web_operation_metrics', 'web_attempt_rejections'])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', name), name);
  assert.ok(
    store
      .all<{ name: string }>('PRAGMA table_info(web_operation_metrics)')
      .some((column) => column.name === 'discarded_audio_segments'),
  );
  const media = store
    .all<{ name: string; notnull: number }>('PRAGMA table_info(web_publication_items)')
    .find((column) => column.name === 'media_id')!;
  assert.equal(media.notnull, 0, 'text fallback items have no audio');
  assert.deepEqual(
    itemTriggers(store).map((row) => row.name),
    ['web_publication_items_no_delete', 'web_publication_items_no_update'],
  );
  assert.throws(() => migrateWebProviderMetrics(store), /WEB_PROVIDER_METRICS_MIGRATION_REQUIRED/);
});

test('a populated 113 database upgrades to 114 keeping every web_publication_items row and both triggers', (t) => {
  const store = nodeAt113();
  t.after(() => store.close());
  const now = 1_700_000_000_000;
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
  for (const id of ['input', 'reply-0', 'reply-1', 'footer'])
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,'world','conversation','player','player','x',?,'text',0)`,
      id,
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
  store.run(
    "INSERT INTO web_publications VALUES ('operation','principal','player','world','conversation','character','input','job','rd','cd',?,'{}')",
    now,
  );
  for (const [ordinal, message, media, origin] of [
    [0, 'reply-0', 'media-0', 'narrative'],
    [1, 'reply-1', 'media-1', 'narrative'],
    [2, 'footer', 'media-footer', 'trial_footer'],
  ] as const)
    store.run('INSERT INTO web_publication_items VALUES (?,?,?,?,?)', 'operation', ordinal, message, media, origin);
  const rows = items(store);
  const triggers = itemTriggers(store);
  assert.equal(rows.length, 3);
  assert.equal(triggers.length, 2);
  migrateWebProviderMetrics(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 114);
  assert.deepEqual(items(store), rows, 'every item row is unchanged');
  assert.deepEqual(itemTriggers(store), triggers, 'both immutability triggers are unchanged');
  assert.throws(() => store.run("UPDATE web_publication_items SET media_id='x' WHERE ordinal=0"), /IMMUTABLE/);
  assert.throws(() => store.run('DELETE FROM web_publication_items WHERE ordinal=0'), /IMMUTABLE/);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

test('Cloudflare runner: the 113 step is byte-for-byte what main applied; 114 is its own ledger version', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  const inline = await f.call<{ hashes: string[]; ledger: number[] }>('/inline?object=hash-inline');
  const r2 = await f.call<{ hashes: string[]; ledger: number[] }>('/r2?object=hash-r2');
  assert.ok(inline.hashes.includes(`113:${MAIN_113.inline}`), 'inline 113 step hash equals main');
  assert.ok(r2.hashes.includes(`113:${MAIN_113.r2}`), 'R2 113 step hash equals main');
  // 114 is now fourth from last (115, 116 and 117 follow it).
  assert.equal(inline.hashes.at(-4)?.startsWith('114:'), true);
  assert.equal(r2.hashes.at(-4)?.startsWith('114:'), true);
  assert.deepEqual(inline.ledger, ledgerVersions);
  assert.deepEqual(r2.ledger, ledgerVersions);
});

test('Cloudflare runner: both authorities create 114 after 113; Worker vars are validated', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  const inline = await f.call<Record<string, unknown>>('/inline?object=inline');
  assert.equal(inline.metrics, true);
  // user_version is 117 now that the co-creation step exists.
  assert.deepEqual(inline.version, { user_version: 117 });
  assert.equal(inline.mediaIdNotNull, 0);
  assert.deepEqual(inline.concurrency, {
    maxTextRunning: 20,
    maxAudioRunning: 4,
    maxWaitingOperations: 104,
    maxGlobalReservedOperations: 128,
    audioFallbackWaitMs: 8000,
  });
  const r2 = await f.call<Record<string, unknown>>('/r2?object=r2');
  assert.equal(r2.metrics, true);
  assert.deepEqual(r2.version, { user_version: 117 });
  assert.equal(r2.mediaIdNotNull, 0);
  assert.deepEqual(r2.itemTriggers, ['web_publication_items_no_delete', 'web_publication_items_no_update']);
  assert.deepEqual(r2.ledger, ledgerVersions);
  assert.deepEqual(r2.concurrency, {
    maxTextRunning: 7,
    maxAudioRunning: 3,
    maxWaitingOperations: 104,
    maxGlobalReservedOperations: 114,
    audioFallbackWaitMs: 8000,
  });
  assert.deepEqual(await f.call('/invalid?object=invalid'), {
    errors: [
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_TEXT',
      'WEB_CONCURRENCY_INVALID_AUDIO',
      'WEB_CONCURRENCY_INVALID_AUDIO',
      'WEB_CONCURRENCY_INVALID_FALLBACK_WAIT',
    ],
    tables: [],
  });
});

test('Cloudflare runner: an existing authority at 113 upgrades to 114 through the normal path (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      metrics: boolean;
      discardedColumn: boolean;
    }>(`/upgrade?mode=${mode}&object=upgrade-${mode}`);
    assert.equal(result.before.length, 38, mode);
    assert.equal(result.before.at(-1)?.startsWith('113:'), true, mode);
    assert.deepEqual(result.after.slice(0, 38), result.before, `${mode}: applied steps are untouched`);
    // Extended for migration 117: opening the authority also applies 116 and 117 after 114 and 115.
    assert.equal(result.after.length, 42, mode);
    assert.equal(result.after.at(-4)?.startsWith('114:'), true, mode);
    assert.equal(result.after.at(-3)?.startsWith('115:'), true, mode);
    assert.equal(result.after.at(-2)?.startsWith('116:'), true, mode);
    assert.equal(result.after.at(-1)?.startsWith('117:'), true, mode);
    assert.deepEqual(result.version, { user_version: 117 }, mode);
    assert.equal(result.metrics && result.discardedColumn, true, mode);
  }
  await f.restart();
  const again = await f.call<{ ledger: number[] }>('/inline?object=upgrade-inline');
  assert.deepEqual(again.ledger, ledgerVersions, 'reopening an upgraded authority keeps it intact');
});
