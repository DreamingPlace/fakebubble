import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, RetryAfterError, ensure } from '../../../packages/domain/errors.ts';
import { WEB_IDENTITY_LIMITS } from '../../../config/web-v1.ts';
import { playerPasswords, validatePlayerPassword } from '../admin/web-admin-password.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { requireWebContent } from '../admission/web-retention.ts';
import { maskEmail, normalizeEmail } from './email-address.ts';
import type { WebIdentity } from './web-identity.ts';

export type EmailPurpose = 'signup' | 'reset' | 'bind';
/** What a mailer is asked to send. `code` mails carry the six digits; `registered` mails carry no code at all. */
export interface PlayerMailer {
  send(message: {
    id: string;
    to: string;
    purpose: EmailPurpose;
    kind: 'code' | 'registered';
    code: string | null;
    expiresAt: number;
  }): Promise<void>;
  waitUntil?(task: Promise<void>): void;
}
export interface WebPlayerAccountsOptions {
  origin: string;
  /** REQUEST_KEY: code digests and throttle keys are HMACs under keys derived from it. */
  requestKey: Buffer;
  clock: Clock;
  /** Null: no mail can be sent. */
  mailer: PlayerMailer | null;
  /** PLAYER_SIGNUP_ENABLED. When false, signup / reset / bind refuse; login still works. */
  signupEnabled: boolean;
  /** PLAYER_EMAIL_DAILY_CAP (emails per UTC day). */
  dailyCap: number;
  nextId?: () => string;
  random?: (size: number) => Buffer;
}

export const PLAYER_LIMITS = Object.freeze({
  codeTtlMs: 10 * 60_000,
  codeAttempts: 5,
  resendMs: 60_000,
  emailPerHour: 5,
  ipPerHour: 10,
  hourMs: 60 * 60_000,
  defaultDailyCap: 200,
  loginWindowMs: 15 * 60_000,
  loginPerEmail: 10,
  loginPerIp: 30,
  passwordPerPrincipal: 5,
  /** Wrong codes per email over ALL challenges and purposes, rolling (hour slots, never expiring early). */
  codeWrongPerEmail: 10,
  codeWindowMs: 24 * 60 * 60_000,
  codeSlotMs: 60 * 60_000,
  nicknameMax: 20,
  kdfConcurrent: 2,
  kdfWaiting: 8,
});

type LoginRow = {
  principal_id: string;
  email_norm: string;
  password_hash: string;
  created_at: number;
  password_changed_at: number;
  last_seen_at: number;
};
type ChallengeRow = {
  id: string;
  purpose: EmailPurpose;
  email_norm: string;
  principal_id: string | null;
  code_digest: string;
  attempts: number;
  ip_hash: string;
  created_at: number;
  expires_at: number;
  verified_at: number | null;
  consumed_at: number | null;
};
export type PlayerSessionInput = { token: string; csrf: string; origin: string };
type Scope = ReturnType<WebIdentity['authorizeSessionWrite']>;

