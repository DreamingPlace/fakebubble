import { RESTORE_PROBLEM_TEXT, } from "../../../../../../packages/contracts/web-character-history.js";
import { h } from "../../cocreation/h.js";
import { dateTimeText } from "../system-format.js";
import { historyList } from "./history-list.js";
import { keyValuePanel } from "../ui/key-value-panel.js";
import { diffSideBySide } from "../preview/diff.js";
import { presentationFields, readableGroups, templateFields } from "./readable.js";
const ACTOR = { owner: '主管理员', admin: '管理员', system: '系统导入' };
export const originText = (origin) => origin.kind === 'restore' ? `恢复自 v${origin.from}` : origin.kind === 'colour' ? '仅改主色' : '发布';
/** What the page says for an error of the history and restore calls; anything else falls back to the host. */
const RESTORE_ERRORS = {
    CHARACTER_PUBLICATION_BUSY: '此人物还有未结束的玩家任务，暂不能恢复。不会取消或重发任何任务，请稍后再试。',
    CHARACTER_VERSION_NOT_RESTORABLE: '这一版已不可恢复，没有任何改动。',
    CHARACTER_VERSION_IS_LIVE: '这一版就是现行版本，不需要恢复。',
    LIVE_VERSION_CONFLICT: '现行版本刚刚变过。请重新读取版本历史，核对后再恢复。',
    ADMIN_OWNER_REQUIRED: '只有主管理员可以恢复版本。',
    CHARACTER_DELETED: '人物已删除，没有版本历史，也不能恢复。',
};
const errorCode = (error) => error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
const problemOf = (error) => {
    const detail = error && typeof error === 'object' && 'detail' in error ? error.detail : null;
    const problem = detail && typeof detail === 'object' ? detail.problem : null;
    return typeof problem === 'string' && problem in RESTORE_PROBLEM_TEXT
        ? RESTORE_PROBLEM_TEXT[problem]
        : null;
};
export function versionHistory(root, host) {
    let disposed = false, token = 0, characterId = '', history = null;
    // One restore request is fixed once it has been asked for: after an uncertain answer the same id is sent again (same answer).
    const attempts = new Map();
    const gone = () => disposed || host.disposed();
    const intro = h('p', { class: 'vh-note' });
    const list = historyList({
        label: '版本历史',
        detail: (entry) => openVersion(entry),
        canRestore: () => host.isOwner(),
        restore: (entry) => host.run(() => restore(entry)),
    });
    intro.textContent = '读取版本历史…';
    list.root.hidden = true;
    const box = h('div', { class: 'vh-wrap' }, intro, list.root);
    root.append(box);
    const entryOf = (row) => ({
        version: row.version,
        live: row.live,
        when: row.publishedAt === null ? '无记录' : dateTimeText(row.publishedAt),
        by: ACTOR[row.by],
        origin: originText(row.origin),
        summary: row.summary,
        problem: row.problem ? RESTORE_PROBLEM_TEXT[row.problem] : null,
    });
    async function restore(row) {
        const live = history?.live;
        if (live === null || live === undefined || !host.isOwner())
            return;
        show(null);
        const key = `${characterId}:${row.version}:${live}`;
        if (!attempts.has(key))
            attempts.set(key, crypto.randomUUID());
        try {
            const result = await host.api.restore(characterId, {
                requestId: attempts.get(key),
                version: row.version,
                liveVersion: live,
            });
            attempts.delete(key);
            if (gone())
                return;
            list.closeAll();
            host.status(`已恢复：v${result.restoredFrom} 的内容已发布为新版本 v${result.version}，玩家下一条消息起生效。`);
            await host.onRestored(characterId, result.version);
            if (!gone())
                await load(characterId);
        }
        catch (error) {
            // A definite refusal ends this attempt; anything else keeps the id so that the same click asks the same question.
            if (errorCode(error) in RESTORE_ERRORS)
                attempts.delete(key);
            const text = (errorCode(error) === 'CHARACTER_VERSION_NOT_RESTORABLE' ? problemOf(error) : null) ??
                RESTORE_ERRORS[errorCode(error)] ??
                host.errorText?.(error);
            show(text ?? '恢复没有完成；没有改动任何版本。可以再点一次，会按同一个请求核对。');
            if (errorCode(error) in RESTORE_ERRORS && !gone())
                await load(characterId).catch(() => { });
        }
    }
    function show(text) {
        list.setNote(text);
        if (text)
            host.status(text);
    }
    /** The detail under a row: returned at once ("读取中…"), filled when the snapshot has been read. */
    function openVersion(row) {
        const mine = token;
        const detail = h('div', { class: 'vh-detail ot-detail' }, h('p', { class: 'vh-note', text: '读取中…' }));
        void (async () => {
            try {
                const snapshot = await host.api.historyVersion(characterId, row.version);
                if (gone() || mine !== token)
                    return;
                detail.replaceChildren(...snapshotNodes(snapshot));
            }
            catch (error) {
                if (gone() || mine !== token)
                    return;
                detail.replaceChildren(h('p', { class: 'vh-note', text: host.errorText?.(error) ?? '这一版没有读取成功。' }));
            }
        })();
        return detail;
    }
    function snapshotNodes(snapshot) {
        const { template } = snapshot.profile;
        return [
            keyValuePanel([
                ['发布时间', snapshot.publishedAt === null ? '无记录（初始导入）' : dateTimeText(snapshot.publishedAt)],
                ['发布者', ACTOR[snapshot.by]],
                ['来源', originText(snapshot.origin)],
                ['相对上一版', snapshot.summary],
            ]),
            h('h4', { class: 'vh-title', text: '与现行版本的差异' }),
            ...diffNodes(snapshot),
            h('h4', { class: 'vh-title', text: '完整快照（只读）' }),
            h('h5', { class: 'vh-group', text: '网页展示' }),
            keyValuePanel(presentationFields(snapshot.profile).map(([label, value]) => [label, fieldNode(value)])),
            h('h5', { class: 'vh-group', text: '人设' }),
            h('div', { class: 'vh-text', text: template.persona }),
            h('h5', { class: 'vh-group', text: '完整模板' }),
            keyValuePanel(templateFields(snapshot.profile).map(([label, value]) => [label, fieldNode(value)])),
        ];
    }
    /** The difference from the live version, in the groups 资料改动 uses. */
    function diffNodes(snapshot) {
        if (snapshot.live || !snapshot.liveProfile)
            return [h('p', { class: 'vh-note', text: snapshot.live ? '这就是现行版本。' : '现在没有现行版本。' })];
        const nodes = [];
        for (const [name, before, after] of readableGroups(snapshot.liveProfile, snapshot.profile)) {
            if (before === after)
                continue;
            nodes.push(h('h5', { class: 'vh-group', text: name }), diffGrid(before ?? '', after, `v${snapshot.version}`));
        }
        nodes.push(h('p', {
            class: 'vh-note',
            text: nodes.length ? '版本号不计入差异。' : '内容与现行版本完全相同（版本号除外）。',
        }));
        return nodes;
    }
    async function load(id) {
        const mine = ++token;
        characterId = id;
        const result = await host.api.history(id);
        if (gone() || mine !== token)
            return;
        history = result;
        intro.hidden = true;
        list.setEntries(result.versions.map(entryOf), result.live);
        list.root.hidden = false;
    }
    return {
        load,
        dispose() {
            disposed = true;
            box.remove();
        },
    };
}
/** A value in a read-only field: its own lines kept, never JSON. */
const fieldNode = (value) => h('span', { class: 'vh-text', text: value });
/** The 资料改动 comparison (the same side-by-side lines and classes), the live text on the left and the version on the right. */
export function diffGrid(before, after, label, beforeLabel = '现行') {
    const grid = h('div', { class: 'pd-grid' });
    grid.append(h('div', { class: 'pd-row pd-head' }, h('span', { class: 'pd-cell pd-left', text: beforeLabel }), h('span', { class: 'pd-cell pd-right', text: label })));
    const side = (cell, pieces) => {
        if (pieces === null) {
            cell.className = `${cell.className} pd-empty`;
            return;
        }
        for (const piece of pieces) {
            if (piece.kind === 'same')
                cell.append(piece.text);
            else
                cell.append(h('span', { class: piece.kind === 'del' ? 'pd-del' : 'pd-add', text: piece.text }));
        }
    };
    for (const row of diffSideBySide(before, after)) {
        const left = h('span', { class: 'pd-cell pd-left' }), right = h('span', { class: 'pd-cell pd-right' });
        side(left, row.left);
        side(right, row.right);
        grid.append(h('div', { class: 'pd-row' }, left, right));
    }
    return grid;
}
