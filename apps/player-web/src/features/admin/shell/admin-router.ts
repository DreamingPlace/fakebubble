import { isAdminPage, type AdminPage } from './admin-nav.ts';

/** `#/characters/jojo` → { page: 'characters', id: 'jojo' }. Only characters and preview carry an id. */
export type AdminRoute = { page: AdminPage; id: string | null };
const WITH_ID: readonly AdminPage[] = ['characters', 'preview'];

export function parseRoute(hash: string): AdminRoute | null {
  const match = /^#\/([a-z]+)(?:\/([A-Za-z0-9_-]{1,128}))?\/?$/.exec(hash);
  if (!match || !isAdminPage(match[1]!)) return null;
  const page = match[1] as AdminPage;
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
