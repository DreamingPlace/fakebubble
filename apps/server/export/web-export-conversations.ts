import { ensure } from '../../../packages/domain/errors.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import {
  characterFacts,
  nicknamesOfWorld,
  redactNicknames,
  REVIEW_ALPHABET,
  reviewCodeFor,
  reviewLabel,
  type CharacterFacts,
} from '../review/web-chat-review.ts';
import type { Cell, Sheet } from './web-export-file.ts';

/**
 * Part 57: 测试对话 as a table to study in bulk. One row per message, under the review page's own pseudonymous code and with the same
 * nickname replacement; a second sheet per conversation. Never read or returned: an id of any principal / player / world /
 * conversation / session / operation, an email, a nickname, an IP hash, an invite code. The candidate's text is NOT read: only the
 * list of guard reason codes inside it (json_extract of `$.guardReasons`, each checked against the fixed list).
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;

export const CONVERSATION_STATUSES = ['published', 'failed', 'unknown'] as const;
export const CONVERSATION_WRITERS = ['v7', 'v8', 'v8p', 'v8m'] as const;
export type ConversationFilters = {
  /** UTC+8 calendar days, inclusive. */
  from: string | null;
  to: string | null;
  characterId: string | null;
  writer: (typeof CONVERSATION_WRITERS)[number] | null;
  /** A draft OR review model name. */
  model: string | null;
  status: (typeof CONVERSATION_STATUSES)[number] | null;
  /** 测试对话's own scope: only live chats, only archived (deleted) ones, or both. */
  scope: 'live' | 'archived' | null;
  /** Review codes (the 4-letter code the review page shows). Empty = every player. */
  players: string[];
};
export const MESSAGES_HEADER = [
  '对话编号',
  '时间（UTC+8）',
  '说话人',
  '角色',
  '内容',
  '方式',
  '回复写法',
  '草稿模型',
  '审核模型',
  '审核改动',
  '改动原因',
  '状态',
  '错误代码',
] as const;
export const CONVERSATIONS_HEADER = [
  '对话编号',
  '角色',
  '消息数',
  '第一条时间（UTC+8）',
  '最后一条时间（UTC+8）',
  '失败数',
] as const;
export const WRITER_LABEL = { v7: '旧写法', v8: '新写法', v8p: '新+档案', v8m: '新+档案+梗' } as const;
const GUARD_REASONS = new Set([
  'distress',
  'hidden_setting',
  'other_conversation',
  'fabricated_real_world',
  'fabricated_shared_past',
  'presumptuous_address',
  'denied_ai',
  'batch_output',
  'over_intense',
]);
const FIXED_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL_NAME = /^[A-Za-z0-9._:/-]{1,80}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UTC8 = 8 * 3_600_000;
const two = (n: number) => String(n).padStart(2, '0');
/** 'YYYY-MM-DD HH:MM:SS' on the UTC+8 wall clock. */
export const utc8Time = (at: number) => {
  const d = new Date(at + UTC8);
  return `${d.toISOString().slice(0, 10)} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}`;
};
/** The first millisecond of a UTC+8 day. */
const dayStart = (day: string) => Date.parse(`${day}T00:00:00Z`) - UTC8;

/** An archived line carries the character's own wall clock ("YYYY-MM-DD HH:MM"); this is that instant in UTC+8. */
export function localToUtc8(local: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(local);
  if (!match) return { text: local, at: null as number | null };
  const wall = Date.UTC(+match[1]!, +match[2]! - 1, +match[3]!, +match[4]!, +match[5]!);
  const offsetAt = (instant: number) => {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }).formatToParts(new Date(instant));
      const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
      return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - instant;
    } catch {
      return 0;
    }
  };
  let at = wall - offsetAt(wall);
  at = wall - offsetAt(at);
  return { text: utc8Time(at), at };
}

export function parseConversationFilters(input: unknown): ConversationFilters {
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
  const body = input as Record<string, unknown>;
  const day = (value: unknown) => {
    ensure(
      value === null ||
        value === undefined ||
        (typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value))),
      'INVALID_REQUEST',
    );
    return (value ?? null) as string | null;
  };
  const id = (value: unknown) => {
    ensure(
      value === null || value === undefined || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)),
      'INVALID_REQUEST',
    );
    return (value ?? null) as string | null;
  };
  const one = <T extends string>(value: unknown, allowed: readonly T[]) => {
    ensure(value === null || value === undefined || allowed.includes(value as T), 'INVALID_REQUEST');
    return (value ?? null) as T | null;
  };
  const model = body.model ?? null;
  ensure(model === null || (typeof model === 'string' && MODEL_NAME.test(model)), 'INVALID_REQUEST');
  const players = body.players ?? [];
  ensure(
    Array.isArray(players) &&
      players.length <= 500 &&
      players.every(
        (c) => typeof c === 'string' && c.length === 4 && [...c].every((ch) => REVIEW_ALPHABET.includes(ch)),
      ),
    'INVALID_REQUEST',
  );
  const from = day(body.from),
    to = day(body.to);
  ensure(from === null || to === null || from <= to, 'INVALID_REQUEST');
  return {
    from,
    to,
    characterId: id(body.characterId),
    writer: one(body.writer, CONVERSATION_WRITERS),
    model: model as string | null,
    status: one(body.status, CONVERSATION_STATUSES),
    scope: one(body.scope, ['live', 'archived'] as const),
    players: [...new Set(players as string[])],
  };
}

