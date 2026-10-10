/**
 * Account sheets: 注册 / 绑定邮箱 / 忘记密码 (email → code → password), 登录, 我的昵称 and 修改密码.
 * Nothing here is persisted: passwords and codes live in input elements only, never in storage, a URL or a log.
 * Errors show fixed Chinese lines chosen from the server's code; a raw message never reaches the page.
 */
import {
  ProviderApiError,
  type CodeChallenge,
  type EmailPurpose,
  type ProviderApi,
} from '../../services/provider-api.ts';
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
>;

export const accountCopy = {
  closed: '注册暂未开放',
  close: '关闭',
  signupTitle: '注册',
  signupIntro: '用邮箱注册后，换手机或浏览器也能用邮箱和密码找回你的聊天。',
  bindTitle: '绑定邮箱',
  bindIntro: '绑定邮箱后，用邮箱和密码就能在其他设备登录你的聊天；绑定成功后，恢复码会失效。',
  resetTitle: '忘记密码',
  resetIntro: '我们会给这个邮箱发一个 6 位验证码。验证后设置新密码，其他设备会退出登录。',
  loginTitle: '登录',
  nicknameTitle: '我的昵称',
  nicknameIntro: '角色会用这个名字称呼你。',
  passwordTitle: '修改密码',
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
  passwordHint: '8 到 128 个字符',
  nickname: '昵称',
  nicknameHint: '1 到 20 个字，不能换行',
  finishSignup: '完成注册',
  finishBind: '完成绑定',
  finishReset: '重置密码',
  working: '请稍候…',
  loginSubmit: '登录',
  loginSwitch: '登录并切换',
  loginNoMerge: '当前访客的聊天不会合并',
  loginNoMergeSub: '登录后会切换到这个邮箱对应的聊天，现在这个访客身份的聊天会留在这台设备的访客里，不会带过去。',
  forgot: '忘记密码',
  toSignup: '没有账号？注册',
  current: '当前密码',
  next: '新密码',
  logoutOthers: '同时退出其他设备',
  save: '保存',
  done: '完成',
  doneSignup: '注册成功',
  doneBind: '邮箱已绑定',
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
    PLAYER_ACCESS_REVOKED: '这个账号的邀请已被收回，不能登录。',
    PLAYER_LOGIN_EXISTS: '这个身份已经绑定过邮箱了。',
    PLAYER_LOGIN_REQUIRED: '请先登录。',
    PLAYER_EMAIL_UNAVAILABLE: '这个邮箱暂时不能使用，换一个试试。',
    PLAYER_SIGNUP_UNAVAILABLE: '当前身份不能注册。',
    PLAYER_BIND_UNAVAILABLE: '当前身份不需要绑定邮箱。',
    PLAYER_EMAIL_DAILY_CAP: '今天的验证码发送名额已经用完，请明天再试。',
    ORIGIN_INVALID: '页面状态已变化，请刷新后再试。',
    CSRF_INVALID: '页面状态已变化，请刷新后再试。',
    SESSION_EXPIRED: '登录状态已失效，请刷新页面。',
    AUTH_REQUIRED: '登录状态已失效，请刷新页面。',
    NETWORK: '网络不太稳定，稍后再试试。',
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
    return error.code === 'PLAYER_EMAIL_DAILY_CAP'
      ? accountCopy.errors.PLAYER_EMAIL_DAILY_CAP!
      : accountCopy.wait(error.retryAfterMs ?? 60_000);
  return accountCopy.errors[error.code] ?? accountCopy.errors.NETWORK!;
}

