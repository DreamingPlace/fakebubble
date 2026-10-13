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

/** Same real-HTTP fixture as web-signup-bonus-http.integration.test.ts (SIGNUP_BONUS_ENABLED on). */
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

const DAY = 24 * HOUR;
type Window = { state: string; started_at: number; expires_at: number };
const age = (f: ReturnType<typeof setup>, principalId: string, ms: number) =>
  f.fixture<Window>('/fixture/age-principal', { principalId, ms });
const snapshot = (f: ReturnType<typeof setup>, principalId: string) =>
  f.fixture<Bonus>('/fixture/bonus-state', { principalId });

test('Part 17c: the guest trial lasts 7 days from the first reply; day 1, 3 and 6.9 are admitted; at 7 days nothing is reserved', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const guest = client();
  const principalId = (await f.boot(guest)).access.principalId as string;
  await f.reply(guest);
  const first = await age(f, principalId, 0);
  assert.equal(first.expires_at - first.started_at, 7 * DAY, 'a counted first reply opens a 7 day window');
  assert.equal(((await f.boot(guest)).access.trialExpiresAt as number) - first.started_at, 7 * DAY);

  await age(f, principalId, DAY); // day 1
  await f.reply(guest);
  await age(f, principalId, 2 * DAY); // day 3
  await f.reply(guest);
  await age(f, principalId, 3.9 * DAY); // day 6.9: the 4th reply is an extra one inside the window
  assert.equal((await f.boot(guest)).access.canSend, true);
  await f.reply(guest);

  const before = await snapshot(f, principalId);
  assert.deepEqual([before.trialOps, before.extraOps, before.principal.trial_used], [3, 1, 3]);
  await age(f, principalId, 0.2 * DAY); // 7.1 days after the first reply
  const refused = await f.send(guest, 'wei-guagua', 410);
  assert.equal(refused.error.code, 'TRIAL_EXPIRED');
  assert.deepEqual(
    await snapshot(f, principalId),
    before,
    'no IP slot, trial counter or free-operation row was reserved',
  );
});

test('Part 17c: a guest whose first reply is an extra one (its IP counters are spent) also gets 7 days', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const ip = '198.51.100.20';
  const other = client(ip);
  await f.boot(other);
  for (let n = 0; n < 3; n++) await f.reply(other); // the IP lifetime quota (3 counted replies) is spent
  const guest = client(ip);
  const principalId = (await f.boot(guest)).access.principalId as string;
  await f.reply(guest); // an extra reply: it starts the window
  const window = await age(f, principalId, 0);
  assert.equal(window.state, 'active');
  assert.equal(window.expires_at - window.started_at, 7 * DAY);
  assert.equal((await snapshot(f, principalId)).extraOps, 1);
});

test('Part 17c: a guest session created with the flag on lasts 14 days; the cookie works on day 10 (grace off) and day 13 (grace on)', async (t) => {
  for (const grace of [false, true]) {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', { signupEnabled: true, ...(grace ? { graceMs: 7 * DAY } : {}) });
    const guest = client();
    const principalId = (await f.boot(guest)).access.principalId as string;
    assert.deepEqual(await f.fixture('/fixture/session-lifetime', { principalId }), { lifetime: 14 * DAY });
    await f.reply(guest);
    await age(f, principalId, 10 * DAY);
    const day10 = await f.boot(guest);
    assert.equal(day10.access.principalId, principalId, `day 10, grace ${grace}: the same guest, not a new one`);
    assert.equal(day10.access.canSend, false);
    await age(f, principalId, 3 * DAY);
    const day13 = await f.boot(guest);
    assert.equal(day13.access.principalId, principalId, `day 13, grace ${grace}: the same guest`);
    await age(f, principalId, 2 * DAY);
    assert.equal(
      (await f.request(`${API}/bootstrap`, guest)).status,
      401,
      `day 15, grace ${grace}: the session has ended`,
    );
  }
});

test('Part 17c: a signed-up guest keeps its bonus after day 7', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const guest = client();
  const principalId = (await f.boot(guest)).access.principalId as string;
  await f.reply(guest);
  assert.equal((await f.signUp(guest, 'late.bonus@example.com')).bonus, 10);
  await age(f, principalId, 8 * DAY);
  const access = (await f.boot(guest)).access;
  assert.deepEqual([access.canSend, access.remainingReplies], [true, 10]);
  await f.reply(guest, 'jojo');
  assert.equal((await snapshot(f, principalId)).bonusOps, 1);
});

test('Part 17c: one bonus per inbox (+tags, gmail dots, googlemail); unrelated addresses still get 10', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const signUp = async (email: string, peer: string) => {
    const guest = client(peer);
    await f.boot(guest);
    const result = await f.signUp(guest, email);
    await f.fixture('/fixture/age-challenges', { ms: 120_000 });
    return result.bonus as number;
  };
  assert.equal(await signUp('ab@gmail.com', '198.51.100.31'), 10);
  assert.equal(await signUp('a.b+1@gmail.com', '198.51.100.32'), 0);
  assert.equal(await signUp('ab@googlemail.com', '198.51.100.33'), 0);
  assert.equal(await signUp('x@example.com', '198.51.100.34'), 10);
  assert.equal(await signUp('x+y@example.com', '198.51.100.35'), 0);
  assert.equal(await signUp('a.b@example.com', '198.51.100.36'), 10, 'dots only count for gmail');
  assert.equal(await signUp('someone.else@example.org', '198.51.100.37'), 10);
});

test('Part 17c: IPv6 clients are limited per /64, not per address (trial quota and signup cap)', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  // Lifetime trial quota: one /64 is one IP.
  const v6a = client('2001:db8:1:2::1');
  const principalA = (await f.boot(v6a)).access.principalId as string;
  for (let n = 0; n < 5; n++) await f.reply(v6a);
  assert.equal((await snapshot(f, principalA)).ipQuota.length, 1);
  const sameBlock = client('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  assert.equal(
    (await f.boot(sameBlock)).access.remainingReplies,
    0,
    'another address of the same /64 shares the quota',
  );
  assert.equal((await f.send(sameBlock, 'wei-guagua', 403)).error.code, 'TRIAL_EXHAUSTED');
  const otherBlock = client('2001:db8:1:3::1');
  assert.equal((await f.boot(otherBlock)).access.remainingReplies, 5, 'a different /64 has its own quota');
  await f.reply(otherBlock);
  assert.equal((await snapshot(f, principalA)).ipQuota.length, 2);
  // IPv4-mapped IPv6 is the IPv4 address itself.
  const plain = client('203.0.113.40');
  await f.boot(plain);
  await f.reply(plain);
  const mapped = client('::ffff:203.0.113.40');
  assert.equal((await f.boot(mapped)).access.remainingReplies, 4, 'the mapped form shares the IPv4 quota');

  // Signup cap: 3 per IP per day, per /64.
  for (let n = 1; n <= 3; n++) {
    const guest = client(`2001:db8:9:9::${n}`);
    await f.boot(guest);
    assert.equal((await f.signUp(guest, `v6.signup${n}@example.com`)).bonus, 10);
    await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  }
  const fourth = client('2001:db8:9:9:1234::1');
  await f.boot(fourth);
  const refused = await f.request(a('/request-code'), fourth, { purpose: 'signup', email: 'v6.signup4@example.com' });
  assert.equal(refused.status, 429);
  const elsewhere = client('2001:db8:9:a::1');
  await f.boot(elsewhere);
  assert.equal((await f.signUp(elsewhere, 'v6.other@example.com')).bonus, 10);
});
