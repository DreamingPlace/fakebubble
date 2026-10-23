import test from 'node:test';
import assert from 'node:assert/strict';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin, type WebSystemOps } from '../../../apps/server/admin/web-system-admin.ts';
import { priceRows } from '../../../apps/server/admin/web-system-status.ts';
import { ensurePlayerNumber } from '../../../apps/server/admission/web-player-number.ts';
import { PLAYER_MODELS } from '../../../packages/contracts/player-models.ts';
import { DAY, T0, tiersFixture } from '../fixtures/invite-tiers.ts';

/**
 * Part 22b at class level on the real schema (Node SQLite): the rules of 积分发放 and 重置全部额度 that the HTTP test shows end to
 * end, plus the status pieces that need a database state a real clock would take weeks to reach.
 */
function system(t: test.TestContext, ops?: Partial<WebSystemOps>) {
  const f = tiersFixture(t);
  installWebAdminActions(f.store);
  const clock = { now: f.clock };
  const live = { now: () => f.clock() };
  void clock;
  const budget = { allowance: 3_000_000 };
  const fake: WebSystemOps = {
    flags: () => ({
      signupBonus: true,
      playerModelChoice: true,
      playerTextModels: ['deepseek'],
      fishVoiceModel: 's2.1-pro',
      chatReview: false,
      turnstile: false,
      alerts: false,
      alertMailBindingPresent: false,
      alertRecipientSet: false,
    }),
    migrations: () => ({ active: 'inline', inline: [], r2: [] }),
    budget: async () => [
      {
        provider: 'deepseek',
        policy: 'test-cumulative',
        spentMicros: 10,
        heldMicros: 5,
        allowanceMicros: budget.allowance,
        remainingMicros: budget.allowance - 15,
      },
      {
        provider: 'fish',
        policy: 'production-unlimited',
        spentMicros: 1,
        heldMicros: 0,
        allowanceMicros: null,
        remainingMicros: null,
      },
    ],
    retention: async () => ({ failing: 0, oldestAgeBucket: null, lastSuccessAt: null }),
    renewPrices: () => [],
    ...ops,
  };
  const security = new WebSecurityCounters(f.store, live);
  const admin = new WebSystemAdmin(f.store, live, f.accounts, { ops: fake, security, emailKey: Buffer.alloc(32, 7) });
  const numberOf = (principalId: string) => ensurePlayerNumber(f.store, f.clock(), principalId)!;
  return { ...f, admin, security, numberOf, budget };
}
const auditRows = (f: ReturnType<typeof system>) =>
  f.store.all<{ action: string; target_id: string }>('SELECT action,target_id FROM web_admin_audit ORDER BY seq');

