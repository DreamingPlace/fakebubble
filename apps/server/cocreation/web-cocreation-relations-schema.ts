import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 39: the tables of 关系与故事 co-creation. NO numbered migration (expected-migrations is untouched): installed idempotently at
 * business-object start and checked against the digest of its statements. STOP code: WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH (a table
 * of this step exists with other contents, or a table of this name family exists without the step's marker).
 *
 * - web_cocreation_relations: one row per relation submission (pair of two, group of three to eight): the member set, the pair's reason,
 *   the administrator's marks (不计入, the edited text, the decision). A submission row itself stays in web_cocreation_submissions.
 * - web_cocreation_members / web_cocreation_ratings: the members in console order and the whole-star opinions of a pair. A rating row
 *   holds no principal: statistics are counts, never who rated. Both go when the submission is purged (player purge, character purge).
 * - web_cocreation_adoptions: one row per adoption request id (idempotent replay, one adoption per submission).
 * - web_cocreation_tidy_calls: the ledger of the optional 整理 text call (the clip-direction pattern: reserve, intent, sent, unknown, known).
 */
const statements = [
  `CREATE TABLE web_cocreation_relations(
    submission_id TEXT PRIMARY KEY REFERENCES web_cocreation_submissions(id),
    member_count INTEGER NOT NULL CHECK(member_count BETWEEN 2 AND 8),
    set_key TEXT NOT NULL CHECK(length(set_key)>0),
    reason TEXT,
    excluded INTEGER NOT NULL DEFAULT 0 CHECK(excluded IN (0,1)),
    excluded_by TEXT,
    excluded_at INTEGER,
    edited_text TEXT,
    decision TEXT CHECK(decision IN ('adopted','rejected')),
    decided_by TEXT,
    decided_at INTEGER,
    CHECK(member_count=2 OR reason IS NULL)) STRICT`,
  `CREATE TABLE web_cocreation_members(
    submission_id TEXT NOT NULL REFERENCES web_cocreation_submissions(id),
    position INTEGER NOT NULL CHECK(position BETWEEN 0 AND 7),
    character_id TEXT NOT NULL,
    PRIMARY KEY(submission_id,position),
    UNIQUE(submission_id,character_id)) STRICT`,
  `CREATE TABLE web_cocreation_ratings(
    submission_id TEXT NOT NULL REFERENCES web_cocreation_submissions(id),
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    stars INTEGER NOT NULL CHECK(stars BETWEEN 0 AND 5),
    PRIMARY KEY(submission_id,from_id,to_id),
    CHECK(from_id<>to_id)) STRICT`,
  `CREATE INDEX web_cocreation_ratings_pair ON web_cocreation_ratings(from_id,to_id)`,
  `CREATE INDEX web_cocreation_members_character ON web_cocreation_members(character_id)`,
  `CREATE TABLE web_cocreation_adoptions(
    request_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    submission_id TEXT NOT NULL UNIQUE,
    group_id TEXT NOT NULL,
    created_group INTEGER NOT NULL CHECK(created_group IN (0,1)),
    cast_revision INTEGER NOT NULL CHECK(cast_revision>0),
    actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_cocreation_tidy_calls(
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    submission_id TEXT NOT NULL,
    model TEXT NOT NULL,
    price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
    max_units INTEGER NOT NULL CHECK(max_units>0),
    held_micros INTEGER NOT NULL CHECK(held_micros>0),
    budget_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known','released')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),
    error_code TEXT,
    result_json TEXT,
    charged_micros INTEGER,
    receipt_json TEXT,
    shared_settled INTEGER NOT NULL DEFAULT 0 CHECK(shared_settled IN (0,1)),
    member_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    settled_at INTEGER,
    CHECK((state='known' AND outcome IS NOT NULL AND charged_micros>=0 AND charged_micros<=held_micros AND receipt_json IS NOT NULL AND settled_at IS NOT NULL)
      OR (state!='known' AND outcome IS NULL AND charged_micros IS NULL AND receipt_json IS NULL AND settled_at IS NULL)),
    CHECK(shared_settled=0 OR state='known')) STRICT`,
  // Request immutability: what a player submitted never changes; an administrator's marks are the only mutable columns.
  `CREATE TRIGGER web_cocreation_relations_request BEFORE UPDATE OF submission_id,member_count,set_key,reason ON web_cocreation_relations
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_members_immutable BEFORE UPDATE ON web_cocreation_members
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_ratings_immutable BEFORE UPDATE ON web_cocreation_ratings
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_adoptions_immutable BEFORE UPDATE ON web_cocreation_adoptions
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_adoptions_retain BEFORE DELETE ON web_cocreation_adoptions
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_tidy_identity BEFORE UPDATE OF id,request_id,request_hash,submission_id,model,price_id,max_units,
    held_micros,budget_id,fingerprint,member_id,session_id,created_at ON web_cocreation_tidy_calls
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_tidy_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,settled_at ON web_cocreation_tidy_calls
    WHEN OLD.state='known' BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_tidy_retain BEFORE DELETE ON web_cocreation_tidy_calls
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_RELATIONS_IMMUTABLE'); END`,
];
export const COCREATION_RELATIONS_DIGEST = createHash('sha256').update(statements.join(';\n')).digest('hex');

export const relationTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_relation_schema'");

/** Needs the submissions table (schema 117) and the provider prices table; a runtime without either installs nothing. */
export function installCocreationRelations(store: BusinessStore) {
  if (
    !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_submissions'") ||
    !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_prices'")
  )
    return;
  store.transaction(() => {
    if (!relationTablesExist(store)) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name GLOB 'web_cocreation_relation*' OR name GLOB 'web_cocreation_members*' OR name GLOB 'web_cocreation_ratings*' OR name GLOB 'web_cocreation_adoptions*' OR name GLOB 'web_cocreation_tidy_*'",
        ),
        'WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_cocreation_relation_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_cocreation_relation_schema VALUES (1,?)', COCREATION_RELATIONS_DIGEST);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_cocreation_relation_schema');
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === COCREATION_RELATIONS_DIGEST,
      'WEB_COCREATION_RELATIONS_SCHEMA_MISMATCH',
    );
  });
}
