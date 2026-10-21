import { LiveBinding } from '../features/prototype/provider-binding.js';
import { startPrototype } from '../features/prototype/preview.js';
import { renderProviderStartError } from '../features/prototype/provider-start-error.js';
import { ProviderApi } from '../services/provider-api.js';
import { turnstileCheck } from '../services/turnstile-widget.js';

const root = document.getElementById('app');
if (!root) throw new Error('APP_ROOT_MISSING');
const params = new URLSearchParams(location.search);
const mode = params.get('mode');
if (mode === 'provider-admin') {
  void import('./admin-mode.js')
    .then((module) => module.startAdminMode(root))
    .catch(() => {
      root.textContent = '管理入口未能加载，请查看构建状态。';
    });
} else if (mode === 'provider') {
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
