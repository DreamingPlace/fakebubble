import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 59: which ITEMS of a co-creation submission the administrator has handled. A submission (one player may send about ten answers
 * at once, or a relation note with a story and a reason) is processed only when every item is handled; before this Part the first
 * 采纳 moved the whole submission. NO numbered migration (expected-migrations is untouched): the table is installed idempotently at
 * business-object start and checked against the digest of its statement, like Part 39's tables. STOP code:
 * WEB_COCREATION_MARKS_SCHEMA_MISMATCH.
 *
 * - `item` is `a<ordinal>` (an answer, ordinal 0..11) or `reason` (the reason of a two-character relation note).
 * - `how`: adopted (the reason adopted as the pair's annotation) / rejected (不采纳) / copied (复制) / handled (标为已处理).
 *   An answer's 采纳 is recorded where it always was (`web_cocreation_answers.adopted_at`), not here.
 * The rows hold no player text. They go with the submission (purge).
 */
const statement = `CREATE TABLE web_cocreation_item_marks(
  submission_id TEXT NOT NULL REFERENCES web_cocreation_submissions(id),
  item TEXT NOT NULL CHECK(item='reason' OR item GLOB 'a[0-9]' OR item GLOB 'a1[01]'),
  how TEXT NOT NULL CHECK(how IN ('adopted','rejected','copied','handled')),
  actor_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(submission_id,item)) STRICT`;
export const COCREATION_MARKS_DIGEST = createHash('sha256').update(statement).digest('hex');
export const COCREATION_ITEM_HOW = ['rejected', 'copied', 'handled'] as const;

export const marksTableExists = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_marks_schema'");

export function installCocreationMarks(store: BusinessStore) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_submissions'")) return;
  store.transaction(() => {
    if (!marksTableExists(store)) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name GLOB 'web_cocreation_item_marks*' OR name GLOB 'web_cocreation_marks_*'",
        ),
        'WEB_COCREATION_MARKS_SCHEMA_MISMATCH',
      );
      store.run(statement);
      store.run(
        'CREATE TABLE web_cocreation_marks_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_cocreation_marks_schema VALUES (1,?)', COCREATION_MARKS_DIGEST);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_cocreation_marks_schema');
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === COCREATION_MARKS_DIGEST,
      'WEB_COCREATION_MARKS_SCHEMA_MISMATCH',
    );
  });
}
