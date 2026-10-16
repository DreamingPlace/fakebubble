import {
  hasAnyCharacterPermission,
  hasAnyInvitePermission,
  hasCocreationPermission,
  hasConversationsPermission,
  hasInvitePermission,
} from '../../../../../../packages/contracts/web-admin-permissions.ts';

/** Pages behind the sidebar plus 我的账号, which lives in the account menu rather than the first-level nav. */
export type AdminPage =
  | 'characters'
  | 'preview'
  | 'cocreation'
  | 'invites'
  | 'grants'
  | 'ops'
  | 'conversations'
  | 'models'
  | 'members'
  | 'account';
export type NavItem = { page: Exclude<AdminPage, 'account'>; label: string; icon: string };
export type NavGroup = { id: string; label: string; items: readonly NavItem[] };

/** First-level navigation. The order is also the order of "the first page this administrator may use". */
export const NAV_TREE: readonly NavGroup[] = [
  {
    id: 'roles',
    label: '角色',
    items: [
      { page: 'characters', label: '角色资料', icon: 'user' },
      { page: 'preview', label: '预演测试', icon: 'play' },
      { page: 'cocreation', label: '共创收件箱', icon: 'inbox' },
    ],
  },
  {
    id: 'players',
    label: '玩家',
    items: [
      { page: 'invites', label: '邀请码', icon: 'ticket' },
      { page: 'grants', label: '玩家授权', icon: 'key' },
    ],
  },
  { id: 'ops', label: '运营', items: [{ page: 'ops', label: '运营数据', icon: 'chart' }] },
  {
    id: 'system',
    label: '系统',
    items: [
      { page: 'models', label: '模型与价格', icon: 'sliders' },
      { page: 'members', label: '管理员与权限', icon: 'shield' },
    ],
  },
];

/**
 * Pages that exist only while a deployment switch is on (Part 19: 运营 → 测试对话, CHAT_REVIEW_ENABLED). They are NOT part of
 * NAV_TREE - the groups and pages every deployment has - and are appended to their group by `navTree()`. `canSeePage` hides
 * them unless the session says the switch is on and the administrator holds the permission.
 */
export const OPTIONAL_NAV: ReadonlyArray<NavItem & { group: string }> = [
  { group: 'ops', page: 'conversations', label: '测试对话', icon: 'chat' },
];
/** NAV_TREE plus the switch-gated pages, in their groups. */
export const navTree = (): NavGroup[] =>
  NAV_TREE.map((group) => ({
    ...group,
    items: [
      ...group.items,
      ...OPTIONAL_NAV.filter((item) => item.group === group.id).map(({ group: _group, ...item }) => item),
    ],
  }));

/** What decides visibility. `inbox` and `metrics` say whether this page was given a client for them at all. */
export type NavAccess = {
  owner: boolean;
  permissions: readonly string[];
  inbox: boolean;
  metrics: boolean;
  /** CHAT_REVIEW_ENABLED and this page has the client for 测试对话. Absent = off. */
  conversations?: boolean;
  /** This page was given a client for 模型与价格. Any administrator may read it (saving is decided by the server and `canManage`). */
  models?: boolean;
};
export const PAGES: readonly AdminPage[] = [...navTree().flatMap((g) => g.items.map((i) => i.page)), 'account'];
export const isAdminPage = (value: string): value is AdminPage => (PAGES as readonly string[]).includes(value);

/** Hidden, never disabled. The server still checks every request; this only decides what is worth showing. */
export function canSeePage(page: AdminPage, access: NavAccess): boolean {
  const { owner, permissions } = access;
  switch (page) {
    case 'account':
      return true;
    case 'characters':
      return owner || hasAnyCharacterPermission(permissions, 'read');
    case 'preview':
      return (
        owner || (hasAnyCharacterPermission(permissions, 'read') && hasAnyCharacterPermission(permissions, 'preview'))
      );
    case 'cocreation':
      return access.inbox && (owner || hasCocreationPermission(permissions, 'cocreation.read'));
    case 'invites':
      return owner || hasAnyInvitePermission(permissions);
    case 'grants':
      return owner || hasInvitePermission(permissions, 'invites.read');
    case 'ops':
      return access.metrics && owner;
    case 'conversations':
      return access.conversations === true && (owner || hasConversationsPermission(permissions));
    case 'models':
      return access.models === true;
    case 'members':
      return owner;
  }
}
export const visibleNav = (access: NavAccess): NavGroup[] =>
  navTree()
    .map((group) => ({ ...group, items: group.items.filter((item) => canSeePage(item.page, access)) }))
    .filter((group) => group.items.length > 0);
/** Where to land: the first sidebar page the administrator may use, else their account. */
export const firstAllowedPage = (access: NavAccess): AdminPage => visibleNav(access)[0]?.items[0]?.page ?? 'account';

// Icons: simple 24px strokes drawn for this console in the style of Tabler Icons (MIT, https://tabler.io/icons).
const ICON_PATHS: Record<string, string> = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/>',
  play: '<circle cx="12" cy="12" r="9"/><path d="M10 8l6 4-6 4z"/>',
  inbox: '<path d="M3 13l3-8h12l3 8v6H3z"/><path d="M3 13h5l1 3h6l1-3h5"/>',
  ticket: '<path d="M4 7h16v4a2 2 0 0 0 0 4v4H4v-4a2 2 0 0 0 0-4z"/><path d="M14 7v12"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M16 7l3 3"/>',
  chart: '<path d="M5 20V10M12 20V4M19 20v-7"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  sliders:
    '<path d="M5 4v16M12 4v16M19 4v16"/><circle cx="5" cy="9" r="2"/><circle cx="12" cy="15" r="2"/><circle cx="19" cy="8" r="2"/>',
};
const icon = (name: string) =>
  `<svg class="admin-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] ?? ''}</svg>`;
/** Static markup for every item; `render()` of the page then hides what the administrator may not use. */
export const navMarkup = () =>
  navTree()
    .map(
      (group) =>
        `<div class="admin-nav-group" data-group="${group.id}"><p class="admin-nav-title">${group.label}</p>${group.items
          .map(
            (item) =>
              `<a class="admin-nav-item" href="#/${item.page}" data-page="${item.page}" title="${item.label}">${icon(item.icon)}<span>${item.label}</span></a>`,
          )
          .join('')}</div>`,
    )
    .join('');
