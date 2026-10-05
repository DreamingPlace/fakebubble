// Accepted v7 baseline from 初v.0.0.0911; kept separate from the deferred v8–v10 experiment.
import type { CharacterScope, TopicMemory } from '../../packages/contracts/index.ts';
import { DIALOGUE, topicKey } from '../../packages/domain/dialogue.ts';
import { episodeSources } from './context-evidence.ts';
import type { BusinessStore as Store } from './store-contract.ts';
const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
interface TopicRow {
  topic_key: string;
  tier: 'short' | 'long';
  player_mentions: number;
  last_seen: number;
}

interface EpisodeRow {
  job_id: string;
  summary: string;
  source_kind: TopicMemory['episodes'][number]['sourceKind'];
  evidence_ids_json: string;
  created_at: number;
}

export function recallMemories(
  store: Store,
  scope: CharacterScope,
  now: number,
  query = '',
  limit = 12,
): TopicMemory[] {
  const topics = store.all<TopicRow>(
    `SELECT * FROM memory_topics WHERE ${where} AND (tier='long' OR active_until>?)
    ORDER BY last_seen DESC,topic_key LIMIT 128`,
    ...params(scope),
    now,
  );
  const words = new Set(
    [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(topicKey(query).slice(0, 4000))]
      .filter((part) => part.isWordLike && part.segment.length > 1)
      .map((part) => part.segment),
  );
  const score = (key: string) => [...words].reduce((sum, word) => sum + (key.includes(word) ? 1 : 0), 0);
  topics.sort((a, b) => score(b.topic_key) - score(a.topic_key) || b.last_seen - a.last_seen);
  return topics.slice(0, limit).map((topic) => ({
    key: topic.topic_key,
    tier: topic.tier,
    playerMentions: topic.player_mentions,
    lastSeenAt: topic.last_seen,
    recallWeight:
      1 +
      Math.round(
        Math.min(DIALOGUE.maxRecallBonus, Math.max(0, topic.player_mentions - 1) * DIALOGUE.recallStep) * 100,
      ) /
        100,
    episodes: store
      .all<EpisodeRow>(
        `SELECT * FROM memory_episodes WHERE ${where} AND topic_key=? ORDER BY created_at DESC,rowid DESC LIMIT 3`,
        ...params(scope),
        topic.topic_key,
      )
      .map((row) => {
        const ids: string[] = JSON.parse(row.evidence_ids_json);
        // Exact, bounded source excerpts keep open details available even if the model's
        // incremental summary missed a nuance. No model-authored IDs can escape this scope.
        const excerpts = store
          .all<{
            id: string;
            author_kind: 'player' | 'character';
            author_id: string;
            body: string;
            created_at: number;
          }>(
            `SELECT id,author_kind,author_id,body,created_at FROM messages WHERE world_id=? AND conversation_id=?
            AND id IN (${ids.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 4`,
            scope.worldId,
            scope.conversationId,
            ...ids,
          )
          .reverse()
          .map((message) => ({
            id: message.id,
            authorKind: message.author_kind,
            authorId: message.author_id,
            text: [...message.body].slice(0, 400).join(''),
            at: message.created_at,
          }));
        const sources = episodeSources(store, scope, topic.topic_key, row.job_id);
        return {
          summary: row.summary,
          sourceKind: row.source_kind,
          messageIds: ids,
          at: row.created_at,
          excerpts,
          ...(sources.length ? { sources } : {}),
        };
      })
      .reverse(),
  }));
}
