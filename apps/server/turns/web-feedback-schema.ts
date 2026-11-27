import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 36: 👍 / 👎 on a character's reply. Installed by an idempotent, digest-checked runtime step; no numbered migration.
 * STOP code on any drift: WEB_FEEDBACK_SCHEMA_MISMATCH.
 *
 *  - web_feedback: at most ONE rating per player per message (primary key principal + message). `target` is 'voice' or 'content'
 *    for a 👎 (what the player is rating down) and NULL for a 👍. The writer (回复写法) and the model that wrote the reply are
 *    copied when the rating is written, so the admin counts never join back into a transcript. `heard_at` is the owner's 「已听」.
 *    It holds the player's principal and the conversation: player data, deleted with the world, the conversation and the character.
 *  - web_feedback_requests: the request id of each write (per principal) with the hash of its body, so a repeat answers the same
 *    and a different body under the same id is IDEMPOTENCY_CONFLICT.
 */
const statements = [
  `CREATE TABLE web_feedback(principal_id TEXT NOT NULL,message_id TEXT NOT NULL,world_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,character_id TEXT NOT NULL,operation_id TEXT NOT NULL,
    rating TEXT NOT NULL CHECK(rating IN ('up','down')),target TEXT CHECK(target IN ('voice','content')),
    writer TEXT NOT NULL,model TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,heard_at INTEGER,
    CHECK((rating='down')=(target IS NOT NULL)),PRIMARY KEY(principal_id,message_id)) STRICT`,
  `CREATE INDEX web_feedback_scope ON web_feedback(world_id,conversation_id)`,
  `CREATE INDEX web_feedback_character ON web_feedback(character_id,updated_at)`,
  `CREATE INDEX web_feedback_time ON web_feedback(updated_at)`,
  `CREATE TABLE web_feedback_requests(principal_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,PRIMARY KEY(principal_id,request_id)) STRICT`,
  `CREATE TRIGGER web_feedback_requests_fixed BEFORE UPDATE ON web_feedback_requests
    BEGIN SELECT RAISE(ABORT,'WEB_FEEDBACK_IMMUTABLE'); END`,
];

export function installWebFeedback(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_feedback_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_feedback*'"), 'WEB_FEEDBACK_SCHEMA_MISMATCH');
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_feedback_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_feedback_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_feedback_schema');
    const guards = store.get<{ n: number }>(
      "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_feedback*'",
    )!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === 1,
      'WEB_FEEDBACK_SCHEMA_MISMATCH',
    );
  });
}

export const webFeedbackInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_feedback_schema'");

export function purgeFeedbackWorld(store: BusinessStore, worldId: string) {
  if (!webFeedbackInstalled(store)) return;
  store.run('DELETE FROM web_feedback WHERE world_id=?', worldId);
  store.run(
    'DELETE FROM web_feedback_requests WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)',
    worldId,
  );
}
export function purgeFeedbackConversation(store: BusinessStore, worldId: string, conversationId: string) {
  if (!webFeedbackInstalled(store)) return;
  store.run('DELETE FROM web_feedback WHERE world_id=? AND conversation_id=?', worldId, conversationId);
}
export function purgeFeedbackCharacter(store: BusinessStore, characterId: string) {
  if (!webFeedbackInstalled(store)) return;
  store.run('DELETE FROM web_feedback WHERE character_id=?', characterId);
}
export function feedbackResidue(store: Pick<BusinessStore, 'get'>, worldId: string) {
  if (!webFeedbackInstalled(store)) return 0;
  return store.get<{ n: number }>(
    `SELECT (SELECT count(*) FROM web_feedback WHERE world_id=?)+
    (SELECT count(*) FROM web_feedback_requests WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)) n`,
    worldId,
    worldId,
  )!.n;
}
