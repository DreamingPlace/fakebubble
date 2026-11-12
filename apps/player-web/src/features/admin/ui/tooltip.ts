/**
 * Hover help (Part 24b-4): one light bubble (white card, hairline, soft shadow, #2B2833 text) shown to the LOWER RIGHT of the
 * pointer (or of the anchor for keyboard focus), never a black box and never on top of the item it explains. The bubble is
 * an ordinary child of the anchor (role=tooltip, wired with aria-describedby by the caller) and is placed with two custom
 * properties, so the CSP's no-inline-style rule holds.
 */
const GAP_X = 14;
const GAP_Y = 18;

/** `anchor` must be position:relative (the console CSS does that for `.has-tip`); `tip` is the bubble inside it. */
export function bindTip(
  anchor: HTMLElement,
  tip: HTMLElement,
  focusTarget: HTMLElement = anchor,
  /**
   * Part 27: `viewport` for an anchor inside a scrolling box (a table that scrolls sideways clips an absolutely placed bubble at its
   * own edge). The bubble is then fixed to the viewport, to the lower right of the pointer, shifted left when it would leave the
   * right edge and flipped above the pointer when it would leave the bottom - so it is always whole.
   */
  viewport = false,
) {
  // Stub DOMs in component tests have no classList; a real browser always does.
  anchor.classList?.add('has-tip');
  tip.classList?.add('ad-tip');
  tip.setAttribute('role', 'tooltip');
  if (viewport) tip.classList?.add('is-fixed');
  const placeInViewport = (clientX: number, clientY: number) => {
    const width = tip.offsetWidth || 240;
    const height = tip.offsetHeight || 40;
    const room = 8;
    const wide = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const high = typeof window !== 'undefined' ? window.innerHeight : 800;
    const left = Math.max(room, Math.min(clientX + GAP_X, wide - width - room));
    let top = clientY + GAP_Y;
    if (top + height > high - room) top = Math.max(room, clientY - height - 10);
    // `position: fixed` is relative to the viewport unless an ancestor has a transform / filter / containment: measure where 0,0
    // lands and subtract it, so the bubble is at the wanted viewport point whatever box it is fixed to.
    tip.style?.setProperty('--tip-x', '0px');
    tip.style?.setProperty('--tip-y', '0px');
    const origin = tip.getBoundingClientRect?.();
    tip.style?.setProperty('--tip-x', `${Math.round(left - (origin?.left ?? 0))}px`);
    tip.style?.setProperty('--tip-y', `${Math.round(top - (origin?.top ?? 0))}px`);
  };
  const place = (x: number, y: number) => {
    // x / y are relative to the anchor; keep the bubble inside the anchor's card on the right.
    const box = anchor.getBoundingClientRect?.();
    const card = anchor.closest?.('.ad-tip-bounds, .wb-preview, .admin-member, .cs-card, .system-section') as
      | HTMLElement
      | null
      | undefined;
    const limit = card?.getBoundingClientRect?.();
    let left = x + GAP_X;
    const width = tip.offsetWidth || 240;
    if (box && limit) left = Math.min(left, limit.right - box.left - width - 8);
    tip.style?.setProperty('--tip-x', `${Math.max(0, Math.round(left))}px`);
    tip.style?.setProperty('--tip-y', `${Math.round(y + GAP_Y)}px`);
  };
  anchor.addEventListener('mousemove', (event) => {
    const box = anchor.getBoundingClientRect?.();
    if (!box) return;
    const e = event as MouseEvent;
    if (viewport) placeInViewport(e.clientX, e.clientY);
    else place(e.clientX - box.left, e.clientY - box.top);
  });
  anchor.addEventListener('mouseenter', (event) => {
    const box = anchor.getBoundingClientRect?.();
    const e = event as MouseEvent;
    if (box && typeof e.clientX === 'number') {
      if (viewport) placeInViewport(e.clientX, e.clientY);
      else place(e.clientX - box.left, e.clientY - box.top);
    }
  });
  focusTarget.addEventListener('focus', () => {
    // Keyboard: just below and to the right of the focused control.
    const box = anchor.getBoundingClientRect?.();
    const at = focusTarget.getBoundingClientRect?.();
    if (viewport && at) placeInViewport(at.right - GAP_X + 6, at.bottom - GAP_Y + 4);
    else if (box && at) place(at.right - box.left - GAP_X + 6, at.bottom - box.top - GAP_Y + 4);
  });
  return tip;
}
