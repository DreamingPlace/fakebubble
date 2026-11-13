import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { LATE_TABLES, embeddingTableExists, releaseUnsentEmbedHolds } from '../budget/web-embed-purge.ts';
import { webReceiptDigest } from '../admission/web-retention.ts';
import { checkAudioReference, speechObjectScope } from '../audio/web-provider-media.ts';
import type { MediaObjectReference } from '../cloudflare/media-objects.ts';
import { webWelcomeLinesInstalled } from './web-welcome-schema.ts';
import {
  auditCharacterDeletionScope,
  conversationContent,
  operationContent,
  operationScope,
  scopeArgs,
  worldCharacterContent,
  type DeletionScope,
} from './web-character-deletion-audit.ts';
import { guardedTables, guardedTriggerSql } from './web-character-deletion-schema.ts';

/**
 * Part 31 (owner): delete ONE live private conversation (what 测试对话 lists) for good. NO numbered migration: a digest-checked
 * runtime step, installed after installWebCharacterDeletion. STOP code: WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH.
 *
 * It reuses the character deletion's content lists and its scope audit (so a table this code does not know fails closed with the
 * same CHARACTER_DELETION_UNHANDLED_CONTENT) and the same R2 erase. What differs: the deletion is of one conversation only
 * (nothing of the character as a whole is touched), a conversation with an unfinished operation is refused
 * (CONVERSATION_DELETE_BUSY, nothing is cancelled, resent or released here), and the guarded content tables are opened for exactly
 * this conversation's operations by a gate row that exists only inside the transaction. Money, quota and ledger rows stay; an
 * UNKNOWN provider call stays UNKNOWN and its hold is kept.
 *
 *   web_conversation_purge_gate  (world_id, conversation_id): present only inside the deleting transaction.
 *   web_conversation_deletions   the audio-erase record: one row per conversation, audio_cleared_at NULL until every R2 object of
 *                                that conversation's operations has been erased (retried by the alarm sweep).
 */
const statements = [
  `CREATE TABLE web_conversation_purge_gate(world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,
    PRIMARY KEY(world_id,conversation_id)) STRICT`,
  `CREATE TABLE web_conversation_deletions(world_id TEXT NOT NULL,conversation_id TEXT NOT NULL,principal_id TEXT NOT NULL,
    character_id TEXT NOT NULL,deleted_at INTEGER NOT NULL,audio_cleared_at INTEGER,
    PRIMARY KEY(world_id,conversation_id)) STRICT`,
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');

export function installWebConversationDeletion(store: WebRuntimeStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_conversation_deletion_schema'")) {
      ensure(
        !store.get(
          "SELECT 1 FROM sqlite_master WHERE name IN ('web_conversation_purge_gate','web_conversation_deletions')",
        ),
        'WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH',
      );
      // The character deletion's own step must have run: the guarded triggers are in its form.
      ensure(
        store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletion_schema'"),
        'WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH',
      );
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_conversation_deletion_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_conversation_deletion_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_conversation_deletion_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH');
    for (const entry of guardedTables) {
      const current = store.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?", entry[1])?.sql;
      ensure(current, 'WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH');
      const widened = guardedTriggerSql(store, entry, true);
      if (normalize(current) === normalize(widened)) continue;
      // Only the exact form the character deletion step installs may be widened; anything else is not ours to rewrite.
      ensure(
        normalize(current) === normalize(guardedTriggerSql(store, entry, false)),
        'WEB_CONVERSATION_DELETION_SCHEMA_MISMATCH',
      );
      store.run(`DROP TRIGGER ${entry[1]}`);
      store.run(widened);
    }
  });
}

export type ConversationRef = { principalId: string; worldId: string; conversationId: string; characterId: string };
const asScope = (c: ConversationRef): DeletionScope => ({
  deletion_id: '',
  principal_id: c.principalId,
  world_id: c.worldId,
  conversation_id: c.conversationId,
  character_id: c.characterId,
  db_cleared_at: null,
  audio_cleared_at: null,
});

/** True while the conversation has an operation that is not finished, or an attempt that has not settled. */
export function conversationBusy(store: WebRuntimeStore, c: ConversationRef) {
  const s = asScope(c);
  return (
    !!store.get(
      `SELECT 1 FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?
      AND (status NOT IN ('published','failed','cancelled') OR quota_state='reserved') LIMIT 1`,
      ...scopeArgs(s),
    ) ||
    !!store.get(
      `SELECT 1 FROM web_provider_attempts WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?
      AND state IN ('not_sent','sent') LIMIT 1`,
      ...scopeArgs(s),
    )
  );
}

