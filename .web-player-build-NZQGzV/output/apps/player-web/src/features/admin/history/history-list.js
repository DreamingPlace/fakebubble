import { h } from "../../cocreation/h.js";
import { hoverValue } from "../ui/hover-value.js";
import { openTable } from "../ui/open-table.js";
import { statusBadge } from "../ui/status-badge.js";
/**
 * Part 24b-6b: the ONE version list of the console, shared by 角色工作台 → 版本历史 and 关系与故事 → 整页版本.
 *   - only the latest 5 published versions, newest first, the live one marked (older ones stay in the database; the cut is made here);
 *   - a click on a row opens its detail directly BELOW the row (V3 "the detail opens below"), no side drawer;
 *   - 恢复此版本 asks in the SAME row ("以 v{live+1} 重新发布 v{N} 的内容", 确认恢复 / 取消): no pop-up dialog.
 * The list owns nothing but the look and the gestures: what a version is, how its detail is read and what a restore sends stay with
 * the host that hands them in.
 */
export const HISTORY_SHOWN = 5;
const VERSION_WORDS = {
    numberText: (version) => `v${version}`,
    current: '现行',
    restore: '恢复此版本',
    confirm: (version, live) => `以 v${live + 1} 重新发布 v${version} 的内容`,
    shown: HISTORY_SHOWN,
    empty: '还没有已发布的版本。',
    more: (total, shown) => `只列出最近 ${shown} 个版本，共 ${total} 个；更早的版本都保留着，不受影响。`,
    columns: ['版本', '时间 · 发布者', '来源 · 改动'],
};
export function historyList(options) {
    const words = { ...VERSION_WORDS, ...options.words };
    let entries = [];
    let total = 0;
    let live = null;
    let confirming = null;
    let busy = false;
    const cells = new Map();
    const note = h('p', { class: 'vh-note', hidden: true, attrs: { role: 'status' } });
    // Part 24b-6c: the count is the visible text; what it leaves out is the hover tip (no explanatory sentence under the list).
    const moreCount = h('span');
    const more = h('p', { class: 'vh-note vh-more', hidden: true }, moreCount);
    const table = openTable({
        label: options.label,
        className: 'vh-table',
        emptyText: words.empty,
        rowKey: (row) => String(row.version),
        detail: (row) => options.detail(row),
        onToggle: () => {
            // Looking at another version (or closing) drops an unanswered question.
            if (confirming !== null)
                ask(null);
        },
        columns: [
            {
                key: 'version',
                label: words.columns[0],
                width: '120px',
                cell: (row) => h('span', { class: 'vh-version' }, words.numberText(row.version), row.live ? statusBadge(words.current, 'ok') : null),
            },
            {
                key: 'publishedAt',
                label: words.columns[1],
                width: 'minmax(0, 190px)',
                cell: (row) => h('span', { class: 'vh-stack' }, h('span', { text: row.when }), row.mark ? markNode(row.mark) : row.by ? h('small', { text: row.by }) : null),
            },
            {
                key: 'origin',
                label: words.columns[2],
                cell: (row) => h('span', { class: 'vh-stack vh-what' }, h('span', { text: row.origin }), row.summary ? h('small', { text: row.summary }) : null, row.problem && !row.live ? h('small', { class: 'vh-why', text: row.problem }) : null),
            },
            {
                key: 'actions',
                label: '',
                width: '244px',
                align: 'end',
                cell: (row) => {
                    const cell = h('span', { class: 'vh-actions' });
                    cells.set(row.version, cell);
                    paintActions(row, cell);
                    return cell;
                },
            },
        ],
    });
    const root = h('div', { class: options.rootClass ?? 'vh' }, note, table.root, more);
    function paintActions(row, cell) {
        cell.replaceChildren();
        if (row.live)
            return;
        if (row.problem) {
            cell.append(statusBadge('不可恢复', 'danger'));
            return;
        }
        if (!options.canRestore())
            return;
        if (live === null)
            return;
        if (confirming === row.version) {
            const cancel = h('button', {
                class: 'admin-secondary',
                text: '取消',
                attrs: { type: 'button', 'data-restore-cancel': String(row.version) },
            });
            const go = h('button', {
                class: 'admin-primary',
                text: '确认恢复',
                attrs: { type: 'button', 'data-restore-go': String(row.version) },
            });
            cancel.addEventListener('click', () => ask(null));
            go.addEventListener('click', () => void run(row));
            const box = h('span', {
                class: 'vh-confirm',
                attrs: { role: 'group', 'aria-live': 'polite', 'aria-label': `恢复 ${words.numberText(row.version)}` },
            }, h('span', { class: 'vh-confirm-text', text: words.confirm(row.version, live) }), h('span', { class: 'vh-confirm-buttons' }, cancel, go));
            box.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    event.stopPropagation();
                    ask(null);
                }
            });
            // A click inside the question is never a click on the row (which would open its detail).
            box.addEventListener('click', (event) => event.stopPropagation());
            cell.append(box);
            return;
        }
        const button = h('button', {
            class: 'admin-secondary',
            text: words.restore,
            attrs: {
                type: 'button',
                'data-restore': String(row.version),
                'aria-label': `${words.restore} ${words.numberText(row.version)}`,
            },
        });
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            ask(row.version);
            cell.querySelector('[data-restore-cancel]')?.focus?.();
        });
        cell.append(button);
    }
    /** Opens the question in one row (or closes it): at most one row asks at a time. */
    function ask(version) {
        const before = confirming;
        confirming = version;
        for (const key of [before, version]) {
            if (key === null)
                continue;
            const row = entries.find((entry) => entry.version === key);
            const cell = cells.get(key);
            if (row && cell)
                paintActions(row, cell);
        }
    }
    async function run(row) {
        if (busy)
            return;
        busy = true;
        try {
            await options.restore(row);
        }
        finally {
            busy = false;
            if (confirming === row.version)
                ask(null);
        }
    }
    return {
        root,
        /** Newest first; only the latest HISTORY_SHOWN are listed. `liveVersion` is the version the next restore is numbered after. */
        setEntries(next, liveVersion) {
            live = liveVersion;
            const ordered = [...next].sort((a, b) => b.version - a.version);
            total = ordered.length;
            entries = ordered.slice(0, words.shown);
            cells.clear();
            confirming = null;
            table.setRows(entries);
            more.hidden = total <= entries.length;
            moreCount.textContent = `共 ${total} 个`;
            hoverValue(more, words.more(total, words.shown));
        },
        /** A line under the list for a refusal or an uncertain answer (null clears it). */
        setNote(text) {
            note.hidden = text === null;
            note.textContent = text ?? '';
        },
        closeAll() {
            ask(null);
            table.closeAll();
        },
        get shown() {
            return entries.length;
        },
    };
}
/** The administrator's mark: a coloured square with the initial; the label sits beside it and is also the hover tip. */
function markNode(mark) {
    const square = h('b', { class: 'mb-mark', text: mark.initial, attrs: { 'aria-hidden': 'true' } });
    if (mark.colour)
        square.style?.setProperty('--mark', mark.colour);
    else
        square.dataset.removed = 'true';
    const node = h('small', { class: 'vh-by' }, square, h('span', { text: mark.label }));
    hoverValue(node, mark.label);
    return node;
}
