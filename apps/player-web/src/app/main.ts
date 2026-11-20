import { LiveBinding } from '../features/prototype/provider-binding.js';
import { startPrototype } from '../features/prototype/preview.js';
import { renderProviderStartError } from '../features/prototype/provider-start-error.js';
import { ProviderApi } from '../services/provider-api.js';
import { turnstileCheck } from '../services/turnstile-widget.js';
import { playerPrefs } from '../features/prefs/player-prefs.ts';
import { startTheme } from '../features/prefs/theme.ts';

const root = document.getElementById('app');
if (!root) throw new Error('APP_ROOT_MISSING');
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
// Part 45: /s/<token> is a shared voice card. It needs no sign-in: the page asks the public share route and nothing else (no
// bootstrap, so no guest session is made for a visitor who only opens a link).
const shared = /^\/s\/([A-Za-z0-9_-]{32})$/.exec(location.pathname);
if (shared) {
  startTheme(playerPrefs());
  if (/Android/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'android';
  void import('../features/share/share-page.js').then((module) => module.startSharePage(root, shared[1]!));
} else if (mode === 'provider-admin') {
  void import('./admin-mode.js')
    .then((module) => module.startAdminMode(root))
    .catch(() => {
      root.textContent = '管理入口未能加载，请查看构建状态。';
    });
} else if (mode === 'provider') {
  // Night mode (Part 25b) belongs to the player pages only: the administrator console never reads it.
  startTheme(playerPrefs());
  // Part 41: Android Chrome rasterises blend modes over the large animated card layers as flat colour blocks; the page marks itself so
  // the stylesheet can fall back to plain compositing there (desktop and iOS are untouched).
  if (/Android/i.test(navigator.userAgent)) document.documentElement.dataset.platform = 'android';
  // One API object for the whole page: its CSRF token follows bootstrap, login and the signed-out first page.
  const api = new ProviderApi();
  // Only used when the server answers TURNSTILE_REQUIRED (the flag is off by default): then a token is fetched silently.
  api.setHumanCheck(turnstileCheck());
  void LiveBinding.connect(api)
    .then((binding) => startPrototype(root, binding))
    .catch((error) => {
      renderProviderStartError(root, error, undefined, api);
    });
} else {
  // The bare URL (and any other mode) opens the player: there is no other entry point.
  params.set('mode', 'provider');
  location.replace(`${location.pathname}?${params.toString()}`);
}
