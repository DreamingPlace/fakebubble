import type { CharacterScope, ContextEvidence } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
export function groupEvidenceSource(evidence: ContextEvidence): { sourceConversationId: string; sourceMessageId: string } | null {
  if (evidence.kind !== 'observed_group_message' && evidence.kind !== 'observed_moment_message') return null;
  const prefix = evidence.kind === 'observed_group_message' ? 'group' : 'moment';
  try {
    const value: unknown = JSON.parse(evidence.text);
    if (!value || typeof value !== 'object' || !('sourceConversationId' in value) || !('sourceMessageId' in value) ||
      typeof value.sourceConversationId !== 'string' || typeof value.sourceMessageId !== 'string' || evidence.id !== `${prefix}:${value.sourceMessageId}`) return null;
    return { sourceConversationId: value.sourceConversationId, sourceMessageId: value.sourceMessageId };
  } catch { return null; }
}
export function freezeContextEvidence(store: Store, scope: CharacterScope, jobId: string, candidates: ContextEvidence[]): ContextEvidence[] {
  const existing = store.get<{ evidence_json: string }>(`SELECT evidence_json FROM job_evidence_snapshots WHERE ${where} AND job_id=?`, ...params(scope), jobId);
  if (existing) return JSON.parse(existing.evidence_json);
  const selected = [...new Map(candidates.map(item => [item.id, item])).values()].slice(0, 12);
  for (const evidence of selected) {
    const source = groupEvidenceSource(evidence); ensure(source, 'INVALID_SOURCE_EVIDENCE');
    const table = evidence.kind === 'observed_moment_message' ? 'moment_threads' : 'group_conversations';
    ensure(store.get(`SELECT 1 FROM ${table} WHERE world_id=? AND conversation_id=?`, scope.worldId, source.sourceConversationId), 'INVALID_SOURCE_EVIDENCE');
    ensure(store.get(`SELECT 1 FROM group_message_knowledge WHERE world_id=? AND conversation_id=? AND character_id=? AND message_id=?`,
      scope.worldId, source.sourceConversationId, scope.characterId, source.sourceMessageId), 'INVALID_SOURCE_EVIDENCE');
  }
  store.run('INSERT INTO job_evidence_snapshots VALUES (?,?,?,?,?)', ...params(scope), jobId, JSON.stringify(selected)); return selected;
}
export function validateEpisodeSources(store: Store, scope: CharacterScope, jobId: string, ids: string[]) {
  if (ids.length === 0) return;
  const snapshot = store.get<{ evidence_json: string }>(`SELECT evidence_json FROM job_evidence_snapshots WHERE ${where} AND job_id=?`, ...params(scope), jobId);
  ensure(snapshot, 'INVALID_SOURCE_EVIDENCE'); const evidence: ContextEvidence[] = JSON.parse(snapshot.evidence_json);
  ensure(ids.length <= 8 && new Set(ids).size === ids.length && ids.every(id => evidence.some(item => item.id === id)), 'INVALID_SOURCE_EVIDENCE');
}
export function recordEpisodeSources(store: Store, scope: CharacterScope, jobId: string, topic: string, ids: string[]) {
  validateEpisodeSources(store, scope, jobId, ids);
  if (!ids.length) return;
  store.run('INSERT INTO memory_episode_sources VALUES (?,?,?,?,?,?)', ...params(scope), topic, jobId, JSON.stringify(ids));
}
export function episodeSources(store: Store, scope: CharacterScope, topic: string, jobId: string): ContextEvidence[] {
  const row = store.get<{ evidence_ids_json: string; evidence_json: string }>(`SELECT s.evidence_ids_json,j.evidence_json FROM memory_episode_sources s
    JOIN job_evidence_snapshots j ON j.job_id=s.job_id AND j.world_id=s.world_id AND j.conversation_id=s.conversation_id AND j.character_id=s.character_id
    WHERE s.world_id=? AND s.conversation_id=? AND s.character_id=? AND s.topic_key=? AND s.job_id=?`, ...params(scope), topic, jobId);
  if (!row) return [];
  const ids: string[] = JSON.parse(row.evidence_ids_json); const evidence: ContextEvidence[] = JSON.parse(row.evidence_json);
  return ids.map(id => { const item = evidence.find(item => item.id === id); ensure(item, 'MEMORY_INTEGRITY_ERROR'); return item; });
}
