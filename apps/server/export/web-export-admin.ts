import type { Clock } from '../../../packages/contracts/index.ts';
import {
  hasAnyInvitePermission,
  hasCastPermission,
  hasStatsPermission,
  hasSystemPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { chatReviewTablesExist } from '../review/web-chat-review.ts';
import { callSheets, failureSheets, parseCallFilters } from './web-export-calls.ts';
import {
  conversationSheets,
  conversationsFor,
  parseConversationFilters,
  type ConversationFilters,
} from './web-export-conversations.ts';
import { renderExport, type ExportFormat, type RenderedExport, type Sheet } from './web-export-file.ts';
import {
  broadcastSheets,
  inviteSheets,
  memeSheets,
  parseMemeFilters,
  parseStatsRange,
  rehearsalSheets,
  shareSheets,
  statsSheets,
} from './web-export-tables.ts';

/**
 * Part 57: 导出. One entry, `export`, for every page's 「导出」 button. The business object builds the table from the same sources and
 * under the same permission as the page (the owner alone for conversations, calls and failures), streams it out as one file per part
 * and keeps nothing: no file, no cache. Every call writes ONE audit row (who, which export, the filters, the row count): no content.
 */
type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
export const EXPORT_KINDS = [
  'conversations',
  'calls',
  'failures',
  'stats',
  'cocreation',
  'memes',
  'invites',
  'broadcast',
  'shares',
  'rehearsal',
  // Part 36: 语音反馈 (the 👎 replies; owner only, like the transcripts they quote).
  'feedback',
] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
/** More rows than this in one export asks for narrower filters (a part holds 50,000). */
export const EXPORT_TOTAL_LIMIT = 500_000;

/** What the co-creation inbox adds (it owns its permission and its anonymous codes). */
export interface CocreationExportSource {
  exportSheets(auth: Auth, filters: unknown): Sheet[];
}
export interface ExportDeps {
  /** Off unless the deployment has 测试对话 on. */
  chatReview: boolean;
  characters?: {
    rehearsalList(auth: Auth, id: string): { runs: { runId: string }[] };
    rehearsalDetail(auth: Auth, id: string, runId: unknown): never;
  } | null;
  broadcast?: { list(auth: Auth): never } | null;
  shareStats?: (() => { created: number; opened: number; expired: number; active: number }) | null;
  cocreation?: CocreationExportSource | null;
  /** Part 36: the 语音反馈 page's own table (owner only). */
  feedback?: { exportSheets(filters: Record<string, unknown>): Sheet[] } | null;
}

/** What may never reach a file even inside free text a player typed: an email address, a UUID, a long hex digest. */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HEX = /\b[0-9a-f]{32,}\b/gi;
export const scrubText = (value: string) =>
  value.replace(EMAIL, '〔邮箱〕').replace(UUID, '〔编号〕').replace(HEX, '〔编号〕');
const scrub = (sheets: Sheet[]): Sheet[] =>
  sheets.map((sheet) => ({
    ...sheet,
    rows: sheet.rows.map((row) => row.map((cell) => (typeof cell === 'string' ? scrubText(cell) : cell))),
  }));

const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export class WebExportAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private readonly deps: ExportDeps;
  constructor(store: BusinessStore, clock: Clock, admin: WebAccountAdmin, deps: ExportDeps) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
    this.deps = deps;
  }

  private audit(actorId: string, kind: ExportKind, target: string) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actorId,
      `export:${kind}`,
      target.slice(0, 400),
      this.clock.now(),
    );
  }

  /** Which kinds this administrator may export (the console shows the button only for these). */
  allowed(auth: Auth): ExportKind[] {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    const grants = this.admin.session(auth.cookie).member.permissions;
    const owner = actor.role === 'owner';
    return EXPORT_KINDS.filter((kind) => this.mayExport(kind, owner, grants));
  }
  private mayExport(kind: ExportKind, owner: boolean, grants: readonly string[]) {
    switch (kind) {
      case 'conversations':
        return owner && this.deps.chatReview;
      case 'calls':
      case 'failures':
        return owner;
      case 'feedback':
        return owner && this.deps.feedback != null;
      case 'stats':
        return owner || hasStatsPermission(grants as never);
      case 'memes':
        return owner || hasCastPermission(grants as never, 'cast.read');
      case 'invites':
        return owner || hasAnyInvitePermission(grants as never);
      case 'shares':
        return owner || hasSystemPermission(grants as never);
      // These three check the permission of their own page when they read.
      case 'broadcast':
        return this.deps.broadcast != null;
      case 'rehearsal':
        return this.deps.characters != null;
      case 'cocreation':
        return this.deps.cocreation != null;
    }
  }

  /**
   * One file of an export. `input`: { kind, format, part (from 1), sheet (a CSV's table, from 0), filters }. The filters are the
   * page's own (a date range in UTC+8 days, a character, ...); anything else is refused.
   */
  export(auth: Auth, input: unknown): RenderedExport {
    ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
    const body = input as Record<string, unknown>;
    ensure(Object.keys(body).sort().join(',') === 'filters,format,kind,part,sheet', 'INVALID_REQUEST');
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    const grants = this.admin.session(auth.cookie).member.permissions;
    const kind = body.kind as ExportKind;
    ensure(EXPORT_KINDS.includes(kind), 'INVALID_REQUEST');
    ensure(body.format === 'csv' || body.format === 'xlsx', 'INVALID_REQUEST');
    ensure(
      Number.isSafeInteger(body.part) && (body.part as number) >= 1 && (body.part as number) <= 10_000,
      'INVALID_REQUEST',
    );
    ensure(
      Number.isSafeInteger(body.sheet) && (body.sheet as number) >= 0 && (body.sheet as number) < 12,
      'INVALID_REQUEST',
    );
    ensure(
      body.filters !== null && typeof body.filters === 'object' && !Array.isArray(body.filters),
      'INVALID_REQUEST',
    );
    const format = body.format as ExportFormat,
      part = body.part as number,
      sheet = body.sheet as number;
    const filters = body.filters as Record<string, unknown>;
    const owner = actor.role === 'owner';
    // The permission first, then the filters: a caller who may not export never learns what a filter would have found.
    if (kind === 'conversations') ensure(this.deps.chatReview && chatReviewTablesExist(this.store), 'NOT_FOUND');
    if (kind === 'conversations' || kind === 'calls' || kind === 'failures' || kind === 'feedback') ensure(owner, 'ADMIN_OWNER_REQUIRED');
    // Broadcast, rehearsal and co-creation check the permission of their own page when they read.
    else if (kind !== 'broadcast' && kind !== 'rehearsal' && kind !== 'cocreation')
      ensure(this.mayExport(kind, owner, grants), 'ADMIN_PERMISSION_REQUIRED');
    const now = this.clock.now();
    const { sheets, base, summary } = this.build(kind, auth, filters, now);
    const clean = scrub(sheets);
    ensure(clean.reduce((n, s) => Math.max(n, s.rows.length), 0) <= EXPORT_TOTAL_LIMIT, 'EXPORT_TOO_LARGE');
    const day = new Date(now + 8 * 3_600_000).toISOString().slice(0, 10);
    const file = renderExport(format, `${base}-${day}`, clean, { part, sheet });
    const totalRows = clean[Math.min(sheet, clean.length - 1)]?.rows.length ?? 0;
    this.audit(
      actor.memberId,
      kind,
      `${format}|part ${file.part}/${file.parts}|rows ${format === 'csv' ? totalRows : clean.reduce((n, s) => n + s.rows.length, 0)}|${summary}`,
    );
    return file;
  }

  private build(
    kind: ExportKind,
    auth: Auth,
    filters: Record<string, unknown>,
    now: number,
  ): { sheets: Sheet[]; base: string; summary: string } {
    const keys = (allowed: string[]) =>
      ensure(
        Object.keys(filters).every((key) => allowed.includes(key)),
        'INVALID_REQUEST',
      );
    const pairs = (object: Record<string, unknown>) =>
      Object.entries(object)
        .filter(([, value]) => value !== null && value !== undefined && !(Array.isArray(value) && value.length === 0))
        .map(([key, value]) => `${key}=${Array.isArray(value) ? value.length : String(value)}`)
        .join(';');
    switch (kind) {
      case 'conversations': {
        keys(['from', 'to', 'characterId', 'writer', 'model', 'status', 'players', 'scope']);
        const parsed: ConversationFilters = parseConversationFilters(filters);
        return {
          sheets: conversationSheets(conversationsFor(this.store, now, parsed)),
          base: 'conversations',
          // Players are counted, never listed: even a pseudonymous code stays out of the log.
          summary: pairs({ ...parsed }),
        };
      }
      case 'feedback': {
        keys(['range', 'characterId', 'writer', 'model', 'unheardOnly']);
        ensure(this.deps.feedback, 'NOT_FOUND');
        return { sheets: this.deps.feedback.exportSheets(filters), base: 'feedback', summary: pairs({ ...filters }) };
      }
      case 'calls': {
        keys(['from', 'to', 'provider', 'state']);
        const parsed = parseCallFilters(filters);
        return { sheets: callSheets(this.store, now, parsed), base: 'calls', summary: pairs({ ...parsed }) };
      }
      case 'failures': {
        keys(['from', 'to', 'characterId', 'writer', 'model']);
        const parsed = parseConversationFilters(filters);
        const { from, to, characterId, writer, model } = parsed;
        return {
          sheets: failureSheets(this.store, { from, to, characterId, writer, model }),
          base: 'failures',
          summary: pairs({ from, to, characterId, writer, model }),
        };
      }
      case 'stats': {
        keys(['range']);
        const range = parseStatsRange(filters.range);
        return { sheets: statsSheets(this.store, now, range), base: 'statistics', summary: `range=${range}` };
      }
      case 'memes': {
        keys(['query', 'year', 'tag', 'state']);
        const parsed = parseMemeFilters(filters);
        return { sheets: memeSheets(this.store, parsed), base: 'memes', summary: pairs({ ...parsed }) };
      }
      case 'invites':
        keys([]);
        return { sheets: inviteSheets(this.store, now), base: 'invites', summary: '' };
      case 'broadcast': {
        keys([]);
        ensure(this.deps.broadcast, 'NOT_FOUND');
        return { sheets: broadcastSheets(this.deps.broadcast.list(auth)), base: 'broadcasts', summary: '' };
      }
      case 'shares': {
        keys([]);
        ensure(this.deps.shareStats, 'NOT_FOUND');
        return { sheets: shareSheets(this.deps.shareStats()), base: 'shares', summary: '' };
      }
      case 'rehearsal': {
        keys(['characterId']);
        ensure(identifier(filters.characterId) && this.deps.characters, 'INVALID_REQUEST');
        const characters = this.deps.characters;
        const characterId = filters.characterId;
        const runs = characters.rehearsalList(auth, characterId).runs.map((info) => ({
          info: info as never,
          detail: characters.rehearsalDetail(auth, characterId, info.runId) as never,
        }));
        return { sheets: rehearsalSheets(runs), base: 'rehearsals', summary: `characterId=${characterId}` };
      }
      case 'cocreation': {
        keys(['characterId', 'status', 'starred', 'query']);
        ensure(this.deps.cocreation, 'NOT_FOUND');
        return {
          sheets: this.deps.cocreation.exportSheets(auth, filters),
          base: 'cocreation',
          summary: pairs({ ...filters, query: filters.query ? 'set' : null }),
        };
      }
    }
  }
}
