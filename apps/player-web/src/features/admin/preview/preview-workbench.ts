import { h } from '../../cocreation/h.ts';
import type { AdminMember } from '../../../services/account-admin-api.ts';
import type { CharacterAdminClient, CharacterDetail } from '../../../services/character-admin-api.ts';
import { segmented } from '../ui/segmented.ts';
import type {
  Bubble,
  EvalSet,
  PreviewAdminClient,
  PreviewCastSource,
  PreviewDetail,
  PreviewRow,
  RunDetail,
  RunSummary,
} from '../../../services/preview-admin-api.ts';
import { hasCharacterPermission } from '../../../../../../packages/contracts/web-admin-permissions.ts';
import { dataTable } from '../ui/data-table.ts';
import { drawer } from '../ui/drawer.ts';
import { keyValuePanel } from '../ui/key-value-panel.ts';
import { statusBadge } from '../ui/status-badge.ts';
import { toolbar } from '../ui/toolbar.ts';
import { compareRuns } from './compare.ts';
import {
  COVERAGE_LABEL,
  SETTLEMENT_LABEL,
  SETTLEMENT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
  errorText,
  micros,
  seconds,
  settlementCopy,
  when,
  zoneLabel,
} from './copy.ts';
import { diffBubbles } from './diff.ts';
import { evalSetEditor } from './eval-set-editor.ts';
import { downloadText, exportName, runToCsv, runToJson } from './export.ts';
import { previewPoller, type PollerHost } from './poller.ts';

export const RUN_MAX = 50;
const INPUT_MAX = 4000;
export type PreviewWorkbenchHost = {
  api: PreviewAdminClient;
  characters: Pick<CharacterAdminClient, 'detail'>;
  member: () => AdminMember | null;
  run: (work: () => Promise<void>) => Promise<void>;
  status: (text: string) => void;
  disposed: () => boolean;
  toast: (text: string, tone?: 'ok' | 'info' | 'warn' | 'danger') => void;
  /** Where modal dialogs attach (the page's main element). */
  modalParent: () => HTMLElement;
  /** A 预演 changed state (finished, failed, was submitted): the editor beside this panel re-reads the proofs it offers. */
  changed?: () => void;
  /** Injected in tests: timer, visibility, download and request ids. */
  poll?: Partial<Pick<PollerHost, 'setTimer' | 'clearTimer' | 'hidden' | 'onVisible'>>;
  download?: (name: string, text: string, type: string) => void;
  newId?: () => string;
};
const defaultHidden = () => (globalThis as { document?: { hidden?: boolean } }).document?.hidden === true;
const defaultOnVisible = (fn: () => void) => {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
};
const RELATIONS: ReadonlyArray<readonly [string, string]> = [
  ['new', '初识'],
  ['friend', '朋友'],
  ['close_friend', '亲近朋友'],
  ['lover', '恋人'],
];
const FILTER_STATUSES: ReadonlyArray<readonly [string, string]> = [
  ['', '全部状态'],
  ['queued', STATUS_LABEL.queued],
  ['generating', STATUS_LABEL.generating],
  ['succeeded', STATUS_LABEL.succeeded],
  ['failed', STATUS_LABEL.failed],
];
const isOpen = (p: Pick<PreviewRow, 'status'>) => p.status === 'queued' || p.status === 'generating';
const bubbleList = (bubbles: readonly Bubble[]) => {
  const list = h('div', { class: 'pw-bubbles' });
  for (const b of bubbles)
    list.append(
      h(
        'div',
        { class: 'pw-bubble' },
        h('span', { text: b.text }),
        b.expression
          ? h('span', { class: 'admin-badge', text: b.expression, attrs: { 'data-tone': 'neutral' } })
          : null,
      ),
    );
  return list;
};
const coverageText = (p: PreviewRow) =>
  p.final?.coverage.length ? p.final.coverage.map((c) => COVERAGE_LABEL[c.status]).join('、') : '—';

/**
 * 预演测试 (Part 13b). One page per character: the top bar submits, the main area lists RUNS (a batch = a run, one
 * data table each) and single previews, a row opens a drawer, two runs can be compared and a run exported. It only
 * ever sends the character's saved draft and the admin's own synthetic inputs; the one timer is the batched status
 * poller, which backs off, stops when nothing is queued or running and sleeps while the tab is hidden.
 */
