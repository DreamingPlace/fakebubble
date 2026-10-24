import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import {
  migrateWebProviderInviteCodes,
  migrateWebProviderInviteTiers,
  migrateWebProviderLegacyInvites,
  migrateWebProviderModelSettings,
  migrateWebProviderCast,
  migrateWebProviderStatsExtras,
  migrateWebProviderStats,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { readChart, readCosts, readSpend } from '../../../apps/server/admin/web-stats-admin.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { DAY, T0, tiersFixture, STATS_SEAL_KEY } from '../fixtures/invite-tiers.ts';
import { modelFixture, NOW, type FetchCall } from '../fixtures/model-choice.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const HOUR = 3_600_000;
const DRAFT = 'submit_dialogue_draft';
const utc = (at: number) => new Date(at).toISOString().slice(0, 10);
const sql130 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/130_stats_extras.sql', import.meta.url), 'utf8');
const answer =
  () =>
  (call: FetchCall, _n: number, request: Parameters<typeof draftEnvelope>[0]) =>
    Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));
/** modelFixture is a schema-123 store; the steps after it are what a deployment applied one by one, 128, 129 and 130 last. */
const up130 = (store: Parameters<typeof migrateWebProviderStats>[0], now = NOW) => {
  migrateWebProviderModelSettings(store);
  migrateWebProviderInviteTiers(store);
  migrateWebProviderLegacyInvites(store);
  migrateWebProviderInviteCodes(store);
  migrateWebProviderStats(store, now);
  migrateWebProviderCast(store);
  migrateWebProviderStatsExtras(store, now);
};
const last = <T>(values: T[]) => values[values.length - 1]!;
const X = 'fixture-character',
  Y = 'fixture-character-2';

test('130 is its own step: same SQL on both authorities, 55 steps, 1-129 unchanged, the Node step stamps the start day', (t) => {
  const { inline, r2 } = expectedWebMigrations();
  assert.equal(inline.length, 55);
  assert.equal(r2.length, 55);
  assert.equal(inline.at(-1)!.version, 130);
  assert.equal(inline.at(-1)!.sha256, createHash('sha256').update(sql130()).digest('hex'));
  assert.deepEqual(r2.at(-1), inline.at(-1), '130 is the same SQL on both authorities');
  assert.deepEqual(
    inline.map((m) => m.version),
    [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 31 }, (_, i) => 100 + i)].slice(0, 55),
  );
  // 1-129 are byte for byte what Part 24a deployed (the pins of 126-129 are the ones the earlier Parts recorded).
  for (const [version, sha] of [
    [129, '061602aea27da734c9c279dfea8de748520f3d45b0afcfeba1ea6333ce992148'],
    [128, '44271b05dc49d7f26d59a1f5537249707d8d66863bd4080d7146ea3b8f25364f'],
    [127, '3cc1d4c03ebbdf90f02ce751341a7aa175804c35799dfe34b29034dd1ae54ecf'],
    [126, '68526f0cfc26957124a4a2f7ea9bcc600cc11c6ba0fcb3702b866aba67efec4e'],
  ] as const)
    assert.equal(inline.find((m) => m.version === version)!.sha256, sha, String(version));

  const f = tiersFixture(t, { stats: true, extras: true });
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 130);
  assert.equal(f.store.get('PRAGMA foreign_key_check'), undefined);
  assert.deepEqual(
    f.store
      .all<{ day: string; metric: string }>("SELECT day,metric FROM web_stats_daily WHERE metric LIKE '%started' ORDER BY metric")
      .map((r) => [r.day, r.metric]),
    [
      [utc(T0), 'extras_started'],
      [utc(T0), 'stats_started'],
    ],
  );
  assert.throws(() => migrateWebProviderStatsExtras(f.store, T0), /WEB_PROVIDER_STATS_EXTRAS_MIGRATION_REQUIRED/);
});

