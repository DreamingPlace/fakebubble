import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 42: 广播. The tables are installed by an idempotent, digest-checked runtime step (like the 预演 queue and the admin speech
 * path). No numbered migration: `expected-migrations` stays as it was. STOP code on any drift: WEB_BROADCAST_SCHEMA_MISMATCH.
 *
 *  - web_broadcast_requests: one row per console request id (create, edit, cancel, send now): the request hash and the broadcast
 *    it answered. A repeat with the same body answers the same; a different body under the same id is IDEMPOTENCY_CONFLICT.
 *  - web_broadcasts: the record. State, the time, the text the administrator wrote, the characters and COUNTS only (recipients,
 *    deliveries, the cursor). No player identity is in it.
 *  - web_broadcast_characters: the voice clip of one character in one broadcast, stored ONCE here and referenced by every message.
 *  - web_broadcast_takes: a voice an administrator generated or uploaded and has not used yet (to listen to before sending).
 *  - web_broadcast_recipients: the registered players frozen when the broadcast starts (so later registrations never receive it),
 *    with the ordinal the cursor walks. Player data: the purges remove a player's rows.
 *  - web_broadcast_messages: which message rows a broadcast wrote into which conversation. The delivery's idempotency key is
 *    (broadcast, character, player, ordinal); it is also how history, the audio route and the writer's context recognise the
 *    message as the character's own. Player data: removed with the conversation, the world and the character.
 */
const statements = [
  `CREATE TABLE web_broadcasts(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    state TEXT NOT NULL CHECK(state IN ('scheduled','sending','sent','cancelled')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),send_at INTEGER NOT NULL CHECK(send_at>=0),
    bubbles_json TEXT NOT NULL CHECK(json_valid(bubbles_json)),character_ids_json TEXT NOT NULL CHECK(json_valid(character_ids_json)),
    recipients INTEGER NOT NULL DEFAULT 0 CHECK(recipients>=0),total INTEGER NOT NULL DEFAULT 0 CHECK(total>=0),
    delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered>=0 AND delivered<=total),cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor>=0),
    created_at INTEGER NOT NULL,started_at INTEGER,finished_at INTEGER,cancelled_at INTEGER,
    CHECK((state='scheduled' AND started_at IS NULL) OR (state IN ('sending','sent') AND started_at IS NOT NULL) OR state='cancelled'),
    CHECK(state!='sent' OR finished_at IS NOT NULL)) STRICT`,
  `CREATE INDEX web_broadcasts_due ON web_broadcasts(state,send_at)`,
  `CREATE TABLE web_broadcast_requests(request_id TEXT PRIMARY KEY,kind TEXT NOT NULL,request_hash TEXT NOT NULL,
    broadcast_id TEXT,member_id TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_broadcast_characters(broadcast_id TEXT NOT NULL REFERENCES web_broadcasts(id),character_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),voice TEXT NOT NULL CHECK(voice IN ('none','generated','uploaded')),
    sha256 TEXT,byte_length INTEGER,duration_ms INTEGER,audio BLOB,
    PRIMARY KEY(broadcast_id,character_id),
    CHECK((voice='none' AND audio IS NULL AND sha256 IS NULL AND byte_length IS NULL AND duration_ms IS NULL) OR
      (voice!='none' AND audio IS NOT NULL AND sha256 IS NOT NULL AND byte_length=length(audio) AND duration_ms>0))) STRICT`,
  `CREATE TABLE web_broadcast_takes(id TEXT PRIMARY KEY,request_id TEXT UNIQUE,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    character_id TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin IN ('generated','uploaded')),text_sha256 TEXT,
    sha256 TEXT NOT NULL,byte_length INTEGER NOT NULL CHECK(byte_length>0 AND byte_length<=1900000),
    duration_ms INTEGER NOT NULL CHECK(duration_ms>0),audio BLOB NOT NULL,created_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_broadcast_recipients(broadcast_id TEXT NOT NULL REFERENCES web_broadcasts(id),
    ordinal INTEGER NOT NULL CHECK(ordinal>=1),principal_id TEXT NOT NULL,
    PRIMARY KEY(broadcast_id,ordinal),UNIQUE(broadcast_id,principal_id)) STRICT`,
  `CREATE INDEX web_broadcast_recipients_principal ON web_broadcast_recipients(principal_id)`,
  `CREATE TABLE web_broadcast_messages(message_id TEXT PRIMARY KEY,broadcast_id TEXT NOT NULL REFERENCES web_broadcasts(id),
    character_id TEXT NOT NULL,principal_id TEXT NOT NULL,world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK(ordinal>=0),kind TEXT NOT NULL CHECK(kind IN ('text','voice')),
    UNIQUE(broadcast_id,character_id,principal_id,ordinal)) STRICT`,
  `CREATE INDEX web_broadcast_messages_scope ON web_broadcast_messages(world_id,conversation_id)`,
  `CREATE INDEX web_broadcast_messages_character ON web_broadcast_messages(character_id)`,
  `CREATE TRIGGER web_broadcasts_identity BEFORE UPDATE OF id,member_id,created_at ON web_broadcasts
    BEGIN SELECT RAISE(ABORT,'WEB_BROADCAST_IMMUTABLE'); END`,
  `CREATE TRIGGER web_broadcasts_sent_fixed BEFORE UPDATE OF bubbles_json,character_ids_json,send_at ON web_broadcasts
    WHEN OLD.state!='scheduled' BEGIN SELECT RAISE(ABORT,'WEB_BROADCAST_IMMUTABLE'); END`,
  `CREATE TRIGGER web_broadcasts_retain BEFORE DELETE ON web_broadcasts BEGIN SELECT RAISE(ABORT,'WEB_BROADCAST_IMMUTABLE'); END`,
  `CREATE TRIGGER web_broadcast_messages_fixed BEFORE UPDATE ON web_broadcast_messages
    BEGIN SELECT RAISE(ABORT,'WEB_BROADCAST_IMMUTABLE'); END`,
];

