import assert from 'node:assert/strict';
import test from 'node:test';
import { previewWorkbench, type PreviewWorkbenchHost } from '../../src/features/admin/preview/preview-workbench.ts';
import { previewPoller, POLL_FIRST_MS, POLL_MAX_MS } from '../../src/features/admin/preview/poller.ts';
import { diffBubbles, diffText } from '../../src/features/admin/preview/diff.ts';
import { compareRuns } from '../../src/features/admin/preview/compare.ts';
import { CSV_HEADER, runToCsv, runToJson } from '../../src/features/admin/preview/export.ts';
import { settlementCopy, zoneLabel } from '../../src/features/admin/preview/copy.ts';
import {
  evalLineProblem,
  formatEvalLines,
  parseEvalLines,
  evalSetEditor,
} from '../../src/features/admin/preview/eval-set-editor.ts';
import type {
  EvalSet,
  PreviewDetail,
  PreviewRow,
  RunDetail,
  RunSummary,
  StatusEntry,
} from '../../src/services/preview-admin-api.ts';
import { PreviewAdminClient } from '../../src/services/preview-admin-api.ts';
import type { AdminMember } from '../../src/services/account-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

const el = (node: unknown) => node as FakeElement;
const OWNER = { role: 'owner', permissions: [] } as unknown as AdminMember;
const READER = { role: 'admin', permissions: ['characters.read:jojo'] } as unknown as AdminMember;
const text = (node: FakeElement) => node.textContent;
const byText = (root: FakeElement, tag: string, label: string) =>
  root.querySelectorAll(tag).find((n) => n.textContent === label) as FakeElement;
const label = (root: FakeElement, aria: string) => root.querySelector(`[aria-label="${aria}"]`) as FakeElement;

const stage = (state = 'known', charged: number | null = 120, wall: number | null = 2300) => ({
  state,
  outcome: state === 'known' ? 'succeeded' : null,
  model: 'deepseek-v4-flash',
  reservedMicros: 900,
  chargedMicros: charged,
  heldMicros: state === 'known' ? 0 : 900,
  wallMs: wall,
});
function row(over: Partial<PreviewRow> & { ordinal: number; input: string }): PreviewRow {
  return {
    previewId: `p${over.runId ?? 'x'}${over.ordinal}`,
    characterId: 'jojo',
    draftRevision: 3,
    profileHash: 'a'.repeat(64),
    status: 'succeeded',
    errorCode: null,
    createdAt: 1_800_000_000_000,
    finishedAt: 1_800_000_020_000,
    runId: 'r1',
    note: null,
    simulatedTime: { time: '05:50', timeZone: 'Asia/Singapore' },
    settlement: 'settled_known',
    cost: { draft: stage(), review: stage('known', 80, 1500), chargedMicros: 200, heldMicros: 0 },
    latency: { draftMs: 2300, reviewMs: 1500 },
    final: {
      bubbles: [
        { text: '早呀', expression: 'upbeat' },
        { text: '今天想吃什么？', expression: 'soft' },
      ],
      mode: 'casual',
      endsSession: false,
      reviewChanged: true,
      coverage: [{ messageId: 'm1', status: 'answered' }],
      topics: [],
      factOps: [],
    },
    ...over,
  };
}
const failedKnown = row({
  ordinal: 2,
  input: '会失败',
  status: 'failed',
  errorCode: 'INVALID_TOPICS',
  settlement: 'settled_known',
  final: null,
  cost: { draft: stage(), review: { ...stage('known', 70), outcome: 'failed' }, chargedMicros: 190, heldMicros: 0 },
});
const failedUnknown = row({
  ordinal: 3,
  input: '网络断了',
  status: 'failed',
  errorCode: 'PREVIEW_CALL_UNKNOWN',
  settlement: 'held_unknown',
  final: null,
  cost: { draft: stage('unknown', null, null), review: null, chargedMicros: 0, heldMicros: 900 },
  latency: { draftMs: null, reviewMs: null },
});
const run1 = (over: Partial<RunSummary> = {}): RunSummary => ({
  runId: 'r1',
  characterId: 'jojo',
  label: '改人设前',
  draftRevision: 3,
  profileHash: 'a'.repeat(64),
  relationship: 'friend',
  simulatedTime: { time: '05:50', timeZone: 'Asia/Singapore' },
  timeZone: 'Asia/Singapore',
  evalSet: { id: 'e1', version: 2 },
  itemCount: 3,
  createdBy: 'm',
  createdAt: 1_800_000_000_000,
  counts: { queued: 0, generating: 0, succeeded: 1, failed: 2 },
  ...over,
});
const detailOf = (runId: string, rows: PreviewRow[], over: Partial<RunSummary> = {}): RunDetail => ({
  run: run1({ runId, ...over }),
  previews: rows.map((r) => ({ ...r, runId })),
});

