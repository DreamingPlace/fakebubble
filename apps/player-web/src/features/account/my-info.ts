/**
 * 我的信息 (Part 22a): the one page behind the top bar's nickname button. It replaces the account dropdown and holds what the
 * dropdown and the 邀请码 button used to: 资料, 额度, 安全, 退出登录 and (separated) 删除我的账号.
 * Rows are plain: a label, a value, at most one button. No helper lines under them (Part 21i).
 *
 * Nothing here is persisted and nothing is parsed as HTML (the `h` builder uses textContent). The caller supplies what each row
 * does; this file only lays it out, so it can be driven by a test without a page.
 */
import type { ModelChoiceInfo, PlayerPlan } from '../../../../../packages/contracts/player-models.ts';
import type { AccountTier } from '../../services/provider-api.ts';
import { h } from '../cocreation/h.ts';
import { playerPrefs, type PlayerPrefs, type ThemePref } from '../prefs/player-prefs.ts';
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
  registered: '注册玩家',
  invitedUnlimited: '邀请 · 不限量',
  invitedRefill: (n: number) => `邀请 · 每天 +${n} 点`,
  trial: '体验中',
  /** Part 25a: the 额度 block's tier pill for an invitation (the refill amount and the end date have their own places). */
  invited: '邀请',
  points: '点',
  times: '次',
  perDay: (n: number) => `/ 每天 +${n}`,
  forever: '∞',
  foreverLabel: '长期有效',
  expiresLabel: (date: string) => `到期 ${date}`,
  billing: '消费记录',
  enterCode: '输入邀请码',
  unlimited: '不限量',
  password: '修改密码',
  logoutOthers: '退出其他设备',
  logoutOthersDone: '已退出其他设备',
  logoutOthersFailed: '没能退出其他设备，稍后再试试',
  logout: '退出登录',
  logoutFailed: '没能退出登录，稍后再试试',
  signupFirst: '注册后即可使用邀请码',
  signup: '注册',
  login: '登录',
  loginOrSignup: '登录 / 注册',
  clear: '清除本设备的体验数据',
  /** Part 25b: night mode. The first choice follows the system's own setting. */
  display: '显示模式',
  themes: [
    ['system', '跟随系统'],
    ['light', '日间'],
    ['dark', '夜间'],
  ] as const satisfies readonly (readonly [ThemePref, string])[],
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
  /** The server's EFFECTIVE tier. The principal kind plays no part here. */
  tier: AccountTier | undefined;
  modelChoice: ModelChoiceInfo | undefined;
}): TierView {
  const { tier, modelChoice } = args;
  const plan = tier?.plan ?? modelChoice?.plan;
  const balance = modelChoice?.metered ? balanceLine(modelChoice) : null;
  if (tier?.kind === 'daily_refill' || (!tier && plan?.kind === 'daily_refill'))
    return {
      label: infoCopy.invitedRefill(plan?.dailyAmount ?? 0),
      expires: plan?.expiresAt == null ? null : utcDate(plan.expiresAt),
      quota: balance,
      unlimited: false,
    };
  if (tier?.unlimited || (!tier && plan?.kind === 'unlimited'))
    return {
      label: infoCopy.invitedUnlimited,
      expires: plan?.expiresAt == null ? null : utcDate(plan.expiresAt),
      quota: infoCopy.unlimited,
      unlimited: true,
    };
  return { label: infoCopy.registered, expires: null, quota: balance, unlimited: false };
}

/**
 * Part 25a: what the one 额度 block shows. Pure. The page decides nothing from the principal kind; `tier` is the server's effective
 * tier. Never carries the cap (the bar is the cap) and never the "约可聊" line (that stays in the top bar and the model sheet).
 */
