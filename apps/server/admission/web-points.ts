import {
  type ModelChoiceInfo,
  DEFAULT_PLAYER_MODEL,
  POINTS,
  isPlayerModelId,
  type PlayerModelId,
} from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import {
  bonusSpent,
  extraTrialSpent,
  freeTier,
  guestTrialOver,
  hasSignupBonus,
  inviteGrantLapsed,
  isRegistered,
} from './web-free-tier.ts';
import { activeEntitlement, utcDay } from './web-entitlements.ts';
import {
  currentPrices,
  effectiveTier,
  firstTierModel,
  modelSettingsTablesExist,
  offeredGlobally,
  playerTier,
  pricesAt,
  replyPointsNow,
  tierModels,
  type ModelFlags,
} from './web-model-settings.ts';

/**
 * Player model choice and points (Part 21b, flag PLAYER_MODEL_CHOICE_ENABLED, default off).
 *
 * Points are player fairness; the budget ledger is money safety. The two are independent: a charge here never touches a
 * reservation, and a refund here never releases one. The business object is the only writer of these tables.
 *
 * Who has points: a principal that holds the signup bonus (a guest that signed up with a verified email) while the feature
 * is on. Its balance is created LAZILY on first touch from the old accounting: 100 - 10 x bonus replies already spent + 10 x unused trial replies (a points account never uses the trial).
 * Invited players may choose a model too but are NOT charged: their rolling daily reply limit is untouched. Guests (the
 * 5-reply DeepSeek-only trial) and administrators see no model picker.
 *
 * Allowance POLICY (web_points_policy: one_off | daily_refill | unlimited) is separate from the BALANCE (web_points_balance);
 * every movement is an event with its `source` (bonus | grant | daily_refill | reset | spend | refund) and, for an
 * administrator's action, the acting admin id. Only one_off (the signup bonus) and unlimited are acted on in this Part;
 * daily_refill and the admin actions are the schema Part 22 builds on (no admin UI here).
 *
 * Charging is at admission. Nothing here hooks the many places an operation can end: `reconcilePoints` runs whenever the
 * balance is read or charged and settles, once per operation (unique index), every operation of the principal that ended
 * without a reply (full refund) or that was answered by a cheaper backup model / without voice (the difference).
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
type Writer = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'>;
type Flagged = ModelFlags;

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables of 123_model_choice.sql: an older database has no model choice, whatever the flag says. */
export const modelChoiceTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_points_balance') && tableExists(store, 'web_operation_models');

/**
 * The models offered at all right now, or null while the feature is off. Part 21g: PLAYER_TEXT_MODELS (and the provider key) is
 * a ceiling and the owner's table decides the rest - a model that is outside the ceiling or switched off is not in this list.
 * DeepSeek stays the internal backup and house reviewer whatever this says (routing never asks the table about it).
 */
export function offeredModels(store: Pick<BusinessStore, 'get' | 'all'> & Flagged): readonly PlayerModelId[] | null {
  return modelChoiceTablesExist(store) ? offeredGlobally(store) : null;
}
/**
 * True for a principal with a points account: feature on and registered (Part 17h: the signup bonus held, or an email login
 * as a guest or as an invited player whose grant lapsed - see isRegistered). `now` is only needed to see an expired grant.
 */
export const hasPoints = (store: Pick<BusinessStore, 'get' | 'all'> & Flagged, principalId: string, now?: number) =>
  offeredModels(store) !== null && isRegistered(store, principalId, now);
/** An invited principal (an invite or an account): may choose a model, is never charged points. */
export const isInvited = (store: Pick<BusinessStore, 'get' | 'all'> & Flagged, principalId: string, now?: number) =>
  offeredModels(store) !== null && playerTier(store, principalId, now) === 'invited';
/**
 * May this principal pick a model? Registered and invited players whenever their tier is offered anything; a guest only when
 * the owner allows its tier more than one model (a guest reply costs one trial reply whatever the model).
 */
