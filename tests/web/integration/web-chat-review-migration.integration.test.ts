import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderChatReview,
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderLogins,
  migrateWebProviderMemory,
  migrateWebProviderMemoryMetrics,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
  migrateWebProviderPreviewWorkbench,
  migrateWebProviderSignupBonus,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

function nodeAt121() {
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
  migrateWebProviderCocreation(store);
  migrateWebProviderLogins(store);
  migrateWebProviderPreviewWorkbench(store);
  migrateWebProviderMemoryMetrics(store);
  migrateWebProviderSignupBonus(store);
  return store;
}
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const sql122 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/122_chat_review.sql', import.meta.url), 'utf8');
const tables = (store: Store) =>
  store
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('web_review_codes','web_review_notice','web_review_archive') ORDER BY name",
    )
    .map((row) => row.name);

test('local runner: 122 is its own step after 121, adds the three chat-review tables and is not repeatable', (t) => {
  const store = nodeAt121();
  t.after(() => store.close());
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 121);
  assert.deepEqual(tables(store), []);
  migrateWebProviderChatReview(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 122);
  assert.deepEqual(tables(store), ['web_review_archive', 'web_review_codes', 'web_review_notice']);
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => migrateWebProviderChatReview(store), /WEB_PROVIDER_CHAT_REVIEW_MIGRATION_REQUIRED/);
  const fresh = new Store(':memory:');
  t.after(() => fresh.close());
  assert.throws(() => migrateWebProviderChatReview(fresh), /WEB_PROVIDER_CHAT_REVIEW_MIGRATION_REQUIRED/);
});

test('the tables only accept what the review writes: a 4-character code from the alphabet, one row per principal, 180-day expiry', (t) => {
  const store = nodeAt121();
  t.after(() => store.close());
  migrateWebProviderChatReview(store);
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.db.exec("INSERT INTO web_review_codes VALUES ('p1','K7M2',1)");
  for (const bad of ['AX01', 'ABCO', 'ABCI', 'ABCL', 'abcd', 'ABC', 'ABCDE'])
    assert.throws(() => store.db.exec(`INSERT INTO web_review_codes VALUES ('p-${bad}','${bad}',1)`), bad);
  assert.throws(() => store.db.exec("INSERT INTO web_review_codes VALUES ('p1','Q9ZZ',1)"), 'one code per principal');
  store.db.exec("INSERT INTO web_review_notice VALUES ('p1',1)");
  assert.throws(() => store.db.exec("INSERT INTO web_review_notice VALUES ('p1',2)"));
  const row = (over: Partial<Record<string, string | number>> = {}) => {
    const values = {
      label: 'JOJO-K7M2',
      review_code: 'K7M2',
      character_id: 'jojo',
      line_order: 0,
      at_local: '2026-10-12 10:30',
      speaker: 'player',
      text: '你好',
      status: 'ok',
      error_code: null,
      review_changed: 0,
      archived_at: 1000,
      expires_at: 1000 + 180 * 24 * 60 * 60_000,
      ...over,
    };
    store.run(
      `INSERT INTO web_review_archive(label,review_code,character_id,line_order,at_local,speaker,text,status,error_code,
        review_changed,archived_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ...(Object.values(values) as (string | number | null)[]),
    );
  };
  row();
  assert.throws(() => row(), 'one line per position of a label');
  row({ line_order: 1 });
  assert.throws(() => row({ line_order: 2, expires_at: 2000 }), 'expiry is exactly archived_at + 180 days');
  assert.throws(() => row({ line_order: 2, speaker: 'admin' }));
  assert.throws(() => row({ line_order: 2, status: 'weird' }));
  assert.throws(() => row({ line_order: 2, review_changed: 2 }));
  assert.throws(() => row({ line_order: 2, review_code: 'K7' }));
  assert.throws(() => row({ line_order: -1 }));
});

test('Cloudflare runner: 122 is the same SQL on both authorities, second to last of 48 steps, and 118-121 are unchanged', () => {
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 21b, migration 123): 48 steps, and 122 is now second to last. No assertion was weakened.
  // Named exception (Part 21g, migration 124): the ledger now has 49 steps and 124 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts, positions counted
  // from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 52);
  assert.equal(r2.length, 52);
  assert.equal(inline.at(-6)!.version, 122);
  assert.equal(r2.at(-6)!.version, 122);
  assert.equal(inline.at(-6)!.sha256, sha(sql122()), 'the ledger hash is the sha256 of the SQL file as written');
  assert.equal(inline.at(-6)!.sha256, r2.at(-6)!.sha256);
  assert.equal(
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    inline.at(-6)!.sha256,
    '5a81455c85a05c9095d66eb50803acefc1d2c2f6b0a478891e733d1471eec950',
    'pinned: a change to the file is a new migration',
  );
  // Nothing before it moved (hashes as main applied them at Part 18).
  const pinned: Record<number, string> = {
    118: '4c5f3beb3db1ef7d683e0bac332c0b37d9cea1d350ccb295267154a4ed777a9b',
    119: '16d1db76b4de5a28024a18008d7eb79a0b65dea8170c2c0da225b407dc155066',
    120: '5fe0cf7c482aa39772024210b75cccfecb2c738d7ecaf0ee3022db3b84275cde',
    121: 'f0fa334dbb0ac155d5421792e612438b722b9882fc8ff11a145e34e705fef8d9',
  };
  for (const [version, hash] of Object.entries(pinned)) {
    assert.equal(inline.find((m) => m.version === Number(version))!.sha256, hash, `inline ${version}`);
    assert.equal(r2.find((m) => m.version === Number(version))!.sha256, hash, `r2 ${version}`);
  }
});

test('Cloudflare runner: an existing authority at 121 gains 122 untouched (inline and R2)', async (t) => {
  const f = localRuntime(t, 'tests/web/fixtures/cloudflare-metrics-worker.ts', { STATE: 'WebMetricsFixture' });
  for (const mode of ['inline', 'r2']) {
    const result = await f.call<{ before: string[]; after: string[]; version: unknown }>(
      `/upgrade?mode=${mode}&through=121&object=cr-${mode}`,
    );
    assert.equal(result.before.length, 46, mode);
    assert.equal(result.before.at(-1)?.startsWith('121:'), true, mode);
    assert.deepEqual(result.after.slice(0, 46), result.before, `${mode}: applied steps are untouched`);
    // Named exception (Part 21b, migration 123): the upgrade runs on to the newest step, so 122 is second to last of 48.
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
    assert.equal(result.after.length, 52, mode);
    assert.equal(result.after.at(-6), `122:${sha(sql122())}`, mode);
    assert.equal(result.after.at(-5)?.startsWith('123:'), true, mode);
    assert.equal(result.after.at(-4)?.startsWith('124:'), true, mode); // Extended for migration 124: the newest step is last.
    assert.equal(result.after.at(-3)?.startsWith('125:'), true, mode); // Extended for migration 125: the newest step is last.
    assert.equal(result.after.at(-2)?.startsWith('126:'), true, mode); // Extended for migration 126: the newest step is last.
    assert.equal(result.after.at(-1)?.startsWith('127:'), true, mode); // Extended for migration 127: the newest step is last.
    assert.deepEqual(result.version, { user_version: 127 }, mode);
  }
});
