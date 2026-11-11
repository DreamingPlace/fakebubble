/**
 * Part 26b: the review model (审核模型). The reviewer is the second text stage of every reply: it audits the draft, rewrites it
 * when needed, and writes the memory (topics, factOps, scene and relationship events). The owner chooses between two DeepSeek
 * models on 系统 → 模型与价格; the default is today's behaviour.
 *
 * Sources (checked 2026-11-04, docs/PROVIDERS.md): `deepseek-v4-pro` is DeepSeek-V4-Pro and `deepseek-flash` is
 * DeepSeek-V4.1-Flash; they are separate models with separate prices.
 */
export const REVIEW_MODELS = ['deepseek-v4-pro', 'deepseek-flash'];
/** Production stays on V4 Pro until the owner switches. */
export const DEFAULT_REVIEW_MODEL = 'deepseek-v4-pro';
export const isReviewModelId = (value) => typeof value === 'string' && REVIEW_MODELS.includes(value);
export const REVIEW_MODEL_LABELS = Object.freeze({
    'deepseek-v4-pro': 'V4 Pro',
    'deepseek-flash': 'V4.1 Flash',
});
const isInt = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
export function parseReviewModelSave(value) {
    if (!plain(value) || Object.keys(value).sort().join(',') !== 'expectedRevision,requestId,reviewModel')
        return undefined;
    if (typeof value.requestId !== 'string' || !/^[A-Za-z0-9_.-]{8,64}$/.test(value.requestId))
        return undefined;
    if (!isInt(value.expectedRevision, 1, Number.MAX_SAFE_INTEGER) || !isReviewModelId(value.reviewModel))
        return undefined;
    return { requestId: value.requestId, expectedRevision: value.expectedRevision, reviewModel: value.reviewModel };
}
/** Strict parse of the server's answer; the page rejects anything else rather than guess. */
export function parseReviewModelView(value) {
    if (!plain(value) ||
        !isReviewModelId(value.current) ||
        !isInt(value.revision, 1, Number.MAX_SAFE_INTEGER) ||
        typeof value.canManage !== 'boolean' ||
        !Array.isArray(value.recent))
        return undefined;
    const recent = [];
    for (const item of value.recent) {
        if (!plain(item) ||
            !isInt(item.at, 0, Number.MAX_SAFE_INTEGER) ||
            typeof item.admin !== 'string' ||
            !isReviewModelId(item.from) ||
            !isReviewModelId(item.to))
            return undefined;
        recent.push({ at: item.at, admin: item.admin, from: item.from, to: item.to });
    }
    return { current: value.current, revision: value.revision, canManage: value.canManage, recent };
}
