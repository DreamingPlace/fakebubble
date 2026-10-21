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
 * Part 22a follow-up, item 5 (Part 22x: the old data is the shape migration 126 leaves). ONE real-HTTP workerd database holding
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

test('22a cross-path: old and new invite data side by side over real HTTP - tier, charge and display for each player', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const state = (principalId: string) => f.fixture<State>('/fixture/cross/state', { principalId });
  const boot = async (actor: Client) => (await f.call(`${API}/bootstrap`, actor)).access.principalId as string;
  const batch = (kind: 'daily_refill' | 'unlimited', count = 2, status = 201) =>
    f.call(
      `${API}/admin/invites/batch-create`,
      owner,
      {
        requestId: randomUUID(),
        name: kind,
        count,
        tier: kind === 'daily_refill' ? { kind, dailyAmount: 50, cap: 120 } : { kind },
        durationDays: null,
        redeemBy: null,
      },
      status,
    );
  const redeem = (actor: Client, code: string, status = 201) =>
    f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code }, status);
  const info = (actor: Client) => f.call(a(''), actor);

  // A: an OLD invited player WITH a login (a guest holding the backfilled unlimited entitlement).
  const A = client();
  const aId = await boot(A);
  await f.signUp(A, 'old.login@example.com');
  const aLegacy = await f.fixture<{ inviteId: string }>('/fixture/cross/legacy', {
    principalId: aId,
    login: true,
  });
  // A2: the same shape, ended later too.
  const A2 = client();
  const a2Id = await boot(A2);
  await f.signUp(A2, 'old.login2@example.com');
  const a2Legacy = await f.fixture<{ inviteId: string }>('/fixture/cross/legacy', {
    principalId: a2Id,
    login: true,
  });
  // B: an OLD invited player WITHOUT a login: after migration 126 an expired guest.
  const B = client();
  const bId = await boot(B);
  await f.fixture<{ inviteId: string }>('/fixture/cross/legacy', {
    principalId: bId,
    login: false,
  });
  // D: a plain registered player.
  const D = client();
  const dId = await boot(D);
  await f.signUp(D, 'plain@example.com');
  // C: a NEW daily_refill holder (a signed-up player redeeming a code).
  const C = client();
  const cId = await boot(C);
  await f.signUp(C, 'new.holder@example.com');
  const made = await batch('daily_refill', 4);
  const codes = made.codes as string[];
  assert.equal((await redeem(C, codes[0]!)).entitlement.kind, 'daily_refill');

  // ---- 1. Start: tier and display of each. ----
  assert.deepEqual([(await info(A)).tier.kind, (await info(A)).tier.unlimited], ['unlimited', true]);
  assert.equal((await state(aId)).kind, 'guest', 'an old invite player is a guest after migration 126');
  assert.equal((await info(C)).tier.kind, 'daily_refill');
  assert.deepEqual((await info(C)).tier.plan, { kind: 'daily_refill', dailyAmount: 50, cap: 120, expiresAt: null });
  assert.equal((await info(D)).tier.kind, 'registered');
  assert.equal((await info(D)).tier.plan, undefined);
  const bBoot = await f.call(`${API}/bootstrap`, B);
  assert.deepEqual([bBoot.access.kind, bBoot.access.canSend], ['guest', false], 'the invite-only player has no access');

  // ---- 2. Charge: unlimited players are never charged; metered ones pay. ----
  const d0 = (await state(dId)).balance!,
    c0 = (await state(cId)).balance!;
  for (const actor of [A, C, D]) assert.equal(await f.reply(actor), 'published');
  assert.equal((await state(aId)).spends, 0, 'old login holder: unlimited, no spend');
  assert.equal((await state(bId)).spends, 0, 'old invite-only holder: no access, no spend');
  assert.equal((await state(cId)).spends, 1, 'new refill holder pays points');
  assert.equal((await state(dId)).spends, 1, 'registered pays points');
  assert.ok((await state(dId)).balance! < d0 && (await state(cId)).balance! < c0);

  // ---- 3. Model choice OFF: nothing falls onto the legacy path; refill needs points; unlimited still works. ----
  await f.fixture('/fixture/cross/choice', { on: false });
  assert.equal((await info(A)).tier.kind, 'unlimited', 'an entitlement holder never depends on the free-tier switch');
  assert.equal(await f.reply(A), 'published');
  assert.equal((await state(aId)).spends, 0);
  const E = client();
  const eId = await boot(E);
  await f.signUp(E, 'switch.off@example.com');
  assert.equal(
    (await redeem(E, codes[1]!, 409)).error.code,
    'WEB_INVITE_UNUSABLE',
    'a daily_refill code needs points: refused, with the code untouched',
  );
  assert.equal(
    (await batch('daily_refill', 1, 409)).error.code,
    'WEB_INVITE_POINTS_REQUIRED',
    'no daily_refill batch while points are off',
  );
  const unlimited = await batch('unlimited', 1);
  assert.equal((await redeem(E, unlimited.codes[0]!)).entitlement.kind, 'unlimited');
  assert.equal((await state(eId)).kind, 'guest', 'redemption never changes the principal kind');
  assert.equal((await info(E)).tier.kind, 'unlimited');
  assert.equal(await f.reply(E), 'published');
  assert.equal((await state(eId)).spends, 0, 'unlimited: never charged with model choice off');
  // ---- 4. Model choice ON again: the refused code was never consumed. ----
  await f.fixture('/fixture/cross/choice', { on: true });
  const F = client();
  const fId = await boot(F);
  await f.signUp(F, 'switch.on@example.com');
  assert.equal((await redeem(F, codes[1]!)).entitlement.kind, 'daily_refill');
  assert.equal((await info(F)).tier.kind, 'daily_refill');
  assert.equal((await info(A)).tier.kind, 'unlimited');
  // Signup bonus switch off and on: no entitlement holder moves.
  for (const on of [false, true]) {
    await f.fixture('/fixture/cross/signup-switch', { on });
    assert.deepEqual(
      [(await info(A)).tier.kind, (await info(C)).tier.kind, (await info(D)).tier.kind],
      // Without the free tier a plain signed-up player is a guest again (17h); an entitlement holder never depends on it.
      ['unlimited', 'daily_refill', on ? 'registered' : 'guest'],
      `signup bonus ${on}`,
    );
  }

  // ---- 5. A refill across a UTC midnight: +N once, clamped to the cap, never above. ----
  const cBefore = await state(cId);
  await f.fixture('/fixture/cross/rewind-refill', { principalId: cId });
  const next = (await info(C)).modelChoice.balance as number;
  assert.equal(next, Math.min(120, cBefore.balance! + 50), 'the new day paid +50, clamped to the cap of 120');
  assert.equal((await state(cId)).refills, cBefore.refills + 1);
  assert.equal((await info(C)).modelChoice.balance, next, 'once a day');

  // ---- 6. Revoke: the entitlement page ends A and A2. ----
  await f.call(`${API}/admin/invites/entitlement-revoke`, owner, { id: aLegacy.inviteId });
  await f.call(`${API}/admin/invites/entitlement-revoke`, owner, { id: a2Legacy.inviteId });
  for (const [actor, id, email] of [
    [A, aId, 'old.login@example.com'],
    [A2, a2Id, 'old.login2@example.com'],
  ] as const) {
    // Named exception (Part 22x): a revoked entitlement no longer ends the player's sessions (only the legacy grant did); the
    // player stays signed in and is registered at once. A fresh login on the same account changes nothing.
    assert.equal((await info(actor)).signedIn, true);
    actor.cookie = '';
    await f.call(a('/login'), actor, { email, password: PASSWORD });
    const after = await info(actor);
    assert.equal(after.tier.kind, 'registered', 'a registered player with the balance that remains - never unlimited');
    assert.equal(after.modelChoice.unlimited, undefined);
    assert.equal(typeof after.modelChoice.balance, 'number');
    const spends = (await state(id)).spends;
    assert.equal(await f.reply(actor), 'published');
    assert.equal((await state(id)).spends, spends + 1, 'charged now');
  }

  // ---- 7. Expiry: the new holder lapses into a registered player with its remaining balance. ----
  const cRemaining = (await state(cId)).balance;
  await f.fixture('/fixture/cross/expire', { principalId: cId });
  const lapsed = await info(C);
  assert.equal(lapsed.tier.kind, 'registered');
  assert.equal(lapsed.modelChoice.balance, cRemaining, 'nothing taken, nothing refilled');
  assert.equal((await f.call(`${API}/bootstrap`, C)).access.canSend, true, 'never a trial-ended state');
  assert.equal(fId.length > 0 && (await info(F)).tier.kind, 'daily_refill', 'the other holder is untouched');
});
