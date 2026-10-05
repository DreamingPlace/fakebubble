import { InviteLocalApiError } from './invite-local-api.ts';

type AdminSession = { csrf: string; expiresAt: number };
type IssuedInvite = { inviteId: string; code: string | null; duplicate: boolean };
const safeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function session(value: unknown): AdminSession {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (typeof row.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(row.csrf) || !safeTime(row.expiresAt))
    throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
  return { csrf: row.csrf, expiresAt: row.expiresAt };
}

/** Same-origin synthetic administrator transport; grant and CSRF remain memory-only. */
export class InviteAdminApi {
  private readonly fetcher: typeof fetch;
  protected csrf: string | null = null;
  private readonly base: string;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init), base = '/api/web/local/admin') {
    this.fetcher = fetcher; this.base = base;
  }
  protected async request(path: string, body?: Record<string, unknown>) {
    const response = await this.fetcher(`${this.base}${path}`, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      ...(body ? { headers: { 'Content-Type': 'application/json',
        ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) }, body: JSON.stringify(body) } : {}),
    });
    let value: unknown;
    try { value = await response.json(); }
    catch { throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID'); }
    if (!response.ok) {
      if (response.status === 401) this.csrf = null;
      const error = value && typeof value === 'object' ?
        (value as { error?: { code?: unknown } }).error?.code : null;
      throw new InviteLocalApiError(response.status,
        typeof error === 'string' ? error : 'WEB_INVITE_ADMIN_REQUEST_FAILED');
    }
    return value;
  }
  async login(token: string): Promise<AdminSession> {
    this.csrf = null;
    const active = session(await this.request('/login', { token }));
    this.csrf = active.csrf;
    return active;
  }
  /** Restores the CSRF from an existing same-origin HttpOnly admin session cookie. */
  async restore(): Promise<AdminSession> {
    const active = session(await this.request('/session'));
    this.csrf = active.csrf;
    return active;
  }
  async issue(input: { requestId: string; redeemBy: number | null; batch: string;
    note: string | null }): Promise<IssuedInvite> {
    if (!this.csrf) throw new Error('WEB_INVITE_ADMIN_SESSION_REQUIRED');
    const value = await this.request('/invites/issue', { ...input, accessDurationMs: null });
    const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (typeof row.inviteId !== 'string' || typeof row.duplicate !== 'boolean' ||
      !(row.code === null || typeof row.code === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.code)) ||
      row.duplicate !== (row.code === null)) throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
    return { inviteId: row.inviteId, code: row.code, duplicate: row.duplicate };
  }
  async logout() {
    if (!this.csrf) throw new Error('WEB_INVITE_ADMIN_SESSION_REQUIRED');
    try {
      const value = await this.request('/logout', {});
      if (!value || typeof value !== 'object' || (value as { loggedOut?: unknown }).loggedOut !== true)
        throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
    } finally { this.csrf = null; }
  }
}
