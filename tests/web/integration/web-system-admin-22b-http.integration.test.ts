import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { ADMIN_PERMISSION_ITEMS } from '../../../packages/contracts/web-admin-permissions.ts';

const LATEST_MIGRATION = Math.max(
  ...readdirSync('apps/server/web-migrations')
    .map((name) => Number(name.slice(0, 3)))
    .filter(Number.isInteger),
);
const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
let peers = 0;
const client = (): Client => ({
  cookie: '',
  csrf: '',
  peer: `10.22.${Math.floor(peers / 250)}.${(++peers % 250) + 1}`,
});
const a = (path: string) => `${API}/account${path}`;

/**
 * Part 22b: ONE real-HTTP workerd database with the console's system pages wired to the real budget Worker object. Players of
 * every shape exist together (a trial guest, a registered player, a daily_refill player near its cap, one AT its cap, an
 * unlimited holder) and grants, 重置全部额度, 续期价格 and 预算充值 run against them, with SIGNUP_BONUS_ENABLED and
 * PLAYER_MODEL_CHOICE_ENABLED on and off. Balances, events, 消费记录 rows and the 我的信息 display are asserted after each step.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-system-worker.ts',
    { STATE: 'WebSystemFixture', PREVIEW_BUDGET: 'PreviewBudgetFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown, headers: Record<string, string> = {}) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-peer': actor.peer,
        'x-fixture-host': 'fixture.invalid',
        ...headers,
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const call = async (
    path: string,
    actor: Client,
    body?: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ) => {
    const response = await request(path, actor, body, headers),
      text = await response.text();
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    Object.defineProperty(result, '__text', { value: text, enumerable: false });
    return result;
  };
  /** An administrator call that must fail with this status and error code. */
  const refuse = async (path: string, actor: Client, body: unknown, status: number, code: string) => {
    const response = await request(path, actor, body),
      text = await response.text();
    assert.equal(response.status, status, `${path}: ${text}`);
    assert.equal(JSON.parse(text).error.code, code, `${path}: ${text}`);
  };
  const mails = async (count: number): Promise<Mail[]> => {
    for (let i = 0; i < 100; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length >= count) return list;
      await sleep(20);
    }
    throw new Error('mail not sent');
  };
  const signUp = async (actor: Client, email: string, headers: Record<string, string> = {}) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email }, 200, headers);
    const mail = (await mails(before + 1)).at(-1)!;
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '阿泡' });
  };
  return { ...runtime, call, request, refuse, signUp, fixture: runtime.call };
}

const ADMIN = `${API}/admin`;
const COMBOS = [
  { bonus: true, choice: true },
  { bonus: true, choice: false },
  { bonus: false, choice: true },
  { bonus: false, choice: false },
];

