import { CharacterAdminClient } from './character-admin-api.ts';
import { CocreationAdminClient } from './cocreation-admin-api.ts';
import { ConversationsAdminClient } from './conversations-admin-api.ts';
import { PreviewAdminClient } from './preview-admin-api.ts';
import { InviteAdminApi } from './invite-admin-api.ts';
import { InviteLocalApiError } from './invite-local-api.ts';
import {
  parseModelAdminView,
  type ModelAdminView,
  type ModelSaveInput,
} from '../../../../packages/contracts/model-settings.ts';
import type {
  BudgetTopUpResult,
  OverviewView,
  PointsGrantResult,
  PointsPreview,
  PointsResetResult,
  PointsTarget,
  RenewPricesResult,
  SystemBudgetRow,
  SystemFlags,
  SystemPriceRow,
  SystemRetention,
  SystemSecurity,
  SystemUnknownKind,
  SystemWarnings,
} from '../../../../packages/contracts/web-system.ts';
import type {
  ChartMetric,
  ChartRange,
  ChartView,
  CostsView,
  PlayerStatsView,
  SpendView,
  StatsRange,
} from '../../../../packages/contracts/web-stats.ts';
import {
  ADMIN_PERMISSION_LIMIT,
  isAdminPermission,
  type AdminPermission,
} from '../../../../packages/contracts/web-admin-permissions.ts';

