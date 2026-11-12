import { h } from '../../cocreation/h.ts';
import { formatRoute } from './admin-router.ts';
import { legibleColour } from '../ui/character-colour.ts';
import { statusBadge } from '../ui/status-badge.ts';
import { dragOrder } from '../ui/drag-order.ts';
import { disclosureButton } from '../ui/disclosure.ts';
import { SIDEBAR_GROUPS, SIDEBAR_GROUP_LABEL, type SidebarGroup } from '../../../services/character-admin-api.ts';

export type PickerRole = {
  characterId: string;
  displayName: string;
  publishedVersion: number | null;
  draftRevision: number | null;
  /** Part 24l, from the server: 当前阵容 / 未发布草稿 / 已下线. Absent = the old rule (never published = a draft). */
  group?: SidebarGroup;
};
/** What the small dot on a rail circle means (the same words the expanded rail uses). */
const RAIL_TONE_TIP: Record<string, string> = {
  cc: '有新的共创想法（数字是条数）',
  off: '没有上线：未发布或已下线',
  draft: '有未发布的草稿',
};
const groupOf = (role: PickerRole): SidebarGroup => role.group ?? (role.publishedVersion === null ? 'draft' : 'live');
/** The list pane of a list | detail page: one button per role, the open one marked, with an empty state. */
export function rolePicker(
  host: HTMLElement,
  options: {
    emptyText: string;
    onPick: (characterId: string) => void;
    badges?: () => Record<string, number>;
    openInbox?: (characterId: string) => void;
    /**
     * The rail (Part 24b-6, Workbench4): a 64 px column of colour circles with ONE small status dot each (共创 count / has draft /
     * not live); on hover or keyboard focus it grows over the page to show the name and the state. `colour` gives the circle its colour.
     * Without it the list is the old one button per row.
     */
    compact?: { colour: (characterId: string, index: number) => string };
    /**
     * Part 24l: this admin dragged one group into a new order (ALL of its ids, in order). A rejection puts the list back as it was.
     * Without it the rows are not draggable.
     */
    onReorder?: (group: SidebarGroup, ids: string[]) => Promise<void>;
  },
) {
  let selected: string | null = null;
  let roles: readonly PickerRole[] = [];
  const seeds = new Map<string, boolean>();
  const drops: (() => void)[] = [];
  /**
   * The open circle is scrolled into view once the rail has a size: a page that is still hidden when the rail is painted (the shell
   * keeps every page mounted) has none yet, so the scroll waits for the first size the rail gets.
   */
  let pendingView = false;
  let watching = false;
  const scrollOpen = () =>
    (host.querySelector?.('.admin-pick[aria-current="true"]') as HTMLElement | null)?.scrollIntoView?.({
      block: 'nearest',
    });
  const keepOpenInView = () => {
    if (host.clientHeight > 0) {
      pendingView = false;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(scrollOpen);
      else scrollOpen();
      return;
    }
    pendingView = true;
    if (!watching && typeof ResizeObserver === 'function') {
      watching = true;
      new ResizeObserver(() => {
        if (pendingView && host.clientHeight > 0) {
          pendingView = false;
          scrollOpen();
        }
      }).observe(host);
    }
  };
  /** The groups this administrator folded (kept while the page is open). */
  const collapsed = new Set<SidebarGroup>();
  const paint = () => {
    for (const stop of drops.splice(0)) stop();
    host.replaceChildren();
    if (!roles.length) host.append(h('p', { class: 'admin-empty', text: options.emptyText }));
    // Part 24l: one block per non-empty group, each with a small heading and its count. The order inside a group is this admin's.
    const lists = new Map<SidebarGroup, HTMLElement>();
    if (options.compact || options.onReorder)
      for (const group of SIDEBAR_GROUPS) {
        const members = roles.filter((role) => groupOf(role) === group);
        if (!members.length) continue;
        const list = h('div', { class: 'admin-pick-list', attrs: { 'data-group': group, role: 'list' } });
        // Part 24b-7b: the group heading is a disclosure (chevron, aria-expanded): it folds its circles away and opens them again.
        const heading = h('button', {
          class: 'admin-pick-head',
          attrs: { type: 'button', title: `${SIDEBAR_GROUP_LABEL[group]} ${members.length}：点击折叠或展开` },
        });
        const count = h('b', {
          text: String(members.length),
          attrs: { 'aria-label': `${members.length} 个`, title: `这一组有 ${members.length} 个角色` },
        });
        disclosureButton(heading, h('span', { text: SIDEBAR_GROUP_LABEL[group] }), !collapsed.has(group));
        heading.append(count);
        list.hidden = collapsed.has(group);
        heading.addEventListener('click', () => {
          if (collapsed.has(group)) collapsed.delete(group);
          else collapsed.add(group);
          list.hidden = collapsed.has(group);
          heading.setAttribute('aria-expanded', String(!collapsed.has(group)));
        });
        host.append(
          h('section', { class: 'admin-pick-group', attrs: { 'data-group': group } }, h('h3', {}, heading), list),
        );
        lists.set(group, list);
      }
    const out = (role: PickerRole, node: HTMLElement) => {
      const list = lists.get(groupOf(role));
      node.setAttribute('data-drag-row', '');
      if (list) list.append(node);
      else host.append(node);
    };
    roles.forEach((role, index) => {
      const compact = options.compact;
      const unread = options.badges?.()[role.characterId] ?? 0;
      const seed = seeds.get(role.characterId) === true;
      const dot = compact
        ? h('i', { class: 'admin-pick-dot', text: [...role.displayName][0] ?? '', attrs: { 'aria-hidden': 'true' } })
        : null;
      if (compact) dot?.style?.setProperty('--dot', legibleColour(compact.colour(role.characterId, index)));
      const offline = groupOf(role) === 'offline';
      const tone =
        unread > 0
          ? 'cc'
          : role.publishedVersion === null || offline
            ? 'off'
            : role.draftRevision !== null
              ? 'draft'
              : '';
      // The expanded rail: the name and ONE state mark (a 共创 count, 未上线, 成长中 or a dot for a draft).
      const mark =
        unread > 0
          ? null
          : offline
            ? h('span', { class: 'admin-pick-mark is-offline', text: '已下线' })
            : role.publishedVersion === null
              ? h('span', { class: 'admin-pick-mark', text: '未上线' })
              : seed
                ? h('span', { class: 'admin-pick-mark is-seed', text: '成长中' })
                : role.draftRevision !== null
                  ? h('i', { class: 'admin-pick-mark is-draft', attrs: { 'aria-label': '有草稿', role: 'img' } })
                  : null;
      const row = h(
        'button',
        {
          class: 'admin-pick',
          attrs: {
            type: 'button',
            'data-character': role.characterId,
            ...(offline ? { 'data-offline': 'true' } : {}),
            // the circle shows one initial: its name is its hover tip (成长中 adds what the dashed ring means)
            ...(seed ? { 'data-seed': 'true' } : {}),
            ...(seed || compact
              ? {
                  title: seed
                    ? `${role.displayName} · 成长中（虚线圈）：设定还少，不编细节，多问玩家`
                    : role.displayName,
                }
              : {}),
            ...(role.characterId === selected ? { 'aria-current': 'true' } : {}),
            ...(compact ? { 'aria-label': role.displayName } : {}),
          },
        },
        dot,
        // Part 24b-7b: every mark on the rail says what it means on hover (a plain title: it also runs on the small test DOM).
        compact && tone
          ? h('i', {
              class: 'admin-pick-st',
              attrs: { 'data-tone': tone, 'aria-hidden': 'true', title: RAIL_TONE_TIP[tone] ?? '' },
            })
          : null,
        compact
          ? h('span', { class: 'admin-pick-text' }, h('strong', { text: role.displayName }), mark)
          : h('strong', { text: role.displayName }),
        !compact && unread > 0
          ? h('span', { class: 'admin-pick-cc', text: String(unread), attrs: { title: '新的共创' } })
          : null,
        compact
          ? null
          : statusBadge(
              role.publishedVersion === null ? '未发布' : `正式 v${role.publishedVersion}`,
              role.publishedVersion === null ? 'warn' : 'ok',
            ),
        compact || role.draftRevision === null ? null : statusBadge(`草稿 ${role.draftRevision}`, 'info'),
      );
      row.addEventListener('click', () => options.onPick(role.characterId));
      if (unread <= 0) {
        out(role, compact ? h('div', { class: 'admin-pick-row' }, row) : row);
        return;
      }
      // New 共创 ideas: the number badge is a visible link (its address names the filtered inbox), opened in place on click.
      const badge = h('a', {
        class: 'cocreation-badge',
        text: compact ? String(unread) : `${unread} 条新共创`,
        attrs: {
          href: formatRoute({ page: 'cocreation', id: role.characterId }),
          title: `${unread} 条新共创：共创收件箱里有新的玩家想法，点击查看`,
          ...(compact ? { 'aria-label': `${unread} 条新共创` } : {}),
        },
      });
      badge.addEventListener('click', (event) => {
        if (!options.openInbox) return;
        event.preventDefault();
        event.stopPropagation();
        options.openInbox(role.characterId);
      });
      out(role, h('div', { class: 'admin-pick-row' }, row, badge));
    });
    // the rail scrolls inside itself: the open character is in view after every paint
    keepOpenInView();
    const reorder = options.onReorder;
    if (reorder)
      for (const [group, list] of lists)
        drops.push(
          dragOrder(list, {
            rows: () => Array.from(list.children) as HTMLElement[],
            idOf: (row) => row.querySelector('[data-character]')?.getAttribute('data-character') ?? '',
            ignore: '.cocreation-badge',
            onOrder: (ids) => {
              const before = roles;
              const first = roles.findIndex((role) => groupOf(role) === group);
              const inGroup = new Map(roles.filter((role) => groupOf(role) === group).map((r) => [r.characterId, r]));
              // The group's members take, in the new order, the places the group held; every other role stays where it is.
              const rest = roles.filter((role) => groupOf(role) !== group);
              roles = [...rest.slice(0, first), ...ids.map((id) => inGroup.get(id)!), ...rest.slice(first)];
              reorder(group, ids).catch(() => {
                roles = before;
                paint();
              });
            },
          }),
        );
  };
  return {
    show(next: readonly PickerRole[]) {
      roles = next;
      paint();
    },
    select(characterId: string | null) {
      selected = characterId;
      // the open character's group is never folded away
      const mine = roles.find((role) => role.characterId === characterId);
      if (mine) collapsed.delete(groupOf(mine));
      paint();
      // the rail scrolls inside itself: the open character is always in view
      keepOpenInView();
    },
    /** The editor's 成长中 switch, whenever it changes: the circle gets (or loses) its dashed ring. */
    setSeed(characterId: string, seed: boolean) {
      if ((seeds.get(characterId) === true) === seed) return;
      seeds.set(characterId, seed);
      paint();
    },
    clear() {
      for (const stop of drops.splice(0)) stop();
      roles = [];
      selected = null;
      host.replaceChildren();
    },
  };
}
