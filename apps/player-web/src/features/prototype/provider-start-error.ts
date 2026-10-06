import { ProviderApiError } from '../../services/provider-api.ts';

export function providerStartFailure(error: unknown) {
  if (error instanceof ProviderApiError && error.status === 401 && error.code === 'GUEST_SESSION_EXPIRED')
    return {
      title: '访客会话已过期',
      detail: '已清理失效的访客登录状态。重新进入不会恢复过期聊天，也不会重置同一网络累计的体验次数。',
      action: '重新进入访客页面',
    };
  if (error instanceof ProviderApiError && ['SESSION_EXPIRED', 'SESSION_ROTATED_RECOVERABLE'].includes(error.code))
    return {
      title: '访问会话需要恢复',
      detail: '当前身份不能继续使用。请回到原邀请兑换或恢复页面核对结果；系统没有将受邀身份替换为新访客。',
      action: '刷新核对访问状态',
    };
  return {
    title: '暂时无法连接',
    detail: '请检查网络后重试。系统没有发送消息，也没有自动重试对话。',
    action: '重新连接',
  };
}

/** A failed bootstrap never silently retries, sends, or replaces an invited identity. */
export function renderProviderStartError(root: HTMLElement, error: unknown, reload = () => location.reload()) {
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
