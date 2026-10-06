import { createHash } from 'node:crypto';
import type {
  CharacterScope,
  DialogueCandidate,
  MessageDTO,
  TextGenerationRequest,
} from '../../../packages/contracts/index.ts';
import { DIALOGUE } from '../../../packages/domain/dialogue.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { protocolFingerprint } from './accepted-text-protocol.ts';
import { textPromptHash } from './accepted-text-prompt.ts';
import { recallMemories } from '../memory/memory.ts';
import { memoryVersion, recallCorrections } from '../memory/memory-review.ts';
import { playerContextKey, playerIntroduction } from '../conversation/player-profile.ts';
import { relationshipContext, relationshipVersion } from '../conversation/relationships.ts';
import { projectedSceneStyle, sceneRevision, sceneState } from '../conversation/scenes.ts';
import { userStore } from '../platform/store-boundary.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { readInputSnapshot } from './web-input-snapshot.ts';
import { requireWebContent } from '../admission/web-retention.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
interface MessageRow {
  id: string;
  world_id: string;
  conversation_id: string;
  author_kind: 'player' | 'character';
  author_id: string;
  body: string;
  created_at: number;
  delivery: 'text' | 'voice';
  voice_fallback: number;
  media_id: string | null;
  proactive: number;
  seq: number;
}
interface RequestRow {
  operation_id: string;
  principal_id: string;
  player_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  request_json: string;
  request_digest: string;
  protocol_digest: string;
  prompt_digest: string;
  memory_version: number;
  player_context_key: string;
  relationship_version: number;
  scene_revision: number;
  voice_version: string;
  frozen_at: number;
}
function dto(row: MessageRow): MessageDTO {
  return {
    id: row.id,
    worldId: row.world_id,
    conversationId: row.conversation_id,
    authorKind: row.author_kind,
    authorId: row.author_id,
    text: row.body,
    createdAt: row.created_at,
    delivery: row.delivery,
    voiceFallback: !!row.voice_fallback,
    mediaId: row.media_id,
    proactive: !!row.proactive,
  };
}

