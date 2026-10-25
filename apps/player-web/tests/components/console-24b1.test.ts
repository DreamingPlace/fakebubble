import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { costsView, priceMarkers, spendSeries } from '../../src/features/admin/costs-view.ts';
import { inviteTiersView } from '../../src/features/admin/invite-tiers-view.ts';
import { overviewView, seriesFigure } from '../../src/features/admin/overview-view.ts';
import {
  canSeePage,
  firstAllowedPage,
  groupPages,
  NAV_TREE,
  navMarkup,
  visibleNav,
  type NavAccess,
} from '../../src/features/admin/shell/admin-nav.ts';
import { LEGACY_ROUTES, formatRoute, parseRoute } from '../../src/features/admin/shell/admin-router.ts';
import { systemView } from '../../src/features/admin/system-view.ts';
import {
  axisTicks,
  conicGradient,
  dollarLabel,
  linePath,
  niceCeiling,
  peakOf,
} from '../../src/features/admin/ui/chart-math.ts';
import type { InviteBatch, InviteBatchCode, SystemStatusView } from '../../src/services/account-admin-api.ts';
import type {
  ChartMetric,
  ChartRange,
  ChartView,
  SpendDay,
  SpendView,
} from '../../../../packages/contracts/web-stats.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

const text = (el: unknown) => (el as FakeElement).textContent;
const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);
const one = (root: unknown, selector: string) => (root as FakeElement).querySelector(selector)!;
const btn = (root: unknown, label: string) => all(root, 'button').find((b) => b.textContent === label)!;

// ---- navigation ---------------------------------------------------------------------------------------------------------

const access = (permissions: string[], over: Partial<NavAccess> = {}): NavAccess => ({
  owner: false,
  permissions,
  inbox: true,
  system: true,
  models: true,
  conversations: true,
  ...over,
});
const labelsOf = (a: NavAccess) => visibleNav(a).flatMap((g) => groupPages(g).map((i) => i.label));

// Part 24b-2 exception (named, narrow): 关系与故事 now exists after 角色工作台, and 预演测试 is no longer a page of its own (预演 lives
// inside 角色工作台; #/preview/<id> redirects there). The assertions about those two items are changed; nothing else here is.
test('24b-1 nav: the groups and pages are exactly the board (as amended by 24b-2: 关系与故事 added, 预演测试 folded into 角色工作台)', () => {
  assert.deepEqual(
    NAV_TREE.map((g) => [g.label, groupPages(g).map((i) => `${i.page}:${i.label}`)]),
    [
      ['', ['overview:总览']],
      ['角色', ['characters:角色工作台', 'cast:关系与故事', 'cocreation:共创收件箱']],
      ['玩家', ['invites:邀请与额度', 'points:积分发放']],
      ['运营', ['stats:玩家统计', 'costs:消耗表']],
      ['系统', ['models:模型与价格', 'system:系统状态', 'members:管理员与权限']],
    ],
  );
  // 测试对话 joins 运营 behind its switch, after 消耗表.
  const everything = labelsOf(access([], { owner: true }));
  assert.deepEqual(everything.slice(everything.indexOf('玩家统计'), everything.indexOf('玩家统计') + 3), [
    '玩家统计',
    '消耗表',
    '测试对话',
  ]);
  assert.ok(everything.includes('关系与故事'));
  assert.ok(!everything.includes('预演测试'));
  assert.ok(!navMarkup().includes('data-page="preview"'));
  assert.match(navMarkup(), /data-page="cast"[^>]*>/);
});

test('24b-1 nav: every page keeps its own permission rule, whatever group it moved to', () => {
  const owner = access([], { owner: true });
  assert.equal(canSeePage('stats', owner) && canSeePage('costs', owner) && canSeePage('conversations', owner), true);
  // 玩家统计 and 消耗表: the owner or stats.read.
  for (const page of ['stats', 'costs'] as const) {
    assert.equal(canSeePage(page, access(['stats.read'])), true);
    assert.equal(canSeePage(page, access(['invites.manage', 'points.grant', 'system.read'])), false, page);
  }
  // 测试对话: the switch AND conversations.read.
  assert.equal(canSeePage('conversations', access(['conversations.read'], { conversations: false })), false);
  assert.equal(canSeePage('conversations', access(['conversations.read'])), true);
  assert.equal(canSeePage('conversations', access(['stats.read'])), false);
  // 角色工作台 needs read; 共创收件箱 needs the inbox and cocreation.read.
  assert.equal(canSeePage('characters', access(['characters.read:*'])), true);
  assert.equal(canSeePage('cocreation', access(['cocreation.read'], { inbox: false })), false);
  // 邀请与额度, 积分发放, 系统状态, 管理员与权限.
  assert.equal(canSeePage('invites', access(['invites.read'])), true);
  assert.equal(canSeePage('points', access(['points.grant'])), true);
  assert.equal(canSeePage('points', access(['stats.read'])), false);
  assert.equal(canSeePage('system', access(['system.read'])), true);
  assert.equal(canSeePage('system', access(['stats.read'])), false);
  assert.equal(canSeePage('members', access(['system.read'])), false);
  assert.equal(canSeePage('members', owner), true);
  // 总览 is for everyone who can log in; 模型与价格 for anyone, when the page has its client.
  assert.equal(canSeePage('overview', access([])), true);
  assert.equal(canSeePage('models', access([], { models: false })), false);
  // A stats.read administrator sees exactly 总览, 玩家统计 and 消耗表 (and nothing under 角色, 玩家 or 系统 but 模型与价格).
  assert.deepEqual(labelsOf(access(['stats.read'])), ['总览', '玩家统计', '消耗表', '模型与价格']);
});

