import assert from 'node:assert/strict';
import test from 'node:test';
import { costsView } from '../../src/features/admin/costs-view.ts';
import { overviewView } from '../../src/features/admin/overview-view.ts';
import { canSeePage, visibleNav } from '../../src/features/admin/shell/admin-nav.ts';
import type { CostsView } from '../../../../packages/contracts/web-stats.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

const text = (el: unknown) => (el as FakeElement).textContent;
const rows = (root: unknown, caption: string) =>
  (root as FakeElement)
    .querySelectorAll('table')
    .find((table) => text(table.querySelector('caption')) === caption)!
    .querySelectorAll('tbody tr')
    .map((tr) => tr.querySelectorAll('td').map((td) => td.textContent));

// Superseded in Part 24b-6 (reason): the 玩家统计 page (stats-view.ts) no longer exists - its day table, 按角色 / 按模型 and the CSV are
// part of 总览 now (Overview3). Its three tests here ("since line, newest first, a totals row ...", "按角色 shows the display name ... 导出表格
// saves the CSV", "nothing yet says so ...") are replaced by the 总览 tests of console-24b6.test.ts, which assert the same behaviours:
// the newest-first day table with its 合计 row and retention, the splits with 未选择模型, the range reloading, 导出表格 saving the CSV of
// the showing range, and the empty window.

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

test('消耗表: the month is in USD with the RMB figure (the rate is its tooltip), the ledger column reads — before 22c, and no hardcoded price note', async (t) => {
  const f = mountCosts(t, costs(true));
  await f.api.load();
  const page = text(f.root);
  // Named exception (Part 24b-1): no exchange rate in the header and no Fish Drama 3 note any more; the rate is the tooltip of the ¥ figure.
  assert.doesNotMatch(page, /按 1 美元 ≈ 6\.7 元估算/);
  assert.doesNotMatch(page, /Fish Drama 3/);
  assert.match(page, /UTC 2026-11/);
  assert.match(page, /\$2\.00/);
  assert.match(page, /≈ ¥13\.40/);
  assert.match(page, /\$3\.60/);
  // Named exception (Part 24b-6, Usage3): the rate is the hover value of the ¥ tile (no title attribute); the tables are open-below
  // grids (.ot) whose numeric cells carry their exact value on hover (the bubble's text follows the visible text), 按模型 merges the days
  // and 按天明细 has one row per day (its calls open under it). The values asserted are the same ones.
  const yuan = (f.root as unknown as FakeElement)
    .querySelectorAll('.ov-tile')
    .find((el) => /¥13\.40/.test(el.textContent))!;
  assert.match(yuan.textContent, /汇率 6\.7/);
  const grid = (caption: string) =>
    (f.root as unknown as FakeElement)
      .querySelectorAll('.ot')
      .find((o) => o.getAttribute('aria-label') === caption)!
      .querySelectorAll('.ot-row')
      .map((r) => r.querySelectorAll('.ot-cell').map((c) => c.textContent));
  const models = grid('消耗表（按模型合计）');
  assert.deepEqual(
    models.map((r) => r[0]),
    ['fish / drama-3 / 语音', 'deepseek / deepseek-v4-flash / 草稿'],
  );
  assert.ok(models[0]![6]!.startsWith('$0.05') && models[0]![6]!.includes('账本扣 $0.090 000'));
  assert.ok(
    models[1]![6]!.startsWith('$0.00') && !models[1]![6]!.includes('账本扣'),
    'a day before 22c has no ledger amount',
  );
  const days = grid('消耗表（按天明细）');
  assert.equal(days.length, 1);
  assert.deepEqual(
    days[0]!.map(
      (c, i) =>
        [0, 1, 2, 3, 4, 5].includes(i) && c.startsWith(['2026-11-20', '10', '$0.05', '$0.09', '120', '$0.0050'][i]!),
    ),
    [true, true, true, true, true, true],
  );
  const quiet = mountCosts(t, costs(false));
  await quiet.api.load();
  assert.doesNotMatch(text(quiet.root), /Fish Drama 3/);
  // Named exception (Part 24b-1): the range is a pill switch; it opens on 30 days, as the select did.
  const pressed = (f.root as unknown as FakeElement)
    .querySelectorAll('[aria-label="时间范围"] button')
    .find((b) => b.getAttribute('aria-pressed') === 'true')!;
  assert.equal(pressed.textContent, '30天', 'the range opens on the range the view loads');
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
  // Named exception (Part 24b-6): the tiles say 昨日新注册 / 昨日活跃 with the UTC day as their hover value; yesterday's replies are a
  // row of the 按天 table now, not a tile.
  for (const wanted of ['昨日新注册', '2026-11-19 UTC', '46', '¥128.65']) assert.ok(withStats.includes(wanted), wanted);
  const without = await make(null);
  assert.ok(!without.includes('昨日') && !without.includes('¥'));
});

// Named exception (Part 24b-6): 玩家统计 is not a page any more (总览 has it), so only 消耗表 is asked about here.
test('navigation: 消耗表 is for the owner and stats.read, nobody else, and is no placeholder', () => {
  const access = (permissions: string[], owner = false) => ({ owner, permissions, inbox: true, system: true });
  for (const page of ['costs'] as const) {
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
  assert.ok(labels(['stats.read']).includes('消耗表'));
  assert.ok(!labels(['stats.read']).includes('玩家统计'), 'no such nav item any more');
  assert.ok(!labels(['system.read']).includes('消耗表'));
});
