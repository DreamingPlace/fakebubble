import { h } from "../../cocreation/h.js";
import { markColour } from "../members-view.js";
import { dateTimeText } from "../system-format.js";
import { hoverValue } from "../ui/hover-value.js";
import { historyList } from "./history-list.js";
import { diffGrid } from "./version-history.js";
import { readableGroups } from "./readable.js";
/** The administrator's mark as the table shows it; a member who has been removed gets a neutral one. */
export const byMark = (by) => ({
    initial: by.initial,
    colour: by.index === null ? null : markColour(by.index),
    label: by.label,
});
export function draftHistory(host) {
    let disposed = false, token = 0, data = null;
    const gone = () => disposed || host.disposed();
    const groupsHost = h('div', {
        class: 'dh-groups',
        attrs: { role: 'list', 'aria-label': '各部分最近由谁改动' },
        hidden: true,
    });
    const list = historyList({
        rootClass: 'dh-list',
        label: '草稿记录',
        words: {
            numberText: (n) => `#${n}`,
            current: '当前',
            restore: '恢复到这一稿',
            confirm: (n, head) => `把修订 ${n} 的内容保存为修订 ${head + 1}（不发布）`,
            shown: 20,
            empty: '还没有保存过的草稿。',
            more: (total, shown) => `只列出最近 ${shown} 次保存，共 ${total} 次。`,
            columns: ['修订', '时间 · 保存者', '改动'],
        },
        detail: (entry) => openRevision(entry),
        canRestore: () => host.canRestore(),
        restore: (entry) => restore(entry),
    });
    const root = h('div', { class: 'dh' }, list.root);
    list.root.hidden = true;
    async function restore(entry) {
        const row = data?.revisions.find((r) => r.revision === entry.version);
        if (!row)
            return;
        try {
            await host.restore(row.profile, row.revision);
        }
        catch (error) {
            list.setNote(host.errorText(error) ?? '恢复没有完成；草稿没有改动。');
        }
    }
    function openRevision(entry) {
        const index = data?.revisions.findIndex((r) => r.revision === entry.version) ?? -1;
        if (!data || index < 0)
            return h('div', { class: 'vh-detail ot-detail' }, h('p', { class: 'vh-note', text: '没有找到这一稿。' }));
        const row = data.revisions[index];
        const before = data.revisions[index + 1]?.profile ?? data.earlier;
        const nodes = [];
        if (!before)
            nodes.push(h('p', { class: 'vh-note', text: '这是这份草稿的第一次保存。' }));
        else {
            const label = data.revisions[index + 1] ? `修订 ${data.revisions[index + 1].revision}` : '正式版本';
            for (const [name, was, now] of readableGroups(before, row.profile)) {
                if (was === now)
                    continue;
                nodes.push(h('h5', { class: 'vh-group', text: name }), diffGrid(was ?? '', now, `修订 ${row.revision}`, label));
            }
            if (!nodes.length)
                nodes.push(h('p', { class: 'vh-note', text: '内容与上一稿相同。' }));
        }
        return h('div', { class: 'vh-detail ot-detail' }, ...nodes);
    }
    function paint() {
        if (!data)
            return;
        groupsHost.replaceChildren();
        for (const { group, by } of data.groups) {
            const mark = byMark(by);
            const square = h('b', { class: 'mb-mark', text: mark.initial, attrs: { 'aria-hidden': 'true' } });
            if (mark.colour)
                square.style?.setProperty('--mark', mark.colour);
            else
                square.dataset.removed = 'true';
            const chip = h('span', { class: 'dh-group', attrs: { role: 'listitem', 'data-group': group } }, square, h('span', { text: group }));
            hoverValue(chip, `${group}：${mark.label}`);
            groupsHost.append(chip);
        }
        groupsHost.hidden = data.groups.length === 0;
        list.setEntries(data.revisions.map((row) => ({
            version: row.revision,
            live: row.revision === data.draftRevision,
            when: dateTimeText(row.savedAt),
            by: null,
            mark: byMark(row.by),
            origin: row.summary,
            summary: '',
            problem: null,
        })), data.draftRevision);
        list.root.hidden = false;
    }
    async function load(id) {
        const mine = ++token;
        const result = await host.api.draftHistory(id);
        if (gone() || mine !== token)
            return;
        data = result;
        paint();
    }
    return {
        /** The strip of group marks (placed above the comparison) and the list (below it). */
        groups: groupsHost,
        root,
        load,
        /** The list's note line for a refusal. */
        note: (text) => list.setNote(text),
        dispose() {
            disposed = true;
            groupsHost.remove();
            root.remove();
        },
    };
}
