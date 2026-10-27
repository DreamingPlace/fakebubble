import { h } from '../../cocreation/h.ts';
import { formatRoute } from './admin-router.ts';
import { statusBadge } from '../ui/status-badge.ts';

export type PickerRole = {
  characterId: string;
  displayName: string;
  publishedVersion: number | null;
  draftRevision: number | null;
};
/** The list pane of a list | detail page: one button per role, the open one marked, with an empty state. */
export function rolePicker(
  host: HTMLElement,
  options: {
    emptyText: string;
    onPick: (characterId: string) => void;
    badges?: () => Record<string, number>;
    openInbox?: (characterId: string) => void;
    /**
     * Pills in one row (Part 24b-3, the approved Workbench board): a colour dot, the full name and ONE compact state ("v2",
     * "v2 · 草稿", "未发布"). `colour` gives the dot its colour. Without it the list is the old one button per row.
     */
    compact?: { colour: (characterId: string, index: number) => string };
  },
) {
  let selected: string | null = null;
  let roles: readonly PickerRole[] = [];
  const paint = () => {
    host.replaceChildren();
    if (!roles.length) host.append(h('p', { class: 'admin-empty', text: options.emptyText }));
    roles.forEach((role, index) => {
      const compact = options.compact;
      const dot = compact ? h('i', { class: 'admin-pick-dot', attrs: { 'aria-hidden': 'true' } }) : null;
      dot?.style?.setProperty('--dot', compact!.colour(role.characterId, index));
      const state =
        role.publishedVersion === null
          ? role.draftRevision === null
            ? '未发布'
            : '未发布 · 草稿'
          : `v${role.publishedVersion}${role.draftRevision === null ? '' : ' · 草稿'}`;
      const row = h(
        'button',
        {
          class: 'admin-pick',
          attrs: {
            type: 'button',
            'data-character': role.characterId,
            ...(role.characterId === selected ? { 'aria-current': 'true' } : {}),
          },
        },
        dot,
        h('strong', { text: role.displayName }),
        (options.badges?.()[role.characterId] ?? 0) > 0
          ? h('span', {
              class: 'admin-pick-cc',
              text: String(options.badges!()[role.characterId]),
              attrs: { title: '新的共创' },
            })
          : null,
        compact
          ? statusBadge(state, role.publishedVersion === null ? 'warn' : role.draftRevision === null ? 'ok' : 'info')
          : statusBadge(
              role.publishedVersion === null ? '未发布' : `正式 v${role.publishedVersion}`,
              role.publishedVersion === null ? 'warn' : 'ok',
            ),
        compact || role.draftRevision === null ? null : statusBadge(`草稿 ${role.draftRevision}`, 'info'),
      );
      row.addEventListener('click', () => options.onPick(role.characterId));
      const unread = options.badges?.()[role.characterId] ?? 0;
      if (unread <= 0) {
        host.append(compact ? h('div', { class: 'admin-pick-row' }, row) : row);
        return;
      }
      // New 共创 ideas: a visible link (its address names the filtered inbox) beside the role, opened in place on click.
      const badge = h('a', {
        class: 'cocreation-badge',
        text: `${unread} 条新共创`,
        attrs: {
          href: formatRoute({ page: 'cocreation', id: role.characterId }),
          title: '共创收件箱里有新的玩家想法，点击查看',
        },
      });
      badge.addEventListener('click', (event) => {
        if (!options.openInbox) return;
        event.preventDefault();
        event.stopPropagation();
        options.openInbox(role.characterId);
      });
      host.append(h('div', { class: 'admin-pick-row' }, row, badge));
    });
  };
  return {
    show(next: readonly PickerRole[]) {
      roles = next;
      paint();
    },
    select(characterId: string | null) {
      selected = characterId;
      paint();
    },
    clear() {
      roles = [];
      selected = null;
      host.replaceChildren();
    },
  };
}