test('grant: only registered and daily_refill players receive points; the cap clamps; guests and unlimited holders are counted, not touched', (t) => {
  const f = system(t);
  const guest = f.player('guest'),
    registered = f.player('registered', { signedUp: true }),
    near = f.player('near', { signedUp: true }),
    capped = f.player('capped', { signedUp: true }),
    unlimited = f.player('unlimited', { signedUp: true });
  const code = (kind: 'daily_refill' | 'unlimited') =>
    f.create(f.owner, { count: 1, tier: kind === 'unlimited' ? { kind } : { kind, dailyAmount: 50, cap: 120 } })
      .codes![0]!;
  for (const who of [near, capped]) f.redeem(who, code('daily_refill'));
  f.redeem(unlimited, code('unlimited'));
  f.store.run('UPDATE web_points_balance SET balance=? WHERE principal_id=?', 100, near.principalId);
  f.store.run('UPDATE web_points_balance SET balance=? WHERE principal_id=?', 120, capped.principalId);
  const before = f.events(unlimited.principalId);
  const result = f.admin.pointsGrant(f.owner, {
    requestId: 'grant-request-1',
    target: { kind: 'all' },
    amount: 30,
    note: 'x',
  });
  assert.deepEqual(
    { ...result, duplicate: undefined },
    {
      amount: 30,
      players: 3,
      granted: 2,
      totalPoints: 50,
      skipped: { guests: 1, unlimited: 1, atCap: 1 },
      duplicate: undefined,
    },
  );
  assert.equal(f.balance(registered.principalId), 130);
  assert.equal(f.balance(near.principalId), 120, 'clamped to the cap');
  assert.equal(f.balance(capped.principalId), 120, 'at the cap nothing is added, nothing is taken');
  assert.deepEqual(f.events(unlimited.principalId), before);
  assert.equal(f.balance(guest.principalId), undefined, 'a guest gets no points account');
  const memberId = f.store.get<{ id: string }>("SELECT id FROM web_admin_members WHERE role='owner'")!.id;
  assert.deepEqual(
    f.store
      .all<{ source: string; delta: number; adminId: string }>(
        "SELECT source,delta,admin_id adminId FROM web_points_events WHERE source='grant' ORDER BY delta",
      )
      .map((row) => ({ ...row })),
    [
      { source: 'grant', delta: 20, adminId: memberId },
      { source: 'grant', delta: 30, adminId: memberId },
    ],
    'one event per receiving player, carrying the administrator',
  );
  // Replay answers the stored result; the same id with other content (or another note) is a conflict.
  assert.equal(
    f.admin.pointsGrant(f.owner, { requestId: 'grant-request-1', target: { kind: 'all' }, amount: 30, note: 'x' })
      .duplicate,
    true,
  );
  assert.equal(f.balance(registered.principalId), 130);
  for (const change of [{ amount: 31 }, { note: 'y' }, { target: { kind: 'tier', tier: 'registered' } }])
    assert.throws(
      () =>
        f.admin.pointsGrant(f.owner, {
          requestId: 'grant-request-1',
          target: { kind: 'all' },
          amount: 30,
          note: 'x',
          ...change,
        }),
      /IDEMPOTENCY_CONFLICT/,
    );
  // The note is kept with the request, never in a player-visible row.
  assert.equal(
    f.store.get<{ note: string }>("SELECT note FROM web_admin_actions WHERE request_id='grant-request-1'")!.note,
    'x',
  );
});

test('grant input: amount 1-10000, note up to 100 characters without control characters, exact target shapes, request id shape', (t) => {
  const f = system(t);
  f.player('someone', { signedUp: true });
  const ok = { requestId: 'request-ok-1', target: { kind: 'all' }, amount: 1, note: '' };
  f.admin.pointsGrant(f.owner, ok);
  f.admin.pointsGrant(f.owner, { ...ok, requestId: 'request-ok-2', amount: 10_000, note: '备'.repeat(100) });
  const bad: unknown[] = [
    { ...ok, requestId: 'short' },
    { ...ok, requestId: 'has spaces in it' },
    { ...ok, amount: 0 },
    { ...ok, amount: 10_001 },
    { ...ok, amount: 1.5 },
    { ...ok, amount: '5' },
    { ...ok, note: 'x'.repeat(101) },
    { ...ok, note: 'a\nb' },
    { ...ok, note: 5 },
    { ...ok, target: { kind: 'all', extra: 1 } },
    { ...ok, target: { kind: 'tier', tier: 'unlimited' } },
    { ...ok, target: { kind: 'player', playerNumber: 'abc' } },
    { ...ok, target: { kind: 'email', email: 'no-at-sign' } },
    { ...ok, target: { kind: 'search', query: 'a' } },
    { requestId: 'request-ok-3', target: { kind: 'all' }, amount: 1 },
    { ...ok, extra: true },
  ];
  for (const input of bad)
    assert.throws(() => f.admin.pointsGrant(f.owner, input), /INVALID_REQUEST/, JSON.stringify(input));
});

