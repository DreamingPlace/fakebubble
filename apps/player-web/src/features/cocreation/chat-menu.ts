import { h } from './h.ts';

export type ChatMenuItem = {
  label: string;
  sub: string;
  disabled?: boolean;
  onSelect(): void;
};

/**
 * The small "⋯" menu of a chat header. Items are read when the menu opens, so they always reflect the current access
 * (a guest sees the co-creation entry disabled, an invited player sees it active).
 */
export function mountChatMenu(button: HTMLElement, host: HTMLElement, items: () => ChatMenuItem[]) {
  let menu: HTMLElement | null = null;
  const onDocument = (event: Event) => {
    if (menu && event.target instanceof Node && !menu.contains(event.target) && !button.contains(event.target)) close();
  };
  const onKey = (event: Event) => {
    const key = (event as KeyboardEvent).key;
    if (key === 'Escape') {
      event.stopPropagation?.();
      close();
      button.focus?.();
    }
  };
  function close() {
    if (!menu) return;
    menu.remove();
    menu = null;
    button.setAttribute('aria-expanded', 'false');
    document.removeEventListener?.('pointerdown', onDocument);
    document.removeEventListener?.('keydown', onKey, true);
  }
  function open() {
    const list = h('div', { class: 'chat-menu', attrs: { role: 'menu', 'aria-label': '更多' } });
    for (const item of items()) {
      const entry = h(
        'button',
        { class: 'chat-menu-item', attrs: { type: 'button', role: 'menuitem' } },
        h('span', { class: 'chat-menu-title', text: item.label }),
        h('span', { class: 'chat-menu-sub', text: item.sub }),
      );
      if (item.disabled) {
        entry.disabled = true;
        entry.setAttribute('aria-disabled', 'true');
      }
      entry.addEventListener('click', () => {
        if (item.disabled) return;
        close();
        item.onSelect();
      });
      list.append(entry);
    }
    host.append(list);
    menu = list;
    button.setAttribute('aria-expanded', 'true');
    document.addEventListener?.('pointerdown', onDocument);
    document.addEventListener?.('keydown', onKey, true);
    (list.querySelector('.chat-menu-item:not([disabled])') as HTMLElement | null)?.focus?.();
  }
  button.addEventListener('click', () => (menu ? close() : open()));
  return { close, isOpen: () => menu !== null };
}
