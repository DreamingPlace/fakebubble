import {
  parseWebInviteCredential,
  parseWebInviteReceipt,
  parseWebInviteRecovery,
  parseWebInviteStatus,
} from '../../../../packages/contracts/web-local-invite.ts';
import {
  parseWebProviderBootstrap,
  type WebProviderActions,
  type WebProviderBootstrap,
  type WebProviderCharacterId,
  type WebProviderHistory,
  type WebProviderOperation,
  type WebProviderSend,
  type WebProviderSync,
} from '../../../../packages/contracts/web-provider.ts';

export class ProviderApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfterMs: number | null;
  constructor(status: number, code: string, retryAfterMs: number | null = null) {
    super(code);
    this.name = 'ProviderApiError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderApiError(0, 'PROTOCOL_INVALID');
  return value as Record<string, unknown>;
};
const operation = (value: unknown): WebProviderOperation => {
  const row = record(value);
  if (
    typeof row.operationId !== 'string' ||
    typeof row.requestId !== 'string' ||
    typeof row.conversationId !== 'string' ||
    typeof row.status !== 'string'
  )
    throw new ProviderApiError(0, 'PROTOCOL_INVALID');
  return row as unknown as WebProviderOperation;
};

/** Same-origin, cookie-authenticated provider-local transport; CSRF stays in memory only. */
export class ProviderApi implements WebProviderActions {
  private csrf = '';
  private readonly fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
  }
  private async request(path: string, init: RequestInit = {}, csrf = this.csrf): Promise<unknown> {
    const response = await this.fetcher(`/api/web/provider${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: init.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {},
    });
    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderApiError(response.status, 'PROTOCOL_INVALID');
    }
    if (!response.ok) {
      const failure = record(payload).error as Record<string, unknown> | undefined;
      const code = failure?.code;
      const retryAfter = failure?.retryAfterMs;
      throw new ProviderApiError(
        response.status,
        typeof code === 'string' ? code : 'INTERNAL_ERROR',
        typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null,
      );
    }
    return payload;
  }
  async bootstrap(): Promise<WebProviderBootstrap> {
    const view = parseWebProviderBootstrap(await this.request('/bootstrap'));
    this.csrf = view.csrf;
    return view;
  }
  async redeemInvite(input: { requestId: string; code: string }) {
    const { duplicate, ...value } = record(
      await this.request('/invites/redeem', { method: 'POST', body: JSON.stringify(input) }),
    );
    try {
      if (typeof duplicate !== 'boolean') throw Error('invalid');
      const receipt = parseWebInviteReceipt(value);
      this.csrf = receipt.csrf;
      return { ...receipt, duplicate };
    } catch {
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    }
  }
  async inviteReceiptStatus(requestId: string) {
    const value = await this.request('/identity/invite-receipt-status', {
      method: 'POST',
      body: JSON.stringify({ requestId }),
    });
    try {
      return parseWebInviteStatus(value);
    } catch {
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    }
  }
  async inviteReceiptChallenge() {
    const value = record(await this.request('/identity/invite-receipt-challenge', { method: 'POST', body: '{}' }));
    if (
      Object.keys(value).join(',') !== 'csrf' ||
      typeof value.csrf !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(value.csrf)
    )
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return value.csrf;
  }
  async recoverInviteReceipt(input: { requestId: string; code: string }, receiptCsrf: string) {
    const value = await this.request(
      '/identity/invite-receipt-recover',
      { method: 'POST', body: JSON.stringify(input) },
      receiptCsrf,
    );
    try {
      const receipt = parseWebInviteReceipt(value);
      this.csrf = receipt.csrf;
      return receipt;
    } catch {
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    }
  }
  /** Replaces the recovery code of the signed-in invited player; the returned code is shown once. */
  async regenerateRecoveryCode() {
    try {
      return parseWebInviteCredential(
        await this.request('/invites/credential-regenerate', { method: 'POST', body: '{}' }),
      ).secret;
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    }
  }
  /** Restores the invited principal behind a recovery code and returns the rotated code. */
  async recoverWithRecoveryCode(input: { secret: string; requestId: string }) {
    try {
      const result = parseWebInviteRecovery(
        await this.request('/invites/recover', {
          method: 'POST',
          body: JSON.stringify({ secret: input.secret, requestId: input.requestId }),
        }),
      );
      this.csrf = result.csrf;
      return result.recoverySecret;
    } catch (error) {
      if (error instanceof ProviderApiError) throw error;
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    }
  }
  async byRequest(requestId: string) {
    return operation(await this.request(`/operations/by-request/${encodeURIComponent(requestId)}`));
  }
  async operation(operationId: string) {
    return operation(await this.request(`/operations/${encodeURIComponent(operationId)}`));
  }
  async waitForOperation(
    initial: WebProviderOperation,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    let current = initial;
    for (let count = 0; !['published', 'failed', 'cancelled', 'unknown'].includes(current.status); count++) {
      await wait(count < 20 ? 500 : 1500);
      current = await this.operation(current.operationId);
    }
    return current;
  }
  async submit(input: WebProviderSend) {
    const receipt = record(
      await this.request(`/characters/${encodeURIComponent(input.characterId)}/operations`, {
        method: 'POST',
        body: JSON.stringify({ requestId: input.requestId, text: input.text, delivery: input.delivery }),
      }),
    );
    return { operation: operation(receipt.operation), duplicate: receipt.duplicate === true };
  }
  async history(input: { characterId: WebProviderCharacterId; conversationId: string; before: string | null }) {
    const page = record(
      await this.request(
        `/conversations/${encodeURIComponent(input.conversationId)}/history${
          input.before ? `?before=${encodeURIComponent(input.before)}` : ''
        }`,
      ),
    );
    if (page.characterId !== input.characterId || !Array.isArray(page.messages))
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return page as unknown as WebProviderHistory;
  }
  async sync(input: { cursor: string | null }) {
    return record(
      await this.request(`/sync${input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : ''}`),
    ) as unknown as WebProviderSync;
  }
  eventUrl(cursor: string) {
    return `/api/web/provider/events?cursor=${encodeURIComponent(cursor)}`;
  }
  async audio(input: {
    characterId: WebProviderCharacterId;
    conversationId: string;
    messageId: string;
    mediaId: string;
  }) {
    const response = await this.fetcher(
      `/api/web/provider/conversations/${encodeURIComponent(input.conversationId)}` +
        `/messages/${encodeURIComponent(input.messageId)}/audio/${encodeURIComponent(input.mediaId)}`,
      { credentials: 'same-origin', cache: 'no-store' },
    );
    if (!response.ok) throw new ProviderApiError(response.status, 'AUDIO_UNAVAILABLE');
    return new Uint8Array(await response.arrayBuffer());
  }
}
