import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 24j: storage of the 角色代码 and of what a profile import could not place yet. NO numbered migration: installed
 * idempotently and digest-checked at start, like the 24f restore step and the 26b comparison tables.
 *
 *   web_profile_codes      one code per character, unique case-insensitively (code_key is the lower-cased code). The same row
 *                          records, against the code, the avatar file NAME (there is no image storage yet, Part 25e) and the Fish
 *                          voice reference id the 声音 page offers when preparing material. Nothing here is generated or approved.
 *   web_profile_checklist  per character, what a file said that cannot be stored yet. 'open' until resolved or dismissed.
 *
 * Neither table holds a player, world or operation id, so the retention audits never see them as player data. The names do not
 * start with `web_character_`: that prefix is reserved by the character catalog's own first-install check.
 */
const statements = [
  `CREATE TABLE web_profile_codes(character_id TEXT PRIMARY KEY,code TEXT NOT NULL
    CHECK(length(code) BETWEEN 2 AND 12 AND code NOT GLOB '*[^A-Za-z0-9_-]*'),
    code_key TEXT NOT NULL UNIQUE CHECK(code_key=lower(code)),avatar_file TEXT,voice_reference_id TEXT,
    created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_profile_checklist(character_id TEXT NOT NULL,item_key TEXT NOT NULL,item_text TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('open','dismissed')),created_at INTEGER NOT NULL,
    PRIMARY KEY(character_id,item_key)) STRICT`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installProfileImport(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_profile_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_profile_*'"), 'WEB_PROFILE_SCHEMA_MISMATCH');
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_profile_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_profile_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_profile_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_PROFILE_SCHEMA_MISMATCH');
  });
}
export const profileImportInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_profile_schema'");

export interface CodeRow {
  character_id: string;
  code: string;
  code_key: string;
  avatar_file: string | null;
  voice_reference_id: string | null;
}
type Read = Pick<BusinessStore, 'get' | 'all'>;
export const allCodes = (store: Read): CodeRow[] =>
  profileImportInstalled(store)
    ? store.all<CodeRow>('SELECT character_id,code,code_key,avatar_file,voice_reference_id FROM web_profile_codes')
    : [];
export const codeOf = (store: Read, characterId: string): CodeRow | null =>
  profileImportInstalled(store)
    ? (store.get<CodeRow>(
        'SELECT character_id,code,code_key,avatar_file,voice_reference_id FROM web_profile_codes WHERE character_id=?',
        characterId,
      ) ?? null)
    : null;
export const checklistOf = (store: Read, characterId: string) =>
  profileImportInstalled(store)
    ? store
        .all<{ item_key: string; item_text: string; state: 'open' | 'dismissed' }>(
          'SELECT item_key,item_text,state FROM web_profile_checklist WHERE character_id=? ORDER BY rowid',
          characterId,
        )
        .map((row) => ({ key: row.item_key, text: row.item_text, state: row.state }))
    : [];
/** The profile data of one character that deleting it removes. Called by the character deletion's own cleanup. */
export function clearProfileMeta(store: BusinessStore, characterId: string) {
  if (!profileImportInstalled(store)) return;
  store.run('DELETE FROM web_profile_codes WHERE character_id=?', characterId);
  store.run('DELETE FROM web_profile_checklist WHERE character_id=?', characterId);
}