test('24b-1 nav: the first page an administrator may use follows the nav order', () => {
  assert.equal(firstAllowedPage(access([], { owner: true })), 'overview');
  assert.equal(firstAllowedPage(access([], { owner: true, system: false })), 'characters');
  assert.equal(firstAllowedPage(access(['stats.read'], { system: false, models: false })), 'account');
  assert.equal(firstAllowedPage(access(['cocreation.read', 'invites.read'], { system: false })), 'cocreation');
  assert.equal(firstAllowedPage(access(['invites.read'], { system: false, models: false })), 'invites');
  assert.equal(firstAllowedPage(access([], { system: false, models: false })), 'account');
});

test('24b-1 nav: old links still work and are followed to their place today', () => {
  // Every old name resolves to a page that exists, and the address is the new place.
  assert.deepEqual(LEGACY_ROUTES, { grants: 'invites', ops: 'system', metrics: 'system', home: 'overview' });
  assert.deepEqual(parseRoute('#/grants'), { page: 'invites', id: null });
  assert.deepEqual(parseRoute('#/ops'), { page: 'system', id: null });
  assert.deepEqual(parseRoute('#/metrics'), { page: 'system', id: null });
  assert.equal(formatRoute(parseRoute('#/grants')!), '#/invites');
  // The links of the pages that kept their names (and moved group) are untouched.
  for (const hash of ['#/stats', '#/costs', '#/conversations', '#/characters/jojo', '#/overview', '#/system'])
    assert.equal(formatRoute(parseRoute(hash)!), hash);
  assert.equal(parseRoute('#/relations'), null, 'a page that does not exist yet is not a route');
});

// ---- chart arithmetic ---------------------------------------------------------------------------------------------------

