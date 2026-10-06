import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import type { WebIdentity } from './web-identity.ts';
import type { WebInvites } from './web-invites.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equalHex(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/** Application actions only. The future transport owns cookies, no-store and trusted IP derivation. */
export class WebInviteActions {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly origin: string;
  private readonly invites: WebInvites;
  private readonly identity: WebIdentity;
  constructor(store: Store, clock: Clock, origin: string, invites: WebInvites, identity: WebIdentity) {
    this.store = store;
    this.clock = clock;
    this.origin = origin;
    this.invites = invites;
    this.identity = identity;
  }

  private admin(cookie: string, csrf: string, origin: string) {
    ensure(origin === this.origin && /^[A-Za-z0-9_-]{43}$/.test(cookie), 'ADMIN_UNAUTHORIZED');
    const row = this.store.get<{ id: string }>(
      `SELECT id FROM admin_sessions WHERE secret_hash=?
      AND revoked_at IS NULL AND expires_at>?`,
      hash(cookie),
      this.clock.now(),
    );
    ensure(row, 'ADMIN_UNAUTHORIZED');
    const expected = hash(`bubble-admin-csrf:${cookie}`);
    ensure(typeof csrf === 'string' && equalHex(csrf, expected), 'ADMIN_CSRF_REQUIRED');
    return row.id;
  }

  private charge(ipHash: string) {
    ensure(/^[a-f0-9]{64}$/.test(ipHash), 'WEB_TRUSTED_IP_REQUIRED');
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    this.store.transaction(() => {
      const updated = this.store.run(
        `INSERT INTO web_invite_attempt_windows
        (purpose,ip_hash,window_at,attempts) VALUES ('redeem',?,?,1)
        ON CONFLICT(purpose,ip_hash) DO UPDATE SET
          window_at=CASE WHEN ?-window_at>=60000 THEN ? ELSE window_at END,
          attempts=CASE WHEN ?-window_at>=60000 THEN 1 ELSE attempts+1 END
        WHERE ?-window_at>=60000 OR attempts<20`,
        ipHash,
        now,
        now,
        now,
        now,
        now,
      );
      ensure(updated.changes === 1, 'WEB_INVITE_RATE_LIMITED');
    });
  }

  issue(
    adminCookie: string,
    csrf: string,
    origin: string,
    body: { requestId: string; redeemBy: number | null; accessDurationMs: null; batch: string; note: string | null },
  ) {
    // Current invite experience has no business access deadline; redemption cutoff remains explicit.
    ensure(body.accessDurationMs === null, 'WEB_INVITE_TERMS_REQUIRED');
    return this.invites.issue({ ...body, adminSessionId: this.admin(adminCookie, csrf, origin) });
  }
  revokeCode(adminCookie: string, csrf: string, origin: string, inviteId: string) {
    return this.invites.revokeCode(this.admin(adminCookie, csrf, origin), inviteId);
  }
  revokeGrant(adminCookie: string, csrf: string, origin: string, grantId: string) {
    return this.invites.revokeGrant(this.admin(adminCookie, csrf, origin), grantId);
  }
  redeem(
    token: string,
    csrf: string,
    origin: string,
    trustedIpHash: string,
    body: { code: string; requestId: string },
  ) {
    this.charge(trustedIpHash);
    return this.invites.redeem({ token, csrf, origin, ...body });
  }
  redemptionChallenge(oldToken: string, origin: string) {
    ensure(origin === this.origin, 'ORIGIN_INVALID');
    return this.invites.inviteReceiptChallenge(oldToken);
  }
  recoverRedemption(oldToken: string, csrf: string, origin: string, body: { code: string; requestId: string }) {
    return this.invites.recoverRedemption({ oldToken, csrf, origin, ...body });
  }
  redemptionStatus(token: string, csrf: string, origin: string, requestId: string) {
    return this.invites.inviteReceiptStatus(token, csrf, origin, requestId);
  }
  createRecoveryCredential(token: string, csrf: string, origin: string) {
    return this.identity.createInviteCredential(token, csrf, origin);
  }
  recoverInvite(origin: string, trustedIpHash: string, body: { secret: string; requestId: string }) {
    return this.identity.recoverInviteCredential({ origin, ipHash: trustedIpHash, ...body });
  }
}
