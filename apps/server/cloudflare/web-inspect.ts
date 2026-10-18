import { purgeDiagnostics } from '../identity/web-player-purge.ts';
import { currentPrices } from '../admission/web-model-settings.ts';
import { WEB_BUILD_COMMIT } from '../../../config/web-build.ts';

/** Read-only operator view of the business authority: SELECT statements only, never content or secrets. */
export interface WebInspectReader {
  all<T>(sql: string, ...params: (string | number)[]): T[];
}
export interface WebMigrationDigest {
  version: number;
  sha256: string;
}
export interface WebInspectExpected {
  /** Which list this object actually runs (R2 mode is the deployed one). */
  active: 'inline' | 'r2';
  inline: WebMigrationDigest[];
  r2: WebMigrationDigest[];
}
export interface WebInspectFlags {
  PUBLIC_ENABLED?: string | undefined;
  EXTERNAL_CALLS?: string | undefined;
  OPERATOR_ENABLED?: string | undefined;
  EMBEDDINGS_ENABLED?: string | undefined;
}
/** Player email accounts (schema 118): configuration only. Never an address, a sender or a binding's contents. */
export interface WebInspectPlayers {
  PLAYER_SIGNUP_ENABLED?: string | undefined;
  PLAYER_EMAIL_DAILY_CAP?: string | undefined;
  /** Whether the PLAYER_EMAIL send binding exists. */
  emailBindingPresent?: boolean | undefined;
}
export interface WebInspectBudgetRow {
  provider: string;
  spentMicros: number;
  heldMicros: number;
}
export type WebInspectBudget =
  | { available: true; providers: WebInspectBudgetRow[] }
  | { available: false; error: string };
export interface WebUnknownAttempts {
  tablePresent: boolean;
  count: number;
  /** Identifiers only (never request, response or message content); capped, `count` stays exact. */
  ids: string[];
  truncated: boolean;
}
export interface WebInspectPrice {
  provider: string;
  model: string;
  phase: string;
  /** The row in force now, or null when none is (an expired price fails closed with WEB_PROVIDER_PRICE_REQUIRED). */
  inForce: { id: string; validUntil: number; version: number; upperMicrosPerUnit: number } | null;
  latestValidUntil: number;
}
/** Part 17g, counts and a time only: principals whose purge is failing now, how long the oldest has been due, when a purge last completed. */
export interface WebInspectRetentionHealth {
  failing: number;
  oldestAgeBucket: '<1d' | '1-7d' | '7-30d' | '>30d' | null;
  lastSuccessAt: number | null;
}
const ID_LIMIT = 200;
const flag = (value: unknown) => (value === undefined ? null : value === 'true' || value === 'false' ? value : 'other');
const digestRows = (rows: { version: number; sha256: string }[]): WebMigrationDigest[] =>
  rows.map((row) => ({ version: row.version, sha256: row.sha256 }));
/** Budget failures are reported as a bounded error code, never an arbitrary message. */
export const inspectErrorCode = (error: unknown) =>
  error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)
    ? error.message
    : 'WEB_INSPECT_BUDGET_UNAVAILABLE';

export function inspectBudget(summary: unknown): WebInspectBudget {
  const rows = Array.isArray(summary) ? (summary as Record<string, unknown>[]) : [];
  return {
    available: true,
    providers: rows.map((row) => ({
      provider: String(row.provider),
      spentMicros: Number(row.spentMicros),
      heldMicros: Number(row.heldMicros),
    })),
  };
}