export function canChooseModel(store: Pick<BusinessStore, 'get' | 'all'> & Flagged, principalId: string, now?: number) {
  if (offeredModels(store) === null) return false;
  const tier = playerTier(store, principalId, now);
  if (!tier) return false;
  // A trial guest whose trial is over has nothing to choose a model for: the page shows the trial-ended state instead.
  if (tier === 'guest' && now !== undefined && guestTrialOver(store, principalId, now)) return false;
  // An invited player whose grant is gone (and who has nothing to fall back on: that one is 'registered') gets no picker. A
  // player who holds an entitlement is not that case: its tier comes from the entitlement, not from a grant.
  if (tier === 'invited' && !activeEntitlement(store, principalId, now) && inviteGrantLapsed(store, principalId, now))
    return false;
  const count = tierModels(store, tier).length;
  return tier === 'guest' ? count > 1 : count > 0;
}
/** The allowance policy of a points account (one_off when none is stored yet). */
export function policyKind(
  store: Pick<BusinessStore, 'get'>,
  principalId: string,
): 'one_off' | 'daily_refill' | 'unlimited' {
  const row = store.get<{ kind: 'one_off' | 'daily_refill' | 'unlimited' }>(
    'SELECT kind FROM web_points_policy WHERE principal_id=?',
    principalId,
  );
  return row?.kind ?? 'one_off';
}

/**
 * Never charged: an 'unlimited' points policy (the schema 123 field) or an unlimited effective tier (Part 22a: an unlimited
 * entitlement, a legacy invite, an account). Both read here so quote and charge cannot disagree.
 */
export function isUnmetered(store: Reader & Flagged, principalId: string, now?: number) {
  return policyKind(store, principalId) === 'unlimited' || effectiveTier(store, principalId, now)?.unlimited === true;
}

/**
 * How many points may still be ADDED to this balance (Part 22a): a player on a daily_refill entitlement never goes above the
 * entitlement's cap through a grant - the bonus, a refill or an administrator's gift add only up to it, and at or above it add
 * nothing. Points already held are never taken away, and refunds (the return of points that were spent) are not grants.
 * Everyone else: no cap.
 */
export function grantRoom(store: Reader & Flagged, principalId: string, now: number, balance: number) {
  const entitlement = activeEntitlement(store, principalId, now);
  if (!entitlement || entitlement.kind !== 'daily_refill' || entitlement.totalCap === null)
    return Number.POSITIVE_INFINITY;
  return Math.max(0, entitlement.totalCap - balance);
}

/** The cheapest reply (voice included) the principal's tier offers: below it the old "free replies used up" answer applies. */
export function cheapestReplyPoints(
  store: Pick<BusinessStore, 'get' | 'all'> & Flagged,
  principalId: string,
  now?: number,
) {
  const tier = playerTier(store, principalId, now);
  const prices = currentPrices(store);
  const models = tier ? tierModels(store, tier) : [];
  const cheapest = Math.min(...(models.length ? models : [DEFAULT_PLAYER_MODEL]).map((id) => prices.perReply[id]));
  return cheapest + prices.voice;
}

/**
 * The saved choice, as a model the player's tier still offers. A model the owner withdrew (globally or for the tier) moves the
 * player to the tier's first allowed model on their next message, once, with the 'model_withdrawn' notice.
 */
export function effectiveModel(store: Writer & Flagged, now: number, principalId: string): PlayerModelId {
  if (!offeredModels(store)) return DEFAULT_PLAYER_MODEL;
  const tier = playerTier(store, principalId, now);
  const allowed = tier ? tierModels(store, tier) : [];
  const first = firstTierModel(store, tier);
  const row = store.get<{ model: string }>('SELECT model FROM web_player_model WHERE principal_id=?', principalId);
  if (!row || !isPlayerModelId(row.model))
    return allowed.length === 0 || allowed.includes(DEFAULT_PLAYER_MODEL) ? DEFAULT_PLAYER_MODEL : first;
  if (allowed.includes(row.model)) return row.model;
  if (allowed.length === 0) return DEFAULT_PLAYER_MODEL;
  store.run(
    "UPDATE web_player_model SET model=?,notice='model_withdrawn',updated_at=? WHERE principal_id=?",
    first,
    now,
    principalId,
  );
  return first;
}

export function setPlayerModel(store: Writer & Flagged, now: number, principalId: string, model: unknown) {
  const offered = offeredModels(store);
  ensure(offered && canChooseModel(store, principalId, now), 'NOT_FOUND');
  const tier = playerTier(store, principalId, now)!;
  ensure(isPlayerModelId(model) && tierModels(store, tier).includes(model), 'MODEL_NOT_AVAILABLE');
  store.run(
    `INSERT INTO web_player_model(principal_id,model,notice,updated_at) VALUES (?,?,NULL,?)
    ON CONFLICT(principal_id) DO UPDATE SET model=excluded.model,notice=NULL,updated_at=excluded.updated_at`,
    principalId,
    model,
    now,
  );
  return model;
}

