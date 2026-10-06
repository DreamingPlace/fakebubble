import { randomUUID } from 'node:crypto';
import type {
  CharacterScope,
  DialogueCandidate,
  MessageDTO,
  RandomSource,
  ShortTermTurn,
  TopicMemory,
} from '../../../packages/contracts/index.ts';
import { DIALOGUE, topicKey } from '../../../packages/domain/dialogue.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { episodeSources, recordEpisodeSources, validateEpisodeSources } from './context-evidence.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
interface TopicRow {
  id: string;
  topic_key: string;
  tier: 'short' | 'long';
  player_mentions: number;
  last_seen: number;
}
interface EpisodeRow {
  row_seq: number;
  job_id: string;
  summary: string;
  source_kind: TopicMemory['episodes'][number]['sourceKind'];
  evidence_ids_json: string;
  created_at: number;
}

export function validateDialogueMemoryEvidence(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  candidate: DialogueCandidate,
): void {
  for (const topic of candidate.topics) {
    if (topic.linkedMemoryId !== undefined)
      ensure(
        store.get(
          `SELECT 1 FROM memory_catalog WHERE ${where} AND id=? AND topic_key=?`,
          ...params(scope),
          topic.linkedMemoryId,
          topic.key,
        ),
        'INVALID_MEMORY_LINK',
      );
    const evidence = topic.evidenceMessageIds.map((id) =>
      store.get<{ author_kind: string }>(
        'SELECT author_kind FROM messages WHERE world_id=? AND conversation_id=? AND id=?',
        scope.worldId,
        scope.conversationId,
        id,
      ),
    );
    ensure(
      evidence.every(Boolean) &&
        (topic.sourceKind !== 'player_statement' ||
          (evidence.length > 0 && evidence.every((row) => row?.author_kind === 'player'))),
      'INVALID_MEMORY_EVIDENCE',
    );
    validateEpisodeSources(store, scope, jobId, topic.sourceEvidenceIds ?? []);
  }
}

/** Internal helper: caller has authorized this conversation/character scope and owns the publication transaction. */
export function recordDialogueMemories(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  candidate: DialogueCandidate,
  published: MessageDTO[],
  currentInputIds: string[],
  now: number,
): void {
  for (const topic of candidate.topics) {
    const evidence = topic.evidenceMessageIds.map((id) => {
      const row = store.get<{ id: string; author_kind: string }>(
        'SELECT id,author_kind FROM messages WHERE world_id=? AND conversation_id=? AND id=?',
        scope.worldId,
        scope.conversationId,
        id,
      );
      ensure(row, 'INVALID_MEMORY_EVIDENCE');
      return row;
    });
    ensure(
      topic.sourceKind !== 'player_statement' ||
        (evidence.length > 0 && evidence.every((row) => row.author_kind === 'player')),
      'INVALID_MEMORY_EVIDENCE',
    );
    store.run(
      `INSERT INTO memory_topics VALUES (?,?,?,?,'short',0,?,?) ON CONFLICT(world_id,conversation_id,character_id,topic_key)
      DO UPDATE SET last_seen=excluded.last_seen,active_until=excluded.active_until`,
      ...params(scope),
      topic.key,
      now,
      now + DIALOGUE.shortMemoryMs,
    );
    store.run(
      'INSERT OR IGNORE INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES (?,?,?,?,?)',
      randomUUID(),
      ...params(scope),
      topic.key,
    );
    // A single-focus answer links its answered inputs to that focus even when the model
    // cites only the older exchange (e.g. the player's follow-up is just “那个呢?”).
    // This associates a turn with a topic; it does NOT make a question a player fact.
    const turnIds = candidate.topics.length === 1 ? candidate.coveredMessageIds : [];
    const mentionIds = new Set([
      ...evidence.filter((row) => row.author_kind === 'player').map((row) => row.id),
      ...turnIds,
    ]);
    for (const id of mentionIds) {
      if (currentInputIds.includes(id)) {
        store.run('INSERT OR IGNORE INTO memory_mentions VALUES (?,?,?,?,?)', ...params(scope), topic.key, id);
      }
    }
    const count = store.get<{ n: number }>(
      `SELECT count(*) AS n FROM memory_mentions WHERE ${where} AND topic_key=?`,
      ...params(scope),
      topic.key,
    )!.n;
    store.run(
      `UPDATE memory_topics SET player_mentions=?,tier=CASE WHEN ?>=? THEN 'long' ELSE tier END WHERE ${where} AND topic_key=?`,
      count,
      count,
      DIALOGUE.promotionMentions,
      ...params(scope),
      topic.key,
    );
    const ids = [...new Set([...topic.evidenceMessageIds, ...turnIds, ...published.map((message) => message.id)])];
    store.run(
      'INSERT INTO memory_episodes VALUES (?,?,?,?,?,?,?,?,?)',
      ...params(scope),
      topic.key,
      jobId,
      topic.summary,
      topic.sourceKind,
      JSON.stringify(ids),
      now,
    );
    recordEpisodeSources(store, scope, jobId, topic.key, topic.sourceEvidenceIds ?? []);
  }
}

