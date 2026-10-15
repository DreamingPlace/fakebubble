import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60_000;
type Client = { cookie: string; csrf: string; peer?: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
const client = (peer?: string): Client => ({ cookie: '', csrf: '', ...(peer ? { peer } : {}) });
const a = (path: string) => `${API}/account${path}`;

/** Real HTTP into workerd SQLite with the production switches on: bonus + review (worker) and the rest via /fixture/players. */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-http-all-worker.ts',
    { STATE: 'WebHTTPAllFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  let tokens = 0;
  const request = (path: string, actor: Client, body?: unknown, turnstile?: string) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...(turnstile ? { 'x-turnstile-token': `good-${turnstile}-${++tokens}` } : {}),
        ...(actor.peer ? { 'x-fixture-peer': actor.peer } : {}),
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const call = async (path: string, actor: Client, body?: unknown, status = 200, turnstile?: string) => {
    const response = await request(path, actor, body, turnstile),
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
  const settle = async (actor: Client, id: string) => {
    const end = Date.now() + 30_000;
    while (true) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  const reply = async (actor: Client, text: string, characterId = 'wei-guagua') => {
    const sent = await call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId: randomUUID(), text, delivery: 'voice' },
      202,
    );
    assert.equal((await settle(actor, sent.operation.operationId)).status, 'published');
  };
  const boot = (actor: Client) => call(`${API}/bootstrap`, actor, undefined, 200, 'guest');
  /** request-code (with Turnstile) → verify → signup; returns the signup answer. */
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email }, 200, 'code');
    assert.equal(challenge.kind ?? 'code', 'code', JSON.stringify(challenge));
    const mail = (await mails(before + 1)).at(-1)!;
    assert.equal(mail.kind, 'code', 'the mail is a code, not the "already registered" notice');
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return call(a('/signup'), actor, {
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: '阿泡',
      adult: true,
    });
  };
  const owner = async () => {
    const actor = client();
    const grant = await runtime.call<{ token: string }>('/fixture/grant');
    await call(`${API}/admin/login`, actor, { token: grant.token });
    return actor;
  };
  return { ...runtime, request, call, reply, boot, signUp, owner, mails, fixture: runtime.call };
}
type PlayerState = {
  retention: { state: string; db_cleared_at: number | null };
  messages: number;
  logins: number;
  challenges: number;
  cards: number;
  liveSessions: number;
};
type ReviewState = { codes: { principal_id: string }[]; notices: number; archive: unknown[] };

test('deleting an account with every public switch on leaves nothing behind, and the address can sign up again', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', {
    signupEnabled: true,
    accountDelete: true,
    legalPages: true,
    graceMs: 4 * DAY,
    turnstile: true,
  });
  const email = 'Second.Account@Example.com';
  const player = client('10.1.1.1');
  const principalId = (await f.boot(player)).access.principalId as string;
  assert.equal((await f.signUp(player, email)).bonus, 10);
  // Chat past the trial so a bonus reply is used too; the owner reads the transcript (live code + banner marks).
  for (let n = 0; n < 6; n++) await f.reply(player, `第${n}句`);
  const owner = await f.owner();
  await f.call(`${API}/admin/conversations/list`, owner, { characterId: null, scope: null, page: 0 });
  const mid = await f.fixture<ReviewState>('/fixture/review-state');
  assert.ok(
    mid.codes.some((c) => c.principal_id === principalId),
    'the owner list drew a review code for the player',
  );

  assert.deepEqual(await f.call(a('/delete'), player, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: true,
  });

  const state = await f.fixture<PlayerState>('/fixture/player-state', { principalId });
  assert.equal(state.retention.state, 'purged', 'not stuck in purging');
  assert.deepEqual([state.logins, state.challenges, state.cards, state.messages, state.liveSessions], [0, 0, 0, 0, 0]);
  const review = await f.fixture<ReviewState>('/fixture/review-state');
  assert.equal(review.codes.filter((c) => c.principal_id === principalId).length, 0, 'no review code');
  assert.equal(review.notices, 0, 'no banner mark');
  assert.ok(review.archive.length > 0, 'the anonymous archive was written');
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });

  // The same address on a brand-new guest: a code, not "你已经注册过", and the signup completes without a second bonus.
  await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  const again = client('10.1.1.2');
  await f.boot(again);
  const second = await f.signUp(again, email.toLowerCase());
  assert.equal(second.bonus, 0);
});

