/** Only implemented capabilities belong here. Deletion has a separate confirmation and scoped cleanup. */
export const ADMIN_INVITE_PERMISSIONS = [
  'invites.read',
  'invites.issue',
  'invites.revoke-code',
  'invites.revoke-access',
] as const;
export type InviteAdminPermission = (typeof ADMIN_INVITE_PERMISSIONS)[number];
/** 角色 · 共创收件箱: read the players' ideas, or also change status, star, note and mark answers adopted. */
export const ADMIN_COCREATION_PERMISSIONS = ['cocreation.read', 'cocreation.manage'] as const;
export type CocreationAdminPermission = (typeof ADMIN_COCREATION_PERMISSIONS)[number];
export const isCocreationPermission = (value: string): value is CocreationAdminPermission =>
  (ADMIN_COCREATION_PERMISSIONS as readonly string[]).includes(value);
/**
 * 运营 · 测试对话 (Part 19, needs CHAT_REVIEW_ENABLED): read whole chat transcripts under an anonymous code. Held by the owner
 * only unless it is granted explicitly: it is in no preset except 全部, which lists every item.
 */
export const ADMIN_CONVERSATION_PERMISSIONS = ['conversations.read'] as const;
export type ConversationAdminPermission = (typeof ADMIN_CONVERSATION_PERMISSIONS)[number];
// Read legacy scoped grants without silently migrating them. New UI grants only four categories.
export const ADMIN_PERMISSION_LIMIT = 128;
export const ADMIN_CHARACTER_ACTIONS = [
  'read',
  'edit',
  'discard',
  'preview',
  'publish',
  'materials',
  'approve-materials',
  'delete',
] as const;
export type CharacterAdminAction = (typeof ADMIN_CHARACTER_ACTIONS)[number];
export const ADMIN_PERMISSION_CATEGORIES = [
  'category.characters',
  'category.publication',
  'category.materials',
  'category.invites',
] as const;
export type AdminPermissionCategory = (typeof ADMIN_PERMISSION_CATEGORIES)[number];
export type AdminPermission =
  | AdminPermissionCategory
  | InviteAdminPermission
  | CocreationAdminPermission
  | ConversationAdminPermission
  | 'invites.revoke'
  | 'characters.create'
  | `characters.${CharacterAdminAction}:${string}`;

export function isAdminPermission(value: unknown): value is AdminPermission {
  if (typeof value !== 'string') return false;
  return (
    (ADMIN_PERMISSION_CATEGORIES as readonly string[]).includes(value) ||
    (ADMIN_INVITE_PERMISSIONS as readonly string[]).includes(value) ||
    (ADMIN_COCREATION_PERMISSIONS as readonly string[]).includes(value) ||
    (ADMIN_CONVERSATION_PERMISSIONS as readonly string[]).includes(value) ||
    value === 'invites.revoke' ||
    value === 'characters.create' ||
    /^characters\.(read|edit|discard|preview|publish|materials|approve-materials|delete):(?:\*|[A-Za-z0-9_-]{1,128})$/.test(
      value,
    )
  );
}
export function hasCharacterPermission(grants: readonly string[], action: CharacterAdminAction, id: string) {
  const category =
    action === 'preview' || action === 'publish'
      ? 'category.publication'
      : action === 'materials' || action === 'approve-materials'
        ? 'category.materials'
        : 'category.characters';
  const categoryRead =
    action === 'read' &&
    ['category.characters', 'category.publication', 'category.materials'].some((p) => grants.includes(p));
  return (
    categoryRead ||
    grants.includes(category) ||
    grants.includes(`characters.${action}:*`) ||
    grants.includes(`characters.${action}:${id}`)
  );
}

/** Legacy combined revocation means precisely its two old actions, never read or issue. */
export function hasInvitePermission(grants: readonly string[], permission: InviteAdminPermission | 'invites.revoke') {
  return (
    grants.includes('category.invites') ||
    grants.includes(permission) ||
    ((permission === 'invites.revoke-code' || permission === 'invites.revoke-access') &&
      grants.includes('invites.revoke'))
  );
}

/** Only an explicit grant (or the owner role, checked by the caller) opens the inbox: player text is not part of character editing. */
export function hasCocreationPermission(grants: readonly string[], permission: CocreationAdminPermission) {
  return grants.includes('cocreation.manage') || grants.includes(permission);
}

/** Only an explicit grant (or the owner role, checked by the caller) opens the transcripts: they are the players' own words. */
export function hasConversationsPermission(grants: readonly string[]) {
  return grants.includes('conversations.read');
}

export function canCreateCharacter(grants: readonly string[]) {
  return grants.includes('category.characters') || grants.includes('characters.create');
}
/** Used only to present/revoke old grants; this never grants a category implicitly. */
export function permissionCategory(permission: AdminPermission): AdminPermissionCategory {
  if ((ADMIN_PERMISSION_CATEGORIES as readonly string[]).includes(permission))
    return permission as AdminPermissionCategory;
  if (permission.startsWith('invites.')) return 'category.invites';
  if (permission.startsWith('characters.preview:') || permission.startsWith('characters.publish:'))
    return 'category.publication';
  if (permission.startsWith('characters.materials:') || permission.startsWith('characters.approve-materials:'))
    return 'category.materials';
  return 'category.characters';
}

