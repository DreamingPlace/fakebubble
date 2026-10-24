/**
 * Account sheets: 注册 / 忘记密码 (email → code → password), 登录, 我的昵称 and 修改密码.
 * Nothing here is persisted: passwords and codes live in input elements only, never in storage, a URL or a log.
 * Errors show fixed Chinese lines chosen from the server's code; a raw message never reaches the page.
 */
import {
  ProviderApiError,
  type CodeChallenge,
  type EmailPurpose,
  type ProviderApi,
} from '../../services/provider-api.ts';
import { handElement } from '../brand/wordmark.ts';
import { h } from '../cocreation/h.ts';

export type AccountApi = Pick<
  ProviderApi,
  | 'requestEmailCode'
  | 'verifyEmailCode'
  | 'finishAccount'
  | 'login'
  | 'resetPassword'
  | 'changePassword'
  | 'setNickname'
  | 'abandonSession'
  | 'deleteAccount'
>;

export const accountCopy = {
  closed: '注册暂未开放',
  close: '关闭',
  signupTitle: '注册',
  signupIntro: '用邮箱注册后，换手机或浏览器也能用邮箱和密码找回你的聊天。',
  resetTitle: '忘记密码',
  resetIntro: '我们会给这个邮箱发一个 6 位验证码。验证后设置新密码，其他设备会退出登录。',
  loginTitle: '登录',
  nicknameTitle: '我的昵称',
  nicknameIntro: '角色会用这个名字称呼你。',
  passwordTitle: '修改密码',
  deleteTitle: '删除我的账号',
  deleteIntro:
    '这会立即永久删除你的账号、全部聊天记录、记忆、生成的语音、共创内容和昵称，无法恢复。若你是受邀玩家，邀请资格也会一并收回。',
  deleteConfirm: '请输入“删除”二字确认',
  deleteWord: '删除',
  deleteSubmit: '永久删除',
  deleting: '正在删除…',
  doneDelete: '账号和聊天数据已删除。谢谢你来过。',
  clearTitle: '清除本设备的体验数据',
  clearIntro:
    '这会立即永久清除这台设备上的体验聊天和记忆，无法恢复。清除后可以重新开始体验（同一网络的体验次数不会重置）。',
  clearWord: '清除',
  clearSubmit: '清除体验数据',
  clearing: '正在清除…',
  doneClear: '这台设备的体验数据已清除。',
  graceHint: '体验已结束 · 注册即可保存并找回你的聊天（7 天内）',
  legalLead: '注册即表示你同意',
  legalTerms: '《用户协议》',
  legalPrivacy: '《隐私政策》',
  legalAnd: '和',
  adult: '我已年满 18 周岁',
  reviewRetention: '聊天文字会以匿名编号再保留 180 天，用于改进角色，之后自动删除。',
  email: '邮箱',
  sendCode: '发送验证码',
  sending: '正在发送…',
  codeSent: '验证码已发送，10 分钟内有效。没收到可以看看垃圾邮件。',
  code: '验证码（6 位数字）',
  verify: '验证',
  verifying: '正在验证…',
  resend: '重新发送',
  resendIn: (seconds: number) => `${seconds} 秒后可重新发送`,
  password: '密码',
  passwordNew: '设置密码',
  passwordAgain: '再次输入密码',
  passwordMismatch: '两次输入的密码不一致',
  showPassword: '显示密码',
  hidePassword: '隐藏密码',
  passwordHint: '8 到 128 个字符',
  nickname: '昵称',
  nicknameHint: '1 到 20 个字，不能换行',
  finishSignup: '完成注册',
  finishReset: '重置密码',
  working: '请稍候…',
  loginSubmit: '登录',
  loginSwitch: '登录并切换',
  loginNoMerge: '当前访客的聊天不会合并',
  loginNoMergeSub: '登录后会切换到这个邮箱对应的聊天，现在这个访客身份的聊天会留在这台设备的访客里，不会带过去。',
  forgot: '忘记密码',
  toSignup: '没有账号？注册',
  goSignup: '去注册',
  current: '当前密码',
  next: '新密码',
  logoutOthers: '同时退出其他设备',
  save: '保存',
  done: '完成',
  doneSignup: '注册成功',
  freeUsedUp: '免费消息已用完，输入邀请码继续',
  signupForBonus: (n: number) => `注册即送 ${n} 条免费消息，可以和任何角色聊`,
  doneSignupBonus: (n: number) => `注册成功，已送你 ${n} 条免费消息`,
  signupBonusIntro: (n: number) => `注册即送 ${n} 条免费消息，可以和任何角色聊。`,
  doneReset: '密码已重置，其他设备已退出登录',
  doneNickname: '昵称已更新',
  donePassword: '密码已修改',
  errors: {
    PLAYER_SIGNUP_DISABLED: '注册暂未开放',
    PLAYER_EMAIL_INVALID: '邮箱格式不太对，检查一下再试试。',
    PLAYER_PASSWORD_INVALID: '密码需要 8 到 128 个字符。',
    PLAYER_NICKNAME_INVALID: '昵称需要 1 到 20 个字，不能有换行或特殊控制字符。',
    PLAYER_CODE_INVALID: '验证码不对或已过期。验证码输错 5 次会作废，可以重新发送。',
    PLAYER_LOGIN_INVALID: '邮箱或密码不正确',
    PLAYER_EMAIL_NOT_REGISTERED: '这个邮箱还没有注册',
    PLAYER_PASSWORD_WRONG: '密码不正确',
    PLAYER_ACCESS_REVOKED: '这个账号的邀请已被收回，不能登录。',
    PLAYER_LOGIN_EXISTS: '这个身份已经绑定过邮箱了。',
    PLAYER_LOGIN_REQUIRED: '请先登录。',
    PLAYER_EMAIL_UNAVAILABLE: '这个邮箱暂时不能使用，换一个试试。',
    PLAYER_SIGNUP_UNAVAILABLE: '当前身份不能注册。',
    PLAYER_EMAIL_DAILY_CAP: '今天的验证码发送名额已经用完，请明天再试。',
    PLAYER_SIGNUP_IP_LIMIT: '这个网络今天的注册次数已用完，请明天再试',
    AGE_CONFIRMATION_REQUIRED: '请先确认你已年满 18 周岁。',
    ACCOUNT_DELETE_CONFIRM_INVALID: '确认文字不对，请按提示输入。',
    ACCOUNT_DELETE_UNAVAILABLE: '当前身份不能这样删除，请联系我们。',
    TURNSTILE_REQUIRED: '人机验证没通过，请再试一次。',
    TURNSTILE_FAILED: '人机验证没通过，请再试一次。',
    TURNSTILE_UNAVAILABLE: '验证服务暂时不可用，请稍后再试。',
    ORIGIN_INVALID: '页面状态已变化，请刷新后再试。',
    CSRF_INVALID: '页面状态已变化，请刷新后再试。',
    SESSION_EXPIRED: '登录状态已失效，请刷新页面。',
    AUTH_REQUIRED: '登录状态已失效，请刷新页面。',
    NETWORK: '网络不太稳定，稍后再试试。',
  } as Record<string, string>,
  /** Login only (Part 21i): the owner accepts that a distinct line reveals whether an email is registered. */
  loginErrors: {
    PLAYER_EMAIL_NOT_REGISTERED: '这个邮箱还没有注册',
    PLAYER_PASSWORD_WRONG: '密码不正确',
    RATE_LIMITED: '尝试次数太多，请稍后再试',
    NETWORK: '网络异常，请重试',
  } as Record<string, string>,
  wait: (ms: number) => {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    return minutes <= 1 ? '操作太频繁了，请 1 分钟后再试。' : `操作太频繁了，请 ${minutes} 分钟后再试。`;
  },
};

