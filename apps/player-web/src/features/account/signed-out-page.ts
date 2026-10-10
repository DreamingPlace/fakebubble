/**
 * The normal first page for someone whose cookie is gone, revoked or rotated: 登录 / 注册 / 以访客继续, plus a small
 * 我有恢复码 link for players who have not bound an email. The server already cleared the dead cookie; nothing of the
 * dead session is shown or attached to a new guest, and a guest is created only by the same bootstrap a cookieless
 * first visit uses.
 */
import { ProviderApiError, type AccountInfo, type ProviderApi } from '../../services/provider-api.ts';
import { h } from '../cocreation/h.ts';
import { openRecoveryEntry, recoveryCopy } from '../prototype/recovery-code.ts';
import { accountCopy, openAccountSheet, type AccountApi, type AccountSheetMode, type Timers } from './account-sheet.ts';

export const signedOutCopy = {
  title: '你还没有登录',
  detail: '登录后可以继续之前的聊天，也可以先以访客试聊。',
  login: '登录',
  signup: '注册',
  guest: '以访客继续',
  working: '请稍候…',
  failed: '网络不太稳定，稍后再试试。',
} as const;

export type SignedOutApi = AccountApi &
  Pick<ProviderApi, 'account' | 'bootstrap' | 'recoverWithRecoveryCode' | 'regenerateRecoveryCode'>;

export function renderSignedOut(
  root: HTMLElement,
  options: { api: SignedOutApi; reload?: () => void; timers?: Timers; mount?: HTMLElement; doneMs?: number },
) {
  const { api } = options;
  const reload = options.reload ?? (() => location.reload());
  let signupEnabled = false;
  let busy = false;
  const notice = h('p', { class: 'signed-out-notice', attrs: { role: 'status', 'aria-live': 'polite' } });
  const loginButton = h('button', {
    class: 'signed-out-primary',
    text: signedOutCopy.login,
    attrs: { type: 'button' },
  });
  const signupButton = h('button', {
    class: 'signed-out-secondary',
    text: signedOutCopy.signup,
    attrs: { type: 'button' },
  });
  const guestButton = h('button', {
    class: 'signed-out-secondary',
    text: signedOutCopy.guest,
    attrs: { type: 'button' },
  });
  const have = h('button', {
    class: 'recovery-have signed-out-recovery',
    text: recoveryCopy.have,
    attrs: { type: 'button' },
  });
  const panel = h(
    'main',
    { class: 'provider-start-error signed-out-page' },
    h('h1', { text: signedOutCopy.title }),
    h('p', { text: signedOutCopy.detail }),
    h('div', { class: 'signed-out-actions' }, loginButton, signupButton, guestButton),
    notice,
    h('div', { class: 'signed-out-more' }, have),
  );
  root.replaceChildren(panel);
  // Whether signup is open decides what 注册 / 忘记密码 say; a failed read keeps it closed and login still works.
  const known = api.account().then(
    (info: AccountInfo) => {
      signupEnabled = info.signupEnabled;
    },
    () => {},
  );
  const shared = {
    api,
    ...(options.doneMs !== undefined ? { doneMs: options.doneMs } : {}),
    ...(options.mount ? { mount: options.mount } : {}),
    ...(options.timers ? { timers: options.timers } : {}),
  };
  const open = (mode: AccountSheetMode, extra: { onDone?: () => void; onCancel?: () => void } = {}) =>
    openAccountSheet({
      ...shared,
      mode,
      signupEnabled,
      onDone: extra.onDone ?? reload,
      ...(extra.onCancel ? { onCancel: extra.onCancel } : {}),
      onSwitch: (to) => {
        if (to === 'reset') open('reset', { onDone: reload });
        else void startSignup();
      },
    });
  // A new guest exists only through the same bootstrap a cookieless first visit uses.
  const newGuest = async () => {
    await api.abandonSession();
    await api.bootstrap();
  };
  const guard = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    notice.textContent = '';
    try {
      await work();
    } catch (error) {
      notice.textContent =
        error instanceof ProviderApiError && error.status === 429
          ? accountCopy.wait(error.retryAfterMs ?? 60_000)
          : signedOutCopy.failed;
    } finally {
      busy = false;
    }
  };
  async function startSignup() {
    await known;
    if (!signupEnabled) {
      open('signup');
      return;
    }
    await guard(async () => {
      await newGuest();
      // Closing the sheet leaves the player in the guest chat they just started.
      open('signup', { onDone: reload, onCancel: reload });
    });
  }
  loginButton.addEventListener('click', () => {
    void known.then(() => open('login'));
  });
  signupButton.addEventListener('click', () => void startSignup());
  guestButton.addEventListener('click', () => {
    void guard(async () => {
      await newGuest();
      reload();
    });
  });
  have.addEventListener('click', () => openRecoveryEntry(api, reload));
  return { panel, ready: known };
}
