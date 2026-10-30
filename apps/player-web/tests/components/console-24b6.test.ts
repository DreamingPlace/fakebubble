import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewView } from '../../src/features/admin/overview-view.ts';
import type {
  ChartMetric,
  ChartRange,
  ChartView,
  PlayerStatsView,
  StatsCounts,
  StatsRange,
} from '../../../../packages/contracts/web-stats.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

// Part 24b-6: the V3 behaviours that replaced older, layout-pinned tests (each of those names its successor here).

const text = (el: unknown) => (el as FakeElement).textContent;
const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);
const one = (root: unknown, selector: string) => (root as FakeElement).querySelector(selector) as FakeElement;
const press = (root: unknown, group: string, label: string) =>
  all(root, `[aria-label="${group}"] button`)
    .find((b) => b.textContent === label)!
    .click();

// ---- 总览 (Overview3), with 玩家统计 merged in -------------------------------------------------------------------------------

const counts = (over: Partial<StatsCounts> = {}): StatsCounts => ({
  signups: 4,
  newGuests: 12,
  activeRegistered: 20,
  activeGuests: 30,
  chatRegistered: 10,
  chatGuests: 8,
  repliesPublished: 100,
  repliesFailed: 3,
  repliesUnknown: 1,
  voiceReplies: 90,
  deletedAccounts: 1,
  inactivePurged: 2,
  expiredPurged: 5,
  ...over,
});
const players = (range: StatsRange = 7): PlayerStatsView => ({
  since: '2026-11-03',
  range,
  days: [
    { day: '2026-11-20', ...counts(), d1: null, d7: null },
    { day: '2026-11-19', ...counts({ signups: 3 }), d1: { cohort: 4, retained: 2 }, d7: { cohort: 0, retained: 0 } },
    { day: '2026-11-18', ...counts({ signups: 1 }), d1: null, d7: null },
  ],
  totals: { ...counts({ signups: 8 }), d1: { cohort: 4, retained: 2 }, d7: null },
  byCharacter: [{ name: '瓜瓜', published: 7, failed: 1, unknown: 0, voice: 6 }],
  byModel: [
    { model: 'xai', published: 5, failed: 0, unknown: 0, voice: 4 },
    { model: '', published: 2, failed: 1, unknown: 0, voice: 2 },
  ],
});
const hourly = (metric: ChartMetric, range: ChartRange): ChartView => ({
  metric,
  range,
  bucket: range === '24h' ? 'hour' : 'day',
  since: '2026-11-03',
  buckets: Array.from({ length: 24 }, (_, i) => `2026-11-20T${String(i).padStart(2, '0')}`),
  total: Array.from({ length: 24 }, (_, i) => i),
  characters: [{ name: '瓜瓜', values: Array.from({ length: 24 }, (_, i) => i) }],
});

