import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  hasPointsPermission,
  hasStatsPermission,
  hasSystemPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { BUDGET_TOPUP_LIMITS } from '../../../packages/contracts/web-system.ts';
import type {
  BudgetTopUpResult,
  OverviewView,
  PointsGrantResult,
  PointsPreview,
  PointsResetResult,
  PriceRenewalRow,
  RenewPricesResult,
} from '../../../packages/contracts/web-system.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import type { ChartView, CostsView, PlayerStatsView, SpendView } from '../../../packages/contracts/web-stats.ts';
import {
  cocreationPointsTablesExist,
  readCocreationPoints,
  saveCocreationPoints,
} from '../cocreation/web-cocreation-points.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { ModelFlags } from '../admission/web-model-settings.ts';
import { bucketProviders } from '../budget/web-provider-budget-contract.ts';
import type { PriceRenewal } from '../generation/web-provider-configuration.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import { once, requestHash, type WebSecurityCounters } from './web-admin-actions.ts';
import {
  emailDigest,
  grantToPlayers,
  highestMicrosPerPoint,
  parseAmount,
  parseNote,
  parseTarget,
  requirePoints,
  resetAll,
  selectPlayers,
} from './web-points-admin.ts';
import { readOverview, readSystemStatus, type WebSystemSources } from './web-system-status.ts';
import {
  costsCsv,
  parseChart,
  parseRange,
  playerStatsCsv,
  readChart,
  readCosts,
  readOverviewStats,
  readPlayerStats,
  readSpend,
} from './web-stats-admin.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
type Store = BusinessStore & ModelFlags;
/** What the Worker gives the console beyond reading: the same price renewal the operator runs, and the budget Worker's top-up. */
export interface WebSystemOps extends WebSystemSources {
  renewPrices(): PriceRenewal[];
  topUp?(requestId: string, provider: 'deepseek' | 'fish', micros: number): Promise<BudgetTopUpResult>;
}
const object = (value: unknown) => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
  return value as Record<string, unknown>;
};
const exactly = (value: unknown, keys: string[]) => {
  const body = object(value);
  ensure(Object.keys(body).sort().join(',') === [...keys].sort().join(','), 'INVALID_REQUEST');
  return body;
};
class Rollback extends Error {
  readonly value: unknown;
  constructor(value: unknown) {
    super('ROLLBACK');
    this.value = value;
  }
}

/**
 * The console's system pages (Part 22b): 概览, 系统状态 and its owner-only buttons, 积分发放 and 重置全部额度. The business object is
 * the only writer; every call needs the session, CSRF and Origin of any administrator write, then its own permission, THEN the
 * body is read (a refused administrator learns nothing about the body). Owner-only actions never accept a permission in place of
 * the owner role. Every action is idempotent per request id and writes one audit row (action, administrator, a target that is
 * never an email: a keyed digest for a lookup).
 */
export class WebSystemAdmin {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private readonly ops: WebSystemOps | undefined;
  private readonly security: WebSecurityCounters;
  private readonly emailKey: Buffer;
  constructor(
    store: BusinessStore,
    clock: Clock,
    admin: WebAccountAdmin,
    options: { ops?: WebSystemOps | undefined; security: WebSecurityCounters; emailKey: Buffer },
  ) {
    this.store = store as Store;
    this.clock = clock;
    this.admin = admin;
    this.ops = options.ops;
    this.security = options.security;
    this.emailKey = options.emailKey;
  }
  private actor(auth: Auth, need: 'any' | 'system' | 'points' | 'stats' | 'owner') {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    if (need === 'any') return actor;
    if (need === 'owner') {
      ensure(actor.role === 'owner', 'ADMIN_OWNER_REQUIRED');
      return actor;
    }
    const granted = this.admin.session(auth.cookie).member.permissions;
    ensure(
      actor.role === 'owner' ||
        (need === 'system'
          ? hasSystemPermission(granted)
          : need === 'stats'
            ? hasStatsPermission(granted)
            : hasPointsPermission(granted)),
      'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  private audit(actorId: string, action: string, target: string) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actorId,
      action,
      target,
      this.clock.now(),
    );
  }

