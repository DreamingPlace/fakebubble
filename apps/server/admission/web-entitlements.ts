import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Invite entitlements (Part 22a, migration 125). An invite is an ENTITLEMENT attached to a normal signed-up account: a
 * redemption adds a row here and never touches web_principals.kind or web_guest_retention. This file only READS them; the
 * one function that turns them into a tier is `effectiveTier` in web-model-settings.ts, and the SQL twin of "holds an active
 * entitlement" is `entitlementActiveSql` below (the inspect counts use it; a test asserts both agree).
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
export type EntitlementKind = 'unlimited' | 'daily_refill';
export interface Entitlement {
  id: string;
  kind: EntitlementKind;
  source: 'invite' | 'admin';
  inviteId: string | null;
  batchId: string | null;
  startsAt: number;
  expiresAt: number | null;
  /** daily_refill only: the batch's CURRENT amount and cap (an owner edit applies at the next refill), else the row's own. */
  dailyAmount: number | null;
  totalCap: number | null;
}

/** Tables of 125_invite_tiers.sql: an older database has no entitlements. */
export const entitlementTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_entitlements'") &&
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_batches'");

type Row = {
  id: string;
  kind: EntitlementKind;
  source: 'invite' | 'admin';
  invite_id: string | null;
  batch_id: string | null;
  starts_at: number;
  expires_at: number | null;
  daily_amount: number | null;
  total_cap: number | null;
};

/**
 * The entitlement that counts for this principal right now: not revoked, started, not expired. `unlimited` outranks
 * `daily_refill`; among refills the larger daily amount wins. `now` unknown: only a revocation counts (as inviteGrantActive).
 */
export function activeEntitlement(store: Reader, principalId: string, now?: number): Entitlement | null {
  if (!entitlementTablesExist(store)) return null;
  const row = store.get<Row>(
    `SELECT e.id,e.kind,e.source,e.invite_id,e.batch_id,e.starts_at,e.expires_at,
      coalesce(b.daily_amount,e.daily_amount) daily_amount,coalesce(b.total_cap,e.total_cap) total_cap
    FROM web_entitlements e LEFT JOIN web_invite_batches b ON b.id=e.batch_id
    WHERE e.principal_id=? AND e.revoked_at IS NULL
      AND (? IS NULL OR e.starts_at<=?) AND (e.expires_at IS NULL OR ? IS NULL OR e.expires_at>?)
    ORDER BY (e.kind='unlimited') DESC,coalesce(b.daily_amount,e.daily_amount) DESC,e.starts_at DESC,e.id LIMIT 1`,
    principalId,
    now ?? null,
    now ?? null,
    now ?? null,
    now ?? null,
  );
  return row
    ? {
        id: row.id,
        kind: row.kind,
        source: row.source,
        inviteId: row.invite_id,
        batchId: row.batch_id,
        startsAt: row.starts_at,
        expiresAt: row.expires_at,
        dailyAmount: row.daily_amount,
        totalCap: row.total_cap,
      }
    : null;
}

/**
 * The SQL twin of `activeEntitlement(...) !== null` over a web_principals row `alias` (two `?`: now, now).
 * Same rule: not revoked, started, not expired.
 */
export function entitlementActiveSql(now: number, alias = 'p', kind?: EntitlementKind) {
  return {
    sql: `EXISTS (SELECT 1 FROM web_entitlements en WHERE en.principal_id=${alias}.id AND en.revoked_at IS NULL
      AND en.starts_at<=? AND (en.expires_at IS NULL OR en.expires_at>?)${kind ? ` AND en.kind='${kind}'` : ''})`,
    args: [now, now] as number[],
  };
}

/** The UTC day of a clock reading, 'YYYY-MM-DD'. Refills happen on the first visit of each UTC day. */
export const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
