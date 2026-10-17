// Part 21i (named exception): login answers PLAYER_EMAIL_NOT_REGISTERED / PLAYER_PASSWORD_WRONG instead of the generic
// PLAYER_LOGIN_INVALID (owner decision); every status code and limit is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60_000;
const GRACE = 7 * DAY;
type Client = { cookie: string; csrf: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
const client = (): Client => ({ cookie: '', csrf: '' });
const a = (path: string) => `${API}/account${path}`;

/** Real HTTP into workerd SQLite (same harness as the account tests); Turnstile uses a fake verifier, never the network. */
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
        'x-fixture-host': 'fixture.invalid',
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
    return result;
  };
  const mails = async (count: number): Promise<Mail[]> => {
    for (let i = 0; i < 100; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length >= count) return list;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('mail not sent');
  };
  const age = () => runtime.call('/fixture/age-challenges', { ms: 120_000 });
  return { ...runtime, request, call, mails, age, fixture: runtime.call };
}
type F = ReturnType<typeof setup>;

/** Request → verify → complete for the actor's current guest session; returns the mail count it used. */
async function signUp(f: F, actor: Client, email: string, nickname = '阿泡') {
  const before = (await f.fixture<Mail[]>('/fixture/player-mail')).length;
  const challenge = await f.call(a('/request-code'), actor, { purpose: 'signup', email });
  const mail = (await f.mails(before + 1)).at(-1)!;
  await f.call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
  return f.call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname });
}
const send = (f: F, actor: Client, text: string, status = 202) =>
  f.call(
    `${API}/characters/wei-guagua/operations`,
    actor,
    { requestId: randomUUID(), text, delivery: 'voice' },
    status,
  );
type State = {
  retention: { state: string };
  messages: number;
  logins: number;
  challenges: number;
  cards: number;
  liveSessions: number;
  grants: { revoked: number }[];
  audit: { actor_id: string | null; action: string; target_id: string }[];
};

test('A: grace over HTTP - bootstrap, no chat, signup gets the history back; after grace the cookie is dead', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, graceMs: GRACE });
  assert.deepEqual((await f.call(a(''), client())).features, { grace: true });

  const kept = client();
  const boot = await f.call(`${API}/bootstrap`, kept);
  const principalId = boot.access.principalId as string;
  await send(f, kept, '宽限期之前');
  // The trial ended 3 days ago and the 24 h cookie is long past: grace keeps the session usable for signup only.
  await f.fixture('/fixture/retention-expire', { principalId, agoMs: 3 * DAY });
  await f.fixture('/fixture/session-expire', { principalId });
  const during = await f.call(`${API}/bootstrap`, kept);
  assert.equal(during.access.canSend, false);
  assert.deepEqual(during.conversations, [], 'no history during grace');
  const info = await f.call(a(''), kept);
  assert.equal(typeof info.grace.endsAt, 'number');
  assert.ok(info.grace.endsAt > Date.now() + 3 * DAY, 'about four days of grace are left');
  assert.equal(
    (await send(f, kept, '还想聊', 410)).error.code,
    'TRIAL_EXPIRED',
    'admission is unchanged: no new reply without an invite',
  );
  const state0 = await f.fixture<State>('/fixture/player-state', { principalId });
  assert.ok(state0.messages > 0, 'the data is still stored');

  await signUp(f, kept, 'grace@example.com');
  const after = await f.call(`${API}/bootstrap`, kept);
  assert.equal(after.conversations.length, 1, 'the history is back');
  assert.equal(after.conversations[0].characterId, 'wei-guagua');
  assert.equal((await f.call(a(''), kept)).grace, undefined);
  assert.equal((await send(f, kept, '注册后也不能再聊', 410)).error.code, 'TRIAL_EXPIRED');

  // Past the end of grace the cookie is dead: the transport clears it and the page shows the signed-out first page.
  const late = client();
  const lateBoot = await f.call(`${API}/bootstrap`, late);
  await send(f, late, '太晚了');
  await f.fixture('/fixture/retention-expire', { principalId: lateBoot.access.principalId, agoMs: GRACE + DAY });
  await f.fixture('/fixture/session-expire', { principalId: lateBoot.access.principalId });
  const dead = await f.request(`${API}/bootstrap`, late);
  assert.equal(dead.status, 401);
  assert.equal(((await dead.json()) as any).error.code, 'GUEST_GRACE_ENDED');
  assert.match(dead.headers.get('set-cookie')!, /Max-Age=0$/);
  // 注册 on the signed-out page: a fresh guest through the normal first-visit path, signed up with an empty history.
  await f.call(a('/signed-out'), late, {});
  const fresh = await f.call(`${API}/bootstrap`, late);
  assert.notEqual(fresh.access.principalId, lateBoot.access.principalId);
  await signUp(f, late, 'late@example.com', '晚来的');
  assert.deepEqual(
    (await f.call(`${API}/bootstrap`, late)).conversations,
    [],
    'nothing of the expired guest comes along',
  );
});

