import * as nodeCrypto from 'node:crypto';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { WEB_IDENTITY_LIMITS as LIMITS } from '../../../config/web-v1.ts';
import { GUEST_GRACE_MS } from '../../../config/web-public.ts';
import { freeTier } from '../admission/web-free-tier.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { webDataLifecycleEnabled, type WebRetentionRow } from '../admission/web-retention.ts';

interface SessionRow {
  id: string;
  principal_id: string;
  account_id: string | null;
  csrf_seed: Uint8Array;
  recovery_epoch: string;
  security_revision: number;
  created_at: number;
  last_active_at: number;
  absolute_expires_at: number;
  revoked_at: number | null;
}
interface AccountRow {
  id: string;
  principal_id: string;
  username_norm: string;
  password_salt: Uint8Array;
  password_tag: Uint8Array;
  security_revision: number;
  active: number;
}

export interface WebIdentityKeys {
  keyId: string;
  sealKey: Buffer;
  requestKey: Buffer;
}
export interface WebIdentityOptions {
  origin: string;
  cookieName: string;
  keys: WebIdentityKeys;
  clock: Clock;
  nextId?: () => string;
  random?: (size: number) => Buffer;
  /** GUEST_GRACE_ENABLED: how long past its trial a guest without a login keeps a usable session (0 = off). */
  guestGraceMs?: number;
}

/** Bounds native Argon2 work before it reaches libuv; no cheaper test-only parameters. */
class PasswordGate {
  private active = 0;
  private waiting: { start: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }[] = [];
  async run(password: string, salt: Uint8Array): Promise<Buffer> {
    ensure(typeof nodeCrypto.argon2 === 'function', 'WEB_ARGON2_UNAVAILABLE');
    return new Promise<Buffer>((resolve, reject) => {
      const start = () => {
        this.active++;
        const finish = () => {
          this.active--;
          const next = this.waiting.shift();
          if (next) {
            clearTimeout(next.timer);
            next.start();
          }
        };
        try {
          nodeCrypto.argon2(
            'argon2id',
            {
              message: password,
              nonce: salt,
              memory: LIMITS.argon2MemoryKiB,
              passes: LIMITS.argon2Passes,
              parallelism: 1,
              tagLength: 32,
            },
            (error, tag) => {
              finish();
              if (error) reject(error);
              else resolve(tag);
            },
          );
        } catch (error) {
          finish();
          reject(error);
        }
      };
      if (this.active < LIMITS.kdfConcurrent) start();
      else {
        ensure(this.waiting.length < LIMITS.kdfWaiting, 'WEB_KDF_BUSY');
        const entry = {
          start,
          reject,
          timer: setTimeout(() => {
            const index = this.waiting.indexOf(entry);
            if (index !== -1) this.waiting.splice(index, 1);
            reject(new Error('WEB_KDF_TIMEOUT'));
          }, LIMITS.kdfWaitMs),
        };
        this.waiting.push(entry);
      }
    });
  }
}
const passwordGate = new PasswordGate();

