import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { requireWebRuntime } from '../platform/web-store-contract.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const csrfFor = (cookie: string) => hash(`bubble-admin-csrf:${cookie}`);

/**
 * Part 59: the admin session slides. It lasts ADMIN_IDLE_MS (8 h) after the LAST request the console made, and never longer than
 * ADMIN_ABSOLUTE_MS (24 h) after the sign-in. Before this Part it was a fixed 8 h from sign-in, so an owner who was working was
 * logged out mid-edit. The write is throttled (at most once per ADMIN_RENEW_STEP_MS) so reads stay cheap.
 */
export const ADMIN_IDLE_MS = 8 * 60 * 60_000;
export const ADMIN_ABSOLUTE_MS = 24 * 60 * 60_000;
export const ADMIN_RENEW_STEP_MS = 10 * 60_000;

/** The local synthetic instance's administrator login. Grant issuance requires trusted local code. */
export class WebInviteAdmin {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly origin: string;
  private readonly random: (size: number) => Buffer;
  private readonly nextId: () => string;
  constructor(
    store: Store,
    clock: Clock,
    origin: string,
    random: (size: number) => Buffer = randomBytes,
    nextId: () => string = randomUUID,
  ) {
    requireWebRuntime(store, 'invite');
    ensure(
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_sessions'") &&
        store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_login_grants'"),
      'WEB_INVITE_ADMIN_SCHEMA_REQUIRED',
    );
    this.store = store;
    this.clock = clock;
    this.origin = origin;
    this.random = random;
    this.nextId = nextId;
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  private newSecret() {
    const bytes = this.random(32);
    ensure(Buffer.isBuffer(bytes) && bytes.length === 32, 'WEB_RANDOM_INVALID');
    return bytes.toString('base64url');
  }

  /** Never expose this as a public unauthenticated route. */
  issueLoginGrant() {
    const token = this.newSecret();
    const expiresAt = this.now() + 60 * 60_000;
    ensure(Number.isSafeInteger(expiresAt), 'INVALID_TIME');
    this.store.run('INSERT INTO admin_login_grants VALUES (?,?,NULL)', hash(token), expiresAt);
    return { token, expiresAt };
  }

  login(token: unknown, origin: unknown) {
    ensure(origin === this.origin, 'ADMIN_UNAUTHORIZED');
    ensure(secret(token), 'ADMIN_INVALID_GRANT');
    return this.store.transaction(() => {
      const now = this.now();
      const grant = this.store.get<{ expires_at: number; consumed_session_id: string | null }>(
        'SELECT expires_at,consumed_session_id FROM admin_login_grants WHERE token_hash=?',
        hash(token),
      );
      ensure(grant && grant.expires_at > now && grant.consumed_session_id === null, 'ADMIN_INVALID_GRANT');
      const cookie = this.newSecret(),
        id = this.nextId(),
        expiresAt = now + ADMIN_IDLE_MS;
      ensure(Number.isSafeInteger(expiresAt), 'INVALID_TIME');
      this.store.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', id, hash(cookie), now, expiresAt);
      const consumed = this.store.run(
        'UPDATE admin_login_grants SET consumed_session_id=? WHERE token_hash=? AND consumed_session_id IS NULL',
        id,
        hash(token),
      );
      ensure(consumed.changes === 1, 'ADMIN_INVALID_GRANT');
      return { cookie, csrf: csrfFor(cookie), expiresAt };
    });
  }

  authorize(cookie: unknown, csrf: unknown, origin: unknown) {
    ensure(origin === this.origin && secret(cookie), 'ADMIN_UNAUTHORIZED');
    const row = this.store.get<{ id: string; expires_at: number; created_at: number }>(
      `SELECT id,expires_at,created_at FROM admin_sessions
      WHERE secret_hash=? AND revoked_at IS NULL AND expires_at>?`,
      hash(cookie),
      this.now(),
    );
    ensure(row, 'ADMIN_UNAUTHORIZED');
    const expected = csrfFor(cookie);
    ensure(
      typeof csrf === 'string' &&
        /^[a-f0-9]{64}$/.test(csrf) &&
        timingSafeEqual(Buffer.from(csrf), Buffer.from(expected)),
      'ADMIN_CSRF_REQUIRED',
    );
    return { sessionId: row.id, expiresAt: this.renew(row) };
  }

  /** Slides the expiry forward for a session that is in use (never past the absolute limit); returns the expiry now in force. */
  private renew(row: { id: string; expires_at: number; created_at: number }) {
    const now = this.now();
    const next = Math.min(now + ADMIN_IDLE_MS, row.created_at + ADMIN_ABSOLUTE_MS);
    if (next - row.expires_at < ADMIN_RENEW_STEP_MS) return row.expires_at;
    this.store.run(
      'UPDATE admin_sessions SET expires_at=? WHERE id=? AND revoked_at IS NULL AND expires_at<?',
      next,
      row.id,
      next,
    );
    return next;
  }

  /** Safe same-origin GET bootstrap; the HttpOnly cookie itself never enters JavaScript. */
  session(cookie: unknown) {
    ensure(secret(cookie), 'ADMIN_UNAUTHORIZED');
    const row = this.store.get<{ id: string; expires_at: number; created_at: number }>(
      `SELECT id,expires_at,created_at FROM admin_sessions
      WHERE secret_hash=? AND revoked_at IS NULL AND expires_at>?`,
      hash(cookie),
      this.now(),
    );
    ensure(row, 'ADMIN_UNAUTHORIZED');
    return { csrf: csrfFor(cookie), expiresAt: this.renew(row) };
  }

  logout(cookie: unknown) {
    ensure(secret(cookie), 'ADMIN_UNAUTHORIZED');
    const now = this.now();
    const changed = this.store.run(
      'UPDATE admin_sessions SET revoked_at=? WHERE secret_hash=? AND revoked_at IS NULL AND expires_at>?',
      now,
      hash(cookie),
      now,
    );
    ensure(changed.changes === 1, 'ADMIN_UNAUTHORIZED');
  }
}
