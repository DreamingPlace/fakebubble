import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewView } from '../../src/features/admin/overview-view.ts';
import { buildSplit, MODEL_COLOURS, OTHER_COLOUR, SHOWN_SERIES } from '../../src/features/admin/overview-split.ts';
import { DATE_PROBLEM, dateField, dayFromToday, monthGrid, parseDate } from '../../src/features/admin/ui/date-field.ts';
import { errorLine, sentenceOf } from '../../src/features/admin/ui/error-line.ts';
import { dollarText, priceCell, priceText, storedPriceText } from '../../src/features/admin/ui/price-format.ts';
import { errorText, micros } from '../../src/features/admin/preview/copy.ts';
import { ERROR_SENTENCES } from '../../src/features/admin/error-sentences.ts';
import { inviteTiersView, type InviteTiersDeps } from '../../src/features/admin/invite-tiers-view.ts';
import type {
  ChartMetric,
  ChartRange,
  ChartView,
  PlayerStatsView,
  StatsCounts,
  StatsRange,
} from '../../../../packages/contracts/web-stats.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

// Part 24b-7d / 24b-7e: plain Chinese, one date field, readable prices, and the one split of 总览.

const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);
const one = (root: unknown, selector: string) => (root as FakeElement).querySelector(selector) as FakeElement;

// ---- the date parts ------------------------------------------------------------------------------------------------------------
test('24b-7d parseDate accepts exactly a real YYYY-MM-DD, nothing else', () => {
  assert.deepEqual(parseDate('2026-02-28'), { ok: true, value: '2026-02-28' });
  assert.deepEqual(parseDate('2024-02-29'), { ok: true, value: '2024-02-29' });
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026/01/01', '', '2026-1-1', 'abcd-ef-gh'])
    assert.deepEqual(parseDate(bad), { ok: false }, bad);
});
test('24b-7d dayFromToday and monthGrid count in UTC days, Monday first', () => {
  const now = Date.UTC(2026, 10, 13, 23, 59);
  assert.equal(dayFromToday(0, now), '2026-11-13');
  assert.equal(dayFromToday(30, now), '2026-12-13');
  assert.equal(dayFromToday(90, now), '2027-02-11');
  const weeks = monthGrid(2026, 10); // November 2026 starts on a Sunday
  assert.equal(weeks[0]![6], '2026-11-01');
  assert.ok(weeks.every((week) => week.length === 7));
  assert.equal(weeks.flat().filter((d) => d !== null).length, 30);
});

test('24b-7d the date field validates as you type with the shared sentence, and reads "" until the date is real', (t) => {
  installFakeDom(t);
  const field = dateField({ id: 'd', label: '日期', utc: true });
  assert.equal(field.value, '');
  assert.equal(field.invalid, false);
  field.input.value = '2026-0';
  assert.equal(field.value, '');
  assert.equal(field.invalid, true);
  field.input.value = '2026-02-30';
  (field.input as unknown as FakeElement).dispatch('input');
  assert.equal(field.problem, DATE_PROBLEM);
  field.input.value = '2026-03-01';
  assert.equal(field.value, '2026-03-01');
  assert.equal(field.invalid, false);
  assert.match(field.root.textContent, /UTC/);
  field.value = '';
  assert.equal(field.input.value, '');
});

test('24b-7d the calendar opens below the field as a popover (not a dialog), picks with a click, closes with Escape', async (t) => {
  installFakeDom(t);
  const field = dateField({ label: '日期', now: () => Date.UTC(2026, 10, 13) });
  (field.input as unknown as FakeElement).click();
  const pop = one(field.root, '.admin-date-pop');
  assert.ok(pop, 'the popover is in the field');
  assert.notEqual(pop.getAttribute('role'), 'dialog');
  const day = all(pop, 'button').find((b) => b.getAttribute('data-day') === '2026-11-20')!;
  day.click();
  assert.equal(field.value, '2026-11-20');
  assert.equal(one(field.root, '.admin-date-pop'), null);
  (field.input as unknown as FakeElement).click();
  one(field.root, '.admin-date-pop').dispatch('keydown', { key: 'Escape' });
  assert.equal(one(field.root, '.admin-date-pop'), null);
  await flush();
});

