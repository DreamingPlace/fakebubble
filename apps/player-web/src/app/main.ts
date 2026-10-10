import { startPrototype } from '../features/prototype/preview.js';
import { renderProviderStartError } from '../features/prototype/provider-start-error.js';
import { ProviderApi } from '../services/provider-api.js';

const root = document.getElementById('app');
if (!root) throw new Error('APP_ROOT_MISSING');
const mode = new URLSearchParams(location.search).get('mode');
if (mode === 'local-2' || mode === 'local-3') {
  void import('./local-mode.js')
    .then((module) => (mode === 'local-3' ? module.startLocal3Mode(root) : module.startLocalMode(root)))
    .catch(() => {
      root.textContent = '本机合成业务入口未能加载，请查看构建状态。';
    });
} else if (mode === 'local-3-admin' || mode === 'provider-admin') {
  void import('./admin-mode.js')
    .then((module) => module.startAdminMode(root, mode === 'provider-admin'))
    .catch(() => {
      root.textContent = '本机合成管理入口未能加载，请查看构建状态。';
    });
} else if (mode === 'provider') {
  // One API object for the whole page: its CSRF token follows bootstrap, login and the signed-out first page.
  const api = new ProviderApi();
  void import('../features/prototype/provider-binding.js')
    .then(async (module) => {
      startPrototype(root, await module.LiveBinding.connect(api));
    })
    .catch((error) => {
      renderProviderStartError(root, error, undefined, api);
    });
} else startPrototype(root);
