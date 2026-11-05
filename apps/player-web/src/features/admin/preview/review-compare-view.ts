import {
  COMPARE_MARKS,
  COMPARE_MARK_LABELS,
  COMPARE_SIDES,
  COMPARE_SIDE_LABELS,
  type CompareCaseResult,
  type CompareEstimate,
  type CompareMark,
  type CompareRunDetail,
  type CompareRunInfo,
  type CompareSide,
  type CompareSideResult,
  type CompareSummarySide,
} from '../../../../../../packages/contracts/review-compare.ts';
import type { ReviewCompareClient } from '../../../services/preview-admin-api.ts';
import { h } from '../../cocreation/h.ts';
import { dataTable } from '../ui/data-table.ts';
import { drawer } from '../ui/drawer.ts';
import { statusBadge } from '../ui/status-badge.ts';
import { micros, when } from './copy.ts';
import { diffBubbles, diffSideBySide, type Piece } from './diff.ts';

export type ReviewCompareHost = {
  api: ReviewCompareClient;
  /** The owner, or `preview` on every character: may start a run and mark. Reading needs only the 预演 grant. */
  canStart: () => boolean;
  run: (work: () => Promise<void>) => Promise<void>;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  disposed: () => boolean;
  modalParent: () => HTMLElement;
  newId?: () => string;
  download?: (name: string, text: string, type: string) => void;
  poll?: {
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
    hidden?: () => boolean;
  };
};

const SIDE_NAME = COMPARE_SIDE_LABELS;
const pct = (passed: number, total: number) => (total === 0 ? '—' : `${Math.round((passed / total) * 1000) / 10}%`);
const ms = (value: number | null) => (value === null ? '—' : `${value} ms`);
const stateText = (r: CompareSideResult) =>
  r.state === 'ok'
    ? '有效'
    : r.state === 'invalid'
      ? `无效（${r.errorCode ?? '—'}）`
      : r.state === 'unknown'
        ? '结果未知'
        : '等待中';
const caseTone = { queued: 'neutral', generating: 'info', done: 'ok', failed: 'danger' } as const;
const caseLabel = { queued: '排队中', generating: '运行中', done: '已完成', failed: '失败' } as const;

/** Draft against final, by bubble: removed text struck, added text marked. Never innerHTML. */
function diffNode(pieces: readonly Piece[]) {
  const node = h('span', { class: 'rc-diff' });
  for (const piece of pieces)
    node.append(
      piece.kind === 'same'
        ? document.createTextNode(piece.text)
        : h(piece.kind === 'del' ? 'del' : 'ins', { text: piece.text }),
    );
  return node;
}

/**
 * 审核对比 (Part 26b), a section of 预演. The administrator starts one run of the built-in synthetic cases (after seeing the
 * estimated cost and explicitly confirming the paid calls), watches it work through the preview queue, and reads: a summary
 * table (V4 Pro against V4.1 Flash), every case side by side with a diff against the same draft, the expected outcomes with
 * pass / fail per reviewer, and marks 更好 / 一样 / 更差 saved with the run. The summary exports as plain text without ids.
 */