function setup(
  t: test.TestContext,
  options: {
    runs?: RunDetail[];
    singles?: PreviewRow[];
    sets?: EvalSet[];
    member?: AdminMember;
    previewAvailable?: boolean;
    hidden?: boolean;
    /** Part 24b-6c: no saved draft / unsaved edits beside the panel. */
    draft?: boolean;
    unsaved?: boolean;
  } = {},
) {
  installFakeDom(t);
  const root = document.createElement('div') as unknown as HTMLElement;
  const runs = options.runs ?? [detailOf('r1', [row({ ordinal: 1, input: '早上好' }), failedKnown, failedUnknown])];
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  const downloads: Array<{ name: string; text: string; type: string }> = [];
  const toasts: string[] = [];
  const toastActions: Array<{ text: string; label: string; run: () => void }> = [];
  const saves: string[] = [];
  const held: { startSingle: null | Promise<unknown> } = { startSingle: null };
  let active = 0,
    statuses: StatusEntry[] = [];
  const state = { hidden: options.hidden ?? false, visible: [] as Array<() => void> };
  const api = {
    list: async () => {
      calls.push('list');
      return { runs: runs.map((r) => r.run), singles: options.singles ?? [] };
    },
    run: async (_id: string, runId: string) => {
      calls.push(`run:${runId}`);
      return runs.find((r) => r.run.runId === runId)!;
    },
    detail: async (_id: string, previewId: string): Promise<PreviewDetail> => {
      calls.push(`detail:${previewId}`);
      const found = [...runs.flatMap((r) => r.previews), ...(options.singles ?? [])].find(
        (p) => p.previewId === previewId,
      )!;
      return {
        ...found,
        draft: { mode: 'casual', bubbles: [{ text: '早呀，今天想吃什么', expression: 'neutral' }] },
        review: {
          decision: 'accept',
          replacementBubbles: [],
          coverage: { m1: { status: 'answered', supportQuote: '今天想吃什么？', missingInformation: '' } },
          topics: [],
          factOps: [],
        },
        rejected:
          found.status === 'failed' && found.settlement === 'settled_known'
            ? [
                {
                  phase: 'review',
                  errorCode: 'INVALID_TOPICS',
                  rawOutput: '{"topics":[1,2,3,4]}',
                  rawBytes: 20,
                  truncated: false,
                },
              ]
            : [],
        ids: {
          previewId,
          runId: found.runId,
          budgetIds: [{ phase: 'draft', budgetId: 'b-1' }],
          providerRequestIds: [],
        },
      };
    },
    status: async (_id: string, runId: string | null) => {
      calls.push(`status:${runId}`);
      return { previews: statuses, active };
    },
    startRun: async (_id: string, body: unknown) => {
      calls.push('startRun');
      (api as unknown as { lastRun: unknown }).lastRun = body;
      if ((api as unknown as { failNext?: boolean }).failNext) {
        (api as unknown as { failNext?: boolean }).failNext = false;
        throw new Error('network');
      }
      return { runId: 'r1', replayed: false };
    },
    startSingle: async (_id: string, body: unknown) => {
      calls.push('startSingle');
      (api as unknown as { lastSingle: unknown }).lastSingle = body;
      if (held.startSingle) await held.startSingle;
      return row({
        ordinal: 0,
        input: (body as { message: string }).message,
        runId: null,
        ordinal_: 0,
        createdAt: 1_800_000_001_000,
      } as never) as PreviewRow;
    },
    evalSets: async () => options.sets ?? [],
    saveEvalSet: async () => ({}) as EvalSet,
    deleteEvalSet: async () => {},
  };
  const host: PreviewWorkbenchHost = {
    api: api as unknown as PreviewWorkbenchHost['api'],
    characters: {
      detail: async () =>
        ({
          characterId: 'jojo',
          published: null,
          draft:
            options.draft === false
              ? null
              : {
                  characterId: 'jojo',
                  revision: 3,
                  baseVersion: null,
                  contentHash: 'a'.repeat(64),
                  savedAt: 1,
                  profile: {
                    template: { schedule: { timeZone: 'Asia/Singapore' } },
                    presentation: { displayName: 'JOJO' },
                  },
                },
          previews: [],
          previewAvailable: options.previewAvailable ?? true,
        }) as never,
    },
    member: () => options.member ?? OWNER,
    run: async (work) => {
      try {
        await work();
      } catch (e) {
        calls.push('error:' + (e as Error).message);
      }
    },
    status: () => {},
    disposed: () => false,
    toast: (message, _tone, action) => {
      toasts.push(message);
      if (action) toastActions.push({ text: message, label: action.label, run: action.run });
    },
    modalParent: () => root,
    draftUnsaved: () => options.unsaved === true,
    saveDraft: () => saves.push('save'),
    poll: {
      setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
      clearTimer: () => {},
      hidden: () => state.hidden,
      onVisible: (fn) => {
        state.visible.push(fn);
        return () => {};
      },
    },
    download: (name, body, type) => downloads.push({ name, text: body, type }),
    newId: (() => {
      let n = 0;
      return () => `req-${++n}`;
    })(),
  };
  const bench = previewWorkbench(root, host);
  return {
    root: el(root),
    bench,
    api,
    calls,
    timers,
    downloads,
    toasts,
    toastActions,
    saves,
    held,
    state,
    setStatus(next: StatusEntry[], n: number) {
      statuses = next;
      active = n;
    },
  };
}
/** Part 24b-6c: the lines of a run, in the results (each `.pw-line` carries its previewId as data-key). */
const linesOf = (root: FakeElement, runId = 'r1') =>
  el(root.querySelector(`[data-run="${runId}"]`)).querySelectorAll('.pw-line');
const sendButton = (root: FakeElement) => root.querySelector('[data-pw-send="preview"]') as FakeElement;
const reasonOf = (root: FakeElement) => text(root.querySelector('[data-pw-reason="preview"]') as FakeElement);
/** The two clicks of a paid call: the first asks, the second sends. */
const confirmSend = (root: FakeElement) => {
  sendButton(root).click();
  sendButton(root).click();
};