export interface QuotaView {
  /** 注册玩家 / 邀请 / 体验中 */
  pill: string;
  /** The chip on the right: '∞' when it never ends, the UTC date when it does, nothing for a plain registered player. */
  expiry: { forever: true } | { date: string } | null;
  /** The big number, or 不限量; null when the page has no figure for this player. */
  big: string | null;
  /** 点 / 次, empty for 不限量. */
  unit: string;
  /** "/ 每天 +N": a daily-refill entitlement only. */
  daily: number | null;
  /** How full the bar is (0-100): balance ÷ cap for a daily refill, remaining ÷ offered for a trial. No bar when null. */
  fill: number | null;
  unlimited: boolean;
}
const percent = (part: number, whole: number) => Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
export function quotaView(args: {
  tier: AccountTier | undefined;
  modelChoice: ModelChoiceInfo | undefined;
}): QuotaView {
  const { tier, modelChoice } = args;
  const plan = tier?.plan ?? modelChoice?.plan;
  const balance = modelChoice?.metered ? modelChoice.balance : null;
  const expiry = (): QuotaView['expiry'] =>
    plan?.expiresAt == null ? { forever: true } : { date: utcDate(plan.expiresAt) };
  if (tier?.kind === 'daily_refill' || (!tier && plan?.kind === 'daily_refill'))
    return {
      pill: infoCopy.invited,
      expiry: expiry(),
      big: balance === null ? null : String(balance),
      unit: infoCopy.points,
      daily: plan?.dailyAmount ?? 0,
      fill: balance !== null && plan?.cap ? percent(balance, plan.cap) : null,
      unlimited: false,
    };
  if (tier?.unlimited || (!tier && plan?.kind === 'unlimited'))
    return {
      pill: infoCopy.invited,
      expiry: expiry(),
      big: infoCopy.unlimited,
      unit: '',
      daily: null,
      fill: null,
      unlimited: true,
    };
  return {
    pill: infoCopy.registered,
    expiry: null,
    big: balance === null ? null : String(balance),
    unit: infoCopy.points,
    daily: null,
    fill: null,
    unlimited: false,
  };
}
/** A guest's trial: the replies it has left, and how far the bar is filled. `offered` is what the trial started with. */
export function trialQuotaView(args: { remaining: number; offered: number; endsAt: number | null }): QuotaView {
  return {
    pill: infoCopy.trial,
    expiry: args.endsAt === null ? null : { date: utcDate(args.endsAt).slice(5) },
    big: String(args.remaining),
    unit: infoCopy.times,
    daily: null,
    fill: percent(args.remaining, Math.max(args.offered, args.remaining, 1)),
    unlimited: false,
  };
}

