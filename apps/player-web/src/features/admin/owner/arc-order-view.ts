import type { ArcCharacter, OwnerAdminClient } from '../../../services/owner-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { dragOrder } from '../ui/drag-order.ts';

export const arcOrderCopy = {
  title: '首页顺序',
  hint: '拖动调整，松手即保存。新玩家第一次打开时，第 1 位在正中。',
  close: '关闭',
  saved: '首页顺序已保存。',
  empty: '没有已上线的角色。',
  position: (n: number) => `第 ${n} 位`,
};

/**
 * Part 31 (A): the order of the cards on the home arc. It is the catalog position the home page already reads (not the per-admin
 * 角色 rail order), so a drop saves for everyone. An inline panel under the roster row, like 导入角色资料: no dialog.
 */
export function arcOrderView(
  host: HTMLElement,
  deps: {
    api: Pick<OwnerAdminClient, 'arcRead' | 'arcSave'>;
    run: (work: () => Promise<void>) => Promise<void>;
    toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
    disposed: () => boolean;
  },
) {
  const list = h('ol', { class: 'arc-list', attrs: { 'aria-label': arcOrderCopy.title } });
  const close = h('button', { class: 'admin-secondary', text: arcOrderCopy.close, attrs: { type: 'button' } });
  const panel = h(
    'section',
    { class: 'arc-panel', hidden: true, attrs: { 'aria-label': arcOrderCopy.title } },
    h(
      'div',
      { class: 'admin-bar' },
      h('strong', { class: 'admin-bar-title', text: arcOrderCopy.title }),
      h('span', { class: 'admin-bar-spacer' }),
      close,
    ),
    h('p', { class: 'admin-hint', text: arcOrderCopy.hint }),
    list,
  );
  host.append(panel);
  let rows: ArcCharacter[] = [];
  const paint = () => {
    list.replaceChildren(
      ...rows.map((row, index) => {
        const dot = h('i', { class: 'arc-dot', attrs: { 'aria-hidden': 'true' } });
        if (row.color) dot.style?.setProperty('--arc-colour', row.color);
        return h(
          'li',
          {
            class: 'arc-row',
            attrs: {
              'data-id': row.characterId,
              tabindex: '0',
              'aria-label': `${row.name}，${arcOrderCopy.position(index + 1)}`,
            },
          },
          h('span', { class: 'arc-grip', text: '⠿', attrs: { 'aria-hidden': 'true' } }),
          h('span', { class: 'arc-pos', text: String(index + 1) }),
          dot,
          h('span', { class: 'arc-name', text: row.name }),
        );
      }),
    );
    if (rows.length === 0) list.replaceChildren(h('li', { class: 'admin-empty', text: arcOrderCopy.empty }));
  };
  const load = async () => {
    rows = await deps.api.arcRead();
    if (!deps.disposed()) paint();
  };
  let stop: (() => void) | null = null;
  stop = dragOrder(list, {
    rows: () => [...list.querySelectorAll<HTMLElement>('.arc-row')],
    idOf: (row) => row.dataset.id ?? '',
    onOrder: (ids) => {
      const before = rows;
      rows = ids.map((id) => rows.find((r) => r.characterId === id)!).filter(Boolean);
      // the numbers follow the rows at once; the server then says what it saved
      rows = rows.map((row, index) => ({ ...row, position: index + 1 }));
      paint();
      void deps.run(async () => {
        try {
          rows = await deps.api.arcSave(ids);
          deps.toast(arcOrderCopy.saved, 'ok');
        } catch (error) {
          rows = before;
          deps.toast('首页顺序没有保存，已恢复。', 'warn');
          throw error;
        } finally {
          if (!deps.disposed()) paint();
        }
      });
    },
    handle: '.arc-grip',
    announce: (row, to, total) => {
      row.setAttribute(
        'aria-label',
        `${row.querySelector('.arc-name')?.textContent ?? ''}，${arcOrderCopy.position(to + 1)} / ${total}`,
      );
    },
  });
  close.addEventListener('click', () => {
    panel.hidden = true;
  });
  return {
    open: () => {
      panel.hidden = false;
      void deps.run(load);
    },
    close: () => {
      panel.hidden = true;
    },
    isOpen: () => !panel.hidden,
    dispose: () => stop?.(),
  };
}
