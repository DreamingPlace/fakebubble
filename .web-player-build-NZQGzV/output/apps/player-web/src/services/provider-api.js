import { parseModelChoice, parsePlan, } from "../../../../packages/contracts/player-models.js";
import { cocreationPointsOk, } from "../../../../packages/contracts/cocreation-cards.js";
import { parseBillingPage } from "../../../../packages/contracts/player-billing.js";
import { parseWebProviderBootstrap, } from "../../../../packages/contracts/web-provider.js";
export class ProviderApiError extends Error {
    status;
    code;
    retryAfterMs;
    constructor(status, code, retryAfterMs = null) {
        super(code);
        this.name = 'ProviderApiError';
        this.status = status;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}
const humanAction = (path) => path === '/bootstrap'
    ? 'guest'
    : path === '/account/request-code'
        ? 'code'
        : path === '/account/login'
            ? 'login'
            : null;
const TIER_KINDS = ['guest', 'registered', 'unlimited', 'daily_refill', 'account'];
function parseTier(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    if (!TIER_KINDS.includes(raw.kind) || typeof raw.unlimited !== 'boolean')
        return undefined;
    const plan = raw.plan === undefined ? undefined : parsePlan(raw.plan);
    return { kind: raw.kind, unlimited: raw.unlimited, ...(plan ? { plan } : {}) };
}
function parseFeatures(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    const features = {
        ...(raw.accountDelete === true ? { accountDelete: true } : {}),
        ...(raw.legal === true ? { legal: true } : {}),
        ...(raw.grace === true ? { grace: true } : {}),
        ...(raw.chatReview === true ? { chatReview: true } : {}),
        ...(Number.isSafeInteger(raw.signupBonus) && raw.signupBonus > 0 && raw.signupBonus <= 1000
            ? { signupBonus: raw.signupBonus }
            : {}),
        ...(typeof raw.turnstileSiteKey === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(raw.turnstileSiteKey)
            ? { turnstileSiteKey: raw.turnstileSiteKey }
            : {}),
    };
    return Object.keys(features).length ? features : undefined;
}
const record = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return value;
};
const operation = (value) => {
    const row = record(value);
    if (typeof row.operationId !== 'string' ||
        typeof row.requestId !== 'string' ||
        typeof row.conversationId !== 'string' ||
        typeof row.status !== 'string')
        throw new ProviderApiError(0, 'PROTOCOL_INVALID');
    return row;
};
/** Same-origin, cookie-authenticated provider-local transport; CSRF stays in memory only. */
export class ProviderApi {
    csrf = '';
    fetcher;
    human = null;
    siteKey = null;
    constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher;
    }
    /** Turnstile (only when the server asks for it): the page installs the widget-backed check once. */
    setHumanCheck(check) {
        this.human = check;
    }
    /**
     * With Turnstile on, the server answers a new guest, a code request and a login without a token with
     * TURNSTILE_REQUIRED. The page then gets a token (no click in the normal case) and repeats the SAME request once.
     */
    async request(path, init = {}, csrf = this.csrf) {
        try {
            return await this.send(path, init, csrf);
        }
        catch (error) {
            const action = humanAction(path);
            if (!(error instanceof ProviderApiError) || error.code !== 'TURNSTILE_REQUIRED' || !action || !this.human)
                throw error;
            let token;
            try {
                const siteKey = (this.siteKey ??= (await this.account()).features?.turnstileSiteKey ?? null);
                if (!siteKey)
                    throw error;
                token = await this.human(siteKey, action);
            }
            catch (failure) {
                if (failure === error)
                    throw error;
                throw new ProviderApiError(0, 'TURNSTILE_FAILED');
            }
            return this.send(path, init, csrf, token);
        }
    }
    async send(path, init, csrf, humanToken) {
        const response = await this.fetcher(`/api/web/provider${path}`, {
            ...init,
            credentials: 'same-origin',
            cache: 'no-store',
            headers: {
                ...(init.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}),
                ...(humanToken ? { 'X-Turnstile-Token': humanToken } : {}),
            },
        });
        let payload = null;
        try {
            payload = await response.json();
        }
        catch {
            throw new ProviderApiError(response.status, 'PROTOCOL_INVALID');
        }
        if (!response.ok) {
            const failure = record(payload).error;
            const code = failure?.code;
            const retryAfter = failure?.retryAfterMs;
            throw new ProviderApiError(response.status, typeof code === 'string' ? code : 'INTERNAL_ERROR', typeof retryAfter === 'number' && Number.isFinite(retryAfter) ? retryAfter : null);
        }
        return payload;
    }
    async bootstrap() {
        const view = parseWebProviderBootstrap(await this.request('/bootstrap'));
        this.csrf = view.csrf;
        return view;
    }
    /** A signed-in player's code adds an ENTITLEMENT: no new session, no receipt. Idempotent on requestId. */
    async redeemInvite(input) {
        const raw = record(await this.request('/invites/redeem', { method: 'POST', body: JSON.stringify(input) }));
        if (!raw.entitlement || typeof raw.entitlement !== 'object' || typeof raw.duplicate !== 'boolean')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return { entitlement: parsePlan(raw.entitlement), duplicate: raw.duplicate };
    }
    /** A player's ideas for one official character; idempotent on requestId, so an uncertain send is retried as is. */
    async submitCocreation(input) {
        const value = record(await this.request('/cocreation/submit', {
            method: 'POST',
            body: JSON.stringify({ characterId: input.characterId, requestId: input.requestId, answers: input.answers }),
        }));
        if (typeof value.submissionId !== 'string' ||
            !Number.isSafeInteger(value.answered) ||
            typeof value.duplicate !== 'boolean')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return {
            submissionId: value.submissionId,
            answered: value.answered,
            duplicate: value.duplicate,
            ...(Number.isSafeInteger(value.earned) ? { earned: value.earned } : {}),
        };
    }
    /** Part 24c: 给制作组的留言条. Never rewarded. Idempotent on requestId. */
    async submitMemo(input) {
        return this.noteResult(await this.request('/cocreation/memo', {
            method: 'POST',
            body: JSON.stringify({ requestId: input.requestId, text: input.text }),
        }));
    }
    /** Part 24c: the story between two characters. Idempotent on requestId. */
    async submitPair(input) {
        return this.noteResult(await this.request('/cocreation/pair', {
            method: 'POST',
            body: JSON.stringify({
                requestId: input.requestId,
                characterId: input.characterId,
                partnerId: input.partnerId,
                text: input.text,
            }),
        }));
    }
    noteResult(raw) {
        const value = record(raw);
        if (typeof value.submissionId !== 'string' || typeof value.duplicate !== 'boolean')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return {
            submissionId: value.submissionId,
            duplicate: value.duplicate,
            ...(Number.isSafeInteger(value.earned) ? { earned: value.earned } : {}),
        };
    }
    /** Part 24c: the live numbers of points for notes (the 获得点数 sheet). */
    async cocreationRewards() {
        const value = record(await this.request('/cocreation/rewards', { method: 'POST', body: JSON.stringify({}) }));
        if (!cocreationPointsOk(value))
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return { notePoints: value.notePoints, dailyCap: value.dailyCap, adoptPoints: value.adoptPoints };
    }
    /** Which cards has this player already answered today for this character (one per card per UTC day)? */
    async cocreationToday(characterId) {
        const value = record(await this.request('/cocreation/today', { method: 'POST', body: JSON.stringify({ characterId }) }));
        if (!Array.isArray(value.cardIds) || !value.cardIds.every((id) => typeof id === 'string'))
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return { cardIds: value.cardIds };
    }
    /** 消费记录: one page (50 rows, newest first, last 90 days) of this player's own spending. */
    async billing(page) {
        const tzOffsetMinutes = -new Date().getTimezoneOffset();
        const parsed = parseBillingPage(await this.request('/billing/history', { method: 'POST', body: JSON.stringify({ page, tzOffsetMinutes }) }));
        if (!parsed)
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return parsed;
    }
    /** Signup / reset step 1: ask for the emailed code. The answer is the same for registered and unknown addresses. */
    async requestEmailCode(input) {
        const value = record(await this.request('/account/request-code', { method: 'POST', body: JSON.stringify(input) }));
        if (typeof value.challengeId !== 'string' ||
            !Number.isSafeInteger(value.expiresAt) ||
            !Number.isSafeInteger(value.resendAfterMs))
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return value;
    }
    async verifyEmailCode(input) {
        await this.request('/account/verify-code', { method: 'POST', body: JSON.stringify(input) });
    }
    /** Step 3 for a guest (注册): password + nickname after a verified code. */
    async finishAccount(input) {
        const value = record(await this.request(`/account/${input.purpose}`, {
            method: 'POST',
            body: JSON.stringify({
                challengeId: input.challengeId,
                password: input.password,
                nickname: input.nickname,
                ...(input.adult === undefined ? {} : { adult: input.adult }),
            }),
        }));
        if (typeof value.nickname !== 'string' || typeof value.emailMasked !== 'string')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return {
            nickname: value.nickname,
            emailMasked: value.emailMasked,
            ...(Number.isSafeInteger(value.bonus) ? { bonus: value.bonus } : {}),
        };
    }
    /** A new session for that login's principal. Other sessions are untouched. */
    async login(input) {
        const value = record(await this.request('/account/login', { method: 'POST', body: JSON.stringify(input) }));
        if (typeof value.csrf !== 'string')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        this.csrf = value.csrf;
    }
    async resetPassword(input) {
        const value = record(await this.request('/account/reset', { method: 'POST', body: JSON.stringify(input) }));
        if (typeof value.csrf !== 'string')
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        this.csrf = value.csrf;
    }
    async changePassword(input) {
        await this.request('/account/password', { method: 'POST', body: JSON.stringify(input) });
    }
    async setNickname(nickname) {
        await this.request('/account/nickname', { method: 'POST', body: JSON.stringify({ nickname }) });
    }
    /** 删除我的账号 (password + the word 删除) or, for a guest without a login, 清除本设备的体验数据 (password '', word 清除). */
    async deleteAccount(input) {
        const value = record(await this.request('/account/delete', { method: 'POST', body: JSON.stringify(input) }));
        if (value.deleted !== true)
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        this.csrf = '';
    }
    /** The × on the one-time review banner; remembered for this player on the server. */
    async closeReviewNotice() {
        await this.request('/account/review-notice-close', { method: 'POST', body: '{}' });
    }
    /** 选择写回复的模型. Affects the next message only; answers with the picker state (new price, balance). */
    async setModel(model) {
        const value = record(await this.request('/account/model', { method: 'POST', body: JSON.stringify({ model }) }));
        const choice = parseModelChoice(value.modelChoice);
        if (!choice)
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
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
    async account() {
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
            ...(parseModelChoice(value.modelChoice) ? { modelChoice: parseModelChoice(value.modelChoice) } : {}),
            ...(parseTier(value.tier) ? { tier: parseTier(value.tier) } : {}),
            ...(typeof value.playerNumber === 'string' && /^[0-9A-HJKMNP-TV-Z]{8}$/.test(value.playerNumber)
                ? { playerNumber: value.playerNumber }
                : {}),
            ...(value.grace &&
                typeof value.grace === 'object' &&
                Number.isSafeInteger(value.grace.endsAt)
                ? { grace: { endsAt: value.grace.endsAt } }
                : {}),
        };
    }
    async byRequest(requestId) {
        return operation(await this.request(`/operations/by-request/${encodeURIComponent(requestId)}`));
    }
    async operation(operationId) {
        return operation(await this.request(`/operations/${encodeURIComponent(operationId)}`));
    }
    async waitForOperation(initial, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
        let current = initial;
        for (let count = 0; !['published', 'failed', 'cancelled', 'unknown'].includes(current.status); count++) {
            await wait(count < 20 ? 500 : 1500);
            current = await this.operation(current.operationId);
        }
        return current;
    }
    async submit(input) {
        const receipt = record(await this.request(`/characters/${encodeURIComponent(input.characterId)}/operations`, {
            method: 'POST',
            body: JSON.stringify({ requestId: input.requestId, text: input.text, delivery: input.delivery }),
        }));
        return { operation: operation(receipt.operation), duplicate: receipt.duplicate === true };
    }
    async history(input) {
        const page = record(await this.request(`/conversations/${encodeURIComponent(input.conversationId)}/history${input.before ? `?before=${encodeURIComponent(input.before)}` : ''}`));
        if (page.characterId !== input.characterId || !Array.isArray(page.messages))
            throw new ProviderApiError(0, 'PROTOCOL_INVALID');
        return page;
    }
    async sync(input) {
        return record(await this.request(`/sync${input.cursor ? `?cursor=${encodeURIComponent(input.cursor)}` : ''}`));
    }
    eventUrl(cursor) {
        return `/api/web/provider/events?cursor=${encodeURIComponent(cursor)}`;
    }
    async audio(input) {
        const response = await this.fetcher(`/api/web/provider/conversations/${encodeURIComponent(input.conversationId)}` +
            `/messages/${encodeURIComponent(input.messageId)}/audio/${encodeURIComponent(input.mediaId)}`, { credentials: 'same-origin', cache: 'no-store' });
        if (!response.ok)
            throw new ProviderApiError(response.status, 'AUDIO_UNAVAILABLE');
        return new Uint8Array(await response.arrayBuffer());
    }
}