for (const combo of COMBOS) {
  test(`22b grants, reset, renew and top-up against every player shape: SIGNUP_BONUS_ENABLED=${combo.bonus} PLAYER_MODEL_CHOICE_ENABLED=${combo.choice}`, async (t) => {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
    // Seeded with every switch on (the data a deployment already holds), then the switches move to the combination under test.
    await f.fixture('/fixture/cross/choice', { on: true });
    await f.fixture('/fixture/cross/signup-switch', { on: true });
    const owner = client();
    await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
    const boot = (actor: Client) => f.call(`${API}/bootstrap`, actor);
    const info = (actor: Client) => f.call(a(''), actor);
    const batch = () =>
      f.call(
        `${ADMIN}/invites/batch-create`,
        owner,
        {
          requestId: randomUUID(),
          name: 'refill',
          count: 2,
          tier: { kind: 'daily_refill', dailyAmount: 50, cap: 120 },
          durationDays: null,
          redeemBy: null,
        },
        201,
      );
    const unlimitedBatch = () =>
      f.call(
        `${ADMIN}/invites/batch-create`,
        owner,
        {
          requestId: randomUUID(),
          name: 'unlimited',
          count: 1,
          tier: { kind: 'unlimited' },
          durationDays: null,
          redeemBy: null,
        },
        201,
      );
    const redeem = (actor: Client, code: string) =>
      f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code }, 201);

    const names = ['trial', 'registered', 'refillNear', 'refillAtCap', 'unlimited'] as const;
    type Name = (typeof names)[number];
    const who = Object.fromEntries(names.map((name) => [name, client()])) as Record<Name, Client>;
    const ids = {} as Record<Name, string>;
    for (const name of names) ids[name] = (await boot(who[name])).access.principalId;
    await f.signUp(who.registered, 'registered@example.com');
    await f.signUp(who.refillNear, 'near@example.com');
    await f.signUp(who.refillAtCap, 'cap@example.com');
    await f.signUp(who.unlimited, 'unlimited@example.com');
    const codes = (await batch()).codes as string[];
    await redeem(who.refillNear, codes[0]!);
    await redeem(who.refillAtCap, codes[1]!);
    await redeem(who.unlimited, (await unlimitedBatch()).codes[0]);
    // Every signed-up player opens its account page once (its balance exists), then the levels the test needs are set.
    for (const name of ['registered', 'refillNear', 'refillAtCap', 'unlimited'] as const) await info(who[name]);
    const level = (name: Name, balance: number) =>
      f.fixture('/fixture/system/set-balance', { principalId: ids[name], balance });
    await level('registered', 100);
    await level('refillNear', 100);
    await level('refillAtCap', 120);
    await f.fixture('/fixture/cross/choice', { on: combo.choice });
    await f.fixture('/fixture/cross/signup-switch', { on: combo.bonus });

    const balance = async (name: Name) =>
      (await f.fixture<{ balance: number | null }>('/fixture/system/balance', { principalId: ids[name] })).balance;
    const events = async (name: Name) =>
      (
        await f.fixture<{ source: string; delta: number; adminId: string | null }[]>('/fixture/system/events', {
          principalId: ids[name],
        })
      ).filter((e) => e.source === 'grant' || e.source === 'reset');
    const billing = (name: Name) => f.call(`${API}/billing/history`, who[name], { page: 1, tzOffsetMinutes: 0 });
    const numberOf = async (name: Name) =>
      (await f.fixture<{ number: string }>('/fixture/system/player-number', { principalId: ids[name] })).number;

    // The model: who is eligible (holds points) under this combination, and what each balance must be.
    const eligible = (name: Name) =>
      name === 'refillNear' || name === 'refillAtCap' || (name === 'registered' && combo.bonus);
    const model: Record<Name, number | null> = {
      trial: null,
      registered: 100,
      refillNear: 100,
      refillAtCap: 120,
      unlimited: await balance('unlimited'),
    };
    const expectedEvents: Record<Name, [string, number][]> = {
      trial: [],
      registered: [],
      refillNear: [],
      refillAtCap: [],
      unlimited: [],
    };
    const give = (name: Name, amount: number, source: 'grant' | 'reset') => {
      if (!eligible(name)) return 0;
      const room = name.startsWith('refill') ? Math.max(0, 120 - model[name]!) : Number.POSITIVE_INFINITY;
      const added = Math.min(amount, room);
      if (added > 0) {
        model[name] = model[name]! + added;
        expectedEvents[name].push([source, added]);
      }
      return added;
    };
    const check = async (step: string) => {
      for (const name of names) {
        assert.equal(await balance(name), model[name], `${step}: ${name} balance`);
        assert.deepEqual(
          (await events(name)).map((e) => [e.source, e.delta]),
          expectedEvents[name],
          `${step}: ${name} events`,
        );
      }
      // 消费记录 and 我的信息 show what the database holds (only with the points feature on).
      for (const name of ['registered', 'refillNear', 'refillAtCap'] as const) {
        if (!combo.choice) {
          assert.equal(
            (await f.request(`${API}/billing/history`, who[name], { page: 1, tzOffsetMinutes: 0 })).status,
            404,
          );
          continue;
        }
        if (!eligible(name)) continue;
        const page = await billing(name);
        const rows = (page.items as { kind: string; points?: number }[]).filter(
          (i) => i.kind === 'grant' || i.kind === 'reset',
        );
        assert.deepEqual(
          rows.map((i) => [i.kind, i.points]).sort(),
          expectedEvents[name].map(([kind, n]) => [kind, n]).sort(),
          `${step}: ${name} 消费记录`,
        );
        const mine = await info(who[name]);
        assert.equal(mine.modelChoice.balance, model[name], `${step}: ${name} 我的信息 balance`);
      }
    };

    // ---- 概览 and 系统状态 first: the page is usable whatever the switches say ----
    const overview = await f.call(`${ADMIN}/overview/read`, owner, {});
    // Named exception (Part 22c): the owner's 概览 also carries `stats` (yesterday and this month's spend; null for an administrator without stats.read). No assertion was weakened.
    assert.deepEqual(Object.keys(overview).sort(), ['day', 'stats', 'today', 'warnings']);
    assert.deepEqual(Object.keys(overview.today).sort(), ['failedReplies', 'replies', 'spendMicros', 'voiceReplies']);
    const status = await f.call(`${ADMIN}/system/status`, owner, {});
    assert.equal(status.version.matches, true, 'the ledger is the expected one');
    // Named exception (22b follow-up): the schema version is the code's latest migration, not a literal (22a2 added 127).
    assert.equal(status.version.schemaVersion, LATEST_MIGRATION);
    assert.equal(status.flags.signupBonus, combo.bonus);
    assert.equal(status.flags.playerModelChoice, combo.choice);
    assert.deepEqual(
      status.budget.rows.map((r: any) => [r.provider, r.policy, r.allowanceMicros, r.remainingMicros]),
      [
        ['deepseek', 'capped', 3_000_000, 3_000_000],
        ['fish', 'capped', 3_000_000, 3_000_000],
      ],
    );
    assert.doesNotMatch(status.__text, /@example\.com|principal-|"ip_?hash"/, 'no identity on the status page');
    assert.ok(Array.isArray(status.metrics));

    const grant = (target: unknown, amount: number, requestId = randomUUID(), note = '') =>
      f.call(`${ADMIN}/points/grant`, owner, { requestId, target, amount, note });
    const preview = (target: unknown, amount: number) => f.call(`${ADMIN}/points/preview`, owner, { target, amount });

    if (!combo.choice) {
      // Without points there is nothing to give or reset: every action is refused and nothing is written anywhere.
      for (const path of ['points/preview', 'points/grant'])
        await f.refuse(
          `${ADMIN}/${path}`,
          owner,
          path === 'points/grant'
            ? { requestId: randomUUID(), target: { kind: 'all' }, amount: 10, note: '' }
            : { target: { kind: 'all' }, amount: 10 },
          409,
          'POINTS_NOT_ENABLED',
        );
      await f.refuse(`${ADMIN}/points/reset-preview`, owner, {}, 409, 'POINTS_NOT_ENABLED');
      await f.refuse(`${ADMIN}/points/reset`, owner, { requestId: randomUUID() }, 409, 'POINTS_NOT_ENABLED');
      await check('points off');
    } else {
      // ---- 1. everyone registered, 30 points ----
      const before = await Promise.all(names.map((n) => events(n)));
      const dry = await preview({ kind: 'all' }, 30);
      assert.deepEqual(await Promise.all(names.map((n) => events(n))), before, 'a preview writes nothing');
      const requestId = randomUUID();
      const first = await grant({ kind: 'all' }, 30, requestId, '测试补发');
      for (const name of names) give(name, 30, 'grant');
      const receivers = names.filter(eligible);
      assert.equal(first.players, receivers.length, 'players the target selected');
      assert.equal(first.granted, receivers.filter((n) => expectedEvents[n].length > 0).length);
      assert.equal(
        first.totalPoints,
        receivers.reduce((s, n) => s + (expectedEvents[n][0]?.[1] ?? 0), 0),
      );
      assert.deepEqual(first.skipped, {
        guests: combo.bonus ? 1 : 2,
        unlimited: 1,
        atCap: receivers.filter((n) => expectedEvents[n].length === 0).length,
      });
      assert.equal(first.duplicate, false);
      // The preview named exactly what the grant then did.
      assert.deepEqual({ ...dry, duplicate: false }, { ...first, duplicate: false });
      await check('grant to all');
      // Idempotent per request id: the same call answers the stored result and gives nothing twice.
      const replay = await grant({ kind: 'all' }, 30, requestId, '测试补发');
      assert.equal(replay.duplicate, true);
      assert.equal(replay.totalPoints, first.totalPoints);
      await check('replay of the grant');
      await f.refuse(
        `${ADMIN}/points/grant`,
        owner,
        { requestId, target: { kind: 'all' }, amount: 31, note: '测试补发' },
        409,
        'IDEMPOTENCY_CONFLICT',
      );
      await check('conflicting reuse of a request id');

      // ---- 2. one effective tier ----
      const tierResult = await grant({ kind: 'tier', tier: 'daily_refill' }, 5);
      for (const name of ['refillNear', 'refillAtCap'] as const) give(name, 5, 'grant');
      assert.equal(tierResult.players, 2);
      assert.equal(tierResult.skipped.atCap, 2 - tierResult.granted);
      await check('grant to one tier');

      // ---- 3. one exact email: the lookup answers 玩家编号, tier and balance only ----
      const looked = await preview({ kind: 'email', email: ' Registered@Example.com ' }, 7);
      assert.deepEqual(Object.keys(looked.player).sort(), ['balance', 'playerNumber', 'tier']);
      assert.equal(looked.player.playerNumber, await numberOf('registered'));
      assert.equal(looked.player.tier, combo.bonus ? 'registered' : 'guest');
      assert.doesNotMatch(looked.__text, /example\.com|registered@/, 'the email is never answered back');
      const byEmail = await grant({ kind: 'email', email: 'registered@example.com' }, 7);
      give('registered', 7, 'grant');
      assert.doesNotMatch(byEmail.__text, /example\.com|registered@/);
      assert.equal(byEmail.skipped.guests, combo.bonus ? 0 : 1, 'a login-only player is a guest without the free tier');
      await check('grant by email');
      // Exact only: a partial address, another case of nothing, an unknown address (404) and a name are not a search.
      await f.refuse(
        `${ADMIN}/points/preview`,
        owner,
        { target: { kind: 'email', email: 'registered' }, amount: 7 },
        400,
        'INVALID_REQUEST',
      );
      await f.refuse(
        `${ADMIN}/points/preview`,
        owner,
        { target: { kind: 'email', email: '*@example.com' }, amount: 7 },
        404,
        'PLAYER_NOT_FOUND',
      );
      await f.refuse(
        `${ADMIN}/points/preview`,
        owner,
        { target: { kind: 'email', email: 'registere@example.com' }, amount: 7 },
        404,
        'PLAYER_NOT_FOUND',
      );
      await check('failed lookups change nothing');
      const audit =
        await f.fixture<{ actorId: string | null; action: string; targetId: string }[]>('/fixture/system/audit');
      const lookups = audit.filter((row) => row.action === 'points-lookup');
      assert.ok(lookups.length >= 4, 'every lookup is logged, found or not');
      for (const row of lookups) assert.match(row.targetId, /^(email:[a-f0-9]{32}|number:[0-9A-Z]{8})$/);
      assert.doesNotMatch(JSON.stringify(audit), /@|example/, 'the audit never holds an email');
      assert.equal(
        new Set(lookups.filter((r) => r.targetId.startsWith('email:')).map((r) => r.targetId)).size,
        3,
        'one digest per address, stable',
      );

      // ---- 4. one exact 玩家编号 ----
      const number = await numberOf('refillNear');
      const byNumber = await grant({ kind: 'player', playerNumber: number.toLowerCase() }, 15);
      give('refillNear', 15, 'grant');
      assert.equal(byNumber.players, 1);
      await check('grant by 玩家编号');
      // A guest and an unlimited holder are answered, not granted.
      const guestNumber = await numberOf('unlimited');
      const unlimitedResult = await grant({ kind: 'player', playerNumber: guestNumber }, 5);
      assert.deepEqual(
        [unlimitedResult.players, unlimitedResult.granted, unlimitedResult.skipped.unlimited],
        [0, 0, 1],
      );
      await check('unlimited holders are skipped');

      // ---- 重置全部额度 ----
      await level('registered', 40);
      await level('refillNear', 10);
      model.registered = 40;
      model.refillNear = 10;
      const resetDry = await f.call(`${ADMIN}/points/reset-preview`, owner, {});
      await check('reset preview writes nothing');
      const resetId = randomUUID();
      const reset = await f.call(`${ADMIN}/points/reset`, owner, { requestId: resetId });
      // registered → 100 (only when it holds points); refill → +min(7 × 50, cap 120 − balance); never lowers; unlimited and guests untouched.
      // Named exception (22b follow-up, the owner changed the product rule): daily_refill adds on top of the balance, so the player
      // already at its cap is counted 已达上限 (atCap), not 已不低于目标 (alreadyFull).
      if (eligible('registered')) {
        const added = 100 - model.registered!;
        model.registered = 100;
        expectedEvents.registered.push(['reset', added]);
      }
      expectedEvents.refillNear.push(['reset', 110]);
      model.refillNear = 120;
      const affected = eligible('registered') ? 2 : 1;
      assert.equal(reset.affected, affected);
      assert.equal(reset.totalPoints, eligible('registered') ? 170 : 110);
      assert.deepEqual(
        [reset.skipped.atCap, reset.skipped.alreadyFull],
        [1, 0],
        'the player already at its cap is not touched',
      );
      assert.deepEqual([reset.skipped.guests, reset.skipped.unlimited], [combo.bonus ? 1 : 2, 1]);
      assert.ok(reset.worstCaseMicros === null || Number.isSafeInteger(reset.worstCaseMicros));
      assert.equal(resetDry.totalPoints, reset.totalPoints, 'the preview named what the reset then did');
      await check('reset');
      const resetAgain = await f.call(`${ADMIN}/points/reset`, owner, { requestId: resetId });
      assert.equal(resetAgain.duplicate, true);
      await check('replay of the reset');
      // Nothing is lowered: a second reset with a new request id finds everyone at their level.
      const second = await f.call(`${ADMIN}/points/reset`, owner, { requestId: randomUUID() });
      assert.deepEqual([second.affected, second.totalPoints], [0, 0]);
      await check('a second reset adds nothing');
      // Every grant and reset event carries the acting administrator.
      const ownerIds = new Set((await Promise.all(names.map((n) => events(n)))).flat().map((e) => e.adminId));
      assert.equal(ownerIds.size, 1);
      assert.ok([...ownerIds][0]);
    }

    // ---- 续期价格: the same renewal as the operator's, per row, never twice ----
    const before = await f.fixture<any[]>('/fixture/system/prices');
    const renewId = randomUUID();
    const renewed = await f.call(`${ADMIN}/system/renew-prices`, owner, { requestId: renewId });
    assert.equal(renewed.duplicate, false);
    assert.ok(renewed.rows.length >= 6);
    for (const row of renewed.rows) {
      assert.ok(['renewed', 'not-due'].includes(row.result), `${row.provider} ${row.result}`);
      assert.ok(row.upperMicrosPerUnit > 0 && row.version > 0, 'the new numbers are shown');
    }
    const after = await f.fixture<any[]>('/fixture/system/prices');
    assert.equal(after.length, before.length + renewed.rows.filter((r: any) => r.result === 'renewed').length);
    const replayed = await f.call(`${ADMIN}/system/renew-prices`, owner, { requestId: renewId });
    assert.equal(replayed.duplicate, true);
    const again = await f.call(`${ADMIN}/system/renew-prices`, owner, { requestId: randomUUID() });
    assert.ok(
      again.rows.every((r: any) => r.result === 'not-due'),
      'nothing is due a second time',
    );
    assert.equal((await f.fixture<any[]>('/fixture/system/prices')).length, after.length, 'no duplicate rows');

    // ---- 预算充值: capped providers only, USD 1-50, idempotent ----
    const topId = randomUUID();
    const top = await f.call(`${ADMIN}/system/budget-topup`, owner, {
      requestId: topId,
      provider: 'deepseek',
      dollars: 5,
    });
    assert.deepEqual(
      [top.provider, top.addedMicros, top.allowanceMicros, top.remainingMicros, top.duplicate],
      ['deepseek', 5_000_000, 8_000_000, 8_000_000, false],
    );
    const topAgain = await f.call(`${ADMIN}/system/budget-topup`, owner, {
      requestId: topId,
      provider: 'deepseek',
      dollars: 5,
    });
    assert.equal(topAgain.duplicate, true);
    const summary = await f.fixture<any[]>('/fixture/system/budget');
    assert.deepEqual(
      summary.map((r) => [r.provider, r.allowanceMicros]),
      [
        ['deepseek', 8_000_000],
        ['fish', 3_000_000],
      ],
      'the replay added nothing and fish is untouched',
    );
    await f.refuse(
      `${ADMIN}/system/budget-topup`,
      owner,
      { requestId: topId, provider: 'deepseek', dollars: 6 },
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    for (const dollars of [0, 51, 1.5, -1, '5'])
      await f.refuse(
        `${ADMIN}/system/budget-topup`,
        owner,
        { requestId: randomUUID(), provider: 'deepseek', dollars },
        400,
        'INVALID_REQUEST',
      );
    await f.refuse(
      `${ADMIN}/system/budget-topup`,
      owner,
      { requestId: randomUUID(), provider: 'gemini', dollars: 5 },
      400,
      'INVALID_REQUEST',
    );
    // The local per-instance ceiling (a copy of the old USD 3 cap) is lifted for the text providers; speech keeps its own.
    assert.deepEqual(
      (await f.fixture<{ provider: string; limitMicros: number | null }[]>('/fixture/system/local-limits')).map((r) => [
        r.provider,
        r.limitMicros,
      ]),
      [
        ['deepseek', null],
        ['fish', 3_000_000],
        ['gemini', null],
        ['xai', null],
      ],
    );
    const status2 = await f.call(`${ADMIN}/system/status`, owner, {});
    assert.deepEqual(
      status2.budget.rows.map((r: any) => [r.provider, r.allowanceMicros]),
      [
        ['deepseek', 8_000_000],
        ['fish', 3_000_000],
      ],
    );
    assert.ok(
      status2.prices.every((p: any) => !p.expiring),
      'after the renewal nothing is near expiry',
    );
    assert.doesNotMatch(status2.__text, /@example\.com|principal-/);
  });
}

