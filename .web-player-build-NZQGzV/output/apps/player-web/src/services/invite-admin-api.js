import { InviteLocalApiError } from "./invite-local-api.js";
const safeTime = (value) => Number.isSafeInteger(value) && value >= 0;
function session(value) {
    const row = value && typeof value === 'object' ? value : {};
    if (typeof row.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(row.csrf) || !safeTime(row.expiresAt))
        throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
    return { csrf: row.csrf, expiresAt: row.expiresAt };
}
/** Same-origin administrator transport (the base of AccountAdminApi); grant and CSRF remain memory-only. */
export class InviteAdminApi {
    fetcher;
    csrf = null;
    base;
    constructor(fetcher = (input, init) => fetch(input, init), base = '/api/web/local/admin') {
        this.fetcher = fetcher;
        this.base = base;
    }
    async request(path, body) {
        let response;
        try {
            response = await this.fetcher(`${this.base}${path}`, {
                method: body ? 'POST' : 'GET',
                credentials: 'same-origin',
                cache: 'no-store',
                // Cloudflare Access answers a browser without its cookie with a cross-origin redirect to its login page.
                redirect: 'manual',
                ...(body
                    ? {
                        headers: { 'Content-Type': 'application/json', ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}) },
                        body: JSON.stringify(body),
                    }
                    : {}),
            });
        }
        catch (error) {
            // A followed Access redirect fails as a CORS TypeError; either way the browser must pass Access first.
            if (error instanceof TypeError)
                throw new InviteLocalApiError(0, 'ACCESS_REQUIRED');
            throw error;
        }
        if (response.type === 'opaqueredirect')
            throw new InviteLocalApiError(0, 'ACCESS_REQUIRED');
        let value;
        try {
            value = await response.json();
        }
        catch {
            throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
        }
        if (!response.ok) {
            if (response.status === 401)
                this.csrf = null;
            const error = value && typeof value === 'object' ? value.error?.code : null;
            throw new InviteLocalApiError(response.status, typeof error === 'string' ? error : 'WEB_INVITE_ADMIN_REQUEST_FAILED', value && typeof value === 'object' ? value.error?.detail : undefined);
        }
        return value;
    }
    async login(token) {
        this.csrf = null;
        const active = session(await this.request('/login', { token }));
        this.csrf = active.csrf;
        return active;
    }
    /** Restores the CSRF from an existing same-origin HttpOnly admin session cookie. */
    async restore() {
        const active = session(await this.request('/session'));
        this.csrf = active.csrf;
        return active;
    }
    async logout() {
        if (!this.csrf)
            throw new Error('WEB_INVITE_ADMIN_SESSION_REQUIRED');
        try {
            const value = await this.request('/logout', {});
            if (!value || typeof value !== 'object' || value.loggedOut !== true)
                throw new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
        }
        finally {
            this.csrf = null;
        }
    }
}