function mount(t: test.TestContext, o: { stats?: boolean; chart?: boolean; empty?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const loads: StatsRange[] = [];
  const charts: [ChartMetric, ChartRange][] = [];
  const exports: StatsRange[] = [];
  const saved: [string, string][] = [];
  const api = overviewView(root, {
    load: async () => ({
      day: '2026-11-20',
      today: { replies: 12, voiceReplies: 9, failedReplies: 1, spendMicros: 2_500_000 },
      warnings: { priceExpiring: 0, retentionFailing: 0, unknownNew: 0 },
      stats: {
        yesterday: { day: '2026-11-19', signups: 3, active: 50 },
        monthListCostRmbFen: 1340,
      } as never,
    }),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
    ...(o.stats === false
      ? {}
      : {
          stats: {
            load: async (range: StatsRange) => {
              loads.push(range);
              return o.empty
                ? { ...players(range), since: null, days: [], byCharacter: [], byModel: [] }
                : players(range);
            },
            exportCsv: async (range: StatsRange) => {
              exports.push(range);
              return { csv: '﻿a,b\r\n', rows: 2 };
            },
            download: (name: string, body: string) => void saved.push([name, body]),
          },
        }),
    ...(o.chart === false
      ? {}
      : {
          chart: {
            load: async (metric: ChartMetric, range: ChartRange) => {
              charts.push([metric, range]);
              return hourly(metric, range);
            },
          },
        }),
  });
  return { root, api, loads, charts, exports, saved };
}

// Supersedes console-24b-1 "总览: one chart card; metric, range and view switch" (14天 range and 表格 view are gone).
test('24b-6 总览: one range in the title row drives the page; the metric and the view only repaint', async (t) => {
  const f = mount(t);
  await f.api.load();
  assert.deepEqual(
    all(f.root, '[aria-label="时间范围"] button').map((b) => b.textContent),
    ['24H', '7天', '30天', '90天'],
  );
  assert.deepEqual(
    all(f.root, '[aria-label="指标"] button').map((b) => b.textContent),
    ['回复', '聊天人数', '活跃'],
  );
  assert.deepEqual(
    all(f.root, '[aria-label="图表类型"] button').map((b) => b.textContent),
    ['折线', '柱状', '饼图'],
  );
  assert.deepEqual(f.loads, [7]);
  press(f.root, '时间范围', '30天');
  await flush();
  assert.deepEqual(f.loads, [7, 30]);
  press(f.root, '时间范围', '24H');
  await flush();
  assert.ok(
    f.charts.some(([metric, range]) => metric === 'replies' && range === '24h'),
    'the hourly chart is asked for',
  );
  assert.equal(all(f.root, '.ovx-line .xy-hit').length, 24, 'one hover target per hour');
  const before = f.loads.length + f.charts.length;
  press(f.root, '图表类型', '柱状');
  press(f.root, '图表类型', '饼图');
  press(f.root, '指标', '聊天人数');
  assert.equal(f.loads.length + f.charts.length, before, 'a metric or view change asks for nothing');
});

// Supersedes console-24b-1 "总览: the pie shows shares ..." and stats-views-22c "玩家统计: since line, newest first, a totals row ...".
test('24b-6 总览: the 按天 table is newest first with a 合计 row, retention as a percentage with the cohort on hover; 按角色 / 按模型 beside it', async (t) => {
  const f = mount(t);
  await f.api.load();
  const rows = all(f.root, '.ov-days .ot-row').map((r) => r.querySelectorAll('.ot-cell').map((c) => c.textContent));
  assert.deepEqual(
    rows.map((r) => (r[0] === '合计' ? r[0] : r[0]!.slice(0, 10))), // a day also carries its UTC date as the hover value
    ['2026-11-20', '2026-11-19', '2026-11-18', '合计'],
  );
  assert.equal(rows[0]![9]!.startsWith('—'), true, 'retention is — while the cohort is open');
  assert.equal(rows[1]![9]!.startsWith('50%'), true);
  assert.match(rows[1]![9]!, /2 \/ 4/, 'the cohort is the hover value');
  assert.match(rows[0]![3]!, /^50/, 'active = 20 + 30');
  assert.match(rows[0]![3]!, /注册 20/);
  assert.match(text(one(f.root, '[aria-label="按角色"]')), /瓜瓜/);
  assert.match(text(one(f.root, '[aria-label="按模型"]')), /xai/);
  assert.match(text(one(f.root, '[aria-label="按模型"]')), /未选择模型/);
  assert.match(text(one(f.root, '.head-status')), /UTC 2026-11-20/);
});

test('24b-6 总览: 导出表格 saves the CSV of the range that is showing; eight tiles', async (t) => {
  const f = mount(t);
  await f.api.load();
  assert.equal(all(f.root, '.ov-tile').length, 8);
  press(f.root, '时间范围', '90天');
  await flush();
  all(f.root, 'button')
    .find((b) => b.textContent === '导出表格')!
    .click();
  await flush();
  assert.deepEqual(f.exports, [90]);
  assert.deepEqual(f.saved, [['玩家统计-最近90天.csv', '﻿a,b\r\n']]);
});

test('24b-6 总览: no stats and no chart card without the clients or stats.read; the two numbers of today stay', async (t) => {
  const f = mount(t, { stats: false, chart: false });
  await f.api.load();
  assert.equal(one(f.root, '.ovx-trend').hidden, true);
  assert.equal(all(f.root, '.ov-tile').length >= 2, true);
  assert.deepEqual(f.loads, []);
  assert.deepEqual(f.charts, []);
});

test('24b-6 总览: an empty window says so instead of an empty table of zeros', async (t) => {
  const f = mount(t, { empty: true });
  await f.api.load();
  assert.equal(all(f.root, '.ov-days .ot-row').length, 0);
  assert.match(text(one(f.root, '.ov-days .ot-empty')), /还没有统计数据/);
});

// ---- shared pieces -----------------------------------------------------------------------------------------------------------
import { canonEditors, CanonError } from '../../src/features/admin/character-canon.ts';
import { dangerZone, HOLD_MS } from '../../src/features/admin/ui/danger-zone.ts';
import { openTable } from '../../src/features/admin/ui/open-table.ts';
import { exactMoney, hoverValue, partsText } from '../../src/features/admin/ui/hover-value.ts';
import { rolePicker } from '../../src/features/admin/shell/role-picker.ts';

test("24b-6 hover values: full precision money, parts, and the bubble is the anchor's last child with a description", (t) => {
  const doc = installFakeDom(t);
  assert.equal(exactMoney(71_204), '$0.071 204');
  assert.equal(exactMoney(1_234_567_890), '$1,234.567 890');
  assert.equal(
    partsText([
      ['注册', 31],
      ['访客', 27],
    ]),
    '注册 31 / 访客 27',
  );
  const cell = doc.createElement('span') as unknown as HTMLElement;
  hoverValue(cell, '注册 31 / 访客 27');
  const tip = (cell as unknown as FakeElement).children.at(-1)! as FakeElement;
  assert.equal(tip.textContent, '注册 31 / 访客 27');
  assert.equal(cell.getAttribute('aria-describedby'), tip.getAttribute('id'));
  assert.equal(cell.getAttribute('tabindex'), '0', 'keyboard focus shows the same bubble');
  hoverValue(cell, '新的');
  assert.equal((cell as unknown as FakeElement).children.length, 1, 'a second call updates the one bubble');
  assert.equal(tip.textContent, '新的');
});

test('24b-6 open-below table: a row opens its detail under itself, one at a time, a second click closes it, ticks stop at the max', async (t) => {
  installFakeDom(t);
  const ticks: string[][] = [];
  const table = openTable<{ id: string }>({
    label: '示例',
    columns: [{ key: 'id', label: '编号', cell: (r) => r.id }],
    rowKey: (r) => r.id,
    detail: (r) => {
      const node = document.createElement('div');
      node.textContent = `详情 ${r.id}`;
      return node;
    },
    tick: { label: '选', max: 2, onChange: (keys) => ticks.push(keys) },
    emptyText: '空',
  });
  table.setRows([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
  const rowOf = (key: string) => one(table.root, `[data-key="${key}"] .ot-row`);
  rowOf('a').click();
  await flush();
  assert.equal(table.openKey, 'a');
  assert.match(text(one(table.root, '[data-key="a"] .ot-panel')), /详情 a/);
  assert.equal(one(table.root, '[data-key="a"]').getAttribute('data-open'), 'true');
  rowOf('b').click();
  await flush();
  assert.equal(table.openKey, 'b');
  assert.equal(one(table.root, '[data-key="a"]').getAttribute('data-open'), 'false', 'only one open');
  rowOf('b').click();
  assert.equal(table.openKey, null);
  const boxes = all(table.root, '.ot-tick input');
  for (const box of boxes) {
    box.checked = true;
    box.dispatch('change');
  }
  assert.deepEqual(table.ticked(), ['a', 'b'], 'the third tick is refused');
  assert.equal(boxes[2]!.checked, false);
  assert.deepEqual(ticks.at(-1), ['a', 'b']);
});

test('24b-6 danger zone: opens in place with the impact; the big ones need the typed name and a full hold, letting go starts over', async (t) => {
  installFakeDom(t);
  let ran = 0;
  const zone = dangerZone({
    open: '删除角色',
    openerId: 'dz-test',
    typeName: 'JOJO',
    impact: () => [{ n: '12', label: '个私人会话' }],
    confirm: '永久删除',
    holdMs: 30,
    run: async () => {
      ran++;
    },
  });
  assert.equal(HOLD_MS, 1500, 'the real hold is 1.5 s');
  const root = zone.root as unknown as FakeElement;
  assert.equal(root.getAttribute('data-open'), 'false');
  one(root, '#dz-test').click();
  await flush();
  assert.equal(root.getAttribute('data-open'), 'true');
  assert.match(text(one(root, '.dz-impact')), /12个私人会话/);
  const go = one(root, '.dz-go');
  assert.equal(go.disabled, true, 'the name is not typed');
  one(root, '.dz-type').type_('jojo');
  assert.equal(go.disabled, true, 'the name must match exactly');
  one(root, '.dz-type').type_('JOJO');
  assert.equal(go.disabled, false);
  go.dispatch('pointerdown');
  assert.equal(go.getAttribute('data-hold'), 'on');
  go.dispatch('pointerup');
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(ran, 0, 'released early: nothing ran');
  go.dispatch('pointerdown');
  await new Promise((r) => setTimeout(r, 60));
  await flush();
  assert.equal(ran, 1, 'held for the whole time: it ran once');
});

test('24b-6 danger zone: a small one has one confirm button and no typing', async (t) => {
  installFakeDom(t);
  let ran = 0;
  const zone = dangerZone({ open: '放弃服务器草稿', confirm: '确认放弃', run: async () => void ran++ });
  const root = zone.root as unknown as FakeElement;
  one(root, '.dz-open').click();
  await flush();
  assert.equal(all(root, '.dz-type').length, 0);
  one(root, '.dz-go').click();
  await flush();
  assert.equal(ran, 1);
});

test('24b-6 the rail shows names only: no version or draft inside a name; the state is its own small line', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as HTMLElement;
  const picker = rolePicker(host, {
    emptyText: '无',
    onPick: () => {},
    compact: { colour: () => '#E8561E' },
  });
  picker.show([{ characterId: 'jojo', displayName: 'JOJO', publishedVersion: 2, draftRevision: 3 }]);
  picker.setSeed('jojo', true);
  const pick = one(host, '.admin-pick');
  assert.equal(one(pick, '.admin-pick-text strong').textContent, 'JOJO');
  assert.equal(pick.getAttribute('data-seed'), 'true', 'the dashed ring marks a growing character');
  assert.equal(all(pick, '.admin-pick-st').length, 1, 'one small status dot');
});

// ---- structured editors over authorCanon.settings --------------------------------------------------------------------------

const canon = () => ({
  selfIdentity: { names: ['测试人物', '保留别名'], truthScope: 'fictional_world', representsRealPerson: false },
  speechStyle: ['温柔', '爱用“嗯”'],
  basicInfo: { birthDate: '2000-01-01' },
  dialogueStyle: '短句，不爱解释',
  background: [{ title: '小时候', text: '住在海边' }, '后来搬了家'],
  dialogueExamples: [
    { situation: '日常聊天', player: '你好', reply: ['嗯？', '你好呀'] },
    { player: '吃了吗', reply: [] },
  ],
  hobbies: ['画画'],
});
const keys = (value: object) => Object.keys(value);

test('24b-6 canon editors: open → save with no edits is deep-equal to the input (same key order, nothing dropped, no type change)', (t) => {
  installFakeDom(t);
  const input = canon();
  const editors = canonEditors(structuredClone(input) as never, () => {});
  const out = editors.assemble(editors.rest);
  assert.deepEqual(out, input);
  assert.deepEqual(keys(out), keys(input), "the key order is the input's");
  assert.equal(typeof out.dialogueStyle, 'string', 'a text stays a text');
  assert.ok(Array.isArray(out.speechStyle), 'a list stays a list');
  assert.equal(JSON.stringify(out), JSON.stringify(input));
});

test('24b-6 canon editors: a shape that is not recognised falls back to the JSON editor and still round-trips', (t) => {
  installFakeDom(t);
  const input = {
    ...canon(),
    speechStyle: { 口头禅: ['嗯'] },
    background: [1, 2],
    dialogueExamples: [{ player: 'x', extra: true }],
  } as never;
  const editors = canonEditors(structuredClone(input), () => {});
  const rest = JSON.parse(editors.rest) as Record<string, unknown>;
  for (const key of ['speechStyle', 'background', 'dialogueExamples'])
    assert.ok(key in rest, `${key} is in the JSON editor`);
  assert.deepEqual(editors.assemble(editors.rest), input);
});

test('24b-6 canon editors: editing one key rebuilds only that key; the others stay as they came in', (t) => {
  installFakeDom(t);
  const editors = canonEditors(canon() as never, () => {});
  const chips = all(editors.speech, '.cn-chip-input');
  chips[0]!.type_('很温柔');
  const out = editors.assemble(editors.rest);
  assert.deepEqual(out.speechStyle, ['很温柔', '爱用“嗯”']);
  assert.deepEqual({ ...out, speechStyle: null }, { ...canon(), speechStyle: null });
  assert.deepEqual(keys(out), keys(canon()));
  // 经历: a card's text, and a card added
  const cards = all(editors.past, '.cn-card textarea');
  cards[1]!.type_('后来搬去了山里');
  const added = all(editors.past, 'button.cn-add')[0]!;
  added.click();
  const next = editors.assemble(editors.rest);
  assert.equal((next.background as unknown[])[1], '后来搬去了山里', 'a plain text stays plain');
  assert.equal((next.background as unknown[]).length, 3);
  // 对话样例: the reply lines
  const reply = all(editors.speech, '.cn-reply')[0]!;
  reply.type_('嗯？\n你好呀\n再见');
  const examples = editors.assemble(editors.rest).dialogueExamples as { reply: string[] }[];
  assert.deepEqual(examples[0]!.reply, ['嗯？', '你好呀', '再见']);
});

test('24b-6 canon editors: the JSON editor is for the other keys only; a key an editor owns is refused there', (t) => {
  installFakeDom(t);
  const editors = canonEditors(canon() as never, () => {});
  assert.deepEqual(Object.keys(JSON.parse(editors.rest)), ['selfIdentity', 'basicInfo', 'hobbies']);
  const bad = JSON.stringify({ ...JSON.parse(editors.rest), speechStyle: ['x'] });
  assert.throws(() => editors.assemble(bad), CanonError);
  assert.throws(() => editors.assemble('[1]'), CanonError);
  const added = JSON.stringify({ ...JSON.parse(editors.rest), 外貌: '短发' });
  assert.equal(editors.assemble(added).外貌, '短发');
});

// ---- round 2 -----------------------------------------------------------------------------------------------------------------
import { diffSideBySide } from '../../src/features/admin/preview/diff.ts';
import { spendSeries } from '../../src/features/admin/costs-view.ts';

test('24b-6 rail: the circle has the first character; the row has the name and ONE mark, never a version or the word 草稿', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as HTMLElement;
  const picker = rolePicker(host, {
    emptyText: '无',
    onPick: () => {},
    badges: () => ({ a: 3 }),
    compact: { colour: () => '#2F7BEA' },
  });
  picker.show([
    { characterId: 'a', displayName: '甲', publishedVersion: 2, draftRevision: 1 },
    { characterId: 'b', displayName: '乙', publishedVersion: null, draftRevision: null },
    { characterId: 'c', displayName: '丙', publishedVersion: 1, draftRevision: 4 },
    { characterId: 'd', displayName: '丁', publishedVersion: 1, draftRevision: null },
  ]);
  picker.setSeed('d', true);
  const rows = all(host, '.admin-pick-row');
  assert.deepEqual(
    all(host, '.admin-pick-dot').map((n) => n.textContent),
    ['甲', '乙', '丙', '丁'],
  );
  for (const row of rows) assert.doesNotMatch(row.textContent, /v\d|草稿|条新共创|修订/);
  const marks = rows.map(
    (r) => r.querySelectorAll('.admin-pick-mark').length + r.querySelectorAll('.cocreation-badge').length,
  );
  assert.deepEqual(marks, [1, 1, 1, 1]);
  assert.equal(one(rows[0], '.cocreation-badge').textContent, '3', 'a 共创 count is a number badge');
  assert.equal(one(rows[1], '.admin-pick-mark').textContent, '未上线');
  assert.equal(all(rows[2], '.is-draft').length, 1, 'a draft is a dot');
  assert.equal(one(rows[3], '.admin-pick-mark').textContent, '成长中');
});

test('24b-6 资料改动: removed text only on the left, added text only on the right, equal text on both, far-away equal lines folded', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'old line', 'i'].join('\n');
  const after = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'new line', 'i'].join('\n');
  const rows = diffSideBySide(before, after);
  const changed = rows.filter((r) => r.changed);
  assert.equal(changed.length, 1);
  assert.ok(changed[0]!.left!.some((p) => p.kind === 'del'));
  assert.ok(changed[0]!.right!.some((p) => p.kind === 'add'));
  assert.ok(!changed[0]!.left!.some((p) => p.kind === 'add') && !changed[0]!.right!.some((p) => p.kind === 'del'));
  assert.ok(
    rows.some((r) => r.left?.[0]?.text === '…'),
    'the unchanged lines far from the change are folded',
  );
  assert.deepEqual(
    diffSideBySide('same', 'same').filter((r) => r.changed),
    [],
  );
  const added = diffSideBySide('x', 'x\ny');
  assert.equal(added.at(-1)!.left, null, 'a line that only the draft has leaves the left empty');
});

test('24b-6 消耗表: a chip of a group with no figure for any day of the range reads —, not $0.00', () => {
  const view = {
    since: null,
    range: 30,
    usdCny: 6.7,
    days: [{ day: '2026-11-20', types: null, unclassifiedMicros: null, totalMicros: null }],
    totals: null,
    alertMicros: null,
    priceChanges: [],
  } as never;
  const built = spendSeries(view, 'user');
  assert.ok(built.series.every((s) => s.sum === null));
  const known = spendSeries(
    {
      ...(view as object),
      days: [
        {
          day: '2026-11-20',
          types: [{ userType: 'guest', textMicros: 5_000_000, voiceMicros: 0 }],
          unclassifiedMicros: 0,
          totalMicros: 5_000_000,
        },
      ],
    } as never,
    'user',
  );
  assert.equal(known.series.find((s) => s.id === 'guest')!.sum, 5);
  assert.equal(known.series.find((s) => s.id === 'registered')!.sum, 0, 'a known day with nothing for a group is 0');
});
