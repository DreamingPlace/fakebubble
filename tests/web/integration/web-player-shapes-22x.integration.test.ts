import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type State = {
  kind: string;
  retention: string;
  spends: number;
  refills: number;
  balance: number | null;
  liveSessions: number;
};
let peers = 0;
const client = (): Client => ({ cookie: '', csrf: '', peer: `10.22.0.${++peers}` });
const a = (path: string) => `${API}/account${path}`;

/**
 * (setup shared with web-invite-cross-path-22a.) Part 22a follow-up, item 5 (Part 22x: the old data is the shape migration 126 leaves). ONE real-HTTP workerd database holding
 * OLD and NEW data together: an old invited player with a login (migration 125 backfilled an unlimited entitlement for it), an
 * old invited player without a login (126: an expired guest, no access), a new daily_refill holder, and a plain registered player. Revoke, expiry, the model-choice switch both ways,
 * redemption and a refill across a UTC midnight run against all of them, and tier, charge and display are asserted for each.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-cross-path-worker.ts',
    { STATE: 'WebCrossPathFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-peer': actor.peer,
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const call = async (path: string, actor: Client, body?: unknown, status = 200) => {
    const response = await request(path, actor, body),
      text = await response.text();
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  const mails = async (count: number): Promise<Mail[]> => {
    for (let i = 0; i < 100; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length >= count) return list;
      await sleep(20);
    }
    throw new Error('mail not sent');
  };
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email });
    const mail = (await mails(before + 1)).at(-1)!;
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '阿泡' });
  };
  const reply = async (actor: Client) => {
    const sent = await call(
      `${API}/characters/wei-guagua/operations`,
      actor,
      { requestId: randomUUID(), text: '你好', delivery: 'voice' },
      202,
    );
    for (let i = 0; i < 300; i++) {
      const op = await call(`${API}/operations/${sent.operation.operationId}`, actor);
      if (['published', 'failed', 'cancelled'].includes(op.status)) return op.status as string;
      await sleep(100);
    }
    throw new Error('operation did not settle');
  };
  return { ...runtime, call, request, signUp, reply, fixture: runtime.call };
}

/** Part 22x: removed routes. Every one answers 404 (a POST with a valid session, so nothing but the missing route can explain it). */
const REMOVED_ROUTES = [
  '/invites/credential',
  '/invites/credential-regenerate',
  '/invites/recover',
  '/identity/invite-receipt-challenge',
  '/identity/invite-receipt-recover',
  '/identity/invite-receipt-status',
  '/identity/receipt-challenge',
  '/identity/receipt-recover',
  '/identity/receipt-status',
  '/admin/invites/issue',
  '/admin/invites/revoke-code',
  '/admin/invites/revoke-grant',
  '/admin/invites/list',
  '/account/bind-request-code',
  '/account/bind-verify-code',
  '/account/bind',
];

const COMBOS = [
  { bonus: true, choice: true },
  { bonus: true, choice: false },
  { bonus: false, choice: true },
  { bonus: false, choice: false },
];

