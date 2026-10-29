import { h } from './h.ts';

/**
 * The first-time guide of the chat's ⋯ menu (Part 21f): one small bubble pointing at the button. Tapping the bubble or
 * opening the menu dismisses it for good. The dismissal is remembered in localStorage; if storage is unavailable the bubble
 * is shown at most once per page load.
 */
export const GUIDE_KEY = 'fakebubble.chat-menu-guide.v1';
export const guideCopy = {
  withPicker: '点这里可以切换回复模型，或和角色一起共创',
  guest: '点这里可以和角色一起共创',
};

let shownThisLoad = false;
/** Test hook: a fresh page load. */
export const resetChatGuide = () => {
  shownThisLoad = false;
};
const stored = () => {
  try {
    return globalThis.localStorage?.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
};
const remember = () => {
  try {
    globalThis.localStorage?.setItem(GUIDE_KEY, '1');
  } catch {
    /* storage is off: the once-per-load flag below is all there is */
  }
};

/**
 * Prepares the bubble for one chat header. `show()` is called when that chat is opened; it does nothing once the guide has
 * been dismissed (or shown on this page load). `text` is read when it is shown so it follows what the player can do.
 */
export function mountChatGuide(button: HTMLElement, host: HTMLElement, text: () => string) {
  let bubble: HTMLElement | null = null;
  const dismiss = () => {
    remember();
    shownThisLoad = true;
    bubble?.remove();
    bubble = null;
    host.classList?.remove?.('has-guide');
    button.removeEventListener('click', dismiss);
  };
  return {
    show() {
      if (bubble || shownThisLoad || stored()) return;
      shownThisLoad = true;
      bubble = h('button', {
        class: 'chat-guide',
        text: text(),
        attrs: { type: 'button', role: 'status' },
      });
      bubble.addEventListener('click', dismiss);
      button.addEventListener('click', dismiss);
      host.append(bubble);
      // The chat's first line (X已添加了你) moves down while the bubble hangs under the header, so both can be read (Part 25b).
      host.classList?.add?.('has-guide');
    },
    dismiss,
    isShown: () => bubble !== null,
  };
}
