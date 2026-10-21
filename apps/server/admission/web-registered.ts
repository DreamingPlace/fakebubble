import { createHmac } from 'node:crypto';
import { POINTS } from '../../../packages/contracts/player-models.ts';
import { bonusCanonicalEmail } from '../identity/email-address.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { freeTier, guestTrialOver, signupBonusTablesExist } from './web-free-tier.ts';
import { currentPrices } from './web-model-settings.ts';
import { modelChoiceTablesExist, offeredModels, unusedTrial } from './web-points.ts';

/**
 * Part 17h: the signup bonus for a REGISTERED player that never got it (see isRegistered in web-free-tier.ts): a guest with an
 * email login signed up before Part 17b or while SIGNUP_BONUS_ENABLED was off.
 *
 * It is granted ONCE, on the first touch (the player's first message, page load or account read), by the same rule a signup
 * uses: once per canonical e-mail address (web_bonus_emails, which outlives the account). The principal then holds an
 * ordinary web_signup_bonus row, so the opening balance is the Part 21f one (100 - 10 x bonus replies spent + 10 x unused
 * trial replies) and every other rule that reads the row (memory, retention, billing) applies unchanged.
 *
 * When the canonical address already received a bonus on ANOTHER principal the grant is refused, but the player stays
 * registered and is never answered TRIAL_EXPIRED: it gets a points account with whatever it has - the unused trial replies
 * converted to points while its trial window is still open, nothing once the window is over.
 */
type Writer = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'> & {
  publicFreeTier?: boolean;
};
/** The keyed digest of a normalized address (the same one a signup writes to web_bonus_emails). */
export type BonusEmailKey = (emailNorm: string) => string;
export function signupBonusEmailKey(requestKey: Buffer): BonusEmailKey {
  const key = createHmac('sha256', requestKey).update('web-signup-bonus-email-v1').digest();
  return (emailNorm) => createHmac('sha256', key).update(bonusCanonicalEmail(emailNorm)).digest('hex');
}

/** Idempotent; a no-op for everyone who is not a registered player without a bonus row. Returns true when the bonus was granted now. */
export function ensureRegisteredBonus(
  store: Writer,
  keyOf: BonusEmailKey | undefined,
  now: number,
  principalId: string,
): boolean {
  if (!keyOf || store.publicFreeTier !== true || !signupBonusTablesExist(store)) return false;
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'")) return false;
  // Cheap exits first: this runs on every message and page load.
  if (store.get('SELECT 1 FROM web_signup_bonus WHERE principal_id=?', principalId)) return false;
  const login = store.get<{ email_norm: string }>(
    'SELECT email_norm FROM web_player_logins WHERE principal_id=?',
    principalId,
  );
  if (!login) return false;
  const kind = store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId)?.kind;
  if (kind !== 'guest') return false;
  const points = modelChoiceTablesExist(store);
  if (points && store.get('SELECT 1 FROM web_points_balance WHERE principal_id=?', principalId)) return false;
  return store.transaction(() => {
    const granted =
      store.run(
        'INSERT INTO web_bonus_emails(email_hmac,granted_at) VALUES (?,?) ON CONFLICT(email_hmac) DO NOTHING',
        keyOf(login.email_norm),
        now,
      ).changes === 1;
    if (granted) {
      store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, now);
      return true;
    }
    // Refused: open the points account it will be metered on, with what it already owns, so no later touch can open a richer one.
    if (points && offeredModels(store) !== null) {
      const live = kind === 'guest' && !guestTrialOver(store, principalId, now);
      const start = live && freeTier(store).on ? POINTS.perBonusReply * unusedTrial(store, principalId) : 0;
      store.run(
        "INSERT INTO web_points_policy(principal_id,kind,amount,created_at,updated_at) VALUES (?,'one_off',0,?,?) ON CONFLICT DO NOTHING",
        principalId,
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
    }
    return false;
  });
}