test('chat users per character: a player chatting with two characters counts once for each and once in the total; the day closes into web_stats_daily', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  f.addCharacter(Y);
  const a = f.player('a', { signedUp: true }),
    b = f.player('b', { signedUp: true }),
    g = f.player('g');
  for (const [who, character, id] of [
    [a, X, 'a1'],
    [a, Y, 'a2'],
    [a, X, 'a3'], // the same player again: still one
    [b, X, 'b1'],
  ] as const) f.finish(f.admit(who.principalId, id, 'a', character).operationId, 'published');
  f.finish(f.admit(g.principalId, 'g1', 'b', Y).operationId, 'published');

  const key = Buffer.from(hkdfSync('sha256', STATS_SEAL_KEY, Buffer.alloc(0), 'stats-active-v1', 32));
  const chatMarker = (period: string, character: string, principalId: string) =>
    createHmac('sha256', key).update('chat\0').update(period).update('\0').update(character).update('\0').update(principalId).digest('hex');
  const day = utc(T0);
  assert.deepEqual(
    f.store
      .all<{ character_id: string; marker: string }>('SELECT character_id,marker FROM web_chat_active')
      .map((r) => `${r.character_id}|${r.marker}`)
      .sort(),
    [
      [X, chatMarker(day, X, a.principalId)],
      [X, chatMarker(day, X, b.principalId)],
      [Y, chatMarker(day, Y, a.principalId)],
      [Y, chatMarker(day, Y, g.principalId)],
    ]
      .map(([c, m]) => `${c}|${m}`)
      .sort(),
  );
  // Today is read from the markers: X 2 (a, b), Y 2 (a, guest g); the total counts a once: 3 players.
  const today = readChart(f.store, T0, 'chat_users', '7d');
  assert.equal(last(today.total), 3);
  assert.deepEqual(
    today.characters.map((c) => last(c.values)).sort(),
    [2, 2],
  );
  assert.equal(today.bucket, 'day');
  assert.equal(today.buckets.length, 7);
  assert.equal(last(today.buckets), day);
  // The total is the distinct count of 22c's chat markers too (registered 2 + guest 1).
  assert.equal(f.store.get<{ n: number }>("SELECT count(*) n FROM web_daily_active WHERE scope='chat'")!.n, 3);

  // Nothing is written into web_stats_daily until the day is over.
  assert.equal(f.store.get("SELECT 1 FROM web_stats_daily WHERE metric='chat_users'"), undefined);
  // The next day: a chats with Y again (a new day, a new marker) and the alarm closes yesterday.
  f.advance(DAY);
  f.finish(f.admit(a.principalId, 'a4', 'a', Y).operationId, 'published');
  f.stats!.maintain(f.clock());
  assert.deepEqual(
    f.store.all<{ day: string; character_id: string; value: number }>("SELECT day,character_id,value FROM web_stats_daily WHERE metric='chat_users' ORDER BY character_id").map((r) => `${r.day}|${r.character_id}|${r.value}`),
    [`${day}|${X}|2`, `${day}|${Y}|2`],
  );
  const closed = readChart(f.store, f.clock(), 'chat_users', '7d');
  assert.deepEqual([closed.total.at(-2), last(closed.total)], [3, 1], 'yesterday written down, today from the markers');
  // Written once: another close the same day or later changes nothing.
  f.stats!.maintain(f.clock() + HOUR);
  assert.equal(f.store.all("SELECT 1 FROM web_stats_daily WHERE metric='chat_users'").length, 2);
  // The markers go after 35 days; the written-down counts stay and the chart still reads them.
  f.stats!.maintain(T0 + 36 * DAY);
  assert.equal(f.store.get('SELECT 1 FROM web_chat_active WHERE day=?', day), undefined, 'day 0 pruned');
  assert.equal(f.store.all('SELECT 1 FROM web_chat_active').length, 1, 'a marker of day X is kept through X + 35');
  const later = readChart(f.store, T0 + 36 * DAY, 'chat_users', '14d');
  assert.equal(later.buckets.includes(day), false, 'the chart window moved on');
  assert.equal(f.store.get<{ n: number }>("SELECT sum(value) n FROM web_stats_daily WHERE metric='chat_users' AND day=?", day)!.n, 4);
});

