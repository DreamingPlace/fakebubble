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
    show(text: string, tone: BadgeTone = 'info') {
      const toast = h('div', { class: 'admin-toast', text, attrs: { 'data-tone': tone } });
      region.append(toast);
      const timer = setTimeout(() => {
        timers.delete(timer);
        toast.remove();
      }, ttl);
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