test('24b-1 消耗表 axis: the ceiling is a rounded number above the tallest value, with headroom', () => {
  for (const [peak, top] of [
    [0, 1],
    [0.3, 0.5],
    [0.8, 1],
    [3.2, 5],
    [4.4, 5],
    [4.6, 10],
    [8.9, 10],
    [17.9, 25],
    [26, 50],
    [48, 100],
    [212, 250],
  ] as const)
    assert.equal(niceCeiling(peak), top, `peak ${peak}`);
  // The gridlines are round numbers: four spans, or five when the ceiling starts with 2.5 or 5.
  assert.deepEqual(axisTicks(10), [0, 2.5, 5, 7.5, 10]);
  assert.deepEqual(axisTicks(50), [0, 10, 20, 30, 40, 50]);
  assert.deepEqual(axisTicks(25), [0, 5, 10, 15, 20, 25]);
  assert.deepEqual(axisTicks(1), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(
    axisTicks(0.5).map((t) => Number(t.toFixed(2))),
    [0, 0.1, 0.2, 0.3, 0.4, 0.5],
  );
  // Labels: whole dollars only when every gridline is whole; otherwise every label has cents.
  assert.deepEqual(
    axisTicks(50).map((t) => dollarLabel(t, axisTicks(50))),
    ['$0', '$10', '$20', '$30', '$40', '$50'],
  );
  assert.deepEqual(
    axisTicks(2).map((t) => dollarLabel(t, axisTicks(2))),
    ['$0.00', '$0.50', '$1.00', '$1.50', '$2.00'],
  );
  // Stacked bars add the visible series up; lines look at the single highest value.
  const series = [
    [1, 2, null],
    [3, 1, 4],
  ];
  assert.equal(peakOf(series, true), 4);
  assert.equal(peakOf(series, false), 4);
  assert.equal(
    peakOf(
      [
        [1, 5],
        [4, 1],
      ],
      true,
    ),
    6,
  );
  assert.equal(
    peakOf(
      [
        [1, 5],
        [4, 1],
      ],
      false,
    ),
    5,
  );
  // A missing day breaks the line (a new M) instead of drawing zero.
  assert.equal(linePath([1, null, 1], 2, 100, 10), 'M0.0,5.0 M100.0,5.0');
  assert.equal(linePath([0, 2], 2, 100, 10), 'M0.0,10.0 L100.0,0.0');
  assert.match(
    conicGradient([
      { color: '#a', value: 1 },
      { color: '#b', value: 3 },
    ]),
    /#a 0\.00deg 90\.00deg, #b 90\.00deg 360\.00deg/,
  );
});

// ---- 总览 ---------------------------------------------------------------------------------------------------------------

const day = (n: number) => `2026-11-${String(n).padStart(2, '0')}`;
const chartView = (metric: ChartMetric, range: ChartRange): ChartView => {
  const hourly = range === '24h';
  const count = hourly ? 24 : range === '7d' ? 7 : 14;
  const buckets = Array.from({ length: count }, (_, i) =>
    hourly ? `2026-11-20T${String(i).padStart(2, '0')}` : day(21 - count + i),
  );
  const values = (base: number) => buckets.map((_, i) => (i === 0 ? null : base + i));
  return {
    metric,
    range,
    bucket: hourly ? 'hour' : 'day',
    since: '2026-11-03',
    buckets,
    total: values(30),
    characters: [
      { name: '瓜瓜', values: values(10) },
      { name: 'JOJO', values: values(8) },
      { name: '陈吉米', values: values(6) },
    ],
  };
};
function mountOverview(t: test.TestContext, o: { chart?: boolean; available?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const calls: [ChartMetric, ChartRange][] = [];
  const api = overviewView(root, {
    load: async () => ({
      day: '2026-11-20',
      today: { replies: 12, voiceReplies: 9, failedReplies: 1, spendMicros: 2_500_000 },
      warnings: { priceExpiring: 0, retentionFailing: 0, unknownNew: 0 },
      stats: null,
    }),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
    chart:
      o.chart === false
        ? undefined
        : {
            load: async (metric, range) => {
              calls.push([metric, range]);
              return chartView(metric, range);
            },
            ...(o.available === undefined ? {} : { available: () => o.available! }),
          },
  });
  return { root, api, calls };
}
const pressed = (root: unknown, group: string) =>
  all(root, `[aria-label="${group}"] button`).find((b) => b.getAttribute('aria-pressed') === 'true')!.textContent;
const visiblePane = (root: unknown) =>
  ['.ov-line', '.ov-pie', '.ov-table'].filter((selector) => !one(root, selector).hidden);

test('24b-1 总览: one chart card; metric, range and view switch with the real endpoint shape', async (t) => {
  const f = mountOverview(t);
  await f.api.load();
  // One card, opening on 回复 · 14天 · 折线, fed by exactly one call.
  assert.equal(all(f.root, '.ov-chart').length, 1);
  assert.deepEqual(f.calls, [['replies', '14d']]);
  assert.deepEqual([pressed(f.root, '指标'), pressed(f.root, '时间范围')], ['回复', '14天']);
  assert.deepEqual(
    all(f.root, '[aria-label="指标"] button').map((b) => b.textContent),
    ['回复', '聊天人数'],
  );
  assert.deepEqual(
    all(f.root, '[aria-label="时间范围"] button').map((b) => b.textContent),
    ['24H', '7天', '14天'],
  );
  assert.deepEqual(
    all(f.root, '[aria-label="图表类型"] button').map((b) => b.getAttribute('aria-label')),
    ['折线', '饼图', '表格'],
  );
  assert.deepEqual(visiblePane(f.root), ['.ov-line']);
  // The legend: every character and the total, with what the window added up to.
  const legend = text(one(f.root, '.ov-legend'));
  for (const wanted of ['瓜瓜', 'JOJO', '陈吉米', '合计']) assert.ok(legend.includes(wanted), wanted);
  // 回复 adds up over the window: 瓜瓜 = 11 + 12 + … + 23.
  assert.equal(seriesFigure('replies', chartView('replies', '14d').characters[0]!.values), 13 * 10 + (13 * 14) / 2);
  // The range asks again, with the same metric.
  btn(f.root, '24H').click();
  await flush();
  assert.deepEqual(f.calls.at(-1), ['replies', '24h']);
  assert.equal(all(f.root, '.ov-line .xy-hit').length, 24, 'one column per hour');
  btn(f.root, '7天').click();
  await flush();
  assert.deepEqual(f.calls.at(-1), ['replies', '7d']);
  assert.equal(all(f.root, '.ov-line .xy-hit').length, 7);
  // The metric asks again, with the same range.
  btn(f.root, '聊天人数').click();
  await flush();
  assert.deepEqual(f.calls.at(-1), ['chat_users', '7d']);
  // The view only repaints: no new call.
  const before = f.calls.length;
  one(f.root, '[aria-label="图表类型"] [aria-label="饼图"]').click();
  assert.deepEqual(visiblePane(f.root), ['.ov-pie']);
  one(f.root, '[aria-label="图表类型"] [aria-label="表格"]').click();
  assert.deepEqual(visiblePane(f.root), ['.ov-table']);
  one(f.root, '[aria-label="图表类型"] [aria-label="折线"]').click();
  assert.deepEqual(visiblePane(f.root), ['.ov-line']);
  assert.equal(f.calls.length, before);
  // Nothing in the card says "today": the chart is a window of the data, not a label.
  assert.doesNotMatch(text(one(f.root, '.ov-chart')), /今天|今日/);
});

test('24b-1 总览: the pie shows shares with the total in the middle; the table is newest first with — before the counters', async (t) => {
  const f = mountOverview(t);
  await f.api.load();
  btn(f.root, '7天').click();
  await flush();
  one(f.root, '[aria-label="图表类型"] [aria-label="饼图"]').click();
  // 回复 over 7 days: 瓜瓜 6 buckets of 11..16 = 81, JOJO 9..14 = 69, 陈吉米 7..12 = 57.
  const shares = all(f.root, '.ov-pie-row').map((row) => row.textContent);
  assert.deepEqual(
    shares,
    ['瓜瓜39%', 'JOJO33%', '陈吉米28%'].map((s) => s),
  );
  assert.equal(text(one(f.root, '.ov-pie-total')), String(31 + 32 + 33 + 34 + 35 + 36));
  assert.equal(text(one(f.root, '.ov-pie-unit')), '条');
  assert.match(one(f.root, '.ov-pie-disc').style.getPropertyValue('--pie'), /^conic-gradient\(/);
  one(f.root, '[aria-label="图表类型"] [aria-label="表格"]').click();
  const rows = all(f.root, '.ov-data tbody tr');
  assert.equal(rows.length, 7);
  assert.equal(rows[0]!.querySelector('th')!.textContent, day(20), 'newest first');
  assert.equal(rows[6]!.querySelectorAll('td')[0]!.textContent, '—', 'the oldest bucket had no counters');
  assert.deepEqual(
    all(f.root, '.ov-data thead th').map((th) => th.textContent),
    ['日期 UTC', '瓜瓜', 'JOJO', '陈吉米', '合计'],
  );
  // 24H: the first column says 时间 and the buckets are hours.
  btn(f.root, '24H').click();
  await flush();
  assert.equal(all(f.root, '.ov-data thead th')[0]!.textContent, '时间 UTC');
  assert.equal(all(f.root, '.ov-data tbody tr')[0]!.querySelector('th')!.textContent, '23:00');
  // 聊天人数 has no sum: the legend shows the newest bucket's people.
  btn(f.root, '聊天人数').click();
  await flush();
  assert.equal(seriesFigure('chat_users', [3, 4, null]), 4);
  assert.equal(text(one(f.root, '.ov-pie-unit')), '人');
});

test('24b-1 总览: no chart card without the client or without stats.read; the numbers above it stay', async (t) => {
  const without = mountOverview(t, { chart: false });
  await without.api.load();
  assert.equal(one(without.root, '.ov-chart').hidden, true);
  assert.deepEqual(without.calls, []);
  assert.ok(text(without.root).includes('12'), 'today is still there');
  const refused = mountOverview(t, { available: false });
  await refused.api.load();
  assert.equal(one(refused.root, '.ov-chart').hidden, true);
  assert.deepEqual(refused.calls, [], 'an administrator without stats.read never asks');
});

// ---- 邀请与额度 ---------------------------------------------------------------------------------------------------------

const batch = (over: Partial<InviteBatch> = {}): InviteBatch => ({
  id: 'b1',
  name: '朋友第一批',
  tier: 'unlimited',
  dailyAmount: null,
  cap: null,
  durationDays: null,
  redeemBy: null,
  createdAt: Date.UTC(2026, 9, 1),
  codes: 3,
  redeemed: 0,
  revoked: 0,
  holders: 0,
  ...over,
});
function mountInvites(t: test.TestContext, o: { plain?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const created: unknown[] = [];
  const copied: string[] = [];
  let list: InviteBatch[] = [batch()];
  const made = ['A'.repeat(43), 'B'.repeat(43), 'C'.repeat(43)];
  const view = inviteTiersView(root, {
    port: {
      inviteBatches: async () => list,
      inviteBatchDetail: async (id): Promise<InviteBatchCode[]> =>
        id === 'b2'
          ? made.map((code, i) => ({
              id: `c${i}`,
              serial: i + 1,
              state: 'unused' as const,
              redeemedAt: null,
              expiresAt: null,
              playerNumber: null,
              ...(o.plain === false ? {} : { codeView: 'plain' as const, code }),
            }))
          : [],
      createInviteBatch: async (input) => {
        created.push(input);
        list = [
          batch({ id: 'b2', name: input.name, codes: input.count, ...(input.test ? { test: true as const } : {}) }),
          ...list,
        ];
        return { batchId: 'b2', duplicate: false, codes: made.slice(0, input.count) };
      },
    },
    isOwner: () => true,
    run: async (work) => work(),
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'req-1',
    disposed: () => false,
    download: () => {},
    copy: async (value) => void copied.push(value),
  });
  const create = async (name: string, testGroup: boolean) => {
    (one(root, '#tiers-name') as FakeElement).value = name;
    (one(root, '#tiers-count') as FakeElement).value = '3';
    (one(root, '#tiers-kind-unlimited') as FakeElement).checked = true;
    (one(root, '#tiers-kind-refill') as FakeElement).checked = false;
    one(root, '#tiers-kind-unlimited').dispatch('change');
    (one(root, '#tiers-test') as FakeElement).checked = testGroup;
    one(root, '#admin-tiers-create').dispatch('submit');
    await flush();
    await flush();
  };
  return { root, view, created, copied, create };
}

test('24b-1 邀请与额度: the 测试 checkbox is sent at creation (and only when ticked); the batch carries the mark', async (t) => {
  const f = mountInvites(t);
  await f.view.load();
  assert.equal((one(f.root, '#tiers-test') as FakeElement).checked, false, 'off by default');
  await f.create('朋友第二批', false);
  assert.equal('test' in (f.created[0] as object), false, 'an ordinary batch sends no test field at all');
  await f.create('测试组一', true);
  assert.equal((f.created[1] as { test?: boolean }).test, true);
  assert.equal((one(f.root, '#tiers-test') as FakeElement).checked, false, 'cleared after creating');
  assert.ok(all(f.root, '.tiers-test-badge').length >= 1, 'the list marks a test batch');
  // The mark is not editable afterwards: no control on the list changes it.
  assert.equal(all(f.root, '.tiers-table input[type="checkbox"]').length, 0);
});

test('24b-1 邀请与额度: right after creating, every code opens with its own 复制 and copies exactly that code', async (t) => {
  const f = mountInvites(t);
  await f.view.load();
  await f.create('朋友第二批', false);
  // The new batch is selected at once (no notice, no separate box).
  assert.equal(all(f.root, '.tiers-fresh').length, 0);
  assert.equal(one(f.root, 'tr[data-batch="b2"]').getAttribute('aria-selected'), 'true');
  const rows = all(f.root, '.tiers-codes-table tbody tr');
  assert.equal(rows.length, 3);
  const buttons = rows.map((r) => r.querySelector('.tiers-copy')!);
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['复制', '复制', '复制'],
  );
  buttons[1]!.click();
  await flush();
  assert.deepEqual(f.copied, ['B'.repeat(43)]);
  assert.equal(buttons[1]!.textContent, '已复制');
  assert.equal(buttons[1]!.getAttribute('aria-pressed'), 'true');
  buttons[2]!.click();
  await flush();
  buttons[0]!.click();
  await flush();
  assert.deepEqual(f.copied, ['B'.repeat(43), 'C'.repeat(43), 'A'.repeat(43)]);
  // 复制全部未使用 copies them all, in order.
  btn(f.root, '复制全部未使用').click();
  await flush();
  assert.equal(f.copied.at(-1), ['A', 'B', 'C'].map((c) => c.repeat(43)).join('\n'));
});

test('24b-1 邀请与额度: when the detail does not carry the plain codes yet, the codes returned at creation still copy one by one', async (t) => {
  const f = mountInvites(t, { plain: false });
  await f.view.load();
  await f.create('朋友第二批', false);
  const buttons = all(f.root, '.tiers-codes-table tbody tr').map((r) => r.querySelector('.tiers-copy'));
  assert.equal(buttons.every(Boolean), true, 'a 复制 on every row');
  buttons[2]!.click();
  await flush();
  assert.deepEqual(f.copied, ['C'.repeat(43)]);
});

test('24b-1 邀请与额度: fixed column widths and one size of button on a batch row', () => {
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
  assert.match(css, /\.tiers-table \{[^}]*table-layout: fixed;/);
  assert.match(css, /\.tiers-codes-table \{[^}]*table-layout: fixed;/);
  const row = /\.tiers-actions button \{([^}]*)\}/.exec(css)![1]!;
  assert.match(row, /width: 84px;/);
  assert.match(row, /height: 32px;/);
  // The table names a width for every column, so nothing is sized by its content.
  for (const column of ['name', 'tier', 'created', 'num', 'actions'])
    assert.match(css, new RegExp(`\\.tiers-col-${column} \\{[^}]*width:`));
  for (const column of ['serial', 'code', 'state', 'at', 'player', 'until', 'action'])
    assert.match(css, new RegExp(`\\.tiers-dcol-${column} \\{[^}]*width:`));
});

// ---- 消耗表 -------------------------------------------------------------------------------------------------------------

const SPEND_DAYS = 10;
function spend(over: Partial<SpendView> = {}, amounts: Record<string, number> = {}): SpendView {
  // Newest first. Per day (micros): guest 0.5, registered 1.5, daily_refill 1.2, unlimited 0.6, test 0.3, unclassified 0.1 (+ amounts).
  const days: SpendDay[] = Array.from({ length: SPEND_DAYS }, (_, i) => {
    const d = `2026-11-${String(20 - i).padStart(2, '0')}`;
    if (i === SPEND_DAYS - 1) return { day: d, types: null, unclassifiedMicros: null, totalMicros: null };
    const m = (v: number) => Math.round((amounts[d] ?? 1) * v * 1_000_000);
    return {
      day: d,
      types: [
        { userType: 'test' as const, textMicros: m(0.1), voiceMicros: m(0.2) },
        { userType: 'unlimited' as const, textMicros: m(0.2), voiceMicros: m(0.4) },
        { userType: 'daily_refill' as const, textMicros: m(0.4), voiceMicros: m(0.8) },
        { userType: 'registered' as const, textMicros: m(0.5), voiceMicros: m(1) },
        { userType: 'guest' as const, textMicros: m(0.2), voiceMicros: m(0.3) },
      ],
      unclassifiedMicros: m(0.1),
      totalMicros: m(3.6),
    };
  });
  return {
    since: '2026-11-03',
    range: 30,
    usdCny: 6.7,
    days,
    totals: null,
    alertMicros: 5_000_000,
    priceChanges: [],
    ...over,
  };
}
function mountCosts(t: test.TestContext, view: SpendView | Error) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const spendCalls: number[] = [];
  const api = costsView(root, {
    load: async () => ({
      since: '2026-11-03',
      range: 30,
      usdCny: 6.7,
      rows: [],
      daily: [],
      month: {
        month: '2026-11',
        listCostMicros: 2_000_000,
        ledgerChargedMicros: 3_600_000,
        listCostRmbFen: 1340,
        publishedReplies: 400,
        costPerReplyMicros: 5000,
        pointsSpent: 999,
        spansDramaPriceChange: true,
      },
    }),
    spend: async (range) => {
      spendCalls.push(range);
      if (view instanceof Error) throw view;
      return { ...view, range };
    },
    exportCsv: async () => ({ csv: '', rows: 0 }),
    download: () => {},
    run: async (work) => {
      await work();
    },
    disposed: () => false,
  });
  const labels = () =>
    all(root, '.xy-grid')
      .filter((g) => !g.classList.contains('is-off'))
      .map((g) => g.textContent);
  const alertShown = () => !one(root, '.xy-alert').classList.contains('is-off');
  const chip = (id: string) => one(root, `[data-chip="${id}"]`);
  return { root, api, spendCalls, labels, alertShown, chip };
}

test('24b-1 消耗表: user-type chips (no 管理员), each selectable on its own; the other split is 文字 / 语音', async (t) => {
  const f = mountCosts(t, spend());
  await f.api.load();
  assert.deepEqual(f.spendCalls, [30], 'the 22d endpoint is asked for the same range');
  const chips = all(f.root, '[data-chip]');
  assert.deepEqual(
    chips.map((c) => c.getAttribute('data-chip')),
    ['guest', 'registered', 'daily_refill', 'unlimited', 'test', 'unclassified'],
  );
  assert.ok(chips[0]!.textContent.startsWith('访客'));
  assert.ok(chips[4]!.textContent.startsWith('测试组'));
  assert.ok(chips[5]!.textContent.startsWith('未归类'));
  assert.doesNotMatch(text(one(f.root, '.cost-chips')), /管理员/);
  assert.equal(
    chips.every((c) => c.getAttribute('aria-pressed') === 'true'),
    true,
    'all on to begin with',
  );
  // Each chip toggles alone.
  f.chip('registered').click();
  assert.deepEqual(
    all(f.root, '[data-chip]').map((c) => c.getAttribute('aria-pressed')),
    ['true', 'false', 'true', 'true', 'true', 'true'],
  );
  f.chip('registered').click();
  assert.equal(f.chip('registered').getAttribute('aria-pressed'), 'true');
  // The sums on the chips are dollars over the known days.
  assert.match(f.chip('registered').textContent, /\$13\.50/, '9 known days of $1.50');
  // The other split: 文字 / 语音 (and what could not be split), chips start on again.
  btn(f.root, '文字 / 语音').click();
  assert.deepEqual(
    all(f.root, '[data-chip]').map((c) => c.getAttribute('data-chip')),
    ['text', 'voice', 'unclassified'],
  );
  assert.deepEqual(
    all(f.root, '[data-chip]').map((c) => c.getAttribute('aria-pressed')),
    ['true', 'true', 'true'],
  );
  // text: 0.1+0.2+0.4+0.5+0.2 = 1.4 a day; voice: 0.2+0.4+0.8+1+0.3 = 2.7 a day.
  assert.match(f.chip('text').textContent, /\$12\.60/);
  assert.match(f.chip('voice').textContent, /\$24\.30/);
  // Before the counters ran there are no figures, not zeros.
  const built = spendSeries(spend(), 'user');
  assert.equal(built.series[0]!.values.at(0), null, 'the oldest (unknown) day, oldest first');
  assert.equal(built.buckets.length, SPEND_DAYS);
});

test('24b-1 消耗表: the scale follows what is shown; the alert line is drawn only while it lies inside the scale', async (t) => {
  const f = mountCosts(t, spend());
  await f.api.load();
  // Everything on, bars stacked: 3.6 a day -> ceiling 5 -> gridlines in whole dollars; the $5 alert is exactly at the top (inside).
  assert.deepEqual(f.labels(), ['$0', '$1', '$2', '$3', '$4', '$5']);
  assert.equal(f.alertShown(), true);
  // Only the test group (0.3 a day): the ceiling falls to $0.50 and the $5 line is outside it.
  for (const id of ['guest', 'registered', 'daily_refill', 'unlimited', 'unclassified']) f.chip(id).click();
  assert.deepEqual(f.labels(), ['$0.00', '$0.10', '$0.20', '$0.30', '$0.40', '$0.50']);
  assert.equal(f.alertShown(), false, 'hidden: it is far above this scale');
  // Back to two types: 1.5 + 1.2 = 2.7 a day -> ceiling 5 again, the line returns.
  f.chip('registered').click();
  f.chip('daily_refill').click();
  f.chip('test').click();
  assert.equal(f.alertShown(), true);
  // A day in the middle spikes to 3x: 10.8 -> ceiling 20 -> labels follow, the line stays inside.
  const spiky = mountCosts(t, spend({}, { '2026-11-15': 3 }));
  await spiky.api.load();
  assert.deepEqual(spiky.labels(), ['$0', '$5', '$10', '$15', '$20']);
  assert.equal(spiky.alertShown(), true);
  // Lines look at the single highest series, not the stack: registered 1.5 -> ceiling 2.5? (1.5 * 1.12 = 1.68 -> 2).
  const line = mountCosts(t, spend());
  await line.api.load();
  one(line.root, '[aria-label="图表类型"] [aria-label="折线"]').click();
  assert.deepEqual(line.labels(), ['$0.00', '$0.50', '$1.00', '$1.50', '$2.00']);
  assert.equal(line.alertShown(), false, 'a $5 line is not drawn on a $2 scale');
  assert.equal(one(line.root, '.xy-layer .xy-lines') !== null, true);
  // No alert configured (the owner alerts are off): never drawn, whatever the scale.
  const none = mountCosts(t, spend({ alertMicros: null }));
  await none.api.load();
  assert.equal(none.alertShown(), false);
});

test('24b-1 消耗表: price markers only for real price changes; none otherwise', async (t) => {
  const quiet = mountCosts(t, spend());
  await quiet.api.load();
  assert.equal(all(quiet.root, '.xy-marker').length, 0, 'no records, no marker, no banner');
  assert.doesNotMatch(text(quiet.root), /Fish|Drama|调价/);
  const changed = mountCosts(
    t,
    spend({ priceChanges: [{ day: '2026-11-12', provider: 'fish', model: 'drama-3', phase: 'speech' }] }),
  );
  await changed.api.load();
  const markers = all(changed.root, '.xy-marker');
  assert.equal(markers.length, 1);
  assert.equal(markers[0]!.textContent, 'drama-3 调价');
  assert.ok(markers[0]!.style.getPropertyValue('--x').endsWith('%'));
  // A change outside the days shown has no marker; two models the same day share one.
  assert.deepEqual(
    priceMarkers(spend({ priceChanges: [{ day: '2026-09-01', provider: 'x', model: 'm', phase: 'draft' }] }), [
      '2026-11-12',
    ]),
    [],
  );
  assert.deepEqual(
    priceMarkers(
      spend({
        priceChanges: [
          { day: '2026-11-12', provider: 'a', model: 'm1', phase: 'draft' },
          { day: '2026-11-12', provider: 'a', model: 'm2', phase: 'review' },
        ],
      }),
      ['2026-11-11', '2026-11-12'],
    ),
    [{ index: 1, label: 'm1、m2 调价' }],
  );
});

test('24b-1 消耗表: bar / line switch; the ¥ figure carries the rate as a tooltip and the header has no rate; a failing spend call leaves the page', async (t) => {
  const f = mountCosts(t, spend());
  await f.api.load();
  assert.equal(one(f.root, '.xy').getAttribute('data-mode'), 'bar');
  assert.equal(all(f.root, '.xy-bar').length, SPEND_DAYS);
  one(f.root, '[aria-label="图表类型"] [aria-label="折线"]').click();
  assert.equal(one(f.root, '.xy').getAttribute('data-mode'), 'line');
  assert.equal(all(f.root, '.xy-path').length, 6);
  one(f.root, '[aria-label="图表类型"] [aria-label="柱状"]').click();
  assert.equal(all(f.root, '.xy-bar').length, SPEND_DAYS);
  const header = text(one(f.root, '.page-head'));
  assert.doesNotMatch(header, /6\.7|汇率|估算/);
  const yuan = all(f.root, '.overview-sub').find((s) => s.textContent.includes('¥'))!;
  assert.equal(yuan.getAttribute('title'), '按 $1 ≈ ¥6.7');
  // The chart is optional data: when it cannot load, the month and the tables still show.
  const broken = mountCosts(t, new Error('STATS_UNAVAILABLE'));
  await broken.api.load();
  assert.equal(one(broken.root, '.cost-chart').hidden, true);
  assert.ok(text(broken.root).includes('本月花费'));
});

// ---- 系统状态 -----------------------------------------------------------------------------------------------------------

const status = (over: Partial<SystemStatusView> = {}): SystemStatusView =>
  ({
    now: Date.UTC(2026, 10, 20),
    version: { commit: '6155488', migrationSteps: 55, schemaVersion: 130, matches: true },
    flags: null,
    prices: [],
    budget: { available: false, error: 'WEB_SYSTEM_SOURCES_UNAVAILABLE' },
    unknown: [],
    retention: null,
    metrics: [],
    security: {
      turnstile: false,
      failuresToday: 0,
      failuresLast7Days: 0,
      unavailableToday: 0,
      unavailableLast7Days: 0,
    },
    warnings: { priceExpiring: 0, retentionFailing: 0, unknownNew: 0 },
    ...over,
  }) as SystemStatusView;
function mountSystem(t: test.TestContext, shown: SystemStatusView, owner = true) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const api = systemView(root, {
    load: async () => shown,
    renewPrices: async () => ({ rows: [], duplicate: false }),
    topUp: async (input) => ({
      provider: input.provider,
      addedMicros: 0,
      allowanceMicros: 0,
      remainingMicros: 0,
      duplicate: false,
    }),
    isOwner: () => owner,
    run: async (work) => {
      await work();
    },
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'r',
    disposed: () => false,
  });
  return { root, api };
}

