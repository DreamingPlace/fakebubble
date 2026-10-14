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

/** Real HTTP into workerd SQLite; `on` picks the worker with CHAT_REVIEW_ENABLED on (otherwise the plain fixture). */
function setup(t: test.TestContext, on: boolean) {
  const runtime = localRuntime(
    t,
    on ? 'tests/web/fixtures/cloudflare-http-review-worker.ts' : 'tests/web/fixtures/cloudflare-http-worker.ts',
    { STATE: on ? 'WebHTTPReviewFixture' : 'WebHTTPFixture' },
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
  const reply = async (actor: Client, text: string, characterId = 'wei-guagua') => {
    const sent = await call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId: randomUUID(), text, delivery: 'voice' },
      202,
    );
    assert.equal((await settle(actor, sent.operation.operationId)).status, 'published');
  };
  const signUp = async (
    actor: Client,
    email: string,
    nickname: string,
    extra: Record<string, unknown> = {},
    status = 200,
  ) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email });
    const mail = (await mails(before + 1)).at(-1)!;
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail.code });
    return call(
      a('/signup'),
      actor,
      { challengeId: challenge.challengeId, password: PASSWORD, nickname, ...extra },
      status,
    );
  };
  /** The owner: the first administrator the fixture grants a login to. */
  const owner = async () => {
    const actor = client();
    const grant = await runtime.call<{ token: string }>('/fixture/grant');
    await call(`${API}/admin/login`, actor, { token: grant.token });
    return actor;
  };
  /** A member with exactly these permissions, signed in on a fresh client. */
  const member = async (by: Client, permissions: string[]) => {
    const issued = await call(`${API}/admin/members/issue`, by, {
      requestId: randomUUID(),
      label: `m-${randomUUID().slice(0, 6)}`,
      memberId: null,
      permissions,
    });
    const actor = client();
    await call(`${API}/admin/login`, actor, { token: issued.token });
    return actor;
  };
  return { ...runtime, request, call, settle, reply, signUp, owner, member, mails, fixture: runtime.call };
}
type ReviewState = {
  codes: { principal_id: string; code: string }[];
  notices: number;
  archive: Record<string, unknown>[];
};
const conv = (path: string) => `${API}/admin/conversations/${path}`;
const list = (f: ReturnType<typeof setup>, who: Client, over: Record<string, unknown> = {}, status = 200) =>
  f.call(conv('list'), who, { characterId: null, scope: null, page: 0, ...over }, status);

