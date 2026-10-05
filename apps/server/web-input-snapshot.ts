import { webCharacterDeleted } from './web-character-deleted.ts';
import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { WebRuntimeStore as WebStore } from './web-store-contract.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface Source {
  operation_id: string;
  principal_id: string;
  player_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  input_seq: number;
  input_body: string;
  template_version: number;
  template_json: string;
  access_revision: number;
}
export interface WebInputSnapshot extends Source {
  capability: 'input-snapshot-only';
  format_version: 1;
  input_digest: string;
  template_digest: string;
  frozen_at: number;
  snapshot_digest: string;
}
export type SnapshotScope = Pick<
  Source,
  'operation_id' | 'principal_id' | 'world_id' | 'conversation_id' | 'character_id' | 'input_message_id'
>;

/** Caller holds the first text-claim transaction. This is not a v7 generation request. */
export function freezeInputSnapshot(store: WebStore, operationId: string, now: number) {
  ensure(
    !store.get('SELECT 1 FROM web_input_snapshots WHERE operation_id=?', operationId),
    'WEB_INPUT_SNAPSHOT_EXISTS',
  );
  const row = store.get<Source>(
    `SELECT o.id operation_id,o.principal_id,p.player_id,o.world_id,o.conversation_id,
      o.character_id,o.input_message_id,m.seq input_seq,m.body input_body,t.version template_version,
      t.config_json template_json,p.revision access_revision
    FROM web_operations o JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
      JOIN worlds w ON w.id=o.world_id AND w.owner_id=p.player_id
      JOIN conversations c ON c.world_id=o.world_id AND c.id=o.conversation_id
        AND c.kind='private' AND c.private_character_id=o.character_id
      JOIN participants cp ON cp.world_id=o.world_id AND cp.conversation_id=o.conversation_id
        AND cp.character_id=o.character_id
      JOIN messages m ON m.id=o.input_message_id AND m.world_id=o.world_id
        AND m.conversation_id=o.conversation_id AND m.author_kind='player' AND m.author_id=p.player_id
      JOIN world_characters wc ON wc.world_id=o.world_id AND wc.character_id=o.character_id
      JOIN character_templates t ON t.id=o.character_id
    WHERE o.id=? AND o.status='queued' AND o.quota_state='reserved'`,
    operationId,
  );
  ensure(row && row.input_body.length > 0, 'WEB_INPUT_SNAPSHOT_SOURCE_INVALID');
  const inputDigest = digest(JSON.stringify([row.input_message_id, row.input_seq, row.input_body]));
  const templateDigest = digest(row.template_json);
  const snapshotDigest = digest(
    JSON.stringify([
      1,
      row.operation_id,
      row.principal_id,
      row.player_id,
      row.world_id,
      row.conversation_id,
      row.character_id,
      row.input_message_id,
      row.input_seq,
      row.input_body,
      inputDigest,
      row.template_version,
      row.template_json,
      templateDigest,
      row.access_revision,
      now,
    ]),
  );
  store.run(
    `INSERT INTO web_input_snapshots VALUES (?,'input-snapshot-only',1,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    row.operation_id,
    row.principal_id,
    row.player_id,
    row.world_id,
    row.conversation_id,
    row.character_id,
    row.input_message_id,
    row.input_seq,
    row.input_body,
    inputDigest,
    row.template_version,
    row.template_json,
    templateDigest,
    row.access_revision,
    now,
    snapshotDigest,
  );
  return inputDigest;
}

export function readInputSnapshot(store: WebStore, scope: SnapshotScope): WebInputSnapshot {
  const row = store.get<WebInputSnapshot>(
    `SELECT s.* FROM web_input_snapshots s JOIN web_operations o
    ON o.id=s.operation_id AND o.principal_id=s.principal_id AND o.world_id=s.world_id
      AND o.conversation_id=s.conversation_id AND o.character_id=s.character_id
      AND o.input_message_id=s.input_message_id
    JOIN web_principals p ON p.id=s.principal_id AND p.player_id=s.player_id AND p.world_id=s.world_id
    JOIN worlds w ON w.id=s.world_id AND w.owner_id=p.player_id
    JOIN conversations c ON c.world_id=s.world_id AND c.id=s.conversation_id
      AND c.kind='private' AND c.private_character_id=s.character_id
    WHERE s.operation_id=? AND s.principal_id=? AND s.world_id=? AND s.conversation_id=?
      AND s.character_id=? AND s.input_message_id=?`,
    scope.operation_id,
    scope.principal_id,
    scope.world_id,
    scope.conversation_id,
    scope.character_id,
    scope.input_message_id,
  );
  ensure(row && row.capability === 'input-snapshot-only' && row.format_version === 1, 'WEB_INPUT_SNAPSHOT_NOT_FOUND');
  return row;
}

/** Live dispatch/candidate guard; never rewrites the frozen material. */
export function requireCurrentInputSnapshot(store: WebStore, scope: SnapshotScope): WebInputSnapshot {
  ensure(!webCharacterDeleted(store, scope.character_id), 'WEB_INPUT_SNAPSHOT_STALE');
  const snapshot = readInputSnapshot(store, scope);
  const current = store.get<{ seq: number; body: string; version: number; config_json: string }>(
    `SELECT m.seq,m.body,t.version,t.config_json FROM messages m
      JOIN web_principals p ON p.id=? AND p.world_id=?
      JOIN worlds w ON w.id=? AND w.owner_id=p.player_id
      JOIN conversations c ON c.world_id=? AND c.id=? AND c.kind='private' AND c.private_character_id=?
      JOIN character_templates t ON t.id=?
      JOIN world_characters wc ON wc.world_id=? AND wc.character_id=?
      WHERE m.id=? AND m.world_id=? AND m.conversation_id=? AND m.author_kind='player'
        AND m.author_id=p.player_id`,
    scope.principal_id,
    scope.world_id,
    scope.world_id,
    scope.world_id,
    scope.conversation_id,
    scope.character_id,
    scope.character_id,
    scope.world_id,
    scope.character_id,
    scope.input_message_id,
    scope.world_id,
    scope.conversation_id,
  );
  ensure(
    current &&
      snapshot.input_seq === current.seq &&
      snapshot.input_body === current.body &&
      snapshot.input_digest === digest(JSON.stringify([scope.input_message_id, current.seq, current.body])) &&
      snapshot.template_version === current.version &&
      snapshot.template_json === current.config_json &&
      snapshot.template_digest === digest(current.config_json),
    'WEB_INPUT_SNAPSHOT_STALE',
  );
  return snapshot;
}
