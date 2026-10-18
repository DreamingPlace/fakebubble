/**
 * 我的信息 (Part 22a): the one page behind the top bar's nickname button. It replaces the account dropdown and holds what the
 * dropdown, the 邀请码 button and the recovery-code button used to: 资料, 额度, 安全, 退出登录 and (separated) 删除我的账号.
 * Rows are plain: a label, a value, at most one button. No helper lines under them (Part 21i).
 *
 * Nothing here is persisted and nothing is parsed as HTML (the `h` builder uses textContent). The caller supplies what each row
 * does; this file only lays it out, so it can be driven by a test without a page.
 */
import type { ModelChoiceInfo, PlayerPlan } from '../../../../../packages/contracts/player-models.ts';
import { h } from '../cocreation/h.ts';
import { accountCopy, accountError, nicknameOk } from './account-sheet.ts';

export const infoCopy = {
  title: '我的信息',
  close: '关闭',
  profile: '资料',
  quota: '额度',
  security: '安全',
  nickname: '昵称',
  edit: '修改',
  save: '保存',
  cancel: '取消',
  saving: '正在保存…',
  number: '玩家编号',
  copy: '复制',
  copied: '已复制',
  copyFailed: '请长按编号复制',
  email: '邮箱',
  noEmail: '未绑定',
  bind: '绑定邮箱',
  tier: '当前身份',
  registered: '注册玩家',
  invitedUnlimited: '邀请 · 不限量',
  invitedRefill: (n: number) => `邀请 · 每天 +${n} 点`,
  trial: '体验中',
  expires: '到期',
  billing: '消费记录',
  enterCode: '输入邀请码',
  unlimited: '不限量',
  password: '修改密码',
  logoutOthers: '退出其他设备',
  logoutOthersDone: '已退出其他设备',
  logoutOthersFailed: '没能退出其他设备，稍后再试试',
  recovery: '恢复码',
  logout: '退出登录',
  logoutFailed: '没能退出登录，稍后再试试',
  signupFirst: '注册后即可使用邀请码',
  signup: '注册',
  login: '登录',
  loginOrSignup: '登录 / 注册',
  clear: '清除本设备的体验数据',
};

/** The UTC calendar date of a clock reading, 'YYYY-MM-DD'. */
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The line every metered tier shows, in the SAME words in the top bar and here. */
export const balanceLine = (info: Pick<ModelChoiceInfo, 'balance' | 'repliesLeft'>) =>
  `剩余 ${info.balance} 点 · 约可聊 ${info.repliesLeft} 条`;

/** What the player holds: the tier label, its end date and the quota line. Pure; the page and the top bar both read it. */
export interface TierView {
  /** 注册玩家 / 邀请 · 每天 +{N} 点 / 邀请 · 不限量 */
  label: string;
  /** UTC date 'YYYY-MM-DD', or null when the tier does not end. */
  expires: string | null;
  /** '剩余 {balance} 点 · 约可聊 {n} 条', or 不限量 for an unlimited tier; null when there is nothing to show. */
  quota: string | null;
  unlimited: boolean;
}
export function tierView(args: {
  /** principal kind of the session: 'guest' (also a signed-up player) or 'invite' (legacy invited player). */
  kind: string;
  modelChoice: ModelChoiceInfo | undefined;
}): TierView {
  const { kind, modelChoice } = args;
  const plan: PlayerPlan | undefined = modelChoice?.plan;
  if (plan?.kind === 'daily_refill')
    return {
      label: infoCopy.invitedRefill(plan.dailyAmount ?? 0),
      expires: plan.expiresAt === null ? null : utcDate(plan.expiresAt),
      quota: modelChoice ? balanceLine(modelChoice) : null,
      unlimited: false,
    };
  if (plan?.kind === 'unlimited' || kind === 'invite')
    return {
      label: infoCopy.invitedUnlimited,
      expires: plan?.expiresAt == null ? null : utcDate(plan.expiresAt),
      quota: infoCopy.unlimited,
      unlimited: true,
    };
  return {
    label: infoCopy.registered,
    expires: null,
    quota: modelChoice?.metered ? balanceLine(modelChoice) : null,
    unlimited: false,
  };
}

