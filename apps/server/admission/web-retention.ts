import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { playerLoginRetainsGuest } from '../identity/web-player-purge.ts';
import { entitlementActiveSql } from './web-entitlements.ts';
import { isRegisteredTier } from './web-model-settings.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';

export type WebRetentionRow = {
  principal_id: string;
  world_id: string;
  started_at: number | null;
  expires_at: number | null;
  state: 'unstarted' | 'active' | 'protected' | 'purging' | 'purged';
  revision: number;
};

/** Cloud113 receipt writers can settle money after expiry, but must not persist private output. */
export function webCloudContentExpired(store: Store, now: number, principalId: string, worldId: string) {
  if (!(store as WebStore).providerAudio) return false;
  const row = store.get<{ kind: string; state: string; expires_at: number | null }>(
    `SELECT p.kind,r.state,r.expires_at
    FROM web_principals p JOIN web_guest_retention r ON r.principal_id=p.id AND r.world_id=p.world_id
    WHERE p.id=? AND p.world_id=?`,
    principalId,
    worldId,
  );
  ensure(row, 'WEB_RETENTION_SCOPE_INVALID');
  // A registered guest (signup bonus or an email login) is a kept account: its content does not expire with the trial window.
  if (row.kind === 'guest' && row.state === 'active' && isRegisteredTier(store as WebStore, principalId, now))
    return false;
  return (
    row.kind === 'guest' &&
    (['purging', 'purged'].includes(row.state) ||
      (row.state === 'active' && row.expires_at !== null && row.expires_at <= now))
  );
}

