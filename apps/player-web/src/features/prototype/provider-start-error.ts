import { ProviderApi, ProviderApiError } from '../../services/provider-api.ts';
import { renderSignedOut, type SignedOutApi } from '../account/signed-out-page.ts';

/** A dead cookie (revoked, rotated, unknown): the page shows the normal signed-out first page, not an error. */
export const isSignedOutError = (error: unknown) =>
  error instanceof ProviderApiError && ['SESSION_EXPIRED', 'SESSION_ROTATED_RECOVERABLE'].includes(error.code);

export function providerStartFailure(error: unknown) {
  if (error instanceof ProviderApiError && error.status === 401 && error.code === 'GUEST_SESSION_EXPIRED')
    return {
      title: '访客会话已过期',
      detail: '已清理失效的访客登录状态。重新进入不会恢复过期聊天，也不会重置同一网络累计的体验次数。',
      action: '重新进入访客页面',
    };
  if (isSignedOutError(error))
    return {
      title: '你还没有登录',
      detail: '登录后可以继续之前的聊天，也可以先以访客试聊。',
      action: '以访客继续',
    };
  return {
    title: '暂时无法连接',
    detail: '请检查网络后重试。系统没有发送消息，也没有自动重试对话。',
    action: '重新连接',
  };
}

/** A failed bootstrap never silently retries, sends, or replaces an invited identity. */
export function renderProviderStartError(
  root: HTMLElement,
  error: unknown,
  reload = () => location.reload(),
  api: Pick<ProviderApi, 'regenerateRecoveryCode' | 'recoverWithRecoveryCode'> &
    Partial<SignedOutApi> = new ProviderApi(),
) {
  if (isSignedOutError(error)) {
    renderSignedOut(root, { api: api as SignedOutApi, reload });
    return;
  }
  const content = providerStartFailure(error),
    panel = document.createElement('main');
  panel.className = 'provider-start-error';
  const title = document.createElement('h1'),
    detail = document.createElement('p'),
    button = document.createElement('button');
  title.textContent = content.title;
  detail.textContent = content.detail;
  button.type = 'button';
  button.textContent = content.action;
  button.addEventListener('click', () => {
    if (button.disabled) return;
    button.disabled = true;
    reload();
  });
  panel.append(title, detail, button);
  root.replaceChildren(panel);
}
