import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewView } from '../../src/features/admin/overview-view.ts';
import type { ChartMetric, ChartRange, ChartView, PlayerStatsView, StatsCounts, StatsRange } from '../../../../packages/contracts/web-stats.ts';
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
              return o.empty ? { ...players(range), since: null, days: [], byCharacter: [], byModel: [] } : players(range);
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
  assert.ok(f.charts.some(([metric, range]) => metric === 'replies' && range === '24h'), 'the hourly chart is asked for');
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
    rows.map((r) => r[0]),
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
