/**
 * Part 27: a wait for the page to be QUIET instead of a sleep. The 24b-6 checks used to sleep 0.4-1.6 s after every step "to let it
 * settle"; most of that time nothing was happening. `quietWait(page, ms)` returns as soon as the page has been still - no DOM change
 * for 200 ms, every finite animation finished, no request in flight - and never waits longer than `ms` (the old sleep), so a step
 * that really takes the full time is no worse off. Waits under 400 ms (a frame, a hover) and over 1600 ms (a timer that has to run
 * out) stay plain sleeps.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;

const inflight = new WeakMap<object, { open: Set<object>; readonly n: number }>();
const track = (page: Page) => {
  const known = inflight.get(page);
  if (known) return known;
  const open = new Set<object>();
  const state = {
    open,
    get n() {
      return open.size;
    },
  };
  inflight.set(page, state);
  // A request cut off by a navigation never reports back, so a new main-frame navigation starts the count again.
  page.on('request', (request: object) => open.add(request));
  page.on('requestfinished', (request: object) => open.delete(request));
  page.on('requestfailed', (request: object) => open.delete(request));
  page.on('framenavigated', (frame: { parentFrame: () => unknown }) => {
    if (!frame.parentFrame()) open.clear();
  });
  return state;
};

/** Call once per page so its requests are counted from the start. */
export function watchRequests(page: Page) {
  track(page);
}

export async function quietWait(page: Page, ms: number): Promise<void> {
  if (ms < 400 || ms > 1600) return page.waitForTimeout(ms);
  const counter = track(page);
  const deadline = Date.now() + ms;
  const floor = Date.now() + 250;
  const stillFor = (left: number) =>
    page.evaluate(
      (budget: number) =>
        new Promise<boolean>((resolve) => {
          let last = performance.now();
          const observer = new MutationObserver(() => {
            last = performance.now();
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
          });
          const end = performance.now() + budget;
          const tick = () => {
            const now = performance.now();
            const animating = document
              .getAnimations()
              .some(
                (a) =>
                  a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY && a.playState === 'running',
              );
            if (!animating && now - last >= 200) {
              observer.disconnect();
              return resolve(true);
            }
            if (now >= end) {
              observer.disconnect();
              return resolve(false);
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      left,
    );
  while (Date.now() < deadline) {
    if ((await stillFor(deadline - Date.now())) && counter.n === 0 && Date.now() >= floor) return;
    if (Date.now() < floor) await page.waitForTimeout(Math.min(50, floor - Date.now()));
  }
}
