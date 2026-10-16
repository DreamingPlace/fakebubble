import {
  type ModelChoiceInfo,
  DEFAULT_PLAYER_MODEL,
  POINTS,
  isPlayerModelId,
  repliesLeft,
  replyPoints,
  type PlayerModelId,
} from '../../../packages/contracts/player-models.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { bonusSpent, hasSignupBonus } from './web-free-tier.ts';

/**
 * Player model choice and points (Part 21b, flag PLAYER_MODEL_CHOICE_ENABLED, default off).
 *
 * Points are player fairness; the budget ledger is money safety. The two are independent: a charge here never touches a
 * reservation, and a refund here never releases one. The business object is the only writer of these tables.
 *
 * Who has points: a principal that holds the signup bonus (a guest that signed up with a verified email) while the feature
 * is on. Its balance is created LAZILY on first touch from the old accounting: 100 - 10 x bonus replies already spent.
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
type Flagged = { playerModelChoice?: readonly PlayerModelId[]; publicFreeTier?: boolean };

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** Tables of 123_model_choice.sql: an older database has no model choice, whatever the flag says. */
export const modelChoiceTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_points_balance') && tableExists(store, 'web_operation_models');

/** The models the owner currently offers (PLAYER_TEXT_MODELS), or null while the feature is off. DeepSeek is always in. */
export function offeredModels(store: Pick<BusinessStore, 'get'> & Flagged): readonly PlayerModelId[] | null {
  const list = store.playerModelChoice;
  return list && list.length > 0 && modelChoiceTablesExist(store) ? list : null;
}
/** True for a principal with a points account: feature on and the signup bonus held. */
export const hasPoints = (store: Pick<BusinessStore, 'get'> & Flagged, principalId: string) =>
  offeredModels(store) !== null && hasSignupBonus(store, principalId);
/** An invited principal: may choose a model, is never charged points (its daily reply limit is unchanged). */
export const isInvited = (store: Pick<BusinessStore, 'get'> & Flagged, principalId: string) =>
  offeredModels(store) !== null &&
  store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind === 'invite';
/** May this principal pick a model (points account or invited)? */
export const canChooseModel = (store: Pick<BusinessStore, 'get'> & Flagged, principalId: string) =>
  hasPoints(store, principalId) || isInvited(store, principalId);
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

/** The saved choice, as a model that is still offered: a model the owner has switched off becomes DeepSeek, once, with a notice. */
export function effectiveModel(store: Writer & Flagged, now: number, principalId: string): PlayerModelId {
  const offered = offeredModels(store);
  if (!offered) return DEFAULT_PLAYER_MODEL;
  const row = store.get<{ model: string }>('SELECT model FROM web_player_model WHERE principal_id=?', principalId);
  if (!row || !isPlayerModelId(row.model)) return DEFAULT_PLAYER_MODEL;
  if (offered.includes(row.model)) return row.model;
  store.run(
    "UPDATE web_player_model SET model='deepseek',notice='model_withdrawn',updated_at=? WHERE principal_id=?",
    now,
    principalId,
  );
  return DEFAULT_PLAYER_MODEL;
}

export function setPlayerModel(store: Writer & Flagged, now: number, principalId: string, model: unknown) {
  const offered = offeredModels(store);
  ensure(offered && canChooseModel(store, principalId), 'NOT_FOUND');
  ensure(isPlayerModelId(model) && offered.includes(model), 'MODEL_NOT_AVAILABLE');
  store.run(
    `INSERT INTO web_player_model(principal_id,model,notice,updated_at) VALUES (?,?,NULL,?)
    ON CONFLICT(principal_id) DO UPDATE SET model=excluded.model,notice=NULL,updated_at=excluded.updated_at`,
    principalId,
    model,
    now,
  );
  return model;
}

/** Create the balance on first touch from the old bonus accounting (no backfill in the migration). */
export function ensureBalance(store: Writer & Flagged, now: number, principalId: string) {
  const row = store.get<{ balance: number }>(
    'SELECT balance FROM web_points_balance WHERE principal_id=?',
    principalId,
  );
  if (row) return row.balance;
  const start = Math.max(0, POINTS.signupBalance - POINTS.perBonusReply * bonusSpent(store, principalId));
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
      POINTS.version,
      now,
    );
  return start;
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
        Math.max(0, POINTS.perReply[chosen] - POINTS.perReply[actual]),
        row.price_version,
      );
      if (row.voice === 1) {
        const voiced = store.get(
          `SELECT 1 FROM web_publication_items WHERE operation_id=? AND origin='narrative' AND media_id IS NOT NULL LIMIT 1`,
          row.operation_id,
        );
        if (!voiced) refund(store, now, principalId, row.operation_id, 'no_voice', POINTS.voice, row.price_version);
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
  const balance = ensureBalance(store, now, principalId);
  if (policyKind(store, principalId) === 'unlimited') return { ok: true, points: 0 };
  const price = replyPoints(model, true);
  if (balance >= price) return { ok: true, points: price };
  return {
    ok: false,
    code: balance >= replyPoints(DEFAULT_PLAYER_MODEL, true) ? 'POINTS_INSUFFICIENT' : 'TRIAL_EXHAUSTED',
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
  const price = policyKind(store, principalId) === 'unlimited' ? 0 : replyPoints(model, true);
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
      POINTS.version,
      now,
    );
  }
  store.run(
    `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,created_at)
    VALUES (?,?,1,?,?,?)`,
    operationId,
    model,
    price,
    POINTS.version,
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
    POINTS.version,
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
  if (!offered || !canChooseModel(store, principalId)) return null;
  const metered = hasSignupBonus(store, principalId);
  return store.transaction(() => {
    let balance = 0;
    if (metered) {
      reconcilePoints(store, now, principalId);
      balance = ensureBalance(store, now, principalId);
    }
    const selected = effectiveModel(store, now, principalId);
    const notice = store.get<{ notice: string | null }>(
      'SELECT notice FROM web_player_model WHERE principal_id=?',
      principalId,
    )?.notice;
    if (notice && consumeNotice) store.run('UPDATE web_player_model SET notice=NULL WHERE principal_id=?', principalId);
    return {
      models: offered.map((id) => ({
        id,
        points: POINTS.perReply[id],
        voicePoints: POINTS.voice,
      })),
      selected,
      metered,
      balance,
      repliesLeft: metered ? repliesLeft(balance, selected) : 0,
      version: POINTS.version,
      ...(notice === 'model_withdrawn' ? { notice } : {}),
    };
  });
}
export type { Reader as PointsReader };
