import { CharacterAdminClient } from "./character-admin-api.js";
import { isReviewModelId, parseReviewModelView, } from "../../../../packages/contracts/review-model.js";
import { cocreationPointsOk } from "../../../../packages/contracts/cocreation-cards.js";
import { CastAdminClient } from "./cast-admin-api.js";
import { ProfileImportClient } from "./profile-import-api.js";
import { CocreationAdminClient } from "./cocreation-admin-api.js";
import { ConversationsAdminClient } from "./conversations-admin-api.js";
import { PreviewAdminClient } from "./preview-admin-api.js";
import { InviteAdminApi } from "./invite-admin-api.js";
import { InviteLocalApiError } from "./invite-local-api.js";
import { parseModelAdminView, } from "../../../../packages/contracts/model-settings.js";
import { ADMIN_PERMISSION_LIMIT, isAdminPermission, } from "../../../../packages/contracts/web-admin-permissions.js";
const invalid = () => new Error('WEB_INVITE_ADMIN_PROTOCOL_INVALID');
function object(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw invalid();
    return value;
}
function string(value) {
    if (typeof value !== 'string')
        throw invalid();
    return value;
}
function time(value) {
    if (!Number.isSafeInteger(value) || value < 0)
        throw invalid();
    return value;
}
function member(value) {
    const row = object(value), role = row.role, permissions = row.permissions;
    if (!['owner', 'admin'].includes(role) ||
        !(row.email === null || typeof row.email === 'string') ||
        !Array.isArray(permissions) ||
        permissions.length > ADMIN_PERMISSION_LIMIT ||
        new Set(permissions).size !== permissions.length ||
        !permissions.every(isAdminPermission))
        throw invalid();
    return {
        id: string(row.id),
        label: string(row.label),
        role: role,
        email: row.email,
        createdAt: time(row.createdAt),
        ...(row.lastSignInAt === undefined
            ? {}
            : { lastSignInAt: row.lastSignInAt === null ? null : time(row.lastSignInAt) }),
        permissions: permissions,
    };
}
function challenge(value) {
    const row = object(value);
    return { challengeId: string(row.challengeId), expiresAt: time(row.expiresAt) };
}
function parseCocreationPoints(value) {
    const row = object(value);
    const { revision, ...numbers } = row;
    if (!Number.isSafeInteger(revision) || !cocreationPointsOk(numbers))
        throw invalid();
    return { ...numbers, revision: revision };
}
export class AccountAdminApi extends InviteAdminApi {
    characters = new CharacterAdminClient((path, body) => this.request('/characters/' + path, body));
    previews = new PreviewAdminClient((path, body) => this.request('/characters/' + path, body), (path, body) => this.request('/eval-sets/' + path, body), (path, body) => this.request('/review-compare/' + path, body));
    cast = new CastAdminClient((path, body) => this.request('/cast/' + path, body));
    /** Part 24j: 导入角色资料. */
    profileImport = new ProfileImportClient((path, body) => this.request('/profile-import/' + path, body));
    cocreation = new CocreationAdminClient((path, body) => this.request('/cocreation/' + path, body));
    conversations = new ConversationsAdminClient((path, body) => this.request('/conversations/' + path, body));
    constructor(fetcher) {
        super(fetcher, '/api/web/provider/admin');
    }
    /**
     * The admin CSRF token is derived from the session cookie, which the browser shares between tabs. A login, email
     * login or password change in one tab replaces the cookie, and every other open tab then still holds the previous
     * token: its calls (the preview status poller above all) get 403 ADMIN_CSRF_REQUIRED although the session is fine.
     * That check runs before anything is done, so one transparent re-sync and retry is safe. A session that is really
     * gone answers 401 on the re-sync and surfaces as such; any other 403 (a missing permission) is never retried.
     */
    async request(path, body) {
        try {
            return await super.request(path, body);
        }
        catch (error) {
            if (!body ||
                !this.csrf ||
                path === '/login' ||
                !(error instanceof InviteLocalApiError) ||
                error.status !== 403 ||
                error.code !== 'ADMIN_CSRF_REQUIRED')
                throw error;
            const fresh = object(await super.request('/session'));
            if (typeof fresh.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(fresh.csrf))
                throw invalid();
            this.csrf = fresh.csrf;
            return await super.request(path, body);
        }
    }
    active(value) {
        const row = object(value);
        if (typeof row.csrf !== 'string' ||
            !/^[a-f0-9]{64}$/.test(row.csrf) ||
            typeof row.emailDeliveryAvailable !== 'boolean')
            throw invalid();
        const active = {
            csrf: row.csrf,
            expiresAt: time(row.expiresAt),
            member: member(row.member),
            emailDeliveryAvailable: row.emailDeliveryAvailable,
            ...(object(row.features ?? {}).chatReview === true ? { features: { chatReview: true } } : {}),
        };
        this.csrf = active.csrf;
        return active;
    }
    async login(token) {
        this.csrf = null;
        return this.active(await this.request('/login', { token }));
    }
    async restore() {
        this.csrf = null;
        return this.active(await this.request('/session'));
    }
    async emailLogin(email, password) {
        this.csrf = null;
        return this.active(await this.request('/email/login', { email, password }));
    }
    async bindStart(email) {
        return challenge(await this.request('/email/bind/start', { email }));
    }
    async bindFinish(challengeId, code, password) {
        return this.active(await this.request('/email/bind/finish', { challengeId, code, password }));
    }
    async resetStart(email) {
        return challenge(await this.request('/email/reset/start', { email }));
    }
    async resetFinish(challengeId, code, password) {
        if (object(await this.request('/email/reset/finish', { challengeId, code, password })).reset !== true)
            throw invalid();
        this.csrf = null;
    }
    async members() {
        const row = object(await this.request('/members/list', {}));
        if (!Array.isArray(row.members) || !Array.isArray(row.grants))
            throw invalid();
        return {
            members: row.members.map(member),
            grants: row.grants.map((value) => {
                const grant = object(value);
                if (grant.consumed !== 0 && grant.consumed !== 1)
                    throw invalid();
                return {
                    id: string(grant.id),
                    memberId: string(grant.memberId),
                    expiresAt: time(grant.expiresAt),
                    consumed: grant.consumed === 1,
                    revokedAt: grant.revokedAt === null ? null : time(grant.revokedAt),
                };
            }),
        };
    }
    async issueMember(input) {
        const row = object(await this.request('/members/issue', input));
        if (typeof row.duplicate !== 'boolean' ||
            !(row.token === null || (typeof row.token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(row.token))) ||
            row.duplicate !== (row.token === null))
            throw invalid();
        return {
            memberId: string(row.memberId),
            grantId: string(row.grantId),
            token: row.token,
            duplicate: row.duplicate,
        };
    }
    async setPermissions(memberId, permissions, expectedPermissions) {
        return member(object(await this.request('/members/permissions', {
            memberId,
            permissions,
            ...(expectedPermissions === undefined ? {} : { expectedPermissions }),
        })).member);
    }
    async revokeCredential(grantId) {
        if (object(await this.request('/members/revoke-credential', { grantId })).revoked !== true)
            throw invalid();
    }
    /** Owner-only; the server rejects everyone else. Days are newest first. */
    async stageLatency(days = 14) {
        const row = object(await this.request('/metrics/stage-latency', { days }));
        if (!Array.isArray(row.days))
            throw invalid();
        return row.days.map((value) => {
            const day = object(value);
            if (typeof day.day !== 'string' || !Number.isSafeInteger(day.operations))
                throw invalid();
            return day;
        });
    }
    /** 系统 → 模型与价格: any administrator may read. A response that is not exactly the documented shape is rejected. */
    async modelSettings() {
        const view = parseModelAdminView(await this.request('/models/read', {}));
        if (!view)
            throw invalid();
        return view;
    }
    /** Part 26b: the live review model (any administrator may read; saving needs models.manage, the server checks). */
    async reviewModel() {
        const view = parseReviewModelView(await this.request('/models/review-read', {}));
        if (!view)
            throw invalid();
        return view;
    }
    async saveReviewModel(input) {
        const row = object(await this.request('/models/review-save', input));
        if (!Number.isSafeInteger(row.revision) ||
            typeof row.changed !== 'boolean' ||
            typeof row.duplicate !== 'boolean' ||
            !isReviewModelId(row.reviewModel))
            throw invalid();
        return row;
    }
    /** The owner, or an administrator holding models.manage; the server checks again. */
    async saveModelSettings(input) {
        const row = object(await this.request('/models/save', input));
        if (!Number.isSafeInteger(row.revision) ||
            !Number.isSafeInteger(row.priceVersion) ||
            !Number.isSafeInteger(row.changes) ||
            typeof row.duplicate !== 'boolean')
            throw invalid();
        return row;
    }
    /** 概览: any administrator. */
    async overview() {
        const row = object(await this.request('/overview/read', {}));
        object(row.today);
        object(row.warnings);
        if (row.stats !== null && row.stats !== undefined)
            object(row.stats);
        if (typeof row.day !== 'string')
            throw invalid();
        return row;
    }
    /** 系统状态: the owner or system.read. */
    async systemStatus() {
        const row = object(await this.request('/system/status', {}));
        if (!Array.isArray(row.prices) || !Array.isArray(row.metrics) || !Array.isArray(row.unknown))
            throw invalid();
        object(row.version);
        object(row.security);
        object(row.warnings);
        return row;
    }
    /** Owner only. The same renewal the operator command runs. */
    async renewPrices(requestId) {
        const row = object(await this.request('/system/renew-prices', { requestId }));
        if (!Array.isArray(row.rows) || typeof row.duplicate !== 'boolean')
            throw invalid();
        return row;
    }
    /** Owner only: dollars 1–50 for a capped provider. */
    async budgetTopUp(input) {
        const row = object(await this.request('/system/budget-topup', input));
        if (!Number.isSafeInteger(row.allowanceMicros) || typeof row.duplicate !== 'boolean')
            throw invalid();
        return row;
    }
    /** What a grant would do, and the one lookup (an email answers 玩家编号, tier and balance only). */
    async pointsPreview(target, amount) {
        const row = object(await this.request('/points/preview', { target, amount }));
        if (!Number.isSafeInteger(row.granted))
            throw invalid();
        return row;
    }
    async pointsGrant(input) {
        const row = object(await this.request('/points/grant', input));
        if (!Number.isSafeInteger(row.granted) || typeof row.duplicate !== 'boolean')
            throw invalid();
        return row;
    }
    /** Part 24c: the three numbers of points for co-creation notes and their revision (owner or points.grant). */
    async cocreationPoints() {
        return parseCocreationPoints(await this.request('/points/cocreation', {}));
    }
    async saveCocreationPoints(input) {
        return parseCocreationPoints(await this.request('/points/cocreation-save', input));
    }
    /** Owner only. */
    async resetPreview() {
        const row = object(await this.request('/points/reset-preview', {}));
        if (!Number.isSafeInteger(row.affected))
            throw invalid();
        return row;
    }
    /** Owner only. */
    async resetPoints(requestId) {
        const row = object(await this.request('/points/reset', { requestId }));
        if (!Number.isSafeInteger(row.affected) || typeof row.duplicate !== 'boolean')
            throw invalid();
        return row;
    }
    /** 玩家统计 (Part 22c): the owner or stats.read. */
    async playerStats(range) {
        const row = object(await this.request('/stats/players', { range }));
        if (!Array.isArray(row.days) || !Array.isArray(row.byCharacter) || !Array.isArray(row.byModel))
            throw invalid();
        object(row.totals);
        return row;
    }
    /** 导出表格 of the daily table: a CSV (UTF-8 BOM) built by the server, audited there. */
    async exportPlayerStats(range) {
        const row = object(await this.request('/stats/players-export', { range }));
        return { csv: string(row.csv), rows: time(row.rows) };
    }
    /** 消耗表 (Part 22c): the owner or stats.read. */
    async costs(range) {
        const row = object(await this.request('/stats/costs', { range }));
        if (!Array.isArray(row.rows) || !Array.isArray(row.daily) || typeof row.usdCny !== 'number')
            throw invalid();
        object(row.month);
        return row;
    }
    /** 总览 chart (Part 22d): replies or chat users, per character and in total. */
    async chart(metric, range) {
        const row = object(await this.request('/stats/chart', { metric, range }));
        if (!Array.isArray(row.buckets) || !Array.isArray(row.total) || !Array.isArray(row.characters))
            throw invalid();
        return row;
    }
    /** 消耗表 by user type (Part 22d) with the alert line and the real price changes (Part 24b-1). */
    async spendByType(range) {
        const row = object(await this.request('/stats/spend-by-type', { range }));
        if (!Array.isArray(row.days) || !Array.isArray(row.priceChanges) || typeof row.usdCny !== 'number')
            throw invalid();
        return row;
    }
    async exportCosts(range) {
        const row = object(await this.request('/stats/costs-export', { range }));
        return { csv: string(row.csv), rows: time(row.rows) };
    }
    /** The batches, newest first (needs the owner role or invites.manage). */
    async inviteBatches() {
        const row = object(await this.request('/invites/batch-list', {}));
        if (!Array.isArray(row.batches))
            throw invalid();
        return row.batches.map((value) => {
            const b = object(value);
            if (!['unlimited', 'daily_refill'].includes(String(b.tier)))
                throw invalid();
            const optional = (v) => (v === null ? null : time(v));
            return {
                id: string(b.id),
                name: string(b.name),
                tier: b.tier,
                dailyAmount: optional(b.dailyAmount),
                cap: optional(b.cap),
                durationDays: optional(b.durationDays),
                redeemBy: optional(b.redeemBy),
                createdAt: time(b.createdAt),
                codes: time(b.codes),
                redeemed: time(b.redeemed),
                revoked: time(b.revoked),
                holders: time(b.holders),
                ...(b.test === true ? { test: true } : {}),
            };
        });
    }
    async inviteBatchDetail(batchId) {
        const row = object(await this.request('/invites/batch-detail', { batchId }));
        if (!Array.isArray(row.codes))
            throw invalid();
        return row.codes.map((value) => {
            const c = object(value);
            if (!['unused', 'redeemed', 'revoked', 'ended', 'expired'].includes(String(c.state)))
                throw invalid();
            const optional = (v) => (v === null ? null : time(v));
            if (c.codeView !== undefined && !['plain', 'masked', 'legacy'].includes(String(c.codeView)))
                throw invalid();
            const codeView = c.codeView;
            const codeText = c.code === null || c.code === undefined ? null : string(c.code);
            return {
                id: string(c.id),
                serial: time(c.serial),
                state: c.state,
                redeemedAt: optional(c.redeemedAt),
                expiresAt: optional(c.expiresAt),
                playerNumber: c.playerNumber === null ? null : string(c.playerNumber),
                ...(c.codeView === undefined ? {} : { codeView: codeView, code: codeText }),
            };
        });
    }
    /** 导出表格: the batch as a CSV (UTF-8 BOM) under the same masking rule as the detail; the export is audit-logged. */
    async exportInviteBatch(batchId) {
        const row = object(await this.request('/invites/batch-export', { batchId }));
        return { csv: string(row.csv), rows: time(row.rows) };
    }
    /** The codes come back ONCE (a replay of the same requestId answers `codes: null`). */
    async createInviteBatch(input) {
        const row = object(await this.request('/invites/batch-create', input));
        if (typeof row.duplicate !== 'boolean' || !(row.codes === null || Array.isArray(row.codes)))
            throw invalid();
        return {
            batchId: string(row.batchId),
            duplicate: row.duplicate,
            codes: row.codes === null ? null : row.codes.map(string),
        };
    }
    /** Owner only. */
    async editInviteBatch(input) {
        const row = object(await this.request('/invites/batch-edit', input));
        if (typeof row.duplicate !== 'boolean')
            throw invalid();
        return { batchId: string(row.batchId), duplicate: row.duplicate, holders: Number(row.holders ?? 0) };
    }
    async revokeInviteBatch(batchId) {
        const row = object(await this.request('/invites/batch-revoke', { batchId }));
        return { revoked: time(row.revoked) };
    }
    /** One UNREDEEMED code. */
    async revokeTierCode(id) {
        await this.request('/invites/tier-code-revoke', { id });
    }
    /** End a redeemed code's entitlement now. */
    async revokeEntitlement(id) {
        await this.request('/invites/entitlement-revoke', { id });
    }
}
