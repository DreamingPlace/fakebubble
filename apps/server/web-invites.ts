import type { InviteAdminPermission } from '../../packages/contracts/web-admin-permissions.ts';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { requireWebRuntime } from './web-store-contract.ts';
import type { WebIdentity } from './web-identity.ts';
import { requireWebAdminMembership } from './web-admin-schema.ts';

type InviteScope = { sessionId: string; principalId: string; playerId: string;
  worldId: string; kind: 'guest' | 'invite' };
type InviteAuthorizer = (token: string, csrf: string, origin: string) => InviteScope;
type IssueInput = { adminSessionId: string; requestId: string; redeemBy: number | null;
  accessDurationMs: number | null; batch: string; note: string | null };
type InviteRow = { id: string; code_digest: string; issue_digest: string; issue_request_id: string;
  redeem_by: number | null; access_duration_ms: number | null; status: string;
  redeemed_count: number; created_by: string };
type GrantRow = { id: string; invite_id: string; principal_id: string; player_id: string;
  world_id: string; redeemed_at: number; expires_at: number | null; revoked_at: number | null };

/** Invite business rules; persisted use requires the role-scoped synthetic schema112 preflight. */
export class WebInvites {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly codeKey: Buffer;
  private readonly authorize: InviteAuthorizer;
  private readonly nextId: () => string;
  private readonly random: (size: number) => Buffer;
  private readonly identity: Pick<WebIdentity, 'completeInviteRedemption' |
    'inviteReceiptChallenge' | 'recoverInviteReceipt' | 'inviteReceiptStatus'> | null;

  constructor(store: Store, options: { clock: Clock; codeKey: Buffer; authorize: InviteAuthorizer;
    identity?: Pick<WebIdentity, 'completeInviteRedemption' | 'inviteReceiptChallenge' |
      'recoverInviteReceipt' | 'inviteReceiptStatus'>; nextId?: () => string;
    random?: (size: number) => Buffer }) {
    requireWebRuntime(store, 'invite');
    ensure(options.codeKey.length === 32, 'WEB_INVITE_KEY_REQUIRED');
    ensure(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_codes'") &&
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_grants'") &&
      store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_redemptions'"),
    'WEB_INVITE_SCHEMA_REQUIRED');
    this.store = store; this.clock = options.clock; this.codeKey = options.codeKey;
    this.authorize = options.authorize; this.nextId = options.nextId ?? randomUUID;
    this.random = options.random ?? randomBytes;
    this.identity = options.identity ?? null;
    if (this.identity) ensure(store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_invite_identity_receipts'"),
      'WEB_INVITE_IDENTITY_SCHEMA_REQUIRED');
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private digest(label: string, value: string) {
    return createHmac('sha256', this.codeKey).update(label).update('\0').update(value).digest('hex');
  }
  private requireAdmin(sessionId: string, now: number, permission: InviteAdminPermission) {
    ensure(typeof sessionId === 'string' && this.store.get(`SELECT 1 FROM admin_sessions
      WHERE id=? AND revoked_at IS NULL AND expires_at>?`, sessionId, now), 'ADMIN_UNAUTHORIZED');
    requireWebAdminMembership(this.store, sessionId, permission);
  }
  private requestId(value: string) {
    ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'INVALID_REQUEST_ID');
  }

  /** A manual administrator action: one 256-bit code, one possible grant, no default terms. */
  issue(input: IssueInput) {
    this.requestId(input.requestId);
    ensure(Object.hasOwn(input, 'redeemBy') && Object.hasOwn(input, 'accessDurationMs') &&
      Object.hasOwn(input, 'batch') && Object.hasOwn(input, 'note') &&
      (input.redeemBy === null || Number.isSafeInteger(input.redeemBy) && input.redeemBy >= 0) &&
      (input.accessDurationMs === null || Number.isSafeInteger(input.accessDurationMs) &&
        input.accessDurationMs > 0) && typeof input.batch === 'string' &&
      input.batch.length >= 1 && input.batch.length <= 128 &&
      (input.note === null || typeof input.note === 'string' && input.note.length <= 500),
    'WEB_INVITE_TERMS_REQUIRED');
    const issueDigest = this.digest('issue-v1', JSON.stringify([
      input.redeemBy, input.accessDurationMs, input.batch, input.note]));
    return this.store.transaction(() => {
      const now = this.now(); this.requireAdmin(input.adminSessionId, now, 'invites.issue');
      const prior = this.store.get<InviteRow>(
        'SELECT * FROM web_invite_codes WHERE issue_request_id=?', input.requestId);
      if (prior) {
        ensure(prior.created_by === input.adminSessionId && prior.issue_digest === issueDigest,
          'IDEMPOTENCY_CONFLICT');
        return { inviteId: prior.id, code: null as string | null, duplicate: true as const };
      }
      ensure(input.redeemBy === null || input.redeemBy > now, 'WEB_INVITE_TERMS_REQUIRED');
      ensure(input.accessDurationMs === null ||
        Number.isSafeInteger(now + input.accessDurationMs), 'WEB_INVITE_TERMS_REQUIRED');
      const bytes = this.random(32);
      ensure(Buffer.isBuffer(bytes) && bytes.length === 32, 'WEB_RANDOM_INVALID');
      const code = bytes.toString('base64url'), inviteId = this.nextId();
      this.store.run(`INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,
        capacity,redeemed_count,redeem_by,access_duration_ms,status,batch,note,created_by,created_at)
        VALUES (?,?,?,?,1,0,?,?,'active',?,?,?,?)`, inviteId,
      this.digest('code-v1', code), input.requestId, issueDigest, input.redeemBy,
      input.accessDurationMs, input.batch, input.note, input.adminSessionId, now);
      return { inviteId, code, duplicate: false as const };
    });
  }

