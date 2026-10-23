import assert from 'node:assert/strict';
import test from 'node:test';
import { costsView } from '../../src/features/admin/costs-view.ts';
import { overviewView } from '../../src/features/admin/overview-view.ts';
import { statsView } from '../../src/features/admin/stats-view.ts';
import { canSeePage, visibleNav } from '../../src/features/admin/shell/admin-nav.ts';
import type { CostsView, PlayerStatsView, StatsCounts, StatsRange } from '../../../../packages/contracts/web-stats.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

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
    { day: '2026-11-18', ...counts(), d1: { cohort: 4, retained: 2 }, d7: { cohort: 0, retained: 0 } },
  ],
  totals: { ...counts({ signups: 8 }), d1: { cohort: 4, retained: 2 }, d7: null },
  byCharacter: [{ name: '瓜瓜', published: 7, failed: 1, unknown: 0, voice: 6 }],
  byModel: [
    { model: 'xai', published: 5, failed: 0, unknown: 0, voice: 4 },
    { model: '', published: 2, failed: 1, unknown: 0, voice: 2 },
  ],
});
const text = (el: unknown) => (el as FakeElement).textContent;
const rows = (root: unknown, caption: string) =>
  (root as FakeElement)
    .querySelectorAll('table')
    .find((table) => text(table.querySelector('caption')) === caption)!
    .querySelectorAll('tbody tr')
    .map((tr) => tr.querySelectorAll('td').map((td) => td.textContent));

function mountStats(t: test.TestContext, view = players()) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const loads: StatsRange[] = [],
    exports: StatsRange[] = [],
    saved: [string, string][] = [];
  const api = statsView(root, {
    load: async (range) => {
      loads.push(range);
      return { ...view, range };
    },
    exportCsv: async (range) => {
      exports.push(range);
      return { csv: '﻿a,b\r\n', rows: 2 };
    },
    download: (name, body) => void saved.push([name, body]),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
  });
  return { root, api, loads, exports, saved };
}

test('玩家统计: since line, newest first, a totals row, 次日留存 as "x / y (%)" and — while the cohort is open', async (t) => {
  const f = mountStats(t);
  await f.api.load();
  assert.match(text(f.root), /统计自 2026-11-03 起（UTC）/);
  const days = rows(f.root, '玩家统计（按天）');
  assert.deepEqual(
    days.map((r) => r[0]),
    ['2026-11-20', '2026-11-18', '合计'],
  );
  assert.deepEqual(days[0], [
    '2026-11-20',
    '4',
    '12',
    '20 / 30',
    '10 / 8',
    '100 / 3 / 1',
    '90',
    '1',
    '2',
    '5',
    '—',
    '—',
  ]);
  assert.deepEqual(days[1]!.slice(-2), ['2 / 4（50%）', '0 / 0']);
  assert.deepEqual(days[2]!.slice(0, 3), ['合计', '8', '12']);
  assert.equal(days[2]![10], '2 / 4（50%）');
  assert.equal(days[2]![11], '—');
});

test('玩家统计: 按角色 shows the display name, 按模型 names a reply with no model choice, the range reloads, 导出表格 saves the CSV', async (t) => {
  const f = mountStats(t);
  await f.api.load();
  assert.deepEqual(rows(f.root, '玩家统计（按角色）'), [['瓜瓜', '7', '1', '0', '6']]);
  assert.deepEqual(rows(f.root, '玩家统计（按模型）'), [
    ['xai', '5', '0', '0', '4'],
    ['未选择模型', '2', '1', '0', '2'],
  ]);
  const tabs = (f.root as unknown as FakeElement).querySelectorAll('[role="tab"]');
  assert.deepEqual(
    tabs.map((tab) => tab.textContent),
    ['按天', '按角色', '按模型'],
  );
  tabs[1]!.click();
  assert.equal(tabs[1]!.getAttribute('aria-selected'), 'true');
  assert.equal(tabs[0]!.getAttribute('aria-selected'), 'false');
  const select = (f.root as unknown as FakeElement).querySelector('select')!;
  select.value = '30';
  select.dispatch('change');
  await flush();
  assert.deepEqual(f.loads, [7, 30]);
  const buttons = (f.root as unknown as FakeElement).querySelectorAll('button');
  buttons.find((b) => b.textContent === '导出表格')!.click();
  await flush();
  assert.deepEqual(f.exports, [30]);
  assert.deepEqual(f.saved, [['玩家统计-最近30天.csv', '﻿a,b\r\n']]);
});

test('玩家统计: nothing yet says so instead of an empty table of zeros', async (t) => {
  const f = mountStats(t, { ...players(), since: null, days: [], byCharacter: [], byModel: [] });
  await f.api.load();
  assert.match(text(f.root), /统计尚未开始/);
  assert.deepEqual(rows(f.root, '玩家统计（按天）'), []);
});

