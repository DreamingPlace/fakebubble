import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
const HOUR = 60 * 60_000;
type Client = { cookie: string; csrf: string; peer?: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
const client = (peer?: string): Client => ({ cookie: '', csrf: '', ...(peer ? { peer } : {}) });
const a = (path: string) => `${API}/account${path}`;

/** Real HTTP into workerd SQLite with SIGNUP_BONUS_ENABLED on (tests/web/fixtures/cloudflare-http-bonus-worker.ts). */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-bonus-worker.ts',
    { STATE: 'WebHTTPBonusFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...(actor.peer ? { 'x-fixture-peer': actor.peer } : {}),
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
  const send = (actor: Client, characterId: string, status = 202) =>
    call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId: randomUUID(), text: '免费消息', delivery: 'voice' },
      status,
    );
  const settle = async (actor: Client, id: string) => {
    const end = Date.now() + 30_000;
    while (true) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  /** One reply, sent and finished. */
  const reply = async (actor: Client, characterId = 'wei-guagua') => {
    const sent = await send(actor, characterId);
    assert.equal((await settle(actor, sent.operation.operationId)).status, 'published');
  };
  /** Request → verify → complete for the actor's current guest session. */
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email });
    const mail = (await mails(before + 1)).at(-1)!;
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '阿泡' });
  };
  const boot = (actor: Client) => call(`${API}/bootstrap`, actor);
  return { ...runtime, request, call, send, settle, reply, signUp, boot, mails, fixture: runtime.call };
}
type Bonus = {
  grant: number;
  bonusOps: number;
  bonusOpsLive: number;
  entitledOps: number;
  extraOps: number;
  trialOps: number;
  principal: { trial_used: number; trial_reserved: number };
  ipQuota: { used_total: number; reserved_total: number }[];
  emails: { email_hmac: string }[];
  ipDaily: { day: string; signups: number }[];
};

test('the free tier: a guest has 5 trial replies; signing up adds 10 that work after the trial, for any character, off the IP quota', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  assert.deepEqual((await f.call(a(''), client())).features, { signupBonus: 10 });

  const guest = client();
  const first = await f.boot(guest);
  const principalId = first.access.principalId as string;
  assert.equal(first.access.remainingReplies, 5, 'the guest trial is 5 now');
  // Signing up grants the bonus once and tells the page how much.
  const signedUp = await f.signUp(guest, 'Bonus.One@example.com');
  assert.deepEqual(signedUp, { nickname: '阿泡', emailMasked: 'B***@example.com'.replace('B', 'b'), bonus: 10 });
  const state0 = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.equal(state0.grant, 1);
  let access = (await f.boot(guest)).access;
  assert.deepEqual([access.remainingReplies, access.canSend, access.lockedCharacterId], [15, true, null]);

  // The trial is used first, on the first character; it is the only thing that touches the per-IP lifetime quota.
  for (let n = 0; n < 5; n++) await f.reply(guest);
  let state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  // Replies 1-3 use the existing counters and the IP lifetime quota; replies 4 and 5 are the extra trial replies.
  assert.deepEqual([state.principal.trial_used, state.trialOps, state.extraOps, state.bonusOps], [3, 3, 2, 0]);
  assert.deepEqual(state.ipQuota, [{ used_total: 3, reserved_total: 0 }]);
  access = (await f.boot(guest)).access;
  assert.deepEqual([access.remainingReplies, access.canSend], [10, true]);

  // The 6th reply goes to ANOTHER character (the trial lock does not apply to the bonus) and is paid by the bonus.
  await f.reply(guest, 'jojo');
  state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.deepEqual([state.bonusOps, state.bonusOpsLive, state.entitledOps, state.trialOps], [1, 1, 3, 3]);
  assert.deepEqual(state.ipQuota, [{ used_total: 3, reserved_total: 0 }], 'bonus replies never touch the IP quota');
  assert.equal((await f.boot(guest)).access.remainingReplies, 9);

  // After the trial WINDOW ended too (a kept account): the bonus still works, with any character.
  await f.fixture('/fixture/retention-expire', { principalId, agoMs: 3 * HOUR });
  access = (await f.boot(guest)).access;
  assert.deepEqual([access.remainingReplies, access.canSend], [9, true], 'the ended window costs the bonus nothing');
  await f.reply(guest, 'chen-jimi');
  await f.reply(guest, 'wei-guagua');
  state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.deepEqual([state.bonusOps, state.bonusOpsLive], [3, 3]);
  assert.deepEqual(state.ipQuota, [{ used_total: 3, reserved_total: 0 }]);

  // Use the rest up: the 10th is the last; the next is refused with the exhausted code and the page can show it.
  for (let n = 0; n < 7; n++) await f.reply(guest, n % 2 ? 'jojo' : 'wei-guagua');
  access = (await f.boot(guest)).access;
  assert.deepEqual([access.remainingReplies, access.canSend], [0, false]);
  const refused = await f.send(guest, 'wei-guagua', 403);
  assert.equal(refused.error.code, 'TRIAL_EXHAUSTED');
  state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.deepEqual([state.bonusOps, state.bonusOpsLive], [10, 10], 'a refusal reserves nothing');
});

