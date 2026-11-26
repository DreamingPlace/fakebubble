import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { scrubText } from '../export/web-export-admin.ts';
import { utc8Time, WRITER_LABEL } from '../export/web-export-conversations.ts';
import type { Sheet } from '../export/web-export-file.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { characterFacts, nicknamesOfWorld, redactNicknames, reviewCodeFor, reviewLabel } from '../review/web-chat-review.ts';
import { turnMemberIds } from './web-turns.ts';
import { webFeedbackInstalled } from './web-feedback-schema.ts';

/**
 * Part 36: 语音反馈 (the owner's page). Counts of 👍 / 👎 per character, per 回复写法 and per model over a range, and the list of the 👎
 * replies, newest first. Each item is in the SAME pseudonymous form as the 测试对话 transcripts: the review page's anonymous code, the
 * player's nicknames replaced, every text scrubbed of an email / uuid / long hex; never an id, email, nickname or IP hash. The owner can
 * mark an item 「已听」 and play her voice. Owner only (it shows transcripts); every action checks the session, CSRF and Origin first.
 * Her plan (读到 / 目的) is a Part 58 field: it is not on this branch, so an item carries none.
 */
type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
export const FEEDBACK_RANGES = [7, 30, 90] as const;
const DAY = 86_400_000;
const WRITERS = Object.keys(WRITER_LABEL) as (keyof typeof WRITER_LABEL)[];
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export interface FeedbackFilters {
  range: (typeof FEEDBACK_RANGES)[number];
  characterId?: string | undefined;
  writer?: string | undefined;
  model?: string | undefined;
  unheardOnly: boolean;
}
export interface FeedbackItem {
  itemId: number;
  time: string;
  characterId: string;
  /** The review page's label: "<character>-<code>". */
  label: string;
  target: 'voice' | 'content';
  writer: string;
  writerLabel: string;
  model: string;
  playerLines: string[];
  replyText: string;
  hasVoice: boolean;
  heard: boolean;
}
export interface FeedbackCounts {
  total: { up: number; down: number; downVoice: number; downContent: number };
  byCharacter: { characterId: string; label: string; up: number; down: number }[];
  byWriter: { writer: string; label: string; up: number; down: number }[];
  byModel: { model: string; up: number; down: number }[];
}

export function parseFeedbackFilters(input: unknown): FeedbackFilters {
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
  const value = input as Record<string, unknown>;
  ensure(
    Object.keys(value).every((key) => ['range', 'characterId', 'writer', 'model', 'unheardOnly', 'before'].includes(key)),
    'INVALID_REQUEST',
  );
  ensure(FEEDBACK_RANGES.includes(value.range as never), 'INVALID_REQUEST');
  ensure(value.characterId === undefined || value.characterId === '' || identifier(value.characterId), 'INVALID_REQUEST');
  ensure(value.writer === undefined || value.writer === '' || WRITERS.includes(value.writer as never), 'INVALID_REQUEST');
  ensure(
    value.model === undefined || value.model === '' || (typeof value.model === 'string' && /^[a-z0-9_.-]{1,64}$/i.test(value.model)),
    'INVALID_REQUEST',
  );
  ensure(value.unheardOnly === undefined || typeof value.unheardOnly === 'boolean', 'INVALID_REQUEST');
  return {
    range: value.range as FeedbackFilters['range'],
    characterId: (value.characterId as string) || undefined,
    writer: (value.writer as string) || undefined,
    model: (value.model as string) || undefined,
    unheardOnly: value.unheardOnly === true,
  };
}

