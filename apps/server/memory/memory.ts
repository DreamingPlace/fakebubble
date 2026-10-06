import { randomUUID } from 'node:crypto';
import type {
  CharacterScope,
  DialogueCandidate,
  MessageDTO,
  RandomSource,
  ShortTermTurn,
  TopicMemory,
} from '../../../packages/contracts/index.ts';
import { DIALOGUE, RECALL, topicKey } from '../../../packages/domain/dialogue.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { UserStore as Store } from '../platform/store-boundary.ts';
import { episodeSources, recordEpisodeSources, validateEpisodeSources } from './context-evidence.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
interface TopicRow {
  id: string;
  topic_key: string;
  tier: 'short' | 'long';
  player_mentions: number;
  last_seen: number;
  importance?: number;
  relevance?: number;
}
interface EpisodeRow {
  row_seq: number;
  job_id: string;
  summary: string;
  source_kind: TopicMemory['episodes'][number]['sourceKind'];
  evidence_ids_json: string;
  created_at: number;
}

/** memory_topics.importance exists from schema 115; an older database records and ranks as if every topic were 3. */
function hasImportance(store: Store, scope: CharacterScope) {
  return !!store.get(scope, "SELECT 1 FROM pragma_table_info('memory_topics') WHERE name='importance'");
}

/** The messages a fact cites must exist in this conversation and be player-authored (the player_statement rule). */
function playerEvidence(store: Store, scope: CharacterScope, ids: string[]) {
  const rows = ids.map((id) =>
    store.get<{ author_kind: string }>(
      scope,
      'SELECT author_kind FROM messages WHERE world_id=? AND conversation_id=? AND id=?',
      scope.worldId,
      scope.conversationId,
      id,
    ),
  );
  ensure(ids.length > 0 && rows.every((row) => row?.author_kind === 'player'), 'INVALID_MEMORY_EVIDENCE');
}
const activeFact = (store: Store, scope: CharacterScope, factKey: string) =>
  store.get<{ id: string }>(
    scope,
    `SELECT id FROM memory_facts WHERE ${where} AND fact_key=? AND retired_at IS NULL`,
    ...params(scope),
    factKey,
  );
