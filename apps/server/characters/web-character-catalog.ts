import { createHash } from 'node:crypto';
import type { CharacterTemplate } from '../../../packages/contracts/index.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

export interface WebCharacterPresentation {
  displayName: string;
  publicDescription: string;
  welcome: { text: string; version: string };
}
export interface WebCharacterProfile {
  template: CharacterTemplate;
  presentation: WebCharacterPresentation;
}
export type CatalogEntry = WebCharacterProfile & { characterId: string; version: number; position: number };
export const characterProfileHash = (value: WebCharacterProfile) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

const statements = [
  `CREATE TABLE web_character_versions(character_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>0),
    profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),content_hash TEXT NOT NULL,created_at INTEGER,
    PRIMARY KEY(character_id,version)) STRICT`,
  `CREATE TABLE web_character_catalog(character_id TEXT PRIMARY KEY REFERENCES character_templates(id),
    version INTEGER NOT NULL,position INTEGER NOT NULL UNIQUE CHECK(position>=0 AND position<15),
    FOREIGN KEY(character_id,version) REFERENCES web_character_versions(character_id,version)) STRICT`,
  `CREATE TABLE web_character_revisions(character_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),
    base_version INTEGER,profile_json TEXT NOT NULL CHECK(json_valid(profile_json)),content_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    PRIMARY KEY(character_id,revision)) STRICT`,
  `CREATE TABLE web_character_drafts(character_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,
    FOREIGN KEY(character_id,revision) REFERENCES web_character_revisions(character_id,revision)) STRICT`,
  ...['web_character_versions', 'web_character_revisions'].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (action) =>
        `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'WEB_CHARACTER_HISTORY_IMMUTABLE'); END`,
    ),
  ),
] as const;

const publicationStatements = [
  `CREATE TABLE web_character_publications(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,version INTEGER NOT NULL,revision INTEGER NOT NULL,profile_hash TEXT NOT NULL,
    preview_id TEXT NOT NULL REFERENCES admin_previews(id),preview_hash TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES web_admin_members(id),session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    created_at INTEGER NOT NULL,UNIQUE(character_id,version),
    FOREIGN KEY(character_id,version) REFERENCES web_character_versions(character_id,version),
    FOREIGN KEY(character_id,revision) REFERENCES web_character_revisions(character_id,revision)) STRICT`,
  ...['UPDATE', 'DELETE'].map(
    (action) => `CREATE TRIGGER web_character_publications_${action.toLowerCase()}
    BEFORE ${action} ON web_character_publications BEGIN SELECT RAISE(ABORT,'WEB_CHARACTER_HISTORY_IMMUTABLE'); END`,
  ),
] as const;

/** One-time import of the approved seed; subsequent construction reads durable publication pointers. */
export function installWebCharacterCatalog(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_character_*'"),
        'WEB_CHARACTER_SCHEMA_MISMATCH',
      );
      const templates = store.all<{ id: string; version: number; config_json: string }>(
        'SELECT * FROM character_templates ORDER BY id',
      );
      const bound = store.all<{ character_id: string }>(`SELECT character_id FROM web_provider_voice_bindings
        WHERE source='user_selected' AND approved=1 ORDER BY character_id`);
      const ids = WEB_PROVIDER_CATALOG.map((entry) => entry.characterId)
        .sort()
        .join(',');
      ensure(
        templates.map((row) => row.id).join(',') === ids && bound.map((row) => row.character_id).join(',') === ids,
        'WEB_PROVIDER_CATALOG_INVALID',
      );
      for (const sql of statements) store.all(sql);
      for (const [position, entry] of WEB_PROVIDER_CATALOG.entries()) {
        const live = templates.find((row) => row.id === entry.characterId)!;
        const profile: WebCharacterProfile = {
          template: JSON.parse(live.config_json),
          presentation: {
            displayName: entry.displayName,
            publicDescription: '',
            welcome: { ...WEB_PROVIDER_WELCOME[entry.characterId] },
          },
        };
        ensure(
          profile.template.id === live.id && profile.template.version === live.version,
          'WEB_PROVIDER_CATALOG_INVALID',
        );
        store.run(
          'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
          live.id,
          live.version,
          JSON.stringify(profile),
          characterProfileHash(profile),
        );
        store.run('INSERT INTO web_character_catalog VALUES (?,?,?)', live.id, live.version, position);
      }
      store.all('CREATE TABLE web_character_schema(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
      store.run('INSERT INTO web_character_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_character_schema');
    const publicationDigest = createHash('sha256').update(publicationStatements.join(';\n')).digest('hex');
    ensure(
      rows.length >= 1 &&
        rows.length <= 2 &&
        rows.find((row) => row.version === 1)?.sha256 === digest &&
        rows.every((row) => row.version === 1 || (row.version === 2 && row.sha256 === publicationDigest)),
      'WEB_CHARACTER_SCHEMA_MISMATCH',
    );
    if (!rows.some((row) => row.version === 2)) {
      for (const sql of publicationStatements) store.all(sql);
      store.run('INSERT INTO web_character_schema VALUES (2,?)', publicationDigest);
    }
    publishedWebCharacters(store);
  });
}

export function publishedWebCharacters(store: BusinessStore): CatalogEntry[] {
  const rows = store.all<{
    character_id: string;
    version: number;
    position: number;
    profile_json: string;
    content_hash: string;
    config_json: string;
    live_version: number;
  }>(`SELECT c.*,v.profile_json,v.content_hash,
    t.config_json,t.version live_version FROM web_character_catalog c
    JOIN web_character_versions v ON v.character_id=c.character_id AND v.version=c.version
    JOIN character_templates t ON t.id=c.character_id ORDER BY c.position`);
  ensure(rows.length <= 15, 'WEB_PROVIDER_CATALOG_INVALID');
  return rows.map((row) => {
    const profile = JSON.parse(row.profile_json) as WebCharacterProfile;
    ensure(
      characterProfileHash(profile) === row.content_hash &&
        profile.template.id === row.character_id &&
        profile.template.version === row.version &&
        row.version === row.live_version &&
        JSON.stringify(profile.template) === JSON.stringify(JSON.parse(row.config_json)),
      'WEB_PROVIDER_CATALOG_INVALID',
    );
    return { ...profile, characterId: row.character_id, version: row.version, position: row.position };
  });
}

/** No fallback to the seed once the durable catalog exists. Draft IDs are never playable. */
export function requirePublishedWebCharacter(store: BusinessStore, characterId: string) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'")) return;
  ensure(
    publishedWebCharacters(store).some((entry) => entry.characterId === characterId) &&
      store.get(
        `SELECT 1 FROM web_provider_voice_bindings WHERE character_id=? AND approved=1 AND source='user_selected'`,
        characterId,
      ),
    'WEB_CHARACTER_UNAVAILABLE',
  );
}

export function webWelcomeLine(store: BusinessStore, characterId: string) {
  if (store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'"))
    return publishedWebCharacters(store).find((entry) => entry.characterId === characterId)?.presentation.welcome;
  return Object.hasOwn(WEB_PROVIDER_WELCOME, characterId)
    ? WEB_PROVIDER_WELCOME[characterId as keyof typeof WEB_PROVIDER_WELCOME]
    : undefined;
}
