import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 24k-2: the tables of the weighted 欢迎词, installed by ONE idempotent, digest-checked runtime step (like 24k-1's admin
 * speech path). No numbered migration: `expected-migrations` stays 56 / last 131. They carry no foreign keys on purpose, so the
 * step does not depend on the order in which the other runtime steps ran.
 *
 *  - web_welcome_material_lines: one welcome slot per line of a 素材版本 whose profile has 2+ lines (bound to the line id and the
 *    exact text). Append-only. A one-line profile keeps using the single welcome slot of web_character_material_assets.
 *  - web_provider_welcome_lines: the published copy of those clips, per voice bundle. Append-only; the public welcome route
 *    reads it only for a character that is on the home page.
 *  - web_welcome_choices: the line a player was given for a character. The player's data: it carries world_id, goes with the
 *    player (purgePlayerLogins) and with the character (the deletion's own transaction).
 */
const statements = [
  `CREATE TABLE web_welcome_material_lines(material_id TEXT NOT NULL,line_id TEXT NOT NULL,body TEXT NOT NULL,
    media_id TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=6000000),
    duration_ms INTEGER NOT NULL CHECK(duration_ms>0 AND duration_ms<=60000),audio_bytes BLOB,audio_ref_json TEXT,
    created_at INTEGER NOT NULL,PRIMARY KEY(material_id,line_id),CHECK((audio_bytes IS NULL)!=(audio_ref_json IS NULL))) STRICT`,
  `CREATE TABLE web_provider_welcome_lines(character_id TEXT NOT NULL,voice_version TEXT NOT NULL,line_id TEXT NOT NULL,
    body TEXT NOT NULL CHECK(length(body)>0),media_id TEXT NOT NULL UNIQUE,sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL CHECK(byte_length>0),duration_ms INTEGER NOT NULL CHECK(duration_ms>0),audio_bytes BLOB,
    audio_ref_json TEXT,created_at INTEGER NOT NULL,PRIMARY KEY(character_id,voice_version,line_id),
    CHECK((audio_bytes IS NULL)!=(audio_ref_json IS NULL))) STRICT`,
  `CREATE TABLE web_welcome_choices(world_id TEXT NOT NULL,character_id TEXT NOT NULL,line_id TEXT NOT NULL,
    body TEXT NOT NULL,version INTEGER NOT NULL,chosen_at INTEGER NOT NULL,PRIMARY KEY(world_id,character_id)) STRICT`,
  ...['web_welcome_material_lines', 'web_provider_welcome_lines'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (action) => `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'WEB_WELCOME_LINE_IMMUTABLE'); END`,
    ),
  ),
];
const TRIGGERS = 4;

export function installWebWelcomeLines(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_welcome_schema'")) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name IN ('web_welcome_material_lines','web_provider_welcome_lines','web_welcome_choices')",
        ),
        'WEB_WELCOME_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_welcome_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_welcome_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_welcome_schema');
    const guards = store.get<{ n: number }>(
      `SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_welcome_material_lines_*'
      OR type='trigger' AND name GLOB 'web_provider_welcome_lines_*'`,
    )!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === TRIGGERS,
      'WEB_WELCOME_SCHEMA_MISMATCH',
    );
  });
}

export const webWelcomeLinesInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_welcome_schema'");