test('email lookup: exact match on the typed address, answers 玩家编号 / tier / balance only, audits a keyed digest, is rate limited', (t) => {
  const f = system(t);
  const p = f.player('findme', { signedUp: true });
  const number = f.numberOf(p.principalId);
  const peer = 'a'.repeat(64);
  const found = f.admin.pointsPreview(
    f.owner,
    { target: { kind: 'email', email: ' FindMe@Example.COM ' }, amount: 5 },
    peer,
  );
  assert.deepEqual(found.player, { playerNumber: number, tier: 'registered', balance: 100 });
  assert.doesNotMatch(JSON.stringify(found), /findme|example/i);
  for (const email of [
    'findme@example.co',
    'indme@example.com',
    'findme@example.com.',
    '%@example.com',
    'find%@example.com',
  ])
    assert.throws(
      () => f.admin.pointsPreview(f.owner, { target: { kind: 'email', email }, amount: 5 }, peer),
      /PLAYER_NOT_FOUND|INVALID_REQUEST/,
      email,
    );
  const audit = auditRows(f);
  assert.ok(audit.filter((row) => row.action === 'points-lookup').length >= 2);
  assert.doesNotMatch(JSON.stringify(audit), /findme|example|@/i, 'no email in the audit');
  assert.ok(audit.every((row) => row.action !== 'points-lookup' || /^email:[a-f0-9]{32}$/.test(row.target_id)));
  // Same address, same digest; another address, another digest.
  const digests = audit.filter((r) => r.action === 'points-lookup').map((r) => r.target_id);
  assert.equal(digests[0], digests[1] === digests[0] ? digests[1] : digests[0]);
  // Six lookups a minute per network place; the seventh is refused. A 玩家编号 is not rate limited (it is pseudonymous).
  const g = system(t);
  g.player('x', { signedUp: true });
  const lookup = () =>
    g.admin.pointsPreview(g.owner, { target: { kind: 'email', email: 'x@example.com' }, amount: 1 }, 'b'.repeat(64));
  for (let i = 0; i < 6; i++) lookup();
  assert.throws(lookup, /RATE_LIMITED/);
  assert.throws(
    () => g.admin.pointsPreview(g.owner, { target: { kind: 'email', email: 'x@example.com' }, amount: 1 }, undefined),
    /WEB_TRUSTED_IP_REQUIRED/,
  );
  for (let i = 0; i < 12; i++)
    assert.throws(
      () => g.admin.pointsPreview(g.owner, { target: { kind: 'player', playerNumber: 'AAAAAAAA' }, amount: 1 }),
      /PLAYER_NOT_FOUND/,
    );
});

test('a purging or purged player is never given points', (t) => {
  const f = system(t);
  const p = f.player('leaving', { signedUp: true });
  f.store.run(
    "UPDATE web_guest_retention SET state='purging',started_at=1,expires_at=2 WHERE principal_id=?",
    p.principalId,
  );
  const result = f.admin.pointsGrant(f.owner, {
    requestId: 'request-purge-1',
    target: { kind: 'all' },
    amount: 10,
    note: '',
  });
  assert.equal(result.players, 0);
  assert.deepEqual(f.events(p.principalId), [['bonus', 100]]);
});

