import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { webBroadcastInstalled } from './web-broadcast-schema.ts';

/**
 * Part 42: how a delivered broadcast shows to the rest of the system. A broadcast message is the CHARACTER's own message in the
 * player's conversation with it, so history, the audio route and the writer's context all read it from here. Every read is scoped by
 * the player's own principal, world and conversation (a broadcast writes only into each player's own conversation).
 */
/** The upload route's body: one WAV as base64 (the limit of the audio, with the envelope). */
export const BROADCAST_UPLOAD_BODY_LIMIT = 2_800_000;
export interface BroadcastScope {
  principalId: string;
  worldId: string;
  conversationId: string;
}

export interface BroadcastHistoryRow {
  seq: number;
  id: string;
  body: string;
  created_at: number;
  ordinal: number;
  media_id: string | null;
  duration_ms: number | null;
}
/** The broadcast messages of one conversation older than `before`, newest first (at most 51, like history's own page). */
export function broadcastHistoryRows(
  store: Pick<BusinessStore, 'all' | 'get'>,
  scope: BroadcastScope,
  before: number | null,
): BroadcastHistoryRow[] {
  if (!webBroadcastInstalled(store)) return [];
  return store.all<BroadcastHistoryRow>(
    `SELECT m.seq,m.id,m.body,m.created_at,b.ordinal,m.media_id,c.duration_ms
    FROM web_broadcast_messages b JOIN messages m ON m.id=b.message_id
    LEFT JOIN web_broadcast_characters c ON c.broadcast_id=b.broadcast_id AND c.character_id=b.character_id AND b.kind='voice'
    WHERE b.principal_id=? AND b.world_id=? AND b.conversation_id=? AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id
      AND m.seq<? ORDER BY m.seq DESC LIMIT 51`,
    scope.principalId,
    scope.worldId,
    scope.conversationId,
    before ?? Number.MAX_SAFE_INTEGER,
  );
}

/** The ids (oldest first) and sequence numbers of the broadcast messages the writer may read as the character's own, before an input. */
export function broadcastContextMessages(
  store: Pick<BusinessStore, 'all' | 'get'>,
  scope: BroadcastScope & { characterId: string },
  beforeSeq: number,
): { id: string; seq: number }[] {
  if (!webBroadcastInstalled(store)) return [];
  return store.all<{ id: string; seq: number }>(
    `SELECT m.id,m.seq FROM web_broadcast_messages b JOIN messages m ON m.id=b.message_id
    WHERE b.principal_id=? AND b.world_id=? AND b.conversation_id=? AND b.character_id=? AND m.author_kind='character'
      AND m.author_id=b.character_id AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id AND m.seq<?
    ORDER BY m.seq`,
    scope.principalId,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
    beforeSeq,
  );
}

/** Whether a message is a broadcast message of this player's own conversation (the publisher's source check). */
export function isBroadcastMessage(
  store: Pick<BusinessStore, 'get'>,
  scope: BroadcastScope & { characterId: string },
  messageId: string,
) {
  return (
    webBroadcastInstalled(store) &&
    !!store.get(
      `SELECT 1 FROM web_broadcast_messages WHERE message_id=? AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=?`,
      messageId,
      scope.principalId,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    )
  );
}

/** The clip of a voice message the player owns, or null when the message is not a broadcast voice message. */
export function broadcastAudio(
  store: Pick<BusinessStore, 'get'>,
  scope: BroadcastScope,
  messageId: string,
  mediaId: string,
): Buffer | null {
  if (!webBroadcastInstalled(store)) return null;
  const row = store.get<{ audio: Uint8Array | null; sha256: string | null }>(
    `SELECT c.audio,c.sha256 FROM web_broadcast_messages b JOIN messages m ON m.id=b.message_id
    JOIN web_broadcast_characters c ON c.broadcast_id=b.broadcast_id AND c.character_id=b.character_id
    WHERE b.message_id=? AND b.principal_id=? AND b.world_id=? AND b.conversation_id=? AND b.kind='voice' AND m.media_id=?
      AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id`,
    messageId,
    scope.principalId,
    scope.worldId,
    scope.conversationId,
    mediaId,
  );
  if (!row?.audio || !row.sha256) return null;
  const bytes = Buffer.from(row.audio);
  return createHash('sha256').update(bytes).digest('hex') === row.sha256 ? bytes : null;
}