export class WebFeedbackAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private readonly readAudio: (scope: { principalId: string; playerId: string; worldId: string; conversationId: string; characterId: string }, mediaId: string) => Promise<Uint8Array>;
  constructor(
    store: BusinessStore,
    clock: Clock,
    admin: WebAccountAdmin,
    readAudio: WebFeedbackAdmin['readAudio'],
  ) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
    this.readAudio = readAudio;
  }
  private owner(auth: Auth) {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    ensure(actor.role === 'owner', 'ADMIN_OWNER_REQUIRED');
    return actor;
  }
  private audit(actorId: string, action: string, target: string) {
    this.store.run('INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)', actorId, action, target, this.clock.now());
  }
  private where(filters: FeedbackFilters, down: boolean) {
    const sql: string[] = ['updated_at>=?'];
    const args: (string | number)[] = [this.clock.now() - filters.range * DAY];
    if (down) sql.push("rating='down'");
    if (filters.characterId) (sql.push('character_id=?'), args.push(filters.characterId));
    if (filters.writer) (sql.push('writer=?'), args.push(filters.writer));
    if (filters.model) (sql.push('model=?'), args.push(filters.model));
    if (down && filters.unheardOnly) sql.push('heard_at IS NULL');
    return { sql: sql.join(' AND '), args };
  }

  /** The counts: 👍 / 👎 per character, per 回复写法 and per model, over the chosen range. */
  counts(auth: Auth, input: unknown): FeedbackCounts {
    this.owner(auth);
    const filters = parseFeedbackFilters(input);
    if (!webFeedbackInstalled(this.store)) return { total: { up: 0, down: 0, downVoice: 0, downContent: 0 }, byCharacter: [], byWriter: [], byModel: [] };
    const where = this.where({ ...filters, unheardOnly: false }, false);
    const group = (column: string) =>
      this.store.all<{ key: string; up: number; down: number }>(
        `SELECT ${column} key,sum(rating='up') up,sum(rating='down') down FROM web_feedback WHERE ${where.sql} GROUP BY ${column} ORDER BY sum(rating='down') DESC,key`,
        ...where.args,
      );
    const total = this.store.get<{ up: number | null; down: number | null; voice: number | null; content: number | null }>(
      `SELECT sum(rating='up') up,sum(rating='down') down,sum(target='voice') voice,sum(target='content') content FROM web_feedback WHERE ${where.sql}`,
      ...where.args,
    )!;
    return {
      total: { up: total.up ?? 0, down: total.down ?? 0, downVoice: total.voice ?? 0, downContent: total.content ?? 0 },
      byCharacter: group('character_id').map((row) => ({ characterId: row.key, label: characterFacts(this.store, row.key).label, up: row.up, down: row.down })),
      byWriter: group('writer').map((row) => ({ writer: row.key, label: WRITER_LABEL[row.key as keyof typeof WRITER_LABEL] ?? row.key, up: row.up, down: row.down })),
      byModel: group('model').map((row) => ({ model: row.key, up: row.up, down: row.down })),
    };
  }

  /** The 👎 replies, newest first (`before`: the item id to continue after). */
  list(auth: Auth, input: unknown): { items: FeedbackItem[]; hasMore: boolean } {
    this.owner(auth);
    const filters = parseFeedbackFilters(input);
    const before = (input as { before?: unknown }).before;
    ensure(before === undefined || (Number.isSafeInteger(before) && (before as number) > 0), 'INVALID_REQUEST');
    if (!webFeedbackInstalled(this.store)) return { items: [], hasMore: false };
    return this.items(filters, before as number | undefined, 50);
  }

  private items(filters: FeedbackFilters, before: number | undefined, limit: number): { items: FeedbackItem[]; hasMore: boolean } {
    const where = this.where(filters, true);
    const rows = this.store.all<{
      id: number;
      principal_id: string;
      world_id: string;
      message_id: string;
      conversation_id: string;
      character_id: string;
      operation_id: string;
      target: 'voice' | 'content';
      writer: string;
      model: string;
      updated_at: number;
      heard_at: number | null;
    }>(
      `SELECT rowid id,principal_id,world_id,message_id,conversation_id,character_id,operation_id,target,writer,model,updated_at,heard_at
      FROM web_feedback WHERE ${where.sql}${before ? ' AND rowid<?' : ''} ORDER BY rowid DESC LIMIT ?`,
      ...where.args,
      ...(before ? [before] : []),
      limit + 1,
    );
    const now = this.clock.now();
    const nameCache = new Map<string, string[]>();
    const items = rows.slice(0, limit).map((row): FeedbackItem => {
      const names = nameCache.get(row.world_id) ?? nicknamesOfWorld(this.store, row.world_id);
      nameCache.set(row.world_id, names);
      const clean = (text: string) => scrubText(redactNicknames(text, names));
      const reply = this.store.get<{ body: string }>('SELECT body FROM messages WHERE id=?', row.message_id);
      const input = this.store.get<{ input_message_id: string }>('SELECT input_message_id FROM web_operations WHERE id=?', row.operation_id);
      const lines = input
        ? turnMemberIds(this.store, row.operation_id, input.input_message_id)
            .map((id) => this.store.get<{ body: string }>('SELECT body FROM messages WHERE id=?', id)?.body)
            .filter((body): body is string => typeof body === 'string')
            .map(clean)
        : [];
      const media = this.store.get<{ media_id: string | null }>('SELECT media_id FROM web_publication_items WHERE message_id=?', row.message_id);
      return {
        itemId: row.id,
        time: utc8Time(row.updated_at),
        characterId: row.character_id,
        label: reviewLabel(characterFacts(this.store, row.character_id), reviewCodeFor(this.store, row.principal_id, now)),
        target: row.target,
        writer: row.writer,
        writerLabel: WRITER_LABEL[row.writer as keyof typeof WRITER_LABEL] ?? row.writer,
        model: row.model,
        playerLines: lines,
        replyText: clean(reply?.body ?? ''),
        hasVoice: !!media?.media_id,
        heard: row.heard_at !== null,
      };
    });
    return { items, hasMore: rows.length > limit };
  }

  /** 已听 / 取消: idempotent (it sets a state), audited with the item number only. */
  markHeard(auth: Auth, input: unknown) {
    const actor = this.owner(auth);
    ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
    const body = input as Record<string, unknown>;
    ensure(Object.keys(body).sort().join(',') === 'heard,itemId', 'INVALID_REQUEST');
    ensure(Number.isSafeInteger(body.itemId) && (body.itemId as number) > 0 && typeof body.heard === 'boolean', 'INVALID_REQUEST');
    ensure(webFeedbackInstalled(this.store), 'NOT_FOUND');
    const changed = this.store.run(
      "UPDATE web_feedback SET heard_at=? WHERE rowid=? AND rating='down' AND (heard_at IS NULL)=?",
      body.heard ? this.clock.now() : null,
      body.itemId as number,
      body.heard ? 1 : 0,
    ).changes;
    ensure(
      changed === 1 || this.store.get("SELECT 1 FROM web_feedback WHERE rowid=? AND rating='down'", body.itemId as number),
      'NOT_FOUND',
    );
    if (changed === 1) this.audit(actor.memberId, body.heard ? 'feedback-heard' : 'feedback-unheard', `item ${body.itemId}`);
    return { itemId: body.itemId as number, heard: body.heard };
  }

  /** Her voice of one 👎 item, as base64 WAV for the page's player. */
  async audio(auth: Auth, input: unknown) {
    this.owner(auth);
    ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
    const body = input as Record<string, unknown>;
    ensure(Object.keys(body).join(',') === 'itemId' && Number.isSafeInteger(body.itemId) && (body.itemId as number) > 0, 'INVALID_REQUEST');
    ensure(webFeedbackInstalled(this.store), 'NOT_FOUND');
    const row = this.store.get<{ principal_id: string; world_id: string; conversation_id: string; character_id: string; message_id: string }>(
      "SELECT principal_id,world_id,conversation_id,character_id,message_id FROM web_feedback WHERE rowid=? AND rating='down'",
      body.itemId as number,
    );
    ensure(row, 'NOT_FOUND');
    const media = this.store.get<{ media_id: string | null }>('SELECT media_id FROM web_publication_items WHERE message_id=?', row.message_id);
    const player = this.store.get<{ player_id: string }>('SELECT player_id FROM web_principals WHERE id=?', row.principal_id);
    ensure(media?.media_id && player, 'NOT_FOUND');
    const bytes = await this.readAudio(
      { principalId: row.principal_id, playerId: player.player_id, worldId: row.world_id, conversationId: row.conversation_id, characterId: row.character_id },
      media.media_id,
    );
    return { contentType: 'audio/wav', base64: Buffer.from(bytes).toString('base64') };
  }

  /** The export (Part 57): the same items under the same filters, with the rating column. Owner only; whitelisted columns. */
  exportSheets(filters: Record<string, unknown>): Sheet[] {
    const parsed = parseFeedbackFilters({ range: 30, ...filters });
    const { items } = webFeedbackInstalled(this.store) ? this.items(parsed, undefined, 50_000) : { items: [] as FeedbackItem[] };
    return [
      {
        name: '语音反馈',
        file: 'feedback',
        header: ['时间（UTC+8）', '对话编号', '角色', '评价', '踩的是', '回复写法', '模型', '玩家的话', '回复文字', '有语音', '已听'],
        rows: items.map((item) => [
          item.time,
          item.label,
          characterFacts(this.store, item.characterId).label,
          '踩',
          item.target === 'voice' ? '语音' : '内容',
          item.writerLabel,
          item.model,
          item.playerLines.join('\n'),
          item.replyText,
          item.hasVoice ? '是' : '否',
          item.heard ? '是' : '否',
        ]),
      },
    ];
  }
}
