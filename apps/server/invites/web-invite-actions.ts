import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import type { BatchTierInput, WebInviteTiers } from './web-invite-tiers.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function equalHex(left: string, right: string) {
  return /^[a-f0-9]{64}$/.test(left) && timingSafeEqual(Buffer.from(left), Buffer.from(right));
}

/** Application actions only. The transport owns cookies, no-store and trusted IP derivation. */
export class WebInviteActions {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly origin: string;
  /** Entitlement redemption and the 邀请与额度 admin actions. */
  private readonly tiers: WebInviteTiers;
  constructor(store: Store, clock: Clock, origin: string, tiers: WebInviteTiers) {
    this.tiers = tiers;
    this.store = store;
    this.clock = clock;
    this.origin = origin;
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

  /** True when the database can hold entitlements (migration 125 and email logins). */
  tiersEnabled() {
    return this.tiers.enabled();
  }
  /** Redeem as a signed-in player. A guest is refused (PLAYER_LOGIN_REQUIRED) and the code is not consumed. */
  redeemTier(
    token: string,
    csrf: string,
    origin: string,
    trustedIpHash: string,
    body: { code: string; requestId: string },
  ) {
    this.charge(trustedIpHash);
    return this.tiers.redeem({ token, csrf, origin, ...body });
  }
  createBatch(
    adminCookie: string,
    csrf: string,
    origin: string,
    body: {
      requestId: string;
      name: string;
      count: number;
      tier: BatchTierInput;
      durationDays: number | null;
      redeemBy: number | null;
    },
  ) {
    return this.tiers.createBatch({ ...body, adminSessionId: this.admin(adminCookie, csrf, origin) });
  }
  listBatches(adminCookie: string, csrf: string, origin: string) {
    return this.tiers.listBatches(this.admin(adminCookie, csrf, origin));
  }
  batchDetail(adminCookie: string, csrf: string, origin: string, batchId: string) {
    return this.tiers.batchDetail(this.admin(adminCookie, csrf, origin), batchId);
  }
  /** 导出表格: a CSV (UTF-8 BOM) of the batch under the same masking rule as batchDetail. Audit-logged. */
  exportBatch(adminCookie: string, csrf: string, origin: string, batchId: string) {
    return this.tiers.exportBatch(this.admin(adminCookie, csrf, origin), batchId);
  }
  editBatch(
    adminCookie: string,
    csrf: string,
    origin: string,
    body: { requestId: string; batchId: string; dailyAmount: number; cap: number },
  ) {
    return this.tiers.editBatch({ ...body, adminSessionId: this.admin(adminCookie, csrf, origin) });
  }
  revokeTierCode(adminCookie: string, csrf: string, origin: string, inviteId: string) {
    return this.tiers.revokeCode(this.admin(adminCookie, csrf, origin), inviteId);
  }
  revokeBatch(adminCookie: string, csrf: string, origin: string, batchId: string) {
    return this.tiers.revokeBatch(this.admin(adminCookie, csrf, origin), batchId);
  }
  revokeEntitlement(adminCookie: string, csrf: string, origin: string, inviteId: string) {
    return this.tiers.revokeEntitlement(this.admin(adminCookie, csrf, origin), inviteId);
  }
}
