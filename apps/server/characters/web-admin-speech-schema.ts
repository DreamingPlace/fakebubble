import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 24k-1: the admin speech path's two tables, installed by an idempotent, digest-checked runtime step (like the 预演
 * queue's tables). No numbered migration: `expected-migrations` stays as it was.
 *
 *  - web_speech_admin_calls: the LEDGER. One row per Fish call the admin path may have sent: ids, enums, counts, hashes, times
 *    and the bill. No text and no audio. Never deleted and its known bill never changed (money records are kept, like the
 *    preview ledger); an UNKNOWN row keeps its reservation for ever.
 *  - web_speech_admin_audio: the admin-only audio of a call that succeeded. It is the only place the audio lives, no player
 *    route reads it, and it is the part that goes with a 预演's purge and with a character's deletion.
 */
const statements = [
  `CREATE TABLE web_speech_admin_calls(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>=0),
    request_hash TEXT NOT NULL,character_id TEXT NOT NULL,revision INTEGER NOT NULL,
    purpose TEXT NOT NULL CHECK(purpose IN ('material-welcome','material-footer','preview')),target_id TEXT NOT NULL,
    text_sha256 TEXT NOT NULL,characters INTEGER NOT NULL CHECK(characters>0),model TEXT NOT NULL,
    wire_hash TEXT NOT NULL,price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
    max_units INTEGER NOT NULL CHECK(max_units>0),held_micros INTEGER NOT NULL CHECK(held_micros>0),
    budget_id TEXT NOT NULL UNIQUE,fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known','released')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),error_code TEXT,
    charged_micros INTEGER,receipt_json TEXT,output_sha256 TEXT,shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),
    member_id TEXT NOT NULL REFERENCES web_admin_members(id),session_id TEXT NOT NULL REFERENCES admin_sessions(id),
    created_at INTEGER NOT NULL,settled_at INTEGER,UNIQUE(request_id,ordinal),
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros
      AND receipt_json IS NOT NULL AND settled_at IS NOT NULL) OR
      (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL AND settled_at IS NULL)),
    CHECK(shared_settled=0 OR state='known')) STRICT`,
  `CREATE TABLE web_speech_admin_audio(call_id TEXT PRIMARY KEY REFERENCES web_speech_admin_calls(id),
    sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=1900000),
    duration_ms INTEGER NOT NULL CHECK(duration_ms>0),audio BLOB NOT NULL,created_at INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER web_speech_admin_calls_identity BEFORE UPDATE OF id,request_id,ordinal,request_hash,character_id,revision,
    purpose,target_id,text_sha256,characters,model,wire_hash,price_id,max_units,held_micros,budget_id,fingerprint,member_id,
    session_id,created_at ON web_speech_admin_calls BEGIN SELECT RAISE(ABORT,'WEB_ADMIN_SPEECH_IMMUTABLE'); END`,
  `CREATE TRIGGER web_speech_admin_calls_final BEFORE UPDATE OF state,outcome,error_code,charged_micros,receipt_json,output_sha256,settled_at
    ON web_speech_admin_calls WHEN OLD.state IN ('known','released') BEGIN SELECT RAISE(ABORT,'WEB_ADMIN_SPEECH_IMMUTABLE'); END`,
  `CREATE TRIGGER web_speech_admin_calls_retain BEFORE DELETE ON web_speech_admin_calls
    BEGIN SELECT RAISE(ABORT,'WEB_ADMIN_SPEECH_IMMUTABLE'); END`,
  `CREATE TRIGGER web_speech_admin_audio_fixed BEFORE UPDATE ON web_speech_admin_audio
    BEGIN SELECT RAISE(ABORT,'WEB_ADMIN_SPEECH_IMMUTABLE'); END`,
];

export function installWebAdminSpeech(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_speech_admin_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_speech_admin_*'"),
        'WEB_ADMIN_SPEECH_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_speech_admin_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_speech_admin_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_speech_admin_schema');
    const guards = store.get<{ n: number }>(
      "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_speech_admin_*'",
    )!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === 4,
      'WEB_ADMIN_SPEECH_SCHEMA_MISMATCH',
    );
  });
}

/** Whether the tables exist (a database that never enabled the admin speech path has none). */
export function webAdminSpeechInstalled(store: BusinessStore) {
  return !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_speech_admin_schema'");
}

/**
 * Retention. The audio of a 预演 goes with that 预演's purge, and all of a character's audio with the character's deletion
 * (Part 24g, in the deletion's own transaction). The ledger rows (no text, no audio) stay as financial receipts, like the
 * preview ledger. Returns how many audio rows were removed.
 */
export function purgeAdminSpeechAudio(store: BusinessStore, scope: { characterId: string; previewIds?: string[] }) {
  if (!webAdminSpeechInstalled(store)) return 0;
  let removed = 0;
  if (scope.previewIds === undefined)
    removed = Number(
      store.run(
        `DELETE FROM web_speech_admin_audio WHERE call_id IN (SELECT id FROM web_speech_admin_calls WHERE character_id=?)`,
        scope.characterId,
      ).changes,
    );
  else
    for (const previewId of scope.previewIds)
      removed += Number(
        store.run(
          `DELETE FROM web_speech_admin_audio WHERE call_id IN
        (SELECT id FROM web_speech_admin_calls WHERE character_id=? AND purpose='preview' AND target_id=?)`,
          scope.characterId,
          previewId,
        ).changes,
      );
  return removed;
}