const tableExists = (store: Reader, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

export type OpInfo = {
  status: string;
  failureCode: string | null;
  writer: string;
  draftModel: string;
  reviewModel: string;
  changed: boolean | null;
  reasons: string[];
};
type Line = {
  at: number | null;
  time: string;
  speaker: string;
  text: string;
  delivery: string;
  op: OpInfo | null;
  /** 已发布 / 失败 / 结果未知 / 进行中 / 已取消 */
  status: string;
  errorCode: string;
  placeholder: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  published: '已发布',
  failed: '失败',
  unknown: '结果未知',
  cancelled: '已取消',
};
export const statusLabel = (status: string) => STATUS_LABEL[status] ?? '进行中';
const FILTER_STATUS: Record<(typeof CONVERSATION_STATUSES)[number], string> = {
  published: '已发布',
  failed: '失败',
  unknown: '结果未知',
};
const writerOf = (json: { writer?: unknown; writerProfile?: unknown; writerMemes?: unknown } | null) =>
  json?.writer === 'v8' ? (json.writerMemes === true ? 'v8m' : json.writerProfile === true ? 'v8p' : 'v8') : 'v7';

/** The operations selected by `where` (over `web_operations o`), keyed by operation id and by the message that started them. */
export function readOperations(store: Reader, where: string, args: (string | number)[]) {
  const models = tableExists(store, 'web_operation_models'),
    requests = tableExists(store, 'web_v7_requests'),
    candidates = tableExists(store, 'web_provider_candidates'),
    metrics = !!store.get("SELECT 1 FROM pragma_table_info('web_operation_metrics') WHERE name='review_changed'");
  const rows = store.all<{
    id: string;
    status: string;
    failure_code: string | null;
    input_message_id: string;
    character_id: string;
    created_at: number;
    draft_model: string | null;
    review_model: string | null;
    writer: string | null;
    profile: number | null;
    memes: number | null;
    changed: number | null;
    reasons: string | null;
  }>(
    `SELECT o.id,o.status,o.failure_code,o.input_message_id,o.character_id,o.created_at,
      ${models ? '(SELECT x.draft_model FROM web_operation_models x WHERE x.operation_id=o.id)' : 'NULL'} draft_model,
      ${models ? '(SELECT x.review_model FROM web_operation_models x WHERE x.operation_id=o.id)' : 'NULL'} review_model,
      ${requests ? "(SELECT json_extract(r.request_json,'$.writer') FROM web_v7_requests r WHERE r.operation_id=o.id)" : 'NULL'} writer,
      ${requests ? "(SELECT json_extract(r.request_json,'$.writerProfile') FROM web_v7_requests r WHERE r.operation_id=o.id)" : 'NULL'} profile,
      ${requests ? "(SELECT json_extract(r.request_json,'$.writerMemes') FROM web_v7_requests r WHERE r.operation_id=o.id)" : 'NULL'} memes,
      ${metrics ? '(SELECT x.review_changed FROM web_operation_metrics x WHERE x.operation_id=o.id)' : 'NULL'} changed,
      ${candidates ? "(SELECT json_extract(c.candidate_json,'$.guardReasons') FROM web_provider_candidates c WHERE c.operation_id=o.id)" : 'NULL'} reasons
    FROM web_operations o WHERE ${where}`,
    ...args,
  );
  const byOperation = new Map<string, OpInfo & { characterId: string; createdAt: number }>(),
    byInput = new Map<string, string>();
  for (const row of rows) {
    let reasons: string[] = [];
    if (row.reasons) {
      try {
        const parsed: unknown = JSON.parse(row.reasons);
        if (Array.isArray(parsed))
          reasons = parsed.filter((r): r is string => typeof r === 'string' && GUARD_REASONS.has(r));
      } catch {
        // not a list: no reasons
      }
    }
    const writer = writerOf({ writer: row.writer, writerProfile: row.profile === 1, writerMemes: row.memes === 1 });
    byOperation.set(row.id, {
      status: row.status,
      failureCode: row.failure_code && FIXED_CODE.test(row.failure_code) ? row.failure_code : null,
      writer,
      draftModel: row.draft_model && MODEL_NAME.test(row.draft_model) ? row.draft_model : '',
      reviewModel: row.review_model && MODEL_NAME.test(row.review_model) ? row.review_model : '',
      changed: row.changed === null ? (reasons.length > 0 ? true : null) : row.changed === 1,
      reasons,
      characterId: row.character_id,
      createdAt: row.created_at,
    });
    byInput.set(row.input_message_id, row.id);
  }
  return { byOperation, byInput };
}

/** The lines of one world's chat with one character, in order. */
function readLines(store: Reader, worldId: string, characterId: string, names: readonly string[]) {
  const { byOperation, byInput } = readOperations(store, 'o.world_id=? AND o.character_id=?', [worldId, characterId]);
  const publication = new Map<string, { operation: string; voiced: boolean }>();
  if (tableExists(store, 'web_publication_items'))
    for (const row of store.all<{ message_id: string; operation_id: string; origin: string; media_id: string | null }>(
      `SELECT i.message_id,i.operation_id,i.origin,i.media_id FROM web_publication_items i
      JOIN web_operations o ON o.id=i.operation_id WHERE o.world_id=? AND o.character_id=?`,
      worldId,
      characterId,
    ))
      publication.set(row.message_id, {
        operation: row.operation_id,
        voiced: row.origin === 'narrative' && row.media_id !== null,
      });
  const messages = store.all<{
    seq: number;
    id: string;
    body: string;
    created_at: number;
    author_kind: 'player' | 'character';
    proactive: number;
  }>(
    `SELECT m.seq,m.id,m.body,m.created_at,m.author_kind,m.proactive FROM messages m
    JOIN conversations c ON c.world_id=m.world_id AND c.id=m.conversation_id
    WHERE m.world_id=? AND c.kind='private' AND c.private_character_id=? ORDER BY m.seq`,
    worldId,
    characterId,
  );
  const lines: Line[] = [];
  for (const m of messages) {
    const made = m.author_kind === 'player' ? undefined : publication.get(m.id);
    const operationId = m.author_kind === 'player' ? byInput.get(m.id) : made?.operation;
    const op = operationId ? (byOperation.get(operationId) ?? null) : null;
    lines.push({
      at: m.created_at,
      time: utc8Time(m.created_at),
      speaker: m.author_kind === 'player' ? '玩家' : m.proactive === 1 ? '角色（主动）' : '角色',
      text: redactNicknames(m.body, names),
      delivery: made?.voiced ? '语音' : '文字',
      op,
      status: op ? statusLabel(op.status) : '已发布',
      errorCode: op?.status === 'failed' ? (op.failureCode ?? '') : '',
      placeholder: false,
    });
    // A reply that did not publish belongs right after the player message it answered.
    if (m.author_kind === 'player' && op && op.status !== 'published' && ['failed', 'unknown'].includes(op.status))
      lines.push({
        at: m.created_at,
        time: utc8Time(m.created_at),
        speaker: '角色',
        text: '',
        delivery: '',
        op,
        status: statusLabel(op.status),
        errorCode: op.status === 'failed' ? (op.failureCode ?? 'UNKNOWN') : '',
        placeholder: true,
      });
  }
  return lines;
}

type Conversation = { label: string; character: string; lines: Line[] };

/** Every conversation the filters leave something of (live ones, then archived ones), sorted by label. */
export function conversationsFor(store: BusinessStore, now: number, filters: ConversationFilters): Conversation[] {
  ensure(tableExists(store, 'web_review_codes') && tableExists(store, 'web_review_archive'), 'NOT_FOUND');
  const facts = new Map<string, CharacterFacts>();
  const factsOf = (id: string) => {
    let value = facts.get(id);
    if (!value) facts.set(id, (value = characterFacts(store, id)));
    return value;
  };
  const fromAt = filters.from === null ? null : dayStart(filters.from);
  const toAt = filters.to === null ? null : dayStart(filters.to) + 86_400_000;
  const keep = (line: Line) => {
    if (filters.status !== null && line.status !== FILTER_STATUS[filters.status]) return false;
    if (filters.writer !== null && line.op?.writer !== filters.writer) return false;
    if (filters.model !== null && line.op?.draftModel !== filters.model && line.op?.reviewModel !== filters.model)
      return false;
    if (line.at !== null) {
      if (fromAt !== null && line.at < fromAt) return false;
      if (toAt !== null && line.at >= toAt) return false;
    } else if (fromAt !== null || toAt !== null) return false;
    return true;
  };
  const wanted = filters.players.length > 0 ? new Set(filters.players) : null;
  const result: Conversation[] = [];
  const live =
    filters.scope === 'archived'
      ? []
      : store.all<{ principal_id: string; world_id: string; character_id: string }>(
          `SELECT DISTINCT p.id principal_id,p.world_id,c.private_character_id character_id
    FROM web_principals p JOIN conversations c ON c.world_id=p.world_id AND c.kind='private'
    WHERE NOT EXISTS (SELECT 1 FROM web_guest_retention r WHERE r.principal_id=p.id AND r.state IN ('purging','purged'))
      AND EXISTS (SELECT 1 FROM messages m WHERE m.world_id=c.world_id AND m.conversation_id=c.id)
      ${filters.characterId === null ? '' : 'AND c.private_character_id=?'}`,
          ...(filters.characterId === null ? [] : [filters.characterId]),
        );
  // The same single write the review page makes: a code that does not exist yet is drawn the first time it is needed.
  store.transaction(() => {
    const namesOf = new Map<string, string[]>();
    for (const row of live) {
      if (webCharacterDeleted(store, row.character_id)) continue;
      const code = reviewCodeFor(store, row.principal_id, now);
      if (wanted && !wanted.has(code)) continue;
      const character = factsOf(row.character_id);
      let names = namesOf.get(row.world_id);
      if (!names) namesOf.set(row.world_id, (names = nicknamesOfWorld(store, row.world_id)));
      const lines = readLines(store, row.world_id, row.character_id, names).filter(keep);
      if (lines.length > 0) result.push({ label: reviewLabel(character, code), character: character.label, lines });
    }
  });
  const archive =
    filters.scope === 'live'
      ? []
      : store.all<{
          label: string;
          review_code: string;
          character_id: string;
          line_order: number;
          at_local: string;
          speaker: string;
          text: string;
          status: string;
          error_code: string | null;
          review_changed: number;
        }>(
          `SELECT label,review_code,character_id,line_order,at_local,speaker,text,status,error_code,review_changed
    FROM web_review_archive ${filters.characterId === null ? '' : 'WHERE character_id=?'} ORDER BY label,review_code,line_order`,
          ...(filters.characterId === null ? [] : [filters.characterId]),
        );
  const archived = new Map<string, Conversation>();
  for (const row of archive) {
    if (wanted && !wanted.has(row.review_code)) continue;
    const character = factsOf(row.character_id);
    const moment = localToUtc8(row.at_local, character.timeZone);
    const op: OpInfo | null =
      row.review_changed === 1
        ? {
            status: 'published',
            failureCode: null,
            writer: '',
            draftModel: '',
            reviewModel: '',
            changed: true,
            reasons: [],
          }
        : null;
    const line: Line = {
      at: moment.at,
      time: moment.text,
      speaker: row.speaker === 'player' ? '玩家' : row.speaker === 'proactive' ? '角色（主动）' : '角色',
      text: row.text,
      delivery: '',
      op,
      status: row.status === 'failed' ? '失败' : '已发布',
      errorCode:
        row.status === 'failed' ? (row.error_code && FIXED_CODE.test(row.error_code) ? row.error_code : 'UNKNOWN') : '',
      placeholder: row.status === 'failed',
    };
    // The archive never kept a writer or a model: those two filters leave archived lines out.
    if (filters.writer !== null || filters.model !== null) continue;
    if (!keep(line)) continue;
    const key = `${row.label}\0${row.review_code}`;
    let target = archived.get(key);
    if (!target) archived.set(key, (target = { label: row.label, character: character.label, lines: [] }));
    target.lines.push(line);
  }
  result.push(...archived.values());
  return result.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

export function conversationSheets(conversations: readonly Conversation[]): Sheet[] {
  const messages: Cell[][] = [];
  const summary: Cell[][] = [];
  for (const conversation of conversations) {
    let count = 0,
      failed = 0,
      first: string | null = null,
      last: string | null = null;
    for (const line of conversation.lines) {
      messages.push([
        conversation.label,
        line.time,
        line.speaker,
        conversation.character,
        line.text,
        line.delivery,
        line.op?.writer ? WRITER_LABEL[line.op.writer as keyof typeof WRITER_LABEL] : '',
        line.op?.draftModel ?? '',
        line.op?.reviewModel ?? '',
        line.op && line.speaker !== '玩家' && !line.placeholder && line.op.changed !== null
          ? line.op.changed
            ? '是'
            : '否'
          : '',
        line.op && line.speaker !== '玩家' ? line.op.reasons.join('、') : '',
        line.status,
        line.errorCode,
      ]);
      if (line.placeholder) failed++;
      else count++;
      if (first === null || line.time < first) first = line.time;
      if (last === null || line.time > last) last = line.time;
    }
    summary.push([conversation.label, conversation.character, count, first, last, failed]);
  }
  return [
    { name: '每条消息', file: 'messages', header: MESSAGES_HEADER, rows: messages },
    { name: '按对话汇总', file: 'summary', header: CONVERSATIONS_HEADER, rows: summary },
  ];
}