test('a guest that never signed up gets the 5-reply trial only, and the exhausted answer is the old one', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const guest = client();
  const principalId = (await f.boot(guest)).access.principalId as string;
  for (let n = 0; n < 5; n++) await f.reply(guest);
  const access = (await f.boot(guest)).access;
  assert.deepEqual([access.remainingReplies, access.canSend], [0, false]);
  assert.equal((await f.send(guest, 'wei-guagua', 403)).error.code, 'TRIAL_EXHAUSTED');
  const state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.deepEqual([state.grant, state.bonusOps, state.trialOps, state.extraOps], [0, 0, 3, 2]);
  // The IP quota is shared: another guest on the same address has nothing left either (lifetime, not daily).
  const other = client();
  const otherBoot = await f.boot(other);
  assert.equal(otherBoot.access.remainingReplies, 0);
  assert.equal((await f.send(other, 'wei-guagua', 403)).error.code, 'TRIAL_EXHAUSTED');
  // ...until it signs up: the bonus does not depend on the exhausted IP quota.
  await f.signUp(other, 'second.guest@example.com');
  const opened = (await f.boot(other)).access;
  assert.deepEqual([opened.remainingReplies, opened.canSend], [10, true]);
  await f.reply(other, 'jojo');
  assert.deepEqual((await f.fixture<Bonus>('/fixture/bonus-state', { principalId })).ipQuota, [
    { used_total: 3, reserved_total: 0 },
  ]);
});

test('the bonus is granted once per verified address, even across delete and re-signup; only a keyed digest remains', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const email = 'Once.Only@Example.com';
  const player = client();
  const firstId = (await f.boot(player)).access.principalId as string;
  assert.equal((await f.signUp(player, email)).bonus, 10);
  assert.equal((await f.fixture<Bonus>('/fixture/bonus-state', { principalId: firstId })).grant, 1);
  await f.reply(player, 'jojo');

  assert.deepEqual(await f.call(a('/delete'), player, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: true,
  });
  const after = await f.fixture<Bonus>('/fixture/bonus-state', { principalId: firstId });
  assert.deepEqual([after.grant, after.bonusOps], [0, 0], 'the entitlement and its markers go with the player');
  assert.equal(after.emails.length, 1, 'the address digest is the one thing that stays');
  assert.match(after.emails[0]!.email_hmac, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(after).toLowerCase().includes('once.only'), 'no address anywhere');
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId: firstId }), {
    clean: true,
    loginsRemain: false,
  });

  // The same address signs up again on a fresh guest: it signs up, but there is no second bonus.
  const again = client();
  const secondId = (await f.boot(again)).access.principalId as string;
  await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  const second = await f.signUp(again, email.toLowerCase());
  assert.equal(second.bonus, 0);
  assert.equal((await f.fixture<Bonus>('/fixture/bonus-state', { principalId: secondId })).grant, 0);
  const access = (await f.boot(again)).access;
  // Trial only - and the address is shared with the first player (one reply of its 5 was already spent from this IP).
  assert.equal(access.remainingReplies, 4);
  // A different address still gets its own.
  const third = client();
  await f.boot(third);
  assert.equal((await f.signUp(third, 'someone.else@example.com')).bonus, 10);
  assert.equal((await f.fixture<Bonus>('/fixture/bonus-state', { principalId: firstId })).emails.length, 2);
});

