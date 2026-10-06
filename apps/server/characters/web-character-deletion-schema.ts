import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';

const guarded = [
  ['web_input_snapshots', 'web_input_snapshots_no_delete', 'WEB_INPUT_SNAPSHOT_IMMUTABLE'],
  ['web_v7_requests', 'web_v7_requests_no_delete', 'WEB_V7_REQUEST_IMMUTABLE'],
  ['web_v7_candidates', 'web_v7_candidates_no_delete', 'WEB_V7_CANDIDATE_IMMUTABLE'],
  ['web_publications', 'web_publications_no_delete', 'WEB_PUBLICATION_IMMUTABLE'],
  ['web_publication_items', 'web_publication_items_no_delete', 'WEB_PUBLICATION_ITEM_IMMUTABLE'],
  ['web_local_text_outputs', 'web_local_text_outputs_no_delete', 'WEB_TEXT_OUTPUT_IMMUTABLE'],
  ['web_local_audio_outputs', 'web_local_audio_outputs_no_delete', 'WEB_AUDIO_OUTPUT_IMMUTABLE'],
  ['web_provider_outputs', 'web_provider_outputs_no_delete', 'WEB_PROVIDER_OUTPUT_IMMUTABLE'],
  ['web_provider_candidates', 'web_provider_candidates_no_delete', 'WEB_PROVIDER_CANDIDATE_IMMUTABLE'],
  ['web_provider_media_assets', 'web_provider_media_no_delete', 'WEB_PROVIDER_MEDIA_IMMUTABLE'],
] as const;
const oldGate = (provider: boolean) => `EXISTS (SELECT 1 FROM web_operations o JOIN web_retention_purge_gate g
  ON g.principal_id=o.principal_id AND g.world_id=o.world_id
  JOIN web_guest_retention r ON r.principal_id=g.principal_id AND r.world_id=g.world_id
  ${provider ? 'JOIN web_principals p ON p.id=g.principal_id AND p.world_id=g.world_id' : ''}
  WHERE o.id=OLD.operation_id AND ${provider ? "p.kind='guest' AND" : ''} r.state='purging' AND r.revision=g.retention_revision)`;
const deleteGate = `EXISTS(SELECT 1 FROM web_character_purge_gate g
  JOIN web_character_deletion_scopes s ON s.deletion_id=g.deletion_id AND s.world_id=g.world_id AND s.conversation_id=g.conversation_id
  JOIN web_character_deletions d ON d.id=s.deletion_id
  JOIN web_operations o ON o.principal_id=s.principal_id AND o.world_id=s.world_id AND o.conversation_id=s.conversation_id AND o.character_id=d.character_id
  WHERE o.id=OLD.operation_id AND d.state='purging' AND s.db_cleared_at IS NULL)`;
