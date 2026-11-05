import { h } from '../../cocreation/h.ts';
import { openTable } from '../ui/open-table.ts';
import { statusBadge } from '../ui/status-badge.ts';

/**
 * Part 24b-6b: the ONE version list of the console, shared by 角色工作台 → 版本历史 and 关系与故事 → 整页版本.
 *   - only the latest 5 published versions, newest first, the live one marked (older ones stay in the database; the cut is made here);
 *   - a click on a row opens its detail directly BELOW the row (V3 "the detail opens below"), no side drawer;
 *   - 恢复此版本 asks in the SAME row ("以 v{live+1} 重新发布 v{N} 的内容", 确认恢复 / 取消): no pop-up dialog.
 * The list owns nothing but the look and the gestures: what a version is, how its detail is read and what a restore sends stay with
 * the host that hands them in.
 */
export const HISTORY_SHOWN = 5;

export type HistoryEntry = {
  version: number;
  live: boolean;
  /** Already formatted (UTC), or the words for "no record". */
  when: string;
  /** 主管理员 / 管理员 / 系统导入, when the source knows who published it. */
  by: string | null;
  /** 发布 / 恢复自 vN / 仅改主色 */
  origin: string;
  summary: string;
  /** Why this version can never be restored (the row says 不可恢复 and the reason), null when it can. */
  problem: string | null;
};

export type HistoryListOptions = {
  label: string;
  /** The detail that opens under a row. Returned at once and filled in later when it has to be read. */
  detail: (entry: HistoryEntry) => Node | Promise<Node>;
  /** Whether this person may restore at all (owner for a character, cast.publish for the cast). */
  canRestore: () => boolean;
  /** What a confirmed 确认恢复 does. The host reports its own success and errors; a throw leaves the row as it was. */
  restore: (entry: HistoryEntry) => Promise<void>;
};

export function historyList(options: HistoryListOptions) {
  let entries: HistoryEntry[] = [];
  let total = 0;
  let live: number | null = null;
  let confirming: number | null = null;
  let busy = false;
  const cells = new Map<number, HTMLElement>();
  const note = h('p', { class: 'vh-note', hidden: true, attrs: { role: 'status' } });
  const more = h('p', { class: 'vh-note vh-more', hidden: true });
  const table = openTable<HistoryEntry>({
    label: options.label,
    className: 'vh-table',
    emptyText: '还没有已发布的版本。',
    rowKey: (row) => String(row.version),
    detail: (row) => options.detail(row),
    onToggle: () => {
      // Looking at another version (or closing) drops an unanswered question.
      if (confirming !== null) ask(null);
    },
    columns: [
      {
        key: 'version',
        label: '版本',
        width: '120px',
        cell: (row) =>
          h('span', { class: 'vh-version' }, `v${row.version}`, row.live ? statusBadge('现行', 'ok') : null),
      },
      {
        key: 'publishedAt',
        label: '时间 · 发布者',
        width: 'minmax(0, 190px)',
        cell: (row) =>
          h('span', { class: 'vh-stack' }, h('span', { text: row.when }), row.by ? h('small', { text: row.by }) : null),
      },
      {
        key: 'origin',
        label: '来源 · 改动',
        cell: (row) =>
          h(
            'span',
            { class: 'vh-stack vh-what' },
            h('span', { text: row.origin }),
            h('small', { text: row.summary }),
            row.problem && !row.live ? h('small', { class: 'vh-why', text: row.problem }) : null,
          ),
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
  const root = h('div', { class: 'vh' }, note, table.root, more);

  function paintActions(row: HistoryEntry, cell: HTMLElement) {
    cell.replaceChildren();
    if (row.live) return;
    if (row.problem) {
      cell.append(statusBadge('不可恢复', 'danger'));
      return;
    }
    if (!options.canRestore()) return;
    if (live === null) return;
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
      const box = h(
        'span',
        { class: 'vh-confirm', attrs: { role: 'group', 'aria-label': `恢复 v${row.version}` } },
        h('span', { class: 'vh-confirm-text', text: `以 v${live + 1} 重新发布 v${row.version} 的内容` }),
        h('span', { class: 'vh-confirm-buttons' }, cancel, go),
      );
      box.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Escape') {
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
      text: '恢复此版本',
      attrs: { type: 'button', 'data-restore': String(row.version), 'aria-label': `恢复此版本 v${row.version}` },
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      ask(row.version);
      cell.querySelector<HTMLElement>('[data-restore-cancel]')?.focus?.();
    });
    cell.append(button);
  }

  /** Opens the question in one row (or closes it): at most one row asks at a time. */
  function ask(version: number | null) {
    const before = confirming;
    confirming = version;
    for (const key of [before, version]) {
      if (key === null) continue;
      const row = entries.find((entry) => entry.version === key);
      const cell = cells.get(key);
      if (row && cell) paintActions(row, cell);
    }
  }

  async function run(row: HistoryEntry) {
    if (busy) return;
    busy = true;
    try {
      await options.restore(row);
    } finally {
      busy = false;
      if (confirming === row.version) ask(null);
    }
  }

  return {
    root,
    /** Newest first; only the latest HISTORY_SHOWN are listed. `liveVersion` is the version the next restore is numbered after. */
    setEntries(next: readonly HistoryEntry[], liveVersion: number | null) {
      live = liveVersion;
      const ordered = [...next].sort((a, b) => b.version - a.version);
      total = ordered.length;
      entries = ordered.slice(0, HISTORY_SHOWN);
      cells.clear();
      confirming = null;
      table.setRows(entries);
      more.hidden = total <= entries.length;
      more.textContent = `只列出最近 ${HISTORY_SHOWN} 个版本，共 ${total} 个；更早的版本都保留着，不受影响。`;
    },
    /** A line under the list for a refusal or an uncertain answer (null clears it). */
    setNote(text: string | null) {
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
