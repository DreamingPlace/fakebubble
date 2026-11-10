import { createHash } from 'node:crypto';
import type { CharacterTemplate } from '../../../packages/contracts/index.ts';
import { WEB_PROVIDER_CATALOG, WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { installWebWelcomeLines } from './web-welcome-schema.ts';
import { upgradeProfile, type WelcomeLine } from '../../../packages/contracts/web-welcomes.ts';

export interface WebCharacterPresentation {
  displayName: string;
  publicDescription: string;
  /** Part 24k-2: 1-8 weighted lines (weights are whole percents summing to 100). Old profiles are upgraded in memory on read. */
  welcomes: WelcomeLine[];
  /**
   * The old single welcome. INPUT ONLY (a save that still carries it replaces the list with that one line): a profile the server
   * reads or returns never has it.
   */
  welcome?: { text: string; version: string };
  /** The character's main chat colour, '#RRGGBB' in capitals. Absent = the player page keeps its built-in palette. */
  color?: string;
  /**
   * Part 24j: the character's colours as the profile template lists them, in order. Stored now, used by the player page only after
   * Part 24k's design board. Every entry has a hex ('#RRGGBB'); exactly one is 'main' when there are several, and `color` is its hex.
   */
  palette?: { hex: string; name: string; role: 'main' | 'accent' }[];
}
export interface WebCharacterProfile {
  template: CharacterTemplate;
  presentation: WebCharacterPresentation;
}
export type CatalogEntry = WebCharacterProfile & { characterId: string; version: number; position: number };
/** What is on disk: an old profile still has `presentation.welcome`; anything written from Part 24k-2 on has `welcomes`. */
export type StoredWebCharacterProfile = {
  template: CharacterTemplate;
  presentation: Omit<WebCharacterPresentation, 'welcomes'> & {
    welcome?: { text: string; version: string };
    welcomes?: WelcomeLine[];
  };
};
/** The hash is over the STORED bytes (never the upgraded view), so stored history keeps verifying. */
export const characterProfileHash = (value: StoredWebCharacterProfile | WebCharacterProfile) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Parse a stored profile and upgrade it in memory. The caller verifies the hash against the stored text FIRST. */
export const upgradedProfile = (stored: StoredWebCharacterProfile): WebCharacterProfile =>
  upgradeProfile(stored) as unknown as WebCharacterProfile;

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

/**
 * Step 3 (Part 24f): a restore publishes an OLD version's exact profile again as a new version. It has no 预演, so it cannot be a
 * web_character_publications row (those name the 预演 they stand on); this row is its marker, its idempotency record (request id +
 * hash) and the answer to 「恢复自 vN」. Like every history table it is append-only. voice_version names the approved voice bundle
 * (binding, welcome and footer clips) that was made current again.
 */
const restoreStatements = [
  `CREATE TABLE web_character_restores(request_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,version INTEGER NOT NULL,from_version INTEGER NOT NULL,profile_hash TEXT NOT NULL,
    voice_version TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    session_id TEXT NOT NULL REFERENCES admin_sessions(id),created_at INTEGER NOT NULL,
    UNIQUE(character_id,version),CHECK(from_version<version),
    FOREIGN KEY(character_id,version) REFERENCES web_character_versions(character_id,version),
    FOREIGN KEY(character_id,from_version) REFERENCES web_character_versions(character_id,version)) STRICT`,
  ...['UPDATE', 'DELETE'].map(
    (action) => `CREATE TRIGGER web_character_restores_${action.toLowerCase()}
    BEFORE ${action} ON web_character_restores BEGIN SELECT RAISE(ABORT,'WEB_CHARACTER_HISTORY_IMMUTABLE'); END`,
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
        const profile = {
          template: JSON.parse(live.config_json),
          presentation: {
            displayName: entry.displayName,
            publicDescription: '',
            welcome: { ...WEB_PROVIDER_WELCOME[entry.characterId] },
          },
        } as StoredWebCharacterProfile;
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
    const restoreDigest = createHash('sha256').update(restoreStatements.join(';\n')).digest('hex');
    ensure(
      rows.length >= 1 &&
        rows.length <= 3 &&
        rows.find((row) => row.version === 1)?.sha256 === digest &&
        rows.every(
          (row) =>
            row.version === 1 ||
            (row.version === 2 && row.sha256 === publicationDigest) ||
            (row.version === 3 && row.sha256 === restoreDigest),
        ),
      'WEB_CHARACTER_SCHEMA_MISMATCH',
    );
    if (!rows.some((row) => row.version === 2)) {
      for (const sql of publicationStatements) store.all(sql);
      store.run('INSERT INTO web_character_schema VALUES (2,?)', publicationDigest);
    }
    // An authority at step 2 gains step 3 here, on the next start (version 3 never exists without version 2).
    if (!rows.some((row) => row.version === 3)) {
      for (const sql of restoreStatements) store.all(sql);
      store.run('INSERT INTO web_character_schema VALUES (3,?)', restoreDigest);
    }
    // Part 24k-2: the weighted 欢迎词 tables (one idempotent, digest-checked step; not a numbered migration).
    installWebWelcomeLines(store);
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
    const stored = JSON.parse(row.profile_json) as StoredWebCharacterProfile;
    ensure(
      characterProfileHash(stored) === row.content_hash &&
        stored.template.id === row.character_id &&
        stored.template.version === row.version &&
        row.version === row.live_version &&
        JSON.stringify(stored.template) === JSON.stringify(JSON.parse(row.config_json)),
      'WEB_PROVIDER_CATALOG_INVALID',
    );
    const profile = upgradedProfile(stored);
    return { ...profile, characterId: row.character_id, version: row.version, position: row.position };
  });
}

