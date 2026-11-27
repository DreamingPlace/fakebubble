/**
 * Part 36: the ONE long-press menu of a chat bubble (design board approved by the owner). A long press (or a right click on a desktop)
 * dims and blurs the page, lifts the bubble and springs a small menu out of it: 引用 for any bubble, 分享为卡片 for a character's voice
 * message, 👍 / 👎 for her replies. There is no explanatory text.
 *
 * Nothing here touches the audio: a voice message that is playing keeps playing while the press happens, the menu is open and an
 * action runs. The menu is an overlay: it pushes no history entry (Part 46's back and swipe handling is not involved) and closes on a
 * tap outside, Escape, scrolling or a resize.
 */
export interface MenuItem {
  key: string;
  icon: string;
  /** The visible word (引用, 分享为卡片, 语音, 内容); the thumbs show only their icon. */
  label?: string;
  /** The accessible name. */
  name: string;
  on?: boolean;
  /** Return `'stay'` to keep the menu open (the 👎 question); anything else closes it. */
  run: () => unknown;
}
export type MenuSet = (MenuItem | 'separator')[];

const svg = (path: string) =>
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
export const MENU_ICONS = {
  quote: svg('<path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/>'),
  card: svg('<rect x="4" y="3.5" width="16" height="17" rx="3.5"/><path d="M8 15.5h8M8 11.5h5"/>'),
  up: svg(
    '<path d="M7 11v9H4v-9z"/><path d="M7 11l4-7c1.6 0 2.5 1.2 2.2 2.8L12.7 10H19a2 2 0 0 1 2 2.4l-1.3 6A2 2 0 0 1 17.7 20H7"/>',
  ),
  down: svg(
    '<path d="M17 13V4h3v9z"/><path d="M17 13l-4 7c-1.6 0-2.5-1.2-2.2-2.8L11.3 14H5a2 2 0 0 1-2-2.4l1.3-6A2 2 0 0 1 6.3 4H17"/>',
  ),
  voice: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
  content: svg('<path d="M6 4h12M6 9h12M6 14h12M6 19h8"/>'),
};

export const LONG_PRESS_MS = 450;
const MOVE_LIMIT = 10;

/** Opens on a long press (touch, pen or held mouse) and on a right click. A press that opened the menu never also "clicks" what is under it. */
export function attachLongPress(target: HTMLElement, open: () => void) {
  let timer: number | null = null;
  let startX = 0;
  let startY = 0;
  let fired = false;
  const clear = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
  };
  target.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    fired = false;
    startX = event.clientX;
    startY = event.clientY;
    clear();
    timer = window.setTimeout(() => {
      timer = null;
      fired = true;
      open();
    }, LONG_PRESS_MS);
  });
  target.addEventListener('pointermove', (event) => {
    if (timer !== null && Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_LIMIT) clear();
  });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave'] as const) target.addEventListener(type, clear);
  target.addEventListener('scroll', clear, true);
  // The release of a long press must not play the voice or toggle the transcript under the finger.
  target.addEventListener(
    'click',
    (event) => {
      if (!fired) return;
      fired = false;
      event.preventDefault();
      event.stopPropagation();
    },
    true,
  );
  target.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    if (!fired) open();
  });
}

/**
 * A copy of a row. A `style` attribute that is COPIED is parsed as markup, which the page's content security policy refuses (WebKit
 * says so in the console and drops the style): so the attribute is taken off the copy and its declarations are set through the style
 * object instead, which is allowed.
 */
function cloneKeepingStyles(row: HTMLElement): HTMLElement {
  const copy = row.cloneNode(true) as HTMLElement;
  const from = [row, ...row.querySelectorAll<HTMLElement>('*')];
  const to = [copy, ...copy.querySelectorAll<HTMLElement>('*')];
  from.forEach((source, index) => {
    const target = to[index];
    if (!target || !target.hasAttribute('style')) return;
    target.removeAttribute('style');
    target.style.cssText = source.style.cssText;
  });
  return copy;
}

let closeCurrent: (() => void) | null = null;

