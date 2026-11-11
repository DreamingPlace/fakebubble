import { PLAYER_MODEL_IDS, isPlayerModelId } from "./player-models.js";
/**
 * Owner-controlled reply models and prices (Part 21g, migration 124). The numbers here are only the DEFAULTS the migration
 * writes and the limits the server enforces; the live values are the rows of web_model_settings / web_model_voice, changed on
 * the admin page 系统 → 模型与价格 with no deploy.
 */
/**
 * Who a player is for model purposes. ONE function resolves it (`playerTier` in apps/server/admission/web-model-settings.ts),
 * so Part 22 can split `invited` into unlimited / daily-refill in one place.
 *  - guest:      a trial guest (no signup bonus)
 *  - registered: a signed-up player with points (a guest holding the signup bonus)
 *  - invited:    an active entitlement, or an account
 */
export const MODEL_TIERS = ['guest', 'registered', 'invited'];
export const MODEL_LIMITS = Object.freeze({
    pointsMin: 1,
    pointsMax: 200,
    voiceMin: 0,
    voiceMax: 20,
    /** How many change-log rows the admin page lists. */
    recentChanges: 30,
});
/** Exactly what migration 124 writes, and what the player-facing behaviour was before the table existed. */
export const DEFAULT_MODEL_SETTINGS = Object.freeze({
    models: Object.freeze([
        { model: 'deepseek', enabled: true, guest: true, registered: true, invited: true, points: 10 },
        { model: 'gemini', enabled: true, guest: false, registered: true, invited: true, points: 20 },
        { model: 'xai', enabled: true, guest: false, registered: true, invited: true, points: 25 },
    ]),
    voicePoints: 2,
});
export const tierAllowed = (setting, tier) => setting[tier];
export const SETTING_FIELDS = [
    'enabled',
    'allowed_guest',
    'allowed_registered',
    'allowed_invited',
    'points_per_reply',
    'voice_points',
];
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
/** Strict parse of an admin save: exactly the three models once each, booleans for switches, integers in range. */
export function parseModelSave(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    if (Object.keys(raw).sort().join(',') !== 'expectedRevision,models,requestId,voicePoints')
        return undefined;
    if (typeof raw.requestId !== 'string' || !/^[A-Za-z0-9_.-]{8,64}$/.test(raw.requestId))
        return undefined;
    if (!isInt(raw.expectedRevision, 1, Number.MAX_SAFE_INTEGER))
        return undefined;
    if (!isInt(raw.voicePoints, MODEL_LIMITS.voiceMin, MODEL_LIMITS.voiceMax))
        return undefined;
    if (!Array.isArray(raw.models) || raw.models.length !== PLAYER_MODEL_IDS.length)
        return undefined;
    const byModel = new Map();
    for (const item of raw.models) {
        if (!item || typeof item !== 'object' || Array.isArray(item))
            return undefined;
        const entry = item;
        if (Object.keys(entry).sort().join(',') !== 'enabled,guest,invited,model,points,registered')
            return undefined;
        if (!isPlayerModelId(entry.model) || byModel.has(entry.model))
            return undefined;
        if (typeof entry.enabled !== 'boolean' ||
            typeof entry.guest !== 'boolean' ||
            typeof entry.registered !== 'boolean' ||
            typeof entry.invited !== 'boolean' ||
            !isInt(entry.points, MODEL_LIMITS.pointsMin, MODEL_LIMITS.pointsMax))
            return undefined;
        byModel.set(entry.model, {
            model: entry.model,
            enabled: entry.enabled,
            guest: entry.guest,
            registered: entry.registered,
            invited: entry.invited,
            points: entry.points,
        });
    }
    return {
        requestId: raw.requestId,
        expectedRevision: raw.expectedRevision,
        models: PLAYER_MODEL_IDS.map((id) => byModel.get(id)),
        voicePoints: raw.voicePoints,
    };
}
/**
 * The tiers that would be left with no allowed + enabled model. Pure: used by the server (which refuses the save) and by the
 * page (which says which tier before the request is sent). The environment ceiling is NOT part of this rule: a tier is judged
 * by the table the owner edits, so an unconfigured model does not make the owner's own save impossible.
 */
export function emptyTiers(models) {
    return MODEL_TIERS.filter((tier) => !models.some((m) => m.enabled && tierAllowed(m, tier)));
}
export const MODEL_TIER_LABELS = Object.freeze({
    guest: '游客',
    registered: '注册玩家',
    invited: '受邀玩家',
});
/** Strict parse of the server's admin view (the page rejects anything else rather than guess). */
export function parseModelAdminView(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return undefined;
    const raw = value;
    if (typeof raw.featureOn !== 'boolean' ||
        typeof raw.canManage !== 'boolean' ||
        !isInt(raw.revision, 1, Number.MAX_SAFE_INTEGER) ||
        !isInt(raw.priceVersion, 1, Number.MAX_SAFE_INTEGER) ||
        !isInt(raw.voicePoints, MODEL_LIMITS.voiceMin, MODEL_LIMITS.voiceMax) ||
        !Array.isArray(raw.models) ||
        raw.models.length !== PLAYER_MODEL_IDS.length ||
        !Array.isArray(raw.recent))
        return undefined;
    const models = [];
    for (const item of raw.models) {
        const m = item;
        if (!m ||
            !isPlayerModelId(m.model) ||
            typeof m.enabled !== 'boolean' ||
            typeof m.guest !== 'boolean' ||
            typeof m.registered !== 'boolean' ||
            typeof m.invited !== 'boolean' ||
            typeof m.configured !== 'boolean' ||
            typeof m.label !== 'string' ||
            !isInt(m.points, MODEL_LIMITS.pointsMin, MODEL_LIMITS.pointsMax))
            return undefined;
        models.push({
            model: m.model,
            enabled: m.enabled,
            guest: m.guest,
            registered: m.registered,
            invited: m.invited,
            points: m.points,
            configured: m.configured,
            label: m.label,
        });
    }
    const recent = [];
    for (const item of raw.recent) {
        const c = item;
        if (!c ||
            !isInt(c.at, 0, Number.MAX_SAFE_INTEGER) ||
            typeof c.admin !== 'string' ||
            !SETTING_FIELDS.includes(c.field) ||
            !(c.model === null || isPlayerModelId(c.model)) ||
            !isInt(c.from, 0, Number.MAX_SAFE_INTEGER) ||
            !isInt(c.to, 0, Number.MAX_SAFE_INTEGER))
            return undefined;
        recent.push({
            at: c.at,
            admin: c.admin,
            model: c.model,
            field: c.field,
            from: c.from,
            to: c.to,
        });
    }
    return {
        featureOn: raw.featureOn,
        revision: raw.revision,
        priceVersion: raw.priceVersion,
        models,
        voicePoints: raw.voicePoints,
        canManage: raw.canManage,
        recent,
    };
}