test('22b every new route: no permission → 403, owner-only routes refuse every non-owner, anonymous and cross-site calls are refused', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  await f.fixture('/fixture/cross/choice', { on: true });
  await f.fixture('/fixture/cross/signup-switch', { on: true });
  const owner = client();
  await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const staff = async (label: string, permissions: string[]) => {
    const issued = await f.call(`${ADMIN}/members/issue`, owner, {
      requestId: randomUUID(),
      label,
      memberId: null,
      permissions,
    });
    const actor = client();
    await f.call(`${ADMIN}/login`, actor, { token: issued.token });
    return actor;
  };
  const nothing = await staff('nothing', []);
  // Every permission an administrator can hold, except that no one can hold the owner role.
  const everything = await staff(
    'everything',
    [...ADMIN_PERMISSION_ITEMS].map((item) =>
      item.startsWith('characters.') && item !== 'characters.create' ? `${item}:*` : item,
    ),
  );
  const pointsOnly = await staff('points', ['points.grant']);
  const systemOnly = await staff('system', ['system.read']);
  const id = () => randomUUID();
  const target = { kind: 'all' };
  const routes = {
    overview: ['overview/read', {}],
    status: ['system/status', {}],
    renew: ['system/renew-prices', { requestId: id() }],
    topup: ['system/budget-topup', { requestId: id(), provider: 'deepseek', dollars: 1 }],
    preview: ['points/preview', { target, amount: 1 }],
    grant: ['points/grant', { requestId: id(), target, amount: 1, note: '' }],
    resetPreview: ['points/reset-preview', {}],
    reset: ['points/reset', { requestId: id() }],
  } as const;
  const ownerOnly = ['renew', 'topup', 'resetPreview', 'reset'] as const;
  const needsPermission = { status: 'system.read', preview: 'points.grant', grant: 'points.grant' } as const;

  // Any administrator reads 概览.
  for (const actor of [nothing, everything, pointsOnly, systemOnly, owner])
    await f.call(`${ADMIN}/${routes.overview[0]}`, actor, {});
  // No permission: 403 on everything but 概览.
  for (const [name, [path, body]] of Object.entries(routes)) {
    if (name === 'overview') continue;
    await f.refuse(
      `${ADMIN}/${path}`,
      nothing,
      body,
      403,
      ownerOnly.includes(name as never) ? 'ADMIN_OWNER_REQUIRED' : 'ADMIN_PERMISSION_REQUIRED',
    );
  }
  // The owner-only routes refuse every non-owner, an administrator with every permission included.
  for (const name of ownerOnly)
    for (const actor of [nothing, everything, pointsOnly, systemOnly])
      await f.refuse(`${ADMIN}/${routes[name][0]}`, actor, routes[name][1], 403, 'ADMIN_OWNER_REQUIRED');
  // The permission routes: the matching permission opens exactly its own routes.
  await f.call(`${ADMIN}/system/status`, systemOnly, {});
  await f.call(`${ADMIN}/system/status`, everything, {});
  await f.refuse(`${ADMIN}/system/status`, pointsOnly, {}, 403, 'ADMIN_PERMISSION_REQUIRED');
  for (const name of ['preview', 'grant'] as const) {
    await f.refuse(`${ADMIN}/${routes[name][0]}`, systemOnly, routes[name][1], 403, 'ADMIN_PERMISSION_REQUIRED');
    assert.equal(needsPermission[name], 'points.grant');
  }
  await f.call(`${ADMIN}/points/preview`, pointsOnly, routes.preview[1]);
  await f.call(`${ADMIN}/points/grant`, pointsOnly, routes.grant[1]);
  await f.call(`${ADMIN}/points/preview`, everything, routes.preview[1]);
  // A refused administrator learns nothing about the body: a malformed body is still a 403, not a 400.
  await f.refuse(`${ADMIN}/points/grant`, nothing, { nonsense: true }, 403, 'ADMIN_PERMISSION_REQUIRED');
  await f.refuse(`${ADMIN}/system/renew-prices`, everything, { nonsense: true }, 403, 'ADMIN_OWNER_REQUIRED');
  // Session, CSRF and Origin like every administrator write.
  const anonymous = client();
  for (const [name, [path, body]] of Object.entries(routes)) {
    await f.refuse(`${ADMIN}/${path}`, anonymous, body, 401, 'ADMIN_UNAUTHORIZED');
    const stale = { ...owner, csrf: 'f'.repeat(64) };
    await f.refuse(`${ADMIN}/${path}`, stale, body, 403, 'ADMIN_CSRF_REQUIRED');
    const crossSite = await f.request(`${ADMIN}/${path}`, owner, body, { origin: 'https://evil.invalid' });
    assert.equal(crossSite.status, 403, `${name}: a foreign Origin is refused`);
    const wrongSite = await f.request(`${ADMIN}/${path}`, owner, body, { 'sec-fetch-site': 'cross-site' });
    assert.equal(wrongSite.status, 403, `${name}: a cross-site fetch is refused`);
  }
  // GET is never a route.
  assert.notEqual((await f.request(`${ADMIN}/system/status`, owner)).status, 200);
  // The old 运营数据 route is kept (owner only) for the numbers that moved into 技术指标; nothing here removed it.
  await f.call(`${ADMIN}/metrics/stage-latency`, owner, { days: 7 });
  await f.refuse(`${ADMIN}/metrics/stage-latency`, everything, { days: 7 }, 403, 'ADMIN_OWNER_REQUIRED');
  // An unknown path under the new prefixes is a plain 404.
  for (const path of ['system/nope', 'points/nope', 'overview/nope'])
    assert.equal((await f.request(`${ADMIN}/${path}`, owner, {})).status, 404, path);
});