  /** Revoking a code prevents future redemption; it does not revoke an existing grant. */
  revokeCode(adminSessionId: string, inviteId: string) {
    return this.store.transaction(() => {
      const now = this.now(); this.requireAdmin(adminSessionId, now, 'invites.revoke-code');
      ensure(typeof inviteId === 'string' && inviteId.length > 0, 'WEB_INVITE_UNAVAILABLE');
      const row = this.store.get<InviteRow>('SELECT * FROM web_invite_codes WHERE id=?', inviteId);
      ensure(row, 'WEB_INVITE_UNAVAILABLE');
      if (row.status === 'revoked') return { inviteId, duplicate: true as const };
      ensure(this.store.run(`UPDATE web_invite_codes SET status='revoked',revoked_at=?
        WHERE id=? AND status='active'`, now, inviteId).changes === 1, 'WEB_INVITE_UNAVAILABLE');
      return { inviteId, duplicate: false as const };
    });
  }

  /** A separate administrator decision; all future entitlement reads must check the grant. */
  revokeGrant(adminSessionId: string, grantId: string) {
    return this.store.transaction(() => {
      const now = this.now(); this.requireAdmin(adminSessionId, now, 'invites.revoke-access');
      ensure(typeof grantId === 'string' && grantId.length > 0, 'WEB_INVITE_GRANT_UNAVAILABLE');
      const grant = this.store.get<GrantRow>('SELECT * FROM web_invite_grants WHERE id=?', grantId);
      ensure(grant, 'WEB_INVITE_GRANT_UNAVAILABLE');
      if (grant.revoked_at !== null) return { grantId, duplicate: true as const };
      ensure(this.store.run(`UPDATE web_invite_grants SET revoked_at=? WHERE id=? AND revoked_at IS NULL`,
        now, grantId).changes === 1, 'WEB_INVITE_GRANT_UNAVAILABLE');
      return { grantId, duplicate: false as const };
    });
  }

