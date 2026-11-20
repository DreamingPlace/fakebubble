import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 45: shareable voice-card links. The tables are installed by an idempotent, digest-checked runtime step (like the broadcast and
 * the 预演 tables). No numbered migration: `expected-migrations` stays as it was. STOP code on any drift: WEB_SHARE_SCHEMA_MISMATCH.
 *
 *  - web_shares: one row per link. Only the SHA-256 of the token is stored (a leaked database cannot open a link). It names the
 *    message it shares (world, conversation, message, media, character) and the two times. It never names the player: the principal
 *    behind the message is found through the message's own rows when the link is opened. A link lives exactly one day
 *    (`expires_at = created_at + 86 400 000`, a CHECK) and a row is never changed once written.
 *  - web_share_requests: the request id of each create (per principal), the hash of its body and the token it answered, so a repeat
 *    answers the same link and a different body under the same id is IDEMPOTENCY_CONFLICT. Player data: it goes with the world.
 *  - web_share_counts: three counters (created / opened / swept-as-expired). Counts only; no id, no content.
 */
export const SHARE_TTL_MS = 86_400_000;
const statements = [
  `CREATE TABLE web_shares(token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
    world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,media_id TEXT NOT NULL,
    character_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('reply','broadcast')),
    created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
    CHECK(expires_at=created_at+86400000)) STRICT`,
  `CREATE INDEX web_shares_scope ON web_shares(world_id,conversation_id)`,
  `CREATE INDEX web_shares_character ON web_shares(character_id)`,
  `CREATE INDEX web_shares_expiry ON web_shares(expires_at)`,
  `CREATE TABLE web_share_requests(principal_id TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(principal_id,request_id)) STRICT`,
  `CREATE INDEX web_share_requests_token ON web_share_requests(token_hash)`,
  `CREATE TABLE web_share_counts(name TEXT PRIMARY KEY CHECK(name IN ('created','opened','expired')),
    n INTEGER NOT NULL CHECK(n>=0)) STRICT`,
  `INSERT INTO web_share_counts VALUES ('created',0),('opened',0),('expired',0)`,
  `CREATE TRIGGER web_shares_fixed BEFORE UPDATE ON web_shares BEGIN SELECT RAISE(ABORT,'WEB_SHARE_IMMUTABLE'); END`,
  `CREATE TRIGGER web_share_requests_fixed BEFORE UPDATE ON web_share_requests
    BEGIN SELECT RAISE(ABORT,'WEB_SHARE_IMMUTABLE'); END`,
];

export function installWebShare(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_share_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_share*'"), 'WEB_SHARE_SCHEMA_MISMATCH');
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_share_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_share_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_share_schema');
    const guards = store.get<{ n: number }>(
      "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_share*'",
    )!.n;
    const counts = store.get<{ n: number }>('SELECT count(*) n FROM web_share_counts')!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === 2 && counts === 3,
      'WEB_SHARE_SCHEMA_MISMATCH',
    );
  });
}

export const webShareInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_share_schema'");

/**
 * Retention. A share is a pointer at the player's own message: it goes with the world (account deletion, a closed account, a guest's
 * purge, the retention cleaners), with the conversation (the player's or the owner's deletion) and with the character. Each helper
 * runs INSIDE the caller's transaction, before its `DELETE FROM messages`, and does nothing on a database without the tables.
 * Opening a link also re-checks that the message still exists, so a missed purge could not keep a link working.
 */
export function purgeShareWorld(store: BusinessStore, worldId: string) {
  if (!webShareInstalled(store)) return;
  store.run('DELETE FROM web_shares WHERE world_id=?', worldId);
  store.run(
    'DELETE FROM web_share_requests WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)',
    worldId,
  );
}
export function purgeShareConversation(store: BusinessStore, worldId: string, conversationId: string) {
  if (!webShareInstalled(store)) return;
  store.run('DELETE FROM web_shares WHERE world_id=? AND conversation_id=?', worldId, conversationId);
  store.run('DELETE FROM web_share_requests WHERE token_hash NOT IN (SELECT token_hash FROM web_shares)');
}
export function purgeShareCharacter(store: BusinessStore, characterId: string) {
  if (!webShareInstalled(store)) return;
  store.run('DELETE FROM web_shares WHERE character_id=?', characterId);
  store.run('DELETE FROM web_share_requests WHERE token_hash NOT IN (SELECT token_hash FROM web_shares)');
}
/** Rows still holding a world's links (the audits assert zero after a purge). */
export function shareResidue(store: Pick<BusinessStore, 'get'>, worldId: string) {
  if (!webShareInstalled(store)) return 0;
  return store.get<{ n: number }>(
    `SELECT (SELECT count(*) FROM web_shares WHERE world_id=?)+
    (SELECT count(*) FROM web_share_requests WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)) n`,
    worldId,
    worldId,
  )!.n;
}