// Named exceptions (Part 24b-6c, one working column): the runs are no longer a table of tables. A run is ONE row (title, time, relation,
// simulated time, "n / m 完成" and a thin bar) whose lines open directly below it; each line is a row with its own live state, result, cost
// and time. What a line says is unchanged: the final bubbles, the error wording, the settlement badge that follows the ledger label.
test('results: a run is one row with its count and bar; its lines carry state, result, cost and time', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const head = f.root.querySelector('[data-key="r1"] .pw-run-head') as FakeElement;
  assert.match(text(head), /改人设前/);
  assert.match(text(head), /北京时间 05:50/);
  assert.match(text(head), /3 \/ 3 完成 · 2 失败/);
  const bar = head.querySelector('.pw-progress') as FakeElement;
  assert.equal(bar.getAttribute('aria-valuenow'), '3');
  assert.equal(bar.getAttribute('aria-valuemax'), '3');
  const lines = linesOf(f.root);
  assert.equal(lines.length, 3);
  const first = lines[0]!;
  assert.equal(text(first.querySelector('.pw-state') as FakeElement), '完成');
  assert.match(text(first.querySelector('.pw-input') as FakeElement), /早上好/);
  assert.equal(text(first.querySelector('.pw-result') as FakeElement), '早呀 / 今天想吃什么？');
  assert.match(text(first.querySelectorAll('.pw-num')[0] as FakeElement), /µ\$|\$/);
  assert.match(text(first.querySelectorAll('.pw-num')[1] as FakeElement), /草稿 2\.3s · 审核 1\.5s/);
  // Failed rows say why, and the settlement badge follows the label, not the error code.
  assert.equal(text(lines[1]!.querySelector('.pw-state') as FakeElement), '失败');
  assert.match(text(lines[1]!.querySelector('.pw-result') as FakeElement), /INVALID_TOPICS/);
  assert.match(text(lines[1]!.querySelector('.pw-result') as FakeElement), /已按实际用量结算/);
  assert.match(text(lines[2]!.querySelector('.pw-result') as FakeElement), /结果未知，额度保留/);
  // Nothing was polled: nothing is queued or running.
  assert.equal(f.timers.length, 0);
});

test('results: a run in progress shows each line as 排队中 / 生成草稿 / 审核中 and "n / m 完成" with a bar that follows', async (t) => {
  const working = detailOf(
    'r1',
    [
      row({ ordinal: 1, input: '甲' }),
      row({ ordinal: 2, input: '乙', status: 'generating', final: null, latency: { draftMs: null, reviewMs: null } }),
      row({ ordinal: 3, input: '丙', status: 'generating', final: null, latency: { draftMs: 900, reviewMs: null } }),
      row({ ordinal: 4, input: '丁', status: 'queued', final: null, latency: { draftMs: null, reviewMs: null } }),
    ],
    { itemCount: 4, counts: { queued: 1, generating: 2, succeeded: 1, failed: 0 } },
  );
  const f = setup(t, { runs: [working] });
  await f.bench.open('jojo');
  await flush();
  assert.deepEqual(
    linesOf(f.root).map((l) => text(l.querySelector('.pw-state') as FakeElement)),
    ['完成', '生成草稿', '审核中', '排队中'],
  );
  assert.match(text(f.root.querySelector('[data-key="r1"] .pw-run-head') as FakeElement), /1 \/ 4 完成/);
  assert.equal(f.root.querySelector('[data-key="r1"] .pw-progress')!.getAttribute('aria-valuenow'), '1');
  // Something is running: the poller is on, and the page announces it politely.
  assert.ok(f.timers.length > 0);
  assert.equal(f.root.querySelector('.pw-feed')!.getAttribute('aria-live'), 'polite');
});

test('results: the lines of a run can be filtered by status and stay in order', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const keys = () => linesOf(f.root).map((l) => l.getAttribute('data-key'));
  assert.deepEqual(keys(), ['px1', 'px2', 'px3']);
  const select = el(f.root.querySelector('[data-run="r1"]')).querySelector('select') as FakeElement;
  select.value = 'failed';
  select.dispatch('change');
  assert.deepEqual(keys(), ['px2', 'px3']);
  select.value = 'succeeded';
  select.dispatch('change');
  assert.deepEqual(keys(), ['px1']);
  select.value = '';
  select.dispatch('change');
  assert.deepEqual(keys(), ['px1', 'px2', 'px3']);
});

test('copy follows the settlement label: a known failure never says 未知调用, an unknown one does', () => {
  const known = settlementCopy(failedKnown);
  assert.doesNotMatch(known, /未知调用/);
  assert.match(known, /已按实际用量结算/);
  assert.match(known, /重新预演/);
  const unknown = settlementCopy(failedUnknown);
  assert.match(unknown, /未知调用不能重发或释放/);
  assert.match(
    settlementCopy({ ...failedKnown, settlement: 'released_unsent', cost: { ...failedKnown.cost, chargedMicros: 0 } }),
    /没有发出任何调用/,
  );
  assert.equal(settlementCopy({ status: 'queued', settlement: null, cost: failedKnown.cost }), '尚未发送。');
});

