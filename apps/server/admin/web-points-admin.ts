import { createHmac } from 'node:crypto';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { POINTS } from '../../../packages/contracts/player-models.ts';
import {
  POINTS_GRANT_LIMITS,
  type PointsLookup,
  type PointsResetResult,
  type PointsSkipped,
  type PointsTarget,
} from '../../../packages/contracts/web-system.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { normalizeEmail } from '../identity/email-address.ts';
import { entitlementTablesExist, activeEntitlement } from '../admission/web-entitlements.ts';
import { freeTier } from '../admission/web-free-tier.ts';
import { PLAYER_NUMBER_PATTERN, ensurePlayerNumber } from '../admission/web-player-number.ts';
import { webTierSql } from '../admission/web-retention.ts';
import { ensureBalance, grantRoom, hasPoints, modelChoiceTablesExist, offeredModels } from '../admission/web-points.ts';
import { currentPrices, offeredGlobally, type ModelFlags } from '../admission/web-model-settings.ts';
import { usageReport, type UsageRow } from '../generation/usage-report.ts';

type Store = BusinessStore & ModelFlags;
type Tier = PointsLookup['tier'];

/** The keyed digest an audit row carries instead of an email: stable for one address, useless without the key. */
export const emailDigest = (key: Buffer, emailNorm: string) =>
  createHmac('sha256', key).update(emailNorm).digest('hex').slice(0, 32);

/** The exact selector an administrator typed, validated and normalized. Unknown keys, extra spaces inside and partial input are refused. */
export function parseTarget(value: unknown): PointsTarget {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
  const target = value as Record<string, unknown>;
  const keys = Object.keys(target).sort().join(',');
  if (target.kind === 'all') {
    ensure(keys === 'kind', 'INVALID_REQUEST');
    return { kind: 'all' };
  }
  if (target.kind === 'tier') {
    ensure(keys === 'kind,tier' && (target.tier === 'registered' || target.tier === 'daily_refill'), 'INVALID_REQUEST');
    return { kind: 'tier', tier: target.tier as 'registered' | 'daily_refill' };
  }
  if (target.kind === 'player') {
    ensure(keys === 'kind,playerNumber' && typeof target.playerNumber === 'string', 'INVALID_REQUEST');
    const playerNumber = (target.playerNumber as string).trim().toUpperCase();
    ensure(PLAYER_NUMBER_PATTERN.test(playerNumber), 'INVALID_REQUEST');
    return { kind: 'player', playerNumber };
  }
  ensure(target.kind === 'email' && keys === 'email,kind', 'INVALID_REQUEST');
  return { kind: 'email', email: normalizeEmail(target.email, 'INVALID_REQUEST') };
}

export function parseAmount(value: unknown) {
  ensure(
    Number.isSafeInteger(value) &&
      (value as number) >= POINTS_GRANT_LIMITS.min &&
      (value as number) <= POINTS_GRANT_LIMITS.max,
    'INVALID_REQUEST',
  );
  return value as number;
}
export function parseNote(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  ensure(
    typeof value === 'string' &&
      [...value].length <= POINTS_GRANT_LIMITS.noteMax &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(value),
    'INVALID_REQUEST',
  );
  return (value as string).trim() || null;
}

/** Whether points exist at all on this deployment (the 21b switch). Without them there is nothing to give or reset. */
export function requirePoints(store: Store) {
  ensure(
    modelChoiceTablesExist(store) && entitlementTablesExist(store) && offeredModels(store) !== null,
    'POINTS_NOT_ENABLED',
  );
}

type Classified = { id: string; tier: Tier };
/** Every principal's tier, from the one SQL definition of it (webTierSql); purging or purged players are never touched. */
function classify(store: Store, now: number, onlyId?: string): Classified[] {
  const sql = webTierSql(125, freeTier(store).on, now);
  const retention = store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_guest_retention'")
    ? "AND NOT EXISTS (SELECT 1 FROM web_guest_retention r WHERE r.principal_id=p.id AND r.state IN ('purging','purged'))"
    : '';
  return store.all<Classified>(
    `SELECT p.id id,${sql.sql} tier FROM web_principals p WHERE 1=1 ${retention} ${onlyId ? 'AND p.id=?' : ''}`,
    ...sql.args,
    ...(onlyId ? [onlyId] : []),
  );
}