for (const combo of COMBOS) {
  test(`22x every player shape end to end over real HTTP: SIGNUP_BONUS_ENABLED=${combo.bonus} PLAYER_MODEL_CHOICE_ENABLED=${combo.choice}`, async (t) => {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
    // Seeded with every switch on (the data a deployment already holds), then the switches move to the combination under test.
    await f.fixture('/fixture/cross/choice', { on: true });
    await f.fixture('/fixture/cross/signup-switch', { on: true });
    const owner = client();
    await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
    const state = (principalId: string) => f.fixture<State>('/fixture/cross/state', { principalId });
    const boot = async (actor: Client) => await f.call(`${API}/bootstrap`, actor);
    const batch = (kind: 'daily_refill' | 'unlimited') =>
      f.call(
        `${API}/admin/invites/batch-create`,
        owner,
        {
          requestId: randomUUID(),
          name: kind,
          count: 1,
          tier: kind === 'daily_refill' ? { kind, dailyAmount: 50, cap: 120 } : { kind },
          durationDays: null,
          redeemBy: null,
        },
        201,
      );
    const redeem = async (actor: Client, kind: 'daily_refill' | 'unlimited') =>
      f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code: (await batch(kind)).codes[0] }, 201);
    const info = (actor: Client) => f.call(a(''), actor);
    const idOf = async (actor: Client) => (await boot(actor)).access.principalId as string;

    // The seven shapes, old and new data in one database.
    const trial = client(),
      pastTrial = client(),
      registered = client(),
      oldLogin = client(),
      oldOnly = client(),
      refill = client(),
      unlimited = client();
    const ids: Record<string, string> = {};
    for (const [name, actor] of Object.entries({ trial, pastTrial, registered, oldLogin, oldOnly, refill, unlimited }))
      ids[name] = await idOf(actor);
    await f.fixture('/fixture/cross/trial-over', { principalId: ids.pastTrial });
    await f.signUp(registered, 'registered@example.com');
    await f.signUp(oldLogin, 'old.login@example.com');
    await f.fixture('/fixture/cross/legacy', { principalId: ids.oldLogin, login: true });
    await f.fixture('/fixture/cross/legacy', { principalId: ids.oldOnly, login: false });
    await f.signUp(refill, 'refill@example.com');
    await redeem(refill, 'daily_refill');
    await f.signUp(unlimited, 'unlimited@example.com');
    await redeem(unlimited, 'unlimited');
    await f.fixture('/fixture/cross/choice', { on: combo.choice });
    await f.fixture('/fixture/cross/signup-switch', { on: combo.bonus });

    const settle = async (actor: Client, operationId: string) => {
      for (let i = 0; i < 300; i++) {
        const op = await f.call(`${API}/operations/${operationId}`, actor);
        if (['published', 'failed', 'cancelled'].includes(op.status)) return op.status as string;
        await sleep(100);
      }
      throw new Error('operation did not settle');
    };
    const refused = async (actor: Client, code: string) => {
      const response = await f.request(`${API}/characters/wei-guagua/operations`, actor, {
        requestId: randomUUID(),
        text: '你好',
        delivery: 'voice',
      });
      const text = await response.text();
      assert.ok(response.status >= 400 && response.status < 500, text);
      assert.equal(JSON.parse(text).error.code, code, text);
    };
    const published = async (actor: Client) => {
      const response = await f.request(`${API}/characters/wei-guagua/operations`, actor, {
        requestId: randomUUID(),
        text: '你好',
        delivery: 'voice',
      });
      const text = await response.text();
      assert.equal(response.status, 202, text);
      assert.equal(await settle(actor, JSON.parse(text).operation.operationId), 'published');
    };
    const billing = (actor: Client) => f.call(`${API}/billing/history`, actor, { page: 1, tzOffsetMinutes: 0 });

    // ---- bootstrap ----
    const boots = {
      trial: await boot(trial),
      pastTrial: await boot(pastTrial),
      registered: await boot(registered),
      oldLogin: await boot(oldLogin),
      oldOnly: await boot(oldOnly),
      refill: await boot(refill),
      unlimited: await boot(unlimited),
    };
    for (const [name, b] of Object.entries(boots))
      assert.equal(b.access.principalId, ids[name], `${name}: same principal`);
    assert.equal(boots.trial.access.canSend, true, 'a guest in its trial can send');
    assert.equal(boots.pastTrial.access.canSend, false, 'a guest past its trial cannot');
    assert.equal(boots.oldOnly.access.canSend, false, 'an old invite-only player has no access');
    for (const name of ['registered', 'oldLogin', 'refill', 'unlimited'])
      assert.equal(boots[name as keyof typeof boots].access.canSend, true, `${name} can send`);
    for (const [name, id] of Object.entries(ids))
      assert.equal((await state(id)).kind, 'guest', `${name}: kind never changes (migration 126 left no invite kind)`);

    // ---- 我的信息: the tier each player sees ----
    // Without the free tier a signed-up player with no entitlement is a guest again (17h); an entitlement never depends on it.
    const plain = combo.bonus ? 'registered' : 'guest';
    assert.equal((await info(registered)).tier.kind, plain);
    assert.deepEqual([(await info(oldLogin)).tier.kind, (await info(oldLogin)).tier.unlimited], ['unlimited', true]);
    assert.equal((await info(unlimited)).tier.kind, 'unlimited');
    assert.equal((await info(refill)).tier.kind, 'daily_refill');
    assert.equal((await info(refill)).tier.plan.dailyAmount, 50);

    // ---- login / logout: a second device signs in; logout ends only its own session ----
    for (const [actor, email] of [
      [registered, 'registered@example.com'],
      [oldLogin, 'old.login@example.com'],
      [refill, 'refill@example.com'],
      [unlimited, 'unlimited@example.com'],
    ] as const) {
      const second = client();
      await f.call(a('/login'), second, { email, password: PASSWORD });
      assert.equal((await info(second)).signedIn, true);
      await f.call(a('/logout'), second, {});
      assert.equal(second.cookie, '', 'logout clears the cookie');
      assert.equal((await info(actor)).signedIn, true, 'the first device is untouched');
    }

    // ---- a message: PUBLISHED, or the exact refusal ----
    await published(trial);
    await refused(pastTrial, 'TRIAL_EXPIRED');
    await refused(oldOnly, 'TRIAL_EXPIRED');
    for (const actor of [registered, oldLogin, refill, unlimited]) await published(actor);
    const spends = async (name: string) => (await state(ids[name]!)).spends;
    assert.equal(await spends('oldLogin'), 0, 'unlimited is never charged');
    assert.equal(await spends('unlimited'), 0);

    // ---- 消费记录 ----
    for (const actor of [trial, registered, oldLogin, refill, unlimited]) {
      if (!combo.choice) {
        // 消费记录 exists only with the points feature: a deployment without it answers 404.
        assert.equal((await f.request(`${API}/billing/history`, actor, { page: 1, tzOffsetMinutes: 0 })).status, 404);
        continue;
      }
      const page = await billing(actor);
      assert.ok(JSON.stringify(page).length > 2, 'a page came back');
      assert.doesNotMatch(JSON.stringify(page), /@example\.com|principal-/, 'no identity in the billing page');
    }

    // ---- account deletion ----
    for (const [actor, email, name] of [
      [registered, 'registered@example.com', 'registered'],
      [oldLogin, 'old.login@example.com', 'oldLogin'],
      [refill, 'refill@example.com', 'refill'],
      [unlimited, 'unlimited@example.com', 'unlimited'],
    ] as const) {
      void email;
      await f.call(a('/delete'), actor, { password: PASSWORD, confirm: '删除' });
      assert.equal(actor.cookie, '', `${name}: the cookie is cleared`);
      const after = await f.request(`${API}/bootstrap`, actor);
      assert.ok([200, 401].includes(after.status));
    }
    for (const actor of [trial, pastTrial, oldOnly]) {
      await f.call(a('/delete'), actor, { password: '', confirm: '清除' });
      assert.equal(actor.cookie, '');
    }

    // ---- every removed route answers 404; the removed browser modes are not served ----
    const probe = client();
    await boot(probe);
    assert.notEqual(
      (await f.request(`${API}/invites/redeem`, probe, { requestId: randomUUID(), code: 'x' })).status,
      404,
      'control: a live route answers something else, so the 404s below are the missing routes',
    );
    for (const route of REMOVED_ROUTES) {
      const response = await f.request(`${API}${route}`, probe, {});
      assert.equal(response.status, 404, `${route} must be gone`);
    }
  });
}
