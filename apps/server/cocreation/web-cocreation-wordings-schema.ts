import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { COCREATION_THEME_IDS } from '../../../packages/contracts/cocreation-wordings.ts';

/**
 * Part 39b: the tables of the co-creation WORDING POOL. NO numbered migration (expected-migrations is untouched): installed idempotently at
 * business-object start and checked against the digest of its statements. STOP code: WEB_COCREATION_WORDINGS_SCHEMA_MISMATCH (a table of
 * this step exists with other contents, or a table of this name family exists without the step's marker).
 *
 * - web_cocreation_wordings: one row per wording of a character's theme (switched on or off); `request_id` makes an add idempotent.
 * - web_cocreation_answer_wordings: the exact wording a player was shown for each theme answer (goes with the submission when it is purged).
 * - web_cocreation_wording_calls: the ledger of the optional 生成 text call (reserve, intent, sent, unknown, known), as for 整理.
 */
const themes = COCREATION_THEME_IDS.map((id) => `'${id}'`).join(',');
const statements = [
  `CREATE TABLE web_cocreation_wordings(
    id TEXT PRIMARY KEY,
    character_id TEXT NOT NULL,
    theme_id TEXT NOT NULL CHECK(theme_id IN (${themes})),
    text TEXT NOT NULL CHECK(length(text)>0),
    enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    source TEXT NOT NULL CHECK(source IN ('manual','generated')),
    request_id TEXT UNIQUE,
    request_hash TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL) STRICT`,
  `CREATE INDEX web_cocreation_wordings_pool ON web_cocreation_wordings(character_id,theme_id)`,
  `CREATE TABLE web_cocreation_answer_wordings(
    submission_id TEXT NOT NULL REFERENCES web_cocreation_submissions(id),
    ordinal INTEGER NOT NULL,
    wording TEXT NOT NULL CHECK(length(wording)>0),
    PRIMARY KEY(submission_id,ordinal)) STRICT`,
  `CREATE TABLE web_cocreation_wording_calls(
    id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
    character_id TEXT NOT NULL,
    model TEXT NOT NULL,
    price_id TEXT NOT NULL REFERENCES web_provider_prices(id),
    max_units INTEGER NOT NULL CHECK(max_units>0),
    held_micros INTEGER NOT NULL CHECK(held_micros>0),
    budget_id TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('intent','sent','unknown','known','released')),
    outcome TEXT CHECK(outcome IN ('succeeded','failed')),
    error_code TEXT,
    added INTEGER,
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
  `CREATE TRIGGER web_cocreation_wordings_identity BEFORE UPDATE OF id,character_id,theme_id,source,request_id,request_hash,created_at ON web_cocreation_wordings
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_WORDINGS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_answer_wordings_immutable BEFORE UPDATE ON web_cocreation_answer_wordings
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_WORDINGS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_wording_calls_identity BEFORE UPDATE OF id,request_id,request_hash,character_id,model,price_id,max_units,
    held_micros,budget_id,fingerprint,member_id,session_id,created_at ON web_cocreation_wording_calls
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_WORDINGS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_wording_calls_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,settled_at ON web_cocreation_wording_calls
    WHEN OLD.state='known' BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_WORDINGS_IMMUTABLE'); END`,
  `CREATE TRIGGER web_cocreation_wording_calls_retain BEFORE DELETE ON web_cocreation_wording_calls
    BEGIN SELECT RAISE(ABORT,'WEB_COCREATION_WORDINGS_IMMUTABLE'); END`,
];
export const COCREATION_WORDINGS_DIGEST = createHash('sha256').update(statements.join(';\n')).digest('hex');

export const wordingTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_wording_schema'");

/** Needs the submissions table (schema 117) and the provider prices table; a runtime without either installs nothing. */
export function installCocreationWordings(store: BusinessStore) {
  if (
    !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_submissions'") ||
    !store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_prices'")
  )
    return;
  store.transaction(() => {
    if (!wordingTablesExist(store)) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name GLOB 'web_cocreation_wording*' OR name GLOB 'web_cocreation_answer_wording*'",
        ),
        'WEB_COCREATION_WORDINGS_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_cocreation_wording_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_cocreation_wording_schema VALUES (1,?)', COCREATION_WORDINGS_DIGEST);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_cocreation_wording_schema');
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === COCREATION_WORDINGS_DIGEST,
      'WEB_COCREATION_WORDINGS_SCHEMA_MISMATCH',
    );
  });
}