// Named exceptions (Part 24b-6c): a result opens BELOW its row (no side drawer). What it shows is unchanged.
test("row click opens the result below its row: draft vs final with the reviewer's changes marked, coverage and quotes, ids", async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const line = linesOf(f.root)[0]!;
  (line.querySelector('.pw-row') as FakeElement).dispatch('click');
  await flush();
  assert.ok(f.calls.includes('detail:px1'), f.calls.join());
  const panel = line.querySelector('.pw-panel') as FakeElement;
  assert.equal(panel.getAttribute('data-state'), 'open');
  assert.equal(f.root.querySelectorAll('.admin-drawer').length, 0, 'no drawer anywhere in 预演');
  assert.equal(f.root.querySelectorAll('.admin-dialog').length, 0, 'no dialog anywhere in 预演');
  const body = text(panel);
  assert.match(body, /早上好/);
  assert.match(body, /草稿与最终气泡（审核改动已标出）/);
  assert.match(body, /引用：“今天想吃什么？”/);
  assert.match(body, /已回答/);
  assert.match(body, /已按实际用量结算/);
  assert.match(body, /b-1/);
  assert.match(body, /北京时间/);
  const marks = panel.querySelectorAll('.pw-del, .pw-add').map((n) => [n.className, text(n)]);
  assert.ok(
    marks.some(([c]) => c === 'pw-add'),
    'something the reviewer added is highlighted',
  );
});

test("a failed row's result shows the rejected output and the error; a settled failure is not described as unknown", async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  (linesOf(f.root)[1]!.querySelector('.pw-row') as FakeElement).dispatch('click');
  await flush();
  const panel = linesOf(f.root)[1]!.querySelector('.pw-panel') as FakeElement;
  const body = text(panel);
  assert.match(body, /INVALID_TOPICS/);
  assert.match(body, /被拒收的模型输出/);
  assert.equal(text(panel.querySelector('.pw-raw') as FakeElement), '{"topics":[1,2,3,4]}');
  assert.doesNotMatch(body, /未知调用/);
  assert.match(body, /重新预演/);
  // The unknown call: the copy that forbids resend is shown, no rejected output exists to show, and only one result is open at a time.
  (linesOf(f.root)[2]!.querySelector('.pw-row') as FakeElement).dispatch('click');
  await flush();
  const unknown = text(linesOf(f.root)[2]!.querySelector('.pw-panel') as FakeElement);
  assert.match(unknown, /未知调用不能重发或释放/);
  assert.match(unknown, /没有保留模型输出/);
  assert.doesNotMatch(unknown, /被拒收的模型输出/);
  assert.equal(linesOf(f.root)[1]!.getAttribute('data-open'), 'false');
  assert.equal(f.root.querySelectorAll('.pw-line[data-open="true"]').length, 1);
});

test('diff: a changed bubble carries a character diff, a removed one and an added one are marked whole', () => {
  assert.deepEqual(diffText('今天好吗', '今天好呀'), [
    { kind: 'same', text: '今天好' },
    { kind: 'del', text: '吗' },
    { kind: 'add', text: '呀' },
  ]);
  const rows = diffBubbles(['甲', '乙'], ['甲', '丙', '丁']);
  assert.deepEqual(
    rows.map((r) => r.pieces.map((p) => p.kind)),
    [['same'], ['del', 'add'], ['add']],
  );
  assert.deepEqual(diffBubbles(['只有草稿'], [])[0]!.pieces, [{ kind: 'del', text: '只有草稿' }]);
});

test('compare: two runs side by side, matched by input text, unmatched inputs keep an empty side', async (t) => {
  const a = detailOf('r1', [row({ ordinal: 1, input: '早上好' }), row({ ordinal: 2, input: '只有 A' })]);
  const b = detailOf(
    'r2',
    [
      row({
        ordinal: 1,
        input: '早上好',
        final: {
          ...row({ ordinal: 1, input: 'x' }).final!,
          bubbles: [{ text: '十五点好', expression: null }],
          reviewChanged: false,
        },
      }),
      row({ ordinal: 2, input: '只有 B' }),
    ],
    {
      label: '下午三点',
      simulatedTime: { time: '15:00', timeZone: 'Asia/Singapore' },
      createdAt: 1_800_000_100_000,
    },
  );
  assert.deepEqual(
    compareRuns(a.previews, b.previews).map((r) => [r.input, r.a?.ordinal ?? null, r.b?.ordinal ?? null]),
    [
      ['早上好', 1, 1],
      ['只有 A', 2, null],
      ['只有 B', null, 2],
    ],
  );
  const f = setup(t, { runs: [a, b] });
  await f.bench.open('jojo');
  await flush();
  // Named exceptions (Part 24b-6, 24b-6c): the two runs are ticked with the run row's own checkbox, the button reads 对比所选 2 次, and the
  // comparison opens INLINE above the results (it was a drawer).
  const picks = ['r1', 'r2'].map((id) => f.root.querySelector(`[data-key="${id}"] .pw-tick input`) as FakeElement);
  assert.equal(f.root.querySelectorAll('.pw-tick input').length, 2);
  assert.equal(f.root.querySelector('[data-compare-go]'), null, 'needs two runs');
  picks[0]!.checked = true;
  picks[0]!.dispatch('change');
  picks[1]!.checked = true;
  picks[1]!.dispatch('change');
  const go = f.root.querySelector('[data-compare-go]') as FakeElement;
  go.click();
  await flush();
  assert.equal(f.root.querySelectorAll('.admin-drawer').length, 0, 'inline, not a drawer');
  const result = f.root.querySelector('.pw-compare-result') as FakeElement;
  assert.deepEqual(
    result
      .querySelectorAll('th')
      .map((th) => text(th))
      .slice(0, 3),
    ['输入', 'A：改人设前 · 05:50', 'B：下午三点 · 15:00'],
  );
  const body = result.querySelectorAll('tbody tr');
  assert.equal(body.length, 3);
  const cellsOf = (tr: FakeElement) => tr.querySelectorAll('td');
  assert.match(text(cellsOf(body[0]!)[2]!), /十五点好/);
  assert.equal(text(cellsOf(body[1]!)[2]!), '—');
  assert.equal(text(cellsOf(body[2]!)[1]!), '—');
});