// ---- the value sent is the same for the same chosen date -----------------------------------------------------------------------
function mountInvites(t: test.TestContext) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const created: { redeemBy: number | null }[] = [];
  const deps: InviteTiersDeps = {
    port: {
      inviteBatches: async () => [],
      inviteBatchDetail: async () => [],
      createInviteBatch: async (input) => {
        created.push(input as never);
        return { batchId: 'b', duplicate: false, codes: [] };
      },
      editInviteBatch: async () => {},
      revokeInviteBatch: async () => {},
      revokeTierCode: async () => {},
      revokeEntitlement: async () => {},
    },
    isOwner: () => true,
    run: async (work) => {
      try {
        await work();
      } catch {
        /* the page shows the message */
      }
    },
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'req',
    disposed: () => false,
    download: () => {},
  };
  const view = inviteTiersView(root, deps);
  return { root, view, created };
}
const submit = async (f: ReturnType<typeof mountInvites>) => {
  one(f.root, '#tiers-name').value = '批次'; // a created batch clears the form, so the name is typed again each time
  one(f.root, '#admin-tiers-create').dispatch('submit');
  await flush();
};
test('24b-7d 兑换截止: typing, the calendar and a quick pick send the same bytes for the same date', async (t) => {
  const f = mountInvites(t);
  await f.view.load();
  one(f.root, '#tiers-name').value = '批次';
  // typed
  one(f.root, '#tiers-redeem-by').value = '2099-03-04';
  await submit(f);
  // by calendar (it opens on the month of the typed date; pick the 20th)
  one(f.root, '#tiers-redeem-by').value = '2099-03-04';
  one(f.root, '#tiers-redeem-by').click();
  const pickDay = all(f.root, '.admin-date-day').find((b) => b.getAttribute('data-day') === '2099-03-20')!;
  pickDay.click();
  assert.equal(one(f.root, '#tiers-redeem-by').value, '2099-03-20');
  await submit(f);
  // by quick pick
  all(f.root, '.admin-date-pick')
    .find((b) => b.textContent === '30 天')!
    .click();
  const thirty = one(f.root, '#tiers-redeem-by').value;
  assert.equal(thirty, dayFromToday(30));
  await submit(f);
  assert.equal(f.created[0]!.redeemBy, Date.parse('2099-03-04T23:59:59.999Z'), 'typed = the old native input');
  assert.equal(f.created[1]!.redeemBy, Date.parse('2099-03-20T23:59:59.999Z'), 'calendar = the same formula');
  assert.equal(f.created[2]!.redeemBy, Date.parse(`${thirty}T23:59:59.999Z`), 'quick pick = the same formula');
  // 不限 clears it: null, as an empty native input did
  all(f.root, '.admin-date-pick')
    .find((b) => b.textContent === '不限')!
    .click();
  assert.equal(one(f.root, '#tiers-redeem-by').value, '');
  await submit(f);
  assert.equal(f.created[3]!.redeemBy, null);
  assert.deepEqual(
    all(f.root, '.admin-date-pick').map((b) => b.textContent),
    ['7 天', '30 天', '90 天', '不限'],
  );
});
test('24b-7d 兑换截止: a half-typed date is refused with the sentence, never sent as "no date"', async (t) => {
  const f = mountInvites(t);
  await f.view.load();
  one(f.root, '#tiers-name').value = '批次';
  one(f.root, '#tiers-redeem-by').value = '2099-13-45';
  await submit(f);
  assert.equal(f.created.length, 0);
  assert.equal(one(f.root, '.tiers-problem').textContent, DATE_PROBLEM);
});