test('chat review over real HTTP: transcripts under an anonymous code, no identity, audited, permissioned', async (t) => {
  const f = setup(t, true);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true, legalPages: true });
  const owner = await f.owner();
  const reader = await f.member(owner, ['conversations.read']);
  const coWriter = await f.member(owner, [
    'characters.read:*',
    'characters.edit:*',
    'characters.preview:*',
    'cocreation.read',
  ]);
  const operations = await f.member(owner, [
    'invites.read',
    'invites.issue',
    'invites.revoke-code',
    'invites.revoke-access',
    'cocreation.read',
    'cocreation.manage',
  ]);

  // The admin session announces the page only because the switch is on.
  assert.deepEqual((await f.call(`${API}/admin/session`, owner)).features, { chatReview: true });

  // Player one signs up (18+ tick, a nickname) and chats; player two stays a guest.
  const one = client('10.0.0.1'),
    two = client('10.0.0.2');
  const bootOne = await f.call(`${API}/bootstrap`, one);
  await f.call(`${API}/bootstrap`, two);
  assert.deepEqual((await f.call(a(''), one)).features.chatReview, true);
  await f.signUp(one, 'Tester.One@example.com', '阿泡', { adult: true });
  await f.reply(one, '你好，我是阿泡');
  await f.reply(one, '再说一句');
  await f.reply(two, '我是第二个人');

  // ---- who may read ----------------------------------------------------------------------------------------------------
  assert.equal((await list(f, coWriter, {}, 403)).error.code, 'ADMIN_PERMISSION_REQUIRED');
  assert.equal((await list(f, operations, {}, 403)).error.code, 'ADMIN_PERMISSION_REQUIRED');
  await f.call(conv('list'), client(), { characterId: null, scope: null, page: 0 }, 401);
  const wrongCsrf = { ...reader, csrf: 'x'.repeat(64) };
  assert.equal((await list(f, wrongCsrf, {}, 403)).error.code, 'ADMIN_CSRF_REQUIRED');

  // ---- list ------------------------------------------------------------------------------------------------------------
  const listed = await list(f, reader);
  assert.equal(listed.total, 2);
  assert.ok(listed.rows.every((r: { archived: boolean }) => !r.archived));
  const labelOne = listed.rows.find((r: { messages: number }) => r.messages >= 4) ?? listed.rows[0];
  assert.match(labelOne.label, /^瓜瓜-[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
  assert.equal(
    JSON.stringify(listed).match(/principal|world|player|session|operation|email|@|ipHash|invite/gi),
    null,
    'nothing identifying in the list',
  );
  const { codes } = await f.fixture<ReviewState>('/fixture/review-state');
  assert.equal(codes.length, 2, 'a code was drawn for each listed transcript, nothing else');

  // ---- detail ----------------------------------------------------------------------------------------------------------
  const detail = await f.call(conv('detail'), reader, {
    characterId: labelOne.characterId,
    code: labelOne.code,
    archived: false,
    page: 0,
  });
  const texts = detail.lines.map((l: { text: string }) => l.text);
  assert.ok(texts.includes('你好，我是〔昵称〕'), JSON.stringify(texts));
  assert.ok(texts.includes('再说一句'));
  assert.equal(detail.lines[0].speaker, 'player');
  assert.ok(detail.lines.some((l: { speaker: string }) => l.speaker === 'character'));
  for (const bad of ['阿泡', 'Tester.One', 'example.com', bootOne.access.principalId])
    assert.ok(!JSON.stringify(detail).includes(bad), `detail must not contain ${bad}`);
  // The CSV: the same lines, the documented columns, no nickname.
  const exported = await f.call(conv('export'), reader, {
    characterId: labelOne.characterId,
    code: labelOne.code,
    archived: false,
  });
  assert.equal(exported.csv.replace(/^﻿/, '').split('\r\n')[0], 'label,time,speaker,text,status,error_code,审核改动');
  assert.ok(exported.csv.includes('你好，我是〔昵称〕') && !exported.csv.includes('阿泡'));
  const everyone = await f.call(conv('export'), reader, { characterId: 'wei-guagua', code: null, archived: null });
  assert.ok(everyone.lines > exported.lines - 1, 'all conversations of the character');

  // ---- the code is absent from every response outside this feature ---------------------------------------------------
  const codesNow = (await f.fixture<ReviewState>('/fixture/review-state')).codes.map((c) => c.code);
  const outside: unknown[] = [
    await f.call(`${API}/bootstrap`, one),
    await f.call(a(''), one),
    await f.call(`${API}/sync`, one),
    await f.call(`${API}/admin/session`, owner),
    await f.call(`${API}/admin/members/list`, owner, {}),
    await f.call(`${API}/admin/invites/list`, owner, { beforeId: null }),
    await f.call(`${API}/admin/characters/list`, owner, {}),
  ];
  const conversation = (await f.call(`${API}/bootstrap`, one)).conversations.find(
    (c: { characterId: string }) => c.characterId === 'wei-guagua',
  );
  outside.push(await f.call(`${API}/conversations/${conversation.conversationId}/history`, one));
  const everything = JSON.stringify(outside);
  for (const code of codesNow) assert.ok(!everything.includes(code), `code ${code} must not leave the review feature`);

  // ---- audit -----------------------------------------------------------------------------------------------------------
  const state = await f.fixture<{ audit: { actor_id: string; action: string; target_id: string }[] }>(
    '/fixture/player-state',
    { principalId: bootOne.access.principalId },
  );
  const review = state.audit.filter((r) => r.action.startsWith('chat-review-'));
  assert.deepEqual(
    review.map((r) => r.action),
    ['chat-review-list', 'chat-review-detail', 'chat-review-export', 'chat-review-export'],
    'the refused calls left nothing',
  );
  assert.ok(review.every((r) => r.actor_id));
  assert.ok(!JSON.stringify(review).includes('第二个人'), 'no content in the audit');

  // ---- the banner ------------------------------------------------------------------------------------------------------
  assert.equal((await f.call(a(''), one)).reviewNoticeClosed, false);
  await f.call(a('/review-notice-close'), { ...one, csrf: 'x'.repeat(43) }, {}, 403);
  assert.deepEqual(await f.call(a('/review-notice-close'), one, {}), { closed: true });
  assert.deepEqual(await f.call(a('/review-notice-close'), one, {}), { closed: true }, 'closing twice is fine');
  assert.equal((await f.call(a(''), one)).reviewNoticeClosed, true, 'remembered by the server');
  assert.equal((await f.call(a(''), two)).reviewNoticeClosed, false, 'per player');
  await f.reply(one, '关掉提示之后还能发送');

  // ---- removal: 删除我的账号 archives once, anonymously ---------------------------------------------------------------
  const before = await f.fixture<ReviewState>('/fixture/review-state');
  assert.equal(before.archive.length, 0);
  assert.equal(before.notices, 1);
  await f.call(a('/delete'), one, { password: PASSWORD, confirm: '删除' });
  const after = await f.fixture<ReviewState>('/fixture/review-state');
  assert.ok(after.archive.length >= 6, 'both sides of three rounds');
  assert.equal(after.codes.length, 1, "the deleted player's live code is gone; the other player's stays");
  assert.equal(after.notices, 0, 'the banner mark went with the player');
  const dump = JSON.stringify(after.archive);
  for (const bad of ['阿泡', 'Tester.One', bootOne.access.principalId])
    assert.ok(!dump.includes(bad), `the archive must not contain ${bad}`);
  assert.ok(after.archive.every((r) => !('principal_id' in r) && !('world_id' in r)));
  assert.ok(after.archive.some((r) => r.text === '你好，我是〔昵称〕'));
  await f.fixture('/fixture/audit-world', { principalId: bootOne.access.principalId });

  // The deleted player's chats are still readable, anonymously, marked 已删除 with the day they go.
  const archived = await list(f, reader, { scope: 'archived' });
  assert.equal(archived.total, 1);
  assert.equal(archived.rows[0].archived, true);
  assert.equal(archived.rows[0].label, labelOne.label, 'the same label the live transcript had');
  const expected = new Date(Math.floor((Date.now() + 180 * DAY) / DAY) * DAY).toISOString().slice(0, 10);
  assert.ok(
    Math.abs(Date.parse(archived.rows[0].expiresOn) - Date.parse(expected)) <= DAY,
    `${archived.rows[0].expiresOn} ~ ${expected}`,
  );
  const gone = await f.call(conv('detail'), reader, {
    characterId: archived.rows[0].characterId,
    code: archived.rows[0].code,
    archived: true,
    page: 0,
  });
  assert.equal(gone.archived, true);
  assert.ok(gone.lines.some((l: { text: string }) => l.text === '你好，我是〔昵称〕'));
  assert.equal((await list(f, reader, { scope: 'live' })).total, 1);

  // ---- 清除本设备的体验数据 (a guest): once more, never twice ---------------------------------------------------------
  await f.call(a('/delete'), two, { password: '', confirm: '清除' });
  const cleared = await f.fixture<ReviewState>('/fixture/review-state');
  const labels = new Set(cleared.archive.map((r) => r.label));
  assert.equal(labels.size, 2, 'two removed players, two labels');
  const counts = new Map<string, number>();
  for (const r of cleared.archive) counts.set(`${r.label}`, (counts.get(`${r.label}`) ?? 0) + 1);
  const lineNumbers = cleared.archive.filter((r) => r.label === [...labels][0]).map((r) => r.line_order);
  assert.equal(new Set(lineNumbers).size, lineNumbers.length, 'no line archived twice');
  assert.equal(cleared.codes.length, 0);

  // ---- the sweep: 180 days later the anonymous rows are gone -----------------------------------------------------------
  await f.fixture('/fixture/review-age', { ms: 179 * DAY });
  await f.fixture('/fixture/review-sweep');
  assert.equal(
    (await f.fixture<ReviewState>('/fixture/review-state')).archive.length,
    cleared.archive.length,
    'day 179: still there',
  );
  await f.fixture('/fixture/review-age', { ms: 2 * DAY });
  await f.fixture('/fixture/review-sweep');
  assert.equal((await f.fixture<ReviewState>('/fixture/review-state')).archive.length, 0);
  assert.equal((await list(f, reader)).total, 0);
});