export type Selection = {
  /** Players that hold points and may receive them (registered and daily_refill). */
  receivers: Classified[];
  skipped: Pick<PointsSkipped, 'guests' | 'unlimited'>;
  player?: { id: string; lookup: PointsLookup };
};

/** Resolve a typed target. `emailKey` makes the keyed digest for the audit; the email itself is never stored or returned. */
export function selectPlayers(
  store: Store,
  now: number,
  target: PointsTarget,
  audit: (action: string, target: string) => void,
  emailKey: Buffer,
): Selection {
  let single: string | null = null;
  if (target.kind === 'email') {
    // Exact equality on the stored normalized address - no LIKE, no prefix, no list. Every lookup leaves a keyed digest, found or not.
    audit('points-lookup', `email:${emailDigest(emailKey, target.email)}`);
    single =
      store.get<{ principal_id: string }>('SELECT principal_id FROM web_player_logins WHERE email_norm=?', target.email)
        ?.principal_id ?? null;
  } else if (target.kind === 'player') {
    audit('points-lookup', `number:${target.playerNumber}`);
    single =
      store.get<{ principal_id: string }>(
        'SELECT principal_id FROM web_player_numbers WHERE number=?',
        target.playerNumber,
      )?.principal_id ?? null;
  }
  if (target.kind === 'email' || target.kind === 'player') {
    const found = single ? classify(store, now, single)[0] : undefined;
    if (!found) throw new DomainError('PLAYER_NOT_FOUND');
    // Every signed-up player has a number (assigned at signup); one that somehow lacks it is given it, as the account page does.
    const number = ensurePlayerNumber(store, now, found.id);
    ensure(number, 'PLAYER_NOT_FOUND');
    const balance = store.get<{ balance: number }>(
      'SELECT balance FROM web_points_balance WHERE principal_id=?',
      found.id,
    );
    const lookup: PointsLookup = { playerNumber: number, tier: found.tier, balance: balance?.balance ?? null };
    const receives = found.tier === 'registered' || found.tier === 'daily_refill';
    return {
      receivers: receives ? [found] : [],
      skipped: {
        guests: found.tier === 'guest' ? 1 : 0,
        unlimited: found.tier === 'unlimited' || found.tier === 'account' ? 1 : 0,
      },
      player: { id: found.id, lookup },
    };
  }
  const all = classify(store, now);
  const wanted = target.kind === 'tier' ? [target.tier] : ['registered', 'daily_refill'];
  return {
    receivers: all.filter((row) => wanted.includes(row.tier)),
    // The skipped counts describe the whole population for 全部 and are not asked for when one tier was chosen.
    skipped:
      target.kind === 'all'
        ? {
            guests: all.filter((row) => row.tier === 'guest').length,
            unlimited: all.filter((row) => row.tier === 'unlimited' || row.tier === 'account').length,
          }
        : { guests: 0, unlimited: 0 },
  };
}

/**
 * A points account for a player that is entitled to one but has none yet (a daily_refill holder while the signup bonus is off,
 * a registered player whose bonus was refused): the same policy + zero balance row the other first-touch paths create, with no
 * event, so a grant has a balance to add to. Balance of a player that already has one is returned unchanged.
 */
function openAccount(store: Store, now: number, principalId: string) {
  const balance = ensureBalance(store, now, principalId);
  if (store.get('SELECT 1 FROM web_points_balance WHERE principal_id=?', principalId)) return balance;
  store.run(
    "INSERT INTO web_points_policy(principal_id,kind,amount,created_at,updated_at) VALUES (?,'one_off',0,?,?) ON CONFLICT DO NOTHING",
    principalId,
    now,
    now,
  );
  store.run(
    'INSERT INTO web_points_balance(principal_id,balance,created_at,updated_at) VALUES (?,0,?,?)',
    principalId,
    now,
    now,
  );
  return 0;
}

/** Adds `points` (> 0) to one balance with ONE event; the caller has decided how many. */
function addPoints(
  store: Store,
  now: number,
  principalId: string,
  adminId: string,
  source: 'grant' | 'reset',
  points: number,
) {
  store.run(
    'UPDATE web_points_balance SET balance=balance+?,updated_at=? WHERE principal_id=?',
    points,
    now,
    principalId,
  );
  store.run(
    `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at)
    VALUES (?,NULL,?,NULL,?,?,?,?)`,
    principalId,
    source,
    points,
    adminId,
    currentPrices(store).version,
    now,
  );
}