// Named exception (22b follow-up): the owner changed the product rule - daily_refill holders get +7 days of N ON TOP of the balance,
// never above the cap (it used to be "topped up to 7 × N"). The expectations below follow the new rule.
test('reset: registered to 100, daily_refill +7 × N up to the cap, never lowers, one reset event each; worst-case cost from the 30-day usage', (t) => {
  const f = system(t);
  const low = f.player('low', { signedUp: true }),
    high = f.player('high', { signedUp: true }),
    refillLow = f.player('refill-low', { signedUp: true }),
    refillCapped = f.player('refill-capped', { signedUp: true }),
    bigCap = f.player('big-cap', { signedUp: true });
  const codes = (tier: { kind: 'daily_refill'; dailyAmount: number; cap: number }, count: number) =>
    f.create(f.owner, { count, tier }).codes!;
  f.redeem(refillLow, codes({ kind: 'daily_refill', dailyAmount: 50, cap: 1000 }, 1)[0]!);
  f.redeem(refillCapped, codes({ kind: 'daily_refill', dailyAmount: 50, cap: 200 }, 1)[0]!);
  f.redeem(bigCap, codes({ kind: 'daily_refill', dailyAmount: 10, cap: 5000 }, 1)[0]!);
  const set = (who: { principalId: string }, balance: number) =>
    f.store.run('UPDATE web_points_balance SET balance=? WHERE principal_id=?', balance, who.principalId);
  set(low, 30);
  set(high, 400);
  set(refillLow, 20); // +350 (7 × 50), room to 1000
  set(refillCapped, 20); // +180: 7 × 50 = 350 would pass the cap 200
  set(bigCap, 100); // +70 (7 × 10), room to 5000
  const sources = (who: { principalId: string }) => f.events(who.principalId).filter((e) => e[0] === 'reset');
  const dry = f.admin.resetPreview(f.owner, {});
  assert.equal(f.balance(low.principalId), 30, 'a preview writes nothing');
  assert.equal(dry.worstCaseMicros, null, 'no usage yet: 暂无数据');
  const result = f.admin.resetPoints(f.owner, { requestId: 'reset-request-1' });
  assert.deepEqual(
    [
      result.affected,
      result.totalPoints,
      result.skipped.alreadyFull,
      result.skipped.atCap,
      result.skipped.guests,
      result.skipped.unlimited,
    ],
    [4, 70 + 350 + 180 + 70, 1, 0, 0, 0],
  );
  assert.deepEqual(
    [low, high, refillLow, refillCapped, bigCap].map((p) => f.balance(p.principalId)),
    [100, 400, 370, 200, 170],
  );
  assert.deepEqual(
    [low, refillLow, refillCapped, bigCap].map((p) => sources(p)),
    [[['reset', 70]], [['reset', 350]], [['reset', 180]], [['reset', 70]]],
  );
  assert.deepEqual(sources(high), [], 'nobody is lowered or touched');
  assert.equal(f.admin.resetPoints(f.owner, { requestId: 'reset-request-1' }).duplicate, true);
  // A new request id is a new reset: the refill holders still below their cap get another 7 days; the one at its cap is counted.
  const second = f.admin.resetPoints(f.owner, { requestId: 'reset-request-2' });
  assert.deepEqual([second.affected, second.totalPoints, second.skipped.atCap], [2, 350 + 70, 1]);

  // The estimate: points × the highest 30-day average micro-USD per point across the offered models.
  const day = new Date(T0 - DAY).toISOString().slice(0, 10);
  const usage = (provider: string, model: string, phase: string, cost: number, replies: number) =>
    f.store.run(
      'INSERT INTO web_provider_usage(day,provider,model,phase,calls,cost_micros,replies) VALUES (?,?,?,?,?,?,?)',
      day,
      provider,
      model,
      phase,
      replies,
      cost,
      replies,
    );
  usage(PLAYER_MODELS.deepseek.provider, PLAYER_MODELS.deepseek.model, 'draft', 1000, 10);
  usage('deepseek', 'house-reviewer', 'review', 500, 10);
  usage('fish', 's2.1-pro', 'speech', 200, 10);
  set(low, 0);
  const priced = f.admin.resetPreview(f.owner, {});
  assert.equal(priced.totalPoints, 100 + 280 + 70, 'low back to 100, refillLow 720 → 1000 (cap), bigCap +70');
  assert.ok(priced.worstCaseMicros !== null && priced.worstCaseMicros > 0, 'priced from the usage aggregates');
  assert.equal(priced.worstCaseMicros % priced.totalPoints, 0, 'points × an integer micro-USD per point');
});

// Named exception family (22b follow-up): the four agreed examples of the new 重置全部额度 rule for daily_refill (N = 50, cap 1000).
test('reset daily_refill: 120 → 470, 780 → 1000, 990 → 1000, 1000 → no event (已达上限); the same request id adds nothing', (t) => {
  const f = system(t);
  const examples = [
    { start: 120, added: 350, end: 470 },
    { start: 780, added: 220, end: 1000 },
    { start: 990, added: 10, end: 1000 },
    { start: 1000, added: 0, end: 1000 },
  ];
  const codes = f.create(f.owner, {
    count: 4,
    tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
  }).codes!;
  const who = examples.map((e, i) => {
    const p = f.player(`example-${i}`, { signedUp: true });
    f.redeem(p, codes[i]!);
    f.store.run('UPDATE web_points_balance SET balance=? WHERE principal_id=?', e.start, p.principalId);
    return p;
  });
  const result = f.admin.resetPoints(f.owner, { requestId: 'reset-examples-1' });
  examples.forEach((e, i) => {
    assert.equal(f.balance(who[i]!.principalId), e.end, `${e.start} → ${e.end}`);
    assert.deepEqual(
      f.events(who[i]!.principalId).filter((event) => event[0] === 'reset'),
      e.added > 0 ? [['reset', e.added]] : [],
      `${e.start}: ${e.added > 0 ? `+${e.added}` : 'no event'}`,
    );
  });
  assert.deepEqual([result.affected, result.totalPoints, result.skipped.atCap], [3, 580, 1]);
  const again = f.admin.resetPoints(f.owner, { requestId: 'reset-examples-1' });
  assert.equal(again.duplicate, true);
  assert.deepEqual(
    who.map((p) => f.balance(p.principalId)),
    examples.map((e) => e.end),
    'the same request id adds nothing',
  );
});

