import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 26b: storage of the 审核对比 (no numbered migration: installed idempotently, digest-checked, like the preview queue).
 * Synthetic cases only: no player id, no content of a player. A run is queued case by case; a case holds up to three provider
 * attempts (one draft, then a V4 Pro review and a V4.1 Flash review of that SAME draft), each with its own budget reservation.
 */
const statements = [
  `CREATE TABLE web_review_compare_runs(id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,
    member_id TEXT NOT NULL,session_id TEXT NOT NULL,case_count INTEGER NOT NULL CHECK(case_count>0),
    estimated_micros INTEGER NOT NULL CHECK(estimated_micros>=0),created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_review_compare_cases(run_id TEXT NOT NULL REFERENCES web_review_compare_runs(id),
    ordinal INTEGER NOT NULL CHECK(ordinal>0),case_key TEXT NOT NULL,request_json TEXT NOT NULL,request_digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','generating','done','failed')),lease_token TEXT,lease_until INTEGER,
    deadline_at INTEGER NOT NULL,retry_at INTEGER NOT NULL,error_code TEXT,finished_at INTEGER,
    PRIMARY KEY(run_id,ordinal)) STRICT`,
  `CREATE INDEX web_review_compare_cases_status ON web_review_compare_cases(status)`,
  `CREATE TABLE web_review_compare_attempts(run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
    phase TEXT NOT NULL CHECK(phase IN ('draft','review_pro','review_flash')),budget_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,wire_hash TEXT NOT NULL,lease_token TEXT NOT NULL,model TEXT NOT NULL,
    price_id TEXT NOT NULL REFERENCES web_provider_prices(id),max_units INTEGER NOT NULL CHECK(max_units>0),
    held_micros INTEGER NOT NULL CHECK(held_micros>0),
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),charged_micros INTEGER,receipt_json TEXT,output_json TEXT,
    output_hash TEXT,metadata_json TEXT,rejected_json TEXT,latency_ms INTEGER,
    shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),created_at INTEGER NOT NULL,settled_at INTEGER,
    PRIMARY KEY(run_id,ordinal,phase),FOREIGN KEY(run_id,ordinal) REFERENCES web_review_compare_cases(run_id,ordinal),
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros
      AND receipt_json IS NOT NULL AND settled_at IS NOT NULL) OR
      (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL AND settled_at IS NULL)),
    CHECK(shared_settled=0 OR state='known')) STRICT`,
  `CREATE TRIGGER web_review_compare_attempt_identity BEFORE UPDATE OF run_id,ordinal,phase,budget_id,fingerprint,wire_hash,
    lease_token,model,price_id,max_units,held_micros,created_at ON web_review_compare_attempts
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_COMPARE_IMMUTABLE'); END`,
  `CREATE TRIGGER web_review_compare_attempt_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,output_json,
    output_hash,metadata_json,rejected_json,latency_ms,settled_at ON web_review_compare_attempts WHEN OLD.state='known'
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_COMPARE_IMMUTABLE'); END`,
  `CREATE TRIGGER web_review_compare_attempt_retain BEFORE DELETE ON web_review_compare_attempts
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_COMPARE_IMMUTABLE'); END`,
  `CREATE TRIGGER web_review_compare_case_request BEFORE UPDATE OF run_id,ordinal,case_key,request_json,request_digest
    ON web_review_compare_cases BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_COMPARE_IMMUTABLE'); END`,
  `CREATE TABLE web_review_compare_marks(run_id TEXT NOT NULL,ordinal INTEGER NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('pro','flash')),mark TEXT NOT NULL CHECK(mark IN ('better','same','worse')),
    member_id TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(run_id,ordinal,side),
    FOREIGN KEY(run_id,ordinal) REFERENCES web_review_compare_cases(run_id,ordinal)) STRICT`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installReviewCompare(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_review_compare_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_review_compare_*'"),
        'WEB_REVIEW_COMPARE_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_review_compare_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_review_compare_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_review_compare_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_REVIEW_COMPARE_SCHEMA_MISMATCH');
  });
}
export const reviewCompareInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_review_compare_schema'");
/** Compare cases being generated right now: they share the preview queue's one text slot. */
export function reviewCompareRunning(store: Pick<BusinessStore, 'get'>) {
  if (!reviewCompareInstalled(store)) return 0;
  return store.get<{ n: number }>("SELECT count(*) n FROM web_review_compare_cases WHERE status='generating'")!.n;
}