test('22b the operator renew-prices and the 续期价格 button leave the same rows, in either order, and never duplicate', async (t) => {
  const normalized = (rows: any[]) =>
    rows.map(({ provider, model, phase, unit, upper, version }) =>
      [provider, model, phase, unit, upper, version].join('|'),
    );
  const run = async (first: 'button' | 'operator') => {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', { signupEnabled: true });
    const owner = client();
    await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
    const button = () => f.call(`${ADMIN}/system/renew-prices`, owner, { requestId: randomUUID() });
    // The operator command is renewProviderPrices behind WebCloudSetup.renewPrices; the fixture runs the very same function.
    const operator = () => f.fixture<any[]>('/fixture/system/operator-renew', {});
    const rows = async () => f.fixture<any[]>('/fixture/system/prices');
    const initial = (await rows()).length;
    const one = first === 'button' ? await button() : { rows: await operator() };
    const afterFirst = await rows();
    assert.ok(one.rows.some((r: any) => r.result === 'renewed'));
    const two = first === 'button' ? { rows: await operator() } : await button();
    assert.ok(
      two.rows.every((r: any) => r.result === 'not-due'),
      `the second runner finds nothing due (${first} first)`,
    );
    assert.deepEqual(await rows(), afterFirst, 'the second runner changed nothing');
    assert.ok(afterFirst.length > initial);
    return normalized(afterFirst);
  };
  const fromButton = await run('button');
  const fromOperator = await run('operator');
  assert.deepEqual(fromButton, fromOperator, 'the same rows whichever ran first');
});