test('export: JSON and CSV (UTF-8 with BOM, CRLF, formula-safe) of one run, no extra network read of other runs', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const run = f.root.querySelector('[data-run="r1"]') as FakeElement;
  (run.querySelector('[data-export="csv"]') as FakeElement).click();
  (run.querySelector('[data-export="json"]') as FakeElement).click();
  await flush();
  assert.equal(f.downloads.length, 2);
  const csv = f.downloads.find((d) => d.name.endsWith('.csv'))!;
  assert.equal(csv.type, 'text/csv');
  assert.ok(csv.text.startsWith('﻿' + CSV_HEADER.join(',')), 'BOM then the header');
  assert.ok(csv.text.includes('\r\n'));
  assert.match(csv.text, /"早呀\n今天想吃什么？"/, 'bubbles are one per line inside the cell');
  assert.match(csv.text, /INVALID_TOPICS/);
  const json = JSON.parse(f.downloads.find((d) => d.name.endsWith('.json'))!.text);
  assert.equal(json.run.runId, 'r1');
  assert.equal(json.previews.length, 3);
  assert.equal(json.previews[1].settlement, 'settled_known');
  // A cell that starts like a formula is neutralised, and commas / quotes are escaped.
  const evil = runToCsv(detailOf('r9', [row({ ordinal: 1, input: '=HYPERLINK("http://x")', note: '+1,"q"' })]));
  assert.match(evil, /"'=HYPERLINK\(""http:\/\/x""\)"/);
  assert.match(evil, /"'\+1,""q"""/);
  assert.equal(JSON.parse(runToJson(detailOf('r9', []))).previews.length, 0);
});

// Named exceptions (Part 24b-6c): there is ONE box (one line = one preview, several = one run) and ONE send button. The paid-call
// confirmation is the button's own second click (the separate checkbox is gone); everything it sends is unchanged, requestId included.
test('submitting: the first click only asks, the second sends; a run carries label, time and relationship, and a retry reuses its requestId', async (t) => {
  const f = setup(t, {
    sets: [{ id: 'e1', name: '16 例', version: 2, items: [{ text: 'a', note: null }], updatedBy: 'm', updatedAt: 1 }],
  });
  await f.bench.open('jojo');
  await flush();
  const box = label(f.root, '预演输入');
  const zone = text(f.root.querySelector('.pw-zone') as FakeElement);
  assert.match(zone, /北京时间/);
  assert.match(zone, /Asia\/Singapore/);
  assert.equal(sendButton(f.root).disabled, true);
  assert.equal(reasonOf(f.root), '没有输入');
  box.type_('第一条\n\n第二条 \n');
  assert.equal(text(sendButton(f.root)), '运行 2 条 · 4 次付费调用');
  label(f.root, '运行备注').type_('改前');
  label(f.root, '预演关系').value = 'friend';
  label(f.root, '模拟时间').value = 'set';
  label(f.root, '模拟时间').dispatch('change');
  (f.root.querySelector('[aria-label="模拟的当地时间"]') as FakeElement).value = '05:50';
  (f.root.querySelector('[aria-label="模拟的当地时间"]') as FakeElement).dispatch('input');
  (f.api as unknown as { failNext: boolean }).failNext = true;
  sendButton(f.root).click();
  await flush();
  assert.equal(f.calls.filter((c) => c === 'startRun').length, 0, 'a first click alone never calls the API');
  assert.equal(text(sendButton(f.root)), '确认付费 · 4 次');
  assert.equal(sendButton(f.root).getAttribute('data-state'), 'confirm');
  sendButton(f.root).click();
  await flush();
  const first = (f.api as unknown as { lastRun: Record<string, unknown> }).lastRun;
  assert.deepEqual(
    { ...first, requestId: undefined },
    {
      requestId: undefined,
      draftRevision: 3,
      profileHash: 'a'.repeat(64),
      relationship: 'friend',
      // Named exception (Part 24b-2): the 关系与故事 switch is always sent; its default chip is 不用.
      castSource: 'none',
      label: '改前',
      simulatedTime: '05:50',
      inputs: [
        { text: '第一条', note: null },
        { text: '第二条', note: null },
      ],
    },
  );
  assert.ok(f.calls.includes('error:network'));
  assert.equal(box.value, '第一条\n\n第二条 \n', 'a failed submission keeps the box');
  assert.equal(
    f.root.querySelectorAll('.pw-batch').length,
    1,
    'the lines shown for the failed submission are gone again',
  );
  // Same content again: the SAME requestId, so a lost reply can never queue a second run.
  confirmSend(f.root);
  await flush();
  assert.equal(
    (f.api as unknown as { lastRun: { requestId: string } }).lastRun.requestId,
    (first as { requestId: string }).requestId,
  );
  assert.equal(f.calls.filter((c) => c === 'startRun').length, 2);
  // Success clears the box: the next paid call needs its own two clicks.
  assert.equal(box.value, '');
  assert.equal(sendButton(f.root).disabled, true);
  // With the box empty a chosen eval set runs, and sends only its id.
  label(f.root, '评测集').value = 'e1';
  label(f.root, '评测集').dispatch('change');
  assert.equal(text(sendButton(f.root)), '运行评测集「16 例」v2 · 2 次付费调用');
  confirmSend(f.root);
  await flush();
  const set = (f.api as unknown as { lastRun: Record<string, unknown> }).lastRun;
  assert.equal(set.evalSetId, 'e1');
  assert.equal('inputs' in set, false);
});

