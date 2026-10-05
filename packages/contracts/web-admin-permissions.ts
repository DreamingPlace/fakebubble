/** Only implemented capabilities belong here. Deletion has a separate confirmation and scoped cleanup. */
export const ADMIN_INVITE_PERMISSIONS = [
  'invites.read',
  'invites.issue',
  'invites.revoke-code',
  'invites.revoke-access',
] as const;
export type InviteAdminPermission = (typeof ADMIN_INVITE_PERMISSIONS)[number];
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
  | 'invites.revoke'
  | 'characters.create'
  | `characters.${CharacterAdminAction}:${string}`;

export function isAdminPermission(value: unknown): value is AdminPermission {
  if (typeof value !== 'string') return false;
  return (
    (ADMIN_PERMISSION_CATEGORIES as readonly string[]).includes(value) ||
    (ADMIN_INVITE_PERMISSIONS as readonly string[]).includes(value) ||
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