test('22b nothing in the client calls a removed route, and the console no longer asks for 运营数据', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client();
  await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  // Every literal admin path the client's API class sends exists on the server: a POST as the owner is never a 404.
  const api = readFileSync('apps/player-web/src/services/account-admin-api.ts', 'utf8');
  const paths = [...api.matchAll(/this\.request\('([^']+)'/g)]
    .map((m) => m[1]!)
    .filter((p) => p !== '/session' && !p.endsWith('/'));
  assert.ok(paths.length > 20, 'the client API was read');
  for (const path of new Set(paths)) {
    const response = await f.request(`${ADMIN}${path}`, owner, {});
    assert.notEqual(response.status, 404, `${path} is called by the client but is not a route`);
  }
  for (const path of [
    '/overview/read',
    '/system/status',
    '/system/renew-prices',
    '/system/budget-topup',
    '/points/preview',
    '/points/grant',
    '/points/reset-preview',
    '/points/reset',
  ])
    assert.ok(paths.includes(path), `${path} is called by the client`);
  // The page itself never asks for the old stage-latency numbers: they arrive inside the one 系统状态 call.
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
    );
  for (const file of files('apps/player-web/src/features').filter((name) => name.endsWith('.ts')))
    assert.doesNotMatch(
      readFileSync(file, 'utf8'),
      /\.stageLatency\(|metrics\/stage-latency|stageLatency\??:/,
      `${file} must not call the old route`,
    );
  // The route itself is kept for the operator and its tests (owner only): it answers, it is not removed.
  assert.equal((await f.request(`${ADMIN}/metrics/stage-latency`, owner, { days: 7 })).status, 200);
});

