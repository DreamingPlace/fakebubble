import { InviteLocalApiError } from './invite-local-api.ts';

/**
 * Part 59: when the admin console can no longer reach its own API. A save (or any call) that is answered with something that is not
 * the API's JSON (a Cloudflare challenge / Access page, a network error, a 401 / 403 from an expired session) is an INTERRUPTION, not
 * a failed save: nothing the owner typed is discarded, one short line says so, and when the owner has verified or signed in again
 * (in a popup or another tab, without leaving the page) the saves that were waiting are sent again by themselves.
 *
 * Module state only (no storage, no tokens): `state`, the listeners, and the retry callbacks the editors registered.
 */
export type InterruptReason = 'access' | 'challenge' | 'network' | 'login';

export class AdminInterruptedError extends InviteLocalApiError {
  readonly interrupted = true as const;
  readonly reason: InterruptReason;
  constructor(reason: InterruptReason, status = 0) {
    // The codes keep their old names: the page's sentences and the Access notice match on them.
    super(status, reason === 'login' ? 'ADMIN_UNAUTHORIZED' : 'ACCESS_REQUIRED');
    this.reason = reason;
  }
}
export const isInterrupted = (error: unknown): error is AdminInterruptedError =>
  error instanceof AdminInterruptedError || (error as { interrupted?: unknown } | null)?.interrupted === true;

/** The line the owner reads while edits wait (ADMIN_COPY: 保存 / 验证 / 重新登录). */
/** Cloudflare Access (Zero Trust) session expired: every admin POST answers a 302 to *.cloudflareaccess.com (an opaque redirect). */
export const ACCESS_EXPIRED_LINE = '登录验证过期了，修改都还在，验证后会自动保存';
export const INTERRUPTED_LINE = '保存没完成，修改都还在，验证或重新登录后会自动再存一次';
export const INTERRUPTED_LINE_READ = '连接中断，修改都还在，验证或重新登录后会自动继续';

type Listener = (state: 'ok' | 'interrupted', reason: InterruptReason | null) => void;
class Connection {
  state: 'ok' | 'interrupted' = 'ok';
  reason: InterruptReason | null = null;
  private listeners = new Set<Listener>();
  private retries = new Map<string, () => Promise<unknown> | unknown>();
  /** True when something that writes (not a read) was interrupted: the line then says the edits are kept. */
  writePending = false;
  on(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  interrupt(reason: InterruptReason, wasWrite: boolean) {
    this.writePending ||= wasWrite;
    const changed = this.state !== 'interrupted' || this.reason !== reason;
    this.state = 'interrupted';
    this.reason = reason;
    if (changed) for (const listener of [...this.listeners]) listener('interrupted', reason);
  }
  /** Any API answer proves the way is open again; the saves that were waiting then run (once each, newest registration per key). */
  open() {
    if (this.state === 'ok') return;
    this.state = 'ok';
    this.reason = null;
    this.writePending = false;
    for (const listener of [...this.listeners]) listener('ok', null);
    const waiting = [...this.retries.values()];
    this.retries.clear();
    for (const retry of waiting)
      void Promise.resolve()
        .then(retry)
        .catch(() => {});
  }
  /** An editor whose save was interrupted asks to be run again after re-authentication. The latest callback per key wins. */
  retryAfterReauth(key: string, retry: () => Promise<unknown> | unknown) {
    this.retries.set(key, retry);
  }
  forget(key: string) {
    this.retries.delete(key);
  }
  get waiting() {
    return this.retries.size;
  }
  /** Tests only. */
  reset() {
    this.state = 'ok';
    this.reason = null;
    this.writePending = false;
    this.retries.clear();
    this.listeners.clear();
  }
}
export const adminConnection = new Connection();

/** Where the verification / sign-in popup opens: the console itself, so Cloudflare's challenge and the console's own login both happen there. */
export function reauthUrl(location: { origin: string; pathname: string }) {
  // A top-level navigation to the console lets Access renew its cookie (and shows its login when needed).
  return `${location.origin}/?mode=provider-admin`;
}
