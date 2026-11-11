import { PLAYER_MODELS } from "../../../../../packages/contracts/player-models.js";
import { h } from "../cocreation/h.js";
export const billingCopy = {
    title: '消费记录',
    close: '关闭',
    quota: (total, used, balance) => `免费额度 ${total} 点 · 已用 ${used} · 剩余 ${balance}`,
    trial: (used, limit) => `免费试用 已用 ${used}/${limit} 条`,
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
    page: (n) => `第 ${n} 页`,
    free: '不计点',
    failedRefund: (points) => (points > 0 ? `回复失败，已退还 ${points} 点` : '回复失败'),
    pending: '回复中…',
    bonus: '注册赠送',
    bonusSub: '含没用完的体验回复',
    grant: '管理员发放',
    daily_refill: '每日补充',
    reset: '余额调整',
    /** Part 24c: a reward for a co-creation note, and for one that was adopted. */
    cocreation: '共创奖励',
    cocreationAdopted: '被采用',
    voice: (on) => (on ? '语音' : '无语音'),
    backup: (chosen) => `（${chosen} 繁忙，已改用）`,
    unknownCharacter: '已删除的角色',
    points: (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n)} 点`,
};
/** The player's own clock: month/day and 24-hour time. */
export function formatBillingTime(at) {
    const d = new Date(at);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** One row of the list, as plain data so a test can read it without a layout engine. */
export function billingRow(item, name) {
    const when = formatBillingTime(item.at);
    const who = (id) => name(id) || billingCopy.unknownCharacter;
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
        case 'cocreation_note':
        case 'cocreation_adopted':
            return {
                title: `${when} · ${billingCopy.cocreation}`,
                sub: item.kind === 'cocreation_adopted' ? billingCopy.cocreationAdopted : '',
                points: billingCopy.points(item.points),
            };
        default:
            return { title: `${when} · ${billingCopy[item.kind]}`, sub: '', points: billingCopy.points(item.points) };
    }
}
export function openBillingSheet(options) {
    const mountPoint = options.mount ?? document.body;
    const opener = document.activeElement;
    const closeButton = h('button', {
        class: 'acct-close icon-button',
        attrs: { type: 'button', 'aria-label': billingCopy.close },
        text: '×',
    });
    const summary = h('div', { class: 'bl-summary' });
    const list = h('ul', { class: 'bl-list' });
    const pager = h('div', { class: 'bl-pager' });
    const status = h('p', { class: 'acct-status bl-status', attrs: { role: 'status', 'aria-live': 'polite' } });
    const sheet = h('div', { class: 'acct-sheet bl-sheet', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bl-title' } }, h('header', { class: 'acct-head' }, h('strong', { class: 'acct-title', text: billingCopy.title, attrs: { id: 'bl-title' } }), closeButton), h('div', { class: 'acct-body bl-body' }, summary, list, status, pager));
    let closed = false;
    let page = 1;
    let loading = 0;
    const close = () => {
        if (closed)
            return;
        closed = true;
        sheet.remove();
        document.removeEventListener?.('keydown', onKey, true);
        opener?.focus?.();
    };
    function onKey(event) {
        if (event.key === 'Escape')
            close();
    }
    const table = (heading, rows) => h('table', { class: 'bl-table' }, h('thead', {}, h('tr', {}, h('th', { text: heading }), h('th', { text: billingCopy.colReplies }), h('th', { text: billingCopy.colPoints }))), h('tbody', {}, ...rows.map((row) => h('tr', {}, h('td', { text: row.name }), h('td', { text: String(row.replies) }), h('td', { text: String(row.points) })))));
    const render = (data) => {
        summary.replaceChildren(h('p', {
            class: 'bl-balance',
            text: data.trial
                ? billingCopy.trial(data.trial.used, data.trial.limit)
                : data.metered && data.quota
                    ? billingCopy.quota(data.quota.total, data.quota.used, data.balance ?? 0)
                    : billingCopy.unmetered,
        }));
        if (data.metered) {
            const { byModel, byCharacter } = data.month;
            summary.append(h('h3', { class: 'bl-heading', text: billingCopy.month }), byModel.length === 0
                ? h('p', { class: 'bl-empty', text: billingCopy.noMonth })
                : h('div', { class: 'bl-tables' }, table(billingCopy.byModel, byModel.map((row) => ({ name: PLAYER_MODELS[row.model].label, ...row }))), table(billingCopy.byCharacter, byCharacter.map((row) => ({
                    name: options.name(row.characterId) || billingCopy.unknownCharacter,
                    ...row,
                })))));
        }
        list.replaceChildren(...(data.items.length === 0
            ? [h('li', { class: 'bl-empty', text: billingCopy.empty })]
            : data.items.map((item) => {
                const row = billingRow(item, options.name);
                return h('li', { class: `bl-row is-${item.kind}` }, h('span', { class: 'bl-main' }, h('span', { class: 'bl-title', text: row.title }), row.sub ? h('span', { class: 'bl-sub', text: row.sub }) : null), h('b', { class: 'bl-points', text: row.points }));
            })), h('li', { class: 'bl-window', text: billingCopy.windowNote }));
        const prev = h('button', { class: 'acct-link bl-prev', attrs: { type: 'button' }, text: billingCopy.prev });
        const next = h('button', { class: 'acct-link bl-next', attrs: { type: 'button' }, text: billingCopy.next });
        prev.disabled = data.page <= 1;
        next.disabled = !data.hasMore;
        prev.addEventListener('click', () => void load(data.page - 1));
        next.addEventListener('click', () => void load(data.page + 1));
        pager.replaceChildren(prev, h('span', { class: 'bl-page', text: billingCopy.page(data.page) }), next);
        pager.hidden = data.page <= 1 && !data.hasMore;
    };
    async function load(target) {
        const ticket = ++loading;
        status.textContent = billingCopy.loading;
        try {
            const data = await options.api.billing(target);
            if (closed || ticket !== loading)
                return;
            page = data.page;
            status.textContent = '';
            render(data);
        }
        catch {
            if (closed || ticket !== loading)
                return;
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
