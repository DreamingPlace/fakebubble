import { h } from '../../cocreation/h.ts';
import { statusBadge } from '../ui/status-badge.ts';

export type PickerRole = {
  characterId: string;
  displayName: string;
  publishedVersion: number | null;
  draftRevision: number | null;
};
/** The list pane of a list | detail page: one button per role, the open one marked, with an empty state. */
export function rolePicker(host: HTMLElement, options: { emptyText: string; onPick: (characterId: string) => void }) {
  let selected: string | null = null;
  let roles: readonly PickerRole[] = [];
  const paint = () => {
    host.replaceChildren();
    if (!roles.length) host.append(h('p', { class: 'admin-empty', text: options.emptyText }));
    for (const role of roles) {
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
        h('strong', { text: role.displayName }),
        h('span', { class: 'admin-pick-meta', text: role.characterId }),
        statusBadge(
          role.publishedVersion === null ? '未发布' : `正式 v${role.publishedVersion}`,
          role.publishedVersion === null ? 'warn' : 'ok',
        ),
        role.draftRevision === null ? null : statusBadge(`草稿 ${role.draftRevision}`, 'info'),
      );
      row.addEventListener('click', () => options.onPick(role.characterId));
      host.append(row);
    }
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