/**
 * One synchronous transaction. Returns the number of messages removed. Throws CONVERSATION_DELETE_BUSY for a conversation with an
 * unfinished operation, CHARACTER_DELETION_SCOPE_UNSAFE when the ids do not belong together (checked by the shared audit).
 */
export function deleteLiveConversation(store: WebRuntimeStore, clock: Clock, c: ConversationRef) {
  const s = asScope(c);
  return store.transaction(() => {
    const now = clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    auditCharacterDeletionScope(store, s, false, true);
    ensure(!conversationBusy(store, c), 'CONVERSATION_DELETE_BUSY');
    ensure(
      store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
        !store.get('SELECT 1 FROM web_conversation_purge_gate LIMIT 1') &&
        !store.get('SELECT 1 FROM web_character_purge_gate LIMIT 1'),
      'CHARACTER_DELETION_SCOPE_UNSAFE',
    );
    const messages = store.get<{ n: number }>(
      'SELECT count(*) n FROM messages WHERE world_id=? AND conversation_id=?',
      c.worldId,
      c.conversationId,
    )!.n;
    store.run('INSERT INTO web_conversation_purge_gate VALUES (?,?)', c.worldId, c.conversationId);
    if (store.providerAudio)
      for (const table of ['web_provider_outputs', 'web_provider_media_assets'])
        ensure(
          !store.get(
            `SELECT 1 FROM ${table} m
        WHERE m.operation_id IN (${operationScope}) AND m.audio_ref_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cf_web_audio_objects x
          WHERE x.operation_id=m.operation_id AND x.ordinal=m.ordinal AND x.reference_json=m.audio_ref_json AND x.principal_id=? AND x.world_id=?) LIMIT 1`,
            ...scopeArgs(s),
            c.principalId,
            c.worldId,
          ),
          'CHARACTER_DELETION_AUDIO_INTENT_REQUIRED',
        );
    for (const table of ['web_local_events', 'web_user_events'])
      store.run(
        `DELETE FROM ${table} WHERE principal_id=? AND world_id=? AND conversation_id=?`,
        c.principalId,
        c.worldId,
        c.conversationId,
      );
    for (const table of operationContent)
      store.run(`DELETE FROM ${table} WHERE operation_id IN (${operationScope})`, ...scopeArgs(s));
    releaseUnsentEmbedHolds(store, c.worldId, c.conversationId);
    for (const table of conversationContent)
      if (!LATE_TABLES.has(table) || embeddingTableExists(store, table))
        store.run(`DELETE FROM ${table} WHERE world_id=? AND conversation_id=?`, c.worldId, c.conversationId);
    // The welcome line this player was drawn for the character goes with the conversation (the shared audit demands it gone).
    if (webWelcomeLinesInstalled(store))
      store.run('DELETE FROM web_welcome_choices WHERE world_id=? AND character_id=?', c.worldId, c.characterId);
    for (const table of worldCharacterContent)
      store.run(`DELETE FROM ${table} WHERE world_id=? AND character_id=?`, c.worldId, c.characterId);
    store.run(
      'UPDATE jobs SET published_message_id=NULL WHERE world_id=? AND conversation_id=?',
      c.worldId,
      c.conversationId,
    );
    store.run('DELETE FROM jobs WHERE world_id=? AND conversation_id=?', c.worldId, c.conversationId);
    for (const o of store.all<{ id: string; payload_hash: string }>(
      'SELECT id,payload_hash FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?',
      ...scopeArgs(s),
    ))
      store.run(
        'UPDATE web_operations SET input_message_id=NULL,payload_hash=? WHERE id=?',
        webReceiptDigest(store, 'receipt', 'deleted-conversation\0' + o.payload_hash),
        o.id,
      );
    for (const a of store.all<{
      operation_id: string;
      stage: string;
      phase: string;
      ordinal: number;
      receipt_json: string | null;
      usage_json: string | null;
    }>(`SELECT * FROM web_external_attempts WHERE operation_id IN (${operationScope}) AND dispatch_state='known'`, ...scopeArgs(s)))
      store.run(
        `UPDATE web_external_attempts SET receipt_json=NULL,usage_json=NULL,receipt_digest=coalesce(receipt_digest,?),usage_digest=coalesce(usage_digest,?)
        WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
        a.receipt_json === null ? null : webReceiptDigest(store, 'receipt', a.receipt_json),
        a.usage_json === null ? null : webReceiptDigest(store, 'usage', a.usage_json),
        a.operation_id,
        a.stage,
        a.phase,
        a.ordinal,
      );
    store.run('DELETE FROM messages WHERE world_id=? AND conversation_id=?', c.worldId, c.conversationId);
    store.run(
      'UPDATE contacts SET state_json=? WHERE world_id=? AND conversation_id=? AND character_id=?',
      JSON.stringify(emptySession()),
      c.worldId,
      c.conversationId,
      c.characterId,
    );
    store.run(
      "UPDATE world_characters SET relationship='new' WHERE world_id=? AND character_id=?",
      c.worldId,
      c.characterId,
    );
    store.run('DELETE FROM web_conversation_purge_gate WHERE world_id=? AND conversation_id=?', c.worldId, c.conversationId);
    auditCharacterDeletionScope(store, s, true, true);
    ensure(!store.get('PRAGMA foreign_key_check'), 'CHARACTER_DELETION_INCOMPLETE');
    store.run(
      `INSERT INTO web_conversation_deletions(world_id,conversation_id,principal_id,character_id,deleted_at,audio_cleared_at)
      VALUES (?,?,?,?,?,NULL) ON CONFLICT(world_id,conversation_id) DO UPDATE SET deleted_at=excluded.deleted_at,audio_cleared_at=NULL`,
      c.worldId,
      c.conversationId,
      c.principalId,
      c.characterId,
      now,
    );
    return messages;
  });
}

/** Erases the R2 objects of every deleted conversation that still has some (R2 deployments only). Idempotent; the alarm retries a failure. */
export async function eraseDeletedConversationAudio(store: WebRuntimeStore, clock: Clock, limit = 4) {
  if (!conversationDeletionInstalledSafe(store)) return 0;
  const pending = store.all<{
    world_id: string;
    conversation_id: string;
    principal_id: string;
    character_id: string;
  }>('SELECT * FROM web_conversation_deletions WHERE audio_cleared_at IS NULL ORDER BY deleted_at LIMIT ?', limit);
  for (const row of pending) {
    const s = asScope({
      principalId: row.principal_id,
      worldId: row.world_id,
      conversationId: row.conversation_id,
      characterId: row.character_id,
    });
    if (store.providerAudio)
      for (const intent of store.all<{ operation_id: string; ordinal: number; reference_json: string }>(
        `SELECT * FROM cf_web_audio_objects WHERE principal_id=? AND world_id=? AND operation_id IN (${operationScope}) AND erased_at IS NULL`,
        s.principal_id,
        s.world_id,
        ...scopeArgs(s),
      )) {
        const reference = JSON.parse(intent.reference_json) as MediaObjectReference;
        const authorize = async () => {
          ensure(
            store.get(
              'SELECT 1 FROM web_conversation_deletions WHERE world_id=? AND conversation_id=? AND audio_cleared_at IS NULL',
              s.world_id,
              s.conversation_id,
            ),
            'CHARACTER_DELETION_SCOPE_UNSAFE',
          );
          const a = store.get<{ player_id: string; input_message_id: string }>(
            `SELECT * FROM web_provider_attempts WHERE operation_id=? AND phase='speech' AND ordinal=?
          AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=?`,
            intent.operation_id,
            intent.ordinal,
            ...scopeArgs(s),
          );
          ensure(a, 'CHARACTER_DELETION_SCOPE_UNSAFE');
          checkAudioReference(
            reference,
            speechObjectScope(store, intent.operation_id, intent.ordinal, {
              principalId: s.principal_id,
              worldId: s.world_id,
              conversationId: s.conversation_id,
              characterId: s.character_id,
              playerId: a.player_id,
              inputMessageId: a.input_message_id,
            }),
          );
        };
        await store.providerAudio.erase(reference, authorize);
        store.run(
          'UPDATE cf_web_audio_objects SET erased_at=? WHERE operation_id=? AND ordinal=? AND reference_json=?',
          clock.now(),
          intent.operation_id,
          intent.ordinal,
          intent.reference_json,
        );
      }
    store.run(
      'UPDATE web_conversation_deletions SET audio_cleared_at=? WHERE world_id=? AND conversation_id=?',
      clock.now(),
      row.world_id,
      row.conversation_id,
    );
  }
  return pending.length;
}
const conversationDeletionInstalledSafe = (store: Pick<WebRuntimeStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_conversation_deletion_schema'");
/** True while an audio erase of a deleted conversation is waiting (so the alarm wakes for it). */
export const conversationAudioPending = (store: Pick<WebRuntimeStore, 'get'>) =>
  conversationDeletionInstalledSafe(store) &&
  !!store.get('SELECT 1 FROM web_conversation_deletions WHERE audio_cleared_at IS NULL LIMIT 1');