test('when the database clear fails after a deletion: the address is free at once, the failure is reported, the alarm finishes it', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', {
    signupEnabled: true,
    accountDelete: true,
    legalPages: true,
    graceMs: 4 * DAY,
    turnstile: true,
  });
  const email = 'Stuck.Clear@Example.com';
  const player = client('10.1.2.1');
  const principalId = (await f.boot(player)).access.principalId as string;
  await f.signUp(player, email);
  await f.reply(player, '一句话');
  // The fault: T2 (clearDatabase) fails closed, the way any audit on unexpected production data would.
  await f.fixture('/fixture/purge-block', { principalId, on: true });
  assert.deepEqual(await f.fixture('/fixture/purge-diagnostics'), {
    purging: 0,
    oldestPurgingMinutes: null,
    loginsOfPurgedPrincipals: 0,
  });
  assert.deepEqual(await f.call(a('/delete'), player, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: false,
  });
  let state = await f.fixture<PlayerState>('/fixture/player-state', { principalId });
  assert.equal(state.retention.state, 'purging', 'T1 ran, T2 did not');
  assert.equal(state.logins, 0, 'the login is gone with T1, not with T2');
  assert.equal(state.challenges, 0);
  // Read-only diagnostics (numbers only): one purge is stuck, and no login of a purging principal remains.
  const stuck = await f.fixture<{ purging: number; oldestPurgingMinutes: number; loginsOfPurgedPrincipals: number }>(
    '/fixture/purge-diagnostics',
  );
  assert.deepEqual([stuck.purging, stuck.loginsOfPurgedPrincipals], [1, 0]);
  assert.ok(Number.isInteger(stuck.oldestPurgingMinutes) && stuck.oldestPurgingMinutes >= 0);
  // A failure is reported with a fixed code and nothing else.
  assert.deepEqual(await f.fixture('/fixture/retention-reports'), [
    { event: 'web_retention_failed', step: 'deletion', code: 'WEB_RETENTION_SCOPE_UNSAFE', failed: 1 },
  ]);

  // A new guest asks for a code for the SAME address while the clear is still stuck: a code, not 你已经注册过.
  await f.fixture('/fixture/age-challenges', { ms: 120_000 });
  const again = client('10.1.2.2');
  await f.boot(again);
  const second = await f.signUp(again, email.toLowerCase());
  assert.equal(second.bonus, 0, 'no second bonus for the same address');

  // The alarm keeps failing (and keeps reporting) while the fault stays, then finishes the purge once it is gone.
  await f.fixture('/fixture/run-alarm');
  assert.equal((await f.fixture<PlayerState>('/fixture/player-state', { principalId })).retention.state, 'purging');
  const reports = await f.fixture<{ step: string; code: string }[]>('/fixture/retention-reports');
  assert.deepEqual(
    reports.map((r) => [r.step, r.code]),
    [
      ['deletion', 'WEB_RETENTION_SCOPE_UNSAFE'],
      ['sweep', 'WEB_RETENTION_SCOPE_UNSAFE'],
    ],
  );
  await f.fixture('/fixture/purge-block', { principalId, on: false });
  await f.fixture('/fixture/run-alarm');
  state = await f.fixture<PlayerState>('/fixture/player-state', { principalId });
  assert.equal(state.retention.state, 'purged');
  assert.deepEqual([state.messages, state.logins, state.cards], [0, 0, 0]);
  assert.equal((await f.fixture<{ purging: number }>('/fixture/purge-diagnostics')).purging, 0);
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });
  // The new owner of the address keeps their login: the old player's retried cleanup does not touch it.
  const login = await f.call(a('/login'), client(), { email, password: PASSWORD }, 200, 'login');
  assert.ok(login.nickname || login.emailMasked || login.csrf, JSON.stringify(login));
});