test('hourly rows: replies by the admission hour, chat users in total and per character; 48 hours, pruned on the sweep; the sum of a day is its daily row', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  f.addCharacter(Y);
  const a = f.player('a', { signedUp: true }),
    b = f.player('b', { signedUp: true });
  // 08:00 UTC: a replies from X and Y, b from X. 10:00: a again from X, whose reply fails.
  for (const [who, character, id] of [
    [a, X, 'a1'],
    [a, Y, 'a2'],
    [b, X, 'b1'],
  ] as const) f.finish(f.admit(who.principalId, id, 'a', character).operationId, 'published');
  f.advance(2 * HOUR);
  f.finish(f.admit(a.principalId, 'a3', 'a', X).operationId, 'failed');
  f.finish(f.admit(b.principalId, 'b2', 'a', X).operationId, 'published');
  const hours = (metric: string) =>
    f.store
      .all<{ hour: string; character_id: string; value: number }>(
        'SELECT hour,character_id,value FROM web_stats_hourly WHERE metric=? ORDER BY hour,character_id',
        metric,
      )
      .map((r) => `${r.hour}|${r.character_id}|${r.value}`);
  const h8 = new Date(T0).toISOString().slice(0, 13),
    h10 = new Date(T0 + 2 * HOUR).toISOString().slice(0, 13);
  assert.deepEqual(hours('reply_published'), [`${h8}|${X}|2`, `${h8}|${Y}|1`, `${h10}|${X}|1`]);
  assert.deepEqual(hours('reply_failed'), [`${h10}|${X}|1`]);
  assert.deepEqual(hours('chat_users'), [
    `${h8}||2`,
    `${h8}|${X}|2`,
    `${h8}|${Y}|1`,
    `${h10}||2`,
    `${h10}|${X}|2`,
  ]);
  // A replay of a final row adds nothing (the same once-only condition as the daily counters).
  f.store.run("UPDATE web_operations SET status='published',stage_version=stage_version+1 WHERE status='published'");
  assert.equal(hours('reply_published').length, 3);
  assert.deepEqual(hours('reply_published').map((l) => l.split('|')[2]), ['2', '1', '1']);
  // The 24 hours of the day add up to the day's daily row, per character.
  assert.deepEqual(
    f.store
      .all<{ character_id: string; n: number }>(
        "SELECT character_id,sum(value) n FROM web_stats_daily WHERE metric='reply_published' GROUP BY character_id ORDER BY character_id",
      )
      .map((r) => `${r.character_id}|${r.n}`),
    [`${X}|3`, `${Y}|1`],
  );

  // The 24H chart: 24 buckets, the current hour last, the characters named, null before the counters ran.
  const chart = readChart(f.store, T0 + 3 * HOUR, 'replies', '24h');
  assert.equal(chart.bucket, 'hour');
  assert.equal(chart.buckets.length, 24);
  assert.equal(last(chart.buckets), new Date(T0 + 3 * HOUR).toISOString().slice(0, 13));
  assert.equal(chart.total[chart.buckets.indexOf(h8)], 3);
  assert.equal(chart.total[chart.buckets.indexOf(h10)], 1);
  assert.equal(chart.total.at(-1), 0);
  assert.equal(chart.total[0], null, 'hours of the day before the counters started read —');
  const users = readChart(f.store, T0 + 3 * HOUR, 'chat_users', '24h');
  assert.equal(users.total[users.buckets.indexOf(h8)], 2, 'a is in two characters, counted once in the total');
  assert.deepEqual(users.characters.map((c) => c.values[users.buckets.indexOf(h8)]).sort(), [1, 2]);

  // 48 hours: a row is kept while its hour is within 48 hours, pruned on the first sweep after.
  f.stats!.maintain(T0 + 47 * HOUR);
  assert.equal(hours('reply_published').length, 3);
  f.stats!.maintain(T0 + 50 * HOUR); // the 08:00 rows are 50 hours old, the 10:00 ones 48
  assert.deepEqual(hours('reply_published'), [`${h10}|${X}|1`]);
  assert.equal(f.store.all('SELECT 1 FROM web_chat_active_hourly').length, 4, 'its markers go with the rows (a, b: X and the total)');
  f.stats!.maintain(T0 + 51 * HOUR);
  assert.deepEqual(hours('reply_published'), []);
  assert.deepEqual(hours('chat_users'), []);
  assert.equal(f.store.get('SELECT 1 FROM web_chat_active_hourly'), undefined);
});

test('the alarm can go idle: chat markers and hourly rows never ask for a wake, a signup cohort does until it closes', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  const g = f.player('g');
  f.finish(f.admit(g.principalId, 'g1').operationId, 'published');
  assert.ok(f.store.get('SELECT 1 FROM web_chat_active') && f.store.get('SELECT 1 FROM web_stats_hourly'));
  assert.equal(f.stats!.nextDue(f.clock()), null, 'markers and hourly rows alone: no wake');
  // A signup opens a cohort: the alarm wants the next UTC midnight ...
  const r = f.player('r', { signedUp: true });
  assert.ok(f.stats!.nextDue(f.clock()) !== null);
  f.finish(f.admit(r.principalId, 'r1').operationId, 'published');
  // ... and once D1 and D7 are closed it is idle again, with markers and hourly rows still there to prune.
  f.advance(9 * DAY);
  f.stats!.maintain(f.clock());
  assert.equal(f.stats!.nextDue(f.clock()), null, 'closed: idle');
  f.advance(40 * DAY);
  f.stats!.maintain(f.clock());
  assert.equal(f.stats!.nextDue(f.clock()), null);
  assert.equal(f.store.get('SELECT 1 FROM web_chat_active'), undefined);
  assert.equal(f.store.get('SELECT 1 FROM web_stats_hourly'), undefined);
});