test('24b-1 系统状态: the build, the migration steps with matches, and the database version lead the page, in their own card', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  const card = one(f.root, '.sys-version');
  const first = one(f.root, '.sys-row');
  assert.ok(first.contains(card), 'the version card is in the first row');
  for (const wanted of ['6155488', '55 步', 'matches: true', '130']) assert.ok(text(card).includes(wanted), wanted);
  assert.equal(text(one(f.root, '.sys-version h3')), '运行版本');
  // A mismatch is as loud as a match.
  const bad = mountSystem(
    t,
    status({ version: { commit: 'abc', migrationSteps: 54, schemaVersion: 129, matches: false } }),
  );
  await bad.api.load();
  assert.ok(text(one(bad.root, '.sys-version')).includes('matches: false'));
  assert.ok(text(bad.root).includes('需要') === false, 'the header pill is about warnings, not about the build');
  // Every other card is still on the page (nothing was dropped by the new layout).
  for (const title of ['UNKNOWN', '安全', '价格', '预算', '清理', '开关', '技术指标'])
    assert.ok(
      all(f.root, 'h3').some((h3) => h3.textContent === title),
      title,
    );
  // The overall pill says what is wrong, in the words of 总览.
  const warn = mountSystem(t, status({ warnings: { priceExpiring: 2, retentionFailing: 0, unknownNew: 0 } }));
  await warn.api.load();
  assert.match(text(one(warn.root, '.sys-overall')), /需要留意.*2 项价格即将到期/);
  assert.match(text(one(f.root, '.sys-overall')), /全部正常/);
});

