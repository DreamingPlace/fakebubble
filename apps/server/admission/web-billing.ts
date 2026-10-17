import type { BillingItem, BillingPage } from '../../../packages/contracts/player-billing.ts';
import {
  DEFAULT_PLAYER_MODEL,
  isPlayerModelId,
  type PlayerModelId,
} from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { freeTier } from './web-free-tier.ts';
import { ensureBalance, hasPoints, isInvited, offeredModels, reconcilePoints } from './web-points.ts';

/**
 * 消费记录: the player's own spending history (Part 21f). Reads web_points_events + web_operation_models + web_operations
 * for ONE principal (the session's, never a client-supplied id), after `reconcilePoints` so every finished reply is settled.
 * Shown to points holders (signed-up players), invited players and (Part 21i) guests on the plain trial. A guest gets ONLY its
 * own trial replies and a "used n/5" summary, no balance; a signed-up player also sees the replies it made during the trial
 * before signing up ("免费试用", 0 points) and a free-quota summary: total granted, used and left.
 *
 * Points only: no money, no provider cost, no ids of other players, no operation ids (the page gets none).
 */
export const BILLING_PAGE_SIZE = 50;
export const BILLING_WINDOW_MS = 90 * 24 * 60 * 60_000;
const MAX_PAGE = 1000;

type Reader = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'> & {
  playerModelChoice?: readonly PlayerModelId[];
  publicFreeTier?: boolean;
};

type Row = {
  at: number;
  kind: 'op' | 'event';
  character_id: string | null;
  status: string | null;
  chosen: string | null;
  draft_provider: string | null;
  backup: number | null;
  points_charged: number | null;
  net: number | null;
  refunded: number | null;
  voiced: number | null;
  source: string | null;
  delta: number | null;
  trial: number | null;
};

const principalKind = (store: Pick<BusinessStore, 'get'>, principalId: string) =>
  store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind;
const LIVE = "o.quota_state IN ('reserved','used')";
// SQL over the aliases o (operation), m (model row, may be absent), p (principal), b (signup bonus, may be absent): 1 for a
// reply of the guest trial. After signing up, only an operation made before the signup (or one on the old bonus path, which has
// no model row) counts; a charged reply or an unlimited-policy reply made later is never a trial reply.
const TRIAL_ROW = `(CASE WHEN p.kind='guest' AND (m.operation_id IS NULL OR
  (m.points_charged=0 AND (b.granted_at IS NULL OR o.created_at<b.granted_at))) THEN 1 ELSE 0 END)`;

/** "免费额度 total 点 · 已用 used · 剩余 balance": lifetime, so older than the 90-day list window too. balance == total - used. */
function quotaSummary(store: Reader, principalId: string) {
  const row = store.get<{ total: number; used: number }>(
    `SELECT coalesce(sum(CASE WHEN source IN ('bonus','grant','daily_refill','reset') THEN delta END),0) total,
      coalesce(-sum(CASE WHEN source IN ('spend','refund') THEN delta END),0) used
    FROM web_points_events WHERE principal_id=?`,
    principalId,
  )!;
  return { total: row.total, used: row.used };
}

/** The guest trial: replies used (reserved or used quota, lifetime) of the replies the trial offers. */
function trialSummary(store: Reader, principalId: string) {
  const row = store.get<{ n: number }>(
    `SELECT count(*) n FROM web_operations o
    JOIN web_principals p ON p.id=o.principal_id
    LEFT JOIN web_operation_models m ON m.operation_id=o.id
    LEFT JOIN web_signup_bonus b ON b.principal_id=o.principal_id
    WHERE o.principal_id=? AND ${TRIAL_ROW}=1 AND ${LIVE}`,
    principalId,
  )!;
  return { used: row.n, limit: freeTier(store).trialReplies };
}

const model = (value: string | null): PlayerModelId => (isPlayerModelId(value) ? value : DEFAULT_PLAYER_MODEL);

