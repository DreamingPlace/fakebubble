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
    ownerAdminExists: has('web_admin_members')
      ? reader.all("SELECT 1 FROM web_admin_members WHERE role='owner' LIMIT 1").length > 0
      : false,
    flags: {
      PUBLIC_ENABLED: flag(flags.PUBLIC_ENABLED),
      EXTERNAL_CALLS: flag(flags.EXTERNAL_CALLS),
      OPERATOR_ENABLED: flag(flags.OPERATOR_ENABLED),
      EMBEDDINGS_ENABLED: flag(flags.EMBEDDINGS_ENABLED),
    },
  };
}