test('user type: first match wins (test, unlimited, daily refill, registered, guest), frozen at admission', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  const typeOf = (operationId: string) =>
    f.store.get<{ user_type: string }>('SELECT user_type FROM web_operation_user_types WHERE operation_id=?', operationId)
      ?.user_type;
  const guest = f.player('guest');
  assert.equal(typeOf(f.admit(guest.principalId, 'g1').operationId), 'guest');
  const reg = f.player('reg', { signedUp: true });
  const first = f.admit(reg.principalId, 'r1').operationId;
  assert.equal(typeOf(first), 'registered');
  f.finish(first, 'published');

  // 每天补充 and 不限量 holders (a normal batch).
  const refill = f.player('refill', { signedUp: true }),
    unlimited = f.player('unlimited', { signedUp: true });
  f.redeem(refill, f.create(f.owner, { count: 1 }).codes![0]!);
  assert.equal(typeOf(f.admit(refill.principalId, 'f1').operationId), 'daily_refill');
  f.redeem(unlimited, f.create(f.owner, { count: 1, tier: { kind: 'unlimited' } }).codes![0]!);
  assert.equal(typeOf(f.admit(unlimited.principalId, 'u1').operationId), 'unlimited');

  // An unlimited points policy is 不限量 too.
  const policy = f.player('policy', { signedUp: true });
  f.store.run("UPDATE web_points_policy SET kind='unlimited' WHERE principal_id=?", policy.principalId);
  assert.equal(typeOf(f.admit(policy.principalId, 'p1').operationId), 'unlimited');

  // 测试组 beats everything: a test batch of either tier, and a player who ALSO holds an unlimited entitlement.
  const tester = f.player('tester', { signedUp: true }),
    both = f.player('both', { signedUp: true });
  f.redeem(tester, f.create(f.owner, { count: 1, test: true }).codes![0]!);
  assert.equal(typeOf(f.admit(tester.principalId, 't1').operationId), 'test');
  f.redeem(both, f.create(f.owner, { count: 1, tier: { kind: 'unlimited' } }).codes![0]!);
  f.redeem(both, f.create(f.owner, { count: 1, tier: { kind: 'unlimited' }, test: true }).codes![0]!);
  assert.equal(typeOf(f.admit(both.principalId, 'b1').operationId), 'test');

  // Frozen: the registered player's old reply stays registered after it becomes a holder, the next one is the new type.
  f.redeem(reg, f.create(f.owner, { count: 1, tier: { kind: 'unlimited' } }).codes![0]!);
  assert.equal(typeOf(first), 'registered', 'a later tier change does not move an old reply');
  assert.equal(typeOf(f.admit(reg.principalId, 'r2').operationId), 'unlimited');
  // A replay of an admission freezes nothing new.
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_operation_user_types')!.n;
  f.admit(reg.principalId, 'r2');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operation_user_types')!.n, before);
  // 管理员 is not a type: the schema cannot hold one.
  assert.throws(
    () =>
      f.store.run("INSERT INTO web_operation_user_types(operation_id,user_type,created_at) VALUES (?,'admin',0)", first),
    /CHECK|UNIQUE|constraint/i,
  );
});