export function previewWorkbench(root: HTMLElement, host: PreviewWorkbenchHost) {
  let disposed = false,
    busy = false,
    id: string | null = null,
    detail: CharacterDetail | null = null,
    view = 0;
  let runs: RunSummary[] = [],
    singles: PreviewRow[] = [],
    sets: EvalSet[] = [];
  const loaded = new Map<string, RunDetail>();
  const open = new Set<string>();
  const chosen: string[] = [];
  const known = new Map<string, string>();
  const gone = () => disposed || host.disposed();
  const can = (action: 'preview' | 'read') => {
    const m = host.member();
    return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, action, id ?? ''));
  };
  const nextId = host.newId ?? (() => crypto.randomUUID());

  // ---- the page frame -------------------------------------------------------------------------------------------
  const composeHost = h('div', { class: 'pw-compose' });
  const compareHost = h('div', { class: 'pw-compare-bar' });
  const runsHost = h('div', { class: 'pw-runs' });
  const singlesHost = h('div', { class: 'pw-singles' });
  const page = h('div', { class: 'pw' }, composeHost, compareHost, runsHost, singlesHost);
  root.append(page);
  const side = drawer(root, { title: '预演详情' });
  const compareDrawer = drawer(root, { title: '运行对比', wide: true });
  const editor = evalSetEditor(root, {
    api: host.api,
    canWrite: () => {
      const m = host.member();
      return !!m && (m.role === 'owner' || hasCharacterPermission(m.permissions, 'preview', '*'));
    },
    run: host.run,
    toast: host.toast,
    changed: (next) => {
      sets = next;
      paintSetPicker();
    },
    confirmParent: host.modalParent,
  });

  const poller = previewPoller({
    tick: async () => {
      const characterId = id;
      if (!characterId) return { active: 0, changed: false };
      const result = await host.api.status(characterId, null);
      if (gone() || characterId !== id) return { active: 0, changed: false };
      const touched = new Set<string>();
      let changed = false;
      for (const p of result.previews) {
        const signature = `${p.status}|${p.settlement}|${p.errorCode}`;
        if (known.get(p.previewId) !== signature) {
          changed = true;
          known.set(p.previewId, signature);
          if (p.runId) touched.add(p.runId);
        }
      }
      if (changed) {
        await refresh([...touched]);
        host.changed?.();
      }
      return { active: result.active, changed };
    },
    hidden: host.poll?.hidden ?? defaultHidden,
    onVisible: host.poll?.onVisible ?? defaultOnVisible,
    ...(host.poll?.setTimer ? { setTimer: host.poll.setTimer } : {}),
    ...(host.poll?.clearTimer ? { clearTimer: host.poll.clearTimer } : {}),
    onGiveUp: () => host.toast('状态刷新连续失败，已暂停。点击“刷新”重试。', 'warn'),
  });

  // ---- compose bar ----------------------------------------------------------------------------------------------
  let pendingRun: { sig: string; body: Parameters<PreviewAdminClient['startRun']>[1] } | null = null;
  let pendingSingle: { sig: string; body: Parameters<PreviewAdminClient['startSingle']>[1] } | null = null;
  const relation = h('select', { attrs: { 'aria-label': '预演关系' } });
  for (const [value, text] of RELATIONS) relation.append(h('option', { text, attrs: { value } }));
  const simMode = h('select', { attrs: { 'aria-label': '模拟时间' } });
  simMode.append(
    h('option', { text: '使用真实时间', attrs: { value: 'none' } }),
    h('option', { text: '指定时间', attrs: { value: 'set' } }),
  );
  const simTime = h('input', { attrs: { type: 'time', value: '05:50', 'aria-label': '模拟的当地时间' } });
  simTime.value = '05:50';
  const simZone = h('span', { class: 'admin-hint pw-zone' });
  // 关系与故事 for this 预演 (Part 24a castSource): the cast draft is how the owner tests it before CAST_CONTEXT_ENABLED is on.
  // Always sent, so what is tested is what is shown on the chip, not whatever the server defaults to.
  let castSource: PreviewCastSource = 'none';
  const castSwitch = segmented<PreviewCastSource>(
    '关系与故事',
    [
      { id: 'none', label: '不用' },
      { id: 'published', label: '已发布' },
      { id: 'draft', label: '草稿' },
    ],
    castSource,
    (next) => {
      castSource = next;
    },
  );
  const setPicker = h('select', { attrs: { 'aria-label': '评测集' } });
  const runSet = h('button', { text: '运行评测集', attrs: { type: 'button' } });
  const editSets = h('button', { class: 'admin-secondary', text: '编辑评测集', attrs: { type: 'button' } });
  const single = h('input', {
    attrs: {
      type: 'text',
      maxlength: String(INPUT_MAX),
      placeholder: '单条输入（不是玩家消息）',
      'aria-label': '单条预演输入',
    },
  });
  const sendSingle = h('button', { text: '单条预演', attrs: { type: 'button' } });
  const batch = h('textarea', {
    attrs: { rows: '4', placeholder: '每行一条输入，作为一次运行提交', 'aria-label': '批量输入' },
  });
  const label = h('input', {
    attrs: { type: 'text', maxlength: '60', placeholder: '运行备注（可选，≤60 字）', 'aria-label': '运行备注' },
  });
  const sendBatch = h('button', { text: '批量运行', attrs: { type: 'button' } });
  const ack = h('input', { attrs: { type: 'checkbox', 'aria-label': '确认发起真实付费预演' } });
  const estimate = h('p', { class: 'admin-hint pw-estimate' });
  const unavailable = h('p', { class: 'admin-empty', hidden: true });

  const lines = () =>
    batch.value
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((text) => ({ text, note: null }));
  const simulated = () => (simMode.value === 'set' && /^\d\d:\d\d$/.test(simTime.value) ? simTime.value : undefined);
  const zone = () => detail?.draft?.profile.template.schedule.timeZone ?? '';
  const calls = (n: number) =>
    `约 ${n} 条预演 = ${n * 2} 次付费调用（每条含草稿与审核两个阶段，逐次预留预算）；单次运行最多 ${RUN_MAX} 条。`;
  const lock = () => {
    const ready = !busy && !!detail?.draft && detail.previewAvailable && can('preview');
    const base = ready && ack.checked;
    const n = lines().length;
    sendSingle.disabled = !base || !single.value.trim();
    sendBatch.disabled = !base || n === 0 || n > RUN_MAX || lines().some((l) => [...l.text].length > INPUT_MAX);
    runSet.disabled = !base || !setPicker.value;
    simTime.disabled = simMode.value !== 'set';
    editSets.disabled = busy;
    const set = sets.find((s) => s.id === setPicker.value);
    estimate.textContent =
      set && !runSet.disabled ? `评测集“${set.name}” v${set.version}：${calls(set.items.length)}` : calls(n);
    simZone.textContent = zone() ? `${zoneLabel(zone())}（角色时区 ${zone()}，不可更改）` : '';
  };
  function paintSetPicker() {
    const keep = setPicker.value;
    setPicker.replaceChildren(h('option', { text: sets.length ? '选择评测集…' : '尚无评测集', attrs: { value: '' } }));
    for (const s of sets)
      setPicker.append(
        h('option', { text: `${s.name} · v${s.version} · ${s.items.length} 条`, attrs: { value: s.id } }),
      );
    if (sets.some((s) => s.id === keep)) setPicker.value = keep;
    lock();
  }
  const bar = toolbar({ title: '预演设置' });
  const field = (text: string, ...nodes: Node[]) =>
    h('label', { class: 'admin-filter' }, h('span', { text }), ...nodes);
  bar.root.append(
    field('关系', relation),
    field('模拟时间', simMode, simTime),
    simZone,
    h('div', { class: 'admin-filter' }, h('span', { text: '关系与故事' }), castSwitch.root),
    h('span', { class: 'admin-bar-spacer' }),
    field('评测集', setPicker),
    runSet,
    editSets,
  );
  composeHost.append(
    bar.root,
    h('div', { class: 'pw-compose-row' }, single, sendSingle),
    h('div', { class: 'pw-compose-row' }, batch, h('div', { class: 'pw-compose-col' }, label, sendBatch)),
    h(
      'label',
      { class: 'admin-check' },
      ack,
      h('span', {
        text: '我确认发起真实付费文字预演，并已核对当前草稿、输入与模拟时间。费用逐次预留，页面不会自动重发。',
      }),
    ),
    estimate,
    unavailable,
  );
  for (const input of [relation, simMode, simTime, setPicker, single, batch, label, ack]) {
    input.addEventListener('input', lock);
    input.addEventListener('change', lock);
  }

  const submit = (work: () => Promise<void>) => {
    if (busy || gone()) return;
    busy = true;
    lock();
    void host.run(work).finally(() => {
      busy = false;
      lock();
    });
  };
  const draftBody = () => {
    const d = detail!.draft!;
    return { draftRevision: d.revision, profileHash: d.contentHash, relationship: relation.value || 'new' };
  };
  const startRun = (inputs: ReturnType<typeof lines> | null, setId: string | null) => {
    const d = detail?.draft;
    if (!d || !id) return;
    const characterId = id;
    const time = simulated();
    const body = {
      ...draftBody(),
      castSource,
      ...(label.value.trim() ? { label: label.value.trim() } : {}),
      ...(time ? { simulatedTime: time } : {}),
    };
    const sig = JSON.stringify([characterId, body, inputs, setId]);
    // The same submission is retried with the same requestId, so a lost reply can never queue a second run.
    if (pendingRun?.sig !== sig)
      pendingRun = {
        sig,
        body: { requestId: nextId(), ...body, ...(setId ? { evalSetId: setId } : { inputs: inputs! }) } as never,
      };
    const request = pendingRun.body;
    submit(async () => {
      const result = await host.api.startRun(characterId, request);
      pendingRun = null;
      if (gone() || characterId !== id) return;
      batch.value = '';
      ack.checked = false;
      open.add(result.runId);
      host.status('已提交一次运行；各条按顺序排队，不会自动重发。');
      await refresh([result.runId]);
      poller.kick();
    });
  };
  sendBatch.addEventListener('click', () => {
    if (!sendBatch.disabled) startRun(lines(), null);
  });
  runSet.addEventListener('click', () => {
    if (!runSet.disabled) startRun(null, setPicker.value);
  });
  sendSingle.addEventListener('click', () => {
    const d = detail?.draft;
    if (sendSingle.disabled || !d || !id) return;
    const characterId = id,
      time = simulated();
    const body = { ...draftBody(), castSource, message: single.value, ...(time ? { simulatedTime: time } : {}) };
    const sig = JSON.stringify([characterId, body]);
    if (pendingSingle?.sig !== sig) pendingSingle = { sig, body: { requestId: nextId(), ...body } };
    const request = pendingSingle.body;
    submit(async () => {
      const row = await host.api.startSingle(characterId, request);
      pendingSingle = null;
      if (gone() || characterId !== id) return;
      single.value = '';
      ack.checked = false;
      singles = [row, ...singles];
      known.set(row.previewId, `${row.status}|${row.settlement}|${row.errorCode}`);
      paintSingles();
      poller.kick();
    });
  });
  editSets.addEventListener('click', () => editor.open(sets));

  // ---- runs -------------------------------------------------------------------------------------------------------
  const runTitle = (run: RunSummary, index: number) => run.label ?? `运行 ${runs.length - index}`;
  const summaryLine = (run: RunSummary) => {
    const parts = [
      when(run.createdAt),
      RELATIONS.find(([v]) => v === run.relationship)?.[1] ?? run.relationship,
      run.simulatedTime ? `模拟 ${zoneLabel(run.timeZone)} ${run.simulatedTime.time}` : '真实时间',
      `草稿 ${run.draftRevision}`,
      run.evalSet ? `评测集 v${run.evalSet.version}` : null,
      `${run.counts.succeeded}/${run.itemCount} 通过${run.counts.failed ? ` · ${run.counts.failed} 失败` : ''}${
        run.counts.queued + run.counts.generating ? ` · ${run.counts.queued + run.counts.generating} 进行中` : ''
      }`,
    ];
    return parts.filter(Boolean).join(' · ');
  };
  const bubbleCell = (p: PreviewRow) => {
    if (p.final) return bubbleList(p.final.bubbles);
    if (p.status === 'failed') return h('span', { class: 'pw-fail', text: errorText(p.errorCode) });
    return h('span', { class: 'admin-hint', text: STATUS_LABEL[p.status] });
  };
  function rowsTable(run: RunSummary, filterValue: () => string) {
    const table = dataTable<PreviewRow>({
      columns: [
        {
          key: 'ordinal',
          label: '#',
          sortable: true,
          sortValue: (p) => p.ordinal ?? 0,
          render: (p) => String(p.ordinal ?? ''),
        },
        { key: 'input', label: '输入', render: (p) => p.input ?? '' },
        { key: 'final', label: '最终气泡', render: bubbleCell },
        {
          key: 'status',
          label: '状态',
          render: (p) => {
            const cell = h('span', {}, statusBadge(STATUS_LABEL[p.status], STATUS_TONE[p.status]));
            if (p.settlement && p.status === 'failed')
              cell.append(statusBadge(SETTLEMENT_LABEL[p.settlement], SETTLEMENT_TONE[p.settlement]));
            return cell;
          },
        },
        { key: 'changed', label: '审核改动', render: (p) => (p.final ? (p.final.reviewChanged ? '是' : '否') : '—') },
        { key: 'coverage', label: '覆盖', render: coverageText },
        { key: 'cost', label: '费用', align: 'end', render: (p) => micros(p.cost.chargedMicros) },
        {
          key: 'latency',
          label: '耗时',
          align: 'end',
          render: (p) =>
            p.latency.draftMs === null && p.latency.reviewMs === null
              ? '—'
              : `草稿 ${seconds(p.latency.draftMs)} · 审核 ${seconds(p.latency.reviewMs)}`,
        },
      ],
      rowKey: (p) => p.previewId,
      emptyText: '没有符合筛选的预演。',
      onRowOpen: (p) => void openRow(p),
      openOn: 'click',
    });
    table.sortBy('ordinal');
    const paint = () => {
      const all = loaded.get(run.runId)?.previews ?? [];
      const wanted = filterValue();
      table.setRows(wanted ? all.filter((p) => p.status === wanted) : all);
    };
    return { table, paint };
  }
  function paintRuns() {
    if (gone()) return;
    runsHost.replaceChildren();
    compareHost.replaceChildren();
    if (!runs.length) {
      runsHost.append(
        h('p', { class: 'admin-empty', text: '还没有运行。用上方“批量运行”或“运行评测集”开始一次评测。' }),
      );
      return;
    }
    runs.forEach((run, index) => {
      const section = h('details', {
        class: 'pw-run',
        attrs: { 'data-run': run.runId, ...(open.has(run.runId) ? { open: '' } : {}) },
      });
      const pick = h('input', {
        attrs: { type: 'checkbox', 'aria-label': '选择此运行用于对比', 'data-compare': run.runId },
      });
      pick.checked = chosen.includes(run.runId);
      pick.addEventListener('click', (event) => event.stopPropagation());
      pick.addEventListener('change', () => {
        const at = chosen.indexOf(run.runId);
        if (pick.checked && at < 0) chosen.push(run.runId);
        if (!pick.checked && at >= 0) chosen.splice(at, 1);
        while (chosen.length > 2) chosen.shift();
        paintRuns();
      });
      const exportJson = h('button', {
        class: 'admin-secondary',
        text: '导出 JSON',
        attrs: { type: 'button', 'data-export': 'json' },
      });
      const exportCsv = h('button', {
        class: 'admin-secondary',
        text: '导出 CSV',
        attrs: { type: 'button', 'data-export': 'csv' },
      });
      for (const [button, kind] of [
        [exportJson, 'json'],
        [exportCsv, 'csv'],
      ] as const)
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          void host.run(async () => {
            const full = await ensureRun(run.runId, true);
            const save = host.download ?? downloadText;
            if (kind === 'json') save(exportName(full.run, 'json'), runToJson(full), 'application/json');
            else save(exportName(full.run, 'csv'), runToCsv(full), 'text/csv');
          });
        });
      const filter = toolbar({ filters: [{ kind: 'select', id: 'status', label: '状态', options: FILTER_STATUSES }] });
      let table: ReturnType<typeof rowsTable> | null = null;
      const fill = () => {
        if (!table) {
          table = rowsTable(run, () => filter.values().status ?? '');
          body.append(filter.root, table.table.root);
        }
        table.paint();
      };
      const body = h('div', { class: 'pw-run-body' });
      section.append(
        h(
          'summary',
          {},
          h('strong', { text: runTitle(run, index) }),
          h('span', { class: 'admin-hint', text: ` ${summaryLine(run)}` }),
          h(
            'span',
            { class: 'pw-run-actions' },
            h('label', { class: 'admin-check' }, pick, h('span', { text: '对比' })),
            exportJson,
            exportCsv,
          ),
        ),
        body,
      );
      filter.root.addEventListener('change', () => table?.paint());
      section.addEventListener('toggle', () => {
        if (section.hasAttribute('open')) {
          open.add(run.runId);
          void ensureRun(run.runId, false).then(fill);
        } else open.delete(run.runId);
      });
      runsHost.append(section);
      if (open.has(run.runId)) {
        if (loaded.has(run.runId)) fill();
        else void ensureRun(run.runId, false).then(fill);
      }
    });
    if (chosen.length === 2) {
      const go = h('button', { text: '对比所选两次运行', attrs: { type: 'button', 'data-compare-go': '' } });
      go.addEventListener('click', () => void showCompare());
      compareHost.append(h('div', { class: 'admin-bar' }, h('span', { text: '已选 2 次运行' }), go));
    }
  }
  async function ensureRun(runId: string, force: boolean) {
    const characterId = id!;
    const cached = loaded.get(runId);
    if (cached && !force) return cached;
    const full = await host.api.run(characterId, runId);
    if (!gone() && characterId === id) {
      loaded.set(runId, full);
      for (const p of full.previews) known.set(p.previewId, `${p.status}|${p.settlement}|${p.errorCode}`);
    }
    return full;
  }
  async function refresh(runIds: string[]) {
    const characterId = id;
    if (!characterId) return;
    const next = await host.api.list(characterId);
    if (gone() || characterId !== id) return;
    runs = next.runs;
    singles = next.singles;
    for (const row of singles) known.set(row.previewId, `${row.status}|${row.settlement}|${row.errorCode}`);
    for (const runId of new Set([...runIds, ...open]))
      if (runs.some((r) => r.runId === runId)) await ensureRun(runId, true);
    if (gone() || characterId !== id) return;
    paintRuns();
    paintSingles();
  }

  // ---- single previews --------------------------------------------------------------------------------------------
  function paintSingles() {
    if (gone()) return;
    singlesHost.replaceChildren(h('h3', { text: '单条预演' }));
    if (!singles.length) {
      singlesHost.append(h('p', { class: 'admin-empty', text: '没有单条预演。' }));
      return;
    }
    const table = dataTable<PreviewRow>({
      columns: [
        { key: 'input', label: '输入', render: (p) => p.input ?? '' },
        { key: 'final', label: '最终气泡', render: bubbleCell },
        { key: 'status', label: '状态', render: (p) => statusBadge(STATUS_LABEL[p.status], STATUS_TONE[p.status]) },
        { key: 'cost', label: '费用', align: 'end', render: (p) => micros(p.cost.chargedMicros) },
        { key: 'at', label: '时间', render: (p) => when(p.createdAt) },
      ],
      rowKey: (p) => p.previewId,
      emptyText: '没有单条预演。',
      onRowOpen: (p) => void openRow(p),
      openOn: 'click',
    });
    table.setRows(singles);
    singlesHost.append(table.root);
  }

  // ---- drawer -----------------------------------------------------------------------------------------------------
  async function openRow(row: PreviewRow) {
    const characterId = id;
    if (!characterId) return;
    side.setTitle(row.ordinal ? `预演 #${row.ordinal}` : '单条预演');
    side.body.replaceChildren(h('p', { class: 'admin-hint', text: '正在读取…' }));
    side.open();
    await host.run(async () => {
      const full = await host.api.detail(characterId, row.previewId);
      if (gone() || characterId !== id) return;
      renderDetail(full);
    });
  }
  function renderDetail(p: PreviewDetail) {
    const body = side.body;
    body.replaceChildren();
    const section = (title: string, ...nodes: Node[]) =>
      body.append(h('section', { class: 'pw-section' }, h('h4', { text: title }), ...nodes));
    section(
      '输入',
      h('pre', { class: 'pw-pre', text: p.input ?? '' }),
      p.note ? h('p', { class: 'admin-hint', text: `备注：${p.note}` }) : (null as never),
    );
    const draftTexts = p.draft?.bubbles?.map((b) => b.text) ?? [];
    const finalTexts = p.final?.bubbles.map((b) => b.text) ?? [];
    if (p.final) {
      const diff = h('div', { class: 'pw-diff' });
      for (const row of diffBubbles(draftTexts, finalTexts)) {
        const line = h('div', { class: 'pw-diff-row' });
        for (const piece of row.pieces)
          line.append(
            h('span', {
              class: piece.kind === 'same' ? '' : piece.kind === 'del' ? 'pw-del' : 'pw-add',
              text: piece.text,
            }),
          );
        diff.append(line);
      }
      section(
        p.final?.reviewChanged
          ? `草稿与最终气泡（审核改动已标出${p.final.reviewDecisionNormalized ? '；审核写了 reject 但给出了可发布的替代气泡，已按 accept 处理' : ''}）`
          : '草稿与最终气泡（审核未改动）',
        h(
          'div',
          { class: 'pw-sides' },
          h(
            'div',
            {},
            h('h5', { text: '草稿' }),
            p.draft?.bubbles ? bubbleList(p.draft.bubbles) : h('p', { class: 'admin-hint', text: '—' }),
          ),
          h(
            'div',
            {},
            h('h5', { text: '最终' }),
            p.final ? bubbleList(p.final.bubbles) : h('p', { class: 'admin-hint', text: '—' }),
          ),
        ),
        diff,
      );
    }
    if (p.review?.coverage) {
      const list = h('ul', { class: 'pw-coverage' });
      for (const [messageId, item] of Object.entries(p.review.coverage))
        list.append(
          h(
            'li',
            {},
            statusBadge(
              COVERAGE_LABEL[item.status as keyof typeof COVERAGE_LABEL] ?? item.status,
              item.status === 'answered' ? 'ok' : 'warn',
            ),
            h('span', { text: item.supportQuote ? ` 引用：“${item.supportQuote}”` : '' }),
            item.missingInformation ? h('span', { text: ` 缺少：${item.missingInformation}` }) : null,
            h('code', { class: 'admin-hint', text: ` ${messageId}` }),
          ),
        );
      section('覆盖与引用', list);
    }
    const topics = p.final?.topics ?? p.review?.topics ?? [];
    const factOps = p.final?.factOps ?? p.review?.factOps ?? [];
    if (topics.length || factOps.length)
      section('话题 / 事实', h('pre', { class: 'pw-pre', text: JSON.stringify({ topics, factOps }, null, 2) }));
    if (p.status === 'failed') {
      const parts: Node[] = [h('p', { class: 'pw-fail', text: errorText(p.errorCode) })];
      for (const r of p.rejected)
        parts.push(
          h('h5', {
            text: `${r.phase === 'draft' ? '草稿' : '审核'}阶段被拒收的模型输出（${r.errorCode}${r.truncated ? `，已截断，原文 ${r.rawBytes} 字节` : ''}）`,
          }),
          h('pre', { class: 'pw-pre pw-raw', text: r.rawOutput }),
        );
      if (!p.rejected.length)
        parts.push(
          h('p', { class: 'admin-hint', text: '没有保留模型输出（失败发生在返回完整响应之前，或在此功能启用之前）。' }),
        );
      section('失败', ...parts);
    }
    section(
      '结算',
      p.settlement ? statusBadge(SETTLEMENT_LABEL[p.settlement], SETTLEMENT_TONE[p.settlement]) : (null as never),
      h('p', { class: 'pw-settlement', text: settlementCopy(p) }),
      keyValuePanel([
        [
          '草稿阶段',
          p.cost.draft
            ? `${p.cost.draft.model} · 实收 ${micros(p.cost.draft.chargedMicros)} · 预留 ${micros(p.cost.draft.reservedMicros)} · ${seconds(p.cost.draft.wallMs)}`
            : null,
        ],
        [
          '审核阶段',
          p.cost.review
            ? `${p.cost.review.model} · 实收 ${micros(p.cost.review.chargedMicros)} · 预留 ${micros(p.cost.review.reservedMicros)} · ${seconds(p.cost.review.wallMs)}`
            : null,
        ],
        ['合计', `实收 ${micros(p.cost.chargedMicros)} · 仍保留 ${micros(p.cost.heldMicros)}`],
      ]),
    );
    section(
      '标识',
      keyValuePanel([
        ['预演 ID', p.ids.previewId],
        ['运行 ID', p.ids.runId],
        ['草稿 / 资料哈希', `${p.draftRevision} / ${p.profileHash.slice(0, 12)}`],
        [
          '模拟时间',
          p.simulatedTime
            ? `${zoneLabel(p.simulatedTime.timeZone)} ${p.simulatedTime.time}（${p.simulatedTime.timeZone}）`
            : '真实时间',
        ],
        ['提交时间', when(p.createdAt)],
        ...p.ids.budgetIds.map((b) => [`预算 ${b.phase}`, b.budgetId] as const),
        ...p.ids.providerRequestIds.map((b) => [`供应商请求 ${b.phase}`, b.requestId] as const),
      ]),
    );
  }

  // ---- compare ----------------------------------------------------------------------------------------------------
  async function showCompare() {
    const [a, b] = chosen;
    if (!a || !b) return;
    await host.run(async () => {
      const [left, right] = await Promise.all([ensureRun(a, false), ensureRun(b, false)]);
      const name = (r: RunDetail) => r.run.label ?? when(r.run.createdAt);
      const side_ = (r: RunDetail) => `${name(r)}${r.run.simulatedTime ? ` · ${r.run.simulatedTime.time}` : ''}`;
      const table = dataTable<ReturnType<typeof compareRuns>[number]>({
        columns: [
          { key: 'input', label: '输入', render: (r) => r.input },
          { key: 'a', label: `A：${side_(left)}`, render: (r) => (r.a ? bubbleCell(r.a) : '—') },
          { key: 'b', label: `B：${side_(right)}`, render: (r) => (r.b ? bubbleCell(r.b) : '—') },
          {
            key: 'status',
            label: '状态 A / B',
            render: (r) => `${r.a ? STATUS_LABEL[r.a.status] : '—'} / ${r.b ? STATUS_LABEL[r.b.status] : '—'}`,
          },
          {
            key: 'changed',
            label: '审核改动 A / B',
            render: (r) =>
              `${r.a?.final ? (r.a.final.reviewChanged ? '是' : '否') : '—'} / ${r.b?.final ? (r.b.final.reviewChanged ? '是' : '否') : '—'}`,
          },
          {
            key: 'coverage',
            label: '覆盖 A / B',
            render: (r) => `${r.a ? coverageText(r.a) : '—'} / ${r.b ? coverageText(r.b) : '—'}`,
          },
          {
            key: 'cost',
            label: '费用 A / B',
            align: 'end',
            render: (r) =>
              `${r.a ? micros(r.a.cost.chargedMicros) : '—'} / ${r.b ? micros(r.b.cost.chargedMicros) : '—'}`,
          },
        ],
        rowKey: (r) => `${r.a?.previewId ?? '-'}:${r.b?.previewId ?? '-'}`,
        emptyText: '两次运行都没有预演。',
      });
      table.setRows(compareRuns(left.previews, right.previews));
      compareDrawer.body.replaceChildren(table.root);
      compareDrawer.open();
    });
  }

  // ---- lifecycle --------------------------------------------------------------------------------------------------
  async function openCharacter(characterId: string) {
    const token = ++view;
    id = characterId;
    runs = [];
    singles = [];
    loaded.clear();
    open.clear();
    chosen.length = 0;
    known.clear();
    pendingRun = null;
    pendingSingle = null;
    poller.stop();
    side.close();
    compareDrawer.close();
    const [d, list, setList] = await Promise.all([
      host.characters.detail(characterId),
      host.api.list(characterId),
      host.api.evalSets().catch(() => [] as EvalSet[]),
    ]);
    if (gone() || token !== view) return;
    detail = d;
    runs = list.runs;
    singles = list.singles;
    sets = setList;
    for (const row of singles) known.set(row.previewId, `${row.status}|${row.settlement}|${row.errorCode}`);
    if (runs[0]) open.add(runs[0].runId);
    unavailable.hidden = !!d.draft && d.previewAvailable;
    unavailable.textContent = !d.draft
      ? '这个角色还没有已保存的草稿，不能预演。'
      : !d.previewAvailable
        ? '当前运行未开启预演。'
        : '';
    paintSetPicker();
    paintRuns();
    paintSingles();
    lock();
    if (runs.some((r) => r.counts.queued + r.counts.generating > 0) || singles.some(isOpen)) poller.kick();
  }
  return {
    open: openCharacter,
    update(next: boolean) {
      busy = next;
      lock();
    },
    clear() {
      view++;
      id = null;
      detail = null;
      runs = [];
      singles = [];
      loaded.clear();
      poller.stop();
      side.close();
      compareDrawer.close();
      runsHost.replaceChildren();
      compareHost.replaceChildren();
      singlesHost.replaceChildren();
    },
    dispose() {
      disposed = true;
      poller.dispose();
      side.dispose();
      compareDrawer.dispose();
      editor.dispose();
    },
    /** Test seam: the poller's state. */
    poller,
  };
}
