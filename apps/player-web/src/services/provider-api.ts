import {
  parseModelChoice,
  parsePlan,
  type ModelChoiceInfo,
  type PlayerPlan,
  type PlayerModelId,
} from '../../../../packages/contracts/player-models.ts';
import type { CocreationAnswer } from '../../../../packages/contracts/cocreation-cards.ts';
import { parseBillingPage, type BillingPage } from '../../../../packages/contracts/player-billing.ts';
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

/** What the page knows about the player's account (GET /account). Signed-out pages only learn whether signup is open. */
export type AccountFeatures = {
  /** 删除我的账号 / 清除本设备的体验数据 are available. */
  accountDelete?: true;
  /** The two legal pages are published. */
  legal?: true;
  /** Cloudflare Turnstile is on: the public site key. */
  turnstileSiteKey?: string;
  /** Signup stays open for 7 days after a trial ended. */
  grace?: true;
  /** Signing up gives this many free replies (any character, no time window). */
  signupBonus?: number;
  /** Administrators may read chats under an anonymous code while testing: the one-time banner applies. */
  chatReview?: true;
};
export type AccountTier = {
  kind: 'guest' | 'registered' | 'unlimited' | 'daily_refill' | 'account';
  unlimited: boolean;
  plan?: PlayerPlan;
};
export type AccountInfo =
  | { signupEnabled: boolean; signedIn: false; features?: AccountFeatures }
  | {
      signupEnabled: boolean;
      signedIn: true;
      kind: string;
      hasLogin: boolean;
      emailMasked: string | null;
      nickname: string | null;
      features?: AccountFeatures;
      /** The player closed the one-time review banner (only present while chatReview is on). */
      reviewNoticeClosed?: boolean;
      /** A guest past its trial and inside the grace period: signup is still possible until endsAt (ms). */
      grace?: { endsAt: number };
      /** PLAYER_MODEL_CHOICE_ENABLED and a points account: the model picker state. Absent for everyone else. */
      modelChoice?: ModelChoiceInfo;
      /** Part 22a: the 玩家编号 of a registered player (8 characters, Crockford base32). */
      playerNumber?: string;
      /** Part 22a: the EFFECTIVE tier from the server (effectiveTier). The page never derives a tier from `kind`. */
      tier?: AccountTier;
    };
/** The bot check: resolves one fresh Turnstile token for an action, or throws. Installed only on the real page. */
export type HumanCheck = (siteKey: string, action: 'guest' | 'code' | 'login') => Promise<string>;
const humanAction = (path: string) =>
  path === '/bootstrap'
    ? 'guest'
    : path === '/account/request-code'
      ? 'code'
      : path === '/account/login'
        ? 'login'
        : null;