test('22b 概览 and 系统状态 numbers come from real data: today’s replies, UNKNOWN calls with their age, Turnstile failures', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, turnstile: true });
  await f.fixture('/fixture/cross/choice', { on: true });
  await f.fixture('/fixture/cross/signup-switch', { on: true });
  const owner = client();
  await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const status = () => f.call(`${ADMIN}/system/status`, owner, {});
  const overview = () => f.call(`${ADMIN}/overview/read`, owner, {});
  const empty = await overview();
  assert.deepEqual(
    [empty.today.replies, empty.today.voiceReplies, empty.today.failedReplies],
    [0, 0, 0],
    'nothing has happened today',
  );

  // Turnstile: a request without a token and one with a bad token are counted as failures; an unreachable siteverify separately.
  const visitor = client();
  const refuseVisit = async (code: string, token?: string) => {
    const response = await f.request(
      `${API}/bootstrap`,
      visitor,
      undefined,
      token ? { 'x-turnstile-token': token } : {},
    );
    assert.equal(JSON.parse(await response.text()).error.code, code);
  };
  await refuseVisit('TURNSTILE_REQUIRED');
  await refuseVisit('TURNSTILE_FAILED', 'bad-token-1');
  await f.fixture('/fixture/turnstile-mode', { down: true });
  await refuseVisit('TURNSTILE_UNAVAILABLE', 'good-guest-3');
  await f.fixture('/fixture/turnstile-mode', { down: false });
  const secured = (await status()).security;
  assert.deepEqual(secured, {
    turnstile: true,
    failuresToday: 2,
    failuresLast7Days: 2,
    unavailableToday: 1,
    unavailableLast7Days: 1,
  });

  // A real reply today.
  const player = client();
  await f.call(`${API}/bootstrap`, player, undefined, 200, { 'x-turnstile-token': 'good-guest-9' });
  await f.signUp(player, 'daily@example.com', { 'x-turnstile-token': 'good-code-9' });
  const sent = await f.call(
    `${API}/characters/wei-guagua/operations`,
    player,
    { requestId: randomUUID(), text: '你好', delivery: 'voice' },
    202,
  );
  for (let i = 0; i < 300; i++) {
    const op = await f.call(`${API}/operations/${sent.operation.operationId}`, player);
    if (op.status === 'published') break;
    await sleep(100);
  }
  const today = await overview();
  assert.deepEqual([today.today.replies, today.today.voiceReplies, today.today.failedReplies], [1, 1, 0]);
  assert.ok(Number.isSafeInteger(today.today.spendMicros) && today.today.spendMicros >= 0);
  assert.deepEqual(today.warnings.unknownNew, 0);

  // An UNKNOWN call: counted per kind with its age, never retried or released by this page; it is the "new UNKNOWN" warning.
  await f.fixture('/fixture/system/unknown', {});
  const after = await status();
  const kinds = Object.fromEntries(after.unknown.map((k: any) => [k.kind, k]));
  assert.equal(kinds.webProvider.count, 1);
  assert.ok(
    Math.abs(kinds.webProvider.oldestAgeMs - 3 * 3_600_000) < 60_000,
    `about three hours: ${kinds.webProvider.oldestAgeMs}`,
  );
  assert.equal(after.warnings.unknownNew, 1);
  assert.equal((await overview()).warnings.unknownNew, 1);
  assert.doesNotMatch(after.__text, /daily@example|principal|operation-/i);
});