/** One gift to every selected player, clamped by 22a's cap for daily_refill players. Writes; the caller owns the transaction. */
export function grantToPlayers(store: Store, now: number, adminId: string, selection: Selection, amount: number) {
  let granted = 0,
    totalPoints = 0,
    atCap = 0;
  for (const receiver of selection.receivers) {
    // Defense in depth: the tier said registered/daily_refill, the points rule must agree before anything is written.
    if (!hasPoints(store, receiver.id, now)) continue;
    const balance = openAccount(store, now, receiver.id);
    const added = Math.min(amount, grantRoom(store, receiver.id, now, balance));
    if (added <= 0) {
      atCap += 1;
      continue;
    }
    addPoints(store, now, receiver.id, adminId, 'grant', added);
    granted += 1;
    totalPoints += added;
  }
  return {
    amount,
    players: selection.receivers.length,
    granted,
    totalPoints,
    skipped: { ...selection.skipped, atCap } satisfies PointsSkipped,
  };
}

/**
 * What 重置全部额度 adds to one player, or null when it never touches them (unlimited, accounts). A registered player is brought
 * back to 100 when below it. A daily_refill holder gets seven days of its batch's daily amount ON TOP of its balance, never
 * above the cap: min(7 × N, cap − balance) while below the cap, else nothing (that is "已达上限"). Nobody is ever lowered.
 */
function resetAmount(
  store: Store,
  now: number,
  row: Classified,
  balance: number,
): { add: number; capped: boolean } | null {
  if (row.tier === 'registered') return { add: Math.max(0, POINTS.signupBalance - balance), capped: false };
  if (row.tier !== 'daily_refill') return null;
  const entitlement = activeEntitlement(store, row.id, now);
  if (!entitlement || entitlement.dailyAmount === null || entitlement.totalCap === null) return null;
  if (balance >= entitlement.totalCap) return { add: 0, capped: true };
  return { add: Math.min(entitlement.dailyAmount * 7, entitlement.totalCap - balance), capped: false };
}

/** 重置全部额度: registered players back to 100 if below; daily_refill holders +7 days of N up to the cap. Writes; the caller owns the transaction. */
export function resetAll(store: Store, now: number, adminId: string) {
  const everyone = selectPlayers(store, now, { kind: 'all' }, () => {}, Buffer.alloc(0));
  let affected = 0,
    totalPoints = 0,
    alreadyFull = 0,
    atCap = 0;
  for (const receiver of everyone.receivers) {
    if (!hasPoints(store, receiver.id, now)) continue;
    const balance = openAccount(store, now, receiver.id);
    const plan = resetAmount(store, now, receiver, balance);
    if (!plan || plan.add <= 0) {
      if (plan?.capped) atCap += 1;
      else alreadyFull += 1;
      continue;
    }
    addPoints(store, now, receiver.id, adminId, 'reset', plan.add);
    affected += 1;
    totalPoints += plan.add;
  }
  return {
    affected,
    totalPoints,
    skipped: { ...everyone.skipped, atCap, alreadyFull },
  } satisfies Omit<PointsResetResult, 'worstCaseMicros' | 'duplicate'>;
}

/**
 * Highest average real cost of ONE point over the last 30 UTC days across the models offered now (list prices, from the usage
 * aggregates): the number a worst-case estimate multiplies by. Null while no offered model has a measured cost.
 */
export function highestMicrosPerPoint(store: Store, now: number): number | null {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_usage'")) return null;
  const since = new Date(now - 29 * 86_400_000).toISOString().slice(0, 10);
  const rows = store.all<UsageRow>('SELECT * FROM web_provider_usage WHERE day>=?', since);
  const offered = offeredGlobally(store) ?? [];
  const costs = usageReport(rows, currentPrices(store))
    .models.filter((model) => offered.includes(model.model) && model.microsPerPoint !== null)
    .map((model) => model.microsPerPoint!);
  return costs.length ? Math.max(...costs) : null;
}
