import {
  hasAnyCharacterPermission,
  hasAnyInvitePermission,
  hasCocreationPermission,
  hasCastPermission,
  hasConversationsPermission,
  hasPointsPermission,
  hasStatsPermission,
  hasSystemPermission,
} from '../../../../../../packages/contracts/web-admin-permissions.ts';

/** Pages behind the sidebar plus 我的账号, which lives in the account menu rather than the first-level nav. */
export type AdminPage =
  | 'overview'
  | 'characters'
  | 'cast'
  | 'cocreation'
  | 'invites'
  | 'points'
  | 'conversations'
  | 'costs'
  | 'models'
  | 'system'
  | 'members'
  | 'account';
export type NavItem = {
  page: Exclude<AdminPage, 'account'>;
  label: string;
  /** Pages that belong under this one (indented beneath it in the sidebar). */
  subs?: readonly NavItem[];
};
export type NavGroup = { id: string; label: string; items: readonly NavItem[] };

/** First-level navigation (Part 24b-1). The order is also the order of "the first page this administrator may use". */
export const NAV_TREE: readonly NavGroup[] = [
  // 总览 stands alone at the top: its group has no title of its own.
  { id: 'overview', label: '', items: [{ page: 'overview', label: '总览' }] },
  {
    id: 'roles',
    label: '角色',
    items: [
      // 预演 lives inside 角色工作台 (Part 24b-2); the old 预演测试 address still arrives there.
      { page: 'characters', label: '角色工作台' },
      { page: 'cast', label: '关系与故事' },
      { page: 'cocreation', label: '共创收件箱' },
    ],
  },
  {
    id: 'players',
    label: '玩家',
    items: [
      { page: 'invites', label: '邀请与额度' },
      { page: 'points', label: '积分发放' },
    ],
  },
  {
    id: 'ops',
    label: '运营',
    items: [{ page: 'costs', label: '消耗表' }],
  },
  {
    id: 'system',
    label: '系统',
    items: [
      { page: 'models', label: '模型与价格' },
      { page: 'system', label: '系统状态' },
      { page: 'members', label: '管理员与权限' },
    ],
  },
];

/**
 * Pages that exist only while a deployment switch is on (Part 19: 运营 → 测试对话, CHAT_REVIEW_ENABLED). They are NOT part of
 * NAV_TREE - the groups and pages every deployment has - and are appended to their group by `navTree()`. `canSeePage` hides
 * them unless the session says the switch is on and the administrator holds the permission.
 */
export const OPTIONAL_NAV: ReadonlyArray<NavItem & { group: string; first?: boolean }> = [
  { group: 'ops', page: 'conversations', label: '测试对话' },
];
/** NAV_TREE plus the switch-gated pages, in their groups (an item marked `first` goes before the group's own pages). */
export const navTree = (): NavGroup[] =>
  NAV_TREE.map((group) => {
    const extra = OPTIONAL_NAV.filter((item) => item.group === group.id).map(({ group: _group, first, ...item }) => ({
      item,
      first: first === true,
    }));
    return {
      ...group,
      items: [
        ...extra.filter((entry) => entry.first).map((entry) => entry.item),
        ...group.items,
        ...extra.filter((entry) => !entry.first).map((entry) => entry.item),
      ],
    };
  });
/** Every item of a group with the pages nested under them, in sidebar order. */
export const groupPages = (group: NavGroup): NavItem[] => group.items.flatMap((item) => [item, ...(item.subs ?? [])]);

/** What decides visibility. `inbox` says whether this page was given a client for it at all. */
export type NavAccess = {
  owner: boolean;
  permissions: readonly string[];
  inbox: boolean;
  /** CHAT_REVIEW_ENABLED and this page has the client for 测试对话. Absent = off. */
  conversations?: boolean;
  /** This page was given the cast client (关系与故事). Absent = the page does not exist here. */
  cast?: boolean;
  /** This page was given a client for 模型与价格. Any administrator may read it (saving is decided by the server and `canManage`). */
  models?: boolean;
  /** This page was given the clients for 概览 / 系统状态 / 积分发放 (Part 22b) and 消耗表 (Part 22c). Absent = those pages do not exist here. */
  system?: boolean;
};
export const PAGES: readonly AdminPage[] = [...navTree().flatMap((g) => groupPages(g).map((i) => i.page)), 'account'];
export const isAdminPage = (value: string): value is AdminPage => (PAGES as readonly string[]).includes(value);

/** Hidden, never disabled. The server still checks every request; this only decides what is worth showing. */
export function canSeePage(page: AdminPage, access: NavAccess): boolean {
  const { owner, permissions } = access;
  switch (page) {
    case 'account':
      return true;
    case 'overview':
      return access.system === true;
    case 'characters':
      return owner || hasAnyCharacterPermission(permissions, 'read');
    case 'cast':
      return access.cast === true && (owner || hasCastPermission(permissions, 'cast.read'));
    case 'cocreation':
      return access.inbox && (owner || hasCocreationPermission(permissions, 'cocreation.read'));
    case 'invites':
      return owner || hasAnyInvitePermission(permissions);
    case 'points':
      return access.system === true && (owner || hasPointsPermission(permissions));
    // 消耗表 (Part 22c): the owner, or an administrator holding stats.read. (玩家统计 moved into 总览 in Part 24b-6.)
    case 'costs':
      return access.system === true && (owner || hasStatsPermission(permissions));
    case 'system':
      return access.system === true && (owner || hasSystemPermission(permissions));
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
    .map((group) => ({
      ...group,
      items: group.items
        .filter((item) => canSeePage(item.page, access))
        .map((item) => (item.subs ? { ...item, subs: item.subs.filter((sub) => canSeePage(sub.page, access)) } : item)),
    }))
    .filter((group) => group.items.length > 0);
/** Where to land: the first sidebar page the administrator may use, else their account. */
export const firstAllowedPage = (access: NavAccess): AdminPage => visibleNav(access)[0]?.items[0]?.page ?? 'account';

const link = (item: NavItem, sub = false) =>
  `<a class="admin-nav-item${sub ? ' admin-nav-sub' : ''}" href="#/${item.page}" data-page="${item.page}"><i class="admin-nav-dot" aria-hidden="true"></i><span>${item.label}</span></a>`;
/** Static markup for every item; `render()` of the page then hides what the administrator may not use. */
export const navMarkup = () =>
  navTree()
    .map(
      (group) =>
        `<div class="admin-nav-group" data-group="${group.id}">${group.label ? `<p class="admin-nav-title">${group.label}</p>` : ''}${group.items
          .map((item) => link(item) + (item.subs ?? []).map((sub) => link(sub, true)).join(''))
          .join('')}</div>`,
    )
    .join('');