/** The line shown for a failure; unknown codes become the network line, never a raw message. */
export function accountError(error: unknown) {
  if (!(error instanceof ProviderApiError)) return accountCopy.errors.NETWORK!;
  if (error.status === 429 || error.code === 'RATE_LIMITED' || error.code === 'PLAYER_RATE_LIMITED')
    return error.code === 'PLAYER_EMAIL_DAILY_CAP' || error.code === 'PLAYER_SIGNUP_IP_LIMIT'
      ? accountCopy.errors[error.code]!
      : accountCopy.wait(error.retryAfterMs ?? 60_000);
  return accountCopy.errors[error.code] ?? accountCopy.errors.NETWORK!;
}

/** The login sheet's line for a failure: the four specific cases, else the general line. */
export function loginError(error: unknown) {
  if (!(error instanceof ProviderApiError)) return accountCopy.loginErrors.NETWORK!;
  if (error.status === 429 || error.code === 'RATE_LIMITED' || error.code === 'PLAYER_RATE_LIMITED')
    return accountCopy.loginErrors.RATE_LIMITED!;
  if (error.status === 0 || error.code === 'NETWORK') return accountCopy.loginErrors.NETWORK!;
  return accountCopy.loginErrors[error.code] ?? accountError(error);
}

const passwordOk = (value: string) => {
  const bytes = new TextEncoder().encode(value).length;
  return bytes >= 8 && bytes <= 128;
};
export const nicknameOk = (value: string) => {
  const trimmed = value.trim();
  const length = [...trimmed].length;
  return length >= 1 && length <= 20 && !/[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(trimmed);
};
const emailLooksOk = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

export type Timers = {
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
};
const realTimers: Timers = {
  now: () => Date.now(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export type AccountSheetMode = 'signup' | 'reset' | 'login' | 'nickname' | 'password' | 'delete' | 'clear';
export type AccountSheetOptions = {
  api: AccountApi;
  mode: AccountSheetMode;
  /** Signup / reset need the server flag; with it off the sheet says 注册暂未开放 and offers nothing else. */
  signupEnabled?: boolean;
  /** The nickname shown in the nickname sheet. */
  nickname?: string | null;
  /** Login: this device holds a guest with chats, which a login never merges. */
  hasGuestChats?: boolean;
  /** The two legal pages are published: the signup sheet shows the consent line with both links. */
  legal?: boolean;
  /** CHAT_REVIEW_ENABLED: the delete / clear warning adds the 180-day anonymous-transcript sentence. */
  reviewRetention?: boolean;
  /** Free replies a signup gives (flag SIGNUP_BONUS_ENABLED): the signup sheet says so. */
  bonus?: number;
  /** A line shown above the signup intro (the signed-out page says the earlier trial chats have expired). */
  notice?: string;
  /** Called after success (the page usually reloads or reopens what the player was doing). */
  onDone?: (mode: AccountSheetMode) => void;
  /** Called when the sheet closes without finishing. */
  onCancel?: () => void;
  /** Login sheet: switch to the sibling flow without stacking sheets. */
  onSwitch?: (to: 'reset' | 'signup') => void;
  mount?: HTMLElement;
  timers?: Timers;
  doneMs?: number;
};

/** One modal sheet. Returns the element and a `close()`; the caller never needs to look inside. */
export function openAccountSheet(options: AccountSheetOptions) {
  const { api, mode } = options;
  const timers = options.timers ?? realTimers;
  const mount = options.mount ?? document.body;
  const flow = mode === 'signup' || mode === 'reset';
  const titles: Record<AccountSheetMode, string> = {
    signup: accountCopy.signupTitle,
    reset: accountCopy.resetTitle,
    login: accountCopy.loginTitle,
    nickname: accountCopy.nicknameTitle,
    password: accountCopy.passwordTitle,
    delete: accountCopy.deleteTitle,
    clear: accountCopy.clearTitle,
  };
  const title = h('strong', { class: 'acct-title', text: titles[mode], attrs: { id: 'acct-title' } });
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': accountCopy.close },
    text: '×',
  });
  const body = h('div', { class: 'acct-body' });
  const status = h('p', { class: 'acct-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const sheet = h(
    'div',
    {
      class: `acct-sheet acct-${mode}`,
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acct-title' },
    },
    h('header', { class: 'acct-head' }, title, closeButton),
    // Part 25a: login and signup carry the wordmark (with the logo trail) and an empty line under it, as the board's page does.
    flow || mode === 'login'
      ? h(
          'div',
          { class: 'acct-brand' },
          handElement('burbur', { size: 48, weight: 2, logo: true, label: 'Burbur', className: 'hand acct-hand' }),
          h('span', { class: 'so-blank', attrs: { 'aria-hidden': 'true' } }),
        )
      : null,
    body,
    status,
  );
  let closed = false,
    finished = false,
    busy = false,
    ticker: unknown = null;
  const stopTicker = () => {
    if (ticker !== null) timers.clearInterval(ticker);
    ticker = null;
  };
  const close = () => {
    if (closed) return;
    closed = true;
    stopTicker();
    sheet.remove();
    if (!finished) options.onCancel?.();
  };
  closeButton.addEventListener('click', close);
  sheet.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') close();
  });
  const say = (message: string) => {
    status.textContent = message;
  };
  const field = (label: string, input: HTMLInputElement, hint?: string) =>
    h(
      'label',
      { class: 'acct-field' },
      h('span', { class: 'acct-label', text: label }),
      input,
      hint ? h('span', { class: 'acct-hint', text: hint }) : null,
    );
  const input = (name: string, type: string, extra: Record<string, string> = {}) =>
    h('input', { class: 'acct-input', attrs: { name, type, ...extra } });
  /**
   * A password field with a 显示/隐藏 toggle (Part 21i; the admin page's pattern: aria-pressed and aria-controls). Returns the
   * input and the labelled field; the input is also what the forms read and clear.
   */
  let passwordFields = 0;
  const passwordField = (
    label: string,
    name: string,
    extra: Record<string, string>,
    hint?: string,
  ): { input: HTMLInputElement; field: HTMLElement } => {
    const control = input(name, 'password', { ...extra, id: `acct-pw-${++passwordFields}` });
    const toggle = h('button', {
      class: 'acct-reveal',
      text: accountCopy.showPassword,
      attrs: { type: 'button', 'aria-pressed': 'false', 'aria-controls': control.id },
    });
    toggle.addEventListener('click', () => {
      const shown = control.type === 'password';
      control.type = shown ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(shown));
      toggle.textContent = shown ? accountCopy.hidePassword : accountCopy.showPassword;
    });
    return {
      input: control,
      field: h(
        'div',
        { class: 'acct-field' },
        h('label', { class: 'acct-label', text: label, attrs: { for: control.id } }),
        h('span', { class: 'acct-pw' }, control, toggle),
        hint ? h('span', { class: 'acct-hint', text: hint }) : null,
      ),
    };
  };
  const button = (text: string, className = 'acct-primary', type = 'button') =>
    h('button', { class: className, text, attrs: { type } });
  /** Disables the controls while a call is in flight and shows the fixed failure line when it throws. */
  const run = async (
    submit: HTMLButtonElement,
    working: string,
    idle: string,
    work: () => Promise<void>,
    report: (error: unknown) => void = (error) => say(accountError(error)),
  ) => {
    if (busy || closed) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = working;
    say('');
    try {
      await work();
    } catch (error) {
      report(error);
    } finally {
      busy = false;
      submit.disabled = false;
      submit.textContent = idle;
    }
  };
  const finish = (message: string) => {
    finished = true;
    stopTicker();
    body.replaceChildren(h('p', { class: 'acct-done', text: message, attrs: { role: 'status' } }));
    say('');
    const finishNow = () => {
      if (closed) return;
      closed = true;
      sheet.remove();
      options.onDone?.(mode);
    };
    // An erasure keeps its final confirmation on screen a little longer: it is the last thing this page shows.
    const wait = options.doneMs ?? (mode === 'delete' || mode === 'clear' ? 2200 : 900);
    if (wait <= 0) finishNow();
    else {
      let elapsed = 0;
      ticker = timers.setInterval(() => {
        elapsed += 100;
        if (elapsed >= wait) {
          stopTicker();
          finishNow();
        }
      }, 100);
    }
  };

  // ---- email → code → password (signup / reset) ---------------------------------------------------------
  const emailFlow = () => {
    const purpose = mode as EmailPurpose;
    if (options.signupEnabled === false) {
      body.replaceChildren(h('p', { class: 'acct-closed', text: accountCopy.closed }));
      return;
    }
    const intro = { signup: accountCopy.signupIntro, reset: accountCopy.resetIntro }[purpose];
    const email = input('email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '254' });
    // LEGAL_PAGES_ENABLED: signing up needs the "我已年满 18 周岁" tick; it is sent once with the signup request, never stored.
    const adult = input('adult', 'checkbox', { required: '' });
    let adultTicked = false;
    let challenge: CodeChallenge | null = null;
    let sentAt = 0;
    let address = '';

    const ageCheck = purpose === 'signup' && options.legal === true;
    const stepEmail = () => {
      const send = button(accountCopy.sendCode, 'acct-primary', 'submit');
      const legal =
        purpose === 'signup' && options.legal
          ? h(
              'p',
              { class: 'acct-legal' },
              accountCopy.legalLead,
              h('a', {
                text: accountCopy.legalTerms,
                attrs: { href: '/terms.html', target: '_blank', rel: 'noopener' },
              }),
              accountCopy.legalAnd,
              h('a', {
                text: accountCopy.legalPrivacy,
                attrs: { href: '/privacy.html', target: '_blank', rel: 'noopener' },
              }),
            )
          : null;
      const form = h(
        'form',
        { class: 'acct-form' },
        purpose === 'signup' && options.notice
          ? h('p', { class: 'acct-expired', text: options.notice, attrs: { role: 'note' } })
          : null,
        h('p', { class: 'acct-intro', text: intro }),
        purpose === 'signup' && options.bonus
          ? h('p', { class: 'acct-bonus', text: accountCopy.signupBonusIntro(options.bonus) })
          : null,
        field(accountCopy.email, email),
        legal,
        ageCheck ? h('label', { class: 'acct-check acct-adult' }, adult, h('span', { text: accountCopy.adult })) : null,
        send,
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!emailLooksOk(email.value)) {
          say(accountCopy.errors.PLAYER_EMAIL_INVALID!);
          return;
        }
        if (ageCheck && !adult.checked) {
          say(accountCopy.errors.AGE_CONFIRMATION_REQUIRED!);
          return;
        }
        adultTicked = adult.checked;
        void run(send, accountCopy.sending, accountCopy.sendCode, async () => {
          address = email.value.trim();
          challenge = await api.requestEmailCode({ purpose, email: address });
          sentAt = timers.now();
          stepCode();
          say(accountCopy.codeSent);
        });
      });
      body.replaceChildren(form);
    };

    const stepCode = () => {
      const code = input('code', 'text', {
        inputmode: 'numeric',
        autocomplete: 'one-time-code',
        maxlength: '6',
        pattern: '[0-9]{6}',
      });
      const verify = button(accountCopy.verify, 'acct-primary', 'submit');
      const resend = button(accountCopy.resend, 'acct-link');
      const form = h(
        'form',
        { class: 'acct-form' },
        h('p', { class: 'acct-intro', text: address }),
        field(accountCopy.code, code),
        verify,
        resend,
      );
      const tick = () => {
        const left = Math.max(0, Math.ceil(((challenge?.resendAfterMs ?? 60_000) - (timers.now() - sentAt)) / 1000));
        resend.disabled = busy || left > 0;
        resend.textContent = left > 0 ? accountCopy.resendIn(left) : accountCopy.resend;
        if (left === 0) stopTicker();
      };
      stopTicker();
      ticker = timers.setInterval(tick, 1000);
      tick();
      resend.addEventListener('click', () => {
        // A new request counts toward the server's limits; a failed one is not retried by the page.
        void run(resend, accountCopy.sending, accountCopy.resend, async () => {
          challenge = await api.requestEmailCode({ purpose, email: address });
          sentAt = timers.now();
          code.value = '';
          say(accountCopy.codeSent);
          stopTicker();
          ticker = timers.setInterval(tick, 1000);
        }).then(tick);
      });
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!/^[0-9]{6}$/.test(code.value.trim())) {
          say(accountCopy.errors.PLAYER_CODE_INVALID!);
          return;
        }
        void run(verify, accountCopy.verifying, accountCopy.verify, async () => {
          await api.verifyEmailCode({ challengeId: challenge!.challengeId, code: code.value.trim() });
          code.value = '';
          stopTicker();
          stepDetails();
        });
      });
      body.replaceChildren(form);
    };

    const stepDetails = () => {
      const newPassword = passwordField(
        purpose === 'reset' ? accountCopy.next : accountCopy.passwordNew,
        'password',
        { autocomplete: 'new-password', maxlength: '128' },
        accountCopy.passwordHint,
      );
      const password = newPassword.input;
      // Signup asks twice (Part 21i); the match is checked here, the server still validates the password rules.
      const again =
        purpose === 'signup'
          ? passwordField(accountCopy.passwordAgain, 'password-again', {
              autocomplete: 'new-password',
              maxlength: '128',
            })
          : null;
      const mismatch = h('p', {
        class: 'acct-mismatch',
        text: accountCopy.passwordMismatch,
        attrs: { role: 'alert' },
        hidden: true,
      });
      const nickname = input('nickname', 'text', { autocomplete: 'nickname', maxlength: '40' });
      const label = { signup: accountCopy.finishSignup, reset: accountCopy.finishReset }[purpose];
      const submit = button(label, 'acct-primary', 'submit');
      const form = h(
        'form',
        { class: 'acct-form' },
        newPassword.field,
        again?.field,
        again ? mismatch : null,
        purpose === 'reset' ? null : field(accountCopy.nickname, nickname, accountCopy.nicknameHint),
        submit,
      );
      const checkMatch = () => {
        if (!again) return;
        const differs = password.value !== again.input.value;
        mismatch.hidden = !(differs && again.input.value !== '');
        submit.disabled = busy || differs;
      };
      password.addEventListener('input', checkMatch);
      again?.input.addEventListener('input', checkMatch);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (again && password.value !== again.input.value) {
          mismatch.hidden = false;
          return;
        }
        if (!passwordOk(password.value)) {
          say(accountCopy.errors.PLAYER_PASSWORD_INVALID!);
          return;
        }
        if (purpose !== 'reset' && !nicknameOk(nickname.value)) {
          say(accountCopy.errors.PLAYER_NICKNAME_INVALID!);
          return;
        }
        void run(submit, accountCopy.working, label, async () => {
          let bonus = 0;
          if (purpose === 'reset')
            await api.resetPassword({ challengeId: challenge!.challengeId, password: password.value });
          else
            bonus =
              (
                await api.finishAccount({
                  purpose,
                  challengeId: challenge!.challengeId,
                  password: password.value,
                  nickname: nickname.value.trim(),
                  ...(ageCheck ? { adult: adultTicked } : {}),
                })
              )?.bonus ?? 0;
          password.value = '';
          if (again) again.input.value = '';
          finish(
            purpose === 'signup' && bonus > 0
              ? accountCopy.doneSignupBonus(bonus)
              : { signup: accountCopy.doneSignup, reset: accountCopy.doneReset }[purpose],
          );
        });
      });
      body.replaceChildren(form);
    };
    stepEmail();
  };

  // ---- 登录 -----------------------------------------------------------------------------------------------------
  const loginForm = () => {
    const email = input('email', 'email', { autocomplete: 'username', inputmode: 'email', maxlength: '254' });
    const loginPassword = passwordField(accountCopy.password, 'password', {
      autocomplete: 'current-password',
      maxlength: '128',
    });
    const password = loginPassword.input;
    const label = options.hasGuestChats ? accountCopy.loginSwitch : accountCopy.loginSubmit;
    const submit = button(label, 'acct-primary', 'submit');
    const forgot = button(accountCopy.forgot, 'acct-link');
    const toSignup = button(accountCopy.toSignup, 'acct-link');
    // Handing over to a sibling sheet is not a cancellation: the caller must not treat it as the player giving up.
    forgot.addEventListener('click', () => {
      finished = true;
      close();
      options.onSwitch?.('reset');
    });
    toSignup.addEventListener('click', () => {
      finished = true;
      close();
      options.onSwitch?.('signup');
    });
    const notice = options.hasGuestChats
      ? h(
          'div',
          { class: 'acct-notice', attrs: { role: 'note' } },
          h('strong', { text: accountCopy.loginNoMerge }),
          h('p', { text: accountCopy.loginNoMergeSub }),
        )
      : null;
    const form = h(
      'form',
      { class: 'acct-form' },
      notice,
      field(accountCopy.email, email),
      loginPassword.field,
      submit,
      h('div', { class: 'acct-links' }, forgot, options.signupEnabled === false ? null : toSignup),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!emailLooksOk(email.value) || password.value === '') {
        say(accountCopy.errors.PLAYER_LOGIN_INVALID!);
        return;
      }
      loginPassword.field.classList.remove('has-error');
      void run(
        submit,
        accountCopy.working,
        label,
        async () => {
          await api.login({ email: email.value.trim(), password: password.value });
          password.value = '';
          finish(accountCopy.loginTitle + '成功');
        },
        (error) => {
          const message = loginError(error);
          // Part 25a: a wrong password outlines the password field (the board's red line); the message stays as it was.
          if (error instanceof ProviderApiError && error.code === 'PLAYER_PASSWORD_WRONG')
            loginPassword.field.classList.add('has-error');
          // An unregistered address is offered the way to sign up, without leaving a second sheet open.
          if (
            error instanceof ProviderApiError &&
            error.code === 'PLAYER_EMAIL_NOT_REGISTERED' &&
            options.signupEnabled !== false
          ) {
            const signup = button(accountCopy.goSignup, 'acct-link acct-goto-signup');
            signup.addEventListener('click', () => toSignup.click());
            status.replaceChildren(message, ' ', signup);
          } else say(message);
        },
      );
    });
    body.replaceChildren(form);
  };

  // ---- 我的昵称 / 修改密码 --------------------------------------------------------------------------------------
  const nicknameForm = () => {
    const nickname = input('nickname', 'text', { autocomplete: 'nickname', maxlength: '40' });
    nickname.value = options.nickname ?? '';
    const submit = button(accountCopy.save, 'acct-primary', 'submit');
    const form = h(
      'form',
      { class: 'acct-form' },
      h('p', { class: 'acct-intro', text: accountCopy.nicknameIntro }),
      field(accountCopy.nickname, nickname, accountCopy.nicknameHint),
      submit,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!nicknameOk(nickname.value)) {
        say(accountCopy.errors.PLAYER_NICKNAME_INVALID!);
        return;
      }
      void run(submit, accountCopy.working, accountCopy.save, async () => {
        await api.setNickname(nickname.value.trim());
        finish(accountCopy.doneNickname);
      });
    });
    body.replaceChildren(form);
  };
  const passwordForm = () => {
    const currentPassword = passwordField(accountCopy.current, 'current', {
      autocomplete: 'current-password',
      maxlength: '128',
    });
    const nextPassword = passwordField(
      accountCopy.next,
      'next',
      { autocomplete: 'new-password', maxlength: '128' },
      accountCopy.passwordHint,
    );
    const current = currentPassword.input,
      next = nextPassword.input;
    const others = input('logoutOthers', 'checkbox');
    const submit = button(accountCopy.save, 'acct-primary', 'submit');
    const form = h(
      'form',
      { class: 'acct-form' },
      currentPassword.field,
      nextPassword.field,
      h('label', { class: 'acct-check' }, others, h('span', { text: accountCopy.logoutOthers })),
      submit,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!passwordOk(current.value) || !passwordOk(next.value)) {
        say(accountCopy.errors.PLAYER_PASSWORD_INVALID!);
        return;
      }
      void run(submit, accountCopy.working, accountCopy.save, async () => {
        await api.changePassword({ current: current.value, next: next.value, logoutOthers: others.checked });
        current.value = '';
        next.value = '';
        finish(accountCopy.donePassword);
      });
    });
    body.replaceChildren(form);
  };

  // ---- 删除我的账号 / 清除本设备的体验数据 ---------------------------------------------------------------------------
  const eraseForm = () => {
    const withPassword = mode === 'delete';
    const erasePassword = passwordField(accountCopy.password, 'password', {
      autocomplete: 'current-password',
      maxlength: '128',
    });
    const password = erasePassword.input;
    const word = withPassword ? accountCopy.deleteWord : accountCopy.clearWord;
    const confirm = input('confirm', 'text', { autocomplete: 'off', maxlength: '8' });
    const label = withPassword ? accountCopy.deleteSubmit : accountCopy.clearSubmit;
    const submit = button(label, 'acct-primary acct-danger', 'submit');
    const form = h(
      'form',
      { class: 'acct-form acct-erase' },
      h('p', {
        class: 'acct-intro acct-warning',
        text:
          (withPassword ? accountCopy.deleteIntro : accountCopy.clearIntro) +
          (options.reviewRetention ? accountCopy.reviewRetention : ''),
      }),
      withPassword ? erasePassword.field : null,
      withPassword ? field(accountCopy.deleteConfirm, confirm) : null,
      submit,
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (withPassword && !passwordOk(password.value)) {
        say(accountCopy.errors.PLAYER_LOGIN_INVALID!);
        return;
      }
      if (withPassword && confirm.value.trim() !== word) {
        say(accountCopy.errors.ACCOUNT_DELETE_CONFIRM_INVALID!);
        return;
      }
      void run(submit, withPassword ? accountCopy.deleting : accountCopy.clearing, label, async () => {
        await api.deleteAccount({ password: withPassword ? password.value : '', confirm: word });
        password.value = '';
        finish(withPassword ? accountCopy.doneDelete : accountCopy.doneClear);
      });
    });
    body.replaceChildren(form);
  };

  if (flow) emailFlow();
  else if (mode === 'delete' || mode === 'clear') eraseForm();
  else if (mode === 'login') loginForm();
  else if (mode === 'nickname') nicknameForm();
  else passwordForm();
  mount.append(sheet);
  (sheet.querySelector('input') as HTMLElement | null)?.focus?.();
  return { element: sheet, close };
}