test('A: with the flag off nothing changes - no grace line, the old expired-guest answer', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  assert.deepEqual(await f.call(a(''), client()), { signupEnabled: true, signedIn: false });
  const guest = client();
  const principalId = (await f.call(`${API}/bootstrap`, guest)).access.principalId as string;
  await send(f, guest, '没有宽限期');
  await f.fixture('/fixture/retention-expire', { principalId, agoMs: 1000 });
  assert.equal(
    (await f.call(a('/request-code'), guest, { purpose: 'signup', email: 'x@example.com' }, 410)).error.code,
    'TRIAL_EXPIRED',
  );
  await f.fixture('/fixture/session-expire', { principalId });
  const dead = await f.request(`${API}/bootstrap`, guest);
  assert.equal(((await dead.json()) as any).error.code, 'GUEST_SESSION_EXPIRED');
});

test('B: 清除本设备的体验数据 for a guest and 删除我的账号 for a login, through the audited purge path', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const secret = '不能出现在审计里的话';

  // Off by default: the route does not exist.
  await f.fixture('/fixture/players', { signupEnabled: true });
  const off = client();
  await f.call(`${API}/bootstrap`, off);
  assert.equal((await f.call(a('/delete'), off, { password: '', confirm: '清除' }, 404)).error.code, 'NOT_FOUND');
  assert.equal((await f.call(a(''), off)).features, undefined);

  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  assert.deepEqual((await f.call(a(''), client())).features, { accountDelete: true });

  // A guest without a login: a button, no password. The words must match; origin and CSRF are checked first.
  const guest = client();
  const guestId = (await f.call(`${API}/bootstrap`, guest)).access.principalId as string;
  await send(f, guest, secret);
  assert.equal(
    (await f.call(a('/delete'), guest, { password: '', confirm: '删除' }, 400)).error.code,
    'ACCOUNT_DELETE_CONFIRM_INVALID',
  );
  assert.equal(
    (await f.call(a('/delete'), guest, { password: 'x', confirm: '清除' }, 400)).error.code,
    'INVALID_REQUEST',
  );
  assert.equal(
    (await f.call(a('/delete'), guest, { password: '', confirm: '清除' }, 403, { origin: 'https://evil.invalid' }))
      .error.code,
    'ORIGIN_INVALID',
  );
  assert.equal(
    (await f.call(a('/delete'), { ...guest, csrf: 'x'.repeat(43) }, { password: '', confirm: '清除' }, 403)).error.code,
    'CSRF_INVALID',
  );
  assert.equal((await f.request(a('/delete'), client(), { password: '', confirm: '清除' })).status, 401);
  assert.ok((await f.fixture<State>('/fixture/player-state', { principalId: guestId })).messages > 0);
  const oldCookie = guest.cookie;
  assert.deepEqual(await f.call(a('/delete'), guest, { password: '', confirm: '清除' }), {
    deleted: true,
    complete: true,
  });
  assert.equal(guest.cookie, '', 'the cookie is cleared');
  const gone = await f.fixture<State>('/fixture/player-state', { principalId: guestId });
  assert.equal(gone.retention.state, 'purged');
  assert.equal(gone.messages, 0);
  assert.equal(gone.liveSessions, 0);
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId: guestId }), {
    clean: true,
    loginsRemain: false,
  });
  assert.equal((await f.request(`${API}/bootstrap`, { cookie: oldCookie, csrf: '' })).status, 401);

  // A signed-up player: password and typing 删除. Wrong password is rate limited; the right one removes everything.
  const player = client();
  const playerId = (await f.call(`${API}/bootstrap`, player)).access.principalId as string;
  await send(f, player, secret);
  await signUp(f, player, 'Delete.Me@example.com', '要走的人');
  const before = await f.fixture<State>('/fixture/player-state', { principalId: playerId });
  assert.deepEqual([before.logins, before.cards], [1, 1]);
  assert.equal(
    (await f.call(a('/delete'), player, { password: PASSWORD, confirm: '清除' }, 400)).error.code,
    'ACCOUNT_DELETE_CONFIRM_INVALID',
  );
  assert.equal(
    (await f.call(a('/delete'), player, { password: 'not the password', confirm: '删除' }, 401)).error.code,
    'PLAYER_LOGIN_INVALID',
  );
  assert.ok(
    (await f.fixture<State>('/fixture/player-state', { principalId: playerId })).logins === 1,
    'nothing deleted yet',
  );
  for (let i = 0; i < 4; i++) await f.call(a('/delete'), player, { password: 'still wrong', confirm: '删除' }, 401);
  const limited = await f.request(a('/delete'), player, { password: PASSWORD, confirm: '删除' });
  assert.equal(limited.status, 429, 'rate limited after five wrong attempts, even with the right password');
  assert.equal(((await limited.json()) as any).error.code, 'PLAYER_RATE_LIMITED');
  assert.equal((await f.fixture<State>('/fixture/player-state', { principalId: playerId })).logins, 1);
});

