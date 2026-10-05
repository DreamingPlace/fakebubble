import type { CharacterScope, MessageDTO, TextGenerationRequest } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { topicKey } from '../../packages/domain/dialogue.ts';
import type { BusinessStore as Store } from './store-contract.ts';

const scoped = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;

// The v7 table/function names are retained; both group chats and Moments are shared threads.
export function groupContext(store: Store, scope: CharacterScope): TextGenerationRequest['conversation'] {
  const row = store.get<{ name: string }>(
    'SELECT name FROM group_conversations WHERE world_id=? AND conversation_id=?',
    scope.worldId,
    scope.conversationId,
  );
  const moment = store.get<{ root_message_id: string }>(
    'SELECT root_message_id FROM moment_threads WHERE world_id=? AND conversation_id=?',
    scope.worldId,
    scope.conversationId,
  );
  const draft = store.get(
    'SELECT 1 FROM moment_post_drafts WHERE world_id=? AND conversation_id=?',
    scope.worldId,
    scope.conversationId,
  );
  ensure(!row || (!moment && !draft), 'MOMENT_INTEGRITY_ERROR');
  if (!row && !moment && !draft) return undefined;
  const members = store.all<{ id: string; name: string }>(
    `SELECT p.character_id id,json_extract(t.config_json,'$.name') name FROM participants p
    JOIN character_templates t ON t.id=p.character_id WHERE p.world_id=? AND p.conversation_id=? ORDER BY p.character_id`,
    scope.worldId,
    scope.conversationId,
  );
  ensure(
    members.some((member) => member.id === scope.characterId),
    'FORBIDDEN',
  );
  return moment
    ? { kind: 'moment', name: '朋友圈评论', postMessageId: moment.root_message_id, members }
    : draft
      ? { kind: 'moment_post', name: '发布朋友圈', members }
      : { kind: 'group', name: row!.name, members };
}

/** Freeze the visible IDs actually supplied to this job, not the entire group history. No knowledge is granted yet. */
export function groupReadSnapshot(store: Store, scope: CharacterScope, jobId: string, ids: string[]): string[] {
  const previous = store.get<{ message_ids_json: string }>(
    `SELECT message_ids_json FROM group_job_reads WHERE ${scoped} AND job_id=?`,
    ...params(scope),
    jobId,
  );
  if (previous) return JSON.parse(previous.message_ids_json);
  store.run('INSERT INTO group_job_reads VALUES (?,?,?,?,?)', ...params(scope), jobId, JSON.stringify(ids));
  return ids;
}

/** Publication transaction only. Failed/unpublished candidates never make a member know the group conversation. */
export function recordGroupKnowledge(
  store: Store,
  scope: CharacterScope,
  jobId: string,
  published: MessageDTO[],
  now: number,
) {
  if (!groupContext(store, scope)) return;
  const snapshot = store.get<{ message_ids_json: string }>(
    `SELECT message_ids_json FROM group_job_reads WHERE ${scoped} AND job_id=?`,
    ...params(scope),
    jobId,
  );
  ensure(snapshot, 'GROUP_CONTEXT_REQUIRED');
  const ids: string[] = [
    ...new Set([...JSON.parse(snapshot.message_ids_json), ...published.map((message) => message.id)]),
  ];
  for (const id of ids) {
    ensure(
      store.get(
        'SELECT 1 FROM messages WHERE world_id=? AND conversation_id=? AND id=?',
        scope.worldId,
        scope.conversationId,
        id,
      ),
      'INVALID_MEMORY_EVIDENCE',
    );
    store.run('INSERT OR IGNORE INTO group_message_knowledge VALUES (?,?,?,?,?,?)', ...params(scope), id, now, jobId);
  }
}

/** Only private replies to the same world's owner may recall already-observed group content. Never import private secrets into groups. */
export function knownGroupEvidence(
  store: Store,
  scope: CharacterScope,
  query: string,
): TextGenerationRequest['evidence'] {
  const sources = store.all<{ conversation_id: string }>(
    `SELECT k.conversation_id FROM group_message_knowledge k
    JOIN participants p ON p.world_id=k.world_id AND p.conversation_id=k.conversation_id AND p.character_id=k.character_id
    WHERE k.world_id=? AND k.character_id=? GROUP BY k.conversation_id ORDER BY max(k.learned_at) DESC,k.conversation_id LIMIT 64`,
    scope.worldId,
    scope.characterId,
  );
  const words = [
    ...new Set(
      [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(topicKey(query).slice(0, 4000))]
        .filter((item) => item.isWordLike && item.segment.length > 1)
        .map((item) => item.segment),
    ),
  ].slice(0, 16);
  const score = words.length ? words.map(() => '(CASE WHEN instr(m.body,?)>0 THEN 1 ELSE 0 END)').join('+') : '0';
  const candidates = sources.flatMap((source) =>
    store
      .all<{
        id: string;
        body: string;
        author_kind: string;
        author_id: string;
        created_at: number;
        learned_at: number;
        name: string;
        surface: 'group' | 'moment';
        author_name: string | null;
        relevance: number;
      }>(
        `SELECT m.id,m.body,m.author_kind,m.author_id,m.created_at,k.learned_at,coalesce(g.name,'朋友圈') name,
      CASE WHEN mt.conversation_id IS NULL THEN 'group' ELSE 'moment' END surface,json_extract(t.config_json,'$.name') author_name,(${score}) relevance
      FROM group_message_knowledge k JOIN messages m ON m.world_id=k.world_id AND m.conversation_id=k.conversation_id AND m.id=k.message_id
      LEFT JOIN group_conversations g ON g.world_id=k.world_id AND g.conversation_id=k.conversation_id
      LEFT JOIN moment_threads mt ON mt.world_id=k.world_id AND mt.conversation_id=k.conversation_id
      LEFT JOIN character_templates t ON m.author_kind='character' AND t.id=m.author_id
      WHERE k.world_id=? AND k.conversation_id=? AND k.character_id=? AND (g.conversation_id IS NOT NULL OR mt.conversation_id IS NOT NULL)
      ORDER BY relevance DESC,m.seq DESC LIMIT 12`,
        ...words,
        scope.worldId,
        source.conversation_id,
        scope.characterId,
      )
      .map((row) => ({ ...row, conversationId: source.conversation_id })),
  );
  candidates.sort((a, b) => b.relevance - a.relevance || b.created_at - a.created_at || a.id.localeCompare(b.id));
  return candidates.slice(0, 12).map((row) => ({
    id: `${row.surface}:${row.id}`,
    kind: `observed_${row.surface}_message`,
    observedAt: row.learned_at,
    text: JSON.stringify({
      sourceConversationId: row.conversationId,
      sourceMessageId: row.id,
      ...(row.surface === 'group' ? { groupName: row.name } : { momentName: row.name }),
      authorKind: row.author_kind,
      authorName: row.author_kind === 'player' ? '玩家' : row.author_name,
      text: [...row.body].slice(0, 800).join(''),
      occurredAt: row.created_at,
    }),
  }));
}
