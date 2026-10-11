export const POLL_FIRST_MS = 2000;
export const POLL_MAX_MS = 10000;
export type PollerHost = {
  /** One status call; resolves how many previews are still queued or generating, and whether anything changed. */
  tick: () => Promise<{ active: number; changed: boolean }>;
  hidden: () => boolean;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onVisible?: (fn: () => void) => () => void;
  /** Gives up after this many failed calls in a row (default 5). */
  maxFailures?: number;
  onGiveUp?: () => void;
};
/**
 * One batched status call at a time, spaced 2 s -> 10 s (x1.5 per quiet call), reset to 2 s when something changed.
 * It stops by itself when nothing is queued or generating, and sleeps while the tab is hidden (a call is made at
 * once when it becomes visible again). `kick()` starts or restarts it after a submission.
 */
export function previewPoller(host: PollerHost) {
  const set = host.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clear = host.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let handle: unknown = null,
    delay = POLL_FIRST_MS,
    failures = 0,
    running = false,
    stopped = false,
    wanted = false;
  const cancel = () => {
    if (handle !== null) clear(handle);
    handle = null;
  };
  const schedule = () => {
    cancel();
    if (stopped || !wanted || host.hidden()) return;
    handle = set(() => {
      handle = null;
      void tick();
    }, delay);
  };
  async function tick() {
    if (running || stopped) return;
    if (host.hidden()) return;
    running = true;
    try {
      const { active, changed } = await host.tick();
      failures = 0;
      delay = changed ? POLL_FIRST_MS : Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
      wanted = active > 0;
    } catch {
      failures++;
      delay = Math.min(POLL_MAX_MS, delay * 2);
      if (failures >= (host.maxFailures ?? 5)) {
        wanted = false;
        host.onGiveUp?.();
      }
    } finally {
      running = false;
    }
    schedule();
  }
  const off = host.onVisible?.(() => {
    if (host.hidden()) cancel();
    else if (wanted && !running) {
      cancel();
      void tick();
    }
  });
  return {
    kick() {
      stopped = false;
      wanted = true;
      failures = 0;
      delay = POLL_FIRST_MS;
      schedule();
    },
    stop() {
      wanted = false;
      cancel();
    },
    dispose() {
      stopped = true;
      cancel();
      off?.();
    },
    isScheduled: () => handle !== null,
    delay: () => delay,
  };
}