/** Expiry removes short topics from default recall, not from a relevant explicit search. */
export function recallMemories(
  store: Store,
  scope: CharacterScope,
  now: number,
  query = '',
  limit = 12,
): TopicMemory[] {
  ensure(Number.isInteger(limit) && limit >= 1 && limit <= 12, 'INVALID_MEMORY_LIMIT');
  const words = [
    ...new Set(
      [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(topicKey(query).slice(0, 4000))]
        .filter((part) => part.isWordLike && part.segment.length > 1)
        .map((part) => part.segment),
    ),
  ].slice(0, 16);
  const score = words.length
    ? words
        .map(
          () => `(CASE WHEN instr(t.topic_key,?)>0 THEN 4 ELSE 0 END +
    CASE WHEN EXISTS(SELECT 1 FROM memory_episodes e WHERE e.world_id=t.world_id AND e.conversation_id=t.conversation_id
      AND e.character_id=t.character_id AND e.topic_key=t.topic_key AND instr(lower(e.summary),?)>0) THEN 1 ELSE 0 END +
    CASE WHEN EXISTS(SELECT 1 FROM memory_corrections c WHERE c.world_id=t.world_id AND c.conversation_id=t.conversation_id
      AND c.character_id=t.character_id AND c.topic_key=t.topic_key AND instr(lower(c.summary),?)>0 AND NOT EXISTS
        (SELECT 1 FROM memory_corrections n WHERE n.world_id=c.world_id AND n.conversation_id=c.conversation_id
          AND n.character_id=c.character_id AND n.topic_key=c.topic_key AND n.revision>c.revision)) THEN 2 ELSE 0 END)`,
        )
        .join('+')
    : '0';
  // Rank inside the full authorized scope before limiting; a newer unrelated topic cannot hide an older match.
  const topics = store.all<TopicRow>(
    `WITH ranked AS (SELECT t.*,c.id,(${score}) relevance FROM memory_topics t
    JOIN memory_catalog c ON c.world_id=t.world_id AND c.conversation_id=t.conversation_id AND c.character_id=t.character_id AND c.topic_key=t.topic_key
    WHERE t.world_id=? AND t.conversation_id=? AND t.character_id=?) SELECT * FROM ranked
    WHERE tier='long' OR active_until>? OR relevance>0 ORDER BY relevance DESC,last_seen DESC,topic_key LIMIT ?`,
    ...words.flatMap((word) => [word, word, word]),
    ...params(scope),
    now,
    limit,
  );
  const episodeScore = words.length
    ? words.map(() => '(CASE WHEN instr(lower(summary),?)>0 THEN 1 ELSE 0 END)').join('+')
    : '0';
  return topics.map((topic) => ({
    id: topic.id,
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
        `SELECT *,rowid row_seq,(${episodeScore}) relevance FROM memory_episodes WHERE ${where} AND topic_key=?
      ORDER BY relevance DESC,created_at DESC,rowid DESC LIMIT 3`,
        ...words,
        ...params(scope),
        topic.topic_key,
      )
      .sort((a, b) => a.created_at - b.created_at || a.row_seq - b.row_seq)
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
            `SELECT id,author_kind,author_id,body,created_at FROM messages WHERE body!='' AND world_id=? AND conversation_id=?
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
      }),
  }));
}

/** Every published dialogue has exact short-term memory, even a greeting with no semantic topic yet. */
export function recentTurns(store: Store, scope: CharacterScope, now: number): ShortTermTurn[] {
  const turns = store.all<{ id: string; at: number }>(
    `SELECT j.id,min(m.created_at) AS at FROM jobs j
    JOIN dialogue_bubbles b ON b.job_id=j.id AND b.world_id=j.world_id AND b.conversation_id=j.conversation_id
    JOIN messages m ON m.id=b.message_id AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id
    WHERE j.world_id=? AND j.conversation_id=? AND j.character_id=? AND m.created_at>?
    GROUP BY j.id ORDER BY max(m.seq) DESC LIMIT 8`,
    ...params(scope),
    now - DIALOGUE.shortMemoryMs,
  );
  return turns.reverse().map((turn) => ({
    ...turn,
    messages: store.all<{ id: string; text: string; expression: ShortTermTurn['messages'][number]['expression'] }>(
      `SELECT m.id,m.body AS text,b.expression FROM dialogue_bubbles b JOIN messages m ON m.id=b.message_id
        WHERE b.world_id=? AND b.conversation_id=? AND b.job_id=? AND m.world_id=? AND m.conversation_id=? AND m.author_id=?
        ORDER BY b.ordinal`,
      scope.worldId,
      scope.conversationId,
      turn.id,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    ),
  }));
}

/** Called in the first eligible proactive claim transaction, never by a timer or generation retry. */
export function selectProactiveTopic(
  store: Store,
  scope: CharacterScope,
  intentId: string,
  now: number,
  random: RandomSource,
): void {
  if (store.get(`SELECT 1 FROM proactive_topics WHERE ${where} AND intent_id=?`, ...params(scope), intentId)) return;
  const pool: { key: string | null; weight: number }[] = [
    { key: null, weight: 1 },
    ...recallMemories(store, scope, now).map((topic) => ({ key: topic.key, weight: topic.recallWeight })),
  ];
  const roll = pool.length > 1 ? random.next() : null;
  ensure(roll === null || (Number.isFinite(roll) && roll >= 0 && roll < 1), 'INVALID_RANDOM');
  let cursor = (roll ?? 0) * pool.reduce((sum, item) => sum + item.weight, 0);
  let selected = pool.at(-1)!;
  for (const item of pool) {
    cursor -= item.weight;
    if (cursor < 0) {
      selected = item;
      break;
    }
  }
  store.run(
    'INSERT INTO proactive_topics VALUES (?,?,?,?,?,?,?,?)',
    ...params(scope),
    intentId,
    selected.key,
    JSON.stringify(pool),
    roll,
    now,
  );
}