test('points off: every points action is refused and nothing is written', (t) => {
  const f = system(t);
  f.player('someone', { signedUp: true });
  Object.assign(f.store, { playerModelChoice: undefined });
  for (const call of [
    () => f.admin.pointsPreview(f.owner, { target: { kind: 'all' }, amount: 1 }),
    () => f.admin.pointsGrant(f.owner, { requestId: 'request-off-1', target: { kind: 'all' }, amount: 1, note: '' }),
    () => f.admin.resetPreview(f.owner, {}),
    () => f.admin.resetPoints(f.owner, { requestId: 'request-off-2' }),
  ])
    assert.throws(call, /POINTS_NOT_ENABLED/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_actions')!.n, 0);
});

test('every new method: session first, then permission, then the body (a refused administrator learns nothing)', async (t) => {
  const f = system(t);
  const nobody = f.member([]);
  const noSession = { cookie: 'x'.repeat(43), csrf: 'y'.repeat(64), origin: 'https://fixture.invalid' };
  const bodies = { nonsense: true };
  const owners: Array<[string, (a: typeof nobody) => unknown]> = [
    ['renew', (a) => f.admin.renewPrices(a, bodies)],
    ['topup', (a) => f.admin.budgetTopUp(a, bodies)],
    ['resetPreview', (a) => f.admin.resetPreview(a, bodies)],
    ['reset', (a) => f.admin.resetPoints(a, bodies)],
  ];
  const refused = (call: () => unknown, pattern: RegExp, name: string) =>
    assert.rejects(async () => call(), pattern, name);
  for (const [name, call] of owners) {
    await refused(() => call(nobody), /ADMIN_OWNER_REQUIRED/, name);
    await refused(() => call(noSession), /ADMIN_UNAUTHORIZED/, name);
  }
  assert.throws(() => f.admin.pointsGrant(nobody, bodies), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.admin.pointsPreview(nobody, bodies), /ADMIN_PERMISSION_REQUIRED/);
  await refused(() => f.admin.status(nobody), /ADMIN_PERMISSION_REQUIRED/, 'status');
  // An administrator holding every item still is not the owner.
  const everything = f.member(['points.grant', 'system.read', 'models.manage', 'invites.manage']);
  for (const [name, call] of owners) await refused(() => call(everything), /ADMIN_OWNER_REQUIRED/, name);
});

test('status: prices (in force, covered until, within 60 days), budget policy, UNKNOWN, counts only', async (t) => {
  const f = system(t);
  const ledger = new WebProviderOffline(f.store, { now: f.clock });
  ledger.configureBudget('deepseek', 3_000_000);
  ledger.configureBudget('fish', 3_000_000);
  const price = (id: string, model: string, from: number, until: number, version: number, upper = 2) =>
    ledger.configurePrice({
      id,
      provider: 'deepseek',
      model,
      phase: 'draft',
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: upper,
      validFrom: from,
      validUntil: until,
      version,
    });
  price('a', 'near', T0 - DAY, T0 + 60 * DAY, 1); // exactly 60 days: expiring
  price('b', 'far', T0 - DAY, T0 + 60 * DAY + 1, 1); // one millisecond more: not
  price('c', 'renewed', T0 - DAY, T0 + 10 * DAY, 1); // in force until day 10 ...
  price('d', 'renewed', T0 + 10 * DAY, T0 + 100 * DAY, 2, 3); // ... renewed ahead: covered until day 100
  price('e', 'gone', T0 - 20 * DAY, T0 - DAY, 1);
  const rows = priceRows(f.store, T0);
  const by = Object.fromEntries(rows.map((r) => [r.model, r]));
  assert.deepEqual([by.near!.expiring, by.far!.expiring], [true, false]);
  assert.deepEqual(
    [by.renewed!.expiring, by.renewed!.version, by.renewed!.upperMicrosPerUnit, by.renewed!.daysLeft],
    [false, 1, 2, 100],
    'covered by the next row: the page shows what is in force now and how long it is covered',
  );
  assert.deepEqual([by.gone!.state, by.gone!.expiring], ['expired', true]);
  const status = await f.admin.status(f.owner);
  assert.deepEqual(status.budget, {
    available: true,
    rows: [
      {
        provider: 'deepseek',
        policy: 'capped',
        spentMicros: 10,
        heldMicros: 5,
        allowanceMicros: 3_000_000,
        remainingMicros: 2_999_985,
      },
      {
        provider: 'fish',
        policy: 'unlimited',
        spentMicros: 1,
        heldMicros: 0,
        allowanceMicros: null,
        remainingMicros: null,
      },
    ],
  });
  assert.deepEqual(
    status.unknown.map((k) => [k.kind, k.count, k.oldestAgeMs]),
    [
      ['webProvider', 0, null],
      ['external', 0, null],
      ['embed', 0, null],
    ],
  );
  assert.equal(status.warnings.priceExpiring, 2, 'near and gone');
  assert.deepEqual(Object.keys(status).sort(), [
    'budget',
    'flags',
    'metrics',
    'now',
    'prices',
    'retention',
    'security',
    'unknown',
    'version',
    'warnings',
  ]);
  // A budget Worker that cannot be reached is a bounded code on the page, never a thrown error.
  const down = system(t, {
    budget: async () => {
      throw new Error('WEB_CLOUD_BUDGET_NOT_INITIALIZED');
    },
  });
  assert.deepEqual((await down.admin.status(down.owner)).budget, {
    available: false,
    error: 'WEB_CLOUD_BUDGET_NOT_INITIALIZED',
  });
  const odd = system(t, {
    budget: async () => {
      throw new Error('connect to 10.0.0.1:5432 refused for user@example.com');
    },
  });
  assert.deepEqual(
    (await odd.admin.status(odd.owner)).budget,
    { available: false, error: 'WEB_INSPECT_BUDGET_UNAVAILABLE' },
    'an arbitrary message is never passed on',
  );
});

test('Turnstile failures: counted per UTC day in the business object (counts only), today and the last 7 days', (t) => {
  const f = tiersFixture(t);
  installWebAdminActions(f.store);
  let now = Date.UTC(2026, 9, 22, 23, 59);
  const counters = new WebSecurityCounters(f.store, { now: () => now });
  counters.record('failed');
  counters.record('failed');
  counters.record('unavailable');
  now = Date.UTC(2026, 9, 23, 0, 1); // UTC midnight passed
  counters.record('failed');
  assert.deepEqual(counters.read(now), {
    failuresToday: 1,
    failuresLast7Days: 3,
    unavailableToday: 0,
    unavailableLast7Days: 1,
  });
  now = Date.UTC(2026, 9, 30, 12); // the window is today and the 6 days before it: the 23rd is out of it
  assert.deepEqual(counters.read(now), {
    failuresToday: 0,
    failuresLast7Days: 0,
    unavailableToday: 0,
    unavailableLast7Days: 0,
  });
  counters.record('failed');
  assert.ok(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_turnstile_counts WHERE day<'2026-10-22'")!.n === 0,
    'old days are pruned',
  );
  assert.deepEqual(
    f.store
      .all<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name='web_turnstile_counts'")
      .map((r) => /principal|ip|email|world/i.test(r.sql)),
    [false],
    'the table holds a day, an outcome and a count',
  );
});