// ---- the console fix: nothing hidden behind a button, no 刷新, no status line ------------------------------------------------

test('24b-1 fix: the pages have no 刷新 button and no explanatory lines under their titles', async (t) => {
  const over = mountOverview(t);
  await over.api.load();
  const costs = mountCosts(t, spend());
  await costs.api.load();
  const system = mountSystem(t, status());
  await system.api.load();
  for (const root of [over.root, costs.root, system.root])
    assert.ok(!all(root, 'button').some((b) => b.textContent === '刷新'), 'no 刷新');
  // 技术指标: the range is segmented buttons, there is no dropdown and no paragraph.
  assert.deepEqual(
    all(system.root, '.system-metrics [aria-label="范围"] button').map((b) => b.textContent),
    ['7天', '14天', '31天'],
  );
  assert.equal(all(system.root, '.system-metrics select').length, 0);
  assert.equal(all(system.root, '.system-metrics .admin-hint').length, 0);
  // 总览: no row of links under the chart; 消耗表: 按天明细 is shown, not folded.
  assert.equal(all(over.root, '.overview-links').length, 0);
  assert.equal(all(costs.root, 'details').length, 0);
  assert.equal(one(costs.root, '.cost-dated').hidden, false);
  assert.ok(all(costs.root, '.cost-dated table').length >= 2);
});