test('the test flag is set at creation only: default off, existing batches are not test, a changed replay conflicts, an update is refused', (t) => {
  const f = tiersFixture(t, { stats: true });
  const old = f.create(f.owner, { name: 'before 130' }); // created on schema 128
  migrateWebProviderCast(f.store);
  migrateWebProviderStatsExtras(f.store, T0);
  const flag = (id: string) => f.store.get<{ test: number }>('SELECT test FROM web_invite_batches WHERE id=?', id)!.test;
  assert.equal(flag(old.batchId), 0, 'a batch that exists before 130 is not a test batch');
  const normal = f.create(f.owner, { name: 'normal' });
  const marked = f.create(f.owner, { name: 'marked', test: true });
  assert.deepEqual([flag(normal.batchId), flag(marked.batchId)], [0, 1]);
  assert.deepEqual(
    f.tiers.listBatches(f.sessionIdOf(f.owner)).batches.map((b) => [b.name, b.test]).sort(),
    [
      ['before 130', false],
      ['marked', true],
      ['normal', false],
    ],
  );
  for (const to of [0, 1])
    assert.throws(
      () => f.store.run('UPDATE web_invite_batches SET test=? WHERE id=?', to, to === 0 ? marked.batchId : normal.batchId),
      /WEB_INVITE_BATCH_TEST_IMMUTABLE/,
    );
  assert.equal(flag(marked.batchId), 1);
  // The creation request is idempotent with the flag in it: the same request with another value is a conflict, the same one a replay.
  const again = { requestId: 'request-test-flag', name: 'flagged', count: 1, tier: { kind: 'unlimited' as const } };
  f.create(f.owner, { ...again, test: true });
  assert.equal(f.create(f.owner, { ...again, test: true }).duplicate, true);
  assert.throws(() => f.create(f.owner, { ...again }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.create(f.owner, { ...again, requestId: 'request-bad', test: 'yes' as never }), /WEB_INVITE_TERMS_REQUIRED/);
});

const spendFixture = async (t: test.TestContext) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
  up130(f.store);
  // What admission wrote for this operation (the fixture inserts the operation itself).
  f.store.run("INSERT INTO web_operation_user_types(operation_id,user_type,created_at) VALUES ('operation','registered',?)", NOW);
  await f.runText();
  await f.finishReply('operation');
  return f;
};

test('spend by user type: the ledger amount of every call lands in its user type and text / voice, and adds up to 22c\'s ledger column', async (t) => {
  const f = await spendFixture(t);
  const spend = f.all<{ day: string; user_type: string; kind: string; calls: number; charged_micros: number }>(
    'SELECT day,user_type,kind,calls,charged_micros FROM web_stats_spend ORDER BY kind',
  );
  assert.deepEqual(spend.map((r) => [r.day, r.user_type, r.kind]), [
    [utc(NOW), 'registered', 'text'],
    [utc(NOW), 'registered', 'voice'],
  ]);
  const usage = (phases: string) =>
    f.get<{ n: number; c: number }>(
      `SELECT sum(ledger_charged_micros) n,sum(calls) c FROM web_provider_usage WHERE phase IN (${phases})`,
    )!;
  assert.equal(spend[0]!.charged_micros, usage("'draft','review'").n, 'text = draft + review');
  assert.equal(spend[0]!.calls, usage("'draft','review'").c);
  assert.equal(spend[1]!.charged_micros, usage("'speech'").n, 'voice = speech');
  assert.ok(spend[0]!.charged_micros > 0 && spend[1]!.charged_micros > 0);
  assert.equal(
    spend[0]!.charged_micros + spend[1]!.charged_micros,
    f.get<{ n: number }>('SELECT sum(charged_micros) n FROM web_provider_attempts')!.n,
    'the same amounts the budget ledger charged',
  );

  const view = readSpend(f.store, NOW + HOUR, 7);
  assert.equal(view.usdCny, 6.7);
  assert.equal(view.since, utc(NOW));
  assert.equal(view.days.length, 7);
  const today = view.days[0]!;
  assert.equal(today.day, utc(NOW));
  assert.deepEqual(
    today.types!.map((r) => r.userType),
    ['test', 'unlimited', 'daily_refill', 'registered', 'guest'],
    'priority order',
  );
  assert.deepEqual(today.types!.find((r) => r.userType === 'registered'), {
    userType: 'registered',
    textMicros: spend[0]!.charged_micros,
    voiceMicros: spend[1]!.charged_micros,
  });
  assert.equal(today.types!.filter((r) => r.userType !== 'registered').every((r) => r.textMicros + r.voiceMicros === 0), true);
  assert.equal(today.totalMicros, spend[0]!.charged_micros + spend[1]!.charged_micros);
  // Days before the counters started show —, as in 22c; the totals only add the known days.
  assert.equal(view.days[1]!.types, null);
  assert.equal(view.days[1]!.totalMicros, null);
  assert.equal(view.totals!.find((r) => r.userType === 'registered')!.textMicros, spend[0]!.charged_micros);
  // 22c's own table agrees with the split.
  assert.equal(
    readCosts(f.store, NOW + HOUR, 7).rows.reduce((sum, r) => sum + (r.ledgerChargedMicros ?? 0), 0),
    today.totalMicros,
  );
});