/** Caller owns the first text-claim transaction. Never scans unproven messages as context. */
export function freezeWebV7Request(store: WebStore, operationId: string, now: number) {
  ensure(!store.get('SELECT 1 FROM web_v7_requests WHERE operation_id=?', operationId), 'WEB_V7_REQUEST_EXISTS');
  const operation = store.get<{
    id: string;
    principal_id: string;
    world_id: string;
    conversation_id: string;
    character_id: string;
    input_message_id: string;
  }>('SELECT * FROM web_operations WHERE id=?', operationId);
  ensure(operation, 'WEB_OPERATION_NOT_FOUND');
  const input = readInputSnapshot(store, {
    operation_id: operation.id,
    principal_id: operation.principal_id,
    world_id: operation.world_id,
    conversation_id: operation.conversation_id,
    character_id: operation.character_id,
    input_message_id: operation.input_message_id,
  });
  const scope: CharacterScope = {
    playerId: input.player_id,
    worldId: input.world_id,
    conversationId: input.conversation_id,
    characterId: input.character_id,
  };
  const prior = store.all<{ operation_id: string; input_message_id: string; job_id: string }>(
    `SELECT p.operation_id,p.input_message_id,p.job_id
    FROM web_publications p JOIN messages m ON m.id=p.input_message_id
    WHERE p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?
      AND p.character_id=? AND m.seq<? ORDER BY m.seq`,
    operation.principal_id,
    input.player_id,
    input.world_id,
    input.conversation_id,
    input.character_id,
    input.input_seq,
  );
  const allowed = new Set<string>([input.input_message_id]);
  const orderedIds: string[] = [];
  const priorJobs = new Set(prior.map((row) => row.job_id));
  for (const row of prior) {
    allowed.add(row.input_message_id);
    orderedIds.push(row.input_message_id);
    for (const item of store.all<{ message_id: string }>(
      `SELECT message_id FROM web_publication_items
      WHERE operation_id=? AND origin='narrative' ORDER BY ordinal`,
      row.operation_id,
    )) {
      allowed.add(item.message_id);
      orderedIds.push(item.message_id);
    }
  }
  orderedIds.push(input.input_message_id);
  // Reject alien memory before v7 ranking/limit; post-filtering would change which topics were selected.
  const episodes = store.all<{ job_id: string; evidence_ids_json: string }>(
    `SELECT job_id,evidence_ids_json FROM memory_episodes WHERE world_id=? AND conversation_id=? AND character_id=?`,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
  );
  for (const episode of episodes) {
    ensure(priorJobs.has(episode.job_id), 'WEB_V7_MEMORY_SOURCE_UNTRUSTED');
    let ids: unknown;
    try {
      ids = JSON.parse(episode.evidence_ids_json);
    } catch {
      ids = null;
    }
    ensure(
      Array.isArray(ids) && ids.every((id) => typeof id === 'string' && allowed.has(id)),
      'WEB_V7_MEMORY_SOURCE_UNTRUSTED',
    );
  }
  ensure(
    !store.get(
      `SELECT 1 FROM memory_topics t WHERE t.world_id=? AND t.conversation_id=?
    AND t.character_id=? AND NOT EXISTS (SELECT 1 FROM memory_episodes e
      WHERE e.world_id=t.world_id AND e.conversation_id=t.conversation_id
        AND e.character_id=t.character_id AND e.topic_key=t.topic_key) LIMIT 1`,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    ),
    'WEB_V7_MEMORY_SOURCE_UNTRUSTED',
  );
  ensure(
    !store.get(
      `SELECT 1 FROM memory_episode_sources WHERE world_id=? AND conversation_id=?
    AND character_id=? LIMIT 1`,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    ),
    'WEB_V7_EXTERNAL_EVIDENCE_UNSUPPORTED',
  );
  for (const row of store.all<{ evidence_ids_json: string }>(
    `SELECT evidence_ids_json FROM memory_corrections
    WHERE world_id=? AND conversation_id=? AND character_id=?`,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
  )) {
    let ids: unknown;
    try {
      ids = JSON.parse(row.evidence_ids_json);
    } catch {
      ids = null;
    }
    ensure(
      Array.isArray(ids) && ids.every((id) => typeof id === 'string' && allowed.has(id)),
      'WEB_V7_CORRECTION_SOURCE_UNTRUSTED',
    );
  }
  ensure(
    store
      .all<{ job_id: string }>(
        `SELECT job_id FROM relationship_events WHERE world_id=?
    AND conversation_id=? AND character_id=?`,
        scope.worldId,
        scope.conversationId,
        scope.characterId,
      )
      .every((row) => priorJobs.has(row.job_id)),
    'WEB_V7_RELATIONSHIP_SOURCE_UNTRUSTED',
  );
  ensure(
    store
      .all<{ job_id: string }>(
        `SELECT job_id FROM scene_events WHERE world_id=?
    AND conversation_id=? AND character_id=? AND source='dialogue'`,
        scope.worldId,
        scope.conversationId,
        scope.characterId,
      )
      .every((row) => priorJobs.has(row.job_id)),
    'WEB_V7_SCENE_SOURCE_UNTRUSTED',
  );
  const ids = orderedIds.slice(-24),
    source = store.all<MessageRow>(
      `SELECT * FROM messages
    WHERE world_id=? AND conversation_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      scope.worldId,
      scope.conversationId,
      ...ids,
    );
  const byId = new Map(source.map((row) => [row.id, row]));
  const selected = ids.map((id) => byId.get(id));
  ensure(
    selected.some((row) => row?.id === input.input_message_id) &&
      selected.every((row) => row && (row.id === input.input_message_id || allowed.has(row.id))),
    'WEB_V7_CONTEXT_SOURCE_INVALID',
  );
  const template = JSON.parse(input.template_json) as TextGenerationRequest['character'];
  ensure(
    template &&
      template.id === scope.characterId &&
      template.version === input.template_version &&
      template.fictional === true &&
      typeof template.persona === 'string' &&
      template.schedule !== undefined,
    'WEB_V7_TEMPLATE_INVALID',
  );
  const relationship = store.get<{ relationship: TextGenerationRequest['relationship'] }>(
    'SELECT relationship FROM world_characters WHERE world_id=? AND character_id=?',
    scope.worldId,
    scope.characterId,
  )?.relationship;
  ensure(relationship, 'WEB_CHARACTER_UNAVAILABLE');
  const access = store.get<{ kind: 'guest' | 'account' | 'invite'; active: number | null }>(
    `SELECT p.kind,a.active FROM web_principals p LEFT JOIN web_accounts a ON a.principal_id=p.id
      WHERE p.id=? AND p.player_id=? AND p.world_id=?`,
    operation.principal_id,
    scope.playerId,
    scope.worldId,
  );
  ensure(
    access &&
      (access.kind === 'guest' ||
        (access.kind === 'account' && access.active === 1) ||
        (access.kind === 'invite' &&
          [111, 112, 113, 114, 115].includes(
            store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
          ) &&
          requireWebContent(store, { now: () => now }, operation.principal_id, scope.worldId))),
    'WEB_V7_MEMORY_ENTITLEMENT_REQUIRED',
  );
  const query = input.input_body;
  const memories = access.kind !== 'guest' ? recallMemories(userStore(store), scope, now, query) : [];
  const corrections =
    access.kind !== 'guest'
      ? recallCorrections(
          userStore(store),
          scope,
          query,
          memories.map((memory) => memory.key),
        )
      : [];
  const relationshipState = relationshipContext(userStore(store), scope, relationship);
  const scene = sceneState(userStore(store), scope, now);
  const shortTermTurns = priorJobs.size
    ? store
        .all<{ job_id: string; at: number }>(
          `SELECT p.job_id,min(m.created_at) at
    FROM web_publications p JOIN web_publication_items i ON i.operation_id=p.operation_id AND i.origin='narrative'
      JOIN messages m ON m.id=i.message_id WHERE p.principal_id=? AND p.player_id=? AND p.world_id=?
      AND p.conversation_id=? AND p.character_id=? AND m.created_at>?
      AND p.job_id IN (${[...priorJobs].map(() => '?').join(',')})
    GROUP BY p.job_id ORDER BY max(m.seq) DESC LIMIT 8`,
          operation.principal_id,
          scope.playerId,
          scope.worldId,
          scope.conversationId,
          scope.characterId,
          now - DIALOGUE.shortMemoryMs,
          ...priorJobs,
        )
        .reverse()
        .map((row) => ({ job_id: row.job_id, at: row.at }))
    : [];
  const introduction = playerIntroduction(userStore(store), scope);
  const request: TextGenerationRequest = {
    jobId: operation.id,
    scope: { worldId: scope.worldId, conversationId: scope.conversationId, characterId: scope.characterId },
    now,
    relationship,
    relationshipContext: relationshipState,
    sceneContext: scene,
    ...(introduction ? { playerIntroduction: introduction } : {}),
    deliveryMode: 'voice',
    requiredMessageIds: [input.input_message_id],
    character: template,
    messages: selected.map((row) => dto(row!)),
    mustClose: false,
    evidence: [],
    memories,
    memoryCorrections: corrections,
    shortTermTurns: shortTermTurns.map((turn) => ({
      id: turn.job_id,
      at: turn.at,
      messages: store.all<{ id: string; text: string; expression: 'neutral' }>(
        `SELECT m.id,m.body text,b.expression
        FROM dialogue_bubbles b JOIN messages m ON m.id=b.message_id
        WHERE b.job_id=? AND b.world_id=? AND b.conversation_id=? ORDER BY b.ordinal`,
        turn.job_id,
        scope.worldId,
        scope.conversationId,
      ),
    })),
  };
  const serialized = JSON.stringify(request),
    requestDigest = digest(serialized),
    protocolDigest = digest(JSON.stringify(protocolFingerprint()));
  const voiceVersion =
    (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113
      ? store.get<{ voice_version: string }>(
          `SELECT voice_version FROM web_provider_voice_bindings
      WHERE character_id=? AND approved=1
        AND source IN ('synthetic_fixture','user_selected')`,
          scope.characterId,
        )?.voice_version
      : `synthetic_test:${scope.characterId}:${input.template_version}`;
  ensure(voiceVersion, 'WEB_PROVIDER_VOICE_UNAPPROVED');
  store.run(
    `INSERT INTO web_v7_requests VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    operation.id,
    operation.principal_id,
    scope.playerId,
    scope.worldId,
    scope.conversationId,
    scope.characterId,
    input.input_message_id,
    serialized,
    requestDigest,
    protocolDigest,
    textPromptHash(),
    memoryVersion(userStore(store), scope),
    playerContextKey(userStore(store), scope),
    relationshipVersion(userStore(store), scope),
    sceneRevision(userStore(store), scope),
    voiceVersion,
    now,
  );
  return requestDigest;
}

