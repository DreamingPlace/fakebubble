/**
 * Part 46: a chat or a sheet that is open is a "layer", and the system back (Android gesture, iOS edge swipe, the browser's back button
 * and its trackpad swipe) closes the TOP layer instead of leaving the site.
 *
 *  - A layer pushes exactly ONE history entry when it opens, and only because the player opened it (callers are click / key handlers:
 *    nothing here pushes on load or on its own, so there is no back-button trap on the home cards).
 *  - Closing a layer IN the app (its back arrow, Escape, a tap on the scrim) takes its entry off again (`history.go(-n)`): no entry
 *    stacks up and none is left behind. Layers above it close with it.
 *  - The system back closes the top layer in the app and takes nothing off again (the browser already did).
 *  - While one of our own `history.go` calls is still on its way, a new layer waits for its popstate before it pushes, so the late
 *    traversal can never land on the entry of the layer that was just opened.
 */
interface Layer {
  onBack: () => void;
  pushed: boolean;
}
const stack: Layer[] = [];
let pending = 0; // our own history.go calls whose popstate has not come yet

const flush = () => {
  if (pending) return;
  for (const layer of stack)
    if (!layer.pushed) {
      history.pushState({ bbLayer: true }, '');
      layer.pushed = true;
    }
};

const release = (layer: Layer) => {
  const at = stack.indexOf(layer);
  if (at < 0) return; // already closed (by the system back, or with a layer below it)
  const closing = stack.splice(at);
  for (const above of closing.slice(1).reverse()) above.onBack();
  const pushed = closing.filter((l) => l.pushed).length;
  if (pushed) {
    pending += 1;
    history.go(-pushed);
  }
};

/** Open a layer. `onBack` closes it in the app (it must not call the returned release itself). Returns what an in-app close calls. */
export function pushBackLayer(onBack: () => void) {
  const layer: Layer = { onBack, pushed: false };
  stack.push(layer);
  flush();
  return () => release(layer);
}

if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    if (pending) {
      pending -= 1;
      flush();
      return;
    }
    stack.pop()?.onBack();
  });
