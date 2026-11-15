import assert from 'node:assert/strict';
import test from 'node:test';
import { CHART_RANGES } from '../../../packages/contracts/web-stats.ts';
import { parseChart, readChart } from '../../../apps/server/admin/web-stats-admin.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { DAY, T0, tiersFixture } from '../fixtures/invite-tiers.ts';

registerSqlTextLoader();

/**
 * Part 24b-7e: the 总览 chart read answers 30d and 90d too, and, for replies on a daily range, one series per chosen text model next to the
 * one per character. Read-only, the same permission (stats.read, through the same route), no table, no migration; names only.
 */
const X = 'fixture-character',
  Y = 'fixture-character-2';
const day = (at: number) => new Date(at).toISOString().slice(0, 10);

test('the chart ranges are 24h / 7d / 14d / 30d / 90d; the route parses the new ones and nothing else', () => {
  assert.deepEqual([...CHART_RANGES], ['24h', '7d', '14d', '30d', '90d']);
  assert.deepEqual(parseChart({ metric: 'replies', range: '90d' }), { metric: 'replies', range: '90d' });
  assert.throws(() => parseChart({ metric: 'replies', range: '60d' }), /INVALID_REQUEST/);
});

test('replies by model: one series per chosen model, adding up to the characters and to the total, every daily range', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  f.addCharacter(Y);
  const put = (daySlug: string, character: string, model: string, value: number) =>
    f.store.run(
      `INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?,?,?,?,?)
      ON CONFLICT(day,metric,character_id,model) DO UPDATE SET value=value+excluded.value`,
      daySlug,
      'reply_published',
      character,
      model,
      value,
    );
  const today = day(T0),
    older = day(T0 - 20 * DAY),
    oldest = day(T0 - 80 * DAY);
  // the counters started 85 days ago, so every day in range is known
  f.store.run("UPDATE web_stats_daily SET day=? WHERE metric='extras_started'", day(T0 - 85 * DAY));
  put(today, X, 'deepseek-v4', 5);
  put(today, X, '', 2); // model choice was off
  put(today, Y, 'deepseek-v4', 3);
  put(older, X, 'grok-4', 7);
  put(oldest, Y, 'grok-4', 11);

  for (const [range, days] of [
    ['7d', 7],
    ['14d', 14],
    ['30d', 30],
    ['90d', 90],
  ] as const) {
    const chart = readChart(f.store, T0, 'replies', range);
    assert.equal(chart.buckets.length, days, range);
    assert.ok(chart.models, `${range} carries the model series`);
    const sum = (series: { values: (number | null)[] }[], i: number) =>
      series.reduce((a, s) => a + (s.values[i] ?? 0), 0);
    chart.buckets.forEach((_, i) => {
      // a day before the counters ran reads — (null) in the total and in every series
      assert.equal(sum(chart.models!, i), chart.total[i] ?? 0, `${range} bucket ${i}: models add up to the total`);
      assert.equal(
        sum(chart.characters, i),
        chart.total[i] ?? 0,
        `${range} bucket ${i}: characters add up to the total`,
      );
      if (chart.total[i] === null) assert.ok(chart.models!.every((m) => m.values[i] === null));
    });
  }
  const month = readChart(f.store, T0, 'replies', '30d');
  const at = (name: string) => month.models!.find((m) => m.name === name)!.values[month.buckets.indexOf(today)];
  assert.equal(at('deepseek-v4'), 8);
  assert.equal(at(''), 2, "'' is the replies admitted while model choice was off (the page says 未选择模型)");
  assert.equal(month.models!.find((m) => m.name === 'grok-4')!.values[month.buckets.indexOf(older)], 7);
  assert.ok(!month.buckets.includes(oldest), 'the 80-day-old day is outside 30d');
  const quarter = readChart(f.store, T0, 'replies', '90d');
  assert.equal(quarter.models!.find((m) => m.name === 'grok-4')!.values[quarter.buckets.indexOf(oldest)], 11);
  // names only: nothing in the answer looks like an id of a player or of a character
  assert.doesNotMatch(JSON.stringify(quarter), new RegExp(`${X}|${Y}|principal`));
  // largest first
  assert.deepEqual(
    quarter.models!.map((m) => m.name),
    ['grok-4', 'deepseek-v4', ''],
  );
});

test('chat users and 24h carry no model series: nothing is made up', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  assert.equal(readChart(f.store, T0, 'chat_users', '30d').models, undefined);
  assert.equal(readChart(f.store, T0, 'chat_users', '90d').bucket, 'day');
  assert.equal(readChart(f.store, T0, 'replies', '24h').models, undefined);
});
