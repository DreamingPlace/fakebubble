import { h } from '../../cocreation/h.ts';

/**
 * A side panel over the content for a record that does not need its own page. The page behind keeps its place;
 * Escape or the close button closes it. The body is the only scroll region inside it.
 */
export function drawer(parent: HTMLElement, options: { title: string; onClose?: () => void; wide?: boolean }) {
  const close = h('button', { class: 'admin-secondary', text: '关闭', attrs: { type: 'button' } });
  const title = h('h3', { text: options.title });
  const body = h('div', { class: 'admin-drawer-body' });
  const panel = h(
    'aside',
    {
      class: options.wide ? 'admin-drawer admin-drawer-wide' : 'admin-drawer',
      hidden: true,
      attrs: { role: 'dialog', 'aria-label': options.title },
    },
    h('header', { class: 'admin-drawer-head' }, title, close),
    body,
  );
  const backdrop = h('div', { class: 'admin-backdrop', hidden: true });
  parent.append(backdrop, panel);
  let open = false;
  const onKey = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') api.close();
  };
  const api = {
    body,
    isOpen: () => open,
    setTitle(text: string) {
      title.textContent = text;
      panel.setAttribute('aria-label', text);
    },
    open() {
      if (open) return;
      open = true;
      panel.hidden = backdrop.hidden = false;
      document.addEventListener('keydown', onKey);
      close.focus();
    },
    close() {
      if (!open) return;
      open = false;
      panel.hidden = backdrop.hidden = true;
      document.removeEventListener('keydown', onKey);
      options.onClose?.();
    },
    dispose() {
      open = false;
      document.removeEventListener('keydown', onKey);
      panel.remove();
      backdrop.remove();
    },
  };
  close.addEventListener('click', () => api.close());
  backdrop.addEventListener('click', () => api.close());
  return api;
}
