/**
 * Part 59: the admin pages stay where they are. Every scroller of the console (the content column, the co-creation list, a table,
 * a long editor) is a plain overflow box whose contents are replaced when something happens (a save, an adoption, a filter, a toggle:
 * `replaceChildren`, a repaint). While the contents are gone the box is shorter than its scroll position, so the BROWSER clamps the
 * position to 0, and it stays there when the new contents arrive: the page "jumps to the top" on any click.
 *
 * One observer for the whole console fixes every place at once: it remembers where the owner scrolled each box to (a scroll that
 * comes right after a change of the page is the browser's own clamp, not the owner), and after every burst of changes puts a box
 * back where it was, as far as the new contents reach. A box is forgotten 3 s after the last change (the owner's position is then
 * whatever it is). Going to another page (`reset`) starts again at the top.
 */
export function keepScroll(root: HTMLElement) {
  const want = new Map<HTMLElement, number>();
  let quietUntil = 0;
  let frame = 0;
  let settle: ReturnType<typeof setTimeout> | null = null;
  const now = () => (typeof performance === 'undefined' ? Date.now() : performance.now());
  const onScroll = (event: Event) => {
    const box = event.target;
    if (!(box instanceof HTMLElement) || !root.contains(box)) return;
    // A scroll right after the page changed is the browser clamping a box that got shorter: not what the owner did.
    if (now() < quietUntil) return;
    if (box.scrollTop > 0) want.set(box, box.scrollTop);
    else want.delete(box);
  };
  const restore = () => {
    frame = 0;
    for (const [box, top] of [...want]) {
      if (!box.isConnected) {
        want.delete(box);
        continue;
      }
      if (box.scrollTop < top) box.scrollTop = top;
    }
  };
  const observer = new MutationObserver(() => {
    quietUntil = now() + 80;
    if (!want.size) return;
    if (!frame) frame = requestAnimationFrame(restore);
    if (settle) clearTimeout(settle);
    // Long after the last change the position is simply where it is: a later, shorter page is not "restored" into.
    settle = setTimeout(() => {
      for (const box of [...want.keys()]) {
        if (!box.isConnected || box.scrollTop === 0) want.delete(box);
        else want.set(box, box.scrollTop);
      }
    }, 3000);
    (settle as { unref?: () => void }).unref?.();
  });
  root.addEventListener('scroll', onScroll, true);
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
  return {
    /** Another page was opened on purpose: every box starts at the top. */
    reset() {
      want.clear();
      for (const box of root.querySelectorAll<HTMLElement>('.admin-content')) box.scrollTop = 0;
    },
    stop() {
      observer.disconnect();
      root.removeEventListener('scroll', onScroll, true);
      if (frame) cancelAnimationFrame(frame);
      if (settle) clearTimeout(settle);
      want.clear();
    },
  };
}