export interface MyInfoOptions {
  /** 'player' has an email login; 'guest' a trial; 'invited' a legacy invited player WITHOUT a login. */
  mode: 'player' | 'guest' | 'invited';
  nickname: string | null;
  playerNumber: string | null;
  emailMasked: string | null;
  tier: TierView | null;
  /** The guest's trial status (the top bar's line), shown as its 额度. */
  trialLine: string | null;
  signupOpen: boolean;
  /** The label of the invite-code row: 输入邀请码, or 核对邀请 while a redemption still needs checking. */
  codeLabel?: string;
  /** Account deletion is available (players) / clearing this device (guests). */
  deleteEnabled: boolean;
  canBind: boolean;
  saveNickname(value: string): Promise<void>;
  actions: {
    password(): void;
    logoutOthers(): Promise<void>;
    logout(): Promise<void>;
    deleteAccount(): void;
    clearDevice(): void;
    billing?: () => void;
    enterCode?: () => void;
    signup(): void;
    login(): void;
    bind(): void;
    recovery?: () => void;
  };
  /** Copy text to the clipboard; a rejection is shown as the long-press fallback. Defaults to navigator.clipboard. */
  copy?: (text: string) => Promise<void>;
  say?: (message: string) => void;
  mount?: HTMLElement;
  /** Called once when the page closes. */
  onClose?: () => void;
}

