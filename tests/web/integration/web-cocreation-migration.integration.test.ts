import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { purgeCocreation } from '../../../apps/server/cocreation/web-cocreation-purge.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

function nodeAt116() {
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
  migrateWebProviderEmbeddings(store);
  return store;
}
const rows = (store: Store, table: string) =>
  store.all<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`);
const hash = 'c'.repeat(64);
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql117 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/117_cocreation.sql', import.meta.url), 'utf8');

function seed(store: Store, now: number) {
  store.db.exec('PRAGMA foreign_keys=ON');
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', now);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
}

test('local runner: 117 is its own step after 116, sets user_version=117 and is not repeatable', (t) => {
  const store = nodeAt116();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 116);
  assert.equal(store.get('SELECT 1 FROM sqlite_master WHERE name=?', 'web_cocreation_submissions'), undefined);
  migrateWebProviderCocreation(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 117);
  for (const table of ['web_cocreation_submissions', 'web_cocreation_answers'])
    assert.ok(store.get('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', 'table', table), table);
  assert.throws(() => migrateWebProviderCocreation(store), /WEB_PROVIDER_COCREATION_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderCocreation(fresh), /WEB_PROVIDER_COCREATION_MIGRATION_REQUIRED/);
});

test('a populated 116 database upgrades to 117 keeping every row; the new constraints hold', (t) => {
  const store = nodeAt116();
  t.after(() => store.close());
  const now = 1_700_000_000_000;
  seed(store, now);
  const before = Object.fromEntries(
    ['web_principals', 'worlds', 'api_players'].map((table) => [table, rows(store, table)]),
  );
  migrateWebProviderCocreation(store);
  for (const table of Object.keys(before)) assert.deepEqual(rows(store, table), before[table], `${table} is unchanged`);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.equal(rows(store, 'web_cocreation_submissions').length, 0, 'the migration submits nothing');

  const submit = (id: string, extra: Record<string, unknown> = {}) => {
    const row = {
      id,
      character_id: 'wei-guagua',
      principal_id: 'principal',
      request_id: `request-${id}`,
      request_hash: hash,
      created_at: now,
      ...extra,
    };
    store.run(
      `INSERT INTO web_cocreation_submissions(${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`,
      ...(Object.values(row) as (string | number | null)[]),
    );
  };
  submit('s1');
  assert.deepEqual(
    {
      ...store.get<object>(
        'SELECT status,starred,admin_note,processed_by,processed_at FROM web_cocreation_submissions',
      ),
    },
    { status: 'new', starred: 0, admin_note: null, processed_by: null, processed_at: null },
    'a submission starts new, unstarred and unprocessed',
  );
  assert.throws(() => submit('s2', { request_id: 'request-s1' }), /UNIQUE/, 'one request id per player');
  assert.throws(() => submit('s3', { status: 'done' }), /CHECK/, 'only new, processed and archived');
  assert.throws(() => submit('s4', { starred: 2 }), /CHECK/);
  assert.throws(() => submit('s5', { request_hash: 'short' }), /CHECK/, 'the request hash is a sha256');
  assert.throws(() => submit('s6', { principal_id: 'nobody' }), /FOREIGN KEY/, 'a submission belongs to a principal');
  assert.throws(() => submit('s7', { processed_by: 'member' }), /CHECK/, 'processed_by and processed_at go together');
  submit('s8', { status: 'processed', processed_by: 'member', processed_at: now });

  const answer = (ordinal: number, extra: Record<string, unknown> = {}) => {
    const row = {
      submission_id: 's1',
      ordinal,
      card_id: 'catchphrase',
      target_field: 'speechStyle',
      kind: 'text',
      text_json: '"口头禅"',
      ...extra,
    };
    store.run(
      `INSERT INTO web_cocreation_answers(${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
        .map(() => '?')
        .join(',')})`,
      ...(Object.values(row) as (string | number | null)[]),
    );
  };
  answer(0);
  assert.throws(() => answer(0), /UNIQUE|PRIMARY/, 'one answer per ordinal');
  assert.throws(() => answer(12), /CHECK/, 'at most twelve answers');
  assert.throws(() => answer(1, { submission_id: 'missing' }), /FOREIGN KEY/);
  assert.throws(() => answer(1, { target_field: 'secret' }), /CHECK/, 'only known target fields');
  assert.throws(() => answer(1, { kind: 'photo' }), /CHECK/);
  assert.throws(() => answer(1, { text_json: 'not json' }), /CHECK/, 'text_json is JSON');
  assert.throws(() => answer(1, { kind: 'dialogue', text_json: '"a string"' }), /CHECK/, 'a dialogue is an object');
  assert.throws(() => answer(1, { kind: 'text', text_json: '{"player":"a"}' }), /CHECK/, 'a text answer is a string');
  answer(1, { kind: 'dialogue', target_field: 'dialogueExamples', text_json: '{"player":"你好","replies":["嗯"]}' });
  assert.throws(() => answer(2, { adopted_at: 1 }), /CHECK/, 'adopted_at and adopted_by go together');
  answer(2, { adopted_at: 1, adopted_by: 'member' });
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
});

test('the lifecycle audit knows both tables, and the purge helper removes answers before submissions', (t) => {
  const store = nodeAt116();
  t.after(() => store.close());
  migrateWebProviderCocreation(store);
  const now = 1_700_000_000_000;
  seed(store, now);
  const submit = (id: string, character: string) => {
    store.run(
      'INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at) VALUES (?,?,?,?,?,?)',
      id,
      character,
      'principal',
      id,
      hash,
      now,
    );
    store.run(
      `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json)
      VALUES (?,0,'free','free','text','"x"')`,
      id,
    );
  };
  submit('a', 'jojo');
  submit('b', 'wei-guagua');
  // A source world passes (the player's ideas are not world content); a cleared world must not still hold them.
  auditWebLifecycleWorld(store as never, 'world', 'source');
  assert.throws(
    () => auditWebLifecycleWorld(store as never, 'world', 'cleared'),
    /WEB_RETENTION_UNEXPECTED_WORLD_DATA/,
  );
  assert.throws(() => purgeCocreation(store, {}), /COCREATION_PURGE_SCOPE_REQUIRED/);
  purgeCocreation(store, { characterId: 'jojo' });
  assert.deepEqual(
    rows(store, 'web_cocreation_submissions').map((r) => r.id),
    ['b'],
  );
  assert.equal(rows(store, 'web_cocreation_answers').length, 1);
  purgeCocreation(store, { principalId: 'principal' });
  assert.equal(rows(store, 'web_cocreation_submissions').length, 0);
  assert.equal(rows(store, 'web_cocreation_answers').length, 0);
  auditWebLifecycleWorld(store as never, 'world', 'cleared');
});

test('Cloudflare runner: 117 is the same SQL on both authorities and its ledger hash is stable', () => {
  const { inline, r2 } = expectedWebMigrations();
  const last = (list: { version: number; sha256: string }[]) => list.at(-1)!;
  assert.equal(last(inline).version, 117);
  assert.equal(last(r2).version, 117);
  assert.equal(last(inline).sha256, sha(sql117()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(last(inline).sha256, last(r2).sha256, 'only the R2 schema-113 step differs between the lists');
});

test('Cloudflare runner: an existing authority at 116 upgrades to 117 through the normal path (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{
      before: string[];
      after: string[];
      version: unknown;
      cocreation: { submissions: boolean; answers: boolean };
    }>(`/upgrade?mode=${mode}&through=116&object=cocreation-${mode}`);
    assert.equal(result.before.length, 41, mode);
    assert.equal(result.before.at(-1)?.startsWith('116:'), true, mode);
    assert.deepEqual(result.after.slice(0, 41), result.before, `${mode}: applied steps are untouched`);
    assert.equal(result.after.length, 42, mode);
    assert.equal(result.after.at(-1), `117:${sha(sql117())}`, mode);
    assert.deepEqual(result.version, { user_version: 117 }, mode);
    assert.deepEqual(result.cocreation, { submissions: true, answers: true }, mode);
  }
});