test('24b-1 fix: the sources of the page are the pages themselves - no status bar, no collapse control in the shell', () => {
  const page = readFileSync(new URL('../../src/features/admin/account-admin-page.ts', import.meta.url), 'utf8');
  for (const gone of ['刷新权限列表', '收起导航', 'admin-nav-collapse', '正在检查登录状态'])
    assert.ok(!page.includes(gone), gone);
  assert.match(
    page,
    /invite-admin-status admin-statusbar sr-only/,
    'the line only survives as a live region for screen readers',
  );
});

test('24b-1 fix: 邀请与额度 shows the form and the list side by side; a click on a row selects the batch', async (t) => {
  const f = mountInvites(t);
  await f.view.load();
  assert.equal(all(f.root, '.tiers-layout .tiers-side #admin-tiers-create').length, 1, 'the form is always there');
  assert.equal(all(f.root, '.tiers-layout .tiers-main .tiers-table').length, 1);
  const labels = all(f.root, 'button').map((b) => b.textContent);
  for (const gone of ['新建批次', '取消', '查看', '收起', '刷新']) assert.ok(!labels.includes(gone), gone);
  assert.ok(labels.includes('撤销整批'), 'a real action stays on the row');
  assert.equal(one(f.root, '.tiers-detail').hidden, true);
  one(f.root, 'tr[data-batch="b1"]').click();
  await flush();
  assert.equal(one(f.root, '.tiers-detail').hidden, false);
  assert.equal(one(f.root, 'tr[data-batch="b1"]').getAttribute('aria-selected'), 'true');
  // A click on a button inside the row does not select it (撤销整批 asks first).
});

