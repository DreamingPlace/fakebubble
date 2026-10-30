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
     * The rail (Part 24b-6, Workbench4): a 64 px column of colour circles with ONE small status dot each (共创 count / has draft /
     * not live); on hover or keyboard focus it grows over the page to show the name and the state. `colour` gives the circle its colour.
     * Without it the list is the old one button per row.
     */
    compact?: { colour: (characterId: string, index: number) => string };
  },
) {
  let selected: string | null = null;
  let roles: readonly PickerRole[] = [];
  const seeds = new Map<string, boolean>();
  const paint = () => {
    host.replaceChildren();
    if (!roles.length) host.append(h('p', { class: 'admin-empty', text: options.emptyText }));
    roles.forEach((role, index) => {
      const compact = options.compact;
      const unread = options.badges?.()[role.characterId] ?? 0;
      const seed = seeds.get(role.characterId) === true;
      const dot = compact
        ? h('i', { class: 'admin-pick-dot', text: [...role.displayName][0] ?? '', attrs: { 'aria-hidden': 'true' } })
        : null;
      dot?.style?.setProperty('--dot', compact!.colour(role.characterId, index));
      const tone = unread > 0 ? 'cc' : role.publishedVersion === null ? 'off' : role.draftRevision !== null ? 'draft' : '';
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
            ...(seed ? { 'data-seed': 'true' } : {}),
            ...(role.characterId === selected ? { 'aria-current': 'true' } : {}),
            ...(compact ? { 'aria-label': role.displayName } : {}),
          },
        },
        dot,
        compact && tone ? h('i', { class: 'admin-pick-st', attrs: { 'data-tone': tone, 'aria-hidden': 'true' } }) : null,
        compact
          ? h(
              'span',
              { class: 'admin-pick-text' },
              h('strong', { text: role.displayName }),
              h('small', { text: role.publishedVersion === null ? '未上线' : seed ? '成长中' : state }),
            )
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
    /** The editor's 成长中 switch, whenever it changes: the circle gets (or loses) its dashed ring. */
    setSeed(characterId: string, seed: boolean) {
      if ((seeds.get(characterId) === true) === seed) return;
      seeds.set(characterId, seed);
      paint();
    },
    clear() {
      roles = [];
      selected = null;
      host.replaceChildren();
    },
  };
}
