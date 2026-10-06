import { createHash, randomUUID } from 'node:crypto';
import type {
  CharacterScope,
  DialogueCandidate,
  MessageDTO,
  RelationshipPreset,
} from '../../../packages/contracts/index.ts';
import type {
  EndSceneReceipt,
  SceneDescription,
  SceneEvent,
  ScenePage,
  SceneState,
} from '../../../packages/contracts/scenes.ts';
import {
  REMOTE_SCENE,
  SCENE_TTL,
  changedScene,
  sceneConsentIds,
  sceneDeliveryStyle,
  validateSceneEvidence,
} from '../../../packages/domain/scenes.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { identifier, keys, record } from '../characters/template-validation.ts';
import type { UserStore as Store } from '../platform/store-boundary.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const publicScope = (scope: CharacterScope) => ({
  worldId: scope.worldId,
  conversationId: scope.conversationId,
  characterId: scope.characterId,
});
interface StateRow {
  revision: number;
  scene_json: string;
  updated_at: number;
  expires_at: number | null;
}
function isPrivate(store: Store, scope: CharacterScope) {
  return !!store.get(
    scope,
    "SELECT 1 FROM conversations WHERE world_id=? AND id=? AND kind='private' AND private_character_id=?",
    ...params(scope),
  );
}
function authorize(store: Store, scope: CharacterScope) {
  ensure(
    store.get(scope, 'SELECT 1 FROM worlds WHERE id=? AND owner_id=?', scope.worldId, scope.playerId) &&
      isPrivate(store, scope),
    'NOT_FOUND',
  );
}
export function sceneRevision(store: Store, scope: CharacterScope) {
  if (!isPrivate(store, scope)) return 0;
  return (
    store.get<{ revision: number }>(scope, `SELECT revision FROM scene_states WHERE ${where}`, ...params(scope))
      ?.revision ?? 0
  );
}
export function sceneState(store: Store, scope: CharacterScope, now: number): SceneState {
  authorize(store, scope);
  const row = store.get<StateRow>(
    scope,
    `SELECT revision,scene_json,updated_at,expires_at FROM scene_states WHERE ${where}`,
    ...params(scope),
  );
  const lastChange = row
    ? (store.get<{ source: SceneState['lastChange'] }>(
        scope,
        `SELECT source FROM scene_events WHERE ${where} AND revision=?`,
        ...params(scope),
        row.revision,
      )?.source ?? null)
    : null;
  return row
    ? {
        lastChange,
        ...JSON.parse(row.scene_json),
        revision: row.revision,
        updatedAt: row.updated_at,
        expiresAt: row.expires_at,
        needsConfirmation: row.expires_at !== null && now >= row.expires_at,
      }
    : { ...REMOTE_SCENE, revision: 0, updatedAt: null, expiresAt: null, needsConfirmation: false, lastChange: null };
}
export function freezeSceneContext(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  messages: MessageDTO[],
  now: number,
): SceneState | undefined {
  if (!isPrivate(store, scope)) return undefined;
  authorize(store, scope);
  const old = store.get<{ context_json: string }>(
    scope,
    `SELECT context_json FROM scene_job_contexts WHERE ${where} AND job_id=?`,
    ...params(scope),
    jobId,
  );
  if (old) return JSON.parse(old.context_json);
  const playerIds = messages
    .filter((item) => item.authorKind === 'player' && item.authorId === scope.playerId)
    .map((item) => item.id);
  const seq = playerIds.length
    ? (store.get<{ seq: number | null }>(
        scope,
        `SELECT max(seq) seq FROM messages WHERE world_id=? AND conversation_id=?
    AND author_kind='player' AND author_id=? AND id IN (${playerIds.map(() => '?').join(',')})`,
        scope.worldId,
        scope.conversationId,
        scope.playerId,
        ...playerIds,
      )!.seq ?? 0)
    : 0;
  const state = sceneState(store, scope, now);
  store.run(
    scope,
    'INSERT INTO scene_job_contexts VALUES (?,?,?,?,?,?)',
    ...params(scope),
    jobId,
    JSON.stringify(state),
    seq,
  );
  return state;
}
/** Read only the private scene and exact messages already supplied to review, never re-run recall. */
export function frozenSceneInputs(store: Store, scope: CharacterScope, jobId: string) {
  if (!isPrivate(store, scope)) return { sceneContext: undefined, messages: [] as MessageDTO[] };
  const row = store.get<{ context_json: string; messages_json: string | null }>(
    scope,
    `SELECT s.context_json,r.messages_json
    FROM scene_job_contexts s LEFT JOIN relationship_job_contexts r ON r.world_id=s.world_id
      AND r.conversation_id=s.conversation_id AND r.character_id=s.character_id AND r.job_id=s.job_id
    WHERE s.world_id=? AND s.conversation_id=? AND s.character_id=? AND s.job_id=?`,
    ...params(scope),
    jobId,
  );
  if (!row) {
    ensure(
      !store.get(scope, `SELECT 1 FROM relationship_job_contexts WHERE ${where} AND job_id=?`, ...params(scope), jobId),
      'SCENE_CONTEXT_MISSING',
    );
    return undefined;
  }
  ensure(row.messages_json !== null, 'SCENE_CONTEXT_MISSING');
  return {
    sceneContext: JSON.parse(row.context_json) as SceneState,
    messages: JSON.parse(row.messages_json) as MessageDTO[],
  };
}
/** Rechecked before paid speech and every bubble; newly arrived input may withdraw an ongoing scene. */
export function projectedSceneStyle(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  candidate: DialogueCandidate,
  context: SceneState | undefined,
  messages: MessageDTO[],
  relationship: RelationshipPreset,
  now: number,
  frozenInputSeq?: number,
) {
  const update = changedScene(candidate.sceneUpdate, context);
  validateSceneEvidence(update, context, messages, candidate, scope.playerId);
  if (!context) return 'conversational' as const;
  const current = store.get<{ revision: number; expires_at: number | null }>(
    scope,
    `SELECT revision,expires_at FROM scene_states WHERE ${where}`,
    ...params(scope),
  );
  // Expiry after review invalidates the candidate, not just its audio style. Own published updates use their new deadline.
  ensure(
    !current ||
      current.expires_at === null ||
      current.expires_at > now ||
      (context.needsConfirmation && current.revision === context.revision),
    'SCENE_CONTEXT_CHANGED',
  );
  if (update && (['planned', 'together'].includes(update.scene.kind) || update.scene.speaking === 'quiet')) {
    const cutoff =
      store.get<{ control_input_seq: number }>(
        scope,
        `SELECT control_input_seq FROM scene_states WHERE ${where}`,
        ...params(scope),
      )?.control_input_seq ?? 0;
    ensure(
      update.evidence.some(
        (proof) =>
          sceneConsentIds(candidate, update.scene.kind).includes(proof.messageId) &&
          store.get(
            scope,
            "SELECT 1 FROM messages WHERE world_id=? AND conversation_id=? AND id=? AND author_kind='player' AND author_id=? AND seq>?",
            scope.worldId,
            scope.conversationId,
            proof.messageId,
            scope.playerId,
            cutoff,
          ),
      ),
      'SCENE_CONSENT_REQUIRED',
    );
  }
  const effective = context.needsConfirmation ? REMOTE_SCENE : context;
  const projected = update?.scene ?? effective;
  const sensitive = !!update || effective.kind === 'together' || effective.speaking === 'quiet';
  if (sensitive) {
    const lastInputSeq =
      frozenInputSeq ??
      store.get<{ last_input_seq: number }>(
        scope,
        `SELECT last_input_seq FROM scene_job_contexts WHERE ${where} AND job_id=?`,
        ...params(scope),
        jobId,
      )?.last_input_seq;
    ensure(
      lastInputSeq !== undefined && Number.isSafeInteger(lastInputSeq) && lastInputSeq >= 0,
      'SCENE_CONTEXT_MISSING',
    );
    ensure(
      !store.get(
        scope,
        `SELECT 1 FROM messages WHERE world_id=? AND conversation_id=? AND author_kind='player' AND author_id=? AND seq>? LIMIT 1`,
        scope.worldId,
        scope.conversationId,
        scope.playerId,
        lastInputSeq,
      ),
      'SCENE_INPUT_CHANGED',
    );
  }
  return sceneDeliveryStyle(projected, relationship);
}
function deadline(scene: SceneDescription, now: number) {
  const ttl = SCENE_TTL[scene.kind] ?? (scene.speaking === 'quiet' ? 30 * 60_000 : null);
  return ttl === null ? null : now + ttl;
}
function save(store: Store, scope: CharacterScope, scene: SceneDescription, now: number) {
  const revision = sceneRevision(store, scope) + 1;
  store.run(
    scope,
    `INSERT INTO scene_states (world_id,conversation_id,character_id,revision,scene_json,updated_at,expires_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(world_id,conversation_id,character_id)
    DO UPDATE SET revision=excluded.revision,scene_json=excluded.scene_json,updated_at=excluded.updated_at,expires_at=excluded.expires_at`,
    ...params(scope),
    revision,
    JSON.stringify(scene),
    now,
    deadline(scene, now),
  );
  return revision;
}
/** A gesture becomes current only when the exact accepting bubble was actually published, including partial turns. */
export function recordSceneBubble(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  candidate: DialogueCandidate,
  messages: MessageDTO[],
  now: number,
) {
  const update = candidate.sceneUpdate && changedScene(candidate.sceneUpdate, sceneState(store, scope, now));
  if (!update) return;
  authorize(store, scope);
  if (store.get(scope, `SELECT 1 FROM scene_events WHERE ${where} AND job_id=?`, ...params(scope), jobId)) return;
  const response = messages.find((message) => message.text.includes(update.responseQuote));
  if (!response) return;
  const revision = save(store, scope, update.scene, now);
  store.run(
    scope,
    'INSERT INTO scene_events VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    randomUUID(),
    ...params(scope),
    revision,
    JSON.stringify(update.scene),
    now,
    'dialogue',
    JSON.stringify(update.evidence),
    JSON.stringify({ messageId: response.id, quote: update.responseQuote }),
    jobId,
  );
  // This job's own publication advances the state; external controls still invalidate its remaining tail.
  store.run(scope, `UPDATE jobs SET scene_revision=? WHERE ${where} AND id=?`, revision, ...params(scope), jobId);
}
export function touchScene(store: Store, scope: CharacterScope, jobId: string, now: number) {
  if (!isPrivate(store, scope)) return;
  const current = sceneState(store, scope, now);
  const frozen = store.get<{ context_json: string }>(
    scope,
    `SELECT context_json FROM scene_job_contexts WHERE ${where} AND job_id=?`,
    ...params(scope),
    jobId,
  );
  const started: SceneState | null = frozen ? JSON.parse(frozen.context_json) : null;
  const published = store.get(scope, `SELECT 1 FROM scene_events WHERE ${where} AND job_id=?`, ...params(scope), jobId);
  if (current.kind === 'together' && (published || (started?.kind === 'together' && !started.needsConfirmation))) {
    // Idle expiry is renewed only by a completed reply, not message spam or a future appointment.
    store.run(scope, `UPDATE scene_states SET expires_at=? WHERE ${where}`, now + SCENE_TTL.together, ...params(scope));
  }
}
export function readScene(store: Store, scope: CharacterScope, now: number): ScenePage {
  authorize(store, scope);
  const rows = store.all<{
    id: string;
    revision: number;
    scene_json: string;
    recorded_at: number;
    source: SceneEvent['source'];
    evidence_json: string;
    response_json: string | null;
  }>(
    scope,
    `SELECT id,revision,scene_json,recorded_at,source,evidence_json,response_json
    FROM scene_events WHERE ${where} ORDER BY revision DESC LIMIT 20`,
    ...params(scope),
  );
  return {
    scope: publicScope(scope),
    state: sceneState(store, scope, now),
    recentEvents: rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      scene: JSON.parse(row.scene_json),
      at: row.recorded_at,
      source: row.source,
      evidence: JSON.parse(row.evidence_json),
      response: row.response_json ? JSON.parse(row.response_json) : null,
    })),
  };
}
export function endScene(store: Store, scope: CharacterScope, now: number, input: unknown): EndSceneReceipt {
  record(input);
  keys(input, ['requestId', 'expectedRevision']);
  identifier(input.requestId);
  ensure(Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) >= 0, 'INVALID_SCENE');
  const requestHash = createHash('sha256')
    .update(JSON.stringify([scope.conversationId, scope.characterId, input.expectedRevision]))
    .digest('hex');
  return store.transaction(scope, () => {
    authorize(store, scope);
    const existing = store.get<{ conversation_id: string; character_id: string; request_hash: string }>(
      scope,
      'SELECT conversation_id,character_id,request_hash FROM scene_end_requests WHERE world_id=? AND request_id=?',
      scope.worldId,
      input.requestId as string,
    );
    if (existing) {
      ensure(
        existing.conversation_id === scope.conversationId &&
          existing.character_id === scope.characterId &&
          existing.request_hash === requestHash,
        'IDEMPOTENCY_CONFLICT',
      );
      const previous = store.get<{ revision: number; recorded_at: number }>(
        scope,
        `SELECT revision,recorded_at FROM scene_end_requests WHERE ${where} AND request_id=?`,
        ...params(scope),
        input.requestId as string,
      )!;
      return { scope: publicScope(scope), revision: previous.revision, at: previous.recorded_at, duplicate: true };
    }
    ensure(sceneRevision(store, scope) === input.expectedRevision, 'SCENE_REVISION_CONFLICT');
    const revision = save(store, scope, { ...REMOTE_SCENE }, now);
    store.run(
      scope,
      `UPDATE scene_states SET control_input_seq=COALESCE((SELECT max(seq) FROM messages WHERE world_id=? AND conversation_id=? AND author_kind='player' AND author_id=?),0) WHERE ${where}`,
      scope.worldId,
      scope.conversationId,
      scope.playerId,
      ...params(scope),
    );
    store.run(
      scope,
      'INSERT INTO scene_end_requests VALUES (?,?,?,?,?,?,?)',
      ...params(scope),
      input.requestId as string,
      requestHash,
      revision,
      now,
    );
    store.run(
      scope,
      'INSERT INTO scene_events VALUES (?,?,?,?,?,?,?,?,?,?,NULL)',
      randomUUID(),
      ...params(scope),
      revision,
      JSON.stringify(REMOTE_SCENE),
      now,
      'player_control',
      '[]',
      null,
    );
    return { scope: publicScope(scope), revision, at: now, duplicate: false };
  });
}