function requireFactsTable(store: Store, scope: CharacterScope) {
  ensure(
    store.get(scope, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_facts'"),
    'WEB_MEMORY_MIGRATION_REQUIRED',
  );
}

/** Before any write: every fact op cites player messages of this conversation; update/retire need an active fact. */
function validatePlayerFacts(store: Store, scope: CharacterScope, candidate: DialogueCandidate): void {
  if (!candidate.factOps?.length) return;
  requireFactsTable(store, scope);
  for (const op of candidate.factOps) {
    playerEvidence(store, scope, op.evidenceMessageIds);
    ensure(op.op === 'add' || activeFact(store, scope, op.factKey), 'INVALID_FACT_REFERENCE');
  }
}

/**
 * Apply fact ops inside the publication transaction. An update (or an add of a key that is already active) retires the
 * old row, pointing at its successor, and inserts the new statement, so history stays and one fact per key is active.
 */
function recordPlayerFacts(store: Store, scope: CharacterScope, candidate: DialogueCandidate, now: number): void {
  for (const op of candidate.factOps ?? []) {
    const current = activeFact(store, scope, op.factKey);
    if (op.op === 'retire') {
      store.run(scope, 'UPDATE memory_facts SET retired_at=?,updated_at=? WHERE id=?', now, now, current!.id);
      continue;
    }
    const id = randomUUID();
    if (current)
      store.run(
        scope,
        'UPDATE memory_facts SET retired_at=?,updated_at=?,superseded_by=? WHERE id=?',
        now,
        now,
        id,
        current.id,
      );
    store.run(
      scope,
      `INSERT INTO memory_facts(world_id,conversation_id,character_id,id,fact_key,statement,importance,
      evidence_message_ids_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ...params(scope),
      id,
      op.factKey,
      op.statement,
      op.importance,
      JSON.stringify(op.evidenceMessageIds),
      now,
      now,
    );
  }
}

export function validateDialogueMemoryEvidence(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  candidate: DialogueCandidate,
): void {
  validatePlayerFacts(store, scope, candidate);
  for (const topic of candidate.topics) {
    if (topic.linkedMemoryId !== undefined)
      ensure(
        store.get(
          scope,
          `SELECT 1 FROM memory_catalog WHERE ${where} AND id=? AND topic_key=?`,
          ...params(scope),
          topic.linkedMemoryId,
          topic.key,
        ),
        'INVALID_MEMORY_LINK',
      );
    const evidence = topic.evidenceMessageIds.map((id) =>
      store.get<{ author_kind: string }>(
        scope,
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
  validatePlayerFacts(store, scope, candidate);
  const importanceColumn = hasImportance(store, scope);
  for (const topic of candidate.topics) {
    const evidence = topic.evidenceMessageIds.map((id) => {
      const row = store.get<{ id: string; author_kind: string }>(
        scope,
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
    if (importanceColumn)
      store.run(
        scope,
        `INSERT INTO memory_topics(world_id,conversation_id,character_id,topic_key,tier,player_mentions,last_seen,active_until,importance)
        VALUES (?,?,?,?,'short',0,?,?,?) ON CONFLICT(world_id,conversation_id,character_id,topic_key)
        DO UPDATE SET last_seen=excluded.last_seen,active_until=excluded.active_until,importance=max(importance,?)`,
        ...params(scope),
        topic.key,
        now,
        now + DIALOGUE.shortMemoryMs,
        topic.importance ?? DIALOGUE.defaultImportance,
        topic.importance ?? 1,
      );
    else
      store.run(
        scope,
        `INSERT INTO memory_topics(world_id,conversation_id,character_id,topic_key,tier,player_mentions,last_seen,active_until)
        VALUES (?,?,?,?,'short',0,?,?) ON CONFLICT(world_id,conversation_id,character_id,topic_key)
        DO UPDATE SET last_seen=excluded.last_seen,active_until=excluded.active_until`,
        ...params(scope),
        topic.key,
        now,
        now + DIALOGUE.shortMemoryMs,
      );
    store.run(
      scope,
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
        store.run(scope, 'INSERT OR IGNORE INTO memory_mentions VALUES (?,?,?,?,?)', ...params(scope), topic.key, id);
      }
    }
    const count = store.get<{ n: number }>(
      scope,
      `SELECT count(*) AS n FROM memory_mentions WHERE ${where} AND topic_key=?`,
      ...params(scope),
      topic.key,
    )!.n;
    // Promotion to long-term: enough player mentions OR an important topic (importance only exists from schema 115).
    store.run(
      scope,
      `UPDATE memory_topics SET player_mentions=?,tier=CASE WHEN ?>=?${importanceColumn ? ' OR importance>=?' : ''} THEN 'long' ELSE tier END
      WHERE ${where} AND topic_key=?`,
      count,
      count,
      DIALOGUE.promotionMentions,
      ...(importanceColumn ? [DIALOGUE.promotionImportance] : []),
      ...params(scope),
      topic.key,
    );
    const ids = [...new Set([...topic.evidenceMessageIds, ...turnIds, ...published.map((message) => message.id)])];
    store.run(
      scope,
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
  recordPlayerFacts(store, scope, candidate, now);
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
    scope,
    `WITH ranked AS (SELECT t.*,c.id,(${score}) relevance FROM memory_topics t
    JOIN memory_catalog c ON c.world_id=t.world_id AND c.conversation_id=t.conversation_id AND c.character_id=t.character_id AND c.topic_key=t.topic_key
    WHERE t.world_id=? AND t.conversation_id=? AND t.character_id=?) SELECT * FROM ranked
    WHERE tier='long' OR active_until>? OR relevance>0`,
    ...words.flatMap((word) => [word, word, word]),
    ...params(scope),
    now,
  );
  const ranked = topics
    .map((topic) => {
      const ageHours = Math.max(0, now - topic.last_seen) / 3_600_000;
      const score =
        RECALL.weightRelevance * Math.min(1, (topic.relevance ?? 0) / RECALL.relevanceSaturation) +
        RECALL.weightImportance * ((topic.importance ?? DIALOGUE.defaultImportance) / 10) +
        RECALL.weightRecency * Math.exp(-ageHours / RECALL.recencyHours);
      return { topic, score };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.topic.last_seen - a.topic.last_seen ||
        (a.topic.topic_key < b.topic.topic_key ? -1 : a.topic.topic_key > b.topic.topic_key ? 1 : 0),
    )
    .slice(0, limit);
  const episodeScore = words.length
    ? words.map(() => '(CASE WHEN instr(lower(summary),?)>0 THEN 1 ELSE 0 END)').join('+')
    : '0';
  return ranked.map(({ topic, score }) => ({
    id: topic.id,
    key: topic.topic_key,
    tier: topic.tier,
    playerMentions: topic.player_mentions,
    importance: topic.importance ?? DIALOGUE.defaultImportance,
    lastSeenAt: topic.last_seen,
    // A proactive pick weights each memory by the same score that ranked it.
    recallWeight: 1 + Math.round(score * 100) / 100,
    episodes: store
      .all<EpisodeRow>(
        scope,
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
            scope,
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
    scope,
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
      scope,
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
  if (store.get(scope, `SELECT 1 FROM proactive_topics WHERE ${where} AND intent_id=?`, ...params(scope), intentId))
    return;
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
    scope,
    'INSERT INTO proactive_topics VALUES (?,?,?,?,?,?,?,?)',
    ...params(scope),
    intentId,
    selected.key,
    JSON.stringify(pool),
    roll,
    now,
  );
}
