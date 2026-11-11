/** Only implemented capabilities belong here. Deletion has a separate confirmation and scoped cleanup. */
export const ADMIN_INVITE_PERMISSIONS = [
    'invites.read',
    'invites.issue',
    'invites.revoke-code',
    'invites.revoke-access',
    /**
     * 邀请与额度 (Part 22a): create batches of codes, list them and revoke codes, batches and entitlements. Editing a batch's daily
     * amount and cap is the owner's alone and is NOT a permission.
     */
    'invites.manage',
];
/** 角色 · 共创收件箱: read the players' ideas, or also change status, star, note and mark answers adopted. */
export const ADMIN_COCREATION_PERMISSIONS = ['cocreation.read', 'cocreation.manage'];
/**
 * 运营 · 测试对话 (Part 19, needs CHAT_REVIEW_ENABLED): read whole chat transcripts under an anonymous code. Held by the owner
 * only unless it is granted explicitly: it is in no preset except 全部, which lists every item.
 */
export const ADMIN_CONVERSATION_PERMISSIONS = ['conversations.read'];
/**
 * 系统 · 模型与价格 (Part 21g): change which reply models are offered, to whom and at what points price. Reading the page needs
 * no permission (any administrator); saving needs this one or the owner role.
 */
export const ADMIN_MODEL_PERMISSIONS = ['models.manage'];
/**
 * 系统 · 系统状态 (Part 22b): read the read-only status page (versions, switches, prices, budget, UNKNOWN, retention, metrics,
 * security counters). The owner always can. The owner-only buttons on that page (续期价格, 预算充值) are NOT a permission.
 */
export const ADMIN_SYSTEM_PERMISSIONS = ['system.read'];
/**
 * 玩家 · 积分发放 (Part 22b): give points to all registered players, one tier, one 玩家编号 or one exact email. Only the owner
 * can give this permission (it is in no preset except 全部). 重置全部额度 is the owner's alone and is NOT a permission.
 */
export const ADMIN_POINTS_PERMISSIONS = ['points.grant'];
/**
 * 玩家 · 玩家统计 and 运营 · 消耗表 (Part 22c): read the daily player counts and the consumption table, and export them. The owner
 * always can. Only the owner can give this permission (it is in no preset except 全部).
 */
export const ADMIN_STATS_PERMISSIONS = ['stats.read'];
/**
 * 世界设定 · cast (Part 24a): read the draft and the published versions, edit the draft (and import the legacy canon into it), and
 * publish or roll back. The owner always can. Only the owner can give these (they are in no preset except 全部) and the permission
 * editor has no row for them: they are granted through the 全部 preset or the API.
 */
export const ADMIN_CAST_PERMISSIONS = ['cast.read', 'cast.edit', 'cast.publish'];
// Read legacy scoped grants without silently migrating them. New UI grants only four categories.
export const ADMIN_PERMISSION_LIMIT = 128;
/**
 * Part 24f: deleting a character is the OWNER's alone. `delete` stays in this list only so that grants already stored
 * (`characters.delete:*`, `characters.delete:<id>`) still parse and are kept untouched in the database; no grant, category or
 * preset opens it (see hasCharacterPermission) and the permission editor has no row for it.
 */
