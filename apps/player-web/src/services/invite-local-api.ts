import {
  parseWebInviteAccess,
  parseWebInviteBootstrap,
  parseWebInviteCredential,
  parseWebInviteReceipt,
  parseWebInviteRecovery,
  parseWebInviteStatus,
} from '../../../../packages/contracts/web-local-invite.ts';

export class InviteLocalApiError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'InviteLocalApiError';
    this.status = status;
    this.code = code;
  }
}

/** Opt-in local-3 candidate. Never persists a code, recovery proof, bearer or CSRF. */
export class InviteLocalApi {
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
  }

  private async response(response: Response) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error('WEB_INVITE_PROTOCOL_INVALID');
    }
    if (!response.ok) {
      const error =
        payload && typeof payload === 'object' ? (payload as { error?: { code?: unknown } }).error?.code : null;
      throw new InviteLocalApiError(response.status, typeof error === 'string' ? error : 'WEB_INVITE_REQUEST_FAILED');
    }
    return payload;
  }

  async bootstrap() {
    return parseWebInviteBootstrap(
      await this.response(
        await this.fetcher('/api/web/local/bootstrap', { credentials: 'same-origin', cache: 'no-store' }),
      ),
    );
  }
  async access() {
    return parseWebInviteAccess(
      await this.response(
        await this.fetcher('/api/web/local/access', { credentials: 'same-origin', cache: 'no-store' }),
      ),
    );
  }

  private async post(path: string, body: Record<string, unknown>, csrf?: string) {
    const response = await this.fetcher(`/api/web/local${path}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      body: JSON.stringify(body),
    });
    return this.response(response);
  }

  async redeem(code: string, requestId: string, csrf: string) {
    return parseWebInviteReceipt(await this.post('/invites/redeem', { code, requestId }, csrf));
  }
  async receiptChallenge() {
    const value = await this.post('/identity/invite-receipt-challenge', {});
    const csrf = value && typeof value === 'object' ? (value as { csrf?: unknown }).csrf : null;
    if (typeof csrf !== 'string') throw new Error('WEB_INVITE_PROTOCOL_INVALID');
    return csrf;
  }
  async recoverRedemption(code: string, requestId: string, receiptCsrf: string) {
    return parseWebInviteReceipt(await this.post('/identity/invite-receipt-recover', { code, requestId }, receiptCsrf));
  }
  async receiptStatus(requestId: string, csrf: string) {
    return parseWebInviteStatus(await this.post('/identity/invite-receipt-status', { requestId }, csrf));
  }
  async createRecoveryCredential(csrf: string) {
    return parseWebInviteCredential(await this.post('/invites/credential', {}, csrf));
  }
  async recoverWithCredential(secret: string, requestId: string) {
    return parseWebInviteRecovery(await this.post('/invites/recover', { secret, requestId }));
  }
}
