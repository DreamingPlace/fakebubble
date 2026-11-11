import { isPlayerModelId } from "./player-models.js";
/**
 * 消费记录 (Part 21f): what POST /billing/history answers. Points only; no ids of players or operations, no money.
 * `points` of a reply is the NET spent (after a cheaper-backup or no-voice refund), positive; 0 and `free` for a reply
 * that is not charged (an invited player). The page shows it as a minus.
 */
export const POINTS_EVENT_KINDS = [
    'bonus',
    'grant',
    'daily_refill',
    'reset',
    'cocreation_note',
    'cocreation_adopted',
];
const count = (n) => Number.isSafeInteger(n) && n >= 0 && n <= 10_000_000;
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128;
const time = (n) => Number.isSafeInteger(n) && n > 0;
const quotaOk = (q) => !!q && typeof q === 'object' && count(q.total) && count(q.used);
const trialOk = (q) => !!q && typeof q === 'object' && count(q.used) && count(q.limit);
/** Strict parse of the server's page: anything unexpected yields undefined and the page says it could not load. */
export function parseBillingPage(value) {
    const v = value;
    if (!v || typeof v !== 'object' || Array.isArray(v))
        return undefined;
    const month = v.month;
    if (typeof v.metered !== 'boolean' ||
        !(v.balance === null || count(v.balance)) ||
        !(v.quota == null || quotaOk(v.quota)) ||
        !(v.trial == null || trialOk(v.trial)) ||
        !Number.isSafeInteger(v.page) ||
        typeof v.hasMore !== 'boolean' ||
        !Array.isArray(v.items) ||
        !month ||
        !Array.isArray(month.byModel) ||
        !Array.isArray(month.byCharacter))
        return undefined;
    const byModel = [];
    for (const raw of month.byModel) {
        if (!raw || !isPlayerModelId(raw.model) || !count(raw.points) || !count(raw.replies))
            return undefined;
        byModel.push({ model: raw.model, points: raw.points, replies: raw.replies });
    }
    const byCharacter = [];
    for (const raw of month.byCharacter) {
        if (!raw || !text(raw.characterId) || !count(raw.points) || !count(raw.replies))
            return undefined;
        byCharacter.push({ characterId: raw.characterId, points: raw.points, replies: raw.replies });
    }
    const items = [];
    for (const raw of v.items) {
        if (!raw || typeof raw !== 'object' || !time(raw.at))
            return undefined;
        const at = raw.at;
        if (raw.kind === 'reply') {
            if (!text(raw.characterId) ||
                !isPlayerModelId(raw.model) ||
                typeof raw.voice !== 'boolean' ||
                typeof raw.free !== 'boolean' ||
                !Number.isSafeInteger(raw.points) ||
                !(raw.backupFor === undefined || isPlayerModelId(raw.backupFor)))
                return undefined;
            items.push({
                kind: 'reply',
                at,
                characterId: raw.characterId,
                model: raw.model,
                ...(raw.backupFor ? { backupFor: raw.backupFor } : {}),
                voice: raw.voice,
                points: raw.points,
                free: raw.free,
            });
        }
        else if (raw.kind === 'pending') {
            if (!text(raw.characterId) ||
                !isPlayerModelId(raw.model) ||
                typeof raw.free !== 'boolean' ||
                !Number.isSafeInteger(raw.points))
                return undefined;
            items.push({
                kind: 'pending',
                at,
                characterId: raw.characterId,
                model: raw.model,
                points: raw.points,
                free: raw.free,
            });
        }
        else if (raw.kind === 'failed') {
            if (!text(raw.characterId) || !count(raw.refunded) || typeof raw.free !== 'boolean')
                return undefined;
            items.push({ kind: 'failed', at, characterId: raw.characterId, refunded: raw.refunded, free: raw.free });
        }
        else if (raw.kind === 'trial') {
            if (!text(raw.characterId) || !isPlayerModelId(raw.model))
                return undefined;
            items.push({ kind: 'trial', at, characterId: raw.characterId, model: raw.model });
        }
        else if (POINTS_EVENT_KINDS.includes(raw.kind)) {
            if (!Number.isSafeInteger(raw.points))
                return undefined;
            items.push({ kind: raw.kind, at, points: raw.points });
        }
        else
            return undefined;
    }
    return {
        metered: v.metered,
        balance: v.balance,
        quota: (v.quota ?? null),
        trial: (v.trial ?? null),
        month: { byModel, byCharacter },
        items,
        page: v.page,
        hasMore: v.hasMore,
    };
}