  /** 概览: any administrator who can log in. */
  async overview(auth: Auth): Promise<OverviewView> {
    const actor = this.actor(auth, 'any');
    const view = await readOverview(this.store, this.clock.now(), this.ops);
    // Part 22c: yesterday's numbers and this month's spend are 玩家统计 / 消耗表 data: only for the owner and stats.read.
    const stats =
      actor.role === 'owner' || hasStatsPermission(this.admin.session(auth.cookie).member.permissions)
        ? readOverviewStats(this.store, this.clock.now())
        : null;
    return { ...view, stats };
  }

  /** 玩家统计: the owner or stats.read. The range is read AFTER the permission, like every administrator body. */
  playerStats(auth: Auth, input: unknown): PlayerStatsView {
    this.actor(auth, 'stats');
    return readPlayerStats(this.store, this.clock.now(), parseRange(exactly(input, ['range']).range));
  }
  /** 导出表格 of the same table: a CSV with a UTF-8 BOM; the administrator, the range and the row count are audited. */
  exportPlayerStats(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'stats');
    const view = readPlayerStats(this.store, this.clock.now(), parseRange(exactly(input, ['range']).range));
    this.audit(actor.memberId, 'stats-export:players', `${view.range}d/${view.days.length}`);
    return { csv: playerStatsCsv(view), rows: view.days.length };
  }
  /** 消耗表: the owner or stats.read. */
  costs(auth: Auth, input: unknown): CostsView {
    this.actor(auth, 'stats');
    return readCosts(this.store, this.clock.now(), parseRange(exactly(input, ['range']).range));
  }
  /** 总览 chart (Part 22d): replies or chat users, 24h hourly or 7d / 14d daily, per character and in total. Counts only. */
  chart(auth: Auth, input: unknown): ChartView {
    this.actor(auth, 'stats');
    const { metric, range } = parseChart(exactly(input, ['metric', 'range']));
    return readChart(this.store, this.clock.now(), metric, range);
  }
  /** 消耗表 by user type (Part 22d): per day, user type and text / voice, in USD micros with the rate the page uses. */
  spendByType(auth: Auth, input: unknown): SpendView {
    this.actor(auth, 'stats');
    return readSpend(
      this.store,
      this.clock.now(),
      parseRange(exactly(input, ['range']).range),
      this.ops?.alertDailySpendMicros?.() ?? null,
    );
  }
  exportCosts(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'stats');
    const view = readCosts(this.store, this.clock.now(), parseRange(exactly(input, ['range']).range));
    this.audit(actor.memberId, 'stats-export:costs', `${view.range}d/${view.rows.length}`);
    return { csv: costsCsv(view), rows: view.rows.length };
  }

  /** 系统状态: the owner or system.read. Read-only. */
  status(auth: Auth) {
    this.actor(auth, 'system');
    const now = this.clock.now();
    return readSystemStatus(this.store, now, this.ops, {
      metrics: this.admin.stageLatencyRows(31).days,
      security: this.security.read(now),
    });
  }

  /** 续期价格 (owner only): the very function the operator's renew-prices runs, then the rows it left. */
  renewPrices(auth: Auth, input: unknown): RenewPricesResult {
    const actor = this.actor(auth, 'owner');
    const body = exactly(input, ['requestId']);
    ensure(this.ops, 'SYSTEM_UNAVAILABLE');
    const ops = this.ops;
    return once(
      this.store,
      this.clock.now(),
      {
        requestId: body.requestId,
        action: 'renew-prices',
        hash: requestHash({ action: 'renew-prices' }),
        adminId: actor.memberId,
      },
      () => {
        const rows = ops.renewPrices().map((row): PriceRenewalRow => {
          const price = this.store.get<{ upper_micros_per_unit: number; version: number }>(
            `SELECT upper_micros_per_unit,version FROM web_provider_prices
            WHERE provider=? AND model=? AND phase=? AND valid_until=? ORDER BY version DESC LIMIT 1`,
            row.provider,
            row.model,
            row.phase,
            row.validUntil,
          );
          return {
            provider: row.provider,
            model: row.model,
            phase: row.phase,
            result: row.result,
            validUntil: row.validUntil,
            upperMicrosPerUnit: price?.upper_micros_per_unit ?? 0,
            version: price?.version ?? 0,
          };
        });
        this.audit(
          actor.memberId,
          'prices-renewed',
          `${rows.filter((r) => r.result === 'renewed').length}/${rows.length}`,
        );
        return { rows };
      },
    );
  }

  /**
   * 预算充值 (owner only): USD 1-50 added to a CAPPED provider's allowance by the budget Worker (idempotent there too). A provider
   * with an unlimited policy has no allowance and refuses. The local per-instance ceiling (a copy of the same cap, USD 3 at most by
   * its schema) is lifted for that bucket's providers where the schema allows it: the budget Worker stays the authority.
   */
  async budgetTopUp(auth: Auth, input: unknown): Promise<BudgetTopUpResult> {
    const actor = this.actor(auth, 'owner');
    const body = exactly(input, ['requestId', 'provider', 'dollars']);
    ensure(
      (body.provider === 'deepseek' || body.provider === 'fish') &&
        Number.isSafeInteger(body.dollars) &&
        (body.dollars as number) >= BUDGET_TOPUP_LIMITS.minDollars &&
        (body.dollars as number) <= BUDGET_TOPUP_LIMITS.maxDollars,
      'INVALID_REQUEST',
    );
    ensure(this.ops?.topUp, 'SYSTEM_UNAVAILABLE');
    const provider = body.provider as 'deepseek' | 'fish',
      dollars = body.dollars as number;
    let result: BudgetTopUpResult;
    try {
      result = await this.ops.topUp(body.requestId as string, provider, dollars * 1_000_000);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      throw new DomainError(
        code === 'WEB_BUDGET_TOPUP_UNLIMITED'
          ? 'BUDGET_UNLIMITED'
          : code === 'WEB_BUDGET_TOPUP_CONFLICT'
            ? 'IDEMPOTENCY_CONFLICT'
            : code === 'WEB_BUDGET_TOPUP_INVALID'
              ? 'INVALID_REQUEST'
              : 'BUDGET_UNAVAILABLE',
      );
    }
    return once(
      this.store,
      this.clock.now(),
      {
        requestId: body.requestId,
        action: 'budget-topup',
        hash: requestHash({ action: 'budget-topup', provider, dollars }),
        adminId: actor.memberId,
      },
      () => {
        this.liftLocalCap(provider);
        this.audit(actor.memberId, `budget-topup:${provider}`, `${dollars}`);
        const { duplicate: _duplicate, ...stored } = result;
        return stored;
      },
    );
  }
  private liftLocalCap(provider: 'deepseek' | 'fish') {
    const column = this.store.get<{ notnull: number }>(
      "SELECT \"notnull\" FROM pragma_table_info('web_provider_spending') WHERE name='limit_micros'",
    );
    // The inline (Node) schema declares the column NOT NULL and cannot lift it; the cloud schema allows NULL (uncapped locally).
    if (!column || column.notnull === 1) return;
    for (const name of bucketProviders(provider))
      this.store.run(
        'UPDATE web_provider_spending SET limit_micros=NULL WHERE provider=? AND limit_micros IS NOT NULL',
        name,
      );
  }

  private grantInput(input: unknown, withRequest: boolean) {
    const body = exactly(input, withRequest ? ['requestId', 'target', 'amount', 'note'] : ['target', 'amount']);
    return {
      requestId: body.requestId,
      target: parseTarget(body.target),
      amount: parseAmount(body.amount),
      note: withRequest ? parseNote(body.note) : null,
    };
  }
  private select(adminId: string, target: ReturnType<typeof parseTarget>, peer: string | undefined) {
    // An email is the one selector that reveals whether an address is registered: it is rate-limited per address owner like a login.
    if (target.kind === 'email') {
      ensure(peer, 'WEB_TRUSTED_IP_REQUIRED');
      this.admin.guard('points-email', peer);
    }
    return selectPlayers(
      this.store,
      this.clock.now(),
      target,
      (action, label) => this.audit(adminId, action, label),
      this.emailKey,
    );
  }

  /** What a grant would do, exactly (the same code, rolled back): the numbers of the confirm dialog. Also the one lookup. */
  pointsPreview(auth: Auth, input: unknown, peer?: string): PointsPreview {
    const actor = this.actor(auth, 'points');
    const { target, amount } = this.grantInput(input, false);
    requirePoints(this.store);
    const selection = this.select(actor.memberId, target, peer);
    const now = this.clock.now();
    let result: ReturnType<typeof grantToPlayers>;
    try {
      this.store.transaction(() => {
        throw new Rollback(grantToPlayers(this.store, now, actor.memberId, selection, amount));
      });
      throw new DomainError('INTERNAL_ERROR');
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      result = error.value as typeof result;
    }
    return { ...result, duplicate: false, ...(selection.player ? { player: selection.player.lookup } : {}) };
  }

  /** Part 24c: the three numbers of points for co-creation notes and the revision they are saved under (owner or points.grant). */
  cocreationPoints(auth: Auth, input: unknown) {
    this.actor(auth, 'points');
    exactly(input, []);
    ensure(cocreationPointsTablesExist(this.store), 'COCREATION_UNAVAILABLE');
    return readCocreationPoints(this.store);
  }
  /** Saves them (compare-and-swap on the revision; validated ranges; the audit row has the numbers only). */
  saveCocreationPoints(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'points');
    object(input);
    return this.store.transaction(() => saveCocreationPoints(this.store, this.clock.now(), actor.memberId, input));
  }

  /** 积分发放 to the selected players (owner or points.grant). One 'grant' event per player that receives points. */
  pointsGrant(auth: Auth, input: unknown, peer?: string): PointsGrantResult {
    const actor = this.actor(auth, 'points');
    const { requestId, target, amount, note } = this.grantInput(input, true);
    requirePoints(this.store);
    const now = this.clock.now();
    const hash = requestHash({
      action: 'points-grant',
      target: target.kind === 'email' ? { kind: 'email', digest: emailDigest(this.emailKey, target.email) } : target,
      amount,
      note,
    });
    // The lookup (and its audit row) happens before the transaction, so a refused or unknown address is audited too.
    const selection = this.select(actor.memberId, target, peer);
    return once(this.store, now, { requestId, action: 'points-grant', hash, adminId: actor.memberId, note }, () => {
      const result = grantToPlayers(this.store, now, actor.memberId, selection, amount);
      this.audit(actor.memberId, 'points-grant', `${target.kind}:${result.granted}/${result.totalPoints}`);
      return result;
    });
  }

  private resetEstimate(totalPoints: number) {
    const per = highestMicrosPerPoint(this.store, this.clock.now());
    return per === null ? null : totalPoints * per;
  }
  /** The numbers of the 重置全部额度 dialog (owner only): accounts, points and the worst-case cost. Writes nothing. */
  resetPreview(auth: Auth, input: unknown): PointsResetResult {
    const actor = this.actor(auth, 'owner');
    exactly(input, []);
    requirePoints(this.store);
    const now = this.clock.now();
    try {
      this.store.transaction(() => {
        throw new Rollback(resetAll(this.store, now, actor.memberId));
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
      const result = error.value as ReturnType<typeof resetAll>;
      return { ...result, worstCaseMicros: this.resetEstimate(result.totalPoints), duplicate: false };
    }
    throw new DomainError('INTERNAL_ERROR');
  }

  /** 重置全部额度 (owner only): registered → 100 if below; daily_refill → +7 × N on top of the balance, never above the cap; never lowers; one 'reset' event per player. */
  resetPoints(auth: Auth, input: unknown): PointsResetResult {
    const actor = this.actor(auth, 'owner');
    const body = exactly(input, ['requestId']);
    requirePoints(this.store);
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'points-reset',
        hash: requestHash({ action: 'points-reset' }),
        adminId: actor.memberId,
      },
      () => {
        const result = resetAll(this.store, now, actor.memberId);
        this.audit(actor.memberId, 'points-reset', `${result.affected}/${result.totalPoints}`);
        return { ...result, worstCaseMicros: this.resetEstimate(result.totalPoints) };
      },
    );
  }
}
