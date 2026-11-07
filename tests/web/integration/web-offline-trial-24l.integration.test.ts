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

/**
 * Part 24l: a counted-trial guest whose trial character goes 下线 is treated exactly like one whose character was deleted (no rebinding of
 * trial_character_id); signing up still gives the bonus for any character; 重新上线 resumes the trial. Real HTTP, workerd SQLite.
 */
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

const admin = async (f: ReturnType<typeof setup>, owner: Client) => {
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<any>('/fixture/grant')).token });
};
const availability = async (
  f: ReturnType<typeof setup>,
  owner: Client,
  action: 'offline' | 'online',
  id = 'wei-guagua',
) => {
  const base = `${API}/admin/characters/${id}`;
  const version = (await f.call(`${base}/detail`, owner, {})).published.version as number;
  return f.call(`${base}/${action}`, owner, { requestId: randomUUID(), liveVersion: version });
};

test('24l a counted trial bound to a character that goes offline reads like a deleted one; the store opens at every step; sign-up gives the bonus for any character', async (t) => {
  const f = setup(t),
    owner = client(),
    guest = client();
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  await admin(f, owner);
  const principalId = (await f.boot(guest)).access.principalId as string;
  await f.reply(guest, 'wei-guagua');
  let access = (await f.boot(guest)).access;
  assert.deepEqual([access.canSend, access.lockedCharacterId, access.remainingReplies], [true, 'wei-guagua', 4]);

  await availability(f, owner, 'offline');
  await f.restart(); // the store-open preflight (TRIAL_SCOPE_INVALID) still passes: trial_character_id was not rebound
  const boot = await f.boot(guest);
  access = boot.access;
  // The same state as for a deleted trial character: cannot send, the replies it has are kept, no error page.
  assert.deepEqual([access.kind, access.canSend, access.remainingReplies], ['guest', false, 4]);
  assert.ok(!boot.characters.some((c: { characterId: string }) => c.characterId === 'wei-guagua'), 'it is not listed');
  assert.equal((await f.send(guest, 'wei-guagua', 404)).error.code, 'NOT_FOUND');
  const principal = await f.fixture<any>('/fixture/bonus-state', { principalId });
  assert.equal(principal.principal.trial_used + principal.principal.trial_reserved >= 1, true);

  // Signing up: the bonus works with any character, offline trial character or not.
  await f.fixture('/fixture/players', { signupEnabled: true }); // a restart resets the fixture's sign-up switch
  await f.signUp(guest, 'Offline.Trial@example.com');
  await f.restart();
  access = (await f.boot(guest)).access;
  assert.equal(access.canSend, true);
  await f.reply(guest, 'jojo');
  await f.restart();
  assert.equal((await f.boot(guest)).access.canSend, true);
});

test('24l 重新上线 resumes the remaining trial replies with the same character; the store opens at every step', async (t) => {
  const f = setup(t),
    owner = client(),
    guest = client();
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  await admin(f, owner);
  await f.boot(guest);
  await f.reply(guest, 'wei-guagua');
  await availability(f, owner, 'offline');
  await f.restart();
  assert.equal((await f.boot(guest)).access.canSend, false);
  await availability(f, owner, 'online');
  await f.restart();
  const access = (await f.boot(guest)).access;
  assert.deepEqual([access.canSend, access.lockedCharacterId, access.remainingReplies], [true, 'wei-guagua', 4]);
  await f.reply(guest, 'wei-guagua');
  await f.reply(guest, 'wei-guagua');
  await f.restart();
  assert.equal((await f.boot(guest)).access.remainingReplies, 2);
});