export type { AdminPermission } from '../../../../packages/contracts/web-admin-permissions.ts';
export type AdminMember = {
  id: string;
  label: string;
  role: 'owner' | 'admin';
  email: string | null;
  permissions: AdminPermission[];
  createdAt: number;
};
export type AccountAdminSession = {
  csrf: string;
  expiresAt: number;
  member: AdminMember;
  emailDeliveryAvailable: boolean;
  /** CHAT_REVIEW_ENABLED: only present while the 测试对话 page exists. */
  features?: { chatReview: true };
};
export type AdminGrant = {
  id: string;
  memberId: string;
  expiresAt: number;
  consumed: boolean;
  revokedAt: number | null;
};
type Percentiles = { samples: number; p50Ms: number | null; p95Ms: number | null };
type CacheUsage = { calls: number; hitTokens: number; missTokens: number; hitRatio: number | null };
/** 运营数据: one UTC day of operation counters (owner only; no content, no player identity). */
export type StageLatencyDay = {
  day: string;
  operations: number;
  textQueueWait: Percentiles;
  audioQueueWait: Percentiles;
  textStage: Percentiles;
  audioStage: Percentiles;
  rateLimitRetries: number;
  fallbacks: number;
  review: { samples: number; changed: number; rate: number | null };
  memoryDropped: { topics: number; facts: number };
  cache: { draft: CacheUsage; review: CacheUsage };
  embedding: {
    calls: number;
    texts: number;
    failures: number;
    unknowns: number;
    queryFallbacks: number;
    queryTimeouts: number;
  };
};
/** 系统状态 (Part 22b): one read; counts, times and prices only. */
export type SystemStatusView = {
  now: number;
  version: { commit: string; migrationSteps: number; schemaVersion: number | null; matches: boolean | null };
  flags: SystemFlags | null;
  prices: SystemPriceRow[];
  budget: { available: true; rows: SystemBudgetRow[] } | { available: false; error: string };
  unknown: SystemUnknownKind[];
  retention: SystemRetention;
  metrics: StageLatencyDay[];
  security: SystemSecurity;
  warnings: SystemWarnings;
};
/** 邀请与额度 (Part 22a): one batch as the list shows it - counts only, no player. */
export type InviteBatch = {
  id: string;
  name: string;
  tier: 'unlimited' | 'daily_refill';
  dailyAmount: number | null;
  cap: number | null;
  durationDays: number | null;
  redeemBy: number | null;
  createdAt: number;
  codes: number;
  redeemed: number;
  revoked: number;
  holders: number;
  /** Part 22d: true only on a test batch (测试组). */
  test?: true;
};
export type InviteBatchCode = {
  id: string;
  serial: number;
  state: 'unused' | 'redeemed' | 'revoked' | 'ended' | 'expired';
  redeemedAt: number | null;
  expiresAt: number | null;
  /** The holder's 玩家编号 - never an id or an email. */
  playerNumber: string | null;
  /**
   * Part 22a2. The server decides: 'plain' = `code` is the code, 'masked' = this administrator may not see it (`code` is
   * ********), 'legacy' = made before codes were kept, only a digest exists (`code` is null). Absent = legacy.
   */
  code?: string | null;
  codeView?: 'plain' | 'masked' | 'legacy';
};
export type NewInviteBatch = {
  requestId: string;
  name: string;
  count: number;
  tier: { kind: 'unlimited' } | { kind: 'daily_refill'; dailyAmount: number; cap: number };
  durationDays: number | null;
  redeemBy: number | null;
  /** Part 22d: a test batch (测试组); set here at creation and never changed. Omitted = not a test batch. */
  test?: boolean;
};
const invalid = () => new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  return value;
}
function time(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid();
  return value as number;
}
function member(value: unknown): AdminMember {
  const row = object(value),
    role = row.role,
    permissions = row.permissions;
  if (
    !['owner', 'admin'].includes(role as string) ||
    !(row.email === null || typeof row.email === 'string') ||
    !Array.isArray(permissions) ||
    permissions.length > ADMIN_PERMISSION_LIMIT ||
    new Set(permissions).size !== permissions.length ||
    !permissions.every(isAdminPermission)
  )
    throw invalid();
  return {
    id: string(row.id),
    label: string(row.label),
    role: role as AdminMember['role'],
    email: row.email as string | null,
    createdAt: time(row.createdAt),
    permissions: permissions as AdminPermission[],
  };
}
function challenge(value: unknown) {
  const row = object(value);
  return { challengeId: string(row.challengeId), expiresAt: time(row.expiresAt) };
}
export class AccountAdminApi extends InviteAdminApi {
  readonly characters = new CharacterAdminClient((path, body) => this.request('/characters/' + path, body));
  readonly previews = new PreviewAdminClient(
    (path, body) => this.request('/characters/' + path, body),
    (path, body) => this.request('/eval-sets/' + path, body),
  );
  readonly cocreation = new CocreationAdminClient((path, body) => this.request('/cocreation/' + path, body));
  readonly conversations = new ConversationsAdminClient((path, body) => this.request('/conversations/' + path, body));
  constructor(fetcher?: typeof fetch) {
    super(fetcher, '/api/web/provider/admin');
  }
  /**
   * The admin CSRF token is derived from the session cookie, which the browser shares between tabs. A login, email
   * login or password change in one tab replaces the cookie, and every other open tab then still holds the previous
   * token: its calls (the preview status poller above all) get 403 ADMIN_CSRF_REQUIRED although the session is fine.
   * That check runs before anything is done, so one transparent re-sync and retry is safe. A session that is really
   * gone answers 401 on the re-sync and surfaces as such; any other 403 (a missing permission) is never retried.
   */
  protected override async request(path: string, body?: Record<string, unknown>) {
    try {
      return await super.request(path, body);
    } catch (error) {
      if (
        !body ||
        !this.csrf ||
        path === '/login' ||
        !(error instanceof InviteLocalApiError) ||
        error.status !== 403 ||
        error.code !== 'ADMIN_CSRF_REQUIRED'
      )
        throw error;
      const fresh = object(await super.request('/session'));
      if (typeof fresh.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(fresh.csrf)) throw invalid();
      this.csrf = fresh.csrf;
      return await super.request(path, body);
    }
  }
  private active(value: unknown): AccountAdminSession {
    const row = object(value);
    if (
      typeof row.csrf !== 'string' ||
      !/^[a-f0-9]{64}$/.test(row.csrf) ||
      typeof row.emailDeliveryAvailable !== 'boolean'
    )
      throw invalid();
    const active = {
      csrf: row.csrf,
      expiresAt: time(row.expiresAt),
      member: member(row.member),
      emailDeliveryAvailable: row.emailDeliveryAvailable,
      ...(object(row.features ?? {}).chatReview === true ? { features: { chatReview: true as const } } : {}),
    };
    this.csrf = active.csrf;
    return active;
  }
  override async login(token: string) {
    this.csrf = null;
    return this.active(await this.request('/login', { token }));
  }
  override async restore() {
    this.csrf = null;
    return this.active(await this.request('/session'));
  }
  async emailLogin(email: string, password: string) {
    this.csrf = null;
    return this.active(await this.request('/email/login', { email, password }));
  }
  async bindStart(email: string) {
    return challenge(await this.request('/email/bind/start', { email }));
  }
  async bindFinish(challengeId: string, code: string, password: string) {
    return this.active(await this.request('/email/bind/finish', { challengeId, code, password }));
  }
  async resetStart(email: string) {
    return challenge(await this.request('/email/reset/start', { email }));
  }
  async resetFinish(challengeId: string, code: string, password: string) {
    if (object(await this.request('/email/reset/finish', { challengeId, code, password })).reset !== true)
      throw invalid();
    this.csrf = null;
  }
  async members() {
    const row = object(await this.request('/members/list', {}));
    if (!Array.isArray(row.members) || !Array.isArray(row.grants)) throw invalid();
    return {
      members: row.members.map(member),
      grants: row.grants.map((value) => {
        const grant = object(value);
        if (grant.consumed !== 0 && grant.consumed !== 1) throw invalid();
        return {
          id: string(grant.id),
          memberId: string(grant.memberId),
          expiresAt: time(grant.expiresAt),
          consumed: grant.consumed === 1,
          revokedAt: grant.revokedAt === null ? null : time(grant.revokedAt),
        };
      }),
    };
  }
  async issueMember(input: {
    requestId: string;
    label: string;
    memberId: string | null;
    permissions: AdminPermission[];
  }) {
    const row = object(await this.request('/members/issue', input));
    if (
      typeof row.duplicate !== 'boolean' ||
      !(row.token === null || (typeof row.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.token))) ||
      row.duplicate !== (row.token === null)
    )
      throw invalid();
    return {
      memberId: string(row.memberId),
      grantId: string(row.grantId),
      token: row.token as string | null,
      duplicate: row.duplicate,
    };
  }
  async setPermissions(memberId: string, permissions: AdminPermission[], expectedPermissions?: AdminPermission[]) {
    return member(
      object(
        await this.request('/members/permissions', {
          memberId,
          permissions,
          ...(expectedPermissions === undefined ? {} : { expectedPermissions }),
        }),
      ).member,
    );
  }
  async revokeCredential(grantId: string) {
    if (object(await this.request('/members/revoke-credential', { grantId })).revoked !== true) throw invalid();
  }
  /** Owner-only; the server rejects everyone else. Days are newest first. */
  async stageLatency(days = 14): Promise<StageLatencyDay[]> {
    const row = object(await this.request('/metrics/stage-latency', { days }));
    if (!Array.isArray(row.days)) throw invalid();
    return row.days.map((value) => {
      const day = object(value);
      if (typeof day.day !== 'string' || !Number.isSafeInteger(day.operations)) throw invalid();
      return day as unknown as StageLatencyDay;
    });
  }
  /** 系统 → 模型与价格: any administrator may read. A response that is not exactly the documented shape is rejected. */
  async modelSettings(): Promise<ModelAdminView> {
    const view = parseModelAdminView(await this.request('/models/read', {}));
    if (!view) throw invalid();
    return view;
  }
  /** The owner, or an administrator holding models.manage; the server checks again. */
  async saveModelSettings(input: ModelSaveInput) {
    const row = object(await this.request('/models/save', input as unknown as Record<string, unknown>));
    if (
      !Number.isSafeInteger(row.revision) ||
      !Number.isSafeInteger(row.priceVersion) ||
      !Number.isSafeInteger(row.changes) ||
      typeof row.duplicate !== 'boolean'
    )
      throw invalid();
    return row as { revision: number; priceVersion: number; changes: number; duplicate: boolean };
  }
  /** 概览: any administrator. */
  async overview(): Promise<OverviewView> {
    const row = object(await this.request('/overview/read', {}));
    object(row.today);
    object(row.warnings);
    if (row.stats !== null && row.stats !== undefined) object(row.stats);
    if (typeof row.day !== 'string') throw invalid();
    return row as unknown as OverviewView;
  }
  /** 系统状态: the owner or system.read. */
  async systemStatus(): Promise<SystemStatusView> {
    const row = object(await this.request('/system/status', {}));
    if (!Array.isArray(row.prices) || !Array.isArray(row.metrics) || !Array.isArray(row.unknown)) throw invalid();
    object(row.version);
    object(row.security);
    object(row.warnings);
    return row as unknown as SystemStatusView;
  }
  /** Owner only. The same renewal the operator command runs. */
  async renewPrices(requestId: string): Promise<RenewPricesResult> {
    const row = object(await this.request('/system/renew-prices', { requestId }));
    if (!Array.isArray(row.rows) || typeof row.duplicate !== 'boolean') throw invalid();
    return row as unknown as RenewPricesResult;
  }
  /** Owner only: dollars 1–50 for a capped provider. */
  async budgetTopUp(input: { requestId: string; provider: 'deepseek' | 'fish'; dollars: number }) {
    const row = object(await this.request('/system/budget-topup', input));
    if (!Number.isSafeInteger(row.allowanceMicros) || typeof row.duplicate !== 'boolean') throw invalid();
    return row as unknown as BudgetTopUpResult;
  }
  /** What a grant would do, and the one lookup (an email answers 玩家编号, tier and balance only). */
  async pointsPreview(target: PointsTarget, amount: number): Promise<PointsPreview> {
    const row = object(await this.request('/points/preview', { target, amount }));
    if (!Number.isSafeInteger(row.granted)) throw invalid();
    return row as unknown as PointsPreview;
  }
  async pointsGrant(input: {
    requestId: string;
    target: PointsTarget;
    amount: number;
    note: string;
  }): Promise<PointsGrantResult> {
    const row = object(await this.request('/points/grant', input));
    if (!Number.isSafeInteger(row.granted) || typeof row.duplicate !== 'boolean') throw invalid();
    return row as unknown as PointsGrantResult;
  }
  /** Owner only. */
  async resetPreview(): Promise<PointsResetResult> {
    const row = object(await this.request('/points/reset-preview', {}));
    if (!Number.isSafeInteger(row.affected)) throw invalid();
    return row as unknown as PointsResetResult;
  }
  /** Owner only. */
  async resetPoints(requestId: string): Promise<PointsResetResult> {
    const row = object(await this.request('/points/reset', { requestId }));
    if (!Number.isSafeInteger(row.affected) || typeof row.duplicate !== 'boolean') throw invalid();
    return row as unknown as PointsResetResult;
  }
  /** 玩家统计 (Part 22c): the owner or stats.read. */
  async playerStats(range: StatsRange): Promise<PlayerStatsView> {
    const row = object(await this.request('/stats/players', { range }));
    if (!Array.isArray(row.days) || !Array.isArray(row.byCharacter) || !Array.isArray(row.byModel)) throw invalid();
    object(row.totals);
    return row as unknown as PlayerStatsView;
  }
  /** 导出表格 of the daily table: a CSV (UTF-8 BOM) built by the server, audited there. */
  async exportPlayerStats(range: StatsRange): Promise<{ csv: string; rows: number }> {
    const row = object(await this.request('/stats/players-export', { range }));
    return { csv: string(row.csv), rows: time(row.rows) };
  }
  /** 消耗表 (Part 22c): the owner or stats.read. */
  async costs(range: StatsRange): Promise<CostsView> {
    const row = object(await this.request('/stats/costs', { range }));
    if (!Array.isArray(row.rows) || !Array.isArray(row.daily) || typeof row.usdCny !== 'number') throw invalid();
    object(row.month);
    return row as unknown as CostsView;
  }
  /** 总览 chart (Part 22d): replies or chat users, per character and in total. */
  async chart(metric: ChartMetric, range: ChartRange): Promise<ChartView> {
    const row = object(await this.request('/stats/chart', { metric, range }));
    if (!Array.isArray(row.buckets) || !Array.isArray(row.total) || !Array.isArray(row.characters)) throw invalid();
    return row as unknown as ChartView;
  }
  /** 消耗表 by user type (Part 22d) with the alert line and the real price changes (Part 24b-1). */
  async spendByType(range: StatsRange): Promise<SpendView> {
    const row = object(await this.request('/stats/spend-by-type', { range }));
    if (!Array.isArray(row.days) || !Array.isArray(row.priceChanges) || typeof row.usdCny !== 'number') throw invalid();
    return row as unknown as SpendView;
  }
  async exportCosts(range: StatsRange): Promise<{ csv: string; rows: number }> {
    const row = object(await this.request('/stats/costs-export', { range }));
    return { csv: string(row.csv), rows: time(row.rows) };
  }
  /** The batches, newest first (needs the owner role or invites.manage). */
  async inviteBatches(): Promise<InviteBatch[]> {
    const row = object(await this.request('/invites/batch-list', {}));
    if (!Array.isArray(row.batches)) throw invalid();
    return row.batches.map((value): InviteBatch => {
      const b = object(value);
      if (!['unlimited', 'daily_refill'].includes(String(b.tier))) throw invalid();
      const optional = (v: unknown) => (v === null ? null : time(v));
      return {
        id: string(b.id),
        name: string(b.name),
        tier: b.tier as InviteBatch['tier'],
        dailyAmount: optional(b.dailyAmount),
        cap: optional(b.cap),
        durationDays: optional(b.durationDays),
        redeemBy: optional(b.redeemBy),
        createdAt: time(b.createdAt),
        codes: time(b.codes),
        redeemed: time(b.redeemed),
        revoked: time(b.revoked),
        holders: time(b.holders),
        ...(b.test === true ? { test: true as const } : {}),
      };
    });
  }
  async inviteBatchDetail(batchId: string): Promise<InviteBatchCode[]> {
    const row = object(await this.request('/invites/batch-detail', { batchId }));
    if (!Array.isArray(row.codes)) throw invalid();
    return row.codes.map((value): InviteBatchCode => {
      const c = object(value);
      if (!['unused', 'redeemed', 'revoked', 'ended', 'expired'].includes(String(c.state))) throw invalid();
      const optional = (v: unknown) => (v === null ? null : time(v));
      if (c.codeView !== undefined && !['plain', 'masked', 'legacy'].includes(String(c.codeView))) throw invalid();
      const codeView = c.codeView;
      const codeText = c.code === null || c.code === undefined ? null : string(c.code);
      return {
        id: string(c.id),
        serial: time(c.serial),
        state: c.state as InviteBatchCode['state'],
        redeemedAt: optional(c.redeemedAt),
        expiresAt: optional(c.expiresAt),
        playerNumber: c.playerNumber === null ? null : string(c.playerNumber),
        ...(c.codeView === undefined ? {} : { codeView: codeView as 'plain' | 'masked' | 'legacy', code: codeText }),
      };
    });
  }
  /** 导出表格: the batch as a CSV (UTF-8 BOM) under the same masking rule as the detail; the export is audit-logged. */
  async exportInviteBatch(batchId: string): Promise<{ csv: string; rows: number }> {
    const row = object(await this.request('/invites/batch-export', { batchId }));
    return { csv: string(row.csv), rows: time(row.rows) };
  }
  /** The codes come back ONCE (a replay of the same requestId answers `codes: null`). */
  async createInviteBatch(input: NewInviteBatch) {
    const row = object(await this.request('/invites/batch-create', input as unknown as Record<string, unknown>));
    if (typeof row.duplicate !== 'boolean' || !(row.codes === null || Array.isArray(row.codes))) throw invalid();
    return {
      batchId: string(row.batchId),
      duplicate: row.duplicate,
      codes: row.codes === null ? null : (row.codes as unknown[]).map(string),
    };
  }
  /** Owner only. */
  async editInviteBatch(input: { requestId: string; batchId: string; dailyAmount: number; cap: number }) {
    const row = object(await this.request('/invites/batch-edit', input));
    if (typeof row.duplicate !== 'boolean') throw invalid();
    return { batchId: string(row.batchId), duplicate: row.duplicate, holders: Number(row.holders ?? 0) };
  }
  async revokeInviteBatch(batchId: string) {
    const row = object(await this.request('/invites/batch-revoke', { batchId }));
    return { revoked: time(row.revoked) };
  }
  /** One UNREDEEMED code. */
  async revokeTierCode(id: string) {
    await this.request('/invites/tier-code-revoke', { id });
  }
  /** End a redeemed code's entitlement now. */
  async revokeEntitlement(id: string) {
    await this.request('/invites/entitlement-revoke', { id });
  }
}