export function readWebV7Request(
  store: WebStore,
  operationId: string,
): { request: TextGenerationRequest; row: RequestRow } {
  const row = store.get<RequestRow>('SELECT * FROM web_v7_requests WHERE operation_id=?', operationId);
  ensure(
    row &&
      digest(row.request_json) === row.request_digest &&
      digest(JSON.stringify(protocolFingerprint())) === row.protocol_digest &&
      textPromptHash() === row.prompt_digest,
    'WEB_V7_REQUEST_INVALID',
  );
  const request = JSON.parse(row.request_json) as TextGenerationRequest;
  ensure(
    request.jobId === operationId &&
      request.scope.worldId === row.world_id &&
      request.scope.conversationId === row.conversation_id &&
      request.scope.characterId === row.character_id &&
      request.requiredMessageIds.length === 1 &&
      request.requiredMessageIds[0] === row.input_message_id,
    'WEB_V7_REQUEST_INVALID',
  );
  return { request, row };
}

/** Reuse v7 scene consent and later-input checks without creating an old leased job. */
export function checkWebV7SceneAtDispatch(store: WebStore, operationId: string, now: number) {
  const { request, row } = readWebV7Request(store, operationId);
  const stored = store.get<{ candidate_json: string; candidate_digest: string; request_digest: string }>(
    (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1) >= 113
      ? 'SELECT * FROM web_provider_candidates WHERE operation_id=?'
      : 'SELECT * FROM web_v7_candidates WHERE operation_id=?',
    operationId,
  );
  ensure(
    stored && stored.request_digest === row.request_digest && digest(stored.candidate_json) === stored.candidate_digest,
    'WEB_V7_CANDIDATE_INVALID',
  );
  const snapshot = readInputSnapshot(store, {
    operation_id: operationId,
    principal_id: row.principal_id,
    world_id: row.world_id,
    conversation_id: row.conversation_id,
    character_id: row.character_id,
    input_message_id: row.input_message_id,
  });
  ensure(Number.isSafeInteger(snapshot.input_seq) && snapshot.input_seq > 0, 'WEB_INPUT_SNAPSHOT_SOURCE_INVALID');
  const scope: CharacterScope = {
    playerId: row.player_id,
    worldId: row.world_id,
    conversationId: row.conversation_id,
    characterId: row.character_id,
  };
  ensure(sceneRevision(userStore(store), scope) === row.scene_revision, 'SCENE_CONTEXT_CHANGED');
  return projectedSceneStyle(
    userStore(store),
    scope,
    operationId,
    JSON.parse(stored.candidate_json) as DialogueCandidate,
    request.sceneContext,
    request.messages,
    request.relationship,
    now,
    snapshot.input_seq,
  );
}
