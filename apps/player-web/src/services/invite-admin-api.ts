import { InviteLocalApiError } from './invite-local-api.ts';
import { AdminInterruptedError, adminConnection } from './admin-connection.ts';

type AdminSession = { csrf: string; expiresAt: number };
const safeTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function session(value: unknown): AdminSession {
  const row = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  if (typeof row.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(row.csrf) || !safeTime(row.expiresAt))
    throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
  return { csrf: row.csrf, expiresAt: row.expiresAt };
}

/** Same-origin administrator transport (the base of AccountAdminApi); grant and CSRF remain memory-only. */
export class InviteAdminApi {
  private readonly fetcher: typeof fetch;
  protected csrf: string | null = null;
  /** Part 59: an admin session was opened here (and not ended by a sign-out): a 401 later is an interruption, not a sign-in screen. */
  protected signedIn = false;
  private readonly base: string;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init), base = '/api/web/local/admin') {
    this.fetcher = fetcher;
    this.base = base;
  }
  protected async request(path: string, body?: Record<string, unknown>) {
    const wasWrite = !!body && path !== '/session';
    const interrupted = (reason: 'challenge' | 'network' | 'login', status = 0) => {
      // Only a console that had a session can be "interrupted": the first sign-in's own failures are ordinary errors.
      if (this.signedIn) adminConnection.interrupt(reason, wasWrite);
      return new AdminInterruptedError(reason, status);
    };
    // The session read is the one the console makes in the background: it must never hang the page, so it has a deadline.
    const control = path === '/session' && typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = control ? setTimeout(() => control.abort(), 15_000) : null;
    (timer as { unref?: () => void } | null)?.unref?.();
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}`, {
        method: body ? 'POST' : 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
        // Cloudflare Access answers a browser without its cookie with a cross-origin redirect to its login page.
        redirect: 'manual',
        ...(control ? { signal: control.signal } : {}),
        ...(body
          ? {
              headers: { 'Content-Type': 'application/json', ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) },
              body: JSON.stringify(body),
            }
          : {}),
      });
    } catch (error) {
      // A followed Access redirect fails as a CORS TypeError; either way the browser must pass Access first. A timeout or a lost
      // connection is the same: the way is closed for now, and nothing the owner typed is lost.
      if (error instanceof TypeError || (error as { name?: string } | null)?.name === 'AbortError')
        throw interrupted('network');
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.type === 'opaqueredirect') throw interrupted('challenge');
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      // Not the API's JSON (an HTML challenge page, a gateway error page): the answer did not come from the console's own API.
      if (response.status === 401) this.csrf = null;
      throw interrupted('challenge', response.status);
    }
    const error = value && typeof value === 'object' ? (value as { error?: { code?: unknown } }).error?.code : null;
    if (!response.ok) {
      if (response.status === 401) this.csrf = null;
      if (response.status === 401 && error === 'ADMIN_UNAUTHORIZED') throw interrupted('login', 401);
      throw new InviteLocalApiError(
        response.status,
        typeof error === 'string' ? error : 'WEB_INVITE_ADMIN_REQUEST_FAILED',
        value && typeof value === 'object' ? (value as { error?: { detail?: unknown } }).error?.detail : undefined,
      );
    }
    // The API itself answered: the way is open (a save that waited for it is sent again now).
    adminConnection.open();
    return value;
  }
  async login(token: string): Promise<AdminSession> {
    this.csrf = null;
    const active = session(await this.request('/login', { token }));
    this.csrf = active.csrf;
    this.signedIn = true;
    return active;
  }
  /** Restores the CSRF from an existing same-origin HttpOnly admin session cookie. */
  async restore(): Promise<AdminSession> {
    const active = session(await this.request('/session'));
    this.csrf = active.csrf;
    this.signedIn = true;
    return active;
  }
  async logout() {
    if (!this.csrf) throw new Error('WEB_INVITE_ADMIN_SESSION_REQUIRED');
    try {
      const value = await this.request('/logout', {});
      if (!value || typeof value !== 'object' || (value as { loggedOut?: unknown }).loggedOut !== true)
        throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
    } finally {
      this.csrf = null;
      this.signedIn = false;
    }
  }
}
