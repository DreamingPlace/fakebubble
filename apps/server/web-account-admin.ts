import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { Clock } from '../../packages/contracts/index.ts';
import type { BusinessStore } from './store-contract.ts';
import { WebInviteAdmin } from './web-invite-admin.ts';
import { installWebAdminSchema } from './web-admin-schema.ts';
import { adminPasswords, validateAdminPassword, validateAdminLoginPassword } from './web-admin-password.ts';

import { ADMIN_INVITE_PERMISSIONS, ADMIN_PERMISSION_LIMIT, hasInvitePermission, isAdminPermission, type AdminPermission } from '../../packages/contracts/web-admin-permissions.ts';
export { type AdminPermission } from '../../packages/contracts/web-admin-permissions.ts';
export const ADMIN_PERMISSIONS = ADMIN_INVITE_PERMISSIONS;
export type AdminMember = { id: string; role: 'owner' | 'admin'; label: string; email: string | null;
  createdAt: number; permissions: AdminPermission[] };
type MemberRow = { id: string; role: 'owner' | 'admin'; label: string; email: string | null;
  password_hash: string | null; credential_version: number; created_at: number; permissions_json: string };
type Challenge = { id: string; member_id: string; purpose: 'bind' | 'reset'; email: string;
  code_hash: string; credential_version: number; expires_at: number; attempts: number; consumed_at: number | null };