/**
 * Part 24l: is the character ON the home page? That is exactly: it has a row in web_character_catalog. (Before the durable catalog
 * exists there is nothing to refuse against, as in requirePublishedWebCharacter.)
 */
export function webCharacterOnline(store: Pick<BusinessStore, 'get'>, characterId: string) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'")) return true;
  return !!store.get('SELECT 1 FROM web_character_catalog WHERE character_id=?', characterId);
}

export type OfflineEntry = WebCharacterProfile & { characterId: string; version: number };
const profileOf = (row: { profile_json: string; content_hash: string; character_id: string; version: number }) => {
  const stored = JSON.parse(row.profile_json) as StoredWebCharacterProfile;
  ensure(
    characterProfileHash(stored) === row.content_hash &&
      stored.template.id === row.character_id &&
      stored.template.version === row.version,
    'WEB_PROVIDER_CATALOG_INVALID',
  );
  return upgradedProfile(stored);
};
/**
 * Part 24l: characters that were published once (they have a live template version) but have no catalog row now and are not
 * deleted: 已下线. Each is read at its current live version, the one 重新上线 puts back.
 */
export function offlineWebCharacters(store: BusinessStore, only?: string): OfflineEntry[] {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'")) return [];
  return store
    .all<{ character_id: string; version: number; profile_json: string; content_hash: string; config_json: string }>(
      `SELECT t.id character_id,t.version,v.profile_json,v.content_hash,t.config_json FROM character_templates t
      JOIN web_character_versions v ON v.character_id=t.id AND v.version=t.version
      WHERE NOT EXISTS(SELECT 1 FROM web_character_catalog c WHERE c.character_id=t.id)
      AND (? IS NULL OR t.id=?) ORDER BY t.id`,
      only ?? null,
      only ?? null,
    )
    .filter((row) => !webCharacterDeleted(store, row.character_id))
    .map((row) => {
      const profile = profileOf(row);
      ensure(
        JSON.stringify(profile.template) === JSON.stringify(JSON.parse(row.config_json)),
        'WEB_PROVIDER_CATALOG_INVALID',
      );
      return { ...profile, characterId: row.character_id, version: row.version };
    });
}

/** The character at its current live version, on the home page or not (an offline one keeps its live version). */
export function webCharacterAtLive(store: BusinessStore, characterId: string): OfflineEntry | undefined {
  return (
    publishedWebCharacters(store).find((entry) => entry.characterId === characterId) ??
    offlineWebCharacters(store, characterId)[0]
  );
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

/** Part 24k-2: every published welcome line of the character (the seed's single line while no catalog exists). */
export function webWelcomeLines(store: BusinessStore, characterId: string): WelcomeLine[] | undefined {
  if (store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_schema'"))
    return publishedWebCharacters(store).find((entry) => entry.characterId === characterId)?.presentation.welcomes;
  return Object.hasOwn(WEB_PROVIDER_WELCOME, characterId)
    ? upgradeProfile({
        presentation: { welcome: WEB_PROVIDER_WELCOME[characterId as keyof typeof WEB_PROVIDER_WELCOME] },
      }).presentation.welcomes
    : undefined;
}
