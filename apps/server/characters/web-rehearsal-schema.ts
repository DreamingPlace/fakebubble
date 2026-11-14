import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 35: storage of 多轮预演. NO numbered migration (expected-migrations is untouched): the tables are installed idempotently at
 * business-object start and checked against the digest of these statements. A mismatch stops the start with
 * WEB_REHEARSAL_SCHEMA_MISMATCH.
 *
 * Admin-only synthetic data: no player id, world or conversation, nothing of a player. A run is a list of UNITS taken one at a
 * time in `seq` order: `hint` (a judge writes the hint phrasings of one meme / story), `cell` (one model's reply to one turn:
 * a draft and the house review) and `judge` (one model's replies about one item, judged). Every provider call of a unit is one
 * row of `web_rehearsal_calls`, with the same ledger columns as a 预演 attempt: the hold and the capacity ticket are taken
 * before the call, an UNKNOWN call keeps both, a known bill is settled once.
 *
 * Content (the player lines, the replies) lives in `web_rehearsal_turns`, `web_rehearsal_units.result_json` and the call outputs.
 * Only the money columns of a known call are write-protected, so a later deletion of transcripts (Part 31) can clear content
 * without touching a bill.
 */
const statements = [
  `CREATE TABLE web_rehearsal_scripts(id TEXT PRIMARY KEY,name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 60),
    turns_json TEXT NOT NULL CHECK(json_valid(turns_json) AND json_type(turns_json)='array'),
    created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_rehearsal_phrases(kind TEXT PRIMARY KEY CHECK(kind IN ('customerService','advice')),
    phrases_json TEXT NOT NULL CHECK(json_valid(phrases_json) AND json_type(phrases_json)='array'),
    updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_rehearsal_requests(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,request_hash TEXT NOT NULL,
    result_json TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_rehearsal_runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
    character_id TEXT NOT NULL,draft_revision INTEGER NOT NULL,profile_hash TEXT NOT NULL,
    script_name TEXT NOT NULL,source_kind TEXT NOT NULL CHECK(source_kind IN ('script','set','memes')),
    models_json TEXT NOT NULL CHECK(json_valid(models_json)),with_cast INTEGER NOT NULL CHECK(with_cast IN (0,1)),
    frozen_json TEXT NOT NULL,frozen_digest TEXT NOT NULL,reviewer TEXT NOT NULL,
    estimated_micros INTEGER NOT NULL CHECK(estimated_micros>=0),member_id TEXT NOT NULL,session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX web_rehearsal_runs_character ON web_rehearsal_runs(character_id,created_at DESC)`,
  `CREATE TABLE web_rehearsal_turns(run_id TEXT NOT NULL REFERENCES web_rehearsal_runs(id),turn INTEGER NOT NULL CHECK(turn>0),
    text TEXT,role TEXT CHECK(role IS NULL OR role IN ('hint','negative')),item_key TEXT,
    PRIMARY KEY(run_id,turn)) STRICT`,
  `CREATE TABLE web_rehearsal_items(run_id TEXT NOT NULL REFERENCES web_rehearsal_runs(id),item_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('meme','story')),label TEXT NOT NULL,spec_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','ready','dropped')),PRIMARY KEY(run_id,item_key)) STRICT`,
  `CREATE TABLE web_rehearsal_units(run_id TEXT NOT NULL REFERENCES web_rehearsal_runs(id),seq INTEGER NOT NULL CHECK(seq>0),
    kind TEXT NOT NULL CHECK(kind IN ('hint','cell','judge')),model_key TEXT,turn INTEGER,item_key TEXT,
    status TEXT NOT NULL CHECK(status IN ('queued','generating','done','failed','unconfirmed','skipped')),
    lease_token TEXT,lease_until INTEGER,deadline_at INTEGER NOT NULL,retry_at INTEGER NOT NULL,error_code TEXT,
    request_json TEXT,request_digest TEXT,result_json TEXT,finished_at INTEGER,PRIMARY KEY(run_id,seq)) STRICT`,
  `CREATE INDEX web_rehearsal_units_status ON web_rehearsal_units(status)`,
  `CREATE TABLE web_rehearsal_calls(run_id TEXT NOT NULL,seq INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('draft','review','judge')),provider TEXT NOT NULL,budget_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,wire_hash TEXT NOT NULL,lease_token TEXT NOT NULL,model TEXT NOT NULL,
    price_id TEXT NOT NULL REFERENCES web_provider_prices(id),max_units INTEGER NOT NULL CHECK(max_units>0),
    held_micros INTEGER NOT NULL CHECK(held_micros>0),
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),charged_micros INTEGER,receipt_json TEXT,output_json TEXT,
    output_hash TEXT,metadata_json TEXT,shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),
    created_at INTEGER NOT NULL,settled_at INTEGER,PRIMARY KEY(run_id,seq,phase),
    FOREIGN KEY(run_id,seq) REFERENCES web_rehearsal_units(run_id,seq),
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros
      AND receipt_json IS NOT NULL AND settled_at IS NOT NULL) OR
      (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL AND settled_at IS NULL)),
    CHECK(shared_settled=0 OR state='known')) STRICT`,
  `CREATE TRIGGER web_rehearsal_call_identity BEFORE UPDATE OF run_id,seq,phase,provider,budget_id,fingerprint,wire_hash,
    lease_token,model,price_id,max_units,held_micros,created_at ON web_rehearsal_calls
    BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_call_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,settled_at
    ON web_rehearsal_calls WHEN OLD.state='known' BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_call_retain BEFORE DELETE ON web_rehearsal_calls
    BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_run_immutable BEFORE UPDATE ON web_rehearsal_runs
    BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_unit_request BEFORE UPDATE OF run_id,seq,kind,model_key,turn,item_key,deadline_at ON web_rehearsal_units
    BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_unit_frozen BEFORE UPDATE OF request_json,request_digest ON web_rehearsal_units
    WHEN OLD.request_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  `CREATE TRIGGER web_rehearsal_turn_text BEFORE UPDATE ON web_rehearsal_turns
    WHEN OLD.text IS NOT NULL OR NEW.run_id<>OLD.run_id OR NEW.turn<>OLD.turn OR NEW.role IS NOT OLD.role
      OR NEW.item_key IS NOT OLD.item_key BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installRehearsal(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_rehearsal_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_rehearsal_*'"),
        'WEB_REHEARSAL_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_rehearsal_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_rehearsal_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_rehearsal_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_REHEARSAL_SCHEMA_MISMATCH');
  });
}
export const rehearsalInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_rehearsal_schema'");
/** Units being generated right now: they share the preview queue's one text slot. */
export function rehearsalRunning(store: Pick<BusinessStore, 'get'>) {
  if (!rehearsalInstalled(store)) return 0;
  return store.get<{ n: number }>("SELECT count(*) n FROM web_rehearsal_units WHERE status='generating'")!.n;
}