export interface AdminMailer {
  send(message: { id: string; to: string; purpose: 'bind' | 'reset'; code: string; expiresAt: number }): Promise<void>;
  waitUntil?(task: Promise<void>): void;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const publicMember = (row: MemberRow): AdminMember => ({ id: row.id, role: row.role, label: row.label,
  email: row.email, createdAt: row.created_at, permissions: JSON.parse(row.permissions_json) as AdminPermission[] });
function permissions(value: unknown): AdminPermission[] {
  ensure(Array.isArray(value) && value.length <= ADMIN_PERMISSION_LIMIT &&
    value.every(isAdminPermission) && new Set(value).size === value.length, 'INVALID_REQUEST');
  return [...value].sort() as AdminPermission[];
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function emailAddress(value: unknown) {
  ensure(typeof value === 'string' && value.length <= 254, 'ADMIN_EMAIL_INVALID');
  const email = value.trim().toLowerCase();
  ensure(/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) &&
    !email.startsWith('.') && !email.includes('..') && !email.includes('.@') && email.split('@')[0]!.length <= 64,
  'ADMIN_EMAIL_INVALID');
  return email;
}

/** Provider-only durable administrator identity. Players never enter this account namespace. */
export class WebAccountAdmin extends WebInviteAdmin {
  private readonly db: BusinessStore;
  private readonly time: Clock;
  private readonly site: string;
  private readonly bytes: (size: number) => Buffer;
  private readonly id: () => string;
  private readonly passwords: typeof adminPasswords;
  private readonly mail: AdminMailer | undefined;
  private hashing = false;
  constructor(store: BusinessStore, clock: Clock, origin: string, options: {
    mailer?: AdminMailer; passwords?: typeof adminPasswords;
    random?: (size: number) => Buffer; nextId?: () => string;
  } = {}) {
    super(store, clock, origin, options.random, options.nextId);
    this.db = store; this.time = clock; this.site = origin;
    this.bytes = options.random ?? randomBytes; this.id = options.nextId ?? randomUUID;
    this.passwords = options.passwords ?? adminPasswords; this.mail = options.mailer;
    installWebAdminSchema(store);
  }
  private at() {
    const now = this.time.now(); ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME'); return now;
  }
  private audit(actor: string | null, action: string, target: string) {
    this.db.run('INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)', actor, action, target, this.at());
  }
  private member(id: string) {
    const row = this.db.get<MemberRow>('SELECT * FROM web_admin_members WHERE id=?', id);
    ensure(row, 'ADMIN_UNAUTHORIZED'); return row;
  }
  private current(cookie: unknown) {
    super.session(cookie);
    const row = this.db.get<MemberRow>(`SELECT m.* FROM web_admin_members m
      JOIN web_admin_session_members a ON a.member_id=m.id
      JOIN admin_sessions s ON s.id=a.session_id WHERE s.secret_hash=?`, hash(cookie as string));
    ensure(row, 'ADMIN_UNAUTHORIZED'); return row;
  }
  override session(cookie: unknown) {
    const session = super.session(cookie), member = this.current(cookie);
    return { ...session, member: publicMember(member), emailDeliveryAvailable: !!this.mail };
  }
  override authorize(cookie: unknown, csrf: unknown, origin: unknown) {
    const auth = super.authorize(cookie, csrf, origin), member = this.current(cookie);
    return { ...auth, memberId: member.id, role: member.role };
  }
  private owner(cookie: unknown, csrf: unknown, origin: unknown) {
    const actor = this.authorize(cookie, csrf, origin); ensure(actor.role === 'owner', 'ADMIN_OWNER_REQUIRED'); return actor;
  }
  private createMember(role: 'owner' | 'admin', label: string, granted: AdminPermission[] = [...ADMIN_PERMISSIONS]) {
    ensure(this.db.get<{ n: number }>('SELECT count(*) n FROM web_admin_members')!.n < 100, 'ADMIN_MEMBER_LIMIT');
    const id = this.id();
    this.db.run(`INSERT INTO web_admin_members(id,role,label,created_at,permissions_json) VALUES (?,?,?,?,?)`,
      id, role, label, this.at(), JSON.stringify(granted));
    return id;
  }
  private grant(memberId: string, actor: string | null, requestKey: string | null = null, requestHash: string | null = null) {
    this.member(memberId);
    const grant = super.issueLoginGrant(), grantId = this.id();
    this.db.run('INSERT INTO web_admin_grant_members VALUES (?,?,?,?,?,?,NULL)',
      hash(grant.token), grantId, memberId, actor, requestKey, requestHash);
    this.audit(actor, 'grant-issued', memberId);
    return { ...grant, grantId, memberId };
  }
  /** Private operator only: first ever issuance establishes the owner; subsequent ones never promote. */
  override issueLoginGrant() {
    return this.db.transaction(() => {
      const first = !this.db.get('SELECT 1 FROM web_admin_members LIMIT 1');
      return this.grant(this.createMember(first ? 'owner' : 'admin', first ? '主管理员' : '管理员'), null);
    });
  }
  /** Private break-glass recovery does not change permissions, role or email. */
  issueRecoveryGrant(memberId: string) {
    return this.db.transaction(() => { this.member(memberId); this.invalidate(memberId); return this.grant(memberId, null); });
  }
  override login(token: unknown, origin: unknown) {
    ensure(origin === this.site, 'ADMIN_UNAUTHORIZED');
    ensure(typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token), 'ADMIN_INVALID_GRANT');
    return this.db.transaction(() => {
      const grant = this.db.get<{ member_id: string }>(`SELECT g.member_id FROM web_admin_grant_members g
        JOIN web_admin_members m ON m.id=g.member_id WHERE g.token_hash=? AND g.revoked_at IS NULL
        `, hash(token));
      ensure(grant, 'ADMIN_INVALID_GRANT');
      const login = super.login(token, origin);
      const session = super.authorize(login.cookie, login.csrf, origin);
      this.db.run('INSERT INTO web_admin_session_members VALUES (?,?)', session.sessionId, grant.member_id);
      this.audit(grant.member_id, 'grant-login', grant.member_id);
      return { ...login, ...this.session(login.cookie) };
    });
  }
  inviteRecords(cookie: unknown, csrf: unknown, origin: unknown, beforeId: unknown) {
    const actor = this.authorize(cookie, csrf, origin), member = this.current(cookie);
    ensure(actor.role === 'owner' || hasInvitePermission(JSON.parse(member.permissions_json), 'invites.read'), 'ADMIN_PERMISSION_REQUIRED');
    ensure(beforeId === null || identifier(beforeId), 'INVALID_REQUEST');
    const before = beforeId === null ? null : this.db.get<{ created_at:number }>('SELECT created_at FROM web_invite_codes WHERE id=?',beforeId);
    ensure(beforeId === null || before, 'INVALID_CURSOR');
    const rows = this.db.all<{ inviteId:string; batch:string; note:string|null; createdAt:number; redeemBy:number|null;
      status:string; redeemed:number; grantId:string|null; redeemedAt:number|null; accessRevokedAt:number|null; accessExpiresAt:number|null }>(`
      SELECT c.id inviteId,c.batch,c.note,c.created_at createdAt,c.redeem_by redeemBy,c.status,c.redeemed_count redeemed,
        g.id grantId,g.redeemed_at redeemedAt,g.revoked_at accessRevokedAt,g.expires_at accessExpiresAt FROM web_invite_codes c LEFT JOIN web_invite_grants g ON g.invite_id=c.id
      WHERE (? IS NULL OR c.created_at<? OR c.created_at=? AND c.id<?) ORDER BY c.created_at DESC,c.id DESC LIMIT 51`,
      beforeId,before?.created_at ?? null,before?.created_at ?? null,beforeId);
    return { records:rows.slice(0,50),next:rows.length>50 ? rows[49]!.inviteId : null };
  }
  private newSession(memberId: string) {
    this.member(memberId);
    const bytes = this.bytes(32); ensure(Buffer.isBuffer(bytes) && bytes.length === 32, 'WEB_RANDOM_INVALID');
    const cookie = bytes.toString('base64url'), id = this.id(), now = this.at();
    // Bound simultaneous sessions while preserving audit and historical foreign keys.
    this.db.run(`UPDATE admin_sessions SET revoked_at=? WHERE id IN (
      SELECT s.id FROM admin_sessions s JOIN web_admin_session_members a ON a.session_id=s.id
      WHERE a.member_id=? AND s.revoked_at IS NULL ORDER BY s.created_at DESC,s.id LIMIT -1 OFFSET 9)`, now, memberId);
    this.db.run('INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)', id, hash(cookie), now, now + 8 * 60 * 60_000);
    this.db.run('INSERT INTO web_admin_session_members VALUES (?,?)', id, memberId);
    return { cookie, ...this.session(cookie) };
  }
  private rate(key: string, maximum: number, duration = 60_000) {
    const accepted = this.db.transaction(() => {
      const now = this.at(); this.db.run('DELETE FROM web_admin_rates WHERE until_ms<=?', now);
      const row = this.db.get<{ count: number }>('SELECT count FROM web_admin_rates WHERE key=?', key);
      if (!row) {
        ensure(this.db.get<{ n: number }>('SELECT count(*) n FROM web_admin_rates')!.n < 1024, 'RATE_LIMITED');
        this.db.run('INSERT INTO web_admin_rates VALUES (?,?,1)', key, now + duration); return true;
      }
      if (row.count >= maximum) return false;
      this.db.run('UPDATE web_admin_rates SET count=count+1 WHERE key=?', key); return true;
    });
    ensure(accepted, 'RATE_LIMITED');
  }
  guard(purpose: string, trustedIpHash: string) {
    ensure(/^[a-f0-9]{64}$/.test(trustedIpHash), 'WEB_TRUSTED_IP_REQUIRED');
    this.rate(`${purpose}:global`, 30); this.rate(`${purpose}:ip:${trustedIpHash}`, 6);
  }
  private async kdf<T>(work: () => Promise<T>) {
    ensure(!this.hashing, 'RATE_LIMITED'); this.hashing = true;
    try { return await work(); } finally { this.hashing = false; }
  }
  async emailLogin(emailValue: unknown, password: unknown, origin: unknown, peer: string) {
    ensure(origin === this.site, 'ADMIN_UNAUTHORIZED'); this.guard('login', peer);
    const email = emailAddress(emailValue); validateAdminLoginPassword(password);
    this.rate(`login:email:${hash(email)}`, 10, 10 * 60_000);
    const row = this.db.get<MemberRow>('SELECT * FROM web_admin_members WHERE email=?', email);
    const valid = await this.kdf(() => this.passwords.verify(password, row?.password_hash ?? null));
    ensure(valid && row, 'ADMIN_LOGIN_INVALID');
    return this.db.transaction(() => {
      const current = this.db.get<MemberRow>('SELECT * FROM web_admin_members WHERE id=?', row.id);
      ensure(current && current.password_hash === row.password_hash &&
        current.credential_version === row.credential_version, 'ADMIN_LOGIN_INVALID');
      this.audit(row.id, 'email-login', row.id); return this.newSession(row.id);
    });
  }
  list(cookie: unknown, csrf: unknown, origin: unknown) {
    this.owner(cookie, csrf, origin);
    return { members: this.db.all<MemberRow>('SELECT * FROM web_admin_members ORDER BY created_at,id').map(publicMember),
      grants: this.db.all(`SELECT g.id,g.member_id AS memberId,l.expires_at AS expiresAt,
        l.consumed_session_id IS NOT NULL AS consumed,g.revoked_at AS revokedAt
        FROM web_admin_grant_members g JOIN admin_login_grants l ON l.token_hash=g.token_hash ORDER BY g.id`) };
  }
  issueMember(cookie: unknown, csrf: unknown, origin: unknown, input: { requestId: unknown; label: unknown; memberId: unknown; permissions: unknown }) {
    const actor = this.owner(cookie, csrf, origin);
    ensure(identifier(input.requestId) && typeof input.label === 'string' && input.label.trim().length > 0 &&
      input.label.length <= 80 && (input.memberId === null || identifier(input.memberId)), 'INVALID_REQUEST');
    const label = input.label.trim(), memberId = input.memberId as string | null, granted = permissions(input.permissions);
    const key = hash(`${actor.memberId}\0${input.requestId}`), fingerprint = hash(JSON.stringify([label, memberId, granted]));
    return this.db.transaction(() => {
      this.owner(cookie, csrf, origin);
      const old = this.db.get<{ id: string; member_id: string; request_hash: string }>(
        'SELECT * FROM web_admin_grant_members WHERE request_key=?', key);
      if (old) {
        ensure(old.request_hash === fingerprint, 'IDEMPOTENCY_CONFLICT');
        return { grantId: old.id, memberId: old.member_id, token: null, duplicate: true };
      }
      if (memberId) {
        const target = this.member(memberId); ensure(target.role !== 'owner', 'ADMIN_OWNER_PROTECTED');
      }
      const target = memberId ?? this.createMember('admin', label, granted);
      const grant = this.grant(target, actor.memberId, key, fingerprint);
      return { ...grant, duplicate: false };
    });
  }
  revokeGrant(cookie: unknown, csrf: unknown, origin: unknown, grantId: string) {
    const actor = this.owner(cookie, csrf, origin);
    return this.db.transaction(() => {
      const row = this.db.get<{ member_id: string }>('SELECT member_id FROM web_admin_grant_members WHERE id=?', grantId);
      ensure(row, 'NOT_FOUND'); ensure(this.member(row.member_id).role !== 'owner', 'ADMIN_OWNER_PROTECTED');
      this.db.run('UPDATE web_admin_grant_members SET revoked_at=coalesce(revoked_at,?) WHERE id=?', this.at(), grantId);
      this.audit(actor.memberId, 'grant-revoked', row.member_id); return { revoked: true };
    });
  }
  private invalidate(memberId: string) {
    const now = this.at();
    this.db.run(`UPDATE admin_sessions SET revoked_at=coalesce(revoked_at,?) WHERE id IN
      (SELECT session_id FROM web_admin_session_members WHERE member_id=?)`, now, memberId);
    this.db.run('UPDATE web_admin_grant_members SET revoked_at=coalesce(revoked_at,?) WHERE member_id=?', now, memberId);
    this.db.run('UPDATE web_admin_challenges SET consumed_at=coalesce(consumed_at,?) WHERE member_id=?', now, memberId);
    this.db.run('UPDATE web_admin_members SET credential_version=credential_version+1 WHERE id=?', memberId);
  }
  setPermissions(cookie: unknown, csrf: unknown, origin: unknown, memberId: string, value: unknown, expectedValue?: unknown) {
    this.owner(cookie, csrf, origin);
    const granted = permissions(value), expected = expectedValue === undefined ? undefined : permissions(expectedValue);
    return this.db.transaction(() => {
      const actor = this.owner(cookie, csrf, origin);
      const target = this.db.get<MemberRow>('SELECT * FROM web_admin_members WHERE id=?', memberId);
      ensure(target, 'NOT_FOUND'); ensure(target.role !== 'owner', 'ADMIN_OWNER_PROTECTED');
      ensure(expected === undefined || JSON.stringify(permissions(JSON.parse(target.permissions_json))) === JSON.stringify(expected), 'ADMIN_PERMISSIONS_CONFLICT');
      this.db.run('UPDATE web_admin_members SET permissions_json=? WHERE id=?', JSON.stringify(granted), memberId);
      this.audit(actor.memberId, `permissions:${granted.join(',')}`, memberId);
      return { member: publicMember(this.member(memberId)) };
    });
  }
  private async challenge(member: MemberRow, email: string, purpose: 'bind' | 'reset') {
    ensure(this.mail, 'ADMIN_EMAIL_UNAVAILABLE');
    const id = this.id(), expiresAt = this.at() + 10 * 60_000;
    let code: string | undefined;
    // Reject the uneven tail rather than biasing the million possible six-digit codes.
    for (let attempt = 0; attempt < 32; attempt++) {
      const bytes = this.bytes(4);
      ensure(Buffer.isBuffer(bytes) && bytes.length === 4, 'WEB_RANDOM_INVALID');
      const number = bytes.readUInt32BE();
      if (number < 4_294_000_000) { code = String(number % 1_000_000).padStart(6, '0'); break; }
    }
    ensure(code !== undefined, 'WEB_RANDOM_INVALID');
    this.db.transaction(() => {
      this.member(member.id);
      this.db.run('DELETE FROM web_admin_challenges WHERE expires_at<=?', this.at());
      this.db.run('UPDATE web_admin_challenges SET consumed_at=coalesce(consumed_at,?) WHERE member_id=? AND purpose=?',
        this.at(), member.id, purpose);
      this.db.run(`INSERT INTO web_admin_challenges(id,member_id,purpose,email,code_hash,credential_version,expires_at,delivery)
        VALUES (?,?,?,?,?,?,?,'pending')`, id, member.id, purpose, email, hash(`${id}\0${code}`), member.credential_version, expiresAt);
    });
    // Return the same shape without awaiting recipient-dependent network timing.
    // Persist before dispatch; an interrupted/unknown send is never auto-retried.
    const delivery = Promise.resolve().then(() => this.mail!.send({ id, to: email, purpose, code, expiresAt }))
      .then(() => { this.db.run("UPDATE web_admin_challenges SET delivery='accepted' WHERE id=?", id); },
        () => { this.db.run("UPDATE web_admin_challenges SET delivery='unknown' WHERE id=?", id); });
    this.mail.waitUntil?.(delivery);
    void delivery.catch(() => {}); // Shutdown leaves the persisted pending state, not a resend.
    return { challengeId: id, expiresAt };
  }
  async startBinding(cookie: unknown, csrf: unknown, origin: unknown, value: unknown) {
    this.authorize(cookie, csrf, origin); const member = this.current(cookie), email = emailAddress(value);
    ensure(this.mail, 'ADMIN_EMAIL_UNAVAILABLE'); ensure(member.email === null, 'ADMIN_EMAIL_ALREADY_BOUND');
    this.rate(`mail:member:${member.id}`, 3, 10 * 60_000); this.rate('mail:global', 20, 60 * 60_000);
    // Do not expose whether another administrator has this email.
    return this.challenge(member, email, 'bind');
  }
  async startReset(value: unknown, origin: unknown, peer: string) {
    ensure(origin === this.site, 'ADMIN_UNAUTHORIZED'); ensure(this.mail, 'ADMIN_EMAIL_UNAVAILABLE');
    this.guard('reset', peer); const email = emailAddress(value);
    this.rate(`mail:email:${hash(email)}`, 3, 10 * 60_000); this.rate('mail:global', 20, 60 * 60_000);
    const member = this.db.get<MemberRow>('SELECT * FROM web_admin_members WHERE email=?', email);
    return member ? this.challenge(member, email, 'reset') : { challengeId: this.id(), expiresAt: this.at() + 10 * 60_000 };
  }
  private checkChallenge(id: unknown, code: unknown, purpose: 'bind' | 'reset', memberId?: string) {
    ensure(identifier(id) && typeof code === 'string' && /^(?:[0-9]{6}|[A-Fa-f0-9]{16})$/.test(code), 'ADMIN_CODE_INVALID');
    // Accept still-live pre-upgrade challenges until their original ten-minute expiry.
    const row = this.db.get<Challenge>('SELECT * FROM web_admin_challenges WHERE id=?', id);
    ensure(row && row.purpose === purpose && (!memberId || row.member_id === memberId) &&
      row.consumed_at === null && row.expires_at > this.at() && row.attempts < 5, 'ADMIN_CODE_INVALID');
    this.db.run('UPDATE web_admin_challenges SET attempts=attempts+1 WHERE id=?', id);
    ensure(timingSafeEqual(Buffer.from(row.code_hash), Buffer.from(hash(`${id}\0${code.toUpperCase()}`))), 'ADMIN_CODE_INVALID');
    const member = this.member(row.member_id);
    ensure(member.credential_version === row.credential_version, 'ADMIN_CODE_INVALID'); return row;
  }
  private finishChallenge(row: Challenge, passwordHash: string) {
    const current = this.db.get<Challenge>('SELECT * FROM web_admin_challenges WHERE id=?', row.id), member = this.member(row.member_id);
    ensure(current && current.consumed_at === null && current.expires_at > this.at() &&
      member.credential_version === row.credential_version, 'ADMIN_CODE_INVALID');
    ensure(row.purpose !== 'bind' || member.email === null, 'ADMIN_EMAIL_ALREADY_BOUND');
    ensure(!this.db.get('SELECT 1 FROM web_admin_members WHERE email=? AND id<>?', row.email, member.id), 'ADMIN_EMAIL_UNAVAILABLE_FOR_BINDING');
    this.invalidate(member.id);
    this.db.run('UPDATE web_admin_members SET email=?,password_hash=? WHERE id=?', row.email, passwordHash, member.id);
    this.audit(member.id, row.purpose === 'bind' ? 'email-bound' : 'password-reset', member.id);
  }
  async finishBinding(cookie: unknown, csrf: unknown, origin: unknown, id: unknown, code: unknown, password: unknown) {
    const actor = this.authorize(cookie, csrf, origin); validateAdminPassword(password);
    const row = this.checkChallenge(id, code, 'bind', actor.memberId);
    const passwordHash = await this.kdf(() => this.passwords.hash(password));
    return this.db.transaction(() => {
      this.authorize(cookie, csrf, origin); this.finishChallenge(row, passwordHash); return this.newSession(actor.memberId);
    });
  }
  async finishReset(origin: unknown, peer: string, id: unknown, code: unknown, password: unknown) {
    ensure(origin === this.site, 'ADMIN_UNAUTHORIZED'); this.guard('reset-finish', peer); validateAdminPassword(password);
    const row = this.checkChallenge(id, code, 'reset');
    const passwordHash = await this.kdf(() => this.passwords.hash(password));
    return this.db.transaction(() => { this.finishChallenge(row, passwordHash); return { reset: true }; });
  }
}