test('18+ at signup: with the legal pages on the server refuses a signup without adult:true; with them off nothing changes', async (t) => {
  const f = setup(t, true);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, legalPages: true });
  for (const [i, extra] of [{}, { adult: false }, { adult: 'true' }].entries()) {
    const actor = client(`10.1.0.${i}`);
    await f.call(`${API}/bootstrap`, actor);
    const refused = await f.signUp(actor, `age${i}@example.com`, '阿泡', extra, 400);
    assert.equal(refused.error.code, 'AGE_CONFIRMATION_REQUIRED', JSON.stringify(extra));
  }
  const ok = client('10.1.0.9');
  await f.call(`${API}/bootstrap`, ok);
  assert.equal((await f.signUp(ok, 'age-ok@example.com', '阿泡', { adult: true })).nickname, '阿泡');
  // Nothing about it is stored: the login row is the same as ever and sending is untouched.
  await f.reply(ok, '成年之后照常发送');

  const off = setup(t, true);
  await off.fixture('/fixture/assets');
  await off.fixture('/fixture/players', { signupEnabled: true, legalPages: false });
  const guest = client('10.2.0.1');
  await off.call(`${API}/bootstrap`, guest);
  assert.equal((await off.signUp(guest, 'plain@example.com', '阿泡')).nickname, '阿泡', 'no tick needed');
  const other = client('10.2.0.2');
  await off.call(`${API}/bootstrap`, other);
  const strict = await off.signUp(other, 'plain2@example.com', '阿泡', { adult: true }, 400);
  assert.equal(strict.error.code, 'INVALID_REQUEST', 'the body is exactly as before when the flag is off');
});