test('B: a fresh signed-up player deletes the account and the audit stays clean', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const secret = '不能出现在审计里的话';
  const email = 'Delete.Me@example.com';
  const player = client();
  const playerId = (await f.call(`${API}/bootstrap`, player)).access.principalId as string;
  await send(f, player, secret);
  await signUp(f, player, email, '要走的人');
  const second = client();
  await f.call(a('/login'), second, { email, password: PASSWORD });
  assert.equal((await f.fixture<State>('/fixture/player-state', { principalId: playerId })).liveSessions, 2);

  assert.deepEqual(await f.call(a('/delete'), player, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: true,
  });
  assert.equal(player.cookie, '');
  const state = await f.fixture<State>('/fixture/player-state', { principalId: playerId });
  assert.equal(state.retention.state, 'purged');
  assert.deepEqual([state.messages, state.logins, state.challenges, state.cards, state.liveSessions], [0, 0, 0, 0, 0]);
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId: playerId }), {
    clean: true,
    loginsRemain: false,
  });
  // The other device is signed out, the login is gone, and the address can be used again.
  assert.equal((await f.request(`${API}/bootstrap`, second)).status, 401);
  assert.equal(
    (await f.call(a('/login'), client(), { email, password: PASSWORD }, 401)).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );
  const again = client();
  await f.call(`${API}/bootstrap`, again);
  await signUp(f, again, email, '回来了');
  // The audit holds an action name, a keyed pseudonym and a time - no content, address, nickname or id.
  assert.equal(state.audit.length, 1);
  assert.deepEqual([state.audit[0]!.actor_id, state.audit[0]!.action], [null, 'player-account-deleted']);
  assert.match(state.audit[0]!.target_id, /^[a-f0-9]{16}$/);
  const dump = JSON.stringify(state);
  for (const leak of [secret, email, email.toLowerCase(), '要走的人', playerId, PASSWORD])
    assert.ok(!dump.includes(leak), `the audit and state must not contain ${leak}`);
});

