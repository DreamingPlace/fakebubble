import type { CharacterScope, ContextEvidence } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { UserStore as Store } from '../platform/store-boundary.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
export function validateEpisodeSources(store: Store, scope: CharacterScope, jobId: string, ids: string[]) {
  if (ids.length === 0) return;
  const snapshot = store.get<{ evidence_json: string }>(
    scope,
    `SELECT evidence_json FROM job_evidence_snapshots WHERE ${where} AND job_id=?`,
    ...params(scope),
    jobId,
  );
  ensure(snapshot, 'INVALID_SOURCE_EVIDENCE');
  const evidence: ContextEvidence[] = JSON.parse(snapshot.evidence_json);
  ensure(
    ids.length <= 8 && new Set(ids).size === ids.length && ids.every((id) => evidence.some((item) => item.id === id)),
    'INVALID_SOURCE_EVIDENCE',
  );
}
export function recordEpisodeSources(store: Store, scope: CharacterScope, jobId: string, topic: string, ids: string[]) {
  validateEpisodeSources(store, scope, jobId, ids);
  if (!ids.length) return;
  store.run(
    scope,
    'INSERT INTO memory_episode_sources VALUES (?,?,?,?,?,?)',
    ...params(scope),
    topic,
    jobId,
    JSON.stringify(ids),
  );
}
export function episodeSources(store: Store, scope: CharacterScope, topic: string, jobId: string): ContextEvidence[] {
  const row = store.get<{ evidence_ids_json: string; evidence_json: string }>(
    scope,
    `SELECT s.evidence_ids_json,j.evidence_json FROM memory_episode_sources s
    JOIN job_evidence_snapshots j ON j.job_id=s.job_id AND j.world_id=s.world_id AND j.conversation_id=s.conversation_id AND j.character_id=s.character_id
    WHERE s.world_id=? AND s.conversation_id=? AND s.character_id=? AND s.topic_key=? AND s.job_id=?`,
    ...params(scope),
    topic,
    jobId,
  );
  if (!row) return [];
  const ids: string[] = JSON.parse(row.evidence_ids_json);
  const evidence: ContextEvidence[] = JSON.parse(row.evidence_json);
  return ids.map((id) => {
    const item = evidence.find((item) => item.id === id);
    ensure(item, 'MEMORY_INTEGRITY_ERROR');
    return item;
  });
}