export function inspectWebAuthority(
  reader: WebInspectReader,
  expected: WebInspectExpected,
  flags: WebInspectFlags,
  budget: WebInspectBudget,
  players: WebInspectPlayers = {},
  now: number = Date.now(),
  retentionHealth: WebInspectRetentionHealth | null = null,
) {
  const has = (name: string) =>
    reader.all<{ n: number }>('SELECT 1 AS n FROM sqlite_master WHERE name=?', name).length > 0;
  const unknowns = (table: string, state: string, id: string): WebUnknownAttempts => {
    if (!has(table)) return { tablePresent: false, count: 0, ids: [], truncated: false };
    const count = reader.all<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE ${state}='unknown'`)[0]!.n;
    const ids = reader
      .all<{ id: string }>(`SELECT ${id} AS id FROM ${table} WHERE ${state}='unknown' ORDER BY 1 LIMIT ${ID_LIMIT}`)
      .map((row) => row.id);
    return { tablePresent: true, count, ids, truncated: count > ids.length };
  };
  const applied = has('cf_web_migrations')
    ? digestRows(
        reader.all<{ version: number; sha256: string }>(
          'SELECT version,sha256 FROM cf_web_migrations ORDER BY version',
        ),
      )
    : [];
  const wanted = expected[expected.active];
  const instance = has('web_instance')
    ? reader.all<{ instance_id: string; recovery_epoch: string }>(
        'SELECT instance_id,recovery_epoch FROM web_instance WHERE singleton=1',
      )[0]
    : undefined;
  return {
    // The code answering, as a build-time constant (config/web-build.ts): never a runtime lookup.
    build: { commit: WEB_BUILD_COMMIT },
    schemaVersion: applied.length ? applied[applied.length - 1]!.version : null,
    migrations: {
      applied,
      expected: { active: expected.active, inline: expected.inline, r2: expected.r2 },
      matches:
        applied.length === wanted.length &&
        applied.every((row, i) => row.version === wanted[i]!.version && row.sha256 === wanted[i]!.sha256),
    },
    instance: instance ? { instanceId: instance.instance_id, recoveryEpoch: instance.recovery_epoch } : null,
    budget,
    unknownAttempts: {
      webProvider: unknowns('web_provider_attempts', 'state', "operation_id||'/'||phase||'/'||ordinal"),
      external: unknowns(
        'web_external_attempts',
        'dispatch_state',
        "operation_id||'/'||stage||'/'||phase||'/'||ordinal",
      ),
      embed: unknowns('web_embed_attempts', 'state', 'id'),
    },
    prices: has('web_provider_prices')
      ? reader
          .all<{ provider: string; model: string; phase: string; latest: number }>(
            'SELECT provider,model,phase,MAX(valid_until) AS latest FROM web_provider_prices GROUP BY provider,model,phase ORDER BY provider,model,phase',
          )
          .map(
            (row): WebInspectPrice => ({
              provider: row.provider,
              model: row.model,
              phase: row.phase,
              inForce:
                reader
                  .all<{ id: string; valid_until: number; version: number; upper_micros_per_unit: number }>(
                    'SELECT id,valid_until,version,upper_micros_per_unit FROM web_provider_prices WHERE provider=? AND model=? AND phase=? AND valid_from<=? AND valid_until>? ORDER BY version DESC',
                    row.provider,
                    row.model,
                    row.phase,
                    now,
                    now,
                  )
                  .map((p) => ({
                    id: p.id,
                    validUntil: p.valid_until,
                    version: p.version,
                    upperMicrosPerUnit: p.upper_micros_per_unit,
                  }))[0] ?? null,
              latestValidUntil: row.latest,
            }),
          )
      : [],
    // Part 17f, numbers only: unfinished purges, the age of the oldest, and logins that outlived their purge (must be 0).
    retention: { ...purgeDiagnostics(reader, now), health: retentionHealth },
    ownerAdminExists: has('web_admin_members')
      ? reader.all("SELECT 1 FROM web_admin_members WHERE role='owner' LIMIT 1").length > 0
      : false,
    players: {
      // true / false / null (unset) / 'other', like the flags below.
      PLAYER_SIGNUP_ENABLED: flag(players.PLAYER_SIGNUP_ENABLED),
      // The number when it is a valid cap (1..999999 digits as the Worker parses it), null when unset, else 'other'.
      PLAYER_EMAIL_DAILY_CAP:
        players.PLAYER_EMAIL_DAILY_CAP === undefined
          ? null
          : /^[1-9][0-9]{0,5}$/.test(players.PLAYER_EMAIL_DAILY_CAP)
            ? Number(players.PLAYER_EMAIL_DAILY_CAP)
            : 'other',
      PLAYER_EMAIL_BINDING_PRESENT: players.emailBindingPresent === true,
    },
    // Part 21b: the aggregate usage rows (UTC day, provider, model, phase; counts and micro-USD at list price). No id, no content.
    usage: {
      // Part 21g: the points table in force (owner's settings; prices only), so `usage:report` calibrates against the real one.
      points: currentPrices({
        all: (sql, ...params) => reader.all(sql, ...(params as (string | number)[])),
        get: (sql, ...params) => reader.all(sql, ...(params as (string | number)[]))[0] as never,
      }),
      rows: has('web_provider_usage')
        ? reader.all(
            'SELECT day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies FROM web_provider_usage ORDER BY day DESC,provider,model,phase LIMIT 2000',
          )
        : [],
    },
    flags: {
      PUBLIC_ENABLED: flag(flags.PUBLIC_ENABLED),
      EXTERNAL_CALLS: flag(flags.EXTERNAL_CALLS),
      OPERATOR_ENABLED: flag(flags.OPERATOR_ENABLED),
      EMBEDDINGS_ENABLED: flag(flags.EMBEDDINGS_ENABLED),
    },
  };
}