test('B: an invited player deletes the account: the grant is revoked and the data goes', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const owner = client(),
    player = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const code = (
    await f.call(
      `${API}/admin/invites/issue`,
      owner,
      { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: '删除测试', note: null },
      201,
    )
  ).code as string;
  const principalId = (await f.call(`${API}/bootstrap`, player)).access.principalId as string;
  // Invited players without a login cannot delete: the password is the proof.
  await signUp(f, player, 'invitee@example.com', '受邀者');
  await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code }, 201);
  assert.equal((await f.call(`${API}/bootstrap`, player)).access.kind, 'invite');
  await send(f, player, '受邀聊天').catch(() => {});
  const before = await f.fixture<State>('/fixture/player-state', { principalId });
  assert.equal(before.grants.length, 1);
  assert.equal(before.grants[0]!.revoked, 0);

  const deleted = await f.call(a('/delete'), player, { password: PASSWORD, confirm: '删除' });
  assert.deepEqual(deleted, { deleted: true, complete: true });
  const after = await f.fixture<State>('/fixture/player-state', { principalId });
  assert.equal(after.retention.state, 'purged');
  assert.deepEqual([after.messages, after.logins, after.cards, after.liveSessions], [0, 0, 0, 0]);
  assert.equal(after.grants[0]!.revoked, 1, 'the grant is revoked as part of the deletion');
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });
  assert.equal(
    (await f.call(a('/login'), client(), { email: 'invitee@example.com', password: PASSWORD }, 401)).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );
});

test('D: Turnstile guards a new guest, request-code and login; each token works once; it fails closed', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, turnstile: true });
  type Calls = { calls: { token: string; remoteIp: string | null }[]; serverErrors: number };
  const calls = async () => (await f.fixture<Calls>('/fixture/turnstile-calls')).calls.length;
  const stats = async () => (await f.fixture<{ principals: number }>('/fixture/stats')).principals;
  const withToken = (token: string) => ({ 'x-turnstile-token': token });

  // The page learns the (public) site key before it has any cookie.
  assert.deepEqual((await f.call(a(''), client())).features, { turnstileSiteKey: '1x00000000000000000000AA' });

  // A new guest needs a valid token; nothing is created without one.
  const first = client();
  assert.equal((await f.call(`${API}/bootstrap`, first, undefined, 403)).error.code, 'TURNSTILE_REQUIRED');
  assert.equal(
    (await f.call(`${API}/bootstrap`, first, undefined, 403, withToken('bad-token-1'))).error.code,
    'TURNSTILE_FAILED',
  );
  assert.equal(
    (await f.call(`${API}/bootstrap`, first, undefined, 403, withToken('not a token!'))).error.code,
    'TURNSTILE_FAILED',
  );
  assert.equal(await stats(), 0, 'no guest was created by the refusals');
  assert.equal(await calls(), 1, 'the malformed token never reached siteverify');
  // A token minted for another action (the fake answers the action like Turnstile does) is refused.
  assert.equal(
    (await f.call(`${API}/bootstrap`, first, undefined, 403, withToken('good-login-1'))).error.code,
    'TURNSTILE_FAILED',
  );
  await f.call(`${API}/bootstrap`, first, undefined, 200, withToken('good-guest-1'));
  assert.equal(await stats(), 1);
  const used = await calls();
  // Once: the same token is refused without another siteverify call.
  assert.equal(
    (await f.call(`${API}/bootstrap`, client(), undefined, 403, withToken('good-guest-1'))).error.code,
    'TURNSTILE_FAILED',
  );
  assert.equal(await calls(), used);
  // A returning visitor (cookie present) is never asked.
  await f.call(`${API}/bootstrap`, first);
  assert.equal(await calls(), used);

  // request-code (signup / reset / bind alike) and login.
  const body = { purpose: 'signup', email: 'bot@example.com' };
  assert.equal((await f.call(a('/request-code'), first, body, 403)).error.code, 'TURNSTILE_REQUIRED');
  assert.equal(
    (await f.call(a('/request-code'), first, body, 403, withToken('good-guest-2'))).error.code,
    'TURNSTILE_FAILED',
  );
  await f.call(a('/request-code'), first, body, 200, withToken('good-code-1'));
  assert.equal(
    (await f.call(a('/request-code'), first, { purpose: 'reset', email: 'bot@example.com' }, 403)).error.code,
    'TURNSTILE_REQUIRED',
  );
  const login = { email: 'bot@example.com', password: PASSWORD };
  assert.equal((await f.call(a('/login'), client(), login, 403)).error.code, 'TURNSTILE_REQUIRED');
  assert.equal(
    (await f.call(a('/login'), client(), login, 401, withToken('good-login-2'))).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );
  assert.equal(
    (await f.call(a('/login'), client(), login, 403, withToken('good-login-2'))).error.code,
    'TURNSTILE_FAILED',
    'one use',
  );
  // Other routes carry no Turnstile: verify-code, signup and the rest keep working with the session alone.
  const [mail] = await f.mails(1);
  assert.ok(mail!.code);

  // Fail closed: siteverify unreachable -> 503, nothing created, and the token is not spent.
  await f.fixture('/fixture/turnstile-mode', { down: true });
  const down = await f.call(`${API}/bootstrap`, client(), undefined, 503, withToken('good-guest-3'));
  assert.equal(down.error.code, 'TURNSTILE_UNAVAILABLE');
  assert.equal(await stats(), 1);
  assert.equal(
    (await f.fixture<Calls>('/fixture/turnstile-calls')).serverErrors,
    1,
    'a 5xx is counted for the owner alerts',
  );
  await f.fixture('/fixture/turnstile-mode', { down: false });
  await f.call(`${API}/bootstrap`, client(), undefined, 200, withToken('good-guest-3'));
  assert.equal(await stats(), 2);
});

