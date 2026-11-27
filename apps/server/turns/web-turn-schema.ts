import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 36: 连发. Several bubbles in a row are answered by ONE reply (a turn). The tables are installed by an idempotent,
 * digest-checked runtime step (like the shares and the broadcast). No numbered migration: `expected-migrations` stays as it was.
 * STOP code on any drift: WEB_TURN_SCHEMA_MISMATCH.
 *
 *  - web_turn_bubbles: one row per bubble a player sent. The bubble's text is an ordinary `messages` row (stored the moment it is
 *    sent); this row says which request sent it, which message it quotes (same conversation, checked when it is written), and which
 *    turn it belongs to once the batch closes. It keeps the keyed IP hash of the request (the trial counters need it when the batch
 *    closes, possibly from an alarm); like every IP hash it never reaches a log or an admin view. A bubble is `pending` until then; `turn` names the operation (its input message is the
 *    LAST bubble of the batch, so every table that keys one input message per operation keeps its meaning); `refused` marks bubbles
 *    whose turn could not be admitted when the batch closed (the code is kept, no content). A row changes state once and never
 *    otherwise (trigger). The player's text lives only in `messages`: this table holds no content.
 */
export const TURN_QUIET_MS = 4_000;
export const TURN_MAX_BUBBLES = 5;
/** Bubbles that may wait at once (a reply in flight keeps later bubbles for the next turn). */
export const TURN_MAX_PENDING = 15;
const statements = [
  `CREATE TABLE web_turn_bubbles(message_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,world_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,character_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    quote_message_id TEXT,ip_hash TEXT NOT NULL CHECK(length(ip_hash)=64),created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','turn','refused')),operation_id TEXT,refused_code TEXT,
    CHECK((state='turn')=(operation_id IS NOT NULL)),CHECK((state='refused')=(refused_code IS NOT NULL)),
    UNIQUE(principal_id,request_id)) STRICT`,
  `CREATE INDEX web_turn_bubbles_scope ON web_turn_bubbles(world_id,conversation_id,state,created_at)`,
  `CREATE INDEX web_turn_bubbles_operation ON web_turn_bubbles(operation_id)`,
  `CREATE INDEX web_turn_bubbles_character ON web_turn_bubbles(character_id)`,
  `CREATE TRIGGER web_turn_bubbles_fixed BEFORE UPDATE ON web_turn_bubbles
    WHEN OLD.state<>'pending' OR NEW.message_id IS NOT OLD.message_id OR NEW.principal_id IS NOT OLD.principal_id
      OR NEW.world_id IS NOT OLD.world_id OR NEW.conversation_id IS NOT OLD.conversation_id
      OR NEW.character_id IS NOT OLD.character_id OR NEW.request_id IS NOT OLD.request_id
      OR NEW.request_hash IS NOT OLD.request_hash OR NEW.quote_message_id IS NOT OLD.quote_message_id
      OR NEW.ip_hash IS NOT OLD.ip_hash OR NEW.created_at IS NOT OLD.created_at
    BEGIN SELECT RAISE(ABORT,'WEB_TURN_IMMUTABLE'); END`,
];

export function installWebTurns(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_turn_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_turn_*'"), 'WEB_TURN_SCHEMA_MISMATCH');
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_turn_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_turn_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_turn_schema');
    const guards = store.get<{ n: number }>(
      "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_turn_*'",
    )!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === 1,
      'WEB_TURN_SCHEMA_MISMATCH',
    );
  });
}

export const webTurnsInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_turn_schema'");

/** Retention, like the shares: each helper runs INSIDE the caller's transaction, before its `DELETE FROM messages`. */
export function purgeTurnsWorld(store: BusinessStore, worldId: string) {
  if (!webTurnsInstalled(store)) return;
  store.run('DELETE FROM web_turn_bubbles WHERE world_id=?', worldId);
}
export function purgeTurnsConversation(store: BusinessStore, worldId: string, conversationId: string) {
  if (!webTurnsInstalled(store)) return;
  store.run('DELETE FROM web_turn_bubbles WHERE world_id=? AND conversation_id=?', worldId, conversationId);
}
export function purgeTurnsCharacter(store: BusinessStore, characterId: string) {
  if (!webTurnsInstalled(store)) return;
  store.run('DELETE FROM web_turn_bubbles WHERE character_id=?', characterId);
}
export function turnsResidue(store: Pick<BusinessStore, 'get'>, worldId: string) {
  if (!webTurnsInstalled(store)) return 0;
  return store.get<{ n: number }>('SELECT count(*) n FROM web_turn_bubbles WHERE world_id=?', worldId)!.n;
}