// Named exception family (22b follow-up): the owner changed the 重置全部额度 rule for daily_refill holders - +7 days of N ON TOP of the
// balance, never above the cap. This test states the four agreed examples explicitly (N = 50, cap 1000) over real HTTP.
test('22b 重置全部额度 for daily_refill: +7 × N on top of the balance up to the cap (the four agreed examples), idempotent, then the next UTC day refills only up to the cap', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  await f.fixture('/fixture/cross/choice', { on: true });
  await f.fixture('/fixture/cross/signup-switch', { on: true });
  const owner = client();
  await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const batch = await f.call(
    `${ADMIN}/invites/batch-create`,
    owner,
    {
      requestId: randomUUID(),
      name: 'refill-1000',
      count: 4,
      tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
      durationDays: null,
      redeemBy: null,
    },
    201,
  );
  const examples = [
    { start: 120, added: 350, end: 470 },
    { start: 780, added: 220, end: 1000 },
    { start: 990, added: 10, end: 1000 },
    { start: 1000, added: 0, end: 1000 },
  ];
  const players: { actor: Client; id: string }[] = [];
  for (const [i] of examples.entries()) {
    const actor = client();
    const id = (await f.call(`${API}/bootstrap`, actor)).access.principalId as string;
    await f.signUp(actor, `refill${i}@example.com`);
    await f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code: batch.codes[i] }, 201);
    await f.call(a(''), actor);
    await f.fixture('/fixture/system/set-balance', { principalId: id, balance: examples[i]!.start });
    players.push({ actor, id });
  }
  const balances = async () =>
    Promise.all(
      players.map(
        async (p) => (await f.fixture<{ balance: number }>('/fixture/system/balance', { principalId: p.id })).balance,
      ),
    );
  const resets = async () =>
    Promise.all(
      players.map(async (p) =>
        (await f.fixture<{ source: string; delta: number }[]>('/fixture/system/events', { principalId: p.id }))
          .filter((e) => e.source === 'reset')
          .map((e) => e.delta),
      ),
    );
  const dry = await f.call(`${ADMIN}/points/reset-preview`, owner, {});
  assert.deepEqual(
    await balances(),
    examples.map((e) => e.start),
    'the preview writes nothing',
  );
  const requestId = randomUUID();
  const done = await f.call(`${ADMIN}/points/reset`, owner, { requestId });
  assert.deepEqual(
    await balances(),
    examples.map((e) => e.end),
  );
  assert.deepEqual(
    await resets(),
    examples.map((e) => (e.added > 0 ? [e.added] : [])),
    'one reset event each; none for the player already at its cap',
  );
  assert.deepEqual(
    [done.affected, done.totalPoints, done.skipped.atCap],
    [3, 580, 1],
    'at the cap is counted 已达上限',
  );
  assert.equal(dry.totalPoints, done.totalPoints);
  // The same request id again adds nothing.
  const again = await f.call(`${ADMIN}/points/reset`, owner, { requestId });
  assert.equal(again.duplicate, true);
  assert.deepEqual(
    await balances(),
    examples.map((e) => e.end),
  );
  assert.deepEqual(
    await resets(),
    examples.map((e) => (e.added > 0 ? [e.added] : [])),
  );
  // A NEW request id is a new reset: the player still below the cap (470) gets another 7 days (+350); the others are at the cap.
  const second = await f.call(`${ADMIN}/points/reset`, owner, { requestId: randomUUID() });
  assert.deepEqual([second.affected, second.totalPoints, second.skipped.atCap], [1, 350, 3]);
  assert.deepEqual(await balances(), [820, 1000, 1000, 1000]);

  // The next UTC day: a visit pays +N refill, but only up to the cap (one player is at 820, the rest at 1000).
  for (const p of players) await f.fixture('/fixture/cross/rewind-refill', { principalId: p.id });
  for (const p of players) await f.call(a(''), p.actor);
  assert.deepEqual(await balances(), [870, 1000, 1000, 1000], 'only the player below the cap gets +50');
});

