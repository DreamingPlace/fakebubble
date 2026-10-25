import { isAdminPage, type AdminPage } from './admin-nav.ts';

/** `#/characters/jojo` → { page: 'characters', id: 'jojo' }. Only characters, preview and cocreation (the inbox filtered to one character) carry an id. */
export type AdminRoute = { page: AdminPage; id: string | null };
const WITH_ID: readonly AdminPage[] = ['characters', 'preview', 'cocreation'];

/**
 * Old deep links keep working: a page that earlier consoles knew by another name (or that moved, Part 24b-1) resolves to its
 * place today. `#/grants` (玩家授权) became 邀请与额度; `#/ops` and `#/metrics` (运营数据) became 系统状态 → 技术指标; `#/home` is 总览. The address bar is rewritten to the new place when the route is followed.
 */
export const LEGACY_ROUTES: Readonly<Record<string, AdminPage>> = {
  grants: 'invites',
  ops: 'system',
  metrics: 'system',
  home: 'overview',
};

export function parseRoute(hash: string): AdminRoute | null {
  const match = /^#\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/.exec(hash);
  if (!match) return null;
  const legacy = LEGACY_ROUTES[match[1]!];
  if (!legacy && !isAdminPage(match[1]!)) return null;
  const page = (legacy ?? match[1]) as AdminPage;
  return { page, id: match[2] && WITH_ID.includes(page) ? match[2] : null };
}
export const formatRoute = (route: AdminRoute) => `#/${route.page}${route.id ? `/${route.id}` : ''}`;
export const sameRoute = (a: AdminRoute | null, b: AdminRoute | null) => a?.page === b?.page && a?.id === b?.id;

/** The browser's address bar, behind a small seam so a page without one (and tests) simply keep the route in memory. */
export function addressBar(win: Pick<Window, 'addEventListener' | 'removeEventListener'> & Partial<Window>) {
  const location = win.location;
  const history = win.history;
  return {
    read: (): AdminRoute | null => (location ? parseRoute(location.hash) : null),
    /** Pushes an entry, so Back returns to the previous page. A no-op when the hash already is the route. */
    push(route: AdminRoute) {
      if (!location || location.hash === formatRoute(route)) return;
      location.hash = formatRoute(route);
    },
    /** Rewrites the current entry (used to undo a refused navigation without adding history). */
    replace(route: AdminRoute | null) {
      if (!location || !history) return;
      const target = route ? formatRoute(route) : '#/';
      if (location.hash !== target) history.replaceState(null, '', target);
    },
    listen(handler: () => void) {
      win.addEventListener('hashchange', handler);
      return () => win.removeEventListener('hashchange', handler);
    },
  };
}
