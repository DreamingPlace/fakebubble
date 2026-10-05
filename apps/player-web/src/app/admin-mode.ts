import { InviteAdminApi } from '../services/invite-admin-api.ts';
import { startInviteAdminPage } from '../features/admin/invite-admin-page.ts';
import { AccountAdminApi } from '../services/account-admin-api.ts';
import { startAccountAdminPage } from '../features/admin/account-admin-page.ts';

export function canOpenAdminPage(location: Pick<Location, 'protocol' | 'hostname'>, provider: boolean) {
  return location.protocol === 'https:' && (provider || location.hostname === '127.0.0.1');
}

export function startAdminMode(root: HTMLElement, provider = false) {
  if (!canOpenAdminPage(location, provider)) {
    root.textContent = provider ? '管理员入口需要通过 HTTPS 打开。' : '此入口仅供本机 HTTPS 合成管理测试。';
    return;
  }
  root.classList.add('local-admin-root');
  if (provider) startAccountAdminPage(root, new AccountAdminApi());
  else startInviteAdminPage(root, { port: new InviteAdminApi(), synthetic: false });
}