/**
 * 共生项. One table, shared by the permission editor (ticking an item ticks what it needs; unticking a requirement
 * unticks what depends on it) and the server (a saved set is normalized by adding what is required).
 * An "item" is a permission as the editor shows it; characters items are granted for every character (`:*`).
 */
export type AdminPermissionItem =
  | `characters.${CharacterAdminAction}`
  | 'characters.create'
  | InviteAdminPermission
  | CocreationAdminPermission
  | ConversationAdminPermission;
/** Direct requirements only; the closure is computed. */
export const ADMIN_PERMISSION_REQUIRES: Readonly<Record<AdminPermissionItem, readonly AdminPermissionItem[]>> = {
  'characters.read': [],
  'characters.create': [],
  'characters.edit': ['characters.read'],
  'characters.discard': ['characters.read'],
  'characters.preview': ['characters.read'],
  'characters.materials': ['characters.read'],
  'characters.delete': ['characters.read'],
  'characters.publish': ['characters.preview', 'characters.read'],
  'characters.approve-materials': ['characters.materials'],
  'invites.read': [],
  'invites.issue': ['invites.read'],
  'invites.revoke-code': ['invites.read'],
  'invites.revoke-access': ['invites.read'],
  'cocreation.read': [],
  'cocreation.manage': ['cocreation.read'],
  'conversations.read': [],
};
export const ADMIN_PERMISSION_ITEMS = Object.keys(ADMIN_PERMISSION_REQUIRES) as AdminPermissionItem[];
const closure = (item: AdminPermissionItem, next: (value: AdminPermissionItem) => readonly AdminPermissionItem[]) => {
  const seen = new Set<AdminPermissionItem>(),
    todo = [...next(item)];
  for (let value = todo.pop(); value; value = todo.pop())
    if (value !== item && !seen.has(value)) {
      seen.add(value);
      todo.push(...next(value));
    }
  return ADMIN_PERMISSION_ITEMS.filter((candidate) => seen.has(candidate));
};
/** Everything an item needs, transitively. */
export const requiredItems = (item: AdminPermissionItem) => closure(item, (value) => ADMIN_PERMISSION_REQUIRES[value]);
/** Everything that needs an item, transitively. */
export const dependentItems = (item: AdminPermissionItem) =>
  closure(item, (value) => ADMIN_PERMISSION_ITEMS.filter((other) => ADMIN_PERMISSION_REQUIRES[other].includes(value)));
/** The stored form of an item. */
export const itemPermission = (item: AdminPermissionItem): AdminPermission =>
  item.startsWith('characters.') && item !== 'characters.create'
    ? (`${item}:*` as AdminPermission)
    : (item as AdminPermission);

/**
 * Adds every required permission (a scoped character grant adds the same scope) and returns a sorted, de-duplicated
 * set. Categories already contain their own requirements. The legacy combined `invites.revoke` keeps meaning exactly its
 * two old actions: it adds nothing.
 */
export function normalizePermissions(granted: readonly AdminPermission[]): AdminPermission[] {
  const result = new Set<AdminPermission>(granted);
  for (const permission of granted) {
    const scoped = /^characters\.([a-z-]+):(.+)$/.exec(permission);
    if (scoped && (ADMIN_CHARACTER_ACTIONS as readonly string[]).includes(scoped[1]!))
      for (const need of requiredItems(`characters.${scoped[1]}` as AdminPermissionItem))
        result.add(`${need}:${scoped[2]}` as AdminPermission);
    else if ((ADMIN_PERMISSION_ITEMS as readonly string[]).includes(permission))
      for (const need of requiredItems(permission as AdminPermissionItem)) result.add(itemPermission(need));
  }
  return [...result].sort();
}

export type AdminPermissionPreset = { id: string; label: string; items: readonly AdminPermissionItem[] };
/** 共创写手 may read, edit and preview characters and read the inbox, but never publish. */
export const ADMIN_PERMISSION_PRESETS: readonly AdminPermissionPreset[] = [
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
      'cocreation.read',
      'cocreation.manage',
    ],
  },
  { id: 'all', label: '全部', items: ADMIN_PERMISSION_ITEMS },
];

/** Does this administrator hold the action for at least one character? Used to show or hide navigation, never to authorize. */
export function hasAnyCharacterPermission(grants: readonly string[], action: CharacterAdminAction) {
  return hasCharacterPermission(grants, action, '') || grants.some((p) => p.startsWith(`characters.${action}:`));
}
export function hasAnyInvitePermission(grants: readonly string[]) {
  return grants.includes('category.invites') || grants.some((p) => p.startsWith('invites.'));
}