const passwordOk = (value: string) => {
  const bytes = new TextEncoder().encode(value).length;
  return bytes >= 8 && bytes <= 128;
};
const nicknameOk = (value: string) => {
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

export type AccountSheetMode = 'signup' | 'bind' | 'reset' | 'login' | 'nickname' | 'password';
export type AccountSheetOptions = {
  api: AccountApi;
  mode: AccountSheetMode;
  /** Signup / bind / reset need the server flag; with it off the sheet says 注册暂未开放 and offers nothing else. */
  signupEnabled?: boolean;
  /** The nickname shown in the nickname sheet. */
  nickname?: string | null;
  /** Login: this device holds a guest with chats, which a login never merges. */
  hasGuestChats?: boolean;
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
  const flow = mode === 'signup' || mode === 'bind' || mode === 'reset';
  const titles: Record<AccountSheetMode, string> = {
    signup: accountCopy.signupTitle,
    bind: accountCopy.bindTitle,
    reset: accountCopy.resetTitle,
    login: accountCopy.loginTitle,
    nickname: accountCopy.nicknameTitle,
    password: accountCopy.passwordTitle,
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
  const button = (text: string, className = 'acct-primary', type = 'button') =>
    h('button', { class: className, text, attrs: { type } });
  /** Disables the controls while a call is in flight and shows the fixed failure line when it throws. */
  const run = async (submit: HTMLButtonElement, working: string, idle: string, work: () => Promise<void>) => {
    if (busy || closed) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = working;
    say('');
    try {
      await work();
    } catch (error) {
      say(accountError(error));
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
    const wait = options.doneMs ?? 900;
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

  // ---- email → code → password (signup / bind / reset) ---------------------------------------------------------
  const emailFlow = () => {
    const purpose = mode as EmailPurpose;
    if (options.signupEnabled === false) {
      body.replaceChildren(h('p', { class: 'acct-closed', text: accountCopy.closed }));
      return;
    }
    const intro = { signup: accountCopy.signupIntro, bind: accountCopy.bindIntro, reset: accountCopy.resetIntro }[
      purpose
    ];
    const email = input('email', 'email', { autocomplete: 'email', inputmode: 'email', maxlength: '254' });
    let challenge: CodeChallenge | null = null;
    let sentAt = 0;
    let address = '';

    const stepEmail = () => {
      const send = button(accountCopy.sendCode, 'acct-primary', 'submit');
      const form = h(
        'form',
        { class: 'acct-form' },
        h('p', { class: 'acct-intro', text: intro }),
        field(accountCopy.email, email),
        send,
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!emailLooksOk(email.value)) {
          say(accountCopy.errors.PLAYER_EMAIL_INVALID!);
          return;
        }
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
      const password = input('password', 'password', { autocomplete: 'new-password', maxlength: '128' });
      const nickname = input('nickname', 'text', { autocomplete: 'nickname', maxlength: '40' });
      const label = { signup: accountCopy.finishSignup, bind: accountCopy.finishBind, reset: accountCopy.finishReset }[
        purpose
      ];
      const submit = button(label, 'acct-primary', 'submit');
      const form = h(
        'form',
        { class: 'acct-form' },
        field(purpose === 'reset' ? accountCopy.next : accountCopy.passwordNew, password, accountCopy.passwordHint),
        purpose === 'reset' ? null : field(accountCopy.nickname, nickname, accountCopy.nicknameHint),
        submit,
      );
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!passwordOk(password.value)) {
          say(accountCopy.errors.PLAYER_PASSWORD_INVALID!);
          return;
        }
        if (purpose !== 'reset' && !nicknameOk(nickname.value)) {
          say(accountCopy.errors.PLAYER_NICKNAME_INVALID!);
          return;
        }
        void run(submit, accountCopy.working, label, async () => {
          if (purpose === 'reset')
            await api.resetPassword({ challengeId: challenge!.challengeId, password: password.value });
          else
            await api.finishAccount({
              purpose,
              challengeId: challenge!.challengeId,
              password: password.value,
              nickname: nickname.value.trim(),
            });
          password.value = '';
          finish({ signup: accountCopy.doneSignup, bind: accountCopy.doneBind, reset: accountCopy.doneReset }[purpose]);
        });
      });
      body.replaceChildren(form);
    };
    stepEmail();
  };

  // ---- 登录 -----------------------------------------------------------------------------------------------------
  const loginForm = () => {
    const email = input('email', 'email', { autocomplete: 'username', inputmode: 'email', maxlength: '254' });
    const password = input('password', 'password', { autocomplete: 'current-password', maxlength: '128' });
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
      field(accountCopy.password, password),
      submit,
      h('div', { class: 'acct-links' }, forgot, options.signupEnabled === false ? null : toSignup),
    );
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!emailLooksOk(email.value) || password.value === '') {
        say(accountCopy.errors.PLAYER_LOGIN_INVALID!);
        return;
      }
      void run(submit, accountCopy.working, label, async () => {
        await api.login({ email: email.value.trim(), password: password.value });
        password.value = '';
        finish(accountCopy.loginTitle + '成功');
      });
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
    const current = input('current', 'password', { autocomplete: 'current-password', maxlength: '128' });
    const next = input('next', 'password', { autocomplete: 'new-password', maxlength: '128' });
    const others = input('logoutOthers', 'checkbox');
    const submit = button(accountCopy.save, 'acct-primary', 'submit');
    const form = h(
      'form',
      { class: 'acct-form' },
      field(accountCopy.current, current),
      field(accountCopy.next, next, accountCopy.passwordHint),
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

  if (flow) emailFlow();
  else if (mode === 'login') loginForm();
  else if (mode === 'nickname') nicknameForm();
  else passwordForm();
  mount.append(sheet);
  (sheet.querySelector('input') as HTMLElement | null)?.focus?.();
  return { element: sheet, close };
}
