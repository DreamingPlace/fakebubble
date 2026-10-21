/**
 * The normal first page for someone whose cookie is gone or revoked: 登录 / 注册 / 以访客继续. The server already
 * cleared the dead cookie; nothing of the dead session is shown or attached to a new guest, and a guest is created only by
 * the same bootstrap a cookieless first visit uses.
 */
import { ProviderApiError, type AccountInfo, type ProviderApi } from '../../services/provider-api.ts';
import { h } from '../cocreation/h.ts';
import { accountCopy, openAccountSheet, type AccountApi, type AccountSheetMode, type Timers } from './account-sheet.ts';

export const signedOutCopy = {
  title: '你还没有登录',
  detail: '登录后可以继续之前的聊天，也可以先以访客试聊。',
  login: '登录',
  signup: '注册',
  guest: '以访客继续',
  working: '请稍候…',
  failed: '网络不太稳定，稍后再试试。',
  /** Shown when the guest's trial AND its 7-day grace period are over (flag GUEST_GRACE_ENABLED). */
  expired: '之前的体验聊天已过期',
  humanFailed: '人机验证没通过，请再试一次。',
  humanDown: '验证服务暂时不可用，请稍后再试。',
  terms: '用户协议',
  privacy: '隐私政策',
} as const;

export type SignedOutApi = AccountApi & Pick<ProviderApi, 'account' | 'bootstrap'>;

export function renderSignedOut(
  root: HTMLElement,
  options: {
    api: SignedOutApi;
    reload?: () => void;
    timers?: Timers;
    mount?: HTMLElement;
    doneMs?: number;
    /** The trial and its grace period ended: say that the earlier trial chats have expired. */
    expired?: boolean;
    /** The account was just erased on this page: the first page names that instead of "你还没有登录". */
    erased?: string;
  },
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
  let legal = false;
  let bonus = 0;
  const legalLinks = h('p', { class: 'legal-links signed-out-legal', hidden: true });
  const panel = h(
    'main',
    { class: 'provider-start-error signed-out-page' },
    h('h1', { text: signedOutCopy.title }),
    options.erased ? h('p', { class: 'signed-out-erased', text: options.erased, attrs: { role: 'status' } }) : null,
    options.expired
      ? h('p', { class: 'signed-out-expired', text: signedOutCopy.expired, attrs: { role: 'status' } })
      : null,
    h('p', { text: signedOutCopy.detail }),
    h('div', { class: 'signed-out-actions' }, loginButton, signupButton, guestButton),
    notice,
    legalLinks,
  );
  root.replaceChildren(panel);
  // Whether signup is open decides what 注册 / 忘记密码 say; a failed read keeps it closed and login still works.
  const known = api.account().then(
    (info: AccountInfo) => {
      signupEnabled = info.signupEnabled;
      legal = info.features?.legal === true;
      bonus = info.features?.signupBonus ?? 0;
      if (legal)
        legalLinks.replaceChildren(
          h('a', { text: signedOutCopy.terms, attrs: { href: '/terms.html', target: '_blank', rel: 'noopener' } }),
          ' · ',
          h('a', { text: signedOutCopy.privacy, attrs: { href: '/privacy.html', target: '_blank', rel: 'noopener' } }),
        );
      legalLinks.hidden = !legal;
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
      legal,
      ...(bonus ? { bonus } : {}),
      ...(mode === 'signup' && options.expired ? { notice: signedOutCopy.expired } : {}),
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
          : error instanceof ProviderApiError &&
              (error.code === 'TURNSTILE_FAILED' || error.code === 'TURNSTILE_REQUIRED')
            ? signedOutCopy.humanFailed
            : error instanceof ProviderApiError && error.code === 'TURNSTILE_UNAVAILABLE'
              ? signedOutCopy.humanDown
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
  return { panel, ready: known };
}
