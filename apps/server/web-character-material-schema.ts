import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore } from './store-contract.ts';

const bindingColumns = [
  'character_id',
  'voice_version',
  'voice_revision',
  'profile_id',
  'reference_id',
  'model',
  'source',
  'approved',
  'evidence_json',
];
const previousTrigger = `CREATE TRIGGER web_provider_voice_bindings_no_update BEFORE UPDATE ON web_provider_voice_bindings
BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_VOICE_IMMUTABLE'); END`;
const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');
const statements = [
  `CREATE TABLE web_character_materials(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,revision INTEGER NOT NULL,profile_hash TEXT NOT NULL,voice_version TEXT NOT NULL UNIQUE,
    voice_revision INTEGER NOT NULL,profile_id TEXT NOT NULL,reference_id TEXT NOT NULL,model TEXT NOT NULL,
    evidence_json TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    session_id TEXT NOT NULL REFERENCES admin_sessions(id),created_at INTEGER NOT NULL,
    FOREIGN KEY(character_id,revision) REFERENCES web_character_revisions(character_id,revision)) STRICT`,
  `CREATE TABLE web_character_material_assets(material_id TEXT NOT NULL REFERENCES web_character_materials(id),
    kind TEXT NOT NULL CHECK(kind IN ('welcome','footer')),media_id TEXT NOT NULL UNIQUE,body TEXT NOT NULL,text_version TEXT,
    sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=6000000),
    duration_ms INTEGER NOT NULL CHECK(duration_ms>0 AND duration_ms<=60000),audio_bytes BLOB,audio_ref_json TEXT,created_at INTEGER NOT NULL,
    PRIMARY KEY(material_id,kind),CHECK((audio_bytes IS NULL)!=(audio_ref_json IS NULL))) STRICT`,
  `CREATE TABLE web_character_material_approvals(material_id TEXT PRIMARY KEY REFERENCES web_character_materials(id),
    manifest_hash TEXT NOT NULL,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    session_id TEXT NOT NULL REFERENCES admin_sessions(id),note TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_character_material_promotions(character_id TEXT NOT NULL,version INTEGER NOT NULL,
    material_id TEXT NOT NULL UNIQUE REFERENCES web_character_material_approvals(material_id),
    PRIMARY KEY(character_id,version),FOREIGN KEY(character_id,version) REFERENCES web_character_publications(character_id,version)) STRICT`,
  `CREATE TABLE web_character_voice_history(character_id TEXT NOT NULL,voice_version TEXT NOT NULL,
    voice_revision INTEGER NOT NULL,profile_id TEXT NOT NULL,reference_id TEXT NOT NULL,model TEXT NOT NULL,
    source TEXT NOT NULL,approved INTEGER NOT NULL,evidence_json TEXT,PRIMARY KEY(character_id,voice_version)) STRICT`,
  ...[
    'web_character_materials',
    'web_character_material_assets',
    'web_character_material_approvals',
    'web_character_material_promotions',
    'web_character_voice_history',
  ].flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (action) =>
        `CREATE TRIGGER ${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
      BEGIN SELECT RAISE(ABORT,'WEB_MATERIAL_IMMUTABLE'); END`,
    ),
  ),
  `CREATE TRIGGER web_provider_voice_bindings_no_update BEFORE UPDATE ON web_provider_voice_bindings
    WHEN NOT (EXISTS(SELECT 1 FROM web_character_voice_history h WHERE ${bindingColumns.map((c) => `h.${c} IS OLD.${c}`).join(' AND ')})
      AND EXISTS(SELECT 1 FROM web_character_material_promotions p
        JOIN web_character_catalog c ON c.character_id=p.character_id AND c.version=p.version
        JOIN web_character_materials m ON m.id=p.material_id
        JOIN web_character_voice_history h ON h.character_id=m.character_id AND h.voice_version=m.voice_version
        WHERE m.character_id=OLD.character_id AND ${bindingColumns.map((c) => `h.${c} IS NEW.${c}`).join(' AND ')}))
    BEGIN SELECT RAISE(ABORT,'WEB_PROVIDER_VOICE_IMMUTABLE'); END`,
];

/** Additive history plus a guarded current projection; never overwrite or delete old approved clips. */
export function installWebCharacterMaterials(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_material_schema'")) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name GLOB 'web_character_material*' OR name='web_character_voice_history'",
        ),
        'WEB_MATERIAL_SCHEMA_MISMATCH',
      );
      const trigger = store.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name='web_provider_voice_bindings_no_update'",
      );
      ensure(trigger && normalize(trigger.sql) === normalize(previousTrigger), 'WEB_MATERIAL_SCHEMA_MISMATCH');
      for (const sql of statements.slice(0, -1)) store.all(sql);
      store.run(
        `INSERT INTO web_character_voice_history SELECT ${bindingColumns.join(',')} FROM web_provider_voice_bindings`,
      );
      store.all('DROP TRIGGER web_provider_voice_bindings_no_update');
      store.all(statements.at(-1)!);
      store.all(
        'CREATE TABLE web_character_material_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_character_material_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_character_material_schema');
    ensure(
      rows.length === 1 &&
        rows[0]!.version === 1 &&
        rows[0]!.sha256 === digest &&
        normalize(
          store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='web_provider_voice_bindings_no_update'")
            ?.sql ?? '',
        ) === normalize(statements.at(-1)!),
      'WEB_MATERIAL_SCHEMA_MISMATCH',
    );
  });
}