export function reviewCompareView(root: HTMLElement, host: ReviewCompareHost) {
  let disposed = false,
    busy = false,
    runs: CompareRunInfo[] = [],
    current: string | null = null,
    detail: CompareRunDetail | null = null,
    estimate: CompareEstimate | null = null,
    openOrdinal: number | null = null,
    timer: unknown = null,
    pendingStart: { id: string } | null = null;
  const gone = () => disposed || host.disposed();
  const newId = host.newId ?? (() => crypto.randomUUID());
  const set = host.poll?.setTimer ?? ((fn: () => void, delay: number) => setTimeout(fn, delay));
  const clear = host.poll?.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const hidden =
    host.poll?.hidden ?? (() => (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true);

  // ---- start card -------------------------------------------------------------------------------------------------
  // The cost stays visible next to the confirmation: a paid call is never confirmed blind.
  const costLine = h('p', { class: 'admin-hint rc-estimate', attrs: { id: 'rc-estimate-tip', role: 'note' } });
  const ack = h('input', { attrs: { type: 'checkbox', 'aria-label': '确认发起付费审核对比' } });
  const ackLine = h('label', { class: 'admin-check pw-ack' }, ack, h('span', { text: '确认发起付费审核对比' }));
  ack.setAttribute('aria-describedby', 'rc-estimate-tip');
  const startButton = h('button', { class: 'admin-primary', text: '开始审核对比', attrs: { type: 'button' } });
  const startHint = h('p', { class: 'admin-hint', hidden: true });
  const intro = h('p', {
    class: 'admin-hint',
    text: '用内置的合成用例（不含任何玩家数据）：每个用例先写一份草稿，再让 V4 Pro 和 V4.1 Flash 各审核同一份草稿。结果只用来选择审核模型，不会影响线上。',
  });
  const startCard = h('div', { class: 'rc-start' }, intro, ackLine, costLine, startButton, startHint);

  // ---- results ----------------------------------------------------------------------------------------------------
  const runsHost = h('div', { class: 'rc-runs', attrs: { role: 'group', 'aria-label': '审核对比的运行' } });
  const progress = h('p', { class: 'admin-hint rc-progress', attrs: { role: 'status' } });
  const summaryHost = h('div', { class: 'rc-summary' });
  const exportButton = h('button', { class: 'admin-secondary', text: '导出摘要', attrs: { type: 'button' } });
  const exportText = h('pre', { class: 'rc-export', hidden: true, attrs: { 'aria-label': '摘要（纯文本）' } });
  const casesHost = h('div', { class: 'rc-cases' });
  const wrap = h(
    'div',
    { class: 'rc' },
    h('h3', { text: '审核对比 · V4 Pro 与 V4.1 Flash' }),
    startCard,
    runsHost,
    progress,
    summaryHost,
    h('div', { class: 'rc-actions' }, exportButton),
    exportText,
    casesHost,
  );
  root.append(wrap);
  // On the page's main element, not inside the preview column: the role picker of 角色工作台 would otherwise sit over its header.
  const side = drawer(host.modalParent(), { title: '用例对比', wide: true });

  const canGo = () => host.canStart() && !busy && ack.checked && !!estimate && !runs.some((r) => r.running);
  // The page re-enables controls after every request; `data-locked` is what keeps a control off.
  const off = (control: HTMLButtonElement | HTMLInputElement, value: boolean) => {
    control.disabled = value;
    control.dataset.locked = String(value);
  };
  const lock = () => {
    off(startButton, !canGo());
    off(ack, !host.canStart() || busy);
    startHint.hidden = host.canStart();
    startHint.textContent = host.canStart() ? '' : '只读：发起审核对比需要“预演”的全部角色权限';
    off(exportButton, !detail);
  };
  const paintEstimate = () => {
    costLine.textContent = estimate
      ? `${estimate.cases} 个用例 = ${estimate.calls} 次付费调用（每个用例：1 次草稿 + V4 Pro、V4.1 Flash 各 1 次审核）；预计花费约 ${micros(estimate.typicalMicros)}（官方标价估算），单次调用最多预留 ${micros(estimate.holdMicros)}。用例在预演队列里逐个运行，不会自动重发。`
      : '';
  };

  // ---- summary table ----------------------------------------------------------------------------------------------
  function summaryTable(d: CompareRunDetail) {
    const { pro, flash } = d.summary;
    type Row = [label: string, a: string, b: string, tip?: string];
    const quote = (s: CompareSummarySide) => `${s.quoteFailures} / ${s.quoteChecked}`;
    const rows: Row[] = [
      [
        '期望结果通过率',
        pct(pro.passed, pro.total),
        pct(flash.passed, flash.total),
        `${pro.passed}/${pro.total} · ${flash.passed}/${flash.total}`,
      ],
      ['无效输出', String(pro.invalid), String(flash.invalid), '结构、工具调用或校验未通过（仍按实际用量计费）'],
      ['引文不准确', quote(pro), quote(flash), '不准确 / 已检查：每条引文必须逐字出现在最终气泡或玩家消息里'],
      ['多余改写', String(pro.needlessRewrites), String(flash.needlessRewrites), '草稿本来满足检查，审核仍然改写了'],
      ['改写了草稿', String(pro.changed), String(flash.changed)],
      ['平均耗时', ms(pro.avgLatencyMs), ms(flash.avgLatencyMs)],
      ['P90 耗时', ms(pro.p90LatencyMs), ms(flash.p90LatencyMs)],
      ['每次审核花费', micros(pro.avgCostMicros), micros(flash.avgCostMicros), '官方标价（高峰价），不是预算上限'],
      ['结果未知', String(pro.unknown), String(flash.unknown), '未知调用不重发，额度保留'],
    ];
    const table = h(
      'table',
      { class: 'admin-table rc-table', attrs: { 'aria-label': '审核对比汇总' } },
      h('caption', { text: '汇总' }),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          ...['指标', SIDE_NAME.pro, SIDE_NAME.flash].map((t) => h('th', { text: t, attrs: { scope: 'col' } })),
        ),
      ),
    );
    const body = h('tbody');
    for (const [label, a, b, tip] of rows) {
      const th = h('th', { text: label, attrs: { scope: 'row' } });
      if (tip) th.setAttribute('title', tip);
      body.append(
        h(
          'tr',
          {},
          th,
          h('td', { text: a, attrs: { 'data-label': SIDE_NAME.pro } }),
          h('td', { text: b, attrs: { 'data-label': SIDE_NAME.flash } }),
        ),
      );
    }
    table.append(body);
    return table;
  }

  // ---- cases ------------------------------------------------------------------------------------------------------
  const passCell = (r: CompareSideResult) => {
    if (r.state === 'pending') return h('span', { class: 'admin-hint', text: '—' });
    if (r.state === 'unknown') return statusBadge('未知', 'danger');
    const passed = r.expectations.filter((e) => e.pass).length;
    return statusBadge(
      `${passed}/${r.expectations.length}${r.state === 'invalid' ? ' · 无效' : ''}`,
      passed === r.expectations.length && r.state === 'ok' ? 'ok' : 'warn',
    );
  };
  const table = dataTable<CompareCaseResult>({
    columns: [
      { key: 'ordinal', label: '#', sortable: true, sortValue: (c) => c.ordinal, render: (c) => String(c.ordinal) },
      { key: 'group', label: '类别', sortable: true, render: (c) => c.group },
      { key: 'title', label: '用例', render: (c) => c.title },
      { key: 'status', label: '状态', render: (c) => statusBadge(caseLabel[c.status], caseTone[c.status]) },
      { key: 'pro', label: SIDE_NAME.pro, render: (c) => passCell(c.pro) },
      { key: 'flash', label: SIDE_NAME.flash, render: (c) => passCell(c.flash) },
      {
        key: 'marks',
        label: '标记',
        render: (c) =>
          [c.pro.mark, c.flash.mark].some(Boolean)
            ? `${c.pro.mark ? COMPARE_MARK_LABELS[c.pro.mark] : '—'} / ${c.flash.mark ? COMPARE_MARK_LABELS[c.flash.mark] : '—'}`
            : '—',
      },
    ],
    rowKey: (c) => String(c.ordinal),
    emptyText: '还没有审核对比的运行。',
    caption: '用例',
    onRowOpen: (c) => openCase(c.ordinal),
    openOn: 'click',
  });
  casesHost.append(table.root);

  function resultColumn(c: CompareCaseResult, s: CompareSide) {
    const r = c[s];
    const col = h('section', { class: 'rc-side', attrs: { 'aria-label': SIDE_NAME[s], 'data-side': s } });
    col.append(h('h4', { text: SIDE_NAME[s] }), h('p', { class: 'admin-hint', text: `状态：${stateText(r)}` }));
    if (r.bubbles && c.draft) {
      const rowsDiff = diffBubbles(c.draft, r.bubbles);
      const list = h('div', { class: 'pw-bubbles' });
      for (const row of rowsDiff)
        list.append(
          h(
            'div',
            { class: 'pw-bubble' },
            row.after === null ? h('del', { text: row.before ?? '' }) : diffNode(row.pieces),
          ),
        );
      col.append(list);
    } else col.append(h('p', { class: 'admin-empty', text: r.state === 'pending' ? '尚未审核。' : '没有有效输出。' }));
    const ul = h('ul', { class: 'rc-expect', attrs: { 'aria-label': `${SIDE_NAME[s]} 的期望结果` } });
    for (const e of r.expectations)
      ul.append(
        h(
          'li',
          {},
          statusBadge(e.pass ? '通过' : '未通过', e.pass ? 'ok' : 'danger'),
          h('span', { text: ` ${e.label}（${e.detail}）` }),
        ),
      );
    col.append(ul);
    const t = r.tokens;
    col.append(
      h('p', {
        class: 'admin-hint rc-metrics',
        text: [
          `耗时 ${ms(r.latencyMs)}`,
          t ? `词元 命中 ${t.hit} / 未命中 ${t.miss} / 输出 ${t.out}` : null,
          `花费 ${micros(r.costMicros)}`,
          `引文 ${r.quotes.failed} 处不准确 / ${r.quotes.checked}`,
          r.changed === null ? null : r.changed ? '改写了草稿' : '未改草稿',
          r.needlessRewrite ? '多余改写' : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }),
    );
    // 更好 / 一样 / 更差, saved with the run; pressing the pressed one again clears it.
    const marks = h('div', { class: 'rc-marks', attrs: { role: 'group', 'aria-label': `${SIDE_NAME[s]} 评价` } });
    for (const mark of COMPARE_MARKS) {
      const b = h('button', {
        text: COMPARE_MARK_LABELS[mark],
        class: 'seg-button',
        attrs: { type: 'button', 'aria-pressed': String(r.mark === mark), 'data-mark': mark },
      });
      off(b, !host.canStart() || r.state === 'pending');
      b.addEventListener('click', () => void setMark(c, s, r.mark === mark ? null : mark));
      marks.append(b);
    }
    col.append(marks);
    return col;
  }
  function openCase(ordinal: number) {
    const c = detail?.cases.find((x) => x.ordinal === ordinal);
    if (!c) return;
    openOrdinal = ordinal;
    side.setTitle(`用例 ${c.ordinal} · ${c.title}`);
    const body = side.body;
    body.replaceChildren(
      h('p', { class: 'admin-hint', text: `玩家输入：${c.input.join(' / ')}` }),
      h('p', { class: 'admin-hint', text: `期望：${c.expected.join('；')}` }),
      h('h4', { text: '草稿（两个审核模型审核的是同一份）' }),
      c.draft
        ? h(
            'div',
            { class: 'pw-bubbles' },
            ...c.draft.map((t) => h('div', { class: 'pw-bubble' }, h('span', { text: t }))),
          )
        : h('p', {
            class: 'admin-empty',
            text: c.status === 'failed' ? `没有草稿（${c.errorCode ?? '失败'}）` : '草稿尚未生成。',
          }),
      h('div', { class: 'rc-sides' }, resultColumn(c, 'pro'), resultColumn(c, 'flash')),
    );
    if (c.pro.bubbles && c.flash.bubbles) {
      const rows = diffSideBySide(c.pro.bubbles.join('\n'), c.flash.bubbles.join('\n'));
      const grid = h('div', { class: 'rc-vs', attrs: { role: 'table', 'aria-label': 'V4 Pro 与 V4.1 Flash 的差异' } });
      grid.append(
        h('div', { class: 'rc-vs-head' }, h('span', { text: SIDE_NAME.pro }), h('span', { text: SIDE_NAME.flash })),
      );
      for (const row of rows)
        grid.append(
          h(
            'div',
            { class: row.changed ? 'rc-vs-row is-changed' : 'rc-vs-row' },
            row.left ? diffNode(row.left) : h('span'),
            row.right ? diffNode(row.right) : h('span'),
          ),
        );
      body.append(h('h4', { text: '两个审核模型的最终回复差异' }), grid);
    }
    side.open();
  }
  async function setMark(c: CompareCaseResult, s: CompareSide, mark: CompareMark | null) {
    if (!current || busy) return;
    await host.run(async () => {
      await host.api.mark({ runId: current!, ordinal: c.ordinal, side: s, mark });
      await load(current!);
      if (openOrdinal === c.ordinal) openCase(c.ordinal);
    });
  }

  // ---- loading / painting -----------------------------------------------------------------------------------------
  function paintRuns() {
    runsHost.replaceChildren();
    runs.forEach((run, index) => {
      const b = h('button', {
        class: 'seg-button',
        text: `${when(run.createdAt)} · ${run.done}/${run.cases}${run.failed ? ` · ${run.failed} 失败` : ''}${run.running ? ' · 进行中' : ''}`,
        attrs: { type: 'button', 'aria-pressed': String(run.runId === current), 'data-run': String(index) },
      });
      b.addEventListener('click', () => void host.run(() => load(run.runId)));
      runsHost.append(b);
    });
  }
  function paint() {
    paintRuns();
    paintEstimate();
    summaryHost.replaceChildren();
    if (detail) {
      const r = detail.run;
      progress.textContent = `已完成 ${r.done}/${r.cases}${r.failed ? `，失败 ${r.failed}` : ''}${r.running ? '，正在运行（逐个用例，排在预演之后）' : ''}；已花费 ${micros(r.chargedMicros)}（预算账本口径）。`;
      summaryHost.append(summaryTable(detail));
      table.setRows(detail.cases);
    } else {
      progress.textContent = runs.length ? '选择一次运行查看结果。' : '';
      table.setRows([]);
    }
    exportText.hidden = true;
    lock();
  }
  async function load(runId: string) {
    const next = await host.api.detail(runId);
    if (gone()) return;
    current = runId;
    detail = next;
    runs = runs.map((r) => (r.runId === runId ? next.run : r));
    paint();
    schedule();
  }
  async function refresh() {
    const [list, est] = await Promise.all([
      host.api.list(),
      estimate ? Promise.resolve(estimate) : host.api.estimate(),
    ]);
    if (gone()) return;
    runs = list;
    estimate = est;
    const pick = current && runs.some((r) => r.runId === current) ? current : (runs[0]?.runId ?? null);
    if (pick) await load(pick);
    else {
      current = null;
      detail = null;
      paint();
    }
  }
  function schedule() {
    if (timer !== null) clear(timer);
    timer = null;
    if (gone() || !detail?.run.running || hidden()) return;
    timer = set(() => {
      timer = null;
      if (current && !gone())
        void host.api.detail(current).then(
          (next) => {
            if (gone()) return;
            detail = next;
            runs = runs.map((r) => (r.runId === next.run.runId ? next.run : r));
            paint();
            if (openOrdinal !== null && side.isOpen()) openCase(openOrdinal);
            schedule();
          },
          () => schedule(),
        );
    }, 5000);
  }

  [ack].forEach((input) => input.addEventListener('change', lock));
  startButton.addEventListener('click', () => {
    if (!canGo() || !estimate) return;
    busy = true;
    lock();
    // The same submission is retried under the same request id, so a lost reply can never queue a second run.
    pendingStart ??= { id: newId() };
    const request = { requestId: pendingStart.id, confirmPaidCalls: estimate.calls };
    void host
      .run(async () => {
        const result = await host.api.start(request);
        pendingStart = null;
        ack.checked = false;
        host.toast(
          result.replayed ? '这次审核对比已经提交过' : '已提交审核对比；用例会按顺序在预演队列里运行。',
          'info',
        );
        current = result.runId;
        await refresh();
      })
      .finally(() => {
        busy = false;
        lock();
      });
  });
  exportButton.addEventListener('click', () => {
    if (!current || !detail) return;
    const runId = current;
    void host.run(async () => {
      const text = await host.api.exportText(runId);
      exportText.textContent = text;
      exportText.hidden = false;
      const name = `review-compare-${new Date(detail!.run.createdAt).toISOString().slice(0, 10)}.txt`;
      (host.download ?? defaultDownload)(name, text, 'text/plain');
    });
  });
  lock();

  return {
    /** Loads the runs and the estimate (once the section is opened). */
    async open() {
      await host.run(refresh);
    },
    clear() {
      if (timer !== null) clear(timer);
      timer = null;
      current = null;
      detail = null;
      side.close();
    },
    dispose() {
      disposed = true;
      if (timer !== null) clear(timer);
      side.dispose();
    },
  };
}
function defaultDownload(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', name);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