  /** If an identity adapter is present, its session rotation and sealed receipt join this transaction. */
  redeem(input: { token: string; csrf: string; origin: string; code: string; requestId: string }) {
    this.requestId(input.requestId);
    ensure(typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code),
      'WEB_INVITE_UNAVAILABLE');
    const codeDigest = this.digest('code-v1', input.code);
    return this.store.transaction(() => {
      const actor = this.authorize(input.token, input.csrf, input.origin), now = this.now();
      ensure(actor.kind === 'guest' || actor.kind === 'invite', 'WEB_GUEST_REQUIRED');
      const session = this.store.get<{ principal_id: string; account_id: string | null;
        recovery_epoch: string; absolute_expires_at: number; revoked_at: number | null }>(
        'SELECT * FROM web_sessions WHERE id=?', actor.sessionId);
      const epoch = this.store.get<{ recovery_epoch: string }>(
        'SELECT recovery_epoch FROM web_instance WHERE singleton=1')?.recovery_epoch;
      ensure(session && session.principal_id === actor.principalId && session.account_id === null &&
        session.revoked_at === null && session.absolute_expires_at > now &&
        session.recovery_epoch === epoch, 'SESSION_EXPIRED');
      const principal = this.store.get<{ kind: string; player_id: string; world_id: string;
        revision: number }>('SELECT * FROM web_principals WHERE id=?', actor.principalId);
      ensure(principal && principal.kind === actor.kind && principal.player_id === actor.playerId &&
        principal.world_id === actor.worldId && this.store.get<{ owner_id: string }>(
          'SELECT owner_id FROM worlds WHERE id=?', actor.worldId)?.owner_id === actor.playerId,
      'WEB_INVITE_SCOPE_INVALID');
      const prior = this.store.get<{ code_digest: string; grant_id: string }>(
        'SELECT code_digest,grant_id FROM web_invite_redemptions WHERE principal_id=? AND request_id=?',
        actor.principalId, input.requestId);
      if (prior) {
        ensure(prior.code_digest === codeDigest, 'IDEMPOTENCY_CONFLICT');
        const grant = this.store.get<GrantRow>('SELECT * FROM web_invite_grants WHERE id=?', prior.grant_id);
        ensure(grant && grant.principal_id === actor.principalId, 'WEB_INVITE_SCOPE_INVALID');
        return { grantId: grant.id, principalId: actor.principalId, playerId: actor.playerId,
          worldId: actor.worldId, expiresAt: grant.expires_at, duplicate: true as const };
      }
      ensure(principal.kind === 'guest' && !this.store.get(
        'SELECT 1 FROM web_invite_grants WHERE principal_id=?', actor.principalId), 'WEB_GUEST_REQUIRED');
      const retention = this.store.get<{ state: string; revision: number; expires_at: number | null;
        world_id: string }>('SELECT * FROM web_guest_retention WHERE principal_id=?', actor.principalId);
      ensure(retention && retention.world_id === actor.worldId && (retention.state === 'unstarted' ||
        retention.state === 'active' && retention.expires_at !== null && now < retention.expires_at),
      'TRIAL_EXPIRED');
      const invite = this.store.get<InviteRow>('SELECT * FROM web_invite_codes WHERE code_digest=?', codeDigest);
      ensure(invite && invite.status === 'active' && invite.redeemed_count === 0 &&
        (invite.redeem_by === null || now < invite.redeem_by), 'WEB_INVITE_UNAVAILABLE');
      const expiresAt = invite.access_duration_ms === null ? null : now + invite.access_duration_ms;
      ensure(expiresAt === null || Number.isSafeInteger(expiresAt), 'INVALID_TIME');
      ensure(this.store.run(`UPDATE web_invite_codes SET redeemed_count=1
        WHERE id=? AND status='active' AND redeemed_count=0 AND (redeem_by IS NULL OR redeem_by>?)`,
      invite.id, now).changes === 1, 'WEB_INVITE_UNAVAILABLE');
      const grantId = this.nextId();
      this.store.run(`INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,
        redeemed_at,expires_at) VALUES (?,?,?,?,?,?,?)`, grantId, invite.id, actor.principalId,
      actor.playerId, actor.worldId, now, expiresAt);
      this.store.run(`INSERT INTO web_invite_redemptions VALUES (?,?,?,?,?)`, actor.principalId,
        input.requestId, codeDigest, grantId, now);
      ensure(this.store.run(`UPDATE web_guest_retention SET state='protected',revision=revision+1
        WHERE principal_id=? AND world_id=? AND revision=? AND state IN ('unstarted','active')`,
      actor.principalId, actor.worldId, retention.revision).changes === 1, 'WEB_RETENTION_STALE');
      ensure(this.store.run(`UPDATE web_principals SET kind='invite',revision=revision+1
        WHERE id=? AND player_id=? AND world_id=? AND kind='guest' AND revision=?`,
      actor.principalId, actor.playerId, actor.worldId, principal.revision).changes === 1,
      'WEB_INVITE_SCOPE_INVALID');
      const identity = this.identity?.completeInviteRedemption({ token: input.token, csrf: input.csrf,
        origin: input.origin, requestId: input.requestId, codeDigest, grantId });
      return { grantId, principalId: actor.principalId, playerId: actor.playerId,
        worldId: actor.worldId, expiresAt, duplicate: false as const, ...(identity ? { identity } : {}) };
    });
  }

  inviteReceiptChallenge(oldToken: string) {
    ensure(this.identity, 'WEB_INVITE_IDENTITY_REQUIRED');
    return this.identity.inviteReceiptChallenge(oldToken);
  }

  recoverRedemption(input: { oldToken: string; csrf: string; origin: string;
    requestId: string; code: string }) {
    ensure(this.identity, 'WEB_INVITE_IDENTITY_REQUIRED');
    ensure(typeof input.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(input.code),
      'RECEIPT_UNAVAILABLE');
    return this.identity.recoverInviteReceipt(input.oldToken, input.csrf, input.origin,
      { requestId: input.requestId, codeDigest: this.digest('code-v1', input.code) });
  }

  inviteReceiptStatus(token: string, csrf: string, origin: string, requestId: string) {
    ensure(this.identity, 'WEB_INVITE_IDENTITY_REQUIRED');
    return this.identity.inviteReceiptStatus(token, csrf, origin, requestId);
  }
}
