import { h } from '../../cocreation/h.ts';
import type { BadgeTone } from './status-badge.ts';

/** Short, non-blocking messages in the bottom-right corner. The region is a polite live region. */
export function toastHost(parent: HTMLElement, options: { ttlMs?: number } = {}) {
  const region = h('div', { class: 'admin-toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  parent.append(region);
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const ttl = options.ttlMs ?? 4000;
  return {
    region,
    /** `action` is one link-button in the toast (查看): the toast then stays longer, so there is time to use it. */
    show(text: string, tone: BadgeTone = 'info', action?: { label: string; run: () => void }) {
      // One at a time: a new message replaces the one on screen.
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      region.replaceChildren();
      const toast = h('div', { class: 'admin-toast', attrs: { 'data-tone': tone } }, h('span', { text }));
      if (action) {
        const go = h('button', { class: 'admin-toast-action', text: action.label, attrs: { type: 'button' } });
        go.addEventListener('click', () => {
          action.run();
          toast.remove();
        });
        toast.append(go);
      }
      region.append(toast);
      const timer = setTimeout(
        () => {
          timers.delete(timer);
          toast.remove();
        },
        action ? Math.max(ttl, 10_000) : ttl,
      );
      timers.add(timer);
      return toast;
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      region.replaceChildren();
    },
  };
}