export function webDataLifecycleEnabled(store: Store) {
  const schema = store.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
  ensure(
    schema !== undefined &&
      Number.isInteger(schema) &&
      schema >= 100 &&
      (schema <= 112 ||
        (schema >= 113 &&
          ((store as WebStore).providerRuntime === true ||
            store.get<{ file: string }>('PRAGMA database_list')?.file === '') &&
          !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_attempts'"))),
    'WEB_SCHEMA_UNSUPPORTED',
  );
  return schema === 110 || schema === 111 || schema === 112 || schema >= 113;
}

/** Keyed audit evidence cannot be reversed into private provider receipts after T2. */
export function webReceiptDigest(store: WebStore, kind: 'receipt' | 'usage', json: string) {
  return store.webReceiptDigest(kind, json);
}

/** What decides whether a principal's private work may run: the principal, its retention row and the clock. */
export type WebContentVerdict = 'live' | 'TRIAL_EXPIRED';

/**
 * Part 17i. THE rule for "is this principal's content live", in one place (JS here, SQL in webContentLiveSql below; a test
 * asserts they agree for every principal shape). Everything that decides whether work may run or must be failed asks it:
 * admission, the stage queue's claims, the publishers, the executors, the ledger and the cleaners.
 *
 *   account       state 'protected'
 *   guest         state 'unstarted', or 'active' inside its window
 *   guest         state 'unstarted' / 'active' and REGISTERED (isRegistered: signup bonus row, or an email login): the
 *                 window is over but the player is a kept account (17b / 17h)
 *   anything else (purging, purged, a plain guest past its window): not live.
 *
 * access 'read' (history, events, an operation's status, published audio) additionally lets a guest WITH an email login
 * read after the trial; it is not part of the SQL rule (nothing is claimed or run on it).
 */
export function webContentVerdict(
  store: Store,
  now: number,
  principalId: string,
  principal: { kind: string; player_id: string },
  row: Pick<WebRetentionRow, 'state' | 'expires_at'>,
  worldId: string,
  access: 'live' | 'read' = 'live',
): WebContentVerdict {
  if (principal.kind === 'account' && row.state === 'protected') return 'live';
  if (
    principal.kind === 'guest' &&
    (row.state === 'unstarted' || (row.state === 'active' && row.expires_at !== null && now < row.expires_at))
  )
    return 'live';
  // Part 17b (17h: or has an email login): a registered guest keeps working content after the trial window ended - the
  // bonus has no time window. ADMISSION still decides whether a reply may start; this gate only stops treating such an
  // account as an expired trial.
  if (
    principal.kind === 'guest' &&
    (row.state === 'unstarted' || row.state === 'active') &&
    isRegisteredTier(store as WebStore, principalId, now)
  )
    return 'live';
  if (
    access === 'read' &&
    principal.kind === 'guest' &&
    row.state === 'active' &&
    playerLoginRetainsGuest(store, principalId)
  )
    return 'live';
  return 'TRIAL_EXPIRED';
}

/**
 * The SQL twin of isRegistered (web-free-tier.ts) over a web_principals row `alias`: a signup bonus row, or an email login
 * on a guest. Same table-presence rules as the JS (bonus tables = schema 121, which also means logins exist) and the same
 * flag. `now` is only for the entitlement half.
 */
export function webRegisteredSql(schema: number, freeTier: boolean, now: number, alias = 'p') {
  const base =
    !freeTier || schema < 121
      ? null
      : {
          sql: `(EXISTS (SELECT 1 FROM web_signup_bonus sb WHERE sb.principal_id=${alias}.id)
      OR EXISTS (SELECT 1 FROM web_player_logins lg WHERE lg.principal_id=${alias}.id)
        AND ${alias}.kind='guest')`,
          args: [] as number[],
        };
  // Part 22a: an ACTIVE entitlement keeps its holder a kept account whatever the free-tier switch says (schema 125).
  const held = schema >= 125 ? entitlementActiveSql(now, alias) : null;
  if (!base && !held) return { sql: '0', args: [] as number[] };
  return {
    sql: `(${[base?.sql, held?.sql].filter(Boolean).join(' OR ')})`,
    args: [...(base?.args ?? []), ...(held?.args ?? [])],
  };
}

/**
 * Part 22a. The SQL twin of `effectiveTier(...).kind` (web-model-settings.ts) over a web_principals row `alias`: the tier of every
 * principal as one string - guest | registered | unlimited | daily_refill | account. Built from webRegisteredSql
 * above and entitlementActiveSql, so there is still ONE definition of "registered" and one of "holds an entitlement"; the
 * operator inspect counts players with it and a test asserts it agrees with the JS for every shape. `?` count: see args.
 */
export function webTierSql(schema: number, freeTier: boolean, now: number, alias = 'p') {
  const registered = webRegisteredSql(schema, freeTier, now, alias);
  const unlimited = entitlementActiveSql(now, alias, 'unlimited');
  const refill = entitlementActiveSql(now, alias, 'daily_refill');
  const entitled = schema >= 125;
  const parts = [`WHEN ${alias}.kind='account' THEN 'account'`];
  const args: number[] = [];
  if (entitled) {
    parts.push(`WHEN ${unlimited.sql} THEN 'unlimited'`, `WHEN ${refill.sql} THEN 'daily_refill'`);
    args.push(...unlimited.args, ...refill.args);
  }
  parts.push(`WHEN NOT ${registered.sql} THEN 'guest'`);
  args.push(...registered.args);
  return { sql: `CASE ${parts.join(' ')} ELSE 'registered' END`, args };
}

/**
 * The SQL twin of webContentVerdict(..., 'live') === 'live' over web_principals `p` joined to web_guest_retention `r`.
 * Used by every query that selects work by its owner (the stage queue's claims). Same schema rules as the JS: the
 * registered branches exist from 121 with the free tier on.
 */
export function webContentLiveSql(schema: number, freeTier: boolean, now: number) {
  const registered = webRegisteredSql(schema, freeTier, now);
  const parts = ["(p.kind='account' AND r.state='protected')"];
  const args: number[] = [];
  parts.push("(p.kind='guest' AND (r.state='unstarted' OR r.state='active' AND r.expires_at>?))");
  args.push(now);
  if (registered.sql !== '0') {
    parts.push(`(p.kind='guest' AND r.state IN ('unstarted','active') AND ${registered.sql})`);
    args.push(...registered.args);
  }
  return { sql: `(${parts.join(' OR ')})`, args };
}

/**
 * One server-side predicate for lifecycle private content. Legacy schemas keep their old contract. The rule itself is
 * webContentVerdict above.
 *
 * access 'live' (the default; admission, queues, publishers, provider calls, signup, redemption of the same kind of
 * work): a guest's content is available only inside the trial. access 'read' (history, events, an operation's status,
 * published audio): additionally a guest WITH an email login keeps reading after the trial ended, because the cleaner
 * keeps that guest's data (see web-player-purge.ts). The retention row is not changed: it stays 'active' and expired,
 * so every 'live' caller, and therefore admission, still answers TRIAL_EXPIRED and no new reply or provider call can
 * start. Only a caller that names 'read' can see the difference.
 */
export function requireWebContent(
  store: Store,
  clock: Clock,
  principalId: string,
  worldId: string,
  access: 'live' | 'read' = 'live',
) {
  if (!webDataLifecycleEnabled(store)) return null;
  const now = clock.now();
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const row = store.get<WebRetentionRow>(
    `SELECT * FROM web_guest_retention
    WHERE principal_id=? AND world_id=?`,
    principalId,
    worldId,
  );
  const principal = store.get<{ kind: string; player_id: string }>(
    `SELECT kind,player_id FROM web_principals
    WHERE id=? AND world_id=?`,
    principalId,
    worldId,
  );
  ensure(row && principal, 'WEB_RETENTION_SCOPE_INVALID');
  const verdict = webContentVerdict(store, now, principalId, principal, row, worldId, access);
  ensure(verdict === 'live', verdict as Exclude<WebContentVerdict, 'live'>);
  return row;
}

/** Caller owns the operation-state CAS and the same short business transaction. */
export function settleWebLifetimeReservation(store: WebStore, ipWindowId: string, outcome: 'used' | 'released') {
  if (!webDataLifecycleEnabled(store)) return;
  const window = store.get<{ ip_hash: string }>('SELECT ip_hash FROM web_ip_windows WHERE id=?', ipWindowId);
  ensure(window, 'WEB_QUOTA_STATE_INVALID');
  ensure(
    store.run(
      `UPDATE web_ip_lifetime_quota SET reserved_total=reserved_total-1,
    ${outcome === 'used' ? 'used_total=used_total+1,' : ''} revision=revision+1
    WHERE ip_hash=? AND reserved_total>0`,
      window.ip_hash,
    ).changes === 1,
    'WEB_QUOTA_STATE_INVALID',
  );
}