test('the confirmation lapses: 取消, a changed box and Escape all go back to the first click without sending', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const box = label(f.root, '预演输入');
  box.type_('你好');
  assert.equal(text(sendButton(f.root)), '预演 1 条 · 2 次付费调用');
  sendButton(f.root).click();
  (f.root.querySelector('[data-pw-cancel="preview"]') as FakeElement).click();
  assert.equal(sendButton(f.root).getAttribute('data-state'), 'idle');
  sendButton(f.root).click();
  box.type_('你好\n再见');
  assert.equal(sendButton(f.root).getAttribute('data-state'), 'idle', 'what would be sent changed');
  assert.equal(text(sendButton(f.root)), '运行 2 条 · 4 次付费调用');
  assert.equal(f.calls.filter((c) => c === 'startSingle' || c === 'startRun').length, 0);
});

test('a single preview shows its row at once as 排队中, sends the simulated time too, and is announced when it is done', async (t) => {
  const f = setup(t, { singles: [row({ ordinal: 0, input: '老的单条', runId: null, previewId: 'solo1' } as never)] });
  await f.bench.open('jojo');
  await flush();
  assert.match(text(f.root.querySelector('.pw-feed') as FakeElement), /老的单条/);
  let release: () => void = () => {};
  f.held.startSingle = new Promise<void>((resolve) => {
    release = resolve;
  });
  label(f.root, '预演输入').type_('你好');
  confirmSend(f.root);
  await flush();
  // The server has not answered yet, and the row is already there with its state.
  const pendingRow = f.root.querySelectorAll('.pw-line').find((l) => /你好/.test(text(l))) as FakeElement;
  assert.ok(pendingRow, 'the submitted line is on screen before the answer');
  assert.equal(text(pendingRow.querySelector('.pw-state') as FakeElement), '排队中');
  release();
  await flush();
  assert.equal((f.api as unknown as { lastSingle: { message: string } }).lastSingle.message, '你好');
  assert.equal(
    'simulatedTime' in (f.api as unknown as { lastSingle: object }).lastSingle,
    false,
    'real clock when no time is set',
  );
  // Newest first: the new line is above the old one.
  const keys = Array.from(f.root.querySelector('.pw-feed')!.children).map((c) =>
    (c as FakeElement).getAttribute('data-key'),
  );
  assert.ok(keys.indexOf('px0') >= 0 && keys.indexOf('px0') < keys.indexOf('solo1'), keys.join());
});

test('a run shows its lines at once, then a toast with 查看 when it is done', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  label(f.root, '预演输入').type_('甲\n乙\n丙');
  confirmSend(f.root);
  await flush();
  // The stub answers with the finished run r1 (1 passed, 2 failed): the toast names the character and the counts.
  assert.equal(f.toasts.at(-1), 'JOJO 预演完成 · 3 条，2 条失败');
  assert.equal(f.toastActions.at(-1)?.label, '查看');
  f.toastActions.at(-1)!.run();
});

test('every reason a send is impossible is said next to the button, never a silent grey one', async (t) => {
  const reason = async (options: Parameters<typeof setup>[1], type?: string) => {
    const f = setup(t, options);
    await f.bench.open('jojo');
    await flush();
    if (type !== undefined) label(f.root, '预演输入').type_(type);
    return { f, button: sendButton(f.root), why: reasonOf(f.root) };
  };
  const none = await reason({ draft: false }, '你好');
  assert.equal(none.button.disabled, true);
  assert.equal(none.why, '没有草稿');
  const unsaved = await reason({ unsaved: true }, '你好');
  assert.equal(unsaved.button.disabled, true);
  assert.match(unsaved.why, /草稿未保存/);
  byText(unsaved.f.root, 'button', '保存草稿').click();
  assert.equal(unsaved.f.saves.length, 1, 'the 保存草稿 link saves the draft');
  const readOnly = await reason({ member: READER }, '你好');
  assert.equal(readOnly.button.disabled, true);
  assert.equal(readOnly.why, '你没有预演权限');
  const off = await reason({ previewAvailable: false }, '你好');
  assert.equal(off.button.disabled, true);
  assert.equal(off.why, '预演暂不可用');
  const many = await reason({}, Array.from({ length: 51 }, (_, i) => `第${i}条`).join('\n'));
  assert.equal(many.button.disabled, true);
  assert.equal(many.why, '超过 50 条');
  const long = await reason({}, `短\n${'长'.repeat(4001)}`);
  assert.equal(long.button.disabled, true);
  assert.equal(long.why, '第 2 行过长');
  const empty = await reason({});
  assert.equal(empty.why, '没有输入');
  // Nothing wrong: no reason at all.
  const fine = await reason({}, '你好');
  assert.equal(fine.button.disabled, false);
  assert.equal(fine.why, '');
});