export function installWebBroadcast(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_broadcast_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_broadcast*'"),
        'WEB_BROADCAST_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.all(sql);
      store.all(
        'CREATE TABLE web_broadcast_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_broadcast_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_broadcast_schema');
    const guards = store.get<{ n: number }>(
      "SELECT count(*) n FROM sqlite_master WHERE type='trigger' AND name GLOB 'web_broadcast*'",
    )!.n;
    ensure(
      rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest && guards === 4,
      'WEB_BROADCAST_SCHEMA_MISMATCH',
    );
  });
}

export const webBroadcastInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_broadcast_schema'");

/**
 * Retention. A broadcast's messages and recipient rows are the player's data: they go with the world (account deletion, a closed
 * account, a guest's purge), with a conversation (the owner's or the player's own deletion) and with a character's deletion. The
 * record (counts and the text the administrator wrote) stays like any other console history. Each helper runs INSIDE the caller's
 * transaction, before its `DELETE FROM messages`, and does nothing on a database without the tables.
 */
export function purgeBroadcastWorld(store: BusinessStore, worldId: string) {
  if (!webBroadcastInstalled(store)) return;
  store.run('DELETE FROM web_broadcast_messages WHERE world_id=?', worldId);
  store.run(
    'DELETE FROM web_broadcast_recipients WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)',
    worldId,
  );
}
export function purgeBroadcastConversation(store: BusinessStore, worldId: string, conversationId: string) {
  if (!webBroadcastInstalled(store)) return;
  store.run('DELETE FROM web_broadcast_messages WHERE world_id=? AND conversation_id=?', worldId, conversationId);
}
/** A character's deletion: its voice clips and takes go too (the delivered messages go with each conversation's purge). */
export function purgeBroadcastCharacter(store: BusinessStore, characterId: string) {
  if (!webBroadcastInstalled(store)) return;
  store.run('DELETE FROM web_broadcast_messages WHERE character_id=?', characterId);
  store.run('DELETE FROM web_broadcast_takes WHERE character_id=?', characterId);
  store.run(
    `UPDATE web_broadcast_characters SET voice='none',audio=NULL,sha256=NULL,byte_length=NULL,duration_ms=NULL
    WHERE character_id=?`,
    characterId,
  );
}
/** Rows still holding a player's message for a world (the audits assert zero after a purge). */
export function broadcastResidue(store: Pick<BusinessStore, 'get'>, worldId: string) {
  if (!webBroadcastInstalled(store)) return 0;
  return store.get<{ n: number }>(
    `SELECT (SELECT count(*) FROM web_broadcast_messages WHERE world_id=?)+
    (SELECT count(*) FROM web_broadcast_recipients WHERE principal_id IN (SELECT id FROM web_principals WHERE world_id=?)) n`,
    worldId,
    worldId,
  )!.n;
}
