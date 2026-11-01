/** A canceled/vertical gesture must never turn into a carousel selection. */
export function swipeStep(dx: number, dy: number, canceled = false): number {
  return canceled || Math.abs(dx) <= 48 || Math.abs(dx) <= Math.abs(dy) * 1.15 ? 0 : dx < 0 ? 1 : -1;
}

export type VisibleViewport = { width: number; height: number; offsetTop: number; offsetLeft: number; scale: number };
export function chatViewport(viewport: VisibleViewport | null, width: number, height: number) {
  // Leave native pinch zoom alone rather than shrinking the UI to defeat magnification.
  if (viewport && Math.abs(viewport.scale - 1) > 0.01) return null;
  const w = viewport?.width ?? width,
    h = viewport?.height ?? height;
  return { width: w, height: h, top: (viewport?.offsetTop ?? 0) + h / 2, left: (viewport?.offsetLeft ?? 0) + w / 2 };
}

export function followChatViewport(page: HTMLElement) {
  const sync = () => {
    const box = chatViewport(window.visualViewport, window.innerWidth, window.innerHeight);
    if (!box) return;
    for (const [key, value] of Object.entries(box)) page.style.setProperty('--chat-' + key, value + 'px');
  };
  window.visualViewport?.addEventListener('resize', sync);
  window.visualViewport?.addEventListener('scroll', sync);
  window.addEventListener('resize', sync);
  sync();
}

/**
 * The width of the front 小卡 (Part 25b): a phone stacks the cards like the desktop does - the front card with the neighbours
 * peeking out on both sides - so the card is narrower than the screen by the width of the peek, on every size.
 */
export function stackCardWidth(viewportWidth: number) {
  return viewportWidth <= 600 ? Math.min(300, viewportWidth - 96) : Math.min(376, viewportWidth - 108);
}

/**
 * Part 25c: the stack is laid out from the width alone (--card-w, --orbit-x). A resize that keeps the width - the phone's toolbar
 * sliding in and out - changes nothing it is laid out from, so it must not re-lay the stack out under a running card transition.
 */
export function widthChanged(laidOutWidth: number, width: number): boolean {
  return laidOutWidth !== width;
}
