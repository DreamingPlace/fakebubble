import type { BillingItem, BillingPage } from '../../../packages/contracts/player-billing.ts';
import {
  DEFAULT_PLAYER_MODEL,
  isPlayerModelId,
  type PlayerModelId,
} from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensureBalance, hasPoints, isInvited, reconcilePoints } from './web-points.ts';

/**
 * 消费记录: the player's own spending history (Part 21f). Reads web_points_events + web_operation_models + web_operations
 * for ONE principal (the session's, never a client-supplied id), after `reconcilePoints` so every finished reply is settled.
 * Shown to points holders (signed-up players) and invited players; a guest on the plain trial has no points and gets NOT_FOUND.
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
};

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
  const metered = hasPoints(store, principalId);
  // A guest on the plain trial (or any deployment without the feature) has no spending history: the page does not exist.
  ensure(metered || isInvited(store, principalId), 'NOT_FOUND');
  return store.transaction(() => {
    let balance: number | null = null;
    if (metered) {
      reconcilePoints(store, now, principalId);
      balance = ensureBalance(store, now, principalId);
    }
    const since = now - BILLING_WINDOW_MS;
    const rows = store.all<Row>(
      `SELECT * FROM (
        SELECT o.created_at at,'op' kind,o.character_id character_id,o.status status,m.chosen chosen,
          m.draft_provider draft_provider,m.backup backup,m.points_charged points_charged,
          (SELECT coalesce(sum(e.delta),0) FROM web_points_events e WHERE e.operation_id=o.id AND e.principal_id=o.principal_id) net,
          (SELECT coalesce(sum(e.delta),0) FROM web_points_events e WHERE e.operation_id=o.id AND e.principal_id=o.principal_id AND e.source='refund' AND e.reason='no_reply') refunded,
          EXISTS (SELECT 1 FROM web_publication_items i WHERE i.operation_id=o.id AND i.origin='narrative' AND i.media_id IS NOT NULL) voiced,
          NULL source,NULL delta,'o:'||o.id sort_key
        FROM web_operations o JOIN web_operation_models m ON m.operation_id=o.id
        WHERE o.principal_id=? AND o.created_at>=?
        UNION ALL
        SELECT e.created_at at,'event' kind,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,e.source source,e.delta delta,
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