/**
 * Trial replies this principal has not used (Part 21f): a points account never takes the trial path, so each one is worth a
 * bonus reply in the opening balance. Counter replies (trial_used + trial_reserved) and the extra trial replies (derived
 * accounting, web_free_operations) are both subtracted from the trial allowance; floored at 0.
 */
export function unusedTrial(store: Pick<BusinessStore, 'get'> & Flagged, principalId: string) {
  const row = store.get<{ used: number; reserved: number }>(
    'SELECT trial_used used,trial_reserved reserved FROM web_principals WHERE id=?',
    principalId,
  );
  if (!row) return 0;
  return Math.max(0, freeTier(store).trialReplies - row.used - row.reserved - extraTrialSpent(store, { principalId }));
}

/** Create the balance on first touch from the old bonus accounting (no backfill in the migration). */
export function ensureBalance(store: Writer & Flagged, now: number, principalId: string) {
  const row = store.get<{ balance: number }>(
    'SELECT balance FROM web_points_balance WHERE principal_id=?',
    principalId,
  );
  if (row) return row.balance;
  // Part 17h: only a METERED principal gets a balance: one that holds the signup bonus or has a points policy. Touching any
  // other principal (a plain trial guest, an unmetered invited player, one whose bonus is not decided yet) creates nothing.
  if (
    !hasSignupBonus(store, principalId) &&
    !store.get('SELECT 1 FROM web_points_policy WHERE principal_id=?', principalId)
  )
    return 0;
  // Part 22a: the opening balance is a grant like any other - on a daily_refill entitlement it stops at the cap.
  const start = Math.min(
    Math.max(
      0,
      POINTS.signupBalance -
        POINTS.perBonusReply * bonusSpent(store, principalId) +
        POINTS.perBonusReply * unusedTrial(store, principalId),
    ),
    grantRoom(store, principalId, now, 0),
  );
  // The policy (what the principal is entitled to) and the balance (what is left) are created together, apart.
  store.run(
    "INSERT INTO web_points_policy(principal_id,kind,amount,created_at,updated_at) VALUES (?,'one_off',?,?,?) ON CONFLICT DO NOTHING",
    principalId,
    POINTS.signupBalance,
    now,
    now,
  );
  store.run(
    'INSERT INTO web_points_balance(principal_id,balance,created_at,updated_at) VALUES (?,?,?,?)',
    principalId,
    start,
    now,
    now,
  );
  if (start > 0)
    store.run(
      `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at)
      VALUES (?,NULL,'bonus',NULL,?,?,?)`,
      principalId,
      start,
      currentPrices(store).version,
      now,
    );
  return start;
}

/**
 * An administrator's gift of points (events source 'grant', carrying the admin id). Clamped like every grant: a daily_refill
 * player is never pushed above its cap. Returns the points actually added.
 */
export function grantPoints(store: Writer & Flagged, now: number, principalId: string, adminId: string, points: number) {
  ensure(Number.isSafeInteger(points) && points > 0, 'INVALID_REQUEST');
  return store.transaction(() => {
    const balance = ensureBalance(store, now, principalId);
    const added = Math.min(points, grantRoom(store, principalId, now, balance));
    if (added <= 0) return 0;
    store.run('UPDATE web_points_balance SET balance=balance+?,updated_at=? WHERE principal_id=?', added, now, principalId);
    store.run(
      `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at)
      VALUES (?,NULL,'grant',NULL,?,?,?,?)`,
      principalId,
      added,
      adminId,
      currentPrices(store).version,
      now,
    );
    return added;
  });
}

/**
 * The daily refill (Part 22a). On a player's FIRST visit of each UTC day, a daily_refill entitlement ADDS its daily amount N
 * (not a top-up to N) as ONE 'daily_refill' points event, never taking the balance above the entitlement's cap. A day without
 * a visit pays nothing and a missed day is never paid later; the (player, day) row of web_entitlement_refills is the once-a-day
 * guard. Returns the points added. Called by every "visit": the page bootstrap / account read, the billing read, a message, and
 * a redemption.
 */