test('flag off: no routes, no features, no archive, deletion exactly as before', async (t) => {
  const f = setup(t, false);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const owner = await f.owner();
  // The review routes answer like any unknown admin path - same status, same body.
  const unknown = await f.request(`${API}/admin/nothing/list`, owner, {});
  for (const action of ['list', 'detail', 'export']) {
    const response = await f.request(conv(action), owner, {});
    assert.equal(response.status, unknown.status, action);
    assert.deepEqual(await response.json(), await unknown.clone().json(), action);
  }
  assert.equal('features' in (await f.call(`${API}/admin/session`, owner)), false);

  const guest = client('10.3.0.1');
  await f.call(`${API}/bootstrap`, guest);
  const info = await f.call(a(''), guest);
  assert.equal(JSON.stringify(info).includes('chatReview'), false);
  assert.equal(JSON.stringify(info).includes('reviewNoticeClosed'), false);
  await f.call(a('/review-notice-close'), guest, {}, 404);
  await f.signUp(guest, 'off@example.com', '阿泡');
  await f.reply(guest, '关闭时不存档');
  await f.call(a('/delete'), guest, { password: PASSWORD, confirm: '删除' });
  const state = await f.fixture<ReviewState>('/fixture/review-state');
  assert.deepEqual(state, { codes: [], notices: 0, archive: [] }, 'nothing archived, no code, no mark');
});