test('the poller: ONE batched call per tick, 2 s growing to 10 s, reset on change, stops when idle, pauses while hidden', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  assert.equal(f.timers.length, 0, 'idle page: no timer at all');
  // A submission starts polling; the first wait is 2 s.
  f.setStatus(
    [
      {
        previewId: 'pr12',
        status: 'generating',
        errorCode: null,
        runId: 'r1',
        ordinal: 2,
        finishedAt: null,
        settlement: null,
      },
    ],
    1,
  );
  f.bench.poller.kick();
  assert.deepEqual(
    f.timers.map((x) => x.ms),
    [POLL_FIRST_MS],
  );
  const seen: number[] = [];
  for (let i = 0; i < 7; i++) {
    f.timers.at(-1)!.fn();
    await flush();
    seen.push(f.timers.at(-1)!.ms);
  }
  // The first tick learns a new status (a change, so 2 s again); every quiet tick after it waits longer, up to 10 s.
  assert.equal(seen[0], POLL_FIRST_MS);
  assert.ok(
    seen.every((ms, i) => i === 0 || ms >= seen[i - 1]!),
    `non-decreasing: ${seen}`,
  );
  assert.equal(Math.max(...seen), POLL_MAX_MS);
  assert.ok(seen[1]! > POLL_FIRST_MS, 'backs off after a quiet tick');
  // Only the batched call is used, once per tick; never one call per preview and never review-status.
  const statusCalls = f.calls.filter((c) => c.startsWith('status:'));
  assert.equal(statusCalls.length, 7);
  assert.ok(statusCalls.every((c) => c === 'status:null'));
  assert.ok(!f.calls.some((c) => /previewStatus|review-status/.test(c)));
  // Something finished: the interval resets to 2 s and the heavy run is refetched once.
  f.setStatus(
    [
      {
        previewId: 'pr12',
        status: 'succeeded',
        errorCode: null,
        runId: 'r1',
        ordinal: 2,
        finishedAt: 5,
        settlement: 'settled_known',
      },
    ],
    1,
  );
  const before = f.calls.filter((c) => c === 'run:r1').length;
  f.timers.at(-1)!.fn();
  await flush();
  assert.equal(f.timers.at(-1)!.ms, POLL_FIRST_MS);
  assert.equal(f.calls.filter((c) => c === 'run:r1').length, before + 1);
  // Nothing queued or generating any more: it stops by itself.
  f.setStatus(
    [
      {
        previewId: 'pr12',
        status: 'succeeded',
        errorCode: null,
        runId: 'r1',
        ordinal: 2,
        finishedAt: 5,
        settlement: 'settled_known',
      },
    ],
    0,
  );
  const n = f.timers.length;
  f.timers.at(-1)!.fn();
  await flush();
  assert.equal(f.timers.length, n, 'no further timer');
});

test('the poller sleeps while the tab is hidden and resumes with an immediate call when it is shown', async () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let hidden = true,
    ticks = 0,
    show: () => void = () => {};
  const poller = previewPoller({
    tick: async () => {
      ticks++;
      return { active: 1, changed: false };
    },
    hidden: () => hidden,
    setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimer: () => {},
    onVisible: (fn) => {
      show = fn;
      return () => {};
    },
  });
  poller.kick();
  assert.equal(timers.length, 0, 'hidden: nothing scheduled');
  hidden = false;
  show();
  await flush();
  assert.equal(ticks, 1, 'shown: an immediate call');
  assert.equal(timers.length, 1);
  hidden = true;
  timers[0]!.fn();
  await flush();
  assert.equal(ticks, 1, 'a timer that fires while hidden makes no call');
  poller.dispose();
});

test('the poller gives up after repeated failures instead of hammering the server, and doubles its wait meanwhile', async () => {
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let gave = 0;
  const poller = previewPoller({
    tick: async () => {
      throw new Error('429');
    },
    hidden: () => false,
    setTimer: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearTimer: () => {},
    maxFailures: 3,
    onGiveUp: () => gave++,
  });
  poller.kick();
  for (let i = 0; i < 5 && timers.at(-1); i++) {
    const last = timers.length;
    timers.at(-1)!.fn();
    await flush();
    if (timers.length === last) break;
  }
  assert.equal(gave, 1);
  assert.deepEqual(
    timers.map((x) => x.ms),
    [2000, 4000, 8000],
  );
});