export function applyDailyRefill(store: Writer & Flagged, now: number, principalId: string) {
  const eff = effectiveTier(store, principalId, now);
  const entitlement = eff?.entitlement;
  if (
    !eff ||
    eff.kind !== 'daily_refill' ||
    !entitlement ||
    entitlement.dailyAmount === null ||
    entitlement.totalCap === null ||
    !hasPoints(store, principalId, now)
  )
    return 0;
  const day = utcDay(now);
  if (store.get('SELECT 1 FROM web_entitlement_refills WHERE principal_id=? AND day=?', principalId, day)) return 0;
  return store.transaction(() => {
    const balance = ensureBalance(store, now, principalId);
    const added = Math.max(0, Math.min(entitlement.dailyAmount!, entitlement.totalCap! - balance));
    store.run(
      'INSERT INTO web_entitlement_refills(principal_id,day,entitlement_id,delta,created_at) VALUES (?,?,?,?,?)',
      principalId,
      day,
      entitlement.id,
      added,
      now,
    );
    if (added > 0) {
      store.run(
        'UPDATE web_points_balance SET balance=balance+?,updated_at=? WHERE principal_id=?',
        added,
        now,
        principalId,
      );
      store.run(
        `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at)
        VALUES (?,NULL,'daily_refill',NULL,?,?,?)`,
        principalId,
        added,
        currentPrices(store).version,
        now,
      );
    }
    return added;
  });
}

function refund(
  store: Writer,
  now: number,
  principalId: string,
  operationId: string,
  reason: 'no_reply' | 'backup_cheaper' | 'no_voice',
  points: number,
  version: number,
) {
  if (points <= 0) return;
  // The unique index (operation, source, reason) makes a second settlement of the same fact a no-op.
  const inserted = store.run(
    `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at)
    VALUES (?,?,'refund',?,?,?,?) ON CONFLICT DO NOTHING`,
    principalId,
    operationId,
    reason,
    points,
    version,
    now,
  );
  if (inserted.changes === 1)
    store.run(
      'UPDATE web_points_balance SET balance=balance+?,updated_at=? WHERE principal_id=?',
      points,
      now,
      principalId,
    );
}

/**
 * Settle every finished, unsettled operation of the principal: no reply (failed, cancelled, UNKNOWN) refunds the whole charge;
 * a reply answered by a backup model costs the CHEAPER of the two models' points; a reply that carried no voice (the voice
 * fell back to text) is not charged the voice points. Idempotent.
 */
export function reconcilePoints(store: Writer, now: number, principalId: string) {
  const rows = store.all<{
    operation_id: string;
    chosen: string;
    voice: number;
    points_charged: number;
    price_version: number;
    draft_provider: string | null;
    status: string;
  }>(
    `SELECT m.operation_id,m.chosen,m.voice,m.points_charged,m.price_version,m.draft_provider,o.status
    FROM web_operation_models m JOIN web_operations o ON o.id=m.operation_id
    WHERE o.principal_id=? AND m.settled=0 AND m.points_charged>0
      AND o.status IN ('failed','cancelled','unknown','published')`,
    principalId,
  );
  for (const row of rows) {
    // The price table the operation was admitted under (Part 21g): a later price change never re-prices a refund.
    const frozen = pricesAt(store, row.price_version) ?? currentPrices(store);
    if (row.status !== 'published') {
      refund(store, now, principalId, row.operation_id, 'no_reply', row.points_charged, row.price_version);
    } else {
      const chosen = isPlayerModelId(row.chosen) ? row.chosen : DEFAULT_PLAYER_MODEL;
      const actual = isPlayerModelId(row.draft_provider) ? row.draft_provider : chosen;
      refund(
        store,
        now,
        principalId,
        row.operation_id,
        'backup_cheaper',
        Math.max(0, frozen.perReply[chosen] - frozen.perReply[actual]),
        row.price_version,
      );
      if (row.voice === 1) {
        const voiced = store.get(
          `SELECT 1 FROM web_publication_items WHERE operation_id=? AND origin='narrative' AND media_id IS NOT NULL LIMIT 1`,
          row.operation_id,
        );
        if (!voiced) refund(store, now, principalId, row.operation_id, 'no_voice', frozen.voice, row.price_version);
      }
    }
    store.run('UPDATE web_operation_models SET settled=1 WHERE operation_id=?', row.operation_id);
  }
}

export type PointsDecision =
  | { ok: true; points: number }
  | { ok: false; code: 'TRIAL_EXHAUSTED' | 'POINTS_INSUFFICIENT' };

/**
 * Can this principal pay for a reply by `model` right now? Reads (after reconciling); a balance below the cheapest reply is
 * the same "free replies used up" answer as today, a balance that only misses the dearer model asks to pick a cheaper one.
 */