test('at most 3 signups per IP per UTC day: the 4th is refused with a retry-later answer; another address is not affected', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const ip = '198.51.100.7';
  for (let n = 1; n <= 3; n++) {
    const guest = client(ip);
    await f.boot(guest);
    assert.equal((await f.signUp(guest, `ip.signup${n}@example.com`)).bonus, 10);
    await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  }
  const state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId: 'none' });
  assert.deepEqual(
    state.ipDaily.map((row) => row.signups),
    [3],
  );
  const fourth = client(ip);
  await f.boot(fourth);
  const refused = await f.request(a('/request-code'), fourth, { purpose: 'signup', email: 'ip.signup4@example.com' });
  assert.equal(refused.status, 429);
  const body = (await refused.json()) as { error: { code: string; retryAfterMs: number } };
  assert.equal(body.error.code, 'PLAYER_SIGNUP_IP_LIMIT');
  assert.ok(body.error.retryAfterMs > 0 && body.error.retryAfterMs <= 24 * HOUR);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  // Login and the other flows of the same IP still work; so does a signup from another address.
  const elsewhere = client('203.0.113.9');
  await f.boot(elsewhere);
  assert.equal((await f.signUp(elsewhere, 'ip.other@example.com')).bonus, 10);
});

test('invite holders are unaffected: no bonus counts against them, their entitlement and limits are as before', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client(),
    player = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const code = (
    await f.call(
      `${API}/admin/invites/issue`,
      owner,
      { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: '免费消息', note: null },
      201,
    )
  ).code as string;
  const principalId = (await f.boot(player)).access.principalId as string;
  await f.signUp(player, 'invited.bonus@example.com');
  await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code }, 201);
  const access = (await f.boot(player)).access;
  assert.equal(access.kind, 'invite');
  assert.deepEqual([access.remainingReplies, access.canSend], [null, true]);
  await f.reply(player, 'jojo');
  const state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId });
  assert.deepEqual(
    [state.bonusOps, state.entitledOps, state.trialOps],
    [0, 1, 0],
    'an invited reply is not a bonus reply',
  );
  assert.deepEqual(state.ipQuota, [], 'and it touches no IP quota');
});

test('the per-IP signup limit is also enforced when the signup completes, not only when the code is requested', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const ip = '198.51.100.20';
  for (let n = 1; n <= 2; n++) {
    const guest = client(ip);
    await f.boot(guest);
    await f.signUp(guest, `race.${n}@example.com`);
    await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  }
  // Two signups are done: a third and a fourth person both ask for a code while one slot is left.
  const third = client(ip),
    fourth = client(ip);
  await f.boot(third);
  await f.boot(fourth);
  const ask = async (actor: Client, email: string) => {
    const before = (await f.fixture<Mail[]>('/fixture/player-mail')).length;
    const challenge = await f.call(a('/request-code'), actor, { purpose: 'signup', email });
    const mail = (await f.mails(before + 1)).at(-1)!;
    await f.call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return challenge.challengeId as string;
  };
  const thirdChallenge = await ask(third, 'race.3@example.com');
  await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  const fourthChallenge = await ask(fourth, 'race.4@example.com');
  const finish = (actor: Client, challengeId: string, status: number) =>
    f.call(a('/signup'), actor, { challengeId, password: PASSWORD, nickname: '抢号' }, status);
  assert.equal((await finish(third, thirdChallenge, 200)).bonus, 10);
  const refused = await finish(fourth, fourthChallenge, 429);
  assert.equal(refused.error.code, 'PLAYER_SIGNUP_IP_LIMIT');
  assert.ok(refused.error.retryAfterMs > 0);
  // Nothing was created for the refused one: no login, no bonus, and the address stays free for another day.
  const state = await f.fixture<Bonus>('/fixture/bonus-state', { principalId: 'none' });
  assert.deepEqual(
    state.ipDaily.map((row) => row.signups),
    [3],
  );
  assert.equal(state.emails.length, 3);
});