/**
 * Lifts `row` (a copy of it, drawn in a copy of the page's own ancestors so every selector still applies) and shows `items` beside its
 * bubble. `set` may be replaced while the menu is open (the 👎 question).
 */
export function openMessageMenu(row: HTMLElement, bubbleSelector: string, initial: MenuSet, onClosed?: () => void) {
  closeCurrent?.();
  const bubble = row.querySelector<HTMLElement>(bubbleSelector) ?? row;
  const rect = row.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  const scrim = document.createElement('div');
  scrim.className = 'msg-scrim';
  // The lifted copy sits in clones of the shell and the card (display: contents), so `.page-shell .voice-bubble` and the tokens apply.
  const shell = document.querySelector<HTMLElement>('.page-shell');
  const slot = row.closest<HTMLElement>('.card-slot');
  const wrapper = document.createElement('div');
  wrapper.className = 'msg-lift-shell';
  const copyContext = (from: HTMLElement | null, to: HTMLElement) => {
    if (!from) return;
    to.className = `${to.className} ${from.className}`.trim();
    for (const attribute of Array.from(from.attributes))
      if (attribute.name.startsWith('data-')) to.setAttribute(attribute.name, attribute.value);
  };
  copyContext(shell, wrapper);
  const holder = document.createElement('div');
  holder.className = 'msg-lift-card';
  copyContext(slot, holder);
  const lifted = cloneKeepingStyles(row);
  lifted.classList.add('msg-lift');
  lifted.setAttribute('aria-hidden', 'true');
  lifted.removeAttribute('data-message-id');
  lifted.style.left = `${rect.left}px`;
  lifted.style.top = `${rect.top}px`;
  lifted.style.width = `${rect.width}px`;
  holder.append(lifted);
  wrapper.append(holder);
  const bar = document.createElement('div');
  bar.className = 'msg-menu';
  bar.setAttribute('role', 'menu');
  document.body.append(scrim, wrapper, bar);
  row.classList.add('is-lifted');
  const previous = document.activeElement as HTMLElement | null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    closeCurrent = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    scroller?.removeEventListener('scroll', close);
    const done = () => {
      scrim.remove();
      wrapper.remove();
      bar.remove();
      row.classList.remove('is-lifted');
      onClosed?.();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
    if (reduced || typeof bar.animate !== 'function') return done();
    scrim.classList.add('is-closing');
    bar.classList.add('is-closing');
    window.setTimeout(done, 140);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  const scroller = row.closest<HTMLElement>('.chat-body');
  scroller?.addEventListener('scroll', close, { passive: true });
  window.addEventListener('resize', close);
  document.addEventListener('keydown', onKey, true);
  scrim.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    close();
  });
  const render = (set: MenuSet) => {
    bar.replaceChildren();
    bar.setAttribute('aria-label', '消息');
    for (const entry of set) {
      if (entry === 'separator') {
        const rule = document.createElement('span');
        rule.className = 'msg-menu-rule';
        rule.setAttribute('aria-hidden', 'true');
        bar.append(rule);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'msg-menu-item';
      button.dataset.key = entry.key;
      button.dataset.on = entry.on ? 'true' : 'false';
      button.setAttribute('role', 'menuitem');
      button.setAttribute('aria-label', entry.name);
      button.innerHTML = entry.icon + (entry.label ? `<span>${entry.label}</span>` : '');
      button.addEventListener('click', () => {
        if (entry.run() !== 'stay') close();
      });
      bar.append(button);
    }
    position();
    bar.querySelector<HTMLButtonElement>('.msg-menu-item')?.focus({ preventScroll: true });
  };
  const position = () => {
    const width = bar.getBoundingClientRect().width;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - width - 12, bubbleRect.left + bubbleRect.width / 2 - width / 2),
    );
    const above = bubbleRect.top > 90;
    bar.style.left = `${left}px`;
    bar.style.top = `${above ? bubbleRect.top - 62 : bubbleRect.bottom + 12}px`;
    bar.style.setProperty('--ox', `${Math.round(bubbleRect.left + bubbleRect.width / 2 - left)}px`);
    bar.style.setProperty('--oy', above ? '100%' : '0%');
  };
  render(initial);
  closeCurrent = close;
  return { close, render };
}