export function quote(store: Writer & Flagged, now: number, principalId: string, model: PlayerModelId): PointsDecision {
  reconcilePoints(store, now, principalId);
  applyDailyRefill(store, now, principalId);
  const balance = ensureBalance(store, now, principalId);
  if (isUnmetered(store, principalId, now)) return { ok: true, points: 0 };
  const price = replyPointsNow(store, model);
  if (balance >= price) return { ok: true, points: price };
  return {
    ok: false,
    code: balance >= cheapestReplyPoints(store, principalId, now) ? 'POINTS_INSUFFICIENT' : 'TRIAL_EXHAUSTED',
  };
}

/** Charge at admission, in the same transaction as the operation row. Refuses (nothing written) if the balance is short. */
export function chargeAdmission(
  store: Writer & Flagged,
  now: number,
  principalId: string,
  operationId: string,
  model: PlayerModelId,
): number {
  // An 'unlimited' policy is never charged (and has no spend event); the operation row still freezes the model.
  // The price is read from the owner's table (Part 21g) and its version is stamped on the event and the operation.
  const prices = currentPrices(store);
  const price = isUnmetered(store, principalId, now) ? 0 : prices.perReply[model] + prices.voice;
  if (price > 0) {
    ensure(
      store.run(
        'UPDATE web_points_balance SET balance=balance-?,updated_at=? WHERE principal_id=? AND balance>=?',
        price,
        now,
        principalId,
        price,
      ).changes === 1,
      'TRIAL_EXHAUSTED',
    );
    store.run(
      `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at)
      VALUES (?,?,'spend','reply',?,?,?)`,
      principalId,
      operationId,
      -price,
      prices.version,
      now,
    );
  }
  store.run(
    `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,created_at)
    VALUES (?,?,1,?,?,?)`,
    operationId,
    model,
    price,
    prices.version,
    now,
  );
  return price;
}

/** An invited player's operation: the chosen model is frozen into it (routing and backup apply), nothing is charged. */
export function recordUnmetered(store: Writer, now: number, operationId: string, model: PlayerModelId) {
  store.run(
    `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,created_at)
    VALUES (?,?,1,0,?,?)`,
    operationId,
    model,
    currentPrices(store).version,
    now,
  );
}

export type ModelChoiceState = ModelChoiceInfo;
/** What the player page shows. Reads, but settles and creates the balance on the way; consumes the one-time notice. */
export function modelChoiceState(
  store: Writer & Flagged,
  now: number,
  principalId: string,
  /** Only the account read that SHOWS the notice consumes it; the access check (every bootstrap) must not. */
  consumeNotice = true,
): ModelChoiceState | null {
  const offered = offeredModels(store);
  if (!offered || !canChooseModel(store, principalId, now)) return null;
  const metered = isRegistered(store, principalId, now);
  const allowed = tierModels(store, playerTier(store, principalId, now)!);
  const prices = currentPrices(store);
  return store.transaction(() => {
    let balance = 0;
    if (metered) {
      reconcilePoints(store, now, principalId);
      applyDailyRefill(store, now, principalId);
      balance = ensureBalance(store, now, principalId);
    }
    const eff = effectiveTier(store, principalId, now);
    const plan = eff?.entitlement
      ? {
          kind: eff.entitlement.kind,
          ...(eff.entitlement.kind === 'daily_refill'
            ? { dailyAmount: eff.entitlement.dailyAmount!, cap: eff.entitlement.totalCap! }
            : {}),
          expiresAt: eff.entitlement.expiresAt,
        }
      : undefined;
    const selected = effectiveModel(store, now, principalId);
    const notice = store.get<{ notice: string | null }>(
      'SELECT notice FROM web_player_model WHERE principal_id=?',
      principalId,
    )?.notice;
    if (notice && consumeNotice) store.run('UPDATE web_player_model SET notice=NULL WHERE principal_id=?', principalId);
    return {
      models: allowed.map((id) => ({
        id,
        points: prices.perReply[id],
        voicePoints: prices.voice,
      })),
      selected,
      metered,
      balance,
      repliesLeft: metered ? Math.max(0, Math.floor(balance / (prices.perReply[selected] + prices.voice))) : 0,
      version: prices.version,
      ...(plan ? { plan } : {}),
      ...(notice === 'model_withdrawn' ? { notice } : {}),
    };
  });
}
export type { Reader as PointsReader };
