/**
 * Part 25b: night mode. The page follows the system's dark mode until the player picks 日间 or 夜间 in 我的信息; the pick is
 * remembered on the device. The theme is one attribute on <html> (`data-theme="light" | "dark"`): every night rule in the
 * stylesheet hangs on it, so the player pages and nothing else change.
 */
import type { PlayerPrefs, ThemePref } from './player-prefs.ts';

export type Theme = 'light' | 'dark';
/** The page's paper in each theme (the design's own: #FAF8F6 by day, #0C0B10 by night). */
export const PAPER: Record<Theme, string> = { light: '#FAF8F6', dark: '#0C0B10' };
/** The cross-fade when the theme changes while the page is open (design/burbur-v2 Motion board: 600 ms). */
export const THEME_FADE_MS = 600;

export const resolveTheme = (pref: ThemePref, systemDark: boolean): Theme =>
  pref === 'system' ? (systemDark ? 'dark' : 'light') : pref;

type SystemQuery = Pick<MediaQueryList, 'matches'> & {
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
};
const systemQuery = (): SystemQuery | null => {
  try {
    return typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
  } catch {
    return null;
  }
};

/** Applies the theme now and again whenever the pick or the system setting changes. */
export function startTheme(prefs: PlayerPrefs, query: SystemQuery | null = systemQuery()) {
  const root = document.documentElement;
  let current: Theme | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  const apply = () => {
    const next = resolveTheme(prefs.theme, query?.matches === true);
    if (next === current) return;
    const first = current === null;
    current = next;
    // The fade class lives only for the length of the cross-fade, and never on the first paint.
    if (!first) {
      root.classList?.add('theme-fade');
      clearTimeout(fadeTimer);
      fadeTimer = setTimeout(() => root.classList?.remove('theme-fade'), THEME_FADE_MS + 60);
    }
    root.setAttribute('data-theme', next);
    root.style.setProperty('color-scheme', next);
    root.style.setProperty('background-color', PAPER[next]);
    document.querySelector?.('meta[name="theme-color"]')?.setAttribute('content', PAPER[next]);
  };
  apply();
  query?.addEventListener('change', apply);
  const unsubscribe = prefs.subscribe(apply);
  return {
    current: () => current!,
    stop() {
      query?.removeEventListener('change', apply);
      unsubscribe();
      clearTimeout(fadeTimer);
    },
  };
}
