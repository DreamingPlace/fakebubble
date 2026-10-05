import { CharacterAdminClient } from './character-admin-api.ts';
import { InviteAdminApi } from './invite-admin-api.ts';
import { ADMIN_PERMISSION_LIMIT, isAdminPermission, type AdminPermission } from '../../../../packages/contracts/web-admin-permissions.ts';

export type { AdminPermission } from '../../../../packages/contracts/web-admin-permissions.ts';
export type AdminMember = { id: string; label: string; role: 'owner' | 'admin'; email: string | null;
  permissions: AdminPermission[]; createdAt: number };
export type AccountAdminSession = { csrf: string; expiresAt: number; member: AdminMember; emailDeliveryAvailable: boolean };
export type AdminGrant = { id: string; memberId: string; expiresAt: number; consumed: boolean; revokedAt: number | null };
const invalid = () => new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function string(value: unknown): string { if (typeof value !== 'string') throw invalid(); return value; }
function time(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(); return value as number; }
function member(value: unknown): AdminMember {
  const row = object(value), role = row.role, permissions = row.permissions;
  if (!['owner','admin'].includes(role as string) || !(row.email === null || typeof row.email === 'string') ||
    !Array.isArray(permissions) || permissions.length > ADMIN_PERMISSION_LIMIT || new Set(permissions).size !== permissions.length ||
    !permissions.every(isAdminPermission)) throw invalid();
  return { id: string(row.id), label: string(row.label), role: role as AdminMember['role'], email: row.email as string | null,
    createdAt: time(row.createdAt), permissions: permissions as AdminPermission[] };
}
function challenge(value: unknown) {
  const row = object(value); return { challengeId: string(row.challengeId), expiresAt: time(row.expiresAt) };
}
export class AccountAdminApi extends InviteAdminApi {
  readonly characters = new CharacterAdminClient((path,body) => this.request('/characters/'+path,body));
  constructor(fetcher?: typeof fetch) { super(fetcher, '/api/web/provider/admin'); }
  private active(value: unknown): AccountAdminSession {
    const row = object(value);
    if (typeof row.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(row.csrf) || typeof row.emailDeliveryAvailable !== 'boolean') throw invalid();
    const active = { csrf: row.csrf, expiresAt: time(row.expiresAt), member: member(row.member), emailDeliveryAvailable: row.emailDeliveryAvailable };
    this.csrf = active.csrf; return active;
  }
  override async login(token: string) { this.csrf = null; return this.active(await this.request('/login', { token })); }
  override async restore() { this.csrf = null; return this.active(await this.request('/session')); }
  async emailLogin(email: string, password: string) {
    this.csrf = null; return this.active(await this.request('/email/login', { email, password }));
  }
  async bindStart(email: string) { return challenge(await this.request('/email/bind/start', { email })); }
  async bindFinish(challengeId: string, code: string, password: string) {
    return this.active(await this.request('/email/bind/finish', { challengeId, code, password }));
  }
  async resetStart(email: string) { return challenge(await this.request('/email/reset/start', { email })); }
  async resetFinish(challengeId: string, code: string, password: string) {
    if (object(await this.request('/email/reset/finish', { challengeId, code, password })).reset !== true) throw invalid();
    this.csrf = null;
  }
  async members() {
    const row = object(await this.request('/members/list', {}));
    if (!Array.isArray(row.members) || !Array.isArray(row.grants)) throw invalid();
    return { members: row.members.map(member), grants: row.grants.map(value => {
      const grant = object(value);
      if (grant.consumed !== 0 && grant.consumed !== 1) throw invalid();
      return { id: string(grant.id), memberId: string(grant.memberId), expiresAt: time(grant.expiresAt),
        consumed: grant.consumed === 1, revokedAt: grant.revokedAt === null ? null : time(grant.revokedAt) };
    }) };
  }
  async issueMember(input: { requestId: string; label: string; memberId: string | null; permissions: AdminPermission[] }) {
    const row = object(await this.request('/members/issue', input));
    if (typeof row.duplicate !== 'boolean' || !(row.token === null || typeof row.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.token)) ||
      row.duplicate !== (row.token === null)) throw invalid();
    return { memberId: string(row.memberId), grantId: string(row.grantId), token: row.token as string | null, duplicate: row.duplicate };
  }
  async setPermissions(memberId: string, permissions: AdminPermission[], expectedPermissions?: AdminPermission[]) {
    return member(object(await this.request('/members/permissions', { memberId, permissions,
      ...(expectedPermissions === undefined ? {} : { expectedPermissions }) })).member);
  }
  async revokeCredential(grantId: string) {
    if (object(await this.request('/members/revoke-credential', { grantId })).revoked !== true) throw invalid();
  }
  async inviteRecords(beforeId: string | null = null) {
    const r=object(await this.request('/invites/list',{beforeId})); if(!Array.isArray(r.records))throw invalid();
    return { next:r.next===null?null:string(r.next),records:r.records.map(v=>{const c=object(v);
      if(!['active','revoked'].includes(String(c.status)) || ![0,1].includes(c.redeemed as number))throw invalid();
      return {inviteId:string(c.inviteId),batch:string(c.batch),note:c.note===null?null:string(c.note),createdAt:time(c.createdAt),
        redeemBy:c.redeemBy===null?null:time(c.redeemBy),status:string(c.status),redeemed:Number(c.redeemed),grantId:c.grantId===null?null:string(c.grantId),
        redeemedAt:c.redeemedAt===null?null:time(c.redeemedAt),accessRevokedAt:c.accessRevokedAt===null?null:time(c.accessRevokedAt),accessExpiresAt:c.accessExpiresAt===null?null:time(c.accessExpiresAt)};
    })};
  }
  async revokeInvite(kind: 'code' | 'grant', id: string) { await this.request(`/invites/revoke-${kind}`, { id }); }
}
