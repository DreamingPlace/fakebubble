import { createHash } from 'node:crypto';
import type { BusinessStore } from './store-contract.ts';
import { ensure } from '../../packages/domain/errors.ts';

const statements = [
  `CREATE TABLE web_character_preview_jobs(preview_id TEXT PRIMARY KEY REFERENCES admin_previews(id),
    character_id TEXT NOT NULL,revision INTEGER NOT NULL,profile_hash TEXT NOT NULL,request_digest TEXT NOT NULL,
    member_id TEXT NOT NULL REFERENCES web_admin_members(id),session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    deadline_at INTEGER NOT NULL,lease_token TEXT,retry_at INTEGER NOT NULL,
    FOREIGN KEY(character_id,revision) REFERENCES web_character_revisions(character_id,revision)) STRICT`,
  `CREATE TABLE web_character_preview_attempts(preview_id TEXT NOT NULL REFERENCES web_character_preview_jobs(preview_id),
    phase TEXT NOT NULL CHECK(phase IN ('draft','review')),budget_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
    wire_hash TEXT NOT NULL,lease_token TEXT NOT NULL,model TEXT NOT NULL,price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
    max_units INTEGER NOT NULL CHECK(max_units>0),held_micros INTEGER NOT NULL CHECK(held_micros>0),
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),charged_micros INTEGER,receipt_json TEXT,
    output_json TEXT,output_hash TEXT,metadata_json TEXT,shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),
    created_at INTEGER NOT NULL,settled_at INTEGER,PRIMARY KEY(preview_id,phase),
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros
      AND receipt_json IS NOT NULL AND settled_at IS NOT NULL) OR
      (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL AND settled_at IS NULL)),
    CHECK(shared_settled=0 OR state='known')) STRICT`,
  `CREATE TRIGGER web_character_preview_jobs_identity BEFORE UPDATE OF preview_id,character_id,revision,profile_hash,
    request_digest,member_id,session_id,deadline_at ON web_character_preview_jobs
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  `CREATE TRIGGER web_character_preview_request BEFORE UPDATE OF character_id,draft_revision,content_hash,prompt_hash,
    request_id,request_hash,evidence_kind,request_json,created_at ON admin_previews
    WHEN EXISTS(SELECT 1 FROM web_character_preview_jobs WHERE preview_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  `CREATE TRIGGER web_character_preview_attempt_identity BEFORE UPDATE OF preview_id,phase,budget_id,fingerprint,
    wire_hash,lease_token,model,price_id,max_units,held_micros,created_at ON web_character_preview_attempts
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  `CREATE TRIGGER web_character_preview_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,
    output_json,output_hash,metadata_json,settled_at ON web_character_preview_attempts WHEN OLD.state='known'
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  ...['web_character_preview_jobs', 'web_character_preview_attempts'].map(
    (table) =>
      `CREATE TRIGGER ${table}_retain BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  ),
];
export function installWebCharacterPreviews(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_preview_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_character_preview_*'"),
        'WEB_PREVIEW_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_character_preview_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_character_preview_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_character_preview_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_PREVIEW_SCHEMA_MISMATCH');
  });
}
/** Optional extension: legacy/synthetic runtimes never install this queue. */
export function webCharacterPreviewsRunning(store: BusinessStore) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_preview_jobs'")) return 0;
  return store.get<{ n: number }>(`SELECT count(*) n FROM web_character_preview_jobs j
    JOIN admin_previews p ON p.id=j.preview_id WHERE p.status='generating'`)!.n;
}