test('production wiring: the page mounts this workbench when it has the client, and the batched status call exists on the API client', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const client = new PreviewAdminClient(
    async (path, body) => {
      calls.push([path, body]);
      return path.endsWith('previews-status') ? { previews: [], active: 0 } : { runId: 'r', replayed: false };
    },
    async (path, body) => {
      calls.push(['eval:' + path, body]);
      return { sets: [] };
    },
  );
  assert.deepEqual(await client.status('jojo', 'run-1'), { previews: [], active: 0 });
  assert.deepEqual(await client.status('jojo', null), { previews: [], active: 0 });
  await client.evalSets();
  assert.deepEqual(calls, [
    ['jojo/previews-status', { runId: 'run-1' }],
    ['jojo/previews-status', { runId: null }],
    ['eval:list', {}],
  ]);
  await assert.rejects(() => client.status('../x', null), /PROTOCOL_INVALID/);
  const { readFileSync } = await import('node:fs');
  const page = readFileSync(new URL('../../src/features/admin/account-admin-page.ts', import.meta.url), 'utf8');
  assert.match(page, /port\.previews\s*\?\s*previewWorkbench\(/);
  const workbench = readFileSync(
    new URL('../../src/features/admin/preview/preview-workbench.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(workbench, /previewStatus|review-status/, 'the new page never polls per preview');
});

test('zone label: UTC+8 zones read as 北京时间, other zones by name and offset', () => {
  assert.equal(zoneLabel('Asia/Singapore'), '北京时间');
  assert.equal(zoneLabel('Asia/Shanghai'), '北京时间');
  assert.match(zoneLabel('Europe/London', Date.UTC(2026, 0, 1)), /Europe\/London GMT/);
});

test('eval-set lines: tab or " || " separate an optional note, limits are explained, and the text round-trips', () => {
  assert.deepEqual(parseEvalLines('你好\t期望打招呼\n再见 || 别太冷\n\n  第三条  '), [
    { text: '你好', note: '期望打招呼' },
    { text: '再见', note: '别太冷' },
    { text: '第三条', note: null },
  ]);
  assert.equal(formatEvalLines(parseEvalLines('a || b\nc')), 'a || b\nc');
  assert.match(evalLineProblem([]), /至少/);
  assert.match(evalLineProblem(Array.from({ length: 51 }, () => ({ text: 'x', note: null }))), /最多 50 行/);
  assert.match(evalLineProblem([{ text: 'x', note: 'n'.repeat(301) }]), /第 1 行的备注超过 300/);
  assert.equal(evalLineProblem([{ text: 'x', note: null }]), '');
});

test('eval-set editor: saves a new version with the expected version, respects write permission, and confirms in place before deleting', async (t) => {
  installFakeDom(t);
  const parent = document.createElement('div') as unknown as HTMLElement;
  const saved: unknown[] = [];
  let sets: EvalSet[] = [
    { id: 'e1', name: '16 例', version: 2, items: [{ text: '你好', note: '招呼' }], updatedBy: 'm', updatedAt: 1 },
  ];
  const deleted: unknown[] = [];
  let write = true;
  const toasts: string[] = [];
  const editor = evalSetEditor(parent, {
    api: {
      evalSets: async () => sets,
      saveEvalSet: async (input) => {
        saved.push(input);
        sets = [{ ...sets[0]!, version: sets[0]!.version + 1, name: input.name, items: input.items }];
        return sets[0]!;
      },
      deleteEvalSet: async (id: string, version: number) => {
        deleted.push([id, version]);
        sets = [];
      },
    },
    canWrite: () => write,
    run: async (work) => {
      await work();
    },
    toast: (m) => toasts.push(m),
    changed: () => {},
  });
  editor.open(sets);
  const root = el(parent);
  (root.querySelector('[data-eval-set="e1"]') as FakeElement).click();
  const lines = root.querySelector('textarea') as FakeElement;
  assert.equal(lines.value, '你好 || 招呼');
  lines.type_('你好 || 招呼\n再见');
  assert.match(text(root.querySelector('.admin-hint') as FakeElement), /2 行 · 当前版本 v2/);
  byText(root, 'button', '保存（生成新版本）').click();
  await flush();
  assert.deepEqual(saved, [
    {
      id: 'e1',
      expectedVersion: 2,
      name: '16 例',
      items: [
        { text: '你好', note: '招呼' },
        { text: '再见', note: null },
      ],
    },
  ]);
  assert.match(toasts.at(-1)!, /已保存：16 例 v3/);
  // Named exception (Part 24b-6c): the editor opens inline (no drawer) and deleting asks IN PLACE (no dialog), like 版本历史.
  // Delete asks first; 取消 does nothing, 删除 sends the version it read.
  byText(root, 'button', '删除').click();
  await flush();
  assert.deepEqual(deleted, []);
  assert.equal(root.querySelectorAll('.admin-dialog').length, 0);
  assert.equal(root.querySelectorAll('.admin-drawer').length, 0);
  byText(root.querySelector('.ic') as FakeElement, 'button', '取消').click();
  await flush();
  assert.deepEqual(deleted, []);
  byText(root, 'button', '删除').click();
  await flush();
  // (the bar of the cancelled question is still fading out: the answer is on the newest one)
  byText(root.querySelectorAll('.ic').at(-1) as FakeElement, 'button', '删除').click();
  await flush();
  assert.deepEqual(deleted, [['e1', 3]]);
  // Too many lines disable saving; without write permission nothing can be saved or deleted.
  (root.querySelector('input') as FakeElement).type_('新的');
  lines.type_(Array.from({ length: 51 }, (_, i) => `第${i}条`).join('\n'));
  assert.equal(byText(root, 'button', '保存（生成新版本）').disabled, true);
  lines.type_('只一条');
  write = false;
  lines.dispatch('input');
  assert.equal(byText(root, 'button', '保存（生成新版本）').disabled, true);
});

test('预演 reads the cast named by the 关系与故事 switch: 不用 / 已发布 / 草稿 reach the run and the single request', async (t) => {
  const f = setup(t);
  await f.bench.open('jojo');
  await flush();
  const switchLabels = f.root.querySelectorAll('[data-seg]').map((b) => [b.getAttribute('data-seg'), b.textContent]);
  assert.deepEqual(switchLabels, [
    ['none', '不用'],
    ['published', '已发布'],
    ['draft', '草稿'],
  ]);
  for (const source of ['none', 'published', 'draft'] as const) {
    (f.root.querySelector(`[data-seg="${source}"]`) as FakeElement).click();
    assert.equal((f.root.querySelector(`[data-seg="${source}"]`) as FakeElement).getAttribute('aria-pressed'), 'true');
    // Named exception (Part 24b-6c): several lines in the one box are a run, one line is a single preview.
    label(f.root, '预演输入').type_(`来自${source}\n再来一条`);
    confirmSend(f.root);
    await flush();
    assert.equal((f.api as unknown as { lastRun: { castSource: string } }).lastRun.castSource, source);
    label(f.root, '预演输入').type_('你好');
    confirmSend(f.root);
    await flush();
    assert.equal((f.api as unknown as { lastSingle: { castSource: string } }).lastSingle.castSource, source);
  }
});