test('spend by user type: a call of an operation with no frozen type (admitted before 130) is unclassified, never guessed', async (t) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
  up130(f.store);
  await f.runText();
  await f.finishReply('operation');
  assert.deepEqual(
    f.all<{ user_type: string }>('SELECT DISTINCT user_type FROM web_stats_spend').map((r) => r.user_type),
    ['unknown'],
  );
  const day = readSpend(f.store, NOW, 7).days[0]!;
  assert.ok(day.unclassifiedMicros! > 0);
  assert.equal(day.totalMicros, day.unclassifiedMicros);
  assert.equal(day.types!.every((r) => r.textMicros + r.voiceMicros === 0), true);
});

test('permission gating: chart and spend-by-type need stats.read (the owner always), checked before the body; no id leaves', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  installWebAdminActions(f.store);
  const live = { now: () => f.clock() };
  const admin = new WebSystemAdmin(f.store, live, f.accounts, {
    ops: undefined,
    security: new WebSecurityCounters(f.store, live),
    emailKey: Buffer.alloc(32, 7),
  });
  const p = f.player('p', { signedUp: true });
  f.finish(f.admit(p.principalId, 'p1').operationId, 'published');
  const body = { metric: 'replies', range: '24h' };
  for (const who of [f.member(['system.read']), f.member(['points.grant']), f.member([])]) {
    // A malformed body is not even looked at: the permission answers first.
    for (const input of [body, null, { nonsense: true }]) {
      assert.throws(() => admin.chart(who, input), /ADMIN_PERMISSION_REQUIRED/);
      assert.throws(() => admin.spendByType(who, input), /ADMIN_PERMISSION_REQUIRED/);
    }
  }
  const staff = f.member(['stats.read']);
  for (const who of [f.owner, staff]) {
    for (const [metric, range] of [
      ['replies', '24h'],
      ['replies', '7d'],
      ['chat_users', '14d'],
    ] as const)
      assert.equal(admin.chart(who, { metric, range }).metric, metric);
    assert.equal(admin.spendByType(who, { range: 30 }).range, 30);
  }
  for (const bad of [
    { metric: 'points', range: '24h' },
    { metric: 'replies', range: '30d' },
    { metric: 'replies' },
    { metric: 'replies', range: '7d', extra: 1 },
  ])
    assert.throws(() => admin.chart(staff, bad), /INVALID_REQUEST/);
  assert.throws(() => admin.spendByType(staff, { range: 5 }), /INVALID_REQUEST/);
  assert.throws(() => admin.spendByType(staff, {}), /INVALID_REQUEST/);
  // Counts only: nothing the answers carry is an id, a marker, an email or an IP hash.
  const text = JSON.stringify([
    admin.chart(f.owner, { metric: 'chat_users', range: '24h' }),
    admin.chart(f.owner, { metric: 'replies', range: '7d' }),
    admin.spendByType(f.owner, { range: 7 }),
  ]);
  for (const secret of [p.principalId, p.playerId, p.worldId, 'p@example.com', 'a'.repeat(64), X])
    assert.equal(text.includes(secret), false, secret);
  assert.doesNotMatch(text, /marker|principal|email|ipHash/i);
});

test('privacy: no column of a new table holds an id, an email or a hash of one; the markers are the only 64-hex values', (t) => {
  const f = tiersFixture(t, { stats: true, extras: true });
  const p = f.player('p', { signedUp: true });
  f.finish(f.admit(p.principalId, 'p1').operationId, 'published');
  const dump = JSON.stringify(
    ['web_chat_active', 'web_chat_active_hourly', 'web_stats_hourly', 'web_stats_spend', 'web_operation_user_types'].map((table) =>
      f.store.all(`SELECT * FROM ${table}`),
    ),
  );
  for (const secret of [p.principalId, p.playerId, p.worldId, 'p@example.com', 'a'.repeat(64)])
    assert.equal(dump.includes(secret), false, secret);
  for (const file of ['apps/server/stats/web-stats.ts', 'apps/server/stats/web-user-type.ts', 'apps/server/admin/web-stats-admin.ts'])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.|logger|report\(/, `${file} writes no log line`);
  // The only reads of the marker tables count them.
  const admin = readFileSync('apps/server/admin/web-stats-admin.ts', 'utf8');
  for (const [, query] of admin.matchAll(/'(SELECT [^']*FROM web_chat_active[^']*)'/g)) assert.match(query!, /count\(\*\)/, query);
});
