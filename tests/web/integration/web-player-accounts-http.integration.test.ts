// Part 21i (named exception): login answers PLAYER_EMAIL_NOT_REGISTERED / PLAYER_PASSWORD_WRONG instead of the generic
// PLAYER_LOGIN_INVALID (owner decision); every status code and limit is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
const client = (): Client => ({ cookie: '', csrf: '' });

/** Real HTTP into workerd SQLite, the same harness as the other Cloudflare HTTP tests. */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: 'WebHTTPFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown, headers: Record<string, string> = {}) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...headers,
        'x-fixture-host': headers.host ?? 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const seen: string[] = [];
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
    if (setCookie) {
      seen.push(setCookie);
      actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    }
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  /** The mails the fixture's mailer accepted (sent after the response, so wait for the expected count). */
  const mails = async (count: number): Promise<Mail[]> => {
    for (let i = 0; i < 100; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length >= count) return list;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('mail not sent');
  };
  const age = () => runtime.call('/fixture/age-challenges', { ms: 120_000 });
  return { ...runtime, request, call, mails, age, seen, fixture: runtime.call };
}
const a = (path: string) => `${API}/account${path}`;

test('accounts over real HTTP: signup, login on a second device, reset, dead cookies, redeem gate', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const first = client(),
    second = client(),
    third = client(),
    stranger = client();
  const email = 'Player.One@Example.com';

  // Signup is closed by default: the page can tell, login still answers, nothing is sent.
  assert.deepEqual(await f.call(a(''), stranger), { signupEnabled: false, signedIn: false });
  await f.call(`${API}/bootstrap`, first);
  const closed = await f.call(a('/request-code'), first, { purpose: 'signup', email }, 403);
  assert.equal(closed.error.code, 'PLAYER_SIGNUP_DISABLED');
  assert.equal(
    (await f.call(a('/login'), stranger, { email, password: PASSWORD }, 401)).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );

  await f.fixture('/fixture/players', { signupEnabled: true });
  assert.deepEqual(await f.call(a(''), stranger), { signupEnabled: true, signedIn: false });
  const principalFirst = (await f.call(`${API}/bootstrap`, first)).access.principalId as string;

  // Wrong origin / missing CSRF are refused before anything is read.
  assert.equal(
    (await f.call(a('/request-code'), first, { purpose: 'signup', email }, 403, { origin: 'https://evil.invalid' }))
      .error.code,
    'ORIGIN_INVALID',
  );
  assert.equal(
    (await f.call(a('/request-code'), { ...first, csrf: 'x'.repeat(43) }, { purpose: 'signup', email }, 403)).error
      .code,
    'CSRF_INVALID',
  );
  assert.equal(
    (await f.request(a('/request-code'), { cookie: '', csrf: '' }, { purpose: 'signup', email })).status,
    401,
  );
  assert.equal(
    (await f.call(a('/login'), stranger, { email, password: PASSWORD }, 403, { origin: 'https://evil.invalid' })).error
      .code,
    'ORIGIN_INVALID',
  );
  assert.equal(
    (await f.call(a('/login'), stranger, { email, password: PASSWORD }, 403, { 'sec-fetch-site': 'cross-site' })).error
      .code,
    'ORIGIN_INVALID',
  );
  assert.equal(
    (await f.call(a('/signed-out'), stranger, {}, 403, { origin: 'https://evil.invalid' })).error.code,
    'ORIGIN_INVALID',
  );
  assert.equal((await f.call(a('/nickname'), first, { nickname: 'x' }, 409)).error.code, 'PLAYER_LOGIN_REQUIRED');

  // 注册: the answer has the same three fields whatever the address is; a second ask within a minute is limited.
  const challenge = await f.call(a('/request-code'), first, { purpose: 'signup', email });
  assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'expiresAt', 'resendAfterMs']);
  const limited = await f.request(a('/request-code'), first, { purpose: 'signup', email });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '60');
  assert.equal(((await limited.json()) as any).error.code, 'PLAYER_RATE_LIMITED');
  const [mail] = await f.mails(1);
  assert.equal(mail!.kind, 'code');
  assert.equal(mail!.to, 'player.one@example.com');
  assert.match(mail!.code!, /^[0-9]{6}$/);
  const wrong = mail!.code === '000000' ? '111111' : '000000';
  assert.equal(
    (await f.call(a('/verify-code'), first, { challengeId: challenge.challengeId, code: wrong }, 400)).error.code,
    'PLAYER_CODE_INVALID',
  );
  await f.call(a('/verify-code'), first, { challengeId: challenge.challengeId, code: mail!.code });
  assert.equal(
    (
      await f.call(
        a('/signup'),
        first,
        { challengeId: challenge.challengeId, password: 'short', nickname: '阿泡' },
        400,
      )
    ).error.code,
    'PLAYER_PASSWORD_INVALID',
  );
  const before = first.cookie;
  const signedUp = await f.call(a('/signup'), first, {
    challengeId: challenge.challengeId,
    password: PASSWORD,
    nickname: ' 阿泡 ',
  });
  assert.deepEqual(signedUp, { nickname: '阿泡', emailMasked: 'p***@example.com' });
  assert.equal(first.cookie, before, 'same session, same cookie value');
  assert.match(f.seen.at(-1)!, /; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=34560000$/, 'the 400-day cookie');
  const info = await f.call(a(''), first);
  assert.deepEqual(info, {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: true,
    emailMasked: 'p***@example.com',
    nickname: '阿泡',
    // Named exception (Part 22a): a signed-up player now also gets its 玩家编号 (8 Crockford characters) in this answer.
    playerNumber: info.playerNumber,
    // Named exception (Part 22a follow-up): the answer carries the EFFECTIVE tier; the page decides nothing from the principal kind.
    tier: { kind: 'guest', unlimited: false },
  });
  assert.match(info.playerNumber, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(
    (await f.call(a('/request-code'), first, { purpose: 'signup', email: 'again@example.com' }, 409)).error.code,
    'PLAYER_LOGIN_EXISTS',
  );

  // 登录 on a second device: same principal, first device untouched, no merge of the device's own guest.
  await f.call(`${API}/bootstrap`, second);
  const guestOfSecond = (await f.call(`${API}/bootstrap`, second)).access.principalId as string;
  assert.notEqual(guestOfSecond, principalFirst);
  assert.equal(
    (await f.call(a('/login'), second, { email, password: 'wrong password' }, 401)).error.code,
    'PLAYER_PASSWORD_WRONG',
  );
  assert.equal(
    (await f.call(a('/login'), second, { email: 'nobody@example.com', password: PASSWORD }, 401)).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );
  await f.call(a('/login'), second, { email: ` ${email.toUpperCase()} `, password: PASSWORD });
  assert.match(f.seen.at(-1)!, /Max-Age=34560000$/);
  assert.equal((await f.call(`${API}/bootstrap`, second)).access.principalId, principalFirst);
  assert.equal((await f.call(`${API}/bootstrap`, first)).access.principalId, principalFirst, 'device A still works');
  // 我的昵称 writes a new 名片 revision.
  assert.deepEqual(await f.call(a('/nickname'), second, { nickname: '小泡' }), { nickname: '小泡', revision: 2 });
  assert.equal((await f.call(a(''), first)).nickname, '小泡');

  // 退出其他设备 ends A and nothing else; 退出登录 ends this one and clears the cookie.
  await f.call(a('/login'), third, { email, password: PASSWORD });
  assert.deepEqual(await f.call(a('/logout-others'), third, {}), { ended: 2 });
  for (const dead of [first, second]) assert.equal((await f.request(`${API}/bootstrap`, dead)).status, 401);
  assert.equal((await f.call(`${API}/bootstrap`, third)).access.principalId, principalFirst);

  // A dead cookie: bootstrap answers 401 SESSION_EXPIRED and clears it; nothing is attached to a new guest.
  const dead = await f.request(`${API}/bootstrap`, first);
  assert.equal(dead.status, 401);
  assert.equal(((await dead.json()) as any).error.code, 'SESSION_EXPIRED');
  assert.match(
    dead.headers.get('set-cookie')!,
    /^__Host-fixture=; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=0$/,
  );
  // The first page's "以访客继续" path: forget the cookie (needs only the origin), then the ordinary first-visit bootstrap.
  const guest = { cookie: first.cookie, csrf: '' };
  await f.call(a('/signed-out'), guest, {});
  assert.equal(guest.cookie, '');
  const fresh = await f.call(`${API}/bootstrap`, guest);
  assert.notEqual(fresh.access.principalId, principalFirst);
  assert.equal(fresh.access.kind, 'guest');
  assert.deepEqual(await f.call(a(''), guest), {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: false,
    emailMasked: null,
    nickname: null,
    // Named exception (Part 22a follow-up): the answer carries the EFFECTIVE tier.
    tier: { kind: 'guest', unlimited: false },
  });
  // An account route for a dead cookie answers like a signed-out visitor instead of failing.
  assert.deepEqual(await f.call(a(''), { cookie: '__Host-fixture=' + 'z'.repeat(43), csrf: '' }), {
    signupEnabled: true,
    signedIn: false,
  });

  // 忘记密码: the code resets the password, every other session ends, this device is signed in fresh.
  await f.age();
  const reset = await f.call(a('/request-code'), stranger, { purpose: 'reset', email });
  const resetMail = (await f.mails(2)).at(-1)!;
  assert.deepEqual([resetMail.purpose, resetMail.kind], ['reset', 'code']);
  await f.call(a('/verify-code'), stranger, { challengeId: reset.challengeId, code: resetMail.code });
  await f.call(a('/reset'), stranger, { challengeId: reset.challengeId, password: 'a brand new pass' });
  assert.match(f.seen.at(-1)!, /Max-Age=34560000$/);
  assert.equal((await f.call(`${API}/bootstrap`, stranger)).access.principalId, principalFirst);
  assert.equal((await f.request(`${API}/bootstrap`, third)).status, 401, 'the other device was signed out');
  assert.equal(
    (await f.call(a('/login'), client(), { email, password: PASSWORD }, 401)).error.code,
    'PLAYER_PASSWORD_WRONG',
  );
  // An unknown address answers the same and sends nothing.
  await f.age();
  const mailCount = (await f.mails(2)).length;
  const ghost = await f.call(a('/request-code'), client(), { purpose: 'reset', email: 'ghost@example.com' });
  assert.deepEqual(Object.keys(ghost).sort(), Object.keys(reset).sort());
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal((await f.mails(mailCount)).length, mailCount, 'no mail for an unknown address');

  // 修改密码 and 退出登录.
  assert.equal(
    (
      await f.call(
        a('/password'),
        stranger,
        { current: 'not mine at all', next: 'another new pass', logoutOthers: false },
        401,
      )
    ).error.code,
    'PLAYER_LOGIN_INVALID',
  );
  assert.deepEqual(
    await f.call(a('/password'), stranger, {
      current: 'a brand new pass',
      next: 'another new pass',
      logoutOthers: false,
    }),
    { changed: true, otherSessionsEnded: 0 },
  );
  await f.call(a('/logout'), stranger, {});
  assert.equal(stranger.cookie, '');
  assert.equal((await f.call(a(''), stranger)).signedIn, false);
});

