import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';

/**
 * Part 42 on the Cloudflare path (workerd, real HTTP, SQLite, alarm): a scheduled broadcast fires with no other request, goes only
 * to the registered players, shows in history like any character message (the voice clip read through the audio route by the player
 * it was delivered to), and an account's deletion removes it (the lifecycle audit stays clean).
 */
const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer?: string };
type Mail = { kind: 'code' | 'registered'; code: string | null };
const client = (peer?: string): Client => ({ cookie: '', csrf: '', ...(peer ? { peer } : {}) });
const a = (path: string) => `${API}/account${path}`;

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
  const boot = (actor: Client) => call(`${API}/bootstrap`, actor, undefined, 200, 'guest');
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email }, 200, 'code');
    const mail = (await mails(before + 1)).at(-1)!;
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
  const state = () => runtime.call<any>('/fixture/broadcast/state');
  /** Waits by reading the fixture's own route only: it never goes through the HTTP transport, so it cannot wake the executor. */
  const until = async (predicate: (s: any) => boolean, seconds: number) => {
    const end = Date.now() + seconds * 1000;
    for (;;) {
      const s = await state();
      if (predicate(s)) return s;
      assert.ok(Date.now() < end, JSON.stringify(s));
      await sleep(500);
    }
  };
  const history = async (actor: Client, characterId = 'wei-guagua') => {
    const boot2 = await boot(actor);
    const conversation = boot2.conversations.find((row: any) => row.characterId === characterId);
    if (!conversation) return { conversationId: null, messages: [] as any[] };
    const page = await call(`${API}/conversations/${conversation.conversationId}/history`, actor);
    return { conversationId: conversation.conversationId as string, messages: page.messages as any[] };
  };
  return { ...runtime, request, call, boot, signUp, owner, state, until, history, fixture: runtime.call };
}

test('a scheduled broadcast fires with no other request, reaches registered players only, reads like any character message, and an account deletion removes it', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true, legalPages: true, turnstile: true });
  const A = client('10.4.2.1'),
    B = client('10.4.2.2'),
    G = client('10.4.2.3');
  const principalA = (await f.boot(A)).access.principalId as string;
  await f.boot(B);
  await f.boot(G);
  await f.signUp(A, 'a.broadcast@example.com');
  await f.signUp(B, 'b.broadcast@example.com');
  const admin = await f.owner();
  const base = `${API}/admin/broadcast`;
  const options = await f.call(`${base}/options`, admin, {});
  assert.equal(options.recipients, 2, 'two registered players; the guest is not one');
  assert.ok(options.characters.some((c: any) => c.characterId === 'wei-guagua'));

  // ---- the page's own refusals over HTTP: the permission and the body shape come first
  assert.equal((await f.call(`${base}/send`, admin, { requestId: 'x' }, 400)).error.code, 'INVALID_REQUEST');
  assert.equal((await f.call(`${base}/nope`, admin, {}, 404)).error.code, 'NOT_FOUND');
  assert.equal((await f.call(`${base}/options`, client(), {}, 401)).error.code, 'ADMIN_UNAUTHORIZED');

  // ---- scheduled: a minute and a bit ahead; from here on the test only reads the fixture's own route
  const sendAt = options.now + 70_000;
  const made = await f.call(`${base}/send`, admin, {
    requestId: 'broadcast-schedule-1',
    bubbles: ['大家好', '今晚有个小活动'],
    characterIds: ['wei-guagua'],
    voices: {},
    sendAt,
    acknowledge: { characters: 1, recipients: 2 },
  });
  assert.equal(made.state, 'scheduled');
  assert.equal((await f.state()).messages, 0);
  const done = await f.until((s) => s.broadcasts[0]?.state === 'sent', 150);
  assert.ok(done.now >= sendAt, 'it did not start before its time');
  assert.deepEqual(
    [done.broadcasts[0].recipients, done.broadcasts[0].delivered, done.messages, done.recipients],
    [2, 2, 4, 2],
  );

  // ---- the player's own view: the character's bubbles, in the conversation that did not exist before
  const seenA = await f.history(A);
  assert.deepEqual(
    seenA.messages.map((m) => [m.author, m.origin, m.text, m.operationId]),
    [
      ['character', 'narrative', '大家好', null],
      ['character', 'narrative', '今晚有个小活动', null],
    ],
  );
  assert.equal((await f.history(G)).messages.length, 0, 'the guest received nothing');
  // not the player's chat and no points were spent
  const access = (await f.boot(B)).access;
  assert.ok(access.canSend !== false);

  // ---- a voice broadcast, uploaded, sent now: one stored clip, read through the player's own audio route
  const clip = syntheticTone(900);
  const upload = await f.call(`${base}/upload`, admin, {
    characterId: 'wei-guagua',
    base64: Buffer.from(clip).toString('base64'),
  });
  assert.equal(upload.origin, 'uploaded');
  const listen = await f.call(`${base}/take-audio`, admin, { takeId: upload.takeId });
  assert.equal(Buffer.from(listen.base64, 'base64').length, clip.length);
  const voiced = await f.call(`${base}/send`, admin, {
    requestId: 'broadcast-now-1',
    bubbles: ['听我说一句'],
    characterIds: ['wei-guagua'],
    voices: { 'wei-guagua': upload.takeId },
    sendAt: null,
    acknowledge: { characters: 1, recipients: 2 },
  });
  assert.equal(voiced.state, 'scheduled', 'recorded; the executor starts it');
  const second = await f.until((s) => s.broadcasts.length === 2 && s.broadcasts[1].state === 'sent', 60);
  assert.equal(second.clips, 1, 'the clip is stored once for the broadcast');
  const seenB = await f.history(B);
  const voice = seenB.messages.find((m) => m.audio?.mediaId);
  assert.ok(voice, 'a voice message');
  assert.equal(voice.text, '听我说一句', 'its words are the transcript');
  const path = `${API}/conversations/${seenB.conversationId}/messages/${voice.messageId}/audio/${voice.audio.mediaId}`;
  const got = await f.request(path, B);
  assert.equal(got.status, 200);
  const bytes = Buffer.from(await got.arrayBuffer());
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    createHash('sha256').update(Buffer.from(clip)).digest('hex'),
  );
  assert.equal((await f.request(path, G)).status, 404, 'another visitor cannot read it');
  const seenA2 = await f.history(A);
  assert.equal(
    (
      await f.request(
        `${API}/conversations/${seenA2.conversationId}/messages/${voice.messageId}/audio/${voice.audio.mediaId}`,
        A,
      )
    ).status,
    404,
    'a message of another conversation is not found',
  );

  // ---- the list: counts only
  const listed = await f.call(`${base}/list`, admin, {});
  assert.equal(listed.broadcasts.length, 2);
  assert.ok(!JSON.stringify(listed).includes('大家好'), 'no message content in the list');

  // ---- purge: deleting an account removes its broadcast messages; the lifecycle audit is clean; the other player keeps them
  assert.deepEqual(await f.call(a('/delete'), A, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: true,
  });
  assert.deepEqual(await f.fixture('/fixture/broadcast/world', { principalId: principalA }), {
    messages: 0,
    links: 0,
    recipients: 0,
  });
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId: principalA }), {
    clean: true,
    loginsRemain: false,
  });
  assert.equal((await f.history(B)).messages.length, 3, "B's messages are untouched");
});