// ---- error codes are never visible text ------------------------------------------------------------------------------------------
test('24b-7d an error shows its sentence; the code is on hover and behind 复制代码, never in the text', (t) => {
  installFakeDom(t);
  const line = errorLine('WEB_SYSTEM_SOURCES_UNAVAILABLE');
  const words = one(line, '.admin-error-text');
  assert.ok(ERROR_SENTENCES.WEB_SYSTEM_SOURCES_UNAVAILABLE);
  assert.ok(words.textContent.startsWith(ERROR_SENTENCES.WEB_SYSTEM_SOURCES_UNAVAILABLE!));
  assert.doesNotMatch(
    all(line, '*')
      .filter((n) => !n.className.includes('ad-tip'))
      .map((n) => (n.children.length ? '' : n.textContent))
      .join(' '),
    /WEB_SYSTEM_SOURCES_UNAVAILABLE/,
  );
  const copy = all(line, 'button')[0]!;
  assert.equal(copy.textContent, '复制代码');
  assert.equal(copy.getAttribute('data-code'), 'WEB_SYSTEM_SOURCES_UNAVAILABLE');
  assert.equal(sentenceOf('NOT_A_CODE_AT_ALL'), '失败，没有更多信息。');
  assert.equal(sentenceOf(null, '原因未知'), '原因未知');
});
test('24b-7d errorText and micros carry no code and no µ$', () => {
  assert.equal(errorText('PREVIEW_CALL_UNKNOWN'), '调用结果未知');
  assert.doesNotMatch(errorText('INVALID_TOPICS'), /INVALID_TOPICS/);
  assert.equal(errorText('SOME_NEW_CODE'), '失败');
  assert.doesNotMatch(micros(71), /µ/);
  assert.equal(micros(71), '$0.000 071');
  assert.equal(micros(null), '—');
});

// ---- prices ---------------------------------------------------------------------------------------------------------------------
test('24b-7d prices per million tokens; the stored value, in the stored unit, is on hover', (t) => {
  installFakeDom(t);
  assert.equal(priceText(1_320_000, 'token'), '$1,320,000 / 百万令牌'.replace('$1,320,000', dollarText(1_320_000)));
  assert.equal(priceText(1.32, 'token'), '$1.32 / 百万令牌');
  assert.equal(priceText(15, 'byte'), '$15 / 百万字节'.replace('$15', dollarText(15)));
  assert.equal(priceText(40_000, 'call'), '$0.04 / 次');
  assert.equal(storedPriceText(1_320_000, 'token'), '存储值：1,320,000 微美元 / 令牌');
  const cell = priceCell(1.32, 'token', '版本 v2');
  assert.equal(cell.getAttribute('data-price'), 'true');
  assert.match(cell.textContent, /存储值：1\.32 微美元 \/ 令牌 · 版本 v2/);
});

// ---- 总览: one split for the page ---------------------------------------------------------------------------------------------
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
const DAYS = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 10, 20) - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10),
  );