const TIER_KINDS = ['guest', 'registered', 'unlimited', 'daily_refill', 'account'] as const;
function parseTier(value: unknown): AccountTier | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!(TIER_KINDS as readonly unknown[]).includes(raw.kind) || typeof raw.unlimited !== 'boolean') return undefined;
  const plan = raw.plan === undefined ? undefined : parsePlan(raw.plan);
  return { kind: raw.kind as AccountTier['kind'], unlimited: raw.unlimited, ...(plan ? { plan } : {}) };
}
function parseFeatures(value: unknown): AccountFeatures | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const features: AccountFeatures = {
    ...(raw.accountDelete === true ? { accountDelete: true as const } : {}),
    ...(raw.legal === true ? { legal: true as const } : {}),
    ...(raw.grace === true ? { grace: true as const } : {}),
    ...(raw.chatReview === true ? { chatReview: true as const } : {}),
    ...(Number.isSafeInteger(raw.signupBonus) && (raw.signupBonus as number) > 0 && (raw.signupBonus as number) <= 1000
      ? { signupBonus: raw.signupBonus as number }
      : {}),
    ...(typeof raw.turnstileSiteKey === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(raw.turnstileSiteKey)
      ? { turnstileSiteKey: raw.turnstileSiteKey }
      : {}),
  };
  return Object.keys(features).length ? features : undefined;
}
export type EmailPurpose = 'signup' | 'reset';
export type CodeChallenge = { challengeId: string; expiresAt: number; resendAfterMs: number };

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
  private human: HumanCheck | null = null;
  private siteKey: string | null = null;
  constructor(fetcher: typeof fetch = (input, init) => fetch(input, init)) {
    this.fetcher = fetcher;
  }
  /** Turnstile (only when the server asks for it): the page installs the widget-backed check once. */
  setHumanCheck(check: HumanCheck | null) {
    this.human = check;
  }
  /**
   * With Turnstile on, the server answers a new guest, a code request and a login without a token with
   * TURNSTILE_REQUIRED. The page then gets a token (no click in the normal case) and repeats the SAME request once.
   */
  private async request(path: string, init: RequestInit = {}, csrf = this.csrf): Promise<unknown> {
    try {
      return await this.send(path, init, csrf);
    } catch (error) {
      const action = humanAction(path);
      if (!(error instanceof ProviderApiError) || error.code !== 'TURNSTILE_REQUIRED' || !action || !this.human)
        throw error;
      let token: string;
      try {
        const siteKey = (this.siteKey ??= (await this.account()).features?.turnstileSiteKey ?? null);
        if (!siteKey) throw error;
        token = await this.human(siteKey, action);
      } catch (failure) {
        if (failure === error) throw error;
        throw new ProviderApiError(0, 'TURNSTILE_FAILED');
      }
      return this.send(path, init, csrf, token);
    }
  }
  private async send(path: string, init: RequestInit, csrf: string, humanToken?: string): Promise<unknown> {
    const response = await this.fetcher(`/api/web/provider${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
        ...(humanToken ? { 'X-Turnstile-Token': humanToken } : {}),
      },
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
  /** A signed-in player's code adds an ENTITLEMENT: no new session, no receipt. Idempotent on requestId. */
  async redeemInvite(input: { requestId: string; code: string }) {
    const raw = record(await this.request('/invites/redeem', { method: 'POST', body: JSON.stringify(input) }));
    if (!raw.entitlement || typeof raw.entitlement !== 'object' || typeof raw.duplicate !== 'boolean')
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return { entitlement: parsePlan(raw.entitlement), duplicate: raw.duplicate };
  }
  /** A player's ideas for one official character; idempotent on requestId, so an uncertain send is retried as is. */
  async submitCocreation(input: { characterId: string; requestId: string; answers: CocreationAnswer[] }) {
    const value = record(
      await this.request('/cocreation/submit', {
        method: 'POST',
        body: JSON.stringify({ characterId: input.characterId, requestId: input.requestId, answers: input.answers }),
      }),
    );
    if (
      typeof value.submissionId !== 'string' ||
      !Number.isSafeInteger(value.answered) ||
      typeof value.duplicate !== 'boolean'
    )
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return { submissionId: value.submissionId, answered: value.answered as number, duplicate: value.duplicate };
  }
  /** Which cards has this player already answered today for this character (one per card per UTC day)? */
  async cocreationToday(characterId: string): Promise<{ cardIds: string[] }> {
    const value = record(
      await this.request('/cocreation/today', { method: 'POST', body: JSON.stringify({ characterId }) }),
    );
    if (!Array.isArray(value.cardIds) || !value.cardIds.every((id) => typeof id === 'string'))
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return { cardIds: value.cardIds as string[] };
  }
  /** 消费记录: one page (50 rows, newest first, last 90 days) of this player's own spending. */
  async billing(page: number): Promise<BillingPage> {
    const tzOffsetMinutes = -new Date().getTimezoneOffset();
    const parsed = parseBillingPage(
      await this.request('/billing/history', { method: 'POST', body: JSON.stringify({ page, tzOffsetMinutes }) }),
    );
    if (!parsed) throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return parsed;
  }
  /** Signup / reset step 1: ask for the emailed code. The answer is the same for registered and unknown addresses. */
  async requestEmailCode(input: { purpose: EmailPurpose; email: string }): Promise<CodeChallenge> {
    const value = record(await this.request('/account/request-code', { method: 'POST', body: JSON.stringify(input) }));
    if (
      typeof value.challengeId !== 'string' ||
      !Number.isSafeInteger(value.expiresAt) ||
      !Number.isSafeInteger(value.resendAfterMs)
    )
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return value as unknown as CodeChallenge;
  }
  async verifyEmailCode(input: { challengeId: string; code: string }) {
    await this.request('/account/verify-code', { method: 'POST', body: JSON.stringify(input) });
  }
  /** Step 3 for a guest (注册): password + nickname after a verified code. */
  async finishAccount(input: {
    purpose: 'signup';
    challengeId: string;
    password: string;
    nickname: string;
    /** The signup sheet's 我已年满 18 周岁 tick (LEGAL_PAGES_ENABLED); sent for a signup only, never stored. */
    adult?: boolean;
  }) {
    const value = record(
      await this.request(`/account/${input.purpose}`, {
        method: 'POST',
        body: JSON.stringify({
          challengeId: input.challengeId,
          password: input.password,
          nickname: input.nickname,
          ...(input.adult === undefined ? {} : { adult: input.adult }),
        }),
      }),
    );
    if (typeof value.nickname !== 'string' || typeof value.emailMasked !== 'string')
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return {
      nickname: value.nickname,
      emailMasked: value.emailMasked,
      ...(Number.isSafeInteger(value.bonus) ? { bonus: value.bonus as number } : {}),
    };
  }
  /** A new session for that login's principal. Other sessions are untouched. */
  async login(input: { email: string; password: string }) {
    const value = record(await this.request('/account/login', { method: 'POST', body: JSON.stringify(input) }));
    if (typeof value.csrf !== 'string') throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    this.csrf = value.csrf;
  }
  async resetPassword(input: { challengeId: string; password: string }) {
    const value = record(await this.request('/account/reset', { method: 'POST', body: JSON.stringify(input) }));
    if (typeof value.csrf !== 'string') throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    this.csrf = value.csrf;
  }
  async changePassword(input: { current: string; next: string; logoutOthers: boolean }) {
    await this.request('/account/password', { method: 'POST', body: JSON.stringify(input) });
  }
  async setNickname(nickname: string) {
    await this.request('/account/nickname', { method: 'POST', body: JSON.stringify({ nickname }) });
  }
  /** 删除我的账号 (password + the word 删除) or, for a guest without a login, 清除本设备的体验数据 (password '', word 清除). */
  async deleteAccount(input: { password: string; confirm: string }) {
    const value = record(await this.request('/account/delete', { method: 'POST', body: JSON.stringify(input) }));
    if (value.deleted !== true) throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    this.csrf = '';
  }
  /** The × on the one-time review banner; remembered for this player on the server. */
  async closeReviewNotice() {
    await this.request('/account/review-notice-close', { method: 'POST', body: '{}' });
  }
  /** 选择写回复的模型. Affects the next message only; answers with the picker state (new price, balance). */
  async setModel(model: PlayerModelId): Promise<ModelChoiceInfo> {
    const value = record(await this.request('/account/model', { method: 'POST', body: JSON.stringify({ model }) }));
    const choice = parseModelChoice(value.modelChoice);
    if (!choice) throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return choice;
  }
  async logoutOthers() {
    await this.request('/account/logout-others', { method: 'POST', body: '{}' });
  }
  async logout() {
    await this.request('/account/logout', { method: 'POST', body: '{}' });
  }
  /** Only the browser forgets its cookie (nothing is revoked): the next visit starts from the first page. */
  async abandonSession() {
    await this.request('/account/signed-out', { method: 'POST', body: '{}' });
  }
  async account(): Promise<AccountInfo> {
    const value = record(await this.request('/account'));
    if (typeof value.signupEnabled !== 'boolean' || typeof value.signedIn !== 'boolean')
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    const features = parseFeatures(value.features);
    if (!value.signedIn)
      return { signupEnabled: value.signupEnabled, signedIn: false, ...(features ? { features } : {}) };
    if (typeof value.hasLogin !== 'boolean' || typeof value.kind !== 'string')
      throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return {
      signupEnabled: value.signupEnabled,
      signedIn: true,
      kind: value.kind,
      hasLogin: value.hasLogin,
      emailMasked: typeof value.emailMasked === 'string' ? value.emailMasked : null,
      nickname: typeof value.nickname === 'string' ? value.nickname : null,
      ...(features ? { features } : {}),
      ...(typeof value.reviewNoticeClosed === 'boolean' ? { reviewNoticeClosed: value.reviewNoticeClosed } : {}),
      ...(parseModelChoice(value.modelChoice) ? { modelChoice: parseModelChoice(value.modelChoice)! } : {}),
      ...(parseTier(value.tier) ? { tier: parseTier(value.tier)! } : {}),
      ...(typeof value.playerNumber === 'string' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(value.playerNumber)
        ? { playerNumber: value.playerNumber }
        : {}),
      ...(value.grace &&
      typeof value.grace === 'object' &&
      Number.isSafeInteger((value.grace as { endsAt?: unknown }).endsAt)
        ? { grace: { endsAt: (value.grace as { endsAt: number }).endsAt } }
        : {}),
    };
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