test('D: with the flag off nobody is asked for a token', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const guest = client();
  await f.call(`${API}/bootstrap`, guest);
  await f.call(a('/request-code'), guest, { purpose: 'signup', email: 'plain@example.com' });
  assert.equal(
    (await f.call(a('/login'), client(), { email: 'plain@example.com', password: PASSWORD }, 401)).error.code,
    'PLAYER_EMAIL_NOT_REGISTERED',
  );
  assert.deepEqual((await f.fixture<{ calls: unknown[] }>('/fixture/turnstile-calls')).calls, []);
});

test('C: the alert state lives in the Durable Object storage: one mail per window, even across a restart', async (t) => {
  const f = setup(t);
  const hour = 60 * 60_000;
  await f.fixture('/fixture/alerts/start', {});
  await f.fixture('/fixture/alerts/error', {});
  const first = await f.fixture<{ ran: boolean; sent: string[]; mails: number }>('/fixture/alerts/check', {});
  assert.deepEqual([first.ran, first.sent, first.mails], [true, ['errors'], 1]);
  // Two hours later a new error and a restarted object: the stored claim holds the 6-hour window.
  await f.fixture('/fixture/alerts/skew', { ms: 2 * hour });
  await f.fixture('/fixture/alerts/restart', {});
  await f.fixture('/fixture/alerts/error', {});
  const second = await f.fixture<{ ran: boolean; sent: string[]; mails: number }>('/fixture/alerts/check', {});
  assert.deepEqual([second.ran, second.sent, second.mails], [true, [], 1]);
  // And the hour gate survives the restart too.
  await f.fixture('/fixture/alerts/restart', {});
  assert.equal((await f.fixture<{ ran: boolean }>('/fixture/alerts/check', {})).ran, false);
  // Six hours after the first mail the standing problem is reported again.
  await f.fixture('/fixture/alerts/skew', { ms: 4 * hour });
  await f.fixture('/fixture/alerts/error', {});
  const third = await f.fixture<{ sent: string[]; mails: number }>('/fixture/alerts/check', {});
  assert.deepEqual([third.sent, third.mails], [['errors'], 2]);
});