function fixedTimeEqual(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Internal only. A future HTTP transport must own cookie/header parsing and never JSON-serialize bearer. */
export class WebIdentity {
  private readonly store: WebStore;
  private readonly options: WebIdentityOptions;
  constructor(store: WebStore, options: WebIdentityOptions) {
    ensure(
      options.keys.sealKey.length === 32 &&
        options.keys.requestKey.length === 32 &&
        options.keys.keyId.length > 0 &&
        options.keys.keyId.length <= 64,
      'WEB_IDENTITY_KEYS_REQUIRED',
    );
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(options.origin);
    } catch {
      ensure(false, 'WEB_IDENTITY_ORIGIN_INVALID');
    }
    ensure(
      parsedOrigin.protocol === 'https:' &&
        parsedOrigin.origin === options.origin &&
        !parsedOrigin.username &&
        !parsedOrigin.password &&
        !parsedOrigin.search &&
        !parsedOrigin.hash &&
        /^__Host-[A-Za-z0-9_-]+$/.test(options.cookieName),
      'WEB_IDENTITY_ORIGIN_INVALID',
    );
    ensure(
      [
        103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 122, 123, 124,
        125, 126,
      ].includes(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1),
      'WEB_IDENTITY_MIGRATION_REQUIRED',
    );
    this.store = store;
    this.options = options;
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
  private epoch() {
    const row = this.store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1');
    ensure(row?.recovery_epoch && row.recovery_epoch !== 'uninitialized', 'WEB_RECOVERY_EPOCH_REQUIRED');
    return row.recovery_epoch;
  }
  private digest(token: string) {
    ensure(/^[A-Za-z0-9_-]{43}$/.test(token), 'SESSION_EXPIRED');
    return createHmac('sha256', this.options.keys.requestKey).update('session\0').update(token).digest('hex');
  }
  private csrf(row: SessionRow, purpose: 'active' | 'receipt') {
    return createHmac('sha256', this.options.keys.requestKey)
      .update(JSON.stringify([this.store.instanceId, this.epoch(), row.id, purpose]))
      .update(row.csrf_seed)
      .digest('base64url');
  }
  private sessionFor(token: string) {
    return this.store.get<SessionRow>('SELECT * FROM web_sessions WHERE token_digest=?', this.digest(token));
  }
  /** Schema 118: an email login bound to the principal. Older schemas have none. */
  hasLogin(principalId: string) {
    return (
      !!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'") &&
      !!this.store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', principalId)
    );
  }
  /** A guest principal with a login gets the same long-lived cookie an invited player does (the trial itself is unchanged). */
  private hasGuestLogin(principalId: string) {
    return (
      this.hasLogin(principalId) &&
      !!this.store.get("SELECT 1 FROM web_principals WHERE id=? AND kind='guest'", principalId)
    );
  }
  /**
   * Grace (flag GUEST_GRACE_ENABLED): the session of a guest whose trial has ended stays usable until the end of the
   * grace period so the player can still sign up. Usable is all it is: the content gates ('live' and 'read') still answer
   * TRIAL_EXPIRED, so no reply starts and no history is read. A guest that never started a trial has no grace.
   */
  private inGrace(row: SessionRow, now: number) {
    const grace = this.options.guestGraceMs ?? 0;
    if (grace <= 0 || row.account_id !== null || !webDataLifecycleEnabled(this.store)) return false;
    const retention = this.store.get<{ expires_at: number | null; state: string }>(
      `SELECT r.expires_at,r.state FROM web_guest_retention r
      JOIN web_principals p ON p.id=r.principal_id AND p.world_id=r.world_id
      WHERE r.principal_id=? AND p.kind='guest'`,
      row.principal_id,
    );
    return (
      !!retention && retention.state === 'active' && retention.expires_at !== null && now < retention.expires_at + grace
    );
  }
  private withinLifetime(row: SessionRow, now: number) {
    return (
      now < row.absolute_expires_at || this.inGrace(row, now)
    );
  }
  private activeSession(token: string, now: number) {
    const row = this.sessionFor(token);
    ensure(
      row &&
        row.revoked_at === null &&
        this.withinLifetime(row, now) &&
        row.recovery_epoch === this.epoch() &&
        (row.account_id === null || now - row.last_active_at < LIMITS.accountIdleMs),
      'SESSION_EXPIRED',
    );
    if (row.account_id !== null) {
      const account = this.store.get<AccountRow>('SELECT * FROM web_accounts WHERE id=?', row.account_id);
      ensure(
        account?.active === 1 &&
          account.principal_id === row.principal_id &&
          account.security_revision === row.security_revision,
        'SESSION_EXPIRED',
      );
    }
    return row;
  }
  private writeAuth(row: SessionRow, csrf: string, origin: string) {
    ensure(origin === this.options.origin, 'ORIGIN_INVALID');
    ensure(/^[A-Za-z0-9_-]{43}$/.test(csrf), 'CSRF_INVALID');
    ensure(fixedTimeEqual(Buffer.from(csrf), Buffer.from(this.csrf(row, 'active'))), 'CSRF_INVALID');
  }
  /**
   * Part 17c: with the free tier on, a guest session created now outlives the 7 day trial and the grace period (14 days);
   * otherwise LIMITS.guestAbsoluteMs (24 h). Sessions that already exist keep the lifetime they were created with.
   */
  private guestLifetimeMs() {
    const tier = freeTier(this.store);
    return tier.on ? Math.max(LIMITS.guestAbsoluteMs, tier.trialWindowMs + GUEST_GRACE_MS) : LIMITS.guestAbsoluteMs;
  }
  private newSession(principalId: string, accountId: string | null, now: number, durable = false) {
    const token = this.random(32).toString('base64url');
    const row: SessionRow = {
      id: this.id(),
      principal_id: principalId,
      account_id: accountId,
      recovery_epoch: this.epoch(),
      security_revision: accountId ? 1 : 0,
      csrf_seed: this.random(32),
      created_at: now,
      last_active_at: now,
      absolute_expires_at:
        now +
        (accountId
          ? LIMITS.accountAbsoluteMs
          : durable
            ? LIMITS.inviteCookieMaxAgeSeconds * 1000
            : this.guestLifetimeMs()),
      revoked_at: null,
    };
    this.store.run(
      `INSERT INTO web_sessions(id,token_digest,principal_id,account_id,recovery_epoch,security_revision,
      csrf_seed,created_at,last_active_at,absolute_expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
      row.id,
      this.digest(token),
      row.principal_id,
      row.account_id,
      row.recovery_epoch,
      row.security_revision,
      row.csrf_seed,
      now,
      now,
      row.absolute_expires_at,
    );
    return { token, row };
  }

  /** Only a known, naturally expired guest cookie may be discarded by bootstrap.
   * Active, revoked and account identities keep their recovery boundary.
   */
  expiredGuest(token: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    const row = this.sessionFor(token);
    return (
      !!row &&
      row.account_id === null &&
      row.revoked_at === null &&
      row.recovery_epoch === this.epoch() &&
      row.absolute_expires_at <= this.now() &&
      !!this.store.get("SELECT 1 FROM web_principals WHERE id=? AND kind='guest'", row.principal_id)
    );
  }

  /** Signed up with an email login: the transport gives the cookie the 400-day lifetime. */
  isDurableSession(token: string) {
    const now = this.now(),
      row = this.activeSession(token, now);
    return row.account_id === null && this.hasGuestLogin(row.principal_id);
  }

  /**
   * True when a cookie names nothing a page could still use: unknown, revoked, expired or malformed. Only then may
   * bootstrap clear it.
   */
  isDeadCookie(token: string) {
    try {
      this.activeSession(token, this.now());
      return false;
    } catch {
      // fall through
    }
    return true;
  }

  /** Transport write authorization that also names the session (for per-session actions such as "log out other devices"). */
  authorizeSessionWrite(token: string, csrf: string, origin: string) {
    const session = this.activeSession(token, this.now());
    this.writeAuth(session, csrf, origin);
    const principal = this.authenticate(token);
    ensure(session.account_id === null, 'WEB_GUEST_REQUIRED');
    return {
      sessionId: session.id,
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      kind: principal.kind,
    };
  }
  /** A signed-in-or-not read of the current session; never throws for a dead cookie. */
  peekSession(token: string | undefined) {
    if (!token) return null;
    try {
      const row = this.activeSession(token, this.now());
      const principal = this.authenticate(token);
      return {
        sessionId: row.id,
        principalId: principal.principalId,
        playerId: principal.player_id,
        worldId: principal.world_id,
        kind: principal.kind,
      };
    } catch {
      return null;
    }
  }
  /** Signup: the session that did it becomes as long-lived as a login session (400 days), never shorter than it was. */
  extendToLoginLifetime(sessionId: string) {
    this.store.run(
      'UPDATE web_sessions SET absolute_expires_at=max(absolute_expires_at,?) WHERE id=? AND revoked_at IS NULL',
      this.now() + LIMITS.inviteCookieMaxAgeSeconds * 1000,
      sessionId,
    );
  }
  /** Login: a fresh long-lived session for the login's principal. Other sessions stay as they are. */
  issueLoginSession(principalId: string) {
    ensure(this.hasLogin(principalId), 'PLAYER_LOGIN_REQUIRED');
    const session = this.newSession(principalId, null, this.now(), true);
    return { issuedToken: session.token, csrf: this.csrf(session.row, 'active'), sessionId: session.row.id };
  }
  /** Ends every live session of the principal, or every one except `exceptSessionId`. Returns how many ended. */
  revokeSessions(principalId: string, exceptSessionId: string | null = null) {
    return this.store.run(
      `UPDATE web_sessions SET revoked_at=? WHERE principal_id=? AND revoked_at IS NULL AND (? IS NULL OR id<>?)`,
      this.now(),
      principalId,
      exceptSessionId,
      exceptSessionId,
    ).changes;
  }

  /** An existing tab receives its stable CSRF; a rotated old token is never overwritten with a fresh guest. */
  bootstrap(token?: string) {
    const now = this.now();
    if (token) {
      const active = this.activeSession(token, now);
      if (active.account_id !== null)
        this.store.run('UPDATE web_sessions SET last_active_at=? WHERE id=? AND revoked_at IS NULL', now, active.id);
      return {
        principalId: active.principal_id,
        csrf: this.csrf(active, 'active'),
        issuedToken: null as string | null,
      };
    }
    return this.store.transaction(() => {
      const playerId = this.id(),
        worldId = this.id(),
        principalId = this.id();
      this.store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      this.store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'UTC', '{}');
      this.store.run(
        "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
        principalId,
        playerId,
        worldId,
      );
      if (webDataLifecycleEnabled(this.store))
        this.store.run(
          `INSERT INTO web_guest_retention
        (principal_id,world_id,state) VALUES (?,?,'unstarted')`,
          principalId,
          worldId,
        );
      const session = this.newSession(principalId, null, now);
      return { principalId, csrf: this.csrf(session.row, 'active'), issuedToken: session.token };
    });
  }

  authenticate(token: string) {
    const row = this.activeSession(token, this.now());
    const principal = this.store.get<{ world_id: string; player_id: string; kind: string }>(
      'SELECT world_id,player_id,kind FROM web_principals WHERE id=?',
      row.principal_id,
    );
    ensure(principal, 'SESSION_EXPIRED');
    return { principalId: row.principal_id, ...principal };
  }

  /** Transport write authorization; reuse the session's cryptographic Origin/CSRF gate. */
  authorizeWrite(token: string, csrf: string, origin: string) {
    const session = this.activeSession(token, this.now());
    this.writeAuth(session, csrf, origin);
    return this.authenticate(token);
  }
  /** Write authorization for redeeming an invite code: names the guest session (never client-supplied); an account session is refused. */
  authorizeInviteAction(token: string, csrf: string, origin: string) {
    const session = this.activeSession(token, this.now());
    this.writeAuth(session, csrf, origin);
    const principal = this.authenticate(token);
    ensure(
      session.account_id === null && principal.kind === 'guest',
      'WEB_GUEST_REQUIRED',
    );
    return {
      sessionId: session.id,
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      kind: 'guest' as const,
    };
  }

  async register(
    token: string,
    csrf: string,
    origin: string,
    input: { requestId: string; username: string; password: string },
  ) {
    ensure(typeof input.username === 'string' && typeof input.password === 'string', 'WEB_REGISTER_INPUT_INVALID');
    const username = input.username.trim().toLowerCase();
    ensure(
      /^[a-z0-9_.-]{3,32}$/.test(username) &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
        Buffer.byteLength(input.password, 'utf8') >= 8 &&
        Buffer.byteLength(input.password, 'utf8') <= 1024,
      'WEB_REGISTER_INPUT_INVALID',
    );
    const initial = this.activeSession(token, this.now());
    this.writeAuth(initial, csrf, origin);
    ensure(initial.account_id === null, 'WEB_GUEST_REQUIRED');
    const salt = this.random(16);
    const tag = await passwordGate.run(input.password, salt);
    return this.store.transaction(() => {
      const now = this.now(),
        old = this.activeSession(token, now);
      this.writeAuth(old, csrf, origin);
      ensure(old.id === initial.id && old.account_id === null, 'WEB_GUEST_REQUIRED');
      const principal = this.store.get<{ kind: string }>(
        'SELECT kind FROM web_principals WHERE id=?',
        old.principal_id,
      );
      ensure(principal?.kind === 'guest', 'WEB_GUEST_REQUIRED');
      if (webDataLifecycleEnabled(this.store)) {
        const retention = this.store.get<WebRetentionRow>(
          'SELECT * FROM web_guest_retention WHERE principal_id=?',
          old.principal_id,
        );
        ensure(
          retention &&
            (retention.state === 'unstarted' ||
              (retention.state === 'active' && retention.expires_at !== null && now < retention.expires_at)),
          'TRIAL_EXPIRED',
        );
        ensure(
          this.store.run(
            `UPDATE web_guest_retention SET state='protected',revision=revision+1
          WHERE principal_id=? AND world_id=? AND revision=? AND state IN ('unstarted','active')`,
            old.principal_id,
            retention.world_id,
            retention.revision,
          ).changes === 1,
          'WEB_RETENTION_STALE',
        );
      }
      ensure(!this.store.get('SELECT 1 FROM web_accounts WHERE username_norm=?', username), 'WEB_USERNAME_UNAVAILABLE');
      const accountId = this.id();
      this.store.run(
        'INSERT INTO web_accounts VALUES (?,?,?,?,?,1,1,?)',
        accountId,
        old.principal_id,
        username,
        salt,
        tag,
        now,
      );
      ensure(
        this.store.run(
          "UPDATE web_principals SET kind='account',revision=revision+1 WHERE id=? AND kind='guest'",
          old.principal_id,
        ).changes === 1,
        'WEB_GUEST_REQUIRED',
      );
      const next = this.newSession(old.principal_id, accountId, now);
      ensure(
        this.store.run('UPDATE web_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, old.id)
          .changes === 1,
        'SESSION_EXPIRED',
      );
      return {
        receipt: { accountId, principalId: old.principal_id, duplicate: false },
        issuedToken: next.token,
        csrf: this.csrf(next.row, 'active'),
      };
    });
  }

  logout(token: string, csrf: string, origin: string) {
    return this.store.transaction(() => {
      const now = this.now(),
        session = this.activeSession(token, now);
      this.writeAuth(session, csrf, origin);
      this.store.run('UPDATE web_sessions SET revoked_at=? WHERE id=?', now, session.id);
    });
  }
}