export function openMyInfo(options: MyInfoOptions) {
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': infoCopy.close },
    text: '×',
  });
  const status = h('p', { class: 'acct-status mi-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const body = h('div', { class: 'acct-body mi-body' });
  const sheet = h(
    'div',
    { class: 'mi-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'mi-title' } },
    h(
      'header',
      { class: 'acct-head' },
      h('strong', { class: 'acct-title', text: infoCopy.title, attrs: { id: 'mi-title' } }),
      closeButton,
    ),
    body,
    status,
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.remove();
    document.removeEventListener?.('keydown', onKey, true);
    opener?.focus?.();
    options.onClose?.();
  };
  function onKey(event: Event) {
    if ((event as KeyboardEvent).key === 'Escape') close();
  }
  const say = (message: string) => {
    status.textContent = message;
    options.say?.(message);
  };

  const button = (text: string, className: string, onClick: () => void) => {
    const node = h('button', { class: className, attrs: { type: 'button' }, text });
    node.addEventListener('click', onClick);
    return node;
  };
  /** A row: label, value, at most one button. */
  const row = (label: string, value: Node | string | null, action?: HTMLElement | null, className = '') =>
    h(
      'div',
      { class: `mi-row ${className}`.trim() },
      h('span', { class: 'mi-key', text: label }),
      value === null ? null : typeof value === 'string' ? h('span', { class: 'mi-val', text: value }) : value,
      action ?? null,
    );
  /** A row that is only a button (it opens something). */
  const link = (text: string, onClick: () => void, className = '') =>
    h(
      'div',
      { class: `mi-row mi-link ${className}`.trim() },
      button(text, 'mi-action', onClick),
      h('span', { class: 'mi-chev', text: '›', attrs: { 'aria-hidden': 'true' } }),
    );
  const section = (title: string, ...rows: (HTMLElement | null)[]) =>
    h('section', { class: 'mi-section' }, h('h3', { class: 'mi-heading', text: title }), ...rows);

  // ---- 资料 -------------------------------------------------------------------------------------------------------------
  const nicknameRow = () => {
    const value = h('span', { class: 'mi-val mi-nickname', text: options.nickname ?? '' });
    const edit = button(infoCopy.edit, 'mi-small', () => startEdit());
    const container = row(infoCopy.nickname, value, edit, 'mi-nick-row');
    function startEdit() {
      const input = h('input', {
        class: 'acct-input mi-input',
        attrs: { type: 'text', maxlength: '40', autocomplete: 'nickname', 'aria-label': infoCopy.nickname },
      });
      input.value = options.nickname ?? '';
      const save = button(infoCopy.save, 'acct-primary mi-small', () => void submit());
      const cancel = button(infoCopy.cancel, 'acct-link mi-small', () => {
        container.replaceChildren(h('span', { class: 'mi-key', text: infoCopy.nickname }), value, edit);
        status.textContent = '';
      });
      container.replaceChildren(h('span', { class: 'mi-key', text: infoCopy.nickname }), input, save, cancel);
      input.focus?.();
      async function submit() {
        const next = input.value.trim();
        if (!nicknameOk(next)) {
          status.textContent = accountCopy.errors.PLAYER_NICKNAME_INVALID!;
          return;
        }
        save.disabled = true;
        status.textContent = infoCopy.saving;
        try {
          await options.saveNickname(next);
          options.nickname = next;
          value.textContent = next;
          container.replaceChildren(h('span', { class: 'mi-key', text: infoCopy.nickname }), value, edit);
          status.textContent = accountCopy.doneNickname;
        } catch (error) {
          save.disabled = false;
          status.textContent = accountError(error);
        }
      }
    }
    return container;
  };
  const numberRow = () => {
    const copy = button(infoCopy.copy, 'mi-small mi-copy', () => {
      const text = options.playerNumber ?? '';
      const write = options.copy ?? ((t: string) => navigator.clipboard.writeText(t));
      void write(text).then(
        () => {
          copy.textContent = infoCopy.copied;
          setTimeout?.(() => {
            if (!closed) copy.textContent = infoCopy.copy;
          }, 2000);
        },
        () => {
          status.textContent = infoCopy.copyFailed;
        },
      );
    });
    return row(infoCopy.number, h('span', { class: 'mi-val mi-number', text: options.playerNumber ?? '' }), copy);
  };

  const add = (...nodes: (Node | null)[]) => body.append(...nodes.filter((node): node is Node => node !== null));

  // ---- build per mode ---------------------------------------------------------------------------------------------------
  const a = options.actions;
  if (options.mode === 'player') {
    add(
      section(
        infoCopy.profile,
        nicknameRow(),
        options.playerNumber ? numberRow() : null,
        row(infoCopy.email, options.emailMasked ?? infoCopy.noEmail),
      ),
    );
  } else if (options.mode === 'invited') {
    add(
      section(
        infoCopy.profile,
        row(infoCopy.email, infoCopy.noEmail, options.canBind ? button(infoCopy.bind, 'mi-small', a.bind) : null),
      ),
    );
  }
  if (options.mode === 'guest') {
    add(
      section(
        infoCopy.quota,
        row(infoCopy.tier, infoCopy.trial),
        options.trialLine ? row('', options.trialLine, null, 'mi-trial') : null,
        a.billing ? link(infoCopy.billing, a.billing) : null,
        a.enterCode ? link(options.codeLabel ?? infoCopy.enterCode, a.enterCode) : null,
      ),
      h(
        'section',
        { class: 'mi-section mi-guest' },
        h(
          'div',
          { class: 'mi-buttons' },
          button(infoCopy.signup, 'acct-primary', a.signup),
          button(infoCopy.login, 'acct-link mi-login', a.login),
        ),
        h('p', { class: 'mi-signup-first', text: infoCopy.signupFirst }),
      ),
    );
    if (options.deleteEnabled)
      add(h('div', { class: 'mi-danger' }, button(infoCopy.clear, 'acct-danger', a.clearDevice)));
  } else {
    const tier = options.tier;
    add(
      section(
        infoCopy.quota,
        tier ? row(infoCopy.tier, tier.label) : null,
        tier?.expires ? row(infoCopy.expires, tier.expires, null, 'mi-expires') : null,
        tier?.quota ? row('', tier.quota, null, 'mi-quota') : null,
        a.billing ? link(infoCopy.billing, a.billing) : null,
        a.enterCode ? link(options.codeLabel ?? infoCopy.enterCode, a.enterCode) : null,
      ),
      options.mode === 'player'
        ? section(
            infoCopy.security,
            link(infoCopy.password, a.password),
            link(infoCopy.logoutOthers, () => void logoutOthers()),
          )
        : a.recovery
          ? section(infoCopy.security, link(infoCopy.recovery, a.recovery))
          : null,
    );
    if (options.mode === 'player') {
      add(
        h(
          'div',
          { class: 'mi-foot' },
          button(infoCopy.logout, 'acct-link mi-logout', () => void logout()),
        ),
        options.deleteEnabled
          ? h('div', { class: 'mi-danger' }, button(accountCopy.deleteTitle, 'acct-danger', a.deleteAccount))
          : null,
      );
    }
  }
  async function logoutOthers() {
    try {
      await a.logoutOthers();
      say(infoCopy.logoutOthersDone);
    } catch {
      say(infoCopy.logoutOthersFailed);
    }
  }
  async function logout() {
    try {
      await a.logout();
    } catch {
      say(infoCopy.logoutFailed);
    }
  }

  closeButton.addEventListener('click', close);
  document.addEventListener?.('keydown', onKey, true);
  mountPoint.append(sheet);
  closeButton.focus?.();
  return { close, element: sheet };
}