const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');
const tables = [
  `CREATE TABLE web_character_deletions(id TEXT PRIMARY KEY,character_id TEXT NOT NULL UNIQUE,
    request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,version INTEGER NOT NULL,profile_hash TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES web_admin_members(id),session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    created_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('purging','deleted')),completed_at INTEGER,error_code TEXT) STRICT`,
  `CREATE TABLE web_character_deletion_scopes(deletion_id TEXT NOT NULL REFERENCES web_character_deletions(id),
    principal_id TEXT NOT NULL,world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,db_cleared_at INTEGER,audio_cleared_at INTEGER,
    PRIMARY KEY(deletion_id,world_id,conversation_id),UNIQUE(world_id,conversation_id),
    FOREIGN KEY(world_id,conversation_id) REFERENCES conversations(world_id,id)) STRICT`,
  `CREATE TABLE web_character_purge_gate(deletion_id TEXT NOT NULL,world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
    PRIMARY KEY(deletion_id,world_id,conversation_id),FOREIGN KEY(deletion_id,world_id,conversation_id)
    REFERENCES web_character_deletion_scopes(deletion_id,world_id,conversation_id)) STRICT`,
  `CREATE TRIGGER web_character_deletion_identity BEFORE UPDATE OF id,character_id,request_id,request_hash,version,profile_hash,member_id,session_id,created_at
    ON web_character_deletions BEGIN SELECT RAISE(ABORT,'WEB_DELETION_IMMUTABLE'); END`,
  `CREATE TRIGGER web_character_deletion_scope_identity BEFORE UPDATE OF deletion_id,principal_id,world_id,conversation_id
    ON web_character_deletion_scopes BEGIN SELECT RAISE(ABORT,'WEB_DELETION_IMMUTABLE'); END`,
  ...['web_character_deletions', 'web_character_deletion_scopes'].map(
    (table) =>
      `CREATE TRIGGER ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'WEB_DELETION_IMMUTABLE'); END`,
  ),
];
export function installWebCharacterDeletion(store: WebRuntimeStore) {
  const triggers = guarded.map(
    ([table, name, error]) => `CREATE TRIGGER ${name} BEFORE DELETE ON ${table}
    WHEN NOT (${table.startsWith('web_provider_') && !store.providerAudio ? '0' : oldGate(table.startsWith('web_provider_'))} OR ${deleteGate}) BEGIN SELECT RAISE(ABORT,'${error}'); END`,
  );
  const digest = createHash('sha256')
    .update([...tables, ...triggers].join(';\n'))
    .digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletion_schema'")) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name GLOB 'web_character_deletion*' OR name='web_character_purge_gate'",
        ),
        'WEB_DELETION_SCHEMA_MISMATCH',
      );
      for (const [table, name, error] of guarded) {
        const provider = table.startsWith('web_provider_'),
          current = store.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name=?', name);
        const expected = `CREATE TRIGGER ${name} BEFORE DELETE ON ${table} ${provider && !store.providerAudio ? '' : `WHEN NOT ${oldGate(provider)}`}
          BEGIN SELECT RAISE(ABORT,'${error}'); END`;
        ensure(current && normalize(current.sql) === normalize(expected), 'WEB_DELETION_SCHEMA_MISMATCH');
      }
      for (const sql of tables) store.all(sql);
      for (const [index, [, name]] of guarded.entries()) {
        store.all(`DROP TRIGGER ${name}`);
        store.all(triggers[index]!);
      }
      if (
        !store.all<{ name: string }>('PRAGMA table_info(web_provider_attempts)').some((c) => c.name === 'output_proof')
      ) {
        store.all('ALTER TABLE web_provider_attempts ADD COLUMN output_proof TEXT');
        for (const row of store.all<{
          operation_id: string;
          phase: string;
          ordinal: number;
          output_digest: string | null;
          spoken_text: string | null;
        }>(
          `SELECT a.operation_id,a.phase,a.ordinal,a.output_digest,o.spoken_text FROM web_provider_attempts a LEFT JOIN web_provider_outputs o
           ON o.operation_id=a.operation_id AND o.phase=a.phase AND o.ordinal=a.ordinal WHERE a.state='known'`,
        ))
          store.run(
            'UPDATE web_provider_attempts SET output_proof=? WHERE operation_id=? AND phase=? AND ordinal=?',
            store.webReceiptDigest('receipt', JSON.stringify([row.output_digest, row.spoken_text ?? null])),
            row.operation_id,
            row.phase,
            row.ordinal,
          );
      }
      store.all(
        'CREATE TABLE web_character_deletion_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_character_deletion_schema VALUES (1,?)', digest);
    }
    const versions = store.all<{ version: number; sha256: string }>('SELECT * FROM web_character_deletion_schema');
    ensure(
      versions.length === 1 && versions[0]!.version === 1 && versions[0]!.sha256 === digest,
      'WEB_DELETION_SCHEMA_MISMATCH',
    );
    for (const [i, [, name]] of guarded.entries())
      ensure(
        normalize(store.get<{ sql: string }>('SELECT sql FROM sqlite_master WHERE name=?', name)?.sql ?? '') ===
          normalize(triggers[i]!),
        'WEB_DELETION_SCHEMA_MISMATCH',
      );
  });
}
