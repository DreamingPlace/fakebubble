import { SessionGate } from '../features/prototype/session-gate.js';
import { mountVerifySheet } from '../features/prototype/verify-sheet.js';
import { bootPlayer } from '../features/prototype/first-paint.js';
import { ProviderApi } from '../services/provider-api.js';
import { turnstileCheck, warmTurnstile } from '../services/turnstile-widget.js';
import { playerPrefs } from '../features/prefs/player-prefs.ts';
import { startTheme } from '../features/prefs/theme.ts';

const root = document.getElementById('app');
if (!root) throw new Error('APP_ROOT_MISSING');
const params = new URLSearchParams(location.search);
// The bare address (Part 48: no redirect any more) and every other mode open the player; only the console asks for its own.
const mode = params.get('mode') === 'provider-admin' ? 'provider-admin' : 'provider';
// Part 45: /s/<token> is a shared voice card. It needs no sign-in: the page asks the public share route and nothing else (no
// bootstrap, so no guest session is made for a visitor who only opens a link).
const shared = /^\/s\/([A-Za-z0-9_-]{32})$/.exec(location.pathname);

/**
 * Part 48: the console's stylesheet (the whole of main.css, in its original order) is loaded only in the administrator mode. The built
 * page names it in <meta name="admin-css">; the player pages never request it.
 */
function loadAdminStyles(): Promise<void> {
  const href = document.querySelector<HTMLMetaElement>('meta[name="admin-css"]')?.content;
  if (!href) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.onload = () => resolve();
    link.onerror = () => resolve();
    document.head.append(link);
  });
}

if (shared) {
  startTheme(playerPrefs());
  if (/Android/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'android';
  void import('../features/share/share-page.js').then((module) => module.startSharePage(root, shared[1]!));
} else if (mode === 'provider-admin') {
  void Promise.all([loadAdminStyles(), import('./admin-mode.js')])
    .then(([, module]) => module.startAdminMode(root))
    .catch(() => {
      root.textContent = '管理入口未能加载，请查看构建状态。';
    });
} else if (mode === 'provider') {
  // The player: ?mode=provider, and (Part 48) the bare address, which no longer redirects there first.
  // Night mode (Part 25b) belongs to the player pages only: the administrator console never reads it.
  startTheme(playerPrefs());
  // Part 41: Android Chrome rasterises blend modes over the large animated card layers as flat colour blocks; the page marks itself so
  // the stylesheet can fall back to plain compositing there (desktop and iOS are untouched).
  if (/Android/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'android';
  // One API object for the whole page: its CSRF token follows bootstrap, login and the signed-out first page.
  const api = new ProviderApi();
  // Part 48: the cards come first (from the public catalog); the session (bootstrap, and Turnstile when the server asks for it) is made
  // in the background right after, and the verification sheet shows only when the player does something that needs it.
  const gate = new SessionGate(api);
  const sheet = mountVerifySheet(gate);
  api.setHumanCheck(turnstileCheck({ host: sheet.widgetHost, onPhase: (phase) => gate.phase(phase) }));
  api.setHumanWarmup(() => warmTurnstile());
  bootPlayer({ root, api, gate, sheet });
}