export interface MyInfoOptions {
  /** 'player' has an email login; 'guest' a trial. */
  mode: 'player' | 'guest';
  nickname: string | null;
  playerNumber: string | null;
  emailMasked: string | null;
  /** The 额度 block (Part 25a): a signed-up player's tier, or a guest's trial. Null shows the buttons only. */
  quota: QuotaView | null;
  /** The guest's trial status (the top bar's line). Read by screen readers next to the trial number. */
  trialLine: string | null;
  signupOpen: boolean;
  /** The label of the invite-code row: 输入邀请码, or 核对邀请 while a redemption still needs checking. */
  codeLabel?: string;
  /** Account deletion is available (players) / clearing this device (guests). */
  deleteEnabled: boolean;
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
  };
  /** Copy text to the clipboard; a rejection is shown as the long-press fallback. Defaults to navigator.clipboard. */
  copy?: (text: string) => Promise<void>;
  say?: (message: string) => void;
  mount?: HTMLElement;
  /** Called once when the page closes. */
  onClose?: () => void;
  /** Where the 日间 / 夜间 choice is kept (Part 25b). Defaults to this device's store. */
  prefs?: PlayerPrefs;
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

  /**
   * Part 25b: 跟随系统 / 日间 / 夜间 - three soft pills, the chosen one filled. They are radio inputs, not buttons: the arrow keys and the
   * screen reader's "1 of 3" come for free. A choice is applied at once and kept on this device.
   */
  const themeRow = () => {
    const prefs = options.prefs ?? playerPrefs();
    const pills = infoCopy.themes.map(([value, label]) => {
      const input = h('input', {
        class: 'sr-only',
        attrs: { type: 'radio', name: 'mi-theme', value, 'data-theme-pref': value },
      });
      const pill = h('label', { class: 'mi-theme-pill' }, input, h('span', { text: label }));
      input.addEventListener('change', () => {
        prefs.setTheme(value);
        mark();
      });
      return { value, input, pill };
    });
    const mark = () => {
      for (const { value, input, pill } of pills) {
        input.checked = value === prefs.theme;
        pill.className = value === prefs.theme ? 'mi-theme-pill is-on' : 'mi-theme-pill';
      }
    };
    mark();
    return h(
      'div',
      { class: 'mi-theme', attrs: { role: 'radiogroup', 'aria-label': infoCopy.display } },
      ...pills.map(({ pill }) => pill),
    );
  };

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
  }
  /** Part 25a: the one 额度 block - tier pill and expiry chip, the big number, the bar, the buttons. */
  const quotaCard = (quota: QuotaView | null, extra: { guest: boolean }, ...buttons: (HTMLElement | null)[]) => {
    const chip =
      quota?.expiry == null
        ? null
        : 'forever' in quota.expiry
          ? h(
              'span',
              { class: 'mi-chip', attrs: { 'aria-label': infoCopy.foreverLabel } },
              h('i', { text: infoCopy.forever }),
            )
          : h('span', {
              class: 'mi-chip',
              text: quota.expiry.date,
              attrs: { 'aria-label': infoCopy.expiresLabel(quota.expiry.date) },
            });
    const fill = h('span', { class: 'mi-fill' });
    fill.style.setProperty('--fill', `${quota?.fill ?? 0}%`);
    const meter =
      quota?.fill == null
        ? null
        : h(
            'div',
            {
              class: 'mi-meter',
              attrs: {
                role: 'meter',
                'aria-label': infoCopy.quota,
                'aria-valuemin': '0',
                'aria-valuemax': '100',
                'aria-valuenow': String(quota.fill),
              },
            },
            fill,
          );
    return h(
      'section',
      { class: `mi-section mi-quota-card${extra.guest ? ' is-guest' : ''}` },
      h('h3', { class: 'mi-heading', text: infoCopy.quota }),
      quota ? h('div', { class: 'mi-q-head' }, h('span', { class: 'mi-pill', text: quota.pill }), chip) : null,
      quota?.big == null
        ? null
        : h(
            'div',
            { class: 'mi-q-number' },
            h('span', { class: 'mi-big', text: quota.big }),
            quota.unit ? h('span', { class: 'mi-unit', text: quota.unit }) : null,
            quota.daily === null ? null : h('span', { class: 'mi-daily', text: infoCopy.perDay(quota.daily) }),
          ),
      extra.guest && options.trialLine ? h('span', { class: 'sr-only', text: options.trialLine }) : null,
      meter,
      h('div', { class: 'mi-q-buttons' }, ...buttons),
    );
  };
  /** A pill button of the 额度 block. `main` is the black one. */
  const pillButton = (text: string, onClick: () => void, main: boolean) =>
    button(text, `mi-pillbtn${main ? ' is-main' : ''}`, onClick);

  if (options.mode === 'guest') {
    add(
      quotaCard(
        options.quota,
        { guest: true },
        a.billing ? pillButton(infoCopy.billing, a.billing, false) : null,
        a.enterCode ? pillButton(options.codeLabel ?? infoCopy.enterCode, a.enterCode, false) : null,
        pillButton(infoCopy.signup, a.signup, true),
        pillButton(infoCopy.login, a.login, false),
      ),
      h('p', { class: 'mi-signup-first', text: infoCopy.signupFirst }),
      themeRow(),
    );
    if (options.deleteEnabled)
      add(h('div', { class: 'mi-danger' }, button(infoCopy.clear, 'acct-danger', a.clearDevice)));
  } else {
    add(
      quotaCard(
        options.quota,
        { guest: false },
        a.billing ? pillButton(infoCopy.billing, a.billing, false) : null,
        a.enterCode ? pillButton(options.codeLabel ?? infoCopy.enterCode, a.enterCode, true) : null,
      ),
      section(
        infoCopy.security,
        link(infoCopy.password, a.password),
        link(infoCopy.logoutOthers, () => void logoutOthers()),
      ),
      themeRow(),
    );
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
