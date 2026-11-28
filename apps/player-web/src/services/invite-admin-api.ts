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

/**
 * Part 60: EVERY admin request has a deadline, so one hung answer (a stuck reply, a Cloudflare challenge, a connection that died while
 * the tab slept) can never hold the console. 20 s by default; the session read keeps its 15 s (Part 59); the few requests that
 * genuinely need longer have their own NAMED deadline (at most 60 s): an export builds a whole file, and a generation waits for a
 * provider call inside the business object.
 */
export const ADMIN_DEADLINE_MS = 20_000;
export const ADMIN_SESSION_DEADLINE_MS = 15_000;
export const ADMIN_EXPORT_DEADLINE_MS = 60_000;
export const ADMIN_GENERATE_DEADLINE_MS = 60_000;
/** Paths that only READ (their last segment): the ones a newer page-open may cancel, and whose interruption is not a lost write. */
const READ_PATH =
  /(?:^|\/)(?:list|read|status|detail|counts|draft|order|home-order|versions?|library|options|items|heard|arc-read|closed-read|memes-list|memes-queue|batch-list|batch-detail|unknown-calls|validate|review-read|writer-read|stage-latency|chart|costs|players|spend-by-type|stats|relation\/(?:detail|stats|order)|wordings\/list|members\/list|points\/(?:preview|reset-preview|cocreation)|overview\/read|models\/read)$/;
export const isReadPath = (path: string) => READ_PATH.test(path);
const EXPORT_PATH = /export/;
const GENERATE_PATH = /(?:generate|tidy|speak|start|take-audio|import-file|import-legacy|memes-import|upload)$/;
/** The deadline of one request and the name that appears in the notes. */
export function adminDeadline(path: string): { ms: number; name: 'session' | 'export' | 'generate' | 'default' } {
  if (path === '/session') return { ms: ADMIN_SESSION_DEADLINE_MS, name: 'session' };
  if (isReadPath(path)) return { ms: ADMIN_DEADLINE_MS, name: 'default' };
  if (EXPORT_PATH.test(path)) return { ms: ADMIN_EXPORT_DEADLINE_MS, name: 'export' };
  if (GENERATE_PATH.test(path)) return { ms: ADMIN_GENERATE_DEADLINE_MS, name: 'generate' };
  return { ms: ADMIN_DEADLINE_MS, name: 'default' };
}
/** A read that a newer page-open replaced: not an error and not an interruption (nothing is shown). */
export class AdminCancelledError extends Error {
  readonly cancelled = true as const;
  constructor() {
    super('ADMIN_REQUEST_CANCELLED');
  }
}
export const isCancelled = (error: unknown): error is AdminCancelledError =>
  error instanceof AdminCancelledError || (error as { cancelled?: unknown } | null)?.cancelled === true;

/** Same-origin administrator transport (the base of AccountAdminApi); grant and CSRF remain memory-only. */
export class InviteAdminApi {
  private readonly fetcher: typeof fetch;
  protected csrf: string | null = null;
  /** Part 59: an admin session was opened here (and not ended by a sign-out): a 401 later is an interruption, not a sign-in screen. */
  protected signedIn = false;
  private readonly base: string;
  /** Part 60: the page-open that is loading now; its READS are cancelled when a newer page-open replaces it. Writes never are. */
  private loadSignal: AbortSignal | null = null;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init), base = '/api/web/local/admin') {
    this.fetcher = fetcher;
    this.base = base;
  }
  setLoadSignal(signal: AbortSignal | null) {
    this.loadSignal = signal;
  }
  protected async request(path: string, body?: Record<string, unknown>) {
    const read = isReadPath(path) || path === '/session';
    const wasWrite = !!body && !read;
    const interrupted = (reason: 'access' | 'challenge' | 'network' | 'login', status = 0) => {
      // Only a console that had a session can be "interrupted": the first sign-in's own failures are ordinary errors.
      if (this.signedIn) adminConnection.interrupt(reason, wasWrite, external !== null);
      return new AdminInterruptedError(reason, status);
    };
    const external = read && path !== '/session' ? this.loadSignal : null;
    if (external?.aborted) throw new AdminCancelledError();
    // Every request has a deadline (see above). `expired` tells the deadline from a newer page-open that cancelled this read.
    const control = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let expired = false;
    const stop = new Promise<never>((_, reject) => {
      const fail = () => reject(new Error('ADMIN_REQUEST_ABORTED'));
      control?.signal.addEventListener('abort', fail, { once: true });
    });
    stop.catch(() => {});
    const timer = control
      ? setTimeout(() => {
          expired = true;
          control.abort();
        }, adminDeadline(path).ms)
      : null;
    (timer as { unref?: () => void } | null)?.unref?.();
    const onCancel = () => control?.abort();
    external?.addEventListener('abort', onCancel, { once: true });
    const guard = (error: unknown): never => {
      if (control?.signal.aborted && !expired) throw new AdminCancelledError();
      // A followed Access redirect fails as a CORS TypeError; either way the browser must pass Access first. A timeout or a lost
      // connection is the same: the way is closed for now, and nothing the owner typed is lost.
      if (expired || error instanceof TypeError || (error as { name?: string } | null)?.name === 'AbortError')
        throw interrupted('network');
      throw error;
    };
    try {
      let response: Response;
      try {
        const sent = this.fetcher(`${this.base}${path}`, {
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
        sent.catch(() => {});
        response = await Promise.race([sent, stop]);
      } catch (error) {
        return guard(error);
      }
      if (response.type === 'opaqueredirect' || /cloudflareaccess\.com/.test(response.url ?? ''))
        throw interrupted('access');
      let value: unknown;
      try {
        value = await Promise.race([response.json(), stop]);
      } catch (error) {
        if (control?.signal.aborted) return guard(error);
        // Not the API's JSON (an HTML challenge page, a gateway error page): the answer did not come from the console's own API.
        if (response.status === 401) this.csrf = null;
        throw interrupted(/cloudflareaccess\.com/.test(response.url ?? '') ? 'access' : 'challenge', response.status);
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
    } finally {
      if (timer) clearTimeout(timer);
      external?.removeEventListener('abort', onCancel);
    }
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
