import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 30: slots and takes. Installed by an idempotent, digest-checked runtime step (like the admin speech tables): no
 * numbered migration, `expected-migrations` is unchanged.
 *
 *  - web_clip_takes: one row per take of a slot (a welcome line or the footer). Generated, generated from feedback, or
 *    uploaded. Mutable on purpose (a take can be renamed, noted or deleted); the bundles that are published stay in the
 *    immutable 素材版本 tables. A row with status 'unusable' is a paid take whose audio had no voice (WEB_SPEECH_NO_ONSET).
 *  - web_clip_choices: the 选用 take of a slot and its approval (per slot, not per version).
 *  - web_clip_migrated: which existing 素材版本 were already turned into takes (the step runs once per version).
 *  - web_clip_direction_calls: the ledger of the text-model calls of 按反馈重录 (reserved first, UNKNOWN never retried).
 *    The money records stay: a take can be deleted, its ledger rows cannot (like the admin speech ledger).
 */
const statements = [
  `CREATE TABLE web_clip_takes(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,character_id TEXT NOT NULL,slot_key TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>0),origin TEXT NOT NULL CHECK(origin IN ('generated','feedback','uploaded')),
    status TEXT NOT NULL CHECK(status IN ('ready','unusable')),name TEXT NOT NULL,note TEXT NOT NULL,feedback TEXT,markup TEXT,
    body TEXT NOT NULL,reference_id TEXT NOT NULL,binding TEXT NOT NULL,resolved_model TEXT NOT NULL,scope_version TEXT NOT NULL,
    sha256 TEXT,byte_length INTEGER,duration_ms INTEGER,audio_bytes BLOB,audio_ref_json TEXT,call_id TEXT,error_code TEXT,
    created_at INTEGER NOT NULL,
    CHECK((status='ready' AND sha256 IS NOT NULL AND byte_length>0 AND duration_ms>0 AND ((audio_bytes IS NULL)!=(audio_ref_json IS NULL)))
      OR (status='unusable' AND sha256 IS NULL AND audio_bytes IS NULL AND audio_ref_json IS NULL AND error_code IS NOT NULL))) STRICT`,
  `CREATE INDEX web_clip_takes_slot ON web_clip_takes(character_id,slot_key,ordinal)`,
  `CREATE TABLE web_clip_choices(character_id TEXT NOT NULL,slot_key TEXT NOT NULL,take_id TEXT NOT NULL REFERENCES web_clip_takes(id),
    approved_sha256 TEXT,approved_by TEXT,approved_session TEXT,approved_note TEXT,approved_at INTEGER,updated_at INTEGER NOT NULL,
    PRIMARY KEY(character_id,slot_key),
    CHECK((approved_sha256 IS NULL)=(approved_at IS NULL))) STRICT`,
  `CREATE TABLE web_clip_migrated(material_id TEXT PRIMARY KEY) STRICT`,
  `CREATE TABLE web_clip_direction_calls(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,slot_key TEXT NOT NULL,model TEXT NOT NULL,price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
    max_units INTEGER NOT NULL CHECK(max_units>0),held_micros INTEGER NOT NULL CHECK(held_micros>0),budget_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known','released')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),error_code TEXT,charged_micros INTEGER,receipt_json TEXT,markup TEXT,
    shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),
    member_id TEXT NOT NULL REFERENCES web_admin_members(id),session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    created_at INTEGER NOT NULL,settled_at INTEGER,
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros AND receipt_json IS NOT NULL
      AND settled_at IS NOT NULL) OR (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL
      AND settled_at IS NULL))) STRICT`,
  `CREATE TRIGGER web_clip_direction_calls_retain BEFORE DELETE ON web_clip_direction_calls
    BEGIN SELECT RAISE(ABORT,'WEB_CLIP_LEDGER_IMMUTABLE'); END`,
  `CREATE TRIGGER web_clip_direction_calls_final BEFORE UPDATE OF state,outcome,error_code,charged_micros,receipt_json,markup,settled_at
    ON web_clip_direction_calls WHEN OLD.state IN ('known','released')
    BEGIN SELECT RAISE(ABORT,'WEB_CLIP_LEDGER_IMMUTABLE'); END`,
];

export function installWebClipTakes(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_clip_takes_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_clip_*'"), 'WEB_CLIP_SCHEMA_MISMATCH');
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_clip_takes_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_clip_takes_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_clip_takes_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_CLIP_SCHEMA_MISMATCH');
  });
}

export const webClipTakesInstalled = (store: BusinessStore) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_clip_takes_schema'");