// Named exception (Part 22x): this test covered the legacy invite (a kind-'invite' grant, recovery code, 玩家授权 records and a
// revoked grant ending every session). That system is gone; what still applies - redeeming needs a login, the same principal
// keeps its chats, a second device logs in to it, the login survives an ended entitlement, signup closed stops sending - is
// asserted for the entitlement code flow.
test('redeeming needs a login, an ended entitlement leaves the login working, and closed signup stops sending', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client(),
    player = client(),
    other = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const issue = async () =>
    (
      await f.call(
        `${API}/admin/invites/batch-create`,
        owner,
        {
          requestId: randomUUID(),
          name: '春季内测',
          count: 1,
          tier: { kind: 'unlimited' },
          durationDays: null,
          redeemBy: null,
        },
        201,
      )
    ).codes[0] as string;
  await f.call(`${API}/bootstrap`, player);
  const code = await issue();
  // A guest without a login is sent to 注册 first; nothing is redeemed.
  assert.equal(
    (await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code }, 409)).error.code,
    'PLAYER_LOGIN_REQUIRED',
  );
  const email = 'invitee@example.com';
  const challenge = await f.call(a('/request-code'), player, { purpose: 'signup', email });
  const [mail] = await f.mails(1);
  await f.call(a('/verify-code'), player, { challengeId: challenge.challengeId, code: mail!.code });
  await f.call(a('/signup'), player, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '受邀者' });
  const principal = (await f.call(`${API}/bootstrap`, player)).access.principalId as string;
  const redeemed = await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code }, 201);
  assert.equal(redeemed.entitlement.kind, 'unlimited');
  const booted = await f.call(`${API}/bootstrap`, player);
  assert.equal(booted.access.principalId, principal, 'same principal: the chats stay');
  assert.equal(booted.access.kind, 'guest', 'redemption never changes the principal kind');
  const info = await f.call(a(''), player);
  assert.equal(info.hasLogin, true);
  assert.equal(info.tier.kind, 'unlimited');

  // A second device logs in to the same principal.
  await f.call(a('/login'), other, { email, password: PASSWORD });
  assert.equal((await f.call(`${API}/bootstrap`, other)).access.principalId, principal);
  // The entitlement ends: nobody is signed out, the login and the wrong-password answer are as before, the entitlement tier is gone.
  await f.fixture('/fixture/revoke-entitlement', { principalId: principal });
  for (const live of [player, other]) assert.equal((await f.request(`${API}/bootstrap`, live)).status, 200);
  // (This fixture runs with the free tier off, so a login alone is a guest again - never unlimited.)
  assert.equal((await f.call(a(''), player)).tier.kind, 'guest');
  await f.call(a('/login'), client(), { email, password: PASSWORD });
  assert.equal(
    (await f.call(a('/login'), client(), { email, password: 'wrong password' }, 401)).error.code,
    'PLAYER_PASSWORD_WRONG',
  );

  // Signup closed again: sending stops.
  await f.fixture('/fixture/players', { signupEnabled: false });
  assert.equal(
    (await f.call(a('/request-code'), client(), { purpose: 'reset', email }, 403)).error.code,
    'PLAYER_SIGNUP_DISABLED',
  );
});

