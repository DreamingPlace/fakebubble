import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { InviteAdminPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { requireWebAdminMembership } from '../admin/web-admin-schema.ts';
import { activeEntitlement, entitlementTablesExist } from '../admission/web-entitlements.ts';
import { applyDailyRefill, offeredModels } from '../admission/web-points.ts';
import type { ModelFlags } from '../admission/web-model-settings.ts';
import { ensurePlayerNumber } from '../admission/web-player-number.ts';
import { inviteCodesCsv, MASKED_CODE } from './web-invite-export.ts';

/**
 * Invite tiers (Part 22a): batches of codes that each grant an ENTITLEMENT, redeemed by a signed-in player, and the owner's
 * pages that create, list, edit and revoke them. Redeeming adds a row to web_entitlements; it never touches
 * web_principals.kind or web_guest_retention. Redemption reads only the code's digest (an HMAC). Since migration 127 (Part 22a2)
 * a new code is also stored SEALED (AES-256-GCM under a key derived from SEAL_KEY), so it can be shown again: to the owner (every
 * code) and to the administrator who created the batch (that batch's codes); any other administrator who may open the page gets
 * ******** and the batch's counts. A code made before 127 has only its digest and is never shown again. The server decides who
 * sees what; the browser never receives a plain code it may not show. Every admin action is audit-logged (web_admin_audit: actor
 * member, action, batch or code id and a row count - never a player id, email, nickname or a code).
 */
type InviteScope = {
  sessionId: string;
  principalId: string;
  playerId: string;
  worldId: string;
  kind: 'guest';
};
export type InviteAuthorizer = (token: string, csrf: string, origin: string) => InviteScope;

export const BATCH_LIMITS = Object.freeze({
  maxCodes: 500,
  amountMin: 1,
  amountMax: 100_000,
  capMax: 10_000_000,
  durationMaxDays: 3650,
  defaultAmount: 50,
  defaultCap: 1000,
  /** Batches the list shows, newest first. */
  listed: 50,
});
const DAY_MS = 86_400_000;

export type BatchTierInput = { kind: 'unlimited' } | { kind: 'daily_refill'; dailyAmount: number; cap: number };
export type BatchInput = {
  adminSessionId: string;
  requestId: string;
  name: string;
  count: number;
  tier: BatchTierInput;
  durationDays: number | null;
  redeemBy: number | null;
  /** Part 22d: a test batch (测试组). Set here, at creation, and never changed. Absent = not a test batch. */
  test?: boolean;
};
export type BatchView = {
  id: string;
  name: string;
  tier: 'unlimited' | 'daily_refill';
  dailyAmount: number | null;
  cap: number | null;
  durationDays: number | null;
  redeemBy: number | null;
  /** Part 22d: present (true) only on a test batch (测试组); absent otherwise. */
  test?: true;
  createdAt: number;
  codes: number;
  redeemed: number;
  revoked: number;
  holders: number;
};
export type BatchCodeView = {
  id: string;
  serial: number;
  state: 'unused' | 'redeemed' | 'revoked' | 'ended' | 'expired';
  redeemedAt: number | null;
  expiresAt: number | null;
  playerNumber: string | null;
  /** The plain code ('plain'), the mask ('masked': this viewer may not see it) or null ('legacy': only a digest exists). */
  code: string | null;
  codeView: 'plain' | 'masked' | 'legacy';
};
/** HKDF info for the key that seals invite codes. */
export const INVITE_CODE_SEAL_LABEL = 'invite-code-v1';
/** The sealing key: HKDF-SHA256 over the business worker's SEAL_KEY, info 'invite-code-v1'. */
export const inviteCodeSealKey = (sealKey: Buffer) =>
  Buffer.from(hkdfSync('sha256', sealKey, Buffer.alloc(0), INVITE_CODE_SEAL_LABEL, 32));
export type RedeemedEntitlement = {
  kind: 'unlimited' | 'daily_refill';
  dailyAmount: number | null;
  cap: number | null;
  expiresAt: number | null;
};

const isInt = (value: unknown, min: number, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;

export class WebInviteTiers {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly codeKey: Buffer;
  /** The derived AES key; null = new codes are stored as digests only (no SEAL_KEY given). */
  private readonly sealKey: Buffer | null;
  private readonly authorize: InviteAuthorizer;
  private readonly nextId: () => string;
  private readonly random: (size: number) => Buffer;

  constructor(
    store: Store,
    options: {
      clock: Clock;
      codeKey: Buffer;
      /** The business worker's SEAL_KEY (raw 32 bytes); the sealing key is derived from it. */
      sealKey?: Buffer;
      authorize: InviteAuthorizer;
      nextId?: () => string;
      random?: (size: number) => Buffer;
    },
  ) {
    ensure(options.codeKey.length === 32, 'WEB_INVITE_KEY_REQUIRED');
    ensure(options.sealKey === undefined || options.sealKey.length === 32, 'WEB_INVITE_KEY_REQUIRED');
    this.sealKey = options.sealKey ? inviteCodeSealKey(options.sealKey) : null;
    this.store = store;
    this.clock = options.clock;
    this.codeKey = options.codeKey;
    this.authorize = options.authorize;
    this.nextId = options.nextId ?? randomUUID;
    this.random = options.random ?? randomBytes;
  }

  /**
   * On a database with migration 125 a code ALWAYS becomes an entitlement (the old invite principal exists only below 125),
   * whatever SIGNUP_BONUS_ENABLED / PLAYER_MODEL_CHOICE_ENABLED say. Only daily_refill needs points: see `pointsOn`.
   */
  enabled() {
    return (
      entitlementTablesExist(this.store) &&
      !!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_logins'")
    );
  }
  /** Points exist (PLAYER_MODEL_CHOICE_ENABLED, with its tables). A daily_refill batch can be made or redeemed only then. */
  pointsOn() {
    return offeredModels(this.store as unknown as ModelFlags & Store) !== null;
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private digest(label: string, value: string) {
    return createHmac('sha256', this.codeKey).update(label).update('\0').update(value).digest('hex');
  }
  /** Migration 127's columns exist (an older database keeps the digest-only behaviour). */
  private sealedColumns() {
    return (
      this.store.all<{ name: string }>('PRAGMA table_info(web_invite_codes)').some((c) => c.name === 'code_sealed') &&
      this.store
        .all<{ name: string }>('PRAGMA table_info(web_invite_batches)')
        .some((c) => c.name === 'created_by_member')
    );
  }
  /** Migration 130's column exists (an older database has no test batches). */
  private testColumn() {
    return this.store.all<{ name: string }>('PRAGMA table_info(web_invite_batches)').some((c) => c.name === 'test');
  }
  /** nonce(12) || ciphertext || tag(16); the row's id is authenticated so a sealed code cannot be moved to another row. */
  private seal(inviteId: string, code: string) {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.sealKey!, nonce);
    cipher.setAAD(Buffer.from(`${INVITE_CODE_SEAL_LABEL}\0${inviteId}`));
    const body = Buffer.concat([cipher.update(code, 'utf8'), cipher.final()]);
    return Buffer.concat([nonce, body, cipher.getAuthTag()]);
  }
  /** The plain code, or null when it cannot be opened (a different key, or the row was altered). */
  private unseal(inviteId: string, sealed: Uint8Array): string | null {
    if (!this.sealKey || sealed.length < 12 + 16) return null;
    try {
      const raw = Buffer.from(sealed);
      const decipher = createDecipheriv('aes-256-gcm', this.sealKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${INVITE_CODE_SEAL_LABEL}\0${inviteId}`));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      const code = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString(
        'utf8',
      );
      return /^[A-Za-z0-9_-]{43}$/.test(code) ? code : null;
    } catch {
      return null;
    }
  }
  /** The administrator member behind a login session, and the role: who may see a batch's plain codes follows the person. */
  private memberOf(sessionId: string) {
    if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_admin_session_members'"))
      return undefined;
    return this.store.get<{ member_id: string; role: string }>(
      `SELECT s.member_id,m.role FROM web_admin_session_members s JOIN web_admin_members m ON m.id=s.member_id WHERE s.session_id=?`,
      sessionId,
    );
  }
  private requestId(value: unknown) {
    ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value), 'INVALID_REQUEST_ID');
  }
  private requireAdmin(sessionId: string, now: number, permission: InviteAdminPermission) {
    ensure(
      typeof sessionId === 'string' &&
        this.store.get(
          `SELECT 1 FROM admin_sessions WHERE id=? AND revoked_at IS NULL AND expires_at>?`,
          sessionId,
          now,
        ),
      'ADMIN_UNAUTHORIZED',
    );
    requireWebAdminMembership(this.store, sessionId, permission);
  }
  /** Editing a batch's N and cap is the owner's alone (not a permission an administrator can be given). */
  private requireOwner(sessionId: string) {
    const member = this.store.get<{ role: string }>(
      `SELECT m.role FROM web_admin_session_members s JOIN web_admin_members m ON m.id=s.member_id WHERE s.session_id=?`,
      sessionId,
    );
    ensure(member?.role === 'owner', 'ADMIN_OWNER_REQUIRED');
  }
  private audit(sessionId: string, action: string, target: string, now: number) {
    if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_admin_audit'")) return;
    const actor =
      this.store.get<{ member_id: string }>(
        'SELECT member_id FROM web_admin_session_members WHERE session_id=?',
        sessionId,
      )?.member_id ?? null;
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor,
      action,
      target,
      now,
    );
  }

  // ---- the player: redeem ------------------------------------------------------------------------------------------------

  /**
   * Redeem a code as a SIGNED-IN player. A guest (no email login) is refused with PLAYER_LOGIN_REQUIRED before anything is
   * read from the code, so the code is not consumed. The grant is an entitlement; the principal and its retention row are not
   * touched, the session is not rotated and no recovery credential is made.
   */
  redeem(input: { token: string; csrf: string; origin: string; code: string; requestId: string }) {
    this.requestId(input.requestId);
    ensure(typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code), 'WEB_INVITE_UNAVAILABLE');
    const codeDigest = this.digest('code-v1', input.code);
    return this.store.transaction(() => {
      const actor = this.authorize(input.token, input.csrf, input.origin),
        now = this.now();
      ensure(actor.kind === 'guest', 'WEB_GUEST_REQUIRED');
      const session = this.store.get<{
        principal_id: string;
        account_id: string | null;
        recovery_epoch: string;
        absolute_expires_at: number;
        revoked_at: number | null;
      }>('SELECT * FROM web_sessions WHERE id=?', actor.sessionId);
      const epoch = this.store.get<{ recovery_epoch: string }>(
        'SELECT recovery_epoch FROM web_instance WHERE singleton=1',
      )?.recovery_epoch;
      ensure(
        session &&
          session.principal_id === actor.principalId &&
          session.revoked_at === null &&
          session.absolute_expires_at > now &&
          session.recovery_epoch === epoch,
        'SESSION_EXPIRED',
      );
      const principal = this.store.get<{ kind: string; player_id: string; world_id: string }>(
        'SELECT kind,player_id,world_id FROM web_principals WHERE id=?',
        actor.principalId,
      );
      ensure(
        principal &&
          principal.kind === actor.kind &&
          principal.player_id === actor.playerId &&
          principal.world_id === actor.worldId,
        'WEB_INVITE_SCOPE_INVALID',
      );
      // The refusal comes first: nothing about the code is looked at, let alone consumed, for a guest.
      ensure(
        this.store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', actor.principalId),
        'PLAYER_LOGIN_REQUIRED',
      );
      const retention = this.store.get<{ state: string }>(
        'SELECT state FROM web_guest_retention WHERE principal_id=? AND world_id=?',
        actor.principalId,
        actor.worldId,
      );
      ensure(retention && ['unstarted', 'active'].includes(retention.state), 'TRIAL_EXPIRED');

      const prior = this.store.get<{ code_digest: string; entitlement_id: string }>(
        'SELECT code_digest,entitlement_id FROM web_entitlement_redemptions WHERE principal_id=? AND request_id=?',
        actor.principalId,
        input.requestId,
      );
      if (prior) {
        ensure(prior.code_digest === codeDigest, 'IDEMPOTENCY_CONFLICT');
        const held = this.store.get<{
          kind: 'unlimited' | 'daily_refill';
          expires_at: number | null;
          batch_id: string | null;
        }>('SELECT kind,expires_at,batch_id FROM web_entitlements WHERE id=?', prior.entitlement_id);
        ensure(held, 'WEB_INVITE_SCOPE_INVALID');
        return { entitlement: this.view(held.kind, held.batch_id, held.expires_at), duplicate: true as const };
      }

      const invite = this.store.get<{
        id: string;
        status: string;
        redeemed_count: number;
        redeem_by: number | null;
        access_duration_ms: number | null;
        batch_id: string | null;
      }>(
        'SELECT id,status,redeemed_count,redeem_by,access_duration_ms,batch_id FROM web_invite_codes WHERE code_digest=?',
        codeDigest,
      );
      ensure(
        invite &&
          invite.status === 'active' &&
          invite.redeemed_count === 0 &&
          (invite.redeem_by === null || now < invite.redeem_by),
        'WEB_INVITE_UNAVAILABLE',
      );
      const batch = invite.batch_id
        ? this.store.get<{ id: string; tier: 'unlimited' | 'daily_refill'; duration_days: number | null }>(
            'SELECT id,tier,duration_days FROM web_invite_batches WHERE id=?',
            invite.batch_id,
          )
        : undefined;
      // A code from before this Part has no batch of its own: it grants unlimited access for its old duration.
      const kind = batch?.tier ?? 'unlimited';
      // A refill needs points: with them off the code stays UNUSED (refused before anything is written).
      ensure(kind !== 'daily_refill' || this.pointsOn(), 'WEB_INVITE_UNUSABLE');
      const durationMs = batch?.duration_days != null ? batch.duration_days * DAY_MS : invite.access_duration_ms;
      const expiresAt = durationMs === null ? null : now + durationMs;
      ensure(expiresAt === null || Number.isSafeInteger(expiresAt), 'INVALID_TIME');
      ensure(
        this.store.run(
          `UPDATE web_invite_codes SET redeemed_count=1
          WHERE id=? AND status='active' AND redeemed_count=0 AND (redeem_by IS NULL OR redeem_by>?)`,
          invite.id,
          now,
        ).changes === 1,
        'WEB_INVITE_UNAVAILABLE',
      );
      const entitlementId = this.nextId();
      this.store.run(
        `INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,expires_at,created_at)
        VALUES (?,?,'invite',?,?,?,?,?,?)`,
        entitlementId,
        actor.principalId,
        invite.id,
        batch?.id ?? null,
        kind,
        now,
        expiresAt,
        now,
      );
      this.store.run(
        'INSERT INTO web_entitlement_redemptions(principal_id,request_id,code_digest,entitlement_id,redeemed_at) VALUES (?,?,?,?,?)',
        actor.principalId,
        input.requestId,
        codeDigest,
        entitlementId,
        now,
      );
      ensurePlayerNumber(this.store, now, actor.principalId);
      // The redemption is a visit: a daily_refill player gets today's +N now (once per UTC day, up to the cap).
      applyDailyRefill(this.store as unknown as Store & ModelFlags, now, actor.principalId);
      return { entitlement: this.view(kind, batch?.id ?? null, expiresAt), duplicate: false as const };
    });
  }

  private view(
    kind: 'unlimited' | 'daily_refill',
    batchId: string | null,
    expiresAt: number | null,
  ): RedeemedEntitlement {
    const batch = batchId
      ? this.store.get<{ daily_amount: number | null; total_cap: number | null }>(
          'SELECT daily_amount,total_cap FROM web_invite_batches WHERE id=?',
          batchId,
        )
      : undefined;
    return {
      kind,
      dailyAmount: kind === 'daily_refill' ? (batch?.daily_amount ?? null) : null,
      cap: kind === 'daily_refill' ? (batch?.total_cap ?? null) : null,
      expiresAt,
    };
  }

  // ---- the administrator: 邀请与额度 -------------------------------------------------------------------------------------

  /** Create a batch and its codes. The codes are returned ONCE (a replay of the same requestId returns `codes: null`). */
  createBatch(input: BatchInput) {
    this.requestId(input.requestId);
    ensure(
      typeof input.name === 'string' &&
        input.name.trim().length >= 1 &&
        input.name.length <= 128 &&
        !/[\p{Cc}]/u.test(input.name) &&
        isInt(input.count, 1, BATCH_LIMITS.maxCodes) &&
        (input.durationDays === null || isInt(input.durationDays, 1, BATCH_LIMITS.durationMaxDays)) &&
        (input.redeemBy === null || (Number.isSafeInteger(input.redeemBy) && input.redeemBy >= 0)) &&
        (input.test === undefined || typeof input.test === 'boolean') &&
        (input.tier.kind === 'unlimited' ||
          (input.tier.kind === 'daily_refill' &&
            isInt(input.tier.dailyAmount, BATCH_LIMITS.amountMin, BATCH_LIMITS.amountMax) &&
            isInt(input.tier.cap, BATCH_LIMITS.amountMin, BATCH_LIMITS.capMax) &&
            input.tier.cap >= input.tier.dailyAmount)),
      'WEB_INVITE_TERMS_REQUIRED',
    );
    const refill = input.tier.kind === 'daily_refill' ? input.tier : null;
    const requestDigest = this.digest(
      'batch-v1',
      JSON.stringify([
        input.name,
        input.count,
        input.tier.kind,
        refill?.dailyAmount ?? null,
        refill?.cap ?? null,
        input.durationDays,
        input.redeemBy,
        // A batch that is not a test batch digests exactly as before 22d, so an old request replays unchanged.
        ...(input.test === true ? ['test'] : []),
      ]),
    );
    return this.store.transaction(() => {
      const now = this.now();
      this.requireAdmin(input.adminSessionId, now, 'invites.manage');
      const prior = this.store.get<{ id: string; request_digest: string; created_by: string }>(
        'SELECT id,request_digest,created_by FROM web_invite_batches WHERE request_id=?',
        input.requestId,
      );
      if (prior) {
        ensure(
          prior.created_by === input.adminSessionId && prior.request_digest === requestDigest,
          'IDEMPOTENCY_CONFLICT',
        );
        return { batchId: prior.id, codes: null as string[] | null, duplicate: true as const };
      }
      ensure(input.redeemBy === null || input.redeemBy > now, 'WEB_INVITE_TERMS_REQUIRED');
      // 需要先开启模型选择/积分: a refill batch means nothing while points are off.
      ensure(input.tier.kind !== 'daily_refill' || this.pointsOn(), 'WEB_INVITE_POINTS_REQUIRED');
      const batchId = this.nextId();
      ensure(input.test !== true || this.testColumn(), 'WEB_INVITE_TERMS_REQUIRED');
      const columns = this.sealedColumns();
      const creator = columns ? (this.memberOf(input.adminSessionId)?.member_id ?? null) : null;
      this.store.run(
        `INSERT INTO web_invite_batches(id,name,tier,daily_amount,total_cap,duration_days,request_id,request_digest,created_by,created_at${columns ? ',created_by_member' : ''}${this.testColumn() ? ',test' : ''})
        VALUES (?,?,?,?,?,?,?,?,?,?${columns ? ',?' : ''}${this.testColumn() ? ',?' : ''})`,
        batchId,
        input.name.trim(),
        input.tier.kind,
        refill?.dailyAmount ?? null,
        refill?.cap ?? null,
        input.durationDays,
        input.requestId,
        requestDigest,
        input.adminSessionId,
        now,
        ...(columns ? [creator] : []),
        ...(this.testColumn() ? [input.test === true ? 1 : 0] : []),
      );
      const codes: string[] = [];
      for (let i = 0; i < input.count; i++) {
        const bytes = this.random(32);
        ensure(Buffer.isBuffer(bytes) && bytes.length === 32, 'WEB_RANDOM_INVALID');
        const code = bytes.toString('base64url');
        codes.push(code);
        const inviteId = this.nextId();
        const sealed = columns && this.sealKey ? this.seal(inviteId, code) : null;
        this.store.run(
          `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,redeem_by,
          access_duration_ms,status,batch,note,created_by,created_at,batch_id${columns ? ',code_sealed' : ''})
          VALUES (?,?,?,?,1,0,?,?,'active',?,NULL,?,?,?${columns ? ',?' : ''})`,
          inviteId,
          this.digest('code-v1', code),
          `${batchId}.${i}`,
          requestDigest,
          input.redeemBy,
          input.durationDays === null ? null : input.durationDays * DAY_MS,
          input.name.trim(),
          input.adminSessionId,
          now,
          batchId,
          ...(columns ? [sealed] : []),
        );
      }
      this.audit(input.adminSessionId, 'invite-batch-created', batchId, now);
      return { batchId, codes: codes as string[] | null, duplicate: false as const };
    });
  }

  /** The batches, newest first: tier, N / cap, created, codes, redeemed, revoked, and how many players hold it now. Counts only. */
  listBatches(adminSessionId: string): { batches: BatchView[] } {
    const now = this.now();
    this.requireAdmin(adminSessionId, now, 'invites.manage');
    const rows = this.store.all<{
      id: string;
      name: string;
      tier: 'unlimited' | 'daily_refill';
      daily_amount: number | null;
      total_cap: number | null;
      duration_days: number | null;
      redeem_by: number | null;
      created_at: number;
      codes: number;
      redeemed: number;
      revoked: number;
      holders: number;
      test: number;
    }>(
      `SELECT b.id,b.name,b.tier,b.daily_amount,b.total_cap,b.duration_days,b.created_at,${this.testColumn() ? 'b.test' : '0'} test,
        (SELECT max(c.redeem_by) FROM web_invite_codes c WHERE c.batch_id=b.id) redeem_by,
        (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id) codes,
        (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id AND c.redeemed_count=1) redeemed,
        (SELECT count(*) FROM web_invite_codes c WHERE c.batch_id=b.id AND (c.status='revoked' OR EXISTS
          (SELECT 1 FROM web_entitlements e WHERE e.invite_id=c.id AND e.revoked_at IS NOT NULL))) revoked,
        (SELECT count(*) FROM web_entitlements e WHERE e.batch_id=b.id AND e.revoked_at IS NULL AND e.starts_at<=?
          AND (e.expires_at IS NULL OR e.expires_at>?)) holders
      FROM web_invite_batches b ORDER BY b.created_at DESC,b.id DESC LIMIT ?`,
      now,
      now,
      BATCH_LIMITS.listed,
    );
    return {
      batches: rows.map((row) => ({
        id: row.id,
        name: row.name,
        tier: row.tier,
        dailyAmount: row.daily_amount,
        cap: row.total_cap,
        durationDays: row.duration_days,
        redeemBy: row.redeem_by,
        ...(row.test === 1 ? { test: true as const } : {}),
        createdAt: row.created_at,
        codes: row.codes,
        redeemed: row.redeemed,
        revoked: row.revoked,
        holders: row.holders,
      })),
    };
  }

  /**
   * One batch's codes by serial number: state, when redeemed, when it ends, the holder's 玩家编号 (never an id or an email) and the
   * code itself under the viewing rule - the owner sees every plain code, the administrator who CREATED the batch sees its plain
   * codes, any other administrator with invites.manage gets ******** ('masked'), and a code made before migration 127 is 'legacy'
   * (only a digest exists). 序号 follows the order the codes were made (rowid), not their random ids. The masking is done here: a caller who may not see a code never receives it. Handing out plain codes
   * is audit-logged (administrator, batch, number of rows; never the codes).
   */
  batchDetail(adminSessionId: string, batchId: string): { codes: BatchCodeView[]; canViewCodes: boolean } {
    const now = this.now();
    this.requireAdmin(adminSessionId, now, 'invites.manage');
    const { codes, canViewCodes } = this.codeRows(adminSessionId, batchId, now);
    if (codes.some((row) => row.codeView === 'plain'))
      this.audit(adminSessionId, `invite-codes-viewed:${codes.length}`, batchId, now);
    return { codes, canViewCodes };
  }

  /**
   * 导出表格: the same rows under the same masking rule as batchDetail, as a CSV with a UTF-8 BOM. Always audit-logged
   * (administrator, batch, number of rows) - also when every code is masked; the codes themselves are never logged.
   */
  exportBatch(adminSessionId: string, batchId: string): { csv: string; rows: number } {
    const now = this.now();
    this.requireAdmin(adminSessionId, now, 'invites.manage');
    const { codes } = this.codeRows(adminSessionId, batchId, now);
    this.audit(adminSessionId, `invite-batch-exported:${codes.length}`, batchId, now);
    return { csv: inviteCodesCsv(codes), rows: codes.length };
  }

  private codeRows(adminSessionId: string, batchId: string, now: number) {
    const batch =
      typeof batchId === 'string'
        ? this.store.get<{ created_by: string | null }>('SELECT created_by FROM web_invite_batches WHERE id=?', batchId)
        : undefined;
    ensure(batch, 'NOT_FOUND');
    const columns = this.sealedColumns();
    // Who made the batch is a PERSON (a login session ends after 8 hours): created_by_member, else the member behind the
    // session that created it. The viewer is the person behind this session.
    const viewer = this.memberOf(adminSessionId);
    const creator = columns
      ? (this.store.get<{ created_by_member: string | null }>(
          'SELECT created_by_member FROM web_invite_batches WHERE id=?',
          batchId,
        )?.created_by_member ?? (batch.created_by ? (this.memberOf(batch.created_by)?.member_id ?? null) : null))
      : null;
    const canViewCodes =
      viewer !== undefined && (viewer.role === 'owner' || (creator !== null && viewer.member_id === creator));
    const rows = this.store.all<{
      id: string;
      status: string;
      redeemed_count: number;
      redeemed_at: number | null;
      expires_at: number | null;
      revoked_at: number | null;
      number: string | null;
      sealed: Uint8Array | null;
    }>(
      `SELECT c.id,c.status,c.redeemed_count,e.starts_at redeemed_at,e.expires_at,e.revoked_at,n.number,
        ${columns ? 'c.code_sealed' : 'NULL'} sealed
      FROM web_invite_codes c LEFT JOIN web_entitlements e ON e.invite_id=c.id
        LEFT JOIN web_player_numbers n ON n.principal_id=e.principal_id
      WHERE c.batch_id=? ORDER BY c.created_at,c.rowid`,
      batchId,
    );
    const codes = rows.map((row, i): BatchCodeView => {
      const state: BatchCodeView['state'] =
        row.redeemed_count === 1
          ? row.revoked_at !== null
            ? 'ended'
            : row.expires_at !== null && row.expires_at <= now
              ? 'expired'
              : 'redeemed'
          : row.status === 'revoked'
            ? 'revoked'
            : 'unused';
      // A code with nothing sealed (made before 127) is 'legacy' for everyone, the owner included.
      const plain = row.sealed && canViewCodes ? this.unseal(row.id, row.sealed) : null;
      const codeView: BatchCodeView['codeView'] = !row.sealed
        ? 'legacy'
        : !canViewCodes
          ? 'masked'
          : plain === null
            ? 'legacy'
            : 'plain';
      return {
        id: row.id,
        serial: i + 1,
        state,
        redeemedAt: row.redeemed_at,
        expiresAt: row.expires_at,
        playerNumber: row.number,
        code: codeView === 'plain' ? plain : codeView === 'masked' ? MASKED_CODE : null,
        codeView,
      };
    });
    return { codes, canViewCodes };
  }

  /**
   * OWNER ONLY. Change a batch's daily amount N and cap. Applies to every holder from their next daily refill; lowering the cap
   * never removes points already held (those players just get no refill until they are below it). Idempotent per requestId,
   * audit-logged, and the change is kept in web_invite_batch_changes with how many players hold the batch.
   */
  editBatch(input: { adminSessionId: string; requestId: string; batchId: string; dailyAmount: number; cap: number }) {
    this.requestId(input.requestId);
    ensure(
      isInt(input.dailyAmount, BATCH_LIMITS.amountMin, BATCH_LIMITS.amountMax) &&
        isInt(input.cap, BATCH_LIMITS.amountMin, BATCH_LIMITS.capMax) &&
        input.cap >= input.dailyAmount &&
        typeof input.batchId === 'string',
      'WEB_INVITE_TERMS_REQUIRED',
    );
    return this.store.transaction(() => {
      const now = this.now();
      this.requireAdmin(input.adminSessionId, now, 'invites.manage');
      this.requireOwner(input.adminSessionId);
      const prior = this.store.get<{ batch_id: string; new_amount: number; new_cap: number }>(
        'SELECT batch_id,new_amount,new_cap FROM web_invite_batch_changes WHERE request_id=?',
        input.requestId,
      );
      if (prior) {
        ensure(
          prior.batch_id === input.batchId && prior.new_amount === input.dailyAmount && prior.new_cap === input.cap,
          'IDEMPOTENCY_CONFLICT',
        );
        return { batchId: prior.batch_id, duplicate: true as const };
      }
      const batch = this.store.get<{ tier: string; daily_amount: number | null; total_cap: number | null }>(
        'SELECT tier,daily_amount,total_cap FROM web_invite_batches WHERE id=?',
        input.batchId,
      );
      ensure(
        batch && batch.tier === 'daily_refill' && batch.daily_amount !== null && batch.total_cap !== null,
        'NOT_FOUND',
      );
      ensure(batch.daily_amount !== input.dailyAmount || batch.total_cap !== input.cap, 'WEB_INVITE_TERMS_REQUIRED');
      const holders = this.store.get<{ n: number }>(
        `SELECT count(*) n FROM web_entitlements WHERE batch_id=? AND revoked_at IS NULL AND starts_at<=?
          AND (expires_at IS NULL OR expires_at>?)`,
        input.batchId,
        now,
        now,
      )!.n;
      this.store.run(
        'UPDATE web_invite_batches SET daily_amount=?,total_cap=? WHERE id=?',
        input.dailyAmount,
        input.cap,
        input.batchId,
      );
      this.store.run(
        `INSERT INTO web_invite_batch_changes(batch_id,admin_id,request_id,old_amount,new_amount,old_cap,new_cap,holders,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
        input.batchId,
        this.store.get<{ member_id: string }>(
          'SELECT member_id FROM web_admin_session_members WHERE session_id=?',
          input.adminSessionId,
        )?.member_id ?? input.adminSessionId,
        input.requestId,
        batch.daily_amount,
        input.dailyAmount,
        batch.total_cap,
        input.cap,
        holders,
        now,
      );
      this.audit(
        input.adminSessionId,
        `invite-batch-edited:${batch.daily_amount}/${batch.total_cap}>${input.dailyAmount}/${input.cap}`,
        input.batchId,
        now,
      );
      return { batchId: input.batchId, holders, duplicate: false as const };
    });
  }

  /** Revoke ONE unredeemed code (its holder, if any, is a different decision: revokeEntitlement). */
  revokeCode(adminSessionId: string, inviteId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      this.requireAdmin(adminSessionId, now, 'invites.manage');
      const row = this.store.get<{ status: string; redeemed_count: number }>(
        'SELECT status,redeemed_count FROM web_invite_codes WHERE id=?',
        typeof inviteId === 'string' ? inviteId : '',
      );
      ensure(row, 'WEB_INVITE_UNAVAILABLE');
      ensure(row.redeemed_count === 0, 'WEB_INVITE_ALREADY_REDEEMED');
      if (row.status === 'revoked') return { inviteId, duplicate: true as const };
      this.store.run(
        "UPDATE web_invite_codes SET status='revoked',revoked_at=? WHERE id=? AND status='active' AND redeemed_count=0",
        now,
        inviteId,
      );
      this.audit(adminSessionId, 'invite-code-revoked', inviteId, now);
      return { inviteId, duplicate: false as const };
    });
  }

  /** Revoke a whole batch: every code of it that has not been redeemed yet. Players who already redeemed keep what they hold. */
  revokeBatch(adminSessionId: string, batchId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      this.requireAdmin(adminSessionId, now, 'invites.manage');
      ensure(
        typeof batchId === 'string' && this.store.get('SELECT 1 FROM web_invite_batches WHERE id=?', batchId),
        'NOT_FOUND',
      );
      const revoked = this.store.run(
        "UPDATE web_invite_codes SET status='revoked',revoked_at=? WHERE batch_id=? AND status='active' AND redeemed_count=0",
        now,
        batchId,
      ).changes;
      this.audit(adminSessionId, `invite-batch-revoked:${revoked}`, batchId, now);
      return { batchId, revoked };
    });
  }

  /**
   * End a redeemed code's entitlement NOW: the player falls back to a normal registered player with the balance it has and
   * stays signed in. Repeating it is a no-op (duplicate).
   */
  revokeEntitlement(adminSessionId: string, inviteId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      this.requireAdmin(adminSessionId, now, 'invites.manage');
      const id = typeof inviteId === 'string' ? inviteId : '';
      const held = this.store.get<{ id: string; revoked_at: number | null }>(
        'SELECT id,revoked_at FROM web_entitlements WHERE invite_id=?',
        id,
      );
      ensure(held, 'WEB_INVITE_UNAVAILABLE');
      if (held.revoked_at !== null) return { inviteId, duplicate: true as const };
      this.store.run('UPDATE web_entitlements SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now, held.id);
      this.audit(adminSessionId, 'invite-entitlement-revoked', id, now);
      return { inviteId, duplicate: false as const };
    });
  }

  /** A player's own active entitlement, for the 我的信息 page. */
  heldBy(principalId: string, now: number) {
    return activeEntitlement(this.store, principalId, now);
  }
}
