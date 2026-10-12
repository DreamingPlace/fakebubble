import { DomainError } from '../packages/domain/errors.ts';

/**
 * Part 17 (public readiness). Every switch here defaults OFF: with nothing configured the deployment behaves exactly as
 * it did before. Values come from Worker vars; anything present but invalid refuses to start.
 */

/** A guest without a login whose trial ended keeps its data this much longer so it can still sign up. */
export const GUEST_GRACE_MS = 7 * 24 * 60 * 60_000;

export interface WebAlertConfig {
  /** ALERT_EMAIL_TO: the owner's address (a destination the ADMIN_EMAIL binding is allowed to reach). */
  readonly to: string;
  /** Business 5xx / exceptions in the last hour at or above this count. */
  readonly errorsPerHour: number;
  /** Provider spend booked in the current UTC day at or above this many micros. */
  readonly dailySpendMicros: number;
  /** Total spend (settled + held) at or above this percent of the budget cap. */
  readonly budgetPercent: number;
  /** Reply validation failures at or above this percent of the last hour's finished replies... */
  readonly validationFailPercent: number;
  /** ...but only when at least this many replies finished in that hour (a single failure is not a 100 % rate). */
  readonly validationMinSamples: number;
  /** UTC hour (0-23) of the daily digest. */
  readonly digestHourUtc: number;
}
export interface WebTurnstileConfig {
  readonly siteKey: string;
  readonly secret: string;
}
export interface WebPublicConfig {
  /** 0 when GUEST_GRACE_ENABLED is off. */
  readonly graceMs: number;
  readonly accountDelete: boolean;
  readonly legalPages: boolean;
  /** SIGNUP_BONUS_ENABLED: 5-reply guest trial + 10-reply signup bonus + 3 signups per IP per UTC day (Part 17b). */
  readonly signupBonus: boolean;
  readonly alerts: WebAlertConfig | null;
  readonly turnstile: WebTurnstileConfig | null;
}

export const ALERT_DEFAULTS = Object.freeze({
  errorsPerHour: 20,
  // 5 USD at 1e6 micros per USD; the real daily cost of the beta is a fraction of this.
  dailySpendMicros: 5_000_000,
  budgetPercent: 80,
  validationFailPercent: 20,
  validationMinSamples: 10,
  digestHourUtc: 1,
});

const on = (value: unknown) => value === 'true';
function integer(name: string, value: unknown, min: number, max: number, fallback: number) {
  if (value === undefined || value === '') return fallback;
  const parsed = typeof value === 'string' && /^[0-9]{1,12}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new DomainError(`WEB_PUBLIC_CONFIG_INVALID_${name}`);
  return parsed;
}

export function webPublicFromEnv(env: Record<string, unknown>): WebPublicConfig {
  let alerts: WebAlertConfig | null = null;
  if (on(env.ALERTS_ENABLED)) {
    const to = env.ALERT_EMAIL_TO;
    if (typeof to !== 'string' || !/^[^\s@<>,;"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/.test(to))
      throw new DomainError('WEB_PUBLIC_CONFIG_INVALID_ALERT_EMAIL_TO');
    alerts = Object.freeze({
      to,
      errorsPerHour: integer(
        'ALERT_ERRORS_PER_HOUR',
        env.ALERT_ERRORS_PER_HOUR,
        1,
        100_000,
        ALERT_DEFAULTS.errorsPerHour,
      ),
      dailySpendMicros: integer(
        'ALERT_DAILY_SPEND_MICROS',
        env.ALERT_DAILY_SPEND_MICROS,
        1,
        1_000_000_000_000,
        ALERT_DEFAULTS.dailySpendMicros,
      ),
      budgetPercent: integer('ALERT_BUDGET_PERCENT', env.ALERT_BUDGET_PERCENT, 1, 100, ALERT_DEFAULTS.budgetPercent),
      validationFailPercent: integer(
        'ALERT_VALIDATION_FAIL_PERCENT',
        env.ALERT_VALIDATION_FAIL_PERCENT,
        1,
        100,
        ALERT_DEFAULTS.validationFailPercent,
      ),
      validationMinSamples: integer(
        'ALERT_VALIDATION_MIN_SAMPLES',
        env.ALERT_VALIDATION_MIN_SAMPLES,
        1,
        100_000,
        ALERT_DEFAULTS.validationMinSamples,
      ),
      digestHourUtc: integer('ALERT_DIGEST_HOUR_UTC', env.ALERT_DIGEST_HOUR_UTC, 0, 23, ALERT_DEFAULTS.digestHourUtc),
    });
  }
  let turnstile: WebTurnstileConfig | null = null;
  if (on(env.TURNSTILE_ENABLED)) {
    const siteKey = env.TURNSTILE_SITE_KEY,
      secret = env.TURNSTILE_SECRET;
    if (typeof siteKey !== 'string' || !/^[0-9A-Za-z_-]{1,64}$/.test(siteKey))
      throw new DomainError('WEB_PUBLIC_CONFIG_INVALID_TURNSTILE_SITE_KEY');
    if (typeof secret !== 'string' || secret.length < 8 || secret.length > 256 || /\s/.test(secret))
      throw new DomainError('WEB_PUBLIC_CONFIG_INVALID_TURNSTILE_SECRET');
    turnstile = Object.freeze({ siteKey, secret });
  }
  return Object.freeze({
    graceMs: on(env.GUEST_GRACE_ENABLED) ? GUEST_GRACE_MS : 0,
    accountDelete: on(env.ACCOUNT_DELETE_ENABLED),
    legalPages: on(env.LEGAL_PAGES_ENABLED),
    signupBonus: on(env.SIGNUP_BONUS_ENABLED),
    alerts,
    turnstile,
  });
}