export function playerBilling(
  store: Reader,
  now: number,
  principalId: string,
  query: { page?: unknown; tzOffsetMinutes?: unknown },
): BillingPage {
  const page = query.page === undefined ? 1 : query.page;
  ensure(Number.isSafeInteger(page) && (page as number) >= 1 && (page as number) <= MAX_PAGE, 'INVALID_REQUEST');
  const tz = query.tzOffsetMinutes === undefined ? 0 : query.tzOffsetMinutes;
  ensure(Number.isSafeInteger(tz) && Math.abs(tz as number) <= 14 * 60, 'INVALID_REQUEST');
  const metered = hasPoints(store, principalId, now);
  const guest = !metered && offeredModels(store) !== null && principalKind(store, principalId) === 'guest';
  // A deployment without the feature has no spending history: the page does not exist.
  ensure(metered || guest || isInvited(store, principalId, now), 'NOT_FOUND');
  return store.transaction(() => {
    let balance: number | null = null;
    if (metered) {
      reconcilePoints(store, now, principalId);
      balance = ensureBalance(store, now, principalId);
    }
    const since = now - BILLING_WINDOW_MS;
    // A guest-trial reply (including the bonus replies spent before the points account existed) is free and has no points.
    // Only a guest principal has them; they count while their quota is reserved or used.
    const rows = store.all<Row>(
      `SELECT * FROM (
        SELECT o.created_at at,'op' kind,o.character_id character_id,o.status status,m.chosen chosen,
          m.draft_provider draft_provider,m.backup backup,m.points_charged points_charged,
          (SELECT coalesce(sum(e.delta),0) FROM web_points_events e WHERE e.operation_id=o.id AND e.principal_id=o.principal_id) net,
          (SELECT coalesce(sum(e.delta),0) FROM web_points_events e WHERE e.operation_id=o.id AND e.principal_id=o.principal_id AND e.source='refund' AND e.reason='no_reply') refunded,
          EXISTS (SELECT 1 FROM web_publication_items i WHERE i.operation_id=o.id AND i.origin='narrative' AND i.media_id IS NOT NULL) voiced,
          NULL source,NULL delta,${TRIAL_ROW} trial,'o:'||o.id sort_key
        FROM web_operations o
        JOIN web_principals p ON p.id=o.principal_id
        LEFT JOIN web_operation_models m ON m.operation_id=o.id
        LEFT JOIN web_signup_bonus b ON b.principal_id=o.principal_id
        WHERE o.principal_id=? AND o.created_at>=? AND (m.operation_id IS NOT NULL OR ${TRIAL_ROW}=1)
          AND (${TRIAL_ROW}=0 OR ${LIVE})
        UNION ALL
        SELECT e.created_at at,'event' kind,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,e.source source,e.delta delta,NULL,
          printf('e:%020d',e.id) sort_key
        FROM web_points_events e
        WHERE e.principal_id=? AND e.operation_id IS NULL AND e.created_at>=?
      ) ORDER BY at DESC,sort_key DESC LIMIT ? OFFSET ?`,
      principalId,
      since,
      principalId,
      since,
      BILLING_PAGE_SIZE + 1,
      ((page as number) - 1) * BILLING_PAGE_SIZE,
    );
    const items: BillingItem[] = rows.slice(0, BILLING_PAGE_SIZE).map((row): BillingItem => {
      if (row.kind === 'event')
        return { kind: row.source as 'bonus' | 'grant' | 'daily_refill' | 'reset', at: row.at, points: row.delta! };
      const free = (row.points_charged ?? 0) === 0;
      const characterId = row.character_id!;
      if (row.trial === 1)
        return {
          kind: 'trial',
          at: row.at,
          characterId,
          model: isPlayerModelId(row.draft_provider) ? row.draft_provider : model(row.chosen),
        };
      if (row.status === 'published') {
        const chosen = model(row.chosen),
          actual = isPlayerModelId(row.draft_provider) ? row.draft_provider : chosen;
        return {
          kind: 'reply',
          at: row.at,
          characterId,
          model: actual,
          ...(row.backup === 1 && actual !== chosen ? { backupFor: chosen } : {}),
          voice: row.voiced === 1,
          points: -(row.net ?? 0) || 0,
          free,
        };
      }
      if (row.status === 'failed' || row.status === 'cancelled' || row.status === 'unknown')
        return { kind: 'failed', at: row.at, characterId, refunded: row.refunded ?? 0, free };
      return { kind: 'pending', at: row.at, characterId, model: model(row.chosen), points: -(row.net ?? 0) || 0, free };
    });
    return {
      metered,
      balance,
      quota: metered ? quotaSummary(store, principalId) : null,
      trial: guest ? trialSummary(store, principalId) : null,
      month: monthSummary(store, now, principalId, tz as number),
      items,
      page: page as number,
      hasMore: rows.length > BILLING_PAGE_SIZE,
    };
  });
}

/** This month's points (month boundaries on the player's clock) by the model that wrote the reply and by character. */
function monthSummary(store: Reader, now: number, principalId: string, tzOffsetMinutes: number) {
  const local = new Date(now - tzOffsetMinutes * 60_000);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) + tzOffsetMinutes * 60_000;
  const rows = store.all<{
    character_id: string;
    chosen: string;
    draft_provider: string | null;
    net: number;
  }>(
    `SELECT o.character_id,m.chosen,m.draft_provider,
      (SELECT coalesce(sum(e.delta),0) FROM web_points_events e WHERE e.operation_id=o.id AND e.principal_id=o.principal_id) net
    FROM web_operations o JOIN web_operation_models m ON m.operation_id=o.id
    WHERE o.principal_id=? AND o.status='published' AND o.created_at>=? AND m.points_charged>0`,
    principalId,
    start,
  );
  const byModel = new Map<PlayerModelId, { points: number; replies: number }>(),
    byCharacter = new Map<string, { points: number; replies: number }>();
  const add = <K>(map: Map<K, { points: number; replies: number }>, key: K, points: number) => {
    const entry = map.get(key) ?? { points: 0, replies: 0 };
    entry.points += points;
    entry.replies += 1;
    map.set(key, entry);
  };
  for (const row of rows) {
    const chosen = model(row.chosen),
      actual = isPlayerModelId(row.draft_provider) ? row.draft_provider : chosen,
      spent = -row.net || 0;
    add(byModel, actual, spent);
    add(byCharacter, row.character_id, spent);
  }
  const sorted = <K>(map: Map<K, { points: number; replies: number }>) =>
    [...map].sort((a, b) => b[1].points - a[1].points).map(([key, value]) => ({ key, ...value }));
  return {
    byModel: sorted(byModel).map(({ key, points, replies }) => ({ model: key, points, replies })),
    byCharacter: sorted(byCharacter).map(({ key, points, replies }) => ({ characterId: key, points, replies })),
  };
}

/** The business object behind POST /billing/history: session, CSRF and Origin as for any player request, then the principal's own page. */
export class WebBilling {
  private readonly store: Reader;
  private readonly clock: { now(): number };
  private readonly identity: { authorizeWrite(token: string, csrf: string, origin: string): { principalId: string } };
  constructor(store: Reader, clock: { now(): number }, identity: WebBilling['identity']) {
    this.store = store;
    this.clock = clock;
    this.identity = identity;
  }
  history(token: string, csrf: string, origin: string, body: { page?: unknown; tzOffsetMinutes?: unknown }) {
    const principal = this.identity.authorizeWrite(token, csrf, origin);
    return playerBilling(this.store, this.clock.now(), principal.principalId, body);
  }
}