test('24b-1 fix: 积分发放 counts the players by itself while the inputs change; one 发放 button', async (t) => {
  const { pointsView } = await import('../../src/features/admin/points-view.ts');
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const asked: [string, number][] = [];
  const api = pointsView(root, {
    preview: async (target, amount) => {
      asked.push([target.kind, amount]);
      return {
        amount,
        players: 9,
        granted: 7,
        totalPoints: 7 * amount,
        skipped: { guests: 2, unlimited: 0, atCap: 0 },
        duplicate: false,
      };
    },
    grant: async () => {
      throw new Error('not here');
    },
    resetPreview: async () => {
      throw new Error('not here');
    },
    reset: async () => {
      throw new Error('not here');
    },
    isOwner: () => true,
    run: async (work) => {
      await work();
    },
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'r',
    disposed: () => false,
    debounceMs: 0,
  });
  await api.load();
  const labels = all(root, 'button').map((b) => b.textContent);
  assert.ok(!labels.includes('核对'));
  assert.equal(labels.filter((l) => l === '发放').length, 1);
  assert.ok(labels.includes('重置全部额度'), 'the owner has the reset in its own panel');
  const amount = one(root, '#points-amount') as FakeElement;
  amount.value = '20';
  amount.dispatch('input');
  await flush();
  await flush();
  assert.deepEqual(asked, [['all', 20]]);
  assert.match(text(one(root, '.points-live')), /将发给 7 位玩家，共 140 点/);
  amount.value = '30';
  amount.dispatch('input');
  await flush();
  await flush();
  assert.match(text(one(root, '.points-live')), /共 210 点/);
  // Invalid input asks nothing and shows nothing.
  amount.value = '0';
  amount.dispatch('input');
  await flush();
  assert.equal(asked.length, 2);
  assert.equal(text(one(root, '.points-live')), '');
});