const costs = (spans: boolean): CostsView => ({
  since: '2026-11-03',
  range: 30,
  usdCny: 6.7,
  rows: [
    {
      day: '2026-11-20',
      provider: 'fish',
      model: 'drama-3',
      phase: 'speech',
      calls: 3,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      bytes: 1000,
      listCostMicros: 50_000,
      ledgerChargedMicros: 90_000,
      replies: 0,
    },
    {
      day: '2026-10-30',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      phase: 'draft',
      calls: 2,
      inputTokens: 1000,
      cachedInputTokens: 100,
      outputTokens: 200,
      bytes: 0,
      listCostMicros: 1234,
      ledgerChargedMicros: null,
      replies: 2,
    },
  ],
  daily: [
    { day: '2026-11-20', publishedReplies: 10, listCostMicros: 50_000, costPerReplyMicros: 5000, pointsSpent: 120 },
  ],
  month: {
    month: '2026-11',
    listCostMicros: 2_000_000,
    ledgerChargedMicros: 3_600_000,
    listCostRmbFen: 1340,
    publishedReplies: 400,
    costPerReplyMicros: 5000,
    pointsSpent: 999,
    spansDramaPriceChange: spans,
  },
});

function mountCosts(t: test.TestContext, view: CostsView) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const saved: string[] = [];
  const api = costsView(root, {
    load: async () => view,
    exportCsv: async (range) => ({ csv: `range ${range}`, rows: 1 }),
    download: (name) => void saved.push(name),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
  });
  return { root, api, saved };
}

test('消耗表: the one rate is on the page, the month is in USD and RMB, the ledger column reads — before 22c, the price note only when the month spans the change', async (t) => {
  const f = mountCosts(t, costs(true));
  await f.api.load();
  const page = text(f.root);
  assert.match(page, /按 1 美元 ≈ 6\.7 元估算/);
  assert.match(page, /本月（UTC 2026-11）/);
  assert.match(page, /\$2\.0000（约 ¥13\.40）/);
  assert.match(page, /\$3\.6000/);
  assert.match(page, /Fish Drama 3 的列表价在 2026-11-12 之后改变/);
  const detail = rows(f.root, '消耗表（按供应商、模型、阶段）');
  assert.deepEqual(detail[0]!.slice(0, 4), ['2026-11-20', 'fish', 'drama-3', '语音']);
  assert.deepEqual(detail[0]!.slice(-3), ['$0.0500', '$0.0900', '0']);
  assert.deepEqual(detail[1]!.slice(-3), ['$0.0012', '—', '2'], 'a day before 22c has no ledger amount');
  assert.deepEqual(rows(f.root, '消耗表（按天）'), [['2026-11-20', '10', '$0.0500', '$0.0050', '120']]);
  const quiet = mountCosts(t, costs(false));
  await quiet.api.load();
  assert.doesNotMatch(text(quiet.root), /Fish Drama 3/);
  assert.equal(
    (f.root as unknown as FakeElement).querySelector('select')!.value,
    '30',
    'the range select opens on the range the view loads',
  );
});

test('概览: yesterday and this month in RMB for stats.read, nothing for anyone else', async (t) => {
  const doc = installFakeDom(t);
  const make = async (stats: unknown) => {
    const root = doc.createElement('div') as unknown as HTMLElement;
    const api = overviewView(root, {
      load: async () =>
        ({
          day: '2026-11-20',
          today: { replies: 1, voiceReplies: 1, failedReplies: 0, spendMicros: 0 },
          warnings: { priceExpiring: 0, retentionFailing: 0, unknownNew: 0 },
          stats,
        }) as never,
      links: () => [],
      go: () => {},
      run: async (work) => {
        await work();
      },
      disposed: () => false,
    });
    await api.load();
    return text(root);
  };
  const withStats = await make({
    yesterday: { day: '2026-11-19', signups: 3, active: 46, replies: 354 },
    monthListCostRmbFen: 12865,
  });
  for (const wanted of ['昨日新注册（UTC 2026-11-19）', '46', '354', '¥128.65'])
    assert.ok(withStats.includes(wanted), wanted);
  const without = await make(null);
  assert.ok(!without.includes('昨日') && !without.includes('¥'));
});

test('navigation: 玩家统计 and 消耗表 are for the owner and stats.read, nobody else, and are no placeholder', () => {
  const access = (permissions: string[], owner = false) => ({ owner, permissions, inbox: true, system: true });
  for (const page of ['stats', 'costs'] as const) {
    assert.equal(canSeePage(page, access([], true)), true);
    assert.equal(canSeePage(page, access(['stats.read'])), true);
    assert.equal(canSeePage(page, access(['system.read', 'points.grant', 'invites.manage'])), false);
    assert.equal(
      canSeePage(page, { ...access([], true), system: false }),
      false,
      'a page without the system clients has none',
    );
  }
  const labels = (permissions: string[]) => visibleNav(access(permissions)).flatMap((g) => g.items.map((i) => i.label));
  assert.ok(labels(['stats.read']).includes('玩家统计') && labels(['stats.read']).includes('消耗表'));
  assert.ok(!labels(['system.read']).includes('玩家统计'));
});
