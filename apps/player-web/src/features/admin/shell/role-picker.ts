import { h } from '../../cocreation/h.ts';
import { formatRoute } from './admin-router.ts';
import { statusBadge } from '../ui/status-badge.ts';

/**
 * The circle's initial is white when that reads (≥ 4.5:1); on a lighter tint the circle itself is darkened a step at a time (the same
 * hue, the darkest tint that is needed) until it does.
 */
function legible(hex: string): { background: string } {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { background: '#6e6875' };
  let channels = [0, 8, 16].map((shift) => (Number.parseInt(m[1]!, 16) >> (16 - shift)) & 255);
  const luminance = (c: number[]) => {
    const lin = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  };
  for (let step = 0; step < 12 && 1.05 / (luminance(channels) + 0.05) < 4.6; step++)
    channels = channels.map((v) => Math.round(v * 0.92));
  return { background: `#${channels.map((v) => v.toString(16).padStart(2, '0')).join('')}` };
}

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
      if (compact) dot?.style?.setProperty('--dot', legible(compact.colour(role.characterId, index)).background);
      const tone =
        unread > 0 ? 'cc' : role.publishedVersion === null ? 'off' : role.draftRevision !== null ? 'draft' : '';
      // The expanded rail: the name and ONE state mark (a 共创 count, 未上线, 成长中 or a dot for a draft).
      const mark =
        unread > 0
          ? null
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
            ...(seed ? { 'data-seed': 'true' } : {}),
            ...(role.characterId === selected ? { 'aria-current': 'true' } : {}),
            ...(compact ? { 'aria-label': role.displayName } : {}),
          },
        },
        dot,
        compact && tone
          ? h('i', { class: 'admin-pick-st', attrs: { 'data-tone': tone, 'aria-hidden': 'true' } })
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
        host.append(compact ? h('div', { class: 'admin-pick-row' }, row) : row);
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