const NAMES = Array.from({ length: 9 }, (_, i) => `角色${i + 1}`);
const valuesOf = (n: number, k: number) => Array.from({ length: n }, (_, i) => (k + 1) * 10 + i);
const dailyChart = (metric: ChartMetric, range: ChartRange): ChartView => {
  const n = range === '24h' ? 24 : Number(range.slice(0, -1));
  const buckets =
    range === '24h' ? Array.from({ length: 24 }, (_, i) => `2026-11-20T${String(i).padStart(2, '0')}`) : DAYS(n);
  const characters = NAMES.map((name, k) => ({ name, values: valuesOf(n, 9 - k) }));
  const models = [
    { name: 'deepseek-a', values: valuesOf(n, 8) },
    { name: '', values: valuesOf(n, 2) },
  ];
  // The model series are the same replies cut another way: scale so each bucket adds up to the characters' total.
  const total = buckets.map((_, i) => characters.reduce((a, c) => a + c.values[i]!, 0));
  const first = models.map((m) => ({ ...m, values: m.values.map(() => 0) }));
  buckets.forEach((_, i) => {
    first[0]!.values[i] = Math.floor(total[i]! / 2);
    first[1]!.values[i] = total[i]! - first[0]!.values[i]!;
  });
  return {
    metric,
    range,
    bucket: range === '24h' ? 'hour' : 'day',
    since: '2026-01-01',
    buckets,
    total,
    characters,
    ...(range !== '24h' && metric === 'replies' ? { models: first } : {}),
  };
};
const stats = (range: StatsRange): PlayerStatsView => ({
  since: '2026-01-01',
  range,
  days: DAYS(range)
    .reverse()
    .map((day) => ({ day, ...counts(), d1: null, d7: null })),
  totals: { ...counts(), d1: null, d7: null },
  byCharacter: NAMES.map((name, k) => ({
    name,
    published: valuesOf(range, 9 - k).reduce((a, b) => a + b, 0),
    failed: 1,
    unknown: 0,
    voice: 0,
  })),
  byModel: [
    { model: 'deepseek-a', published: 700, failed: 2, unknown: 0, voice: 0 },
    { model: '', published: 300, failed: 1, unknown: 0, voice: 0 },
  ],
});
function mountOverview(t: test.TestContext) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const charts: [ChartMetric, ChartRange][] = [];
  const api = overviewView(root, {
    load: async () => ({
      day: '2026-11-20',
      today: { replies: 12, voiceReplies: 9, failedReplies: 1, spendMicros: 2_500_000 },
      warnings: { priceExpiring: 0, retentionFailing: 0, unknownNew: 0 },
      stats: { yesterday: { day: '2026-11-19', signups: 3, active: 50 }, monthListCostRmbFen: 1340 } as never,
    }),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
    stats: {
      load: async (range: StatsRange) => stats(range),
      exportCsv: async () => ({ csv: '', rows: 0 }),
      download: () => {},
    },
    chart: {
      load: async (metric: ChartMetric, range: ChartRange) => {
        charts.push([metric, range]);
        return dailyChart(metric, range);
      },
    },
  });
  return { root, api, charts };
}
const press = (root: unknown, group: string, label: string) =>
  all(root, `[aria-label="${group}"] button`)
    .find((b) => b.textContent === label)!
    .click();

test("24b-7e the character split: 6 largest, the rest summed into 其他, every bucket adds up to the 全部 total, in the characters' colours", () => {
  const view = dailyChart('replies', '30d');
  const split = buildSplit(view, 'character')!;
  assert.equal(split.series.length, SHOWN_SERIES + 1);
  assert.equal(split.series.at(-1)!.name, '其他');
  assert.equal(split.series.at(-1)!.color, OTHER_COLOUR);
  const rest = view.characters.slice(SHOWN_SERIES);
  split.buckets.forEach((_, i) => {
    assert.equal(
      split.series.at(-1)!.values[i],
      rest.reduce((a, c) => a + c.values[i]!, 0),
      '其他 is the sum of the rest',
    );
    assert.equal(
      split.series.reduce((a, s) => a + (s.values[i] ?? 0), 0),
      view.total[i],
      'the series add up to the total of the bucket',
    );
  });
  assert.equal(new Set(split.series.map((s) => s.color)).size, split.series.length, 'one colour per series');
});
test('24b-7e the model split uses the neutral palette (never a character colour list) and names 未选择模型', () => {
  const split = buildSplit(dailyChart('replies', '7d'), 'model')!;
  assert.deepEqual(split.series.map((s) => s.name).sort(), ['deepseek-a', '未选择模型'].sort());
  for (const s of split.series) assert.ok((MODEL_COLOURS as readonly string[]).includes(s.color));
  assert.equal(buildSplit(dailyChart('chat_users', '7d'), 'model'), null, 'no model series is ever made up');
});

