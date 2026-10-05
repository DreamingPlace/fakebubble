import { parseAccess, parseBootstrap, parseError, parseHistory, parseOperation, parseSync,
  WebLocalProtocolError, type LocalAccess, type LocalView } from '../../../../packages/contracts/web-local-client.ts';
import type { WebLocalHistoryPage, WebLocalOperation, WebLocalSyncPage } from '../../../../packages/contracts/web-local.ts';
import { parseWebInviteBootstrap, type WebInviteView } from '../../../../packages/contracts/web-local-invite.ts';

export class LocalApiError extends Error {
  readonly status: number; readonly code: string;
  constructor(status: number, code: string) { super(code); this.name = 'LocalApiError'; this.status = status; this.code = code; }
}
export class StaleLocalIdentityError extends Error {
  constructor() { super('identity transition superseded'); this.name = 'StaleLocalIdentityError'; }
}
const requireCurrent = (current: () => boolean) => { if (!current()) throw new StaleLocalIdentityError(); };

/** Same-origin, cookie-authenticated synthetic-local transport; never persists CSRF. */
export class LocalApi {
  private csrf = '';
  private csrfEpoch = 0;
  private latestBootstrap: LocalView | null = null;
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) { this.fetcher = fetcher; }
  setCsrf(csrf: string) { this.csrf = csrf; this.csrfEpoch++; this.latestBootstrap = null; }
  private async request(path: string, init: RequestInit = {}, csrf = this.csrf): Promise<unknown> {
    const response = await this.fetcher(`/api/web/local${path}`, { ...init, credentials: 'same-origin',
      cache: 'no-store', headers: { ...(init.body ? { 'Content-Type': 'application/json',
        'X-CSRF-Token': csrf } : {}) } });
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new WebLocalProtocolError('non-JSON response'); }
    if (!response.ok) throw new LocalApiError(response.status, parseError(payload).code);
    return payload;
  }
  private async bootstrapWith<T extends LocalView | WebInviteView>(parse: (value: unknown) => T,
    signal: AbortSignal | undefined, current: () => boolean): Promise<T> {
    const epoch = ++this.csrfEpoch;
    this.latestBootstrap = null;
    const view = parse(await this.request('/bootstrap', { signal: signal ?? null }));
    requireCurrent(current);
    if (epoch !== this.csrfEpoch) {
      if (this.latestBootstrap) return this.latestBootstrap as T;
      throw new StaleLocalIdentityError();
    }
    this.csrf = view.bootstrap.csrf;
    if (view.bootstrap.contractVersion !== 'web-v1-local-3') this.latestBootstrap = view as LocalView;
    return view;
  }
  async bootstrap(signal?: AbortSignal, current: () => boolean = () => true): Promise<LocalView> {
    return this.bootstrapWith(parseBootstrap, signal, current);
  }
  /** One GET selects the trusted local-2 guest/account or local-3 invite contract. */
  async bootstrapAny(signal?: AbortSignal, current: () => boolean = () => true): Promise<LocalView | WebInviteView> {
    return this.bootstrapWith(value => {
      const version = value && typeof value === 'object' ?
        (value as { contractVersion?: unknown }).contractVersion : null;
      return version === 'web-v1-local-3' ? parseWebInviteBootstrap(value) : parseBootstrap(value);
    }, signal, current);
  }
  async access(signal?: AbortSignal): Promise<LocalAccess> {
    return parseAccess(await this.request('/access', { signal: signal ?? null }));
  }
  async byRequest(requestId: string, signal?: AbortSignal): Promise<WebLocalOperation> {
    return parseOperation(await this.request(`/operations/by-request/${encodeURIComponent(requestId)}`, { signal: signal ?? null }));
  }
  async operation(operationId: string, signal?: AbortSignal): Promise<WebLocalOperation> {
    return parseOperation(await this.request(`/operations/${encodeURIComponent(operationId)}`, { signal: signal ?? null }));
  }
  async send(characterId: string, requestId: string, text: string, signal?: AbortSignal,
    csrf?: string): Promise<WebLocalOperation> {
    const payload = await this.request(`/characters/${encodeURIComponent(characterId)}/operations`,
      { method: 'POST', body: JSON.stringify({ requestId, text, delivery: 'voice' }), signal: signal ?? null }, csrf);
    const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (typeof root.duplicate !== 'boolean') throw new WebLocalProtocolError('invalid send receipt');
    return parseOperation(root.operation);
  }
  async sync(cursor: string, signal?: AbortSignal): Promise<WebLocalSyncPage> {
    return parseSync(await this.request(`/sync?cursor=${encodeURIComponent(cursor)}`, { signal: signal ?? null }));
  }
  async history(conversationId: string, before?: string, signal?: AbortSignal): Promise<WebLocalHistoryPage> {
    return parseHistory(await this.request(`/conversations/${encodeURIComponent(conversationId)}/history${before ?
      `?before=${encodeURIComponent(before)}` : ''}`, { signal: signal ?? null }));
  }
  eventUrl(cursor: string) { return `/api/web/local/events?cursor=${encodeURIComponent(cursor)}`; }
  async register(requestId: string, username: string, password: string, current: () => boolean = () => true) {
    return this.identityReceipt(await this.request('/register', { method: 'POST',
      body: JSON.stringify({ requestId, username, password }) }), current);
  }
  async receiptStatus(requestId: string) {
    const value = await this.request('/identity/receipt-status', { method: 'POST',
      body: JSON.stringify({ requestId }) });
    const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (typeof r.accountId !== 'string' || typeof r.principalId !== 'string' || r.duplicate !== false)
      throw new WebLocalProtocolError('invalid identity status');
    return { accountId: r.accountId, principalId: r.principalId };
  }
  async receiptChallenge(current: () => boolean = () => true): Promise<string> {
    const value = await this.request('/identity/receipt-challenge');
    const csrf = value && typeof value === 'object' ? (value as Record<string, unknown>).csrf : null;
    if (typeof csrf !== 'string') throw new WebLocalProtocolError('invalid receipt challenge');
    requireCurrent(current);
    this.setCsrf(csrf);
    return csrf;
  }
  async recoverRegister(requestId: string, username: string, password: string,
    current: () => boolean = () => true) {
    return this.identityReceipt(await this.request('/identity/receipt-recover', { method: 'POST',
      body: JSON.stringify({ requestId, username, password }) }), current);
  }
  private identityReceipt(value: unknown, current: () => boolean) {
    const r = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    if (typeof r.accountId !== 'string' || typeof r.principalId !== 'string' ||
        r.duplicate !== false || typeof r.csrf !== 'string')
      throw new WebLocalProtocolError('invalid identity receipt');
    requireCurrent(current);
    this.setCsrf(r.csrf);
    return { accountId: r.accountId, principalId: r.principalId };
  }
}