/** Bounds scrypt work: a busy gate refuses instead of queueing without limit. */
class KdfGate {
  private active = 0;
  private waiting: (() => void)[] = [];
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= PLAYER_LIMITS.kdfConcurrent) {
      ensure(this.waiting.length < PLAYER_LIMITS.kdfWaiting, 'RATE_LIMITED');
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
const gate = new KdfGate();

/** The nickname the player chose, as it is stored and shown to the character. */
export function playerNickname(value: unknown) {
  ensure(typeof value === 'string', 'PLAYER_NICKNAME_INVALID');
  const nickname = value.trim();
  ensure(
    [...nickname].length >= 1 &&
      [...nickname].length <= PLAYER_LIMITS.nicknameMax &&
      // Control characters, newlines/separators and bidi overrides are refused; everything else is the player's choice.
      !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(nickname),
    'PLAYER_NICKNAME_INVALID',
  );
  return nickname;
}
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/**
 * Email logins for players (schema 118). A login is a credential bound 1:1 to a principal; it never changes the
 * principal's kind, its admission treatment or its entitlement. The business object is the only writer.
 * Codes, passwords and full addresses never reach a log, a metric, a receipt or an error.
 */
export class WebPlayerAccounts {
  private readonly store: WebStore;
  private readonly identity: WebIdentity;
  private readonly options: WebPlayerAccountsOptions;
  private readonly codeKey: Buffer;
  private readonly throttleKey: Buffer;

  constructor(store: WebStore, identity: WebIdentity, options: WebPlayerAccountsOptions) {
    ensure(
      options.requestKey.length === 32 &&
        Number.isSafeInteger(options.dailyCap) &&
        options.dailyCap >= 1 &&
        options.dailyCap <= 100_000 &&
        (!options.signupEnabled || options.mailer !== null),
      'WEB_PLAYER_CONFIG_INVALID',
    );
    ensure(
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'") &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_email_challenges'"),
      'WEB_PLAYER_LOGIN_SCHEMA_REQUIRED',
    );
    this.store = store;
    this.identity = identity;
    this.options = options;
    this.codeKey = createHmac('sha256', options.requestKey).update('web-player-email-code-v1').digest();
    this.throttleKey = createHmac('sha256', options.requestKey).update('web-player-throttle-v1').digest();
  }

  get signupEnabled() {
    return this.options.signupEnabled;
  }
  private now() {
    const now = this.options.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private id() {
    return (this.options.nextId ?? randomUUID)();
  }
  private random(size: number) {
    const value = (this.options.random ?? randomBytes)(size);
    ensure(Buffer.isBuffer(value) && value.length === size, 'WEB_RANDOM_INVALID');
    return value;
  }
  private origin(origin: unknown) {
    ensure(origin === this.options.origin, 'ORIGIN_INVALID');
  }
  requireOrigin(origin: unknown) {
    this.origin(origin);
  }
  private key(label: string, value: string) {
    return createHmac('sha256', this.throttleKey).update(label).update('\0').update(value).digest('hex');
  }
  private codeDigest(id: string, email: string, purpose: EmailPurpose, code: string) {
    return createHmac('sha256', this.codeKey)
      .update(JSON.stringify([id, email, purpose, code]))
      .digest('hex');
  }
  private sixDigits() {
    // Reject the uneven tail rather than bias the million possible codes.
    for (let attempt = 0; attempt < 32; attempt++) {
      const number = this.random(4).readUInt32BE();
      if (number < 4_294_000_000) return String(number % 1_000_000).padStart(6, '0');
    }
    ensure(false, 'WEB_RANDOM_INVALID');
  }
  private requireSignupOpen() {
    ensure(this.options.signupEnabled && this.options.mailer, 'PLAYER_SIGNUP_DISABLED');
  }
  private loginOf(principalId: string) {
    return this.store.get<LoginRow>('SELECT * FROM web_player_logins WHERE principal_id=?', principalId);
  }
  private activeGrant(principalId: string, now: number) {
    return !!this.store.get(
      `SELECT 1 FROM web_invite_grants g JOIN web_principals p ON p.id=g.principal_id
      WHERE g.principal_id=? AND g.player_id=p.player_id AND g.world_id=p.world_id AND p.kind='invite'
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)`,
      principalId,
      now,
    );
  }
  /** A login may open a session only while its principal is usable: an invited player's grant must still be active. */
  private ensureLoginUsable(principalId: string, now: number) {
    const principal = this.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', principalId);
    ensure(principal, 'PLAYER_LOGIN_INVALID');
    ensure(principal.kind === 'guest' || this.activeGrant(principalId, now), 'PLAYER_ACCESS_REVOKED');
  }

  /** Counters are reserved before the work they guard, so parallel requests cannot all slip under a limit. */
  private reserve(scope: 'login-email' | 'login-ip' | 'password-principal', key: string, limit: number, now: number) {
    const row = this.store.get<{ window_at: number; failures: number }>(
      `INSERT INTO web_player_throttle(scope,key,window_at,failures) VALUES (?,?,?,1)
      ON CONFLICT(scope,key) DO UPDATE SET
        window_at=CASE WHEN ?-window_at>=? THEN ? ELSE window_at END,
        failures=CASE WHEN ?-window_at>=? THEN 1 ELSE failures+1 END
      RETURNING window_at,failures`,
      scope,
      key,
      now,
      now,
      PLAYER_LIMITS.loginWindowMs,
      now,
      now,
      PLAYER_LIMITS.loginWindowMs,
    )!;
    if (row.failures > limit)
      throw new RetryAfterError(
        'PLAYER_RATE_LIMITED',
        Math.max(1000, row.window_at + PLAYER_LIMITS.loginWindowMs - now),
      );
  }
  private release(scope: 'login-email' | 'login-ip' | 'password-principal', key: string, all: boolean) {
    if (all) this.store.run('DELETE FROM web_player_throttle WHERE scope=? AND key=?', scope, key);
    else
      this.store.run(
        'UPDATE web_player_throttle SET failures=failures-1 WHERE scope=? AND key=? AND failures>0',
        scope,
        key,
      );
  }

  /**
   * Wrong codes per email. One row per (email, hour slot); the total is the sum over the slots that cannot have left the
   * 24 h window yet (a slot counts until its END is 24 h old, so a guess is never forgotten early).
   */
  private codeSlotKey(email: string, slot: number) {
    return this.key('code-email', `${email}\0${slot}`);
  }
  private codeSlots(email: string, now: number) {
    const last = Math.floor(now / PLAYER_LIMITS.codeSlotMs);
    const first = last - Math.ceil(PLAYER_LIMITS.codeWindowMs / PLAYER_LIMITS.codeSlotMs);
    const slots: number[] = [];
    for (let slot = first; slot <= last; slot++) slots.push(slot);
    return slots
      .map((slot) => ({ slot, key: this.codeSlotKey(email, slot), start: slot * PLAYER_LIMITS.codeSlotMs }))
      .filter((entry) => entry.start + PLAYER_LIMITS.codeSlotMs + PLAYER_LIMITS.codeWindowMs > now);
  }
  /** Refuses (PLAYER_RATE_LIMITED + retry-after) once the email has used up its wrong codes. Same answer for every email. */
  private requireCodeBudget(email: string, now: number) {
    const slots = this.codeSlots(email, now);
    const rows = this.store.all<{ key: string; failures: number }>(
      `SELECT key,failures FROM web_player_throttle WHERE scope='code-email' AND key IN (${slots.map(() => '?').join(',')})`,
      ...slots.map((entry) => entry.key),
    );
    const byKey = new Map(rows.map((row) => [row.key, row.failures]));
    let total = 0;
    for (const entry of slots) total += byKey.get(entry.key) ?? 0;
    if (total < PLAYER_LIMITS.codeWrongPerEmail) return;
    // Oldest slots drop out first; the answer is when the total falls under the limit again.
    let remaining = total;
    for (const entry of slots) {
      remaining -= byKey.get(entry.key) ?? 0;
      if (remaining < PLAYER_LIMITS.codeWrongPerEmail)
        throw new RetryAfterError(
          'PLAYER_RATE_LIMITED',
          Math.max(1000, entry.start + PLAYER_LIMITS.codeSlotMs + PLAYER_LIMITS.codeWindowMs - now),
        );
    }
  }
  private recordWrongCode(email: string, now: number) {
    const slot = Math.floor(now / PLAYER_LIMITS.codeSlotMs);
    this.store.run(
      `INSERT INTO web_player_throttle(scope,key,window_at,failures) VALUES ('code-email',?,?,1)
      ON CONFLICT(scope,key) DO UPDATE SET failures=failures+1`,
      this.codeSlotKey(email, slot),
      slot * PLAYER_LIMITS.codeSlotMs,
    );
  }

  /**
   * Activity for the 180-day inactivity purge: bootstrap calls this for the signed-in principal. The row is written
   * only when its last_seen_at is before the start of the current UTC day, i.e. at most once per UTC day.
   */
  touch(principalId: string) {
    const now = this.now();
    this.store.run(
      'UPDATE web_player_logins SET last_seen_at=? WHERE principal_id=? AND last_seen_at<?',
      now,
      principalId,
      now - (now % 86_400_000),
    );
  }

  /** Who is asking: the signed-out sees only whether signup is open; a signed-in player sees their own login. */
  info(token: string | undefined) {
    const session = this.identity.peekSession(token);
    const base = { signupEnabled: this.options.signupEnabled };
    if (!session) return { ...base, signedIn: false as const };
    const login = this.loginOf(session.principalId);
    const nickname = this.currentNickname(session.worldId);
    return {
      ...base,
      signedIn: true as const,
      kind: session.kind,
      hasLogin: !!login,
      emailMasked: login ? maskEmail(login.email_norm) : null,
      nickname,
      // A legacy invited player without a login may bind one.
      canBind: !login && session.kind === 'invite' && this.activeGrant(session.principalId, this.now()),
    };
  }
  private currentNickname(worldId: string) {
    const row = this.store.get<{ profile_json: string }>(
      'SELECT profile_json FROM player_profile_versions WHERE world_id=? ORDER BY revision DESC LIMIT 1',
      worldId,
    );
    if (!row) return null;
    try {
      const name = (JSON.parse(row.profile_json) as { name?: unknown }).name;
      return typeof name === 'string' ? name : null;
    } catch {
      return null;
    }
  }

  /**
   * Starts a signup / reset / bind challenge. The response has the same shape and the same limits whether or not the
   * address is registered: a registered address gets a "已注册" mail (signup/bind), an unknown reset address gets nothing.
   */
  requestCode(input: {
    purpose: unknown;
    email: unknown;
    ipHash: string;
    origin: unknown;
    session?: PlayerSessionInput | undefined;
  }) {
    this.origin(input.origin);
    ensure(/^[a-f0-9]{64}$/.test(input.ipHash), 'WEB_TRUSTED_IP_REQUIRED');
    ensure(input.purpose === 'signup' || input.purpose === 'reset' || input.purpose === 'bind', 'INVALID_REQUEST');
    const purpose = input.purpose as EmailPurpose;
    this.requireSignupOpen();
    const email = normalizeEmail(input.email, 'PLAYER_EMAIL_INVALID');
    let scope: Scope | null = null;
    if (purpose !== 'reset') {
      ensure(input.session, 'AUTH_REQUIRED');
      scope = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
      this.ensureEligible(purpose, scope, this.now());
    }
    const created = this.store.transaction(() => {
      const now = this.now();
      this.sweep(now);
      if (scope && purpose !== 'reset') this.ensureEligible(purpose, scope, now);
      // Before anything is charged or looked up, and before registration is consulted: the same refusal for every
      // address and every purpose.
      this.requireCodeBudget(email, now);
      this.chargeSend(email, input.ipHash, now);
      this.store.run(
        'UPDATE web_email_challenges SET consumed_at=? WHERE email_norm=? AND purpose=? AND consumed_at IS NULL',
        now,
        email,
        purpose,
      );
      const registered = !!this.store.get('SELECT 1 FROM web_player_logins WHERE email_norm=?', email);
      // signup/bind to a registered address -> "already registered" mail; reset of an unknown address -> no mail.
      const kind: 'code' | 'registered' | null =
        purpose === 'reset' ? (registered ? 'code' : null) : registered ? 'registered' : 'code';
      const id = this.id(),
        expiresAt = now + PLAYER_LIMITS.codeTtlMs;
      const code = kind === 'code' ? this.sixDigits() : null;
      // Without a code to type, the digest is of unguessable bytes: the challenge exists but can never verify.
      const digest = this.codeDigest(id, email, purpose, code ?? this.random(16).toString('hex'));
      this.store.run(
        `INSERT INTO web_email_challenges(id,purpose,email_norm,principal_id,code_digest,ip_hash,created_at,expires_at,delivery)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        id,
        purpose,
        email,
        scope?.principalId ?? null,
        digest,
        input.ipHash,
        now,
        expiresAt,
        kind === null ? 'none' : 'pending',
      );
      return { id, expiresAt, kind, code };
    });
    if (created.kind !== null) this.dispatch(created.id, email, purpose, created.kind, created.code, created.expiresAt);
    return { challengeId: created.id, expiresAt: created.expiresAt, resendAfterMs: PLAYER_LIMITS.resendMs };
  }
  private ensureEligible(purpose: 'signup' | 'bind', scope: Scope, now: number) {
    ensure(!this.loginOf(scope.principalId), 'PLAYER_LOGIN_EXISTS');
    if (purpose === 'signup') {
      ensure(scope.kind === 'guest', 'PLAYER_SIGNUP_UNAVAILABLE');
      // Only a live trial can become a kept account: an ended one is already (being) purged.
      requireWebContent(this.store, this.options.clock, scope.principalId, scope.worldId);
    } else ensure(scope.kind === 'invite' && this.activeGrant(scope.principalId, now), 'PLAYER_BIND_UNAVAILABLE');
  }
  /** Old challenges and idle counters go; the send ledger keeps a full day. */
  private sweep(now: number) {
    this.store.run('DELETE FROM web_email_challenges WHERE created_at<?', now - 24 * PLAYER_LIMITS.hourMs);
    // Each scope ages out on its own window: the 24 h code counter must outlive the 15 min login window.
    this.store.run(
      "DELETE FROM web_player_throttle WHERE scope<>'code-email' AND window_at<?",
      now - PLAYER_LIMITS.loginWindowMs,
    );
    this.store.run(
      "DELETE FROM web_player_throttle WHERE scope='code-email' AND window_at<?",
      now - PLAYER_LIMITS.codeWindowMs - PLAYER_LIMITS.codeSlotMs,
    );
    this.store.run(
      'DELETE FROM web_player_email_daily WHERE day<?',
      new Date(now - 2 * 24 * PLAYER_LIMITS.hourMs).toISOString().slice(0, 10),
    );
  }
  /** Every limit is checked before anything is sent; the slot is spent even when no mail goes out (no oracle). */
  private chargeSend(email: string, ipHash: string, now: number) {
    const last = this.store.get<{ last: number | null }>(
      'SELECT max(created_at) last FROM web_email_challenges WHERE email_norm=?',
      email,
    )?.last;
    if (last != null && now - last < PLAYER_LIMITS.resendMs)
      throw new RetryAfterError('PLAYER_RATE_LIMITED', PLAYER_LIMITS.resendMs - (now - last));
    const since = now - PLAYER_LIMITS.hourMs;
    for (const [column, value, limit] of [
      ['email_norm', email, PLAYER_LIMITS.emailPerHour],
      ['ip_hash', ipHash, PLAYER_LIMITS.ipPerHour],
    ] as const) {
      const rows = this.store.all<{ created_at: number }>(
        `SELECT created_at FROM web_email_challenges WHERE ${column}=? AND created_at>? ORDER BY created_at`,
        value,
        since,
      );
      if (rows.length >= limit)
        throw new RetryAfterError(
          'PLAYER_RATE_LIMITED',
          Math.max(1000, rows[rows.length - limit]!.created_at + PLAYER_LIMITS.hourMs - now),
        );
    }
    const day = new Date(now).toISOString().slice(0, 10);
    const sends =
      this.store.get<{ sends: number }>('SELECT sends FROM web_player_email_daily WHERE day=?', day)?.sends ?? 0;
    if (sends >= this.options.dailyCap) {
      const nextDay = Date.parse(`${day}T00:00:00.000Z`) + 24 * PLAYER_LIMITS.hourMs;
      throw new RetryAfterError('PLAYER_EMAIL_DAILY_CAP', Math.max(1000, nextDay - now));
    }
    this.store.run(
      `INSERT INTO web_player_email_daily(day,sends) VALUES (?,1) ON CONFLICT(day) DO UPDATE SET sends=sends+1`,
      day,
    );
  }
  /**
   * The challenge is persisted before the mailer runs and the answer does not wait for it. A send that errors or times
   * out is recorded 'unknown' and never retried; the player may ask again after the cooldown (which counts).
   */
  private dispatch(
    id: string,
    to: string,
    purpose: EmailPurpose,
    kind: 'code' | 'registered',
    code: string | null,
    expiresAt: number,
  ) {
    const mailer = this.options.mailer!;
    const delivery = Promise.resolve()
      .then(() => mailer.send({ id, to, purpose, kind, code, expiresAt }))
      .then(
        () => {
          this.store.run("UPDATE web_email_challenges SET delivery='accepted' WHERE id=?", id);
        },
        () => {
          this.store.run("UPDATE web_email_challenges SET delivery='unknown' WHERE id=?", id);
        },
      );
    mailer.waitUntil?.(delivery);
    void delivery.catch(() => {});
  }

  /** Step 2: the six digits. Each look spends an attempt first; the fifth wrong one kills the challenge. */
  verifyCode(input: {
    challengeId: unknown;
    code: unknown;
    origin: unknown;
    session?: PlayerSessionInput | undefined;
  }) {
    this.origin(input.origin);
    ensure(
      identifier(input.challengeId) && typeof input.code === 'string' && /^[0-9]{6}$/.test(input.code),
      'PLAYER_CODE_INVALID',
    );
    const challengeId = input.challengeId;
    const code = input.code;
    // The attempt is committed even when the code is wrong, so the failure is thrown after the transaction.
    const right = this.store.transaction(() => {
      const now = this.now();
      const row = this.store.get<ChallengeRow>('SELECT * FROM web_email_challenges WHERE id=?', challengeId);
      if (
        !row ||
        row.consumed_at !== null ||
        row.verified_at !== null ||
        row.expires_at <= now ||
        row.attempts >= PLAYER_LIMITS.codeAttempts
      )
        return false;
      if (row.purpose !== 'reset') {
        if (!input.session) return false;
        const scope = this.identity.authorizeSessionWrite(
          input.session.token,
          input.session.csrf,
          input.session.origin,
        );
        if (scope.principalId !== row.principal_id) return false;
      }
      // Spent wrong codes of this email, over every challenge: once used up, even the right code is not looked at.
      this.requireCodeBudget(row.email_norm, now);
      this.store.run('UPDATE web_email_challenges SET attempts=attempts+1 WHERE id=?', row.id);
      const supplied = Buffer.from(this.codeDigest(row.id, row.email_norm, row.purpose, code));
      const expected = Buffer.from(row.code_digest);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        this.recordWrongCode(row.email_norm, now);
        return false;
      }
      this.store.run('UPDATE web_email_challenges SET verified_at=? WHERE id=? AND verified_at IS NULL', now, row.id);
      return true;
    });
    ensure(right, 'PLAYER_CODE_INVALID');
    return { verified: true as const };
  }
  private verifiedChallenge(id: string, purposes: EmailPurpose[], now: number) {
    const row = this.store.get<ChallengeRow>('SELECT * FROM web_email_challenges WHERE id=?', id);
    ensure(
      row &&
        purposes.includes(row.purpose) &&
        row.verified_at !== null &&
        row.consumed_at === null &&
        row.expires_at > now,
      'PLAYER_CODE_INVALID',
    );
    return row;
  }

  /** The 名片 (player_profile_versions) gains a revision with name = nickname; an unchanged name adds nothing. */
  private writeNickname(worldId: string, nickname: string, now: number) {
    const latest = this.store.get<{ revision: number; profile_json: string }>(
      'SELECT revision,profile_json FROM player_profile_versions WHERE world_id=? ORDER BY revision DESC LIMIT 1',
      worldId,
    );
    const prior = latest ? (JSON.parse(latest.profile_json) as Record<string, unknown>) : null;
    if (prior?.name === nickname) return latest!.revision;
    const profile = prior
      ? { ...prior, name: nickname }
      : { name: nickname, age: null, city: '', occupation: '', familyBackground: '', sharedCharacterIds: [] };
    const revision = (latest?.revision ?? 0) + 1;
    this.store.run(
      'INSERT INTO player_profile_versions(world_id,revision,profile_json,updated_at) VALUES (?,?,?,?)',
      worldId,
      revision,
      JSON.stringify(profile),
      now,
    );
    return revision;
  }

  /**
   * Step 3 of 注册 / 绑定邮箱: password + nickname after the code was right. Binds the login to the CURRENT principal
   * (its chats stay) and writes the nickname into the 名片. Other sessions are untouched; a bind also revokes the
   * principal's recovery credential, so the old "revoke every other session" path can no longer be used on them.
   */
  async complete(input: {
    challengeId: unknown;
    password: unknown;
    nickname: unknown;
    session: PlayerSessionInput;
    purpose: 'signup' | 'bind';
  }) {
    this.requireSignupOpen();
    ensure(identifier(input.challengeId), 'PLAYER_CODE_INVALID');
    validatePlayerPassword(input.password);
    const nickname = playerNickname(input.nickname),
      password = input.password,
      challengeId = input.challengeId;
    const first = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
    this.verifiedChallenge(challengeId, [input.purpose], this.now());
    const hash = await gate.run(() => playerPasswords.hash(password));
    return this.store.transaction(() => {
      const now = this.now();
      const scope = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
      ensure(scope.sessionId === first.sessionId, 'SESSION_EXPIRED');
      const challenge = this.verifiedChallenge(challengeId, [input.purpose], now);
      ensure(challenge.principal_id === scope.principalId, 'PLAYER_CODE_INVALID');
      this.ensureEligible(input.purpose, scope, now);
      ensure(
        !this.store.get('SELECT 1 FROM web_player_logins WHERE email_norm=?', challenge.email_norm),
        'PLAYER_EMAIL_UNAVAILABLE',
      );
      this.store.run(
        `INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at)
        VALUES (?,?,?,?,?,?)`,
        scope.principalId,
        challenge.email_norm,
        hash,
        now,
        now,
        now,
      );
      this.writeNickname(scope.worldId, nickname, now);
      this.identity.extendToLoginLifetime(scope.sessionId);
      if (input.purpose === 'bind' && this.store.get("SELECT 1 FROM sqlite_master WHERE name='web_invite_credentials'"))
        this.store.run(
          `UPDATE web_invite_credentials SET revoked_at=? WHERE revoked_at IS NULL AND grant_id IN
          (SELECT id FROM web_invite_grants WHERE principal_id=?)`,
          now,
          scope.principalId,
        );
      this.store.run(
        'UPDATE web_email_challenges SET consumed_at=? WHERE email_norm=? AND consumed_at IS NULL',
        now,
        challenge.email_norm,
      );
      return { nickname, emailMasked: maskEmail(challenge.email_norm), token: input.session.token };
    });
  }

  /** 登录: email + password -> a new session of that login's principal. Never merges principals, never touches other sessions. */
  async login(input: { email: unknown; password: unknown; origin: unknown; ipHash: string }) {
    this.origin(input.origin);
    ensure(/^[a-f0-9]{64}$/.test(input.ipHash), 'WEB_TRUSTED_IP_REQUIRED');
    // Malformed input is the same generic failure a wrong password is.
    let email: string;
    try {
      email = normalizeEmail(input.email, 'PLAYER_LOGIN_INVALID');
      validatePlayerPassword(input.password);
    } catch {
      throw new DomainError('PLAYER_LOGIN_INVALID');
    }
    const password = input.password as string;
    const emailKey = this.key('email', email),
      ipKey = this.key('ip', input.ipHash);
    this.store.transaction(() => {
      const now = this.now();
      this.reserve('login-email', emailKey, PLAYER_LIMITS.loginPerEmail, now);
      this.reserve('login-ip', ipKey, PLAYER_LIMITS.loginPerIp, now);
    });
    const row = this.store.get<LoginRow>('SELECT * FROM web_player_logins WHERE email_norm=?', email);
    // An unknown address pays the same scrypt cost: no timing oracle for who is registered.
    const valid = await gate.run(() => playerPasswords.verify(password, row?.password_hash ?? null));
    if (!valid || !row) throw new DomainError('PLAYER_LOGIN_INVALID');
    return this.store.transaction(() => {
      const now = this.now();
      const current = this.loginOf(row.principal_id);
      ensure(current && current.password_hash === row.password_hash, 'PLAYER_LOGIN_INVALID');
      this.ensureLoginUsable(row.principal_id, now);
      this.release('login-email', emailKey, true);
      this.release('login-ip', ipKey, false);
      this.store.run('UPDATE web_player_logins SET last_seen_at=? WHERE principal_id=?', now, row.principal_id);
      return this.identity.issueLoginSession(row.principal_id);
    });
  }

  /** 忘记密码, last step: new password after the emailed code. Every other session of the principal ends. */
  async reset(input: { challengeId: unknown; password: unknown; origin: unknown; ipHash: string }) {
    this.origin(input.origin);
    this.requireSignupOpen();
    ensure(identifier(input.challengeId) && /^[a-f0-9]{64}$/.test(input.ipHash), 'PLAYER_CODE_INVALID');
    validatePlayerPassword(input.password);
    const password = input.password,
      challengeId = input.challengeId;
    this.verifiedChallenge(challengeId, ['reset'], this.now());
    const hash = await gate.run(() => playerPasswords.hash(password));
    return this.store.transaction(() => {
      const now = this.now();
      const challenge = this.verifiedChallenge(challengeId, ['reset'], now);
      const login = this.store.get<LoginRow>(
        'SELECT * FROM web_player_logins WHERE email_norm=?',
        challenge.email_norm,
      );
      ensure(login, 'PLAYER_CODE_INVALID');
      this.ensureLoginUsable(login.principal_id, now);
      this.store.run(
        'UPDATE web_player_logins SET password_hash=?,password_changed_at=? WHERE principal_id=?',
        hash,
        now,
        login.principal_id,
      );
      this.store.run(
        'UPDATE web_email_challenges SET consumed_at=? WHERE email_norm=? AND consumed_at IS NULL',
        now,
        challenge.email_norm,
      );
      // A forgotten password may mean a lost device: everything signed in before now ends, this device signs in fresh.
      this.identity.revokeSessions(login.principal_id);
      this.release('login-email', this.key('email', challenge.email_norm), true);
      return this.identity.issueLoginSession(login.principal_id);
    });
  }

  /** 修改密码: needs the current password; optionally ends the other devices. */
  async changePassword(input: { current: unknown; next: unknown; logoutOthers: unknown; session: PlayerSessionInput }) {
    validatePlayerPassword(input.current);
    validatePlayerPassword(input.next);
    ensure(typeof input.logoutOthers === 'boolean', 'INVALID_REQUEST');
    const current = input.current,
      next = input.next;
    const scope = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
    const login = this.loginOf(scope.principalId);
    ensure(login, 'PLAYER_LOGIN_REQUIRED');
    const key = this.key('principal', scope.principalId);
    this.store.transaction(() =>
      this.reserve('password-principal', key, PLAYER_LIMITS.passwordPerPrincipal, this.now()),
    );
    const valid = await gate.run(() => playerPasswords.verify(current, login.password_hash));
    ensure(valid, 'PLAYER_LOGIN_INVALID');
    const hash = await gate.run(() => playerPasswords.hash(next));
    return this.store.transaction(() => {
      const now = this.now();
      const again = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
      ensure(again.sessionId === scope.sessionId, 'SESSION_EXPIRED');
      const row = this.loginOf(scope.principalId);
      ensure(row && row.password_hash === login.password_hash, 'PLAYER_LOGIN_INVALID');
      this.store.run(
        'UPDATE web_player_logins SET password_hash=?,password_changed_at=? WHERE principal_id=?',
        hash,
        now,
        scope.principalId,
      );
      this.release('password-principal', key, true);
      const ended = input.logoutOthers ? this.identity.revokeSessions(scope.principalId, scope.sessionId) : 0;
      return { changed: true as const, otherSessionsEnded: ended };
    });
  }

  /** 退出其他设备: every session of the principal except this one. */
  logoutOthers(session: PlayerSessionInput) {
    return this.store.transaction(() => {
      const scope = this.identity.authorizeSessionWrite(session.token, session.csrf, session.origin);
      ensure(this.loginOf(scope.principalId), 'PLAYER_LOGIN_REQUIRED');
      return { ended: this.identity.revokeSessions(scope.principalId, scope.sessionId) };
    });
  }

  /** 我的昵称: a new 名片 revision (unchanged names add none). */
  setNickname(input: { nickname: unknown; session: PlayerSessionInput }) {
    const nickname = playerNickname(input.nickname);
    return this.store.transaction(() => {
      const scope = this.identity.authorizeSessionWrite(input.session.token, input.session.csrf, input.session.origin);
      ensure(this.loginOf(scope.principalId), 'PLAYER_LOGIN_REQUIRED');
      return { nickname, revision: this.writeNickname(scope.worldId, nickname, this.now()) };
    });
  }

  /** 退出登录: this session ends; the cookie is cleared by the transport. */
  logout(session: PlayerSessionInput) {
    this.identity.logout(session.token, session.csrf, session.origin);
    return { loggedOut: true as const };
  }
}