// Part 22b follow-up (22a2 is merged): 系统状态 → 清理 lists, per failing principal, where its purge broke and how many times - from the same
// source as operator inspect (WebCloudRetention.health) - and no id.
test('22b 系统状态 清理: phase / sub / errorName / messageShape and the count per failing principal, no ids; a purged principal is not listed', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client();
  await f.call(`${ADMIN}/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const actor = client();
    ids.push((await f.call(`${API}/bootstrap`, actor)).access.principalId as string);
  }
  const detail = (phase: string, sub: string, errorName: string, messageShape: string) => ({
    code: 'WEB_RETENTION_FAILED',
    phase,
    sub,
    errorName,
    messageShape,
  });
  const fail = (principalId: string, count: number, d: ReturnType<typeof detail>) =>
    f.fixture('/fixture/system/retention-fail', { principalId, count, detail: d });
  assert.deepEqual((await f.call(`${ADMIN}/system/status`, owner, {})).retention.failures, [], 'nothing failing');
  await fail(ids[0]!, 2, detail('clearDatabase', 'audit_source', 'Error', 'not <tok>: <tok>'));
  await fail(ids[1]!, 5, detail('eraseAudio', 'media_delete', 'DomainError', 'R2 <n> failed'));
  const status = await f.call(`${ADMIN}/system/status`, owner, {});
  assert.equal(status.retention.failing, 2);
  assert.deepEqual(status.retention.failures, [
    {
      code: 'WEB_RETENTION_FAILED',
      phase: 'eraseAudio',
      sub: 'media_delete',
      errorName: 'DomainError',
      messageShape: 'R2 <n> failed',
      count: 5,
    },
    {
      code: 'WEB_RETENTION_FAILED',
      phase: 'clearDatabase',
      sub: 'audit_source',
      errorName: 'Error',
      messageShape: 'not <tok>: <tok>',
      count: 2,
    },
  ]);
  for (const id of ids) assert.ok(!status.__text.includes(id), 'no principal id on the page');
  assert.equal((await f.call(`${ADMIN}/overview/read`, owner, {})).warnings.retentionFailing, 2);
});
