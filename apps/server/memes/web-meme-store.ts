import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 37c-1: the per-entry on/off of the internet-meme dictionary. NO numbered migration (expected-migrations is untouched): the two
 * tables are installed idempotently at business-object start and checked against the digest of their statements. Any other state
 * (a foreign `web_meme_*` table, a changed digest) stops the start with WEB_MEME_SCHEMA_MISMATCH.
 *
 * An entry is ON unless it ships DEFAULT OFF (dropped in the Part 37c-1b re-curation, or a common everyday word). The table holds only the administrator's
 * OVERRIDES of that default, both ways: enabled=1 turns a default-off entry on, enabled=0 turns any entry off; a switch back to the
 * default deletes the row. No content, no player data, no id of a person. The dictionary itself ships with the build (meme-dictionary.generated.ts).
 */
const statements = [
  'CREATE TABLE web_meme_switch(entry_key TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),changed_at INTEGER NOT NULL) STRICT',
  'CREATE TABLE web_meme_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installMemeStore(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_meme_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_meme_*'"), 'WEB_MEME_SCHEMA_MISMATCH');
      for (const statement of statements) store.run(statement);
      store.run('INSERT INTO web_meme_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_meme_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_MEME_SCHEMA_MISMATCH');
    const tables = store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name GLOB 'web_meme_*' ORDER BY name",
    );
    ensure(tables.map((row) => row.name).join(',') === 'web_meme_schema,web_meme_switch', 'WEB_MEME_SCHEMA_MISMATCH');
  });
}
