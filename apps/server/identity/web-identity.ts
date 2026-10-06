import * as nodeCrypto from 'node:crypto';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { WEB_IDENTITY_LIMITS as LIMITS } from '../../../config/web-v1.ts';
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
interface ReceiptRow {
  id: string;
  old_session_id: string;
  new_session_id: string;
  account_id: string;
  action: 'register';
  request_id: string;
  request_mac: Uint8Array;
  security_revision: number;
  public_receipt: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: number;
  expires_at: number;
  successful_retrievals: number;
  failed_attempts: number;
  failed_window_at: number | null;
  revoked_at: number | null;
}
interface InviteReceiptRow {
  id: string;
  old_session_id: string;
  new_session_id: string;
  grant_id: string;
  request_id: string;
  code_digest: string;
  public_receipt: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: number;
  expires_at: number;
  successful_retrievals: number;
  failed_attempts: number;
  failed_window_at: number | null;
  revoked_at: number | null;
}
interface InviteGrantRow {
  id: string;
  principal_id: string;
  player_id: string;
  world_id: string;
  expires_at: number | null;
  revoked_at: number | null;
}
interface InviteCredentialReceiptRow {
  id: string;
  grant_id: string;
  request_id: string;
  old_secret_digest: string;
  new_secret_digest: string;
  new_session_id: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: number;
  expires_at: number;
  successful_retrievals: number;
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
      [103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115].includes(
        store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
      ),
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
  private activeSession(token: string, now: number) {
    const row = this.sessionFor(token);
    ensure(
      row &&
        row.revoked_at === null &&
        now < row.absolute_expires_at &&
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
  private newSession(principalId: string, accountId: string | null, now: number) {
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
      absolute_expires_at: now + (accountId ? LIMITS.accountAbsoluteMs : LIMITS.guestAbsoluteMs),
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
  private requestMac(username: string, password: string) {
    return createHmac('sha256', this.options.keys.requestKey)
      .update(JSON.stringify(['web-register-v1', username, password]))
      .digest();
  }
  private inviteSecretDigest(secret: string) {
    ensure(/^[A-Za-z0-9_-]{43}$/.test(secret), 'WEB_INVITE_RECOVERY_UNAVAILABLE');
    return createHmac('sha256', this.options.keys.requestKey)
      .update('invite-recovery-v1\0')
      .update(secret)
      .digest('hex');
  }
  private activeInviteGrant(principalId: string, now: number) {
    const grant = this.store.get<InviteGrantRow>(
      `SELECT g.* FROM web_invite_grants g
      JOIN web_principals p ON p.id=g.principal_id WHERE g.principal_id=?
        AND g.player_id=p.player_id AND g.world_id=p.world_id AND p.kind='invite'
        AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)`,
      principalId,
      now,
    );
    ensure(grant, 'WEB_INVITE_ACCESS_REQUIRED');
    return grant;
  }
  private aad(
    receipt: Pick<
      ReceiptRow,
      'old_session_id' | 'new_session_id' | 'action' | 'request_id' | 'request_mac' | 'security_revision'
    >,
  ) {
    return Buffer.from(
      JSON.stringify([
        this.store.instanceId,
        this.epoch(),
        receipt.old_session_id,
        receipt.new_session_id,
        receipt.action,
        receipt.request_id,
        Buffer.from(receipt.request_mac).toString('hex'),
        receipt.security_revision,
      ]),
    );
  }

  /** Only a known, naturally expired guest cookie may be discarded by bootstrap.
   * Active, revoked, rotated, invited and account identities keep their recovery boundary.
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

  /** An existing tab receives its stable CSRF; a rotated old token is never overwritten with a fresh guest. */
  bootstrap(token?: string) {
    const now = this.now();
    if (token) {
      const row = this.sessionFor(token);
      if (
        row?.revoked_at !== null &&
        row?.revoked_at !== undefined &&
        row.recovery_epoch === this.epoch() &&
        this.store.get<ReceiptRow>(
          `SELECT * FROM web_identity_receipts WHERE old_session_id=? AND revoked_at IS NULL
          AND expires_at>? AND successful_retrievals<?`,
          row.id,
          now,
          LIMITS.receiptSuccessfulRetrievals,
        )
      ) {
        ensure(false, 'SESSION_ROTATED_RECOVERABLE');
      }
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
  /** Internal invite core only; session ID is never a client-supplied grant. */
  authorizeInviteAction(token: string, csrf: string, origin: string) {
    const session = this.activeSession(token, this.now());
    this.writeAuth(session, csrf, origin);
    const principal = this.authenticate(token);
    ensure(
      session.account_id === null && (principal.kind === 'guest' || principal.kind === 'invite'),
      'WEB_GUEST_REQUIRED',
    );
    return {
      sessionId: session.id,
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      kind: principal.kind as 'guest' | 'invite',
    };
  }

  /** Called only inside the invite redemption transaction, after its grant and principal CAS. */
  completeInviteRedemption(input: {
    token: string;
    csrf: string;
    origin: string;
    requestId: string;
    codeDigest: string;
    grantId: string;
  }) {
    ensure(
      [112, 113, 114, 115].includes(
        this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
      ) &&
        /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
        /^[a-f0-9]{64}$/.test(input.codeDigest),
      'WEB_INVITE_IDENTITY_SCHEMA_REQUIRED',
    );
    const now = this.now(),
      old = this.activeSession(input.token, now);
    this.writeAuth(old, input.csrf, input.origin);
    ensure(old.account_id === null, 'WEB_GUEST_REQUIRED');
    const grant = this.store.get<{ principal_id: string; expires_at: number | null }>(
      `SELECT principal_id,expires_at FROM web_invite_grants WHERE id=? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>?)`,
      input.grantId,
      now,
    );
    ensure(
      grant?.principal_id === old.principal_id &&
        this.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', old.principal_id)?.kind ===
          'invite',
      'WEB_INVITE_ACCESS_REQUIRED',
    );
    const next = this.newSession(old.principal_id, null, now);
    ensure(
      this.store.run('UPDATE web_sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, old.id).changes ===
        1,
      'SESSION_EXPIRED',
    );
    const receipt = { grantId: input.grantId, principalId: old.principal_id, expiresAt: grant.expires_at };
    const aad = Buffer.from(
      JSON.stringify([
        'invite-redeem-v1',
        this.store.instanceId,
        this.epoch(),
        old.id,
        next.row.id,
        input.grantId,
        input.requestId,
        input.codeDigest,
      ]),
    );
    const nonce = this.random(12);
    const cipher = createCipheriv('aes-256-gcm', this.options.keys.sealKey, nonce, { authTagLength: 16 });
    cipher.setAAD(aad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ token: next.token }), 'utf8'), cipher.final()]);
    this.store.run(
      `INSERT INTO web_invite_identity_receipts(id,old_session_id,new_session_id,grant_id,
      request_id,code_digest,public_receipt,key_id,nonce,ciphertext,auth_tag,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      this.id(),
      old.id,
      next.row.id,
      input.grantId,
      input.requestId,
      input.codeDigest,
      JSON.stringify(receipt),
      this.options.keys.keyId,
      nonce,
      ciphertext,
      cipher.getAuthTag(),
      now,
      now + LIMITS.receiptMs,
    );
    return { receipt, issuedToken: next.token, csrf: this.csrf(next.row, 'active') };
  }

  inviteReceiptChallenge(oldToken: string) {
    const now = this.now(),
      old = this.sessionFor(oldToken);
    ensure(
      old?.revoked_at !== null &&
        old?.revoked_at !== undefined &&
        old.recovery_epoch === this.epoch() &&
        this.store.get(
          `SELECT 1 FROM web_invite_identity_receipts r
        JOIN web_invite_grants g ON g.id=r.grant_id
        JOIN web_sessions s ON s.id=r.new_session_id WHERE r.old_session_id=? AND r.revoked_at IS NULL
        AND r.expires_at>? AND r.successful_retrievals<? AND g.revoked_at IS NULL
        AND (g.expires_at IS NULL OR g.expires_at>?) AND s.revoked_at IS NULL
        AND s.recovery_epoch=? AND s.absolute_expires_at>?`,
          old.id,
          now,
          LIMITS.receiptSuccessfulRetrievals,
          now,
          this.epoch(),
          now,
        ),
      'RECEIPT_UNAVAILABLE',
    );
    return { csrf: this.csrf(old, 'receipt') };
  }

  recoverInviteReceipt(
    oldToken: string,
    csrf: string,
    origin: string,
    input: { requestId: string; codeDigest: string },
  ) {
    ensure(origin === this.options.origin, 'ORIGIN_INVALID');
    ensure(/^[A-Za-z0-9_-]{43}$/.test(csrf), 'CSRF_INVALID');
    ensure(
      /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) && /^[a-f0-9]{64}$/.test(input.codeDigest),
      'RECEIPT_UNAVAILABLE',
    );
    const now = this.now(),
      old = this.sessionFor(oldToken);
    ensure(old && old.revoked_at !== null && old.recovery_epoch === this.epoch(), 'RECEIPT_UNAVAILABLE');
    ensure(fixedTimeEqual(Buffer.from(csrf), Buffer.from(this.csrf(old, 'receipt'))), 'CSRF_INVALID');
    const receipt = this.store.transaction(() => {
      const row = this.store.get<InviteReceiptRow>(
        `SELECT * FROM web_invite_identity_receipts
        WHERE old_session_id=? AND request_id=? AND revoked_at IS NULL AND expires_at>?
          AND successful_retrievals<?`,
        old.id,
        input.requestId,
        now,
        LIMITS.receiptSuccessfulRetrievals,
      );
      ensure(
        row &&
          this.store.get(
            `SELECT 1 FROM web_invite_grants g
        JOIN web_sessions s ON s.id=? WHERE g.id=? AND g.principal_id=s.principal_id
          AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at>?)
          AND s.revoked_at IS NULL AND s.recovery_epoch=? AND s.absolute_expires_at>?`,
            row.new_session_id,
            row.grant_id,
            now,
            this.epoch(),
            now,
          ),
        'RECEIPT_UNAVAILABLE',
      );
      const reserved = this.store.get<{ failed_window_at: number }>(
        `UPDATE web_invite_identity_receipts SET
        failed_attempts=CASE WHEN failed_window_at IS NULL OR ?-failed_window_at>=? THEN 1 ELSE failed_attempts+1 END,
        failed_window_at=CASE WHEN failed_window_at IS NULL OR ?-failed_window_at>=? THEN ? ELSE failed_window_at END
        WHERE id=? AND revoked_at IS NULL AND expires_at>? AND successful_retrievals<?
          AND (failed_window_at IS NULL OR ?-failed_window_at>=? OR failed_attempts<?)
        RETURNING failed_window_at`,
        now,
        LIMITS.receiptFailedWindowMs,
        now,
        LIMITS.receiptFailedWindowMs,
        now,
        row.id,
        now,
        LIMITS.receiptSuccessfulRetrievals,
        now,
        LIMITS.receiptFailedWindowMs,
        LIMITS.receiptFailedAttempts,
      );
      ensure(reserved, 'WEB_IDENTITY_RATE_LIMITED');
      return row;
    });
    if (!fixedTimeEqual(Buffer.from(receipt.code_digest), Buffer.from(input.codeDigest)))
      ensure(false, 'RECEIPT_UNAVAILABLE');
    return this.store.transaction(() => {
      const currentNow = this.now();
      const current = this.store.get<InviteReceiptRow>(
        `SELECT * FROM web_invite_identity_receipts
        WHERE id=? AND revoked_at IS NULL AND expires_at>? AND successful_retrievals<?`,
        receipt.id,
        currentNow,
        LIMITS.receiptSuccessfulRetrievals,
      );
      const target =
        current && this.store.get<SessionRow>('SELECT * FROM web_sessions WHERE id=?', current.new_session_id);
      ensure(
        current &&
          target &&
          target.revoked_at === null &&
          target.recovery_epoch === this.epoch() &&
          target.absolute_expires_at > currentNow &&
          this.store.get(
            `SELECT 1 FROM web_invite_grants WHERE id=? AND principal_id=?
          AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
            current.grant_id,
            target.principal_id,
            currentNow,
          ),
        'RECEIPT_UNAVAILABLE',
      );
      ensure(
        current.key_id === this.options.keys.keyId && current.nonce.length === 12 && current.auth_tag.length === 16,
        'RECEIPT_UNAVAILABLE',
      );
      let token: string;
      try {
        const decipher = createDecipheriv('aes-256-gcm', this.options.keys.sealKey, current.nonce, {
          authTagLength: 16,
        });
        decipher.setAAD(
          Buffer.from(
            JSON.stringify([
              'invite-redeem-v1',
              this.store.instanceId,
              this.epoch(),
              current.old_session_id,
              current.new_session_id,
              current.grant_id,
              current.request_id,
              current.code_digest,
            ]),
          ),
        );
        decipher.setAuthTag(current.auth_tag);
        token = JSON.parse(
          Buffer.concat([decipher.update(current.ciphertext), decipher.final()]).toString('utf8'),
        ).token;
      } catch {
        ensure(false, 'RECEIPT_UNAVAILABLE');
      }
      ensure(
        typeof token === 'string' &&
          this.digest(token) ===
            this.store.get<{ token_digest: string }>('SELECT token_digest FROM web_sessions WHERE id=?', target.id)
              ?.token_digest,
        'RECEIPT_UNAVAILABLE',
      );
      this.store.run(
        `UPDATE web_invite_identity_receipts SET successful_retrievals=successful_retrievals+1,
        failed_attempts=CASE WHEN failed_attempts>0 THEN failed_attempts-1 ELSE 0 END WHERE id=?`,
        current.id,
      );
      return {
        receipt: JSON.parse(current.public_receipt) as {
          grantId: string;
          principalId: string;
          expiresAt: number | null;
        },
        issuedToken: token,
        csrf: this.csrf(target, 'active'),
      };
    });
  }

  inviteReceiptStatus(token: string, csrf: string, origin: string, requestId: string) {
    ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(requestId), 'RECEIPT_UNAVAILABLE');
    const now = this.now(),
      session = this.activeSession(token, now);
    this.writeAuth(session, csrf, origin);
    const receipt = this.store.get<InviteReceiptRow>(
      `SELECT * FROM web_invite_identity_receipts
      WHERE new_session_id=? AND request_id=? AND revoked_at IS NULL`,
      session.id,
      requestId,
    );
    ensure(
      receipt &&
        this.store.get(
          `SELECT 1 FROM web_invite_grants WHERE id=? AND principal_id=?
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
          receipt.grant_id,
          session.principal_id,
          now,
        ),
      'RECEIPT_UNAVAILABLE',
    );
    return JSON.parse(receipt.public_receipt) as { grantId: string; principalId: string; expiresAt: number | null };
  }

  /** Shows a separate high-entropy recovery secret once; the invitation code is never a login proof. */
  createInviteCredential(token: string, csrf: string, origin: string) {
    return this.store.transaction(() => {
      const now = this.now(),
        session = this.activeSession(token, now);
      this.writeAuth(session, csrf, origin);
      ensure(session.account_id === null, 'WEB_GUEST_REQUIRED');
      const grant = this.activeInviteGrant(session.principal_id, now);
      ensure(
        !this.store.get('SELECT 1 FROM web_invite_credentials WHERE grant_id=?', grant.id),
        'WEB_INVITE_CREDENTIAL_EXISTS',
      );
      const secret = this.random(32).toString('base64url');
      this.store.run(
        `INSERT INTO web_invite_credentials(grant_id,secret_digest,created_at)
        VALUES (?,?,?)`,
        grant.id,
        this.inviteSecretDigest(secret),
        now,
      );
      return { grantId: grant.id, secret, expiresAt: grant.expires_at };
    });
  }

  /** Cross-device proof: trusted transport supplies the hashed client IP and enforces HTTPS/no-store. */
  recoverInviteCredential(input: { origin: string; requestId: string; secret: string; ipHash: string }) {
    ensure(input.origin === this.options.origin, 'ORIGIN_INVALID');
    ensure(
      /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) && /^[a-f0-9]{64}$/.test(input.ipHash),
      'WEB_INVITE_RECOVERY_UNAVAILABLE',
    );
    const digest = this.inviteSecretDigest(input.secret),
      now = this.now();
    // A failed proof still spends a shared slot: do not roll this transaction back with the proof check.
    this.store.transaction(() => {
      const attempt = this.store.run(
        `INSERT INTO web_invite_attempt_windows(purpose,ip_hash,window_at,attempts)
        VALUES ('recover',?,?,1) ON CONFLICT(purpose,ip_hash) DO UPDATE SET
        window_at=CASE WHEN ?-window_at>=60000 THEN ? ELSE window_at END,
        attempts=CASE WHEN ?-window_at>=60000 THEN 1 ELSE attempts+1 END
        WHERE ?-window_at>=60000 OR attempts<20`,
        input.ipHash,
        now,
        now,
        now,
        now,
        now,
      );
      ensure(attempt.changes === 1, 'WEB_IDENTITY_RATE_LIMITED');
    });
    return this.store.transaction(() => {
      const currentNow = this.now();
      const replay = this.store.get<InviteCredentialReceiptRow>(
        `SELECT * FROM web_invite_credential_receipts
        WHERE old_secret_digest=? AND request_id=? AND expires_at>? AND successful_retrievals<?`,
        digest,
        input.requestId,
        currentNow,
        LIMITS.receiptSuccessfulRetrievals,
      );
      if (replay) {
        const grant = this.store.get<InviteGrantRow>(
          `SELECT * FROM web_invite_grants
          WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
          replay.grant_id,
          currentNow,
        );
        const target = this.store.get<SessionRow>('SELECT * FROM web_sessions WHERE id=?', replay.new_session_id);
        ensure(
          grant &&
            target &&
            grant.principal_id === target.principal_id &&
            target.revoked_at === null &&
            target.recovery_epoch === this.epoch() &&
            target.absolute_expires_at > currentNow &&
            this.store.get<{ secret_digest: string }>(
              'SELECT secret_digest FROM web_invite_credentials WHERE grant_id=?',
              grant.id,
            )?.secret_digest === replay.new_secret_digest &&
            replay.key_id === this.options.keys.keyId,
          'WEB_INVITE_RECOVERY_UNAVAILABLE',
        );
        let response: { token: string; secret: string };
        try {
          const decipher = createDecipheriv('aes-256-gcm', this.options.keys.sealKey, replay.nonce, {
            authTagLength: 16,
          });
          decipher.setAAD(
            Buffer.from(
              JSON.stringify([
                'invite-credential-v1',
                this.store.instanceId,
                this.epoch(),
                replay.grant_id,
                replay.request_id,
                replay.old_secret_digest,
                replay.new_secret_digest,
                replay.new_session_id,
              ]),
            ),
          );
          decipher.setAuthTag(replay.auth_tag);
          response = JSON.parse(Buffer.concat([decipher.update(replay.ciphertext), decipher.final()]).toString('utf8'));
        } catch {
          ensure(false, 'WEB_INVITE_RECOVERY_UNAVAILABLE');
        }
        ensure(
          this.digest(response.token) ===
            this.store.get<{ token_digest: string }>('SELECT token_digest FROM web_sessions WHERE id=?', target.id)
              ?.token_digest && this.inviteSecretDigest(response.secret) === replay.new_secret_digest,
          'WEB_INVITE_RECOVERY_UNAVAILABLE',
        );
        this.store.run(
          `UPDATE web_invite_credential_receipts SET
          successful_retrievals=successful_retrievals+1 WHERE id=?`,
          replay.id,
        );
        return {
          principalId: grant.principal_id,
          grantId: grant.id,
          expiresAt: grant.expires_at,
          issuedToken: response.token,
          recoverySecret: response.secret,
          csrf: this.csrf(target, 'active'),
          duplicate: true as const,
        };
      }
      const credential = this.store.get<{ grant_id: string; revision: number }>(
        `SELECT grant_id,revision
        FROM web_invite_credentials WHERE secret_digest=? AND revoked_at IS NULL`,
        digest,
      );
      ensure(credential, 'WEB_INVITE_RECOVERY_UNAVAILABLE');
      const grant = this.store.get<InviteGrantRow>(
        `SELECT * FROM web_invite_grants
        WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`,
        credential.grant_id,
        currentNow,
      );
      ensure(
        grant &&
          this.store.get(
            `SELECT 1 FROM web_principals p WHERE p.id=?
        AND p.player_id=? AND p.world_id=? AND p.kind='invite'`,
            grant.principal_id,
            grant.player_id,
            grant.world_id,
          ),
        'WEB_INVITE_RECOVERY_UNAVAILABLE',
      );
      this.store.run(
        'UPDATE web_sessions SET revoked_at=? WHERE principal_id=? AND revoked_at IS NULL',
        currentNow,
        grant.principal_id,
      );
      const next = this.newSession(grant.principal_id, null, currentNow);
      const secret = this.random(32).toString('base64url'),
        nextDigest = this.inviteSecretDigest(secret);
      ensure(
        this.store.run(
          `UPDATE web_invite_credentials SET secret_digest=?,revision=revision+1,
        rotated_at=? WHERE grant_id=? AND secret_digest=? AND revision=? AND revoked_at IS NULL`,
          nextDigest,
          currentNow,
          grant.id,
          digest,
          credential.revision,
        ).changes === 1,
        'WEB_INVITE_RECOVERY_UNAVAILABLE',
      );
      const nonce = this.random(12);
      const cipher = createCipheriv('aes-256-gcm', this.options.keys.sealKey, nonce, { authTagLength: 16 });
      cipher.setAAD(
        Buffer.from(
          JSON.stringify([
            'invite-credential-v1',
            this.store.instanceId,
            this.epoch(),
            grant.id,
            input.requestId,
            digest,
            nextDigest,
            next.row.id,
          ]),
        ),
      );
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ token: next.token, secret }), 'utf8'),
        cipher.final(),
      ]);
      this.store.run(
        `INSERT INTO web_invite_credential_receipts(id,grant_id,request_id,
        old_secret_digest,new_secret_digest,new_session_id,key_id,nonce,ciphertext,auth_tag,
        created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.id(),
        grant.id,
        input.requestId,
        digest,
        nextDigest,
        next.row.id,
        this.options.keys.keyId,
        nonce,
        ciphertext,
        cipher.getAuthTag(),
        currentNow,
        currentNow + LIMITS.receiptMs,
      );
      return {
        principalId: grant.principal_id,
        grantId: grant.id,
        expiresAt: grant.expires_at,
        issuedToken: next.token,
        recoverySecret: secret,
        csrf: this.csrf(next.row, 'active'),
        duplicate: false as const,
      };
    });
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
      const publicReceipt = { accountId, principalId: old.principal_id, duplicate: false };
      const receiptBase = {
        old_session_id: old.id,
        new_session_id: next.row.id,
        action: 'register' as const,
        request_id: input.requestId,
        request_mac: this.requestMac(username, input.password),
        security_revision: 1,
      };
      const nonce = this.random(12);
      const cipher = createCipheriv('aes-256-gcm', this.options.keys.sealKey, nonce, { authTagLength: 16 });
      cipher.setAAD(this.aad(receiptBase));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ token: next.token }), 'utf8'), cipher.final()]);
      const authTag = cipher.getAuthTag();
      this.store.run(
        `INSERT INTO web_identity_receipts(id,old_session_id,new_session_id,account_id,action,
        request_id,request_mac,security_revision,public_receipt,key_id,nonce,ciphertext,auth_tag,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        this.id(),
        old.id,
        next.row.id,
        accountId,
        'register',
        input.requestId,
        receiptBase.request_mac,
        1,
        JSON.stringify(publicReceipt),
        this.options.keys.keyId,
        nonce,
        ciphertext,
        authTag,
        now,
        now + LIMITS.receiptMs,
      );
      return { receipt: publicReceipt, issuedToken: next.token, csrf: this.csrf(next.row, 'active') };
    });
  }

  receiptChallenge(oldToken: string) {
    const now = this.now(),
      old = this.sessionFor(oldToken);
    ensure(
      old?.revoked_at !== null && old?.revoked_at !== undefined && old.recovery_epoch === this.epoch(),
      'RECEIPT_UNAVAILABLE',
    );
    const receipt = this.store.get<ReceiptRow>(
      `SELECT * FROM web_identity_receipts WHERE old_session_id=?
      AND revoked_at IS NULL AND expires_at>? AND successful_retrievals<?`,
      old.id,
      now,
      LIMITS.receiptSuccessfulRetrievals,
    );
    ensure(receipt, 'RECEIPT_UNAVAILABLE');
    return { csrf: this.csrf(old, 'receipt') };
  }

  async recoverReceipt(
    oldToken: string,
    csrf: string,
    origin: string,
    input: { requestId: string; username: string; password: string },
  ) {
    ensure(origin === this.options.origin, 'ORIGIN_INVALID');
    ensure(/^[A-Za-z0-9_-]{43}$/.test(csrf), 'CSRF_INVALID');
    ensure(
      /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
        typeof input.username === 'string' &&
        Buffer.byteLength(input.username, 'utf8') <= 64 &&
        typeof input.password === 'string' &&
        Buffer.byteLength(input.password, 'utf8') <= 1024,
      'RECEIPT_UNAVAILABLE',
    );
    const now = this.now(),
      old = this.sessionFor(oldToken);
    ensure(old && old.revoked_at !== null && old.recovery_epoch === this.epoch(), 'RECEIPT_UNAVAILABLE');
    ensure(fixedTimeEqual(Buffer.from(csrf), Buffer.from(this.csrf(old, 'receipt'))), 'CSRF_INVALID');
    // A failed-attempt slot is reserved before the asynchronous KDF, across all connections.
    // The existing counter means failed proofs plus in-flight verification reservations.
    const { receipt, account, windowAt } = this.store.transaction(() => {
      const row = this.store.get<ReceiptRow>(
        `SELECT * FROM web_identity_receipts WHERE old_session_id=?
        AND action='register' AND request_id=?`,
        old.id,
        input.requestId,
      );
      ensure(
        row &&
          row.expires_at > now &&
          row.revoked_at === null &&
          row.successful_retrievals < LIMITS.receiptSuccessfulRetrievals,
        'RECEIPT_UNAVAILABLE',
      );
      const account = this.store.get<AccountRow>('SELECT * FROM web_accounts WHERE id=?', row.account_id);
      const target = this.store.get<SessionRow>('SELECT * FROM web_sessions WHERE id=?', row.new_session_id);
      ensure(
        account?.active === 1 &&
          account.security_revision === row.security_revision &&
          target?.revoked_at === null &&
          target.recovery_epoch === this.epoch() &&
          now < target.absolute_expires_at &&
          now - target.last_active_at < LIMITS.accountIdleMs,
        'RECEIPT_UNAVAILABLE',
      );
      const reserved = this.store.get<{ failed_window_at: number }>(
        `UPDATE web_identity_receipts SET
        failed_attempts=CASE WHEN failed_window_at IS NULL OR ?-failed_window_at>=? THEN 1 ELSE failed_attempts+1 END,
        failed_window_at=CASE WHEN failed_window_at IS NULL OR ?-failed_window_at>=? THEN ? ELSE failed_window_at END
        WHERE id=? AND revoked_at IS NULL AND expires_at>? AND successful_retrievals<?
          AND (failed_window_at IS NULL OR ?-failed_window_at>=? OR failed_attempts<?)
        RETURNING failed_window_at`,
        now,
        LIMITS.receiptFailedWindowMs,
        now,
        LIMITS.receiptFailedWindowMs,
        now,
        row.id,
        now,
        LIMITS.receiptSuccessfulRetrievals,
        now,
        LIMITS.receiptFailedWindowMs,
        LIMITS.receiptFailedAttempts,
      );
      ensure(reserved, 'WEB_IDENTITY_RATE_LIMITED');
      return { receipt: row, account, windowAt: reserved.failed_window_at };
    });
    const release = () =>
      this.store.run(
        `UPDATE web_identity_receipts SET failed_attempts=failed_attempts-1
      WHERE id=? AND failed_window_at=? AND failed_attempts>0`,
        receipt.id,
        windowAt,
      );
    let supplied: Buffer;
    try {
      supplied = await passwordGate.run(input.password, account.password_salt);
    } catch (error) {
      release();
      throw error;
    }
    if (
      !(
        account.username_norm === input.username.trim().toLowerCase() &&
        fixedTimeEqual(supplied, account.password_tag) &&
        fixedTimeEqual(this.requestMac(account.username_norm, input.password), receipt.request_mac)
      )
    ) {
      // The reservation becomes one failed proof in its original window.
      ensure(false, 'RECEIPT_UNAVAILABLE');
    }
    try {
      return this.store.transaction(() => {
        const currentNow = this.now();
        const current = this.store.get<ReceiptRow>('SELECT * FROM web_identity_receipts WHERE id=?', receipt.id);
        ensure(
          current &&
            current.revoked_at === null &&
            current.expires_at > currentNow &&
            current.successful_retrievals < LIMITS.receiptSuccessfulRetrievals,
          'RECEIPT_UNAVAILABLE',
        );
        const target = this.store.get<SessionRow>('SELECT * FROM web_sessions WHERE id=?', current.new_session_id);
        const accountNow = this.store.get<AccountRow>('SELECT * FROM web_accounts WHERE id=?', current.account_id);
        ensure(
          target &&
            target.revoked_at === null &&
            target.recovery_epoch === this.epoch() &&
            currentNow < target.absolute_expires_at &&
            currentNow - target.last_active_at < LIMITS.accountIdleMs &&
            accountNow?.active === 1 &&
            accountNow.security_revision === current.security_revision,
          'RECEIPT_UNAVAILABLE',
        );
        ensure(
          current.key_id === this.options.keys.keyId && current.nonce.length === 12 && current.auth_tag.length === 16,
          'RECEIPT_UNAVAILABLE',
        );
        let token: string;
        try {
          const decipher = createDecipheriv('aes-256-gcm', this.options.keys.sealKey, current.nonce, {
            authTagLength: 16,
          });
          decipher.setAAD(this.aad(current));
          decipher.setAuthTag(current.auth_tag);
          token = JSON.parse(
            Buffer.concat([decipher.update(current.ciphertext), decipher.final()]).toString('utf8'),
          ).token;
        } catch {
          ensure(false, 'RECEIPT_UNAVAILABLE');
        }
        ensure(
          typeof token === 'string' &&
            this.digest(token) ===
              this.store.get<{ token_digest: string }>('SELECT token_digest FROM web_sessions WHERE id=?', target.id)
                ?.token_digest,
          'RECEIPT_UNAVAILABLE',
        );
        this.store.run(
          'UPDATE web_identity_receipts SET successful_retrievals=successful_retrievals+1 WHERE id=?',
          current.id,
        );
        release();
        return {
          receipt: JSON.parse(current.public_receipt) as { accountId: string; principalId: string; duplicate: false },
          issuedToken: token,
          csrf: this.csrf(target, 'active'),
        };
      });
    } catch (error) {
      release();
      throw error;
    }
  }

  receiptStatus(token: string, csrf: string, origin: string, requestId: string) {
    ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(requestId), 'RECEIPT_UNAVAILABLE');
    const now = this.now(),
      session = this.activeSession(token, now);
    this.writeAuth(session, csrf, origin);
    const receipt = this.store.get<ReceiptRow>(
      'SELECT * FROM web_identity_receipts WHERE new_session_id=? AND request_id=?',
      session.id,
      requestId,
    );
    const account = receipt && this.store.get<AccountRow>('SELECT * FROM web_accounts WHERE id=?', receipt.account_id);
    ensure(
      receipt &&
        receipt.revoked_at === null &&
        account?.active === 1 &&
        account.security_revision === receipt.security_revision &&
        receipt.account_id === session.account_id,
      'RECEIPT_UNAVAILABLE',
    );
    return JSON.parse(receipt.public_receipt) as { accountId: string; principalId: string; duplicate: false };
  }

  logout(token: string, csrf: string, origin: string) {
    return this.store.transaction(() => {
      const now = this.now(),
        session = this.activeSession(token, now);
      this.writeAuth(session, csrf, origin);
      this.store.run('UPDATE web_sessions SET revoked_at=? WHERE id=?', now, session.id);
      this.store.run(
        'UPDATE web_identity_receipts SET revoked_at=? WHERE new_session_id=? AND revoked_at IS NULL',
        now,
        session.id,
      );
      if (
        [112, 113, 114, 115].includes(
          this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
        )
      )
        this.store.run(
          `UPDATE web_invite_identity_receipts SET revoked_at=?
          WHERE new_session_id=? AND revoked_at IS NULL`,
          now,
          session.id,
        );
    });
  }
}
