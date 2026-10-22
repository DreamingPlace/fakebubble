import { inspectErrorCode } from '../cloudflare/web-inspect.ts';
import { WEB_BUILD_COMMIT } from '../../../config/web-build.ts';
import { PRICE_RENEWAL_DUE_MS } from '../generation/web-provider-configuration.ts';
import { purgeDiagnostics } from '../identity/web-player-purge.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type {
  OverviewView,
  SystemBudgetRow,
  SystemFlags,
  SystemPriceRow,
  SystemRetention,
  SystemSecurity,
  SystemUnknownKind,
  SystemWarnings,
} from '../../../packages/contracts/web-system.ts';
import type { StageLatencyDay } from './web-account-admin.ts';

const DAY_MS = 86_400_000;
type Digest = { version: number; sha256: string };
/** What only the Worker knows (its environment, its bindings, the budget Worker, its retention ledger). Absent in a harness. */
export interface WebSystemSources {
  flags(): SystemFlags;
  /** The ledger this object runs and the one it expects: { active, inline, r2 }. */
  migrations(): { active: 'inline' | 'r2'; inline: Digest[]; r2: Digest[] };
  /** The budget Worker's summary (one RPC read). Throws when it cannot be reached. */
  budget(): Promise<unknown>;
  retention(): Promise<{
    failing: number;
    oldestAgeBucket: '<1d' | '1-7d' | '7-30d' | '>30d' | null;
    lastSuccessAt: number | null;
  } | null>;
}

const has = (store: BusinessStore, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);

/**
 * One row per (provider, model, phase): the numbers and version in force now (the highest version whose window contains now;
 * a group with none shows its latest, expired) and, as `validUntil`, how long the price is COVERED - the end of the group's latest
 * row, which is also what the renewal decides on. A row renewed ahead of time therefore stops being "expiring" at once.
 */
export function priceRows(store: BusinessStore, now: number): SystemPriceRow[] {
  if (!has(store, 'web_provider_prices')) return [];
  const groups = store.all<{ provider: string; model: string; phase: string; covered: number }>(
    `SELECT provider,model,phase,MAX(valid_until) covered FROM web_provider_prices
    GROUP BY provider,model,phase ORDER BY provider,model,phase`,
  );
  type Row = { unit: string; upper_micros_per_unit: number; version: number };
  return groups.map(({ covered, ...group }): SystemPriceRow => {
    const live = store.get<Row>(
      `SELECT unit,upper_micros_per_unit,version FROM web_provider_prices
      WHERE provider=? AND model=? AND phase=? AND valid_from<=? AND valid_until>? ORDER BY version DESC LIMIT 1`,
      group.provider,
      group.model,
      group.phase,
      now,
      now,
    );
    const row =
      live ??
      store.get<Row>(
        `SELECT unit,upper_micros_per_unit,version FROM web_provider_prices
        WHERE provider=? AND model=? AND phase=? ORDER BY valid_until DESC,version DESC LIMIT 1`,
        group.provider,
        group.model,
        group.phase,
      )!;
    return {
      ...group,
      unit: row.unit,
      upperMicrosPerUnit: row.upper_micros_per_unit,
      version: row.version,
      validUntil: covered,
      state: live ? 'in_force' : 'expired',
      daysLeft: Math.floor((covered - now) / DAY_MS),
      expiring: covered - now <= PRICE_RENEWAL_DUE_MS,
    };
  });
}

/** UNKNOWN provider calls: counts per kind and the age of the oldest (from its send time). Nothing but numbers. */
export function unknownKinds(store: BusinessStore, now: number): SystemUnknownKind[] {
  const kinds: Array<[SystemUnknownKind['kind'], string, string]> = [
    ['webProvider', 'web_provider_attempts', 'state'],
    ['external', 'web_external_attempts', 'dispatch_state'],
    ['embed', 'web_embed_attempts', 'state'],
  ];
  return kinds.map(([kind, table, state]) => {
    if (!has(store, table)) return { kind, count: 0, oldestAgeMs: null };
    const row = store.get<{ n: number; oldest: number | null }>(
      `SELECT count(*) n,min(sent_at) oldest FROM ${table} WHERE ${state}='unknown'`,
    )!;
    return { kind, count: row.n, oldestAgeMs: row.oldest === null ? null : Math.max(0, now - row.oldest) };
  });
}
/** UNKNOWN calls that appeared in the last 24 hours: the one the one-line warning on 概览 is about. */
const unknownNew = (store: BusinessStore, now: number) =>
  (
    [
      ['web_provider_attempts', 'state'],
      ['web_external_attempts', 'dispatch_state'],
      ['web_embed_attempts', 'state'],
    ] as const
  ).reduce(
    (n, [table, state]) =>
      n +
      (has(store, table)
        ? store.get<{ n: number }>(
            `SELECT count(*) n FROM ${table} WHERE ${state}='unknown' AND sent_at>?`,
            now - DAY_MS,
          )!.n
        : 0),
    0,
  );

