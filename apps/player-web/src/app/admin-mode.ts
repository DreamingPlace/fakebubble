import { AccountAdminApi } from '../services/account-admin-api.ts';
import { startAccountAdminPage } from '../features/admin/account-admin-page.ts';

export function canOpenAdminPage(location: Pick<Location, 'protocol'>) {
  return location.protocol === 'https:';
}

export function startAdminMode(root: HTMLElement) {
  if (!canOpenAdminPage(location)) {
    root.textContent = '管理员入口需要通过 HTTPS 打开。';
    return;
  }
  root.classList.add('local-admin-root');
  startAccountAdminPage(root, new AccountAdminApi());
}
