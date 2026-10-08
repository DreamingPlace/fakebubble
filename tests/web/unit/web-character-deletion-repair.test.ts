import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test, { type TestContext } from 'node:test';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { installWebCharacterDeletion } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import {
  migrateWebProviderEmbeddings,
  migrateWebProviderMemory,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { Store } from '../../../apps/server/platform/store.ts';
import type { WebRuntimeStore } from '../../../apps/server/platform/web-store-contract.ts';

const guardedTriggers = [
  'web_input_snapshots_no_delete',
  'web_v7_requests_no_delete',
  'web_v7_candidates_no_delete',
  'web_publications_no_delete',
  'web_publication_items_no_delete',
  'web_local_text_outputs_no_delete',
  'web_local_audio_outputs_no_delete',
  'web_provider_outputs_no_delete',
  'web_provider_candidates_no_delete',
  'web_provider_media_no_delete',
];
const triggerSql = (store: Store, name: string) =>
  store.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name=?', name)?.sql;
const allTriggers = (store: Store) =>
  Object.fromEntries(guardedTriggers.map((name) => [name, triggerSql(store, name)]));
const deletionAware = (sql: string | undefined) => !!sql && sql.includes('web_character_purge_gate');

/** A Node authority exactly as the old code left a production database: schema 113 with the deletion schema installed. */
function installedAt113(t: TestContext) {
  const raw = new Store(':memory:');
  t.after(() => raw.close());
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    raw.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  raw.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(raw);
  const store = Object.assign(raw, {
    webReceiptDigest: (kind: string, json: string) =>
      createHash('sha256')
        .update(kind + ':repair-fixture:' + json)
        .digest('hex'),
  }) as unknown as WebRuntimeStore;
  new WebAccountAdmin(store, { now: () => 1_700_000_000_000 }, 'https://fixture.invalid');
  installWebCharacterDeletion(store);
  return { raw, store };
}
const upgradeTo116 = (raw: Store) => {
  migrateWebProviderMetrics(raw);
  migrateWebProviderMemory(raw);
  migrateWebProviderEmbeddings(raw);
};

test('migration 114 leaves the pre-deletion publication-item trigger; the next start repairs only that trigger, once', (t) => {
  const { raw, store } = installedAt113(t);
  const digest = raw.get('SELECT * FROM web_character_deletion_schema');
  const before = allTriggers(raw);
  assert.ok(guardedTriggers.every((name) => deletionAware(before[name])));
  upgradeTo116(raw);
  const broken = allTriggers(raw);
  assert.equal(deletionAware(broken.web_publication_items_no_delete), false, 'the 114 rebuild lost the deletion gate');
  for (const name of guardedTriggers.filter((n) => n !== 'web_publication_items_no_delete'))
    assert.equal(broken[name], before[name], `${name} is untouched by 114-116`);

  installWebCharacterDeletion(store);
  const repaired = allTriggers(raw);
  assert.deepEqual(repaired, before, 'every guarded trigger is back to the deletion-aware text, byte for byte');
  assert.deepEqual(raw.get('SELECT * FROM web_character_deletion_schema'), digest, 'the digest is not changed');

  installWebCharacterDeletion(store);
  assert.deepEqual(allTriggers(raw), repaired, 'a second start changes nothing');
});

test('a guarded trigger with any other SQL still raises WEB_DELETION_SCHEMA_MISMATCH and is left alone', (t) => {
  const { raw, store } = installedAt113(t);
  upgradeTo116(raw);
  const current = triggerSql(raw, 'web_publication_items_no_delete')!;
  const variants: Record<string, string> = {
    'a different error code': current.replace('WEB_PUBLICATION_ITEM_IMMUTABLE', 'SOMETHING_ELSE'),
    'an unconditional trigger': current.replace(/WHEN NOT[\s\S]*?BEGIN/, 'BEGIN'),
    'a widened gate': current.replace("r.state='purging'", "r.state IN ('purging','active')"),
  };
  for (const [label, sql] of Object.entries(variants)) {
    assert.notEqual(sql, current, label);
    raw.db.exec('DROP TRIGGER web_publication_items_no_delete');
    raw.db.exec(sql);
    assert.throws(() => installWebCharacterDeletion(store), /WEB_DELETION_SCHEMA_MISMATCH/, label);
    assert.equal(triggerSql(raw, 'web_publication_items_no_delete'), sql, `${label}: not touched`);
  }
  // A deletion-aware trigger that was edited is just as unacceptable as a legacy one.
  const { raw: other, store: otherStore } = installedAt113(t);
  const aware = triggerSql(other, 'web_publications_no_delete')!;
  other.db.exec('DROP TRIGGER web_publications_no_delete');
  other.db.exec(aware.replace("d.state='purging'", "d.state IN ('purging','deleted')"));
  assert.throws(() => installWebCharacterDeletion(otherStore), /WEB_DELETION_SCHEMA_MISMATCH/);
  // A missing trigger is not repaired either.
  other.db.exec('DROP TRIGGER web_publications_no_delete');
  assert.throws(() => installWebCharacterDeletion(otherStore), /WEB_DELETION_SCHEMA_MISMATCH/);
});
