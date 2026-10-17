/**
 * 消费记录 (Part 21f): the player's own spending history, in the account sheet's frame. Points only. Newest first, the last
 * 90 days, 50 rows a page. It shows no ids and no money; the server only ever answers for the session's own principal.
 */
import type { BillingItem, BillingPage } from '../../../../../packages/contracts/player-billing.ts';
import { PLAYER_MODELS } from '../../../../../packages/contracts/player-models.ts';
import { h } from '../cocreation/h.ts';

export const billingCopy = {
  title: '消费记录',
  close: '关闭',
  quota: (total: number, used: number, balance: number) => `免费额度 ${total} 点 · 已用 ${used} · 剩余 ${balance}`,
  trial: (used: number, limit: number) => `免费试用 已用 ${used}/${limit} 条`,
  trialRow: '免费试用',
  unmetered: '你的聊天不计点',
  month: '本月消耗',
  byModel: '按模型',
  byCharacter: '按角色',
  colName: '名称',
  colReplies: '条数',
  colPoints: '点数',
  empty: '最近 90 天还没有消费记录',
  noMonth: '本月还没有消耗',
  windowNote: '只显示最近 90 天',
  loading: '正在加载…',
  failed: '没能加载，稍后再试试',
  retry: '重试',
  prev: '上一页',
  next: '下一页',
  page: (n: number) => `第 ${n} 页`,
  free: '不计点',
  failedRefund: (points: number) => (points > 0 ? `回复失败，已退还 ${points} 点` : '回复失败'),
  pending: '回复中…',
  bonus: '注册赠送',
  bonusSub: '含没用完的体验回复',
  grant: '管理员赠送',
  daily_refill: '每日补充',
  reset: '余额调整',
  voice: (on: boolean) => (on ? '语音' : '无语音'),
  backup: (chosen: string) => `（${chosen} 繁忙，已改用）`,
  unknownCharacter: '角色',
  points: (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} 点`,
};

/** The player's own clock: month/day and 24-hour time. */
export function formatBillingTime(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export interface BillingSheetOptions {
  api: { billing(page: number): Promise<BillingPage> };
  /** Display name of a character (the page already knows its catalogue). */
  name: (characterId: string) => string;
  mount?: HTMLElement;
}

/** One row of the list, as plain data so a test can read it without a layout engine. */
export function billingRow(item: BillingItem, name: (characterId: string) => string) {
  const when = formatBillingTime(item.at);
  const who = (id: string) => name(id) || billingCopy.unknownCharacter;
  switch (item.kind) {
    case 'reply': {
      const backup = item.backupFor ? billingCopy.backup(PLAYER_MODELS[item.backupFor].label) : '';
      return {
        title: `${when} · ${who(item.characterId)}`,
        sub: `${PLAYER_MODELS[item.model].label}${backup} · ${billingCopy.voice(item.voice)}`,
        points: item.free ? billingCopy.free : billingCopy.points(-item.points),
      };
    }
    case 'trial':
      return {
        title: `${when} · ${who(item.characterId)}`,
        sub: `${PLAYER_MODELS[item.model].label} · ${billingCopy.trialRow}`,
        points: billingCopy.points(0),
      };
    case 'pending':
      return {
        title: `${when} · ${who(item.characterId)}`,
        sub: `${PLAYER_MODELS[item.model].label} · ${billingCopy.pending}`,
        points: item.free ? billingCopy.free : billingCopy.points(-item.points),
      };
    case 'failed':
      return {
        title: `${when} · ${who(item.characterId)}`,
        sub: billingCopy.failedRefund(item.refunded),
        points: item.free ? billingCopy.free : billingCopy.points(0),
      };
    case 'bonus':
      return {
        title: `${when} · ${billingCopy.bonus}`,
        sub: billingCopy.bonusSub,
        points: billingCopy.points(item.points),
      };
    default:
      return { title: `${when} · ${billingCopy[item.kind]}`, sub: '', points: billingCopy.points(item.points) };
  }
}

export function openBillingSheet(options: BillingSheetOptions) {
  const mountPoint = options.mount ?? document.body;
  const opener = document.activeElement as HTMLElement | null;
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': billingCopy.close },
    text: '×',
  });
  const summary = h('div', { class: 'bl-summary' });
  const list = h('ul', { class: 'bl-list' });
  const pager = h('div', { class: 'bl-pager' });
  const status = h('p', { class: 'acct-status bl-status', attrs: { role: 'status', 'aria-live': 'polite' } });
  const sheet = h(
    'div',
    { class: 'acct-sheet bl-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bl-title' } },
    h(
      'header',
      { class: 'acct-head' },
      h('strong', { class: 'acct-title', text: billingCopy.title, attrs: { id: 'bl-title' } }),
      closeButton,
    ),
    h('div', { class: 'acct-body bl-body' }, summary, list, status, pager),
  );
  let closed = false;
  let page = 1;
  let loading = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.remove();
    document.removeEventListener?.('keydown', onKey, true);
    opener?.focus?.();
  };
  function onKey(event: Event) {
    if ((event as KeyboardEvent).key === 'Escape') close();
  }

  const table = (heading: string, rows: { name: string; replies: number; points: number }[]) =>
    h(
      'table',
      { class: 'bl-table' },
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { text: heading }),
          h('th', { text: billingCopy.colReplies }),
          h('th', { text: billingCopy.colPoints }),
        ),
      ),
      h(
        'tbody',
        {},
        ...rows.map((row) =>
          h(
            'tr',
            {},
            h('td', { text: row.name }),
            h('td', { text: String(row.replies) }),
            h('td', { text: String(row.points) }),
          ),
        ),
      ),
    );

  const render = (data: BillingPage) => {
    summary.replaceChildren(
      h('p', {
        class: 'bl-balance',
        text: data.trial
          ? billingCopy.trial(data.trial.used, data.trial.limit)
          : data.metered && data.quota
            ? billingCopy.quota(data.quota.total, data.quota.used, data.balance ?? 0)
            : billingCopy.unmetered,
      }),
    );
    if (data.metered) {
      const { byModel, byCharacter } = data.month;
      summary.append(
        h('h3', { class: 'bl-heading', text: billingCopy.month }),
        byModel.length === 0
          ? h('p', { class: 'bl-empty', text: billingCopy.noMonth })
          : h(
              'div',
              { class: 'bl-tables' },
              table(
                billingCopy.byModel,
                byModel.map((row) => ({ name: PLAYER_MODELS[row.model].label, ...row })),
              ),
              table(
                billingCopy.byCharacter,
                byCharacter.map((row) => ({
                  name: options.name(row.characterId) || billingCopy.unknownCharacter,
                  ...row,
                })),
              ),
            ),
      );
    }
    list.replaceChildren(
      ...(data.items.length === 0
        ? [h('li', { class: 'bl-empty', text: billingCopy.empty })]
        : data.items.map((item) => {
            const row = billingRow(item, options.name);
            return h(
              'li',
              { class: `bl-row is-${item.kind}` },
              h(
                'span',
                { class: 'bl-main' },
                h('span', { class: 'bl-title', text: row.title }),
                row.sub ? h('span', { class: 'bl-sub', text: row.sub }) : null,
              ),
              h('b', { class: 'bl-points', text: row.points }),
            );
          })),
      h('li', { class: 'bl-window', text: billingCopy.windowNote }),
    );
    const prev = h('button', { class: 'acct-link bl-prev', attrs: { type: 'button' }, text: billingCopy.prev });
    const next = h('button', { class: 'acct-link bl-next', attrs: { type: 'button' }, text: billingCopy.next });
    prev.disabled = data.page <= 1;
    next.disabled = !data.hasMore;
    prev.addEventListener('click', () => void load(data.page - 1));
    next.addEventListener('click', () => void load(data.page + 1));
    pager.replaceChildren(prev, h('span', { class: 'bl-page', text: billingCopy.page(data.page) }), next);
    pager.hidden = data.page <= 1 && !data.hasMore;
  };

  async function load(target: number) {
    const ticket = ++loading;
    status.textContent = billingCopy.loading;
    try {
      const data = await options.api.billing(target);
      if (closed || ticket !== loading) return;
      page = data.page;
      status.textContent = '';
      render(data);
    } catch {
      if (closed || ticket !== loading) return;
      const retry = h('button', { class: 'acct-link', attrs: { type: 'button' }, text: billingCopy.retry });
      retry.addEventListener('click', () => void load(page));
      status.replaceChildren(billingCopy.failed, ' ', retry);
    }
  }

  closeButton.addEventListener('click', close);
  document.addEventListener?.('keydown', onKey, true);
  mountPoint.append(sheet);
  closeButton.focus?.();
  const loaded = load(1);
  return { close, element: sheet, loaded };
}