test('24b-7e one switch for the page: 全部 / 按角色 / 按模型 drive the chart AND the 统计表 (which has no switch of its own)', async (t) => {
  const f = mountOverview(t);
  await f.api.load();
  assert.deepEqual(
    all(f.root, '[aria-label="分组"] button').map((b) => b.textContent),
    ['全部', '按角色', '按模型'],
  );
  assert.equal(all(f.root, '[aria-label="统计维度"]').length, 0, "the table's own switch is gone");
  assert.equal(one(f.root, '.ov-days').hidden, false);
  assert.equal(one(f.root, '.ov-by')?.hidden, true);
  const before = f.charts.length;
  press(f.root, '分组', '按角色');
  await flush();
  assert.ok(f.charts.length > before, 'the character split reads its chart data when first chosen');
  assert.equal(one(f.root, '.ov-days').hidden, true);
  const byRole = all(f.root, '.ov-by').find((n) => n.getAttribute('aria-label') === '玩家统计（按角色）')!;
  assert.equal(byRole.hidden, false);
  // the legend lists the series with their totals; the chart total (sum of the legend) = the table's 成功 total
  const legend = all(f.root, '.ovx-legend button');
  assert.equal(legend.length, SHOWN_SERIES + 1);
  const view = dailyChart('replies', '7d');
  const split = buildSplit(view, 'character')!;
  const tableTotal = stats(7).byCharacter.reduce((a, r) => a + r.published, 0);
  const chartTotal = split.series.reduce((a, s) => a + s.values.reduce<number>((x, v) => x + (v ?? 0), 0), 0);
  assert.equal(chartTotal, tableTotal, 'for this range the chart totals equal the table totals');
  // a legend entry hides and shows its series
  legend[0]!.click();
  assert.equal(all(f.root, '.ovx-legend button')[0]!.getAttribute('aria-pressed'), 'false');
  all(f.root, '.ovx-legend button')[0]!.click();
  assert.equal(all(f.root, '.ovx-legend button')[0]!.getAttribute('aria-pressed'), 'true');
  // 占比 is a column of the table
  assert.ok(all(byRole, '.ot-head .ot-cell').some((c) => c.textContent.includes('占比')));
});

test('24b-7e combinations without data are disabled, with the reason on hover; a split is never guessed', async (t) => {
  const f = mountOverview(t);
  await f.api.load();
  const tab = (group: string, label: string) =>
    all(f.root, `[aria-label="${group}"] button`).find((b) => b.textContent === label)!;
  // 活跃 has no split
  press(f.root, '指标', '活跃');
  assert.equal(tab('分组', '按角色').disabled, true);
  assert.match(tab('分组', '按角色').getAttribute('title')!, /活跃是按玩家统计/);
  assert.equal(tab('分组', '按模型').disabled, true);
  // 聊天人数 has 按角色 but not 按模型
  press(f.root, '指标', '聊天人数');
  assert.equal(tab('分组', '按角色').disabled, false);
  assert.equal(tab('分组', '按模型').disabled, true);
  assert.match(tab('分组', '按模型').getAttribute('title')!, /聊天人数是按角色统计的/);
  // 24H has no model either
  press(f.root, '指标', '回复');
  press(f.root, '时间范围', '24H');
  await flush();
  assert.equal(tab('分组', '按模型').disabled, true);
  assert.match(tab('分组', '按模型').getAttribute('title')!, /按小时/);
  assert.equal(tab('分组', '按角色').disabled, false);
  // choosing 按角色 and then 活跃... falls back to 全部 rather than showing nothing
  press(f.root, '时间范围', '7天');
  await flush();
  press(f.root, '分组', '按角色');
  await flush();
  press(f.root, '指标', '活跃');
  assert.equal(
    all(f.root, '[aria-label="分组"] button').find((b) => b.getAttribute('aria-pressed') === 'true')!.textContent,
    '全部',
  );
  // the 统计表 went back to the days with the switch (regression: it used to stay on 按角色)
  assert.equal(one(f.root, '.ov-days').hidden, false);
  assert.equal(all(f.root, '.ov-by').every((n) => n.hidden), true);
});
