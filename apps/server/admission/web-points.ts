import {
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
 * is on. Its balance is created LAZILY on first touch from the old accounting: 100 - 10 x bonus replies already spent. Guests
 * (the 5-reply DeepSeek-only trial), invited players and administrators are not touched and see no model picker.
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
  ensure(offered && hasPoints(store, principalId), 'NOT_FOUND');
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
  store.run(
    'INSERT INTO web_points_balance(principal_id,balance,created_at,updated_at) VALUES (?,?,?,?)',
    principalId,
    start,
    now,
    now,
  );
  if (start > 0)
    store.run(
      `INSERT INTO web_points_events(principal_id,operation_id,kind,reason,points,price_version,created_at)
      VALUES (?,NULL,'grant','signup_bonus_init',?,?,?)`,
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
  // The unique index (operation, kind, reason) makes a second settlement of the same fact a no-op.
  const inserted = store.run(
    `INSERT INTO web_points_events(principal_id,operation_id,kind,reason,points,price_version,created_at)
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
  const price = replyPoints(model, true);
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
    `INSERT INTO web_points_events(principal_id,operation_id,kind,reason,points,price_version,created_at)
    VALUES (?,?,'spend','reply',?,?,?)`,
    principalId,
    operationId,
    price,
    POINTS.version,
    now,
  );
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

export interface ModelChoiceState {
  models: { id: PlayerModelId; points: number; voicePoints: number }[];
  selected: PlayerModelId;
  balance: number;
  repliesLeft: number;
  version: number;
  notice?: 'model_withdrawn';
}
/** What the player page shows. Reads, but settles and creates the balance on the way; consumes the one-time notice. */
export function modelChoiceState(store: Writer & Flagged, now: number, principalId: string): ModelChoiceState | null {
  const offered = offeredModels(store);
  if (!offered || !hasSignupBonus(store, principalId)) return null;
  return store.transaction(() => {
    reconcilePoints(store, now, principalId);
    const balance = ensureBalance(store, now, principalId);
    const selected = effectiveModel(store, now, principalId);
    const notice = store.get<{ notice: string | null }>(
      'SELECT notice FROM web_player_model WHERE principal_id=?',
      principalId,
    )?.notice;
    if (notice) store.run('UPDATE web_player_model SET notice=NULL WHERE principal_id=?', principalId);
    return {
      models: offered.map((id) => ({
        id,
        points: POINTS.perReply[id],
        voicePoints: POINTS.voice,
      })),
      selected,
      balance,
      repliesLeft: repliesLeft(balance, selected),
      version: POINTS.version,
      ...(notice === 'model_withdrawn' ? { notice } : {}),
    };
  });
}
export type { Reader as PointsReader };