async function retentionOf(
  store: BusinessStore,
  sources: WebSystemSources | undefined,
  now: number,
): Promise<SystemRetention> {
  const health = await sources?.retention().catch(() => null);
  if (!health) return null;
  const purge = purgeDiagnostics(store, now);
  return { ...health, purging: purge.purging, oldestPurgingMinutes: purge.oldestPurgingMinutes };
}

export async function systemWarnings(
  store: BusinessStore,
  now: number,
  sources: WebSystemSources | undefined,
): Promise<SystemWarnings> {
  return {
    priceExpiring: priceRows(store, now).filter((row) => row.expiring).length,
    retentionFailing: (await sources?.retention().catch(() => null))?.failing ?? 0,
    unknownNew: unknownNew(store, now),
  };
}

function budgetRows(summary: unknown): SystemBudgetRow[] {
  return (Array.isArray(summary) ? (summary as Record<string, unknown>[]) : []).map((row) => ({
    provider: row.provider === 'fish' ? 'fish' : 'deepseek',
    policy: row.policy === 'production-unlimited' ? 'unlimited' : 'capped',
    spentMicros: Number(row.spentMicros),
    heldMicros: Number(row.heldMicros),
    allowanceMicros: row.allowanceMicros === null ? null : Number(row.allowanceMicros),
    remainingMicros: row.remainingMicros === null ? null : Number(row.remainingMicros),
  }));
}

/** 系统状态: one read, counts and times only. `metrics` are the 技术指标 days (the old 运营数据 numbers). */
export async function readSystemStatus(
  store: BusinessStore,
  now: number,
  sources: WebSystemSources | undefined,
  extras: { metrics: StageLatencyDay[]; security: Omit<SystemSecurity, 'turnstile'> },
) {
  const flags = sources?.flags() ?? null;
  const ledger = has(store, 'cf_web_migrations')
    ? store.all<Digest>('SELECT version,sha256 FROM cf_web_migrations ORDER BY version')
    : [];
  const expected = sources?.migrations();
  const wanted = expected ? expected[expected.active] : null;
  let budget: { available: true; rows: SystemBudgetRow[] } | { available: false; error: string };
  try {
    if (!sources) throw new Error('WEB_SYSTEM_SOURCES_UNAVAILABLE');
    budget = { available: true, rows: budgetRows(await sources.budget()) };
  } catch (error) {
    budget = { available: false, error: inspectErrorCode(error) };
  }
  return {
    now,
    version: {
      commit: WEB_BUILD_COMMIT,
      migrationSteps: ledger.length,
      schemaVersion: ledger.length ? ledger[ledger.length - 1]!.version : null,
      matches: wanted
        ? ledger.length === wanted.length &&
          ledger.every((row, i) => row.version === wanted[i]!.version && row.sha256 === wanted[i]!.sha256)
        : null,
    },
    flags,
    prices: priceRows(store, now),
    budget,
    unknown: unknownKinds(store, now),
    retention: await retentionOf(store, sources, now),
    metrics: extras.metrics,
    security: { turnstile: flags?.turnstile ?? false, ...extras.security },
    warnings: await systemWarnings(store, now, sources),
  };
}
export type SystemStatusView = Awaited<ReturnType<typeof readSystemStatus>>;

/** 概览: today (UTC) from the operations table and the usage aggregates, plus the warnings. No new data model. */
export async function readOverview(
  store: BusinessStore,
  now: number,
  sources: WebSystemSources | undefined,
): Promise<OverviewView> {
  const day = new Date(now).toISOString().slice(0, 10);
  const start = Date.parse(`${day}T00:00:00Z`);
  const count = (status: string) =>
    store.get<{ n: number }>(
      'SELECT count(*) n FROM web_operations WHERE created_at>=? AND created_at<? AND status=?',
      start,
      start + DAY_MS,
      status,
    )!.n;
  const voiced = store.get<{ n: number }>(
    `SELECT count(*) n FROM web_operations o WHERE o.created_at>=? AND o.created_at<? AND o.status='published'
    AND EXISTS (SELECT 1 FROM web_publication_items i WHERE i.operation_id=o.id AND i.origin='narrative' AND i.media_id IS NOT NULL)`,
    start,
    start + DAY_MS,
  )!.n;
  return {
    day,
    today: {
      replies: count('published'),
      voiceReplies: voiced,
      failedReplies: count('failed') + count('unknown'),
      spendMicros: has(store, 'web_provider_usage')
        ? store.get<{ n: number }>('SELECT COALESCE(SUM(cost_micros),0) n FROM web_provider_usage WHERE day=?', day)!.n
        : null,
    },
    warnings: await systemWarnings(store, now, sources),
  };
}