test('the daily cap stops sending over HTTP with a 429 and the same envelope', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, dailyCap: 2 });
  const guests = [client(), client(), client()];
  for (const guest of guests) await f.call(`${API}/bootstrap`, guest);
  await f.call(a('/request-code'), guests[0]!, { purpose: 'signup', email: 'one@example.com' });
  await f.call(a('/request-code'), guests[1]!, { purpose: 'signup', email: 'two@example.com' });
  const capped = await f.request(a('/request-code'), guests[2]!, { purpose: 'signup', email: 'three@example.com' });
  assert.equal(capped.status, 429);
  assert.equal(((await capped.json()) as any).error.code, 'PLAYER_EMAIL_DAILY_CAP');
  assert.ok(Number(capped.headers.get('retry-after')) > 0);
  await f.mails(2);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal((await f.mails(2)).length, 2, 'the capped request sent nothing');
});

test('a mail that fails is recorded and never retried by the server; the player asks again after the cooldown', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, failMail: true });
  const guest = client();
  await f.call(`${API}/bootstrap`, guest);
  const challenge = await f.call(a('/request-code'), guest, { purpose: 'signup', email: 'down@example.com' });
  assert.ok(challenge.challengeId, 'the answer does not wait for the mailer');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(await f.fixture('/fixture/player-mail'), [], 'nothing was delivered and nothing was retried');
  assert.equal(
    (await f.call(a('/request-code'), guest, { purpose: 'signup', email: 'down@example.com' }, 429)).error.code,
    'PLAYER_RATE_LIMITED',
  );
});