export const ADMIN_CHARACTER_ACTIONS = [
    'read',
    'edit',
    'discard',
    'preview',
    'publish',
    'materials',
    'approve-materials',
    'delete',
];
export const ADMIN_PERMISSION_CATEGORIES = [
    'category.characters',
    'category.publication',
    'category.materials',
    'category.invites',
];
export function isAdminPermission(value) {
    if (typeof value !== 'string')
        return false;
    return (ADMIN_PERMISSION_CATEGORIES.includes(value) ||
        ADMIN_INVITE_PERMISSIONS.includes(value) ||
        ADMIN_COCREATION_PERMISSIONS.includes(value) ||
        ADMIN_CONVERSATION_PERMISSIONS.includes(value) ||
        ADMIN_MODEL_PERMISSIONS.includes(value) ||
        ADMIN_SYSTEM_PERMISSIONS.includes(value) ||
        ADMIN_POINTS_PERMISSIONS.includes(value) ||
        ADMIN_STATS_PERMISSIONS.includes(value) ||
        ADMIN_CAST_PERMISSIONS.includes(value) ||
        value === 'invites.revoke' ||
        value === 'characters.create' ||
        /^characters\.(read|edit|discard|preview|publish|materials|approve-materials|delete):(?:\*|[A-Za-z0-9_-]{1,128})$/.test(value));
}
export function hasCharacterPermission(grants, action, id) {
    // Owner-only (the owner role is checked by the caller): neither category.characters, nor 全部, nor a stored delete grant counts.
    if (action === 'delete')
        return false;
    const category = action === 'preview' || action === 'publish'
        ? 'category.publication'
        : action === 'materials' || action === 'approve-materials'
            ? 'category.materials'
            : 'category.characters';
    const categoryRead = action === 'read' &&
        ['category.characters', 'category.publication', 'category.materials'].some((p) => grants.includes(p));
    return (categoryRead ||
        grants.includes(category) ||
        grants.includes(`characters.${action}:*`) ||
        grants.includes(`characters.${action}:${id}`));
}
/** Legacy combined revocation means precisely its two old actions, never read or issue. */
export function hasInvitePermission(grants, permission) {
    return (grants.includes('category.invites') ||
        grants.includes(permission) ||
        ((permission === 'invites.revoke-code' || permission === 'invites.revoke-access') &&
            grants.includes('invites.revoke')));
}
/** Only an explicit grant (or the owner role, checked by the caller) opens the inbox: player text is not part of character editing. */
export function hasCocreationPermission(grants, permission) {
    return grants.includes('cocreation.manage') || grants.includes(permission);
}
/** Only an explicit grant (or the owner role, checked by the caller) opens the transcripts: they are the players' own words. */
export function hasConversationsPermission(grants) {
    return grants.includes('conversations.read');
}
/** Saving 模型与价格 (the owner role is checked by the caller). Reading the page needs nothing. */
export function hasModelsPermission(grants) {
    return grants.includes('models.manage');
}
/** Reading 系统状态 (the owner role is checked by the caller). */
export function hasSystemPermission(grants) {
    return grants.includes('system.read');
}
/** Giving points (the owner role is checked by the caller). */
export function hasPointsPermission(grants) {
    return grants.includes('points.grant');
}
/** Reading 玩家统计 and 消耗表 and exporting them (the owner role is checked by the caller). */
export function hasStatsPermission(grants) {
    return grants.includes('stats.read');
}
/** The cast: read (draft, versions, compile-preview), edit (save, import-legacy) or publish (publish, rollback). Owner role is checked by the caller. */
export function hasCastPermission(grants, permission) {
    return grants.includes(permission);
}
export function canCreateCharacter(grants) {
    return grants.includes('category.characters') || grants.includes('characters.create');
}
/** Direct requirements only; the closure is computed. */
export const ADMIN_PERMISSION_REQUIRES = {
    'characters.read': [],
    'characters.create': [],
    'characters.edit': ['characters.read'],
    'characters.discard': ['characters.read'],
    'characters.preview': ['characters.read'],
    'characters.materials': ['characters.read'],
    'characters.publish': ['characters.preview', 'characters.read'],
    'characters.approve-materials': ['characters.materials'],
    'invites.read': [],
    'invites.issue': ['invites.read'],
    'invites.revoke-code': ['invites.read'],
    'invites.revoke-access': ['invites.read'],
    'invites.manage': [],
    'cocreation.read': [],
    'cocreation.manage': ['cocreation.read'],
    'conversations.read': [],
    'models.manage': [],
    'system.read': [],
    'points.grant': [],
    'stats.read': [],
    'cast.read': [],
    'cast.edit': ['cast.read'],
    'cast.publish': ['cast.read'],
};
export const ADMIN_PERMISSION_ITEMS = Object.keys(ADMIN_PERMISSION_REQUIRES);
const closure = (item, next) => {
    const seen = new Set(), todo = [...next(item)];
    for (let value = todo.pop(); value; value = todo.pop())
        if (value !== item && !seen.has(value)) {
            seen.add(value);
            todo.push(...next(value));
        }
    return ADMIN_PERMISSION_ITEMS.filter((candidate) => seen.has(candidate));
};
/** Everything an item needs, transitively. */
export const requiredItems = (item) => closure(item, (value) => ADMIN_PERMISSION_REQUIRES[value]);
/** Everything that needs an item, transitively. */
export const dependentItems = (item) => closure(item, (value) => ADMIN_PERMISSION_ITEMS.filter((other) => ADMIN_PERMISSION_REQUIRES[other].includes(value)));
/** The stored form of an item. */
export const itemPermission = (item) => item.startsWith('characters.') && item !== 'characters.create'
    ? `${item}:*`
    : item;
/**
 * Adds every required permission (a scoped character grant adds the same scope) and returns a sorted, de-duplicated
 * set. Categories already contain their own requirements. The legacy combined `invites.revoke` keeps meaning exactly its
 * two old actions: it adds nothing.
 */
export function normalizePermissions(granted) {
    const result = new Set(granted);
    for (const permission of granted) {
        const scoped = /^characters\.([a-z-]+):(.+)$/.exec(permission);
        if (scoped && scoped[1] === 'delete')
            // A grant stored before Part 24f: kept as it was (and still needing read in its scope), but it opens nothing.
            result.add(`characters.read:${scoped[2]}`);
        else if (scoped && ADMIN_CHARACTER_ACTIONS.includes(scoped[1]))
            for (const need of requiredItems(`characters.${scoped[1]}`))
                result.add(`${need}:${scoped[2]}`);
        else if (ADMIN_PERMISSION_ITEMS.includes(permission))
            for (const need of requiredItems(permission))
                result.add(itemPermission(need));
    }
    return [...result].sort();
}
/** 共创写手 may read, edit and preview characters and read the inbox, but never publish. */
export const ADMIN_PERMISSION_PRESETS = [
    {
        id: 'co-writer',
        label: '共创写手',
        items: ['characters.read', 'characters.edit', 'characters.preview', 'cocreation.read'],
    },
    {
        id: 'operations',
        label: '运营',
        items: [
            'invites.read',
            'invites.issue',
            'invites.revoke-code',
            'invites.revoke-access',
            'invites.manage',
            'cocreation.read',
            'cocreation.manage',
        ],
    },
    { id: 'all', label: '全部', items: ADMIN_PERMISSION_ITEMS },
];
/** Does this administrator hold the action for at least one character? Used to show or hide navigation, never to authorize. */
export function hasAnyCharacterPermission(grants, action) {
    return hasCharacterPermission(grants, action, '') || grants.some((p) => p.startsWith(`characters.${action}:`));
}
export function hasAnyInvitePermission(grants) {
    return grants.includes('category.invites') || grants.some((p) => p.startsWith('invites.'));
}
