import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { parseWebProviderBootstrap } from '../../../packages/contracts/web-provider.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
type Client = { cookie: string; csrf: string };
const client = (): Client => ({ cookie: '', csrf: '' });
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
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const cookie = response.headers.get('set-cookie')?.split(';')[0];
    if (cookie) {
      assert.match(response.headers.get('set-cookie')!, /; Path=\/; Secure; HttpOnly; SameSite=Lax/);
      actor.cookie = response.headers.get('set-cookie')!.includes('Max-Age=0') ? '' : cookie;
    }
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  const boot = async (actor: Client) => parseWebProviderBootstrap(await call(`${API}/bootstrap`, actor));
  const send = (actor: Client, characterId = 'wei-guagua', requestId = randomUUID(), status = 202) =>
    call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId, text: '离线完整 HTTP 验收', delivery: 'voice' },
      status,
    );
  const settle = async (actor: Client, id: string) => {
    const end = Date.now() + 20_000;
    while (true) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  return { ...runtime, request, call, boot, send, settle, fixture: runtime.call };
}

test('shared IP quota: a previously opened guest becomes exhausted without new operations, including after restart', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const idle = client(),
    active = client(),
    stale = await f.boot(idle);
  await f.boot(active);
  assert.equal(stale.access.remainingReplies, 3);
  for (let n = 0; n < 3; n++) {
    const sent = await f.send(active);
    assert.equal((await f.settle(active, sent.operation.operationId)).status, 'published');
  }
  const before = await f.fixture<any>('/fixture/stats');
  const rejected = await f.send(idle, 'wei-guagua', randomUUID(), 403);
  assert.equal(rejected.error.code, 'TRIAL_EXHAUSTED');
  const current = await f.boot(idle);
  assert.equal(current.access.remainingReplies, 0);
  assert.equal(current.access.canSend, false);
  assert.equal(current.conversations.length, 0, 'rejection does not store a player message');
  assert.equal(stale.access.remainingReplies, 3, 'the browser must refresh its old projection');
  await f.restart();
  const after = await f.boot(idle);
  assert.equal(after.access.remainingReplies, 0);
  assert.equal((await f.send(idle, 'wei-guagua', randomUUID(), 403)).error.code, 'TRIAL_EXHAUSTED');
  const final = await f.fixture<any>('/fixture/stats');
  assert.deepEqual(final.calls, before.calls);
  assert.deepEqual(final.spending, before.spending);
  assert.deepEqual(final.operations, before.operations);
  const oldCookie = idle.cookie;
  await f.fixture('/fixture/session-expire', { principalId: current.access.principalId });
  await f.restart();
  const expired = await f.request(`${API}/bootstrap`, idle);
  assert.equal(expired.status, 401);
  assert.equal(((await expired.json()) as any).error.code, 'GUEST_SESSION_EXPIRED');
  assert.match(expired.headers.get('set-cookie')!, /^__Host-fixture=;.*Max-Age=0/);
  const afterExpiry = await f.fixture<any>('/fixture/stats');
  assert.deepEqual(afterExpiry, final, 'expiry response changes no data or quota');
  idle.cookie = '';
  const entered = await f.boot(idle);
  assert.notEqual(entered.access.principalId, current.access.principalId);
  assert.notEqual(idle.cookie, oldCookie);
  assert.equal(entered.access.remainingReplies, 0);
  assert.equal(entered.access.canSend, false);
  assert.deepEqual((await f.fixture<any>('/fixture/stats')).operations, final.operations);
});

test('durable character drafts, scoped authority and profile preview never mutate live players or make external calls', async (t) => {
  const f = setup(t),
    owner = client(),
    member = client(),
    guest = client();
  const initial = await f.boot(guest),
    stats = await f.fixture<any>('/fixture/stats');
  const grant = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: grant.token });
  const base = `${API}/admin/characters`,
    detail = await f.call(`${base}/wei-guagua/detail`, owner, {});
  const profile = detail.published.profile;
  profile.template.version++;
  profile.template.persona = '离线草稿验证。'.repeat(1600); // UTF-8 >8192, within authenticated editor bound.
  profile.presentation.displayName = '<img src=x onerror="alert(1)">';
  const first = await f.call(`${base}/wei-guagua/save`, owner, { expectedRevision: null, profile });
  assert.equal(first.revision, 1);
  assert.equal((await f.call(`${base}/wei-guagua/save`, owner, { expectedRevision: null, profile })).revision, 1);
  await f.call(`${base}/wei-guagua/save`, guest, { expectedRevision: 1, profile }, 401);
  await f.call(`${base}/wei-guagua/save`, owner, { expectedRevision: 1, profile }, 403, {
    origin: 'https://evil.invalid',
  });
  const preview = await f.call(`${base}/wei-guagua/preview`, owner, { expectedRevision: 1 });
  assert.equal(preview.kind, 'profile-preview');
  assert.equal(preview.externalCalls, false);
  assert.equal(preview.publishAvailable, false);
  await f.call(
    `${base}/wei-guagua/publish`,
    owner,
    {
      requestId: randomUUID(),
      draftRevision: 1,
      profileHash: first.contentHash,
      previewId: 'missing-real-preview',
      acknowledgeReview: true,
    },
    409,
  );
  assert.deepEqual((await f.boot(guest)).characters, initial.characters);
  const invite = await f.call(`${API}/admin/members/issue`, owner, {
    requestId: randomUUID(),
    label: 'Scoped editor',
    memberId: null,
    permissions: ['characters.read:wei-guagua', 'characters.edit:wei-guagua'],
  });
  await f.call(`${API}/admin/login`, member, { token: invite.token });
  assert.deepEqual(
    (await f.call(`${base}/list`, member, {})).characters.map((c: any) => c.characterId),
    ['wei-guagua'],
  );
  await f.call(`${base}/jojo/detail`, member, {}, 403);
  await f.call(`${base}/wei-guagua/discard`, member, { expectedRevision: 1 }, 403);
  await f.restart();
  assert.deepEqual((await f.call(`${base}/wei-guagua/detail`, owner, {})).draft, first);
  const newer = structuredClone(profile);
  newer.presentation.publicDescription = '新的草稿';
  await f.call(`${base}/wei-guagua/save`, member, { expectedRevision: 1, profile: newer });
  await f.call(`${base}/wei-guagua/save`, owner, { expectedRevision: 1, profile }, 409);
  await f.call(`${base}/wei-guagua/preview`, owner, { expectedRevision: 1 }, 409);
  await f.call(`${API}/admin/members/permissions`, owner, { memberId: invite.memberId, permissions: [] });
  assert.equal((await f.call(`${API}/admin/session`, member)).member.id, invite.memberId);
  await f.call(`${base}/wei-guagua/detail`, member, {}, 403);
  const added = structuredClone(profile);
  added.template.id = 'draft-only';
  added.template.version = 1;
  await f.call(`${base}/draft-only/save`, owner, { expectedRevision: null, profile: added });
  await f.send(guest, 'draft-only', randomUUID(), 404);
  await f.call(`${base}/wei-guagua/discard`, owner, { expectedRevision: 2 });
  assert.equal((await f.call(`${base}/wei-guagua/detail`, owner, {})).draft, null);
  const after = await f.fixture<any>('/fixture/stats');
  assert.deepEqual(after, stats);
  assert.deepEqual((await f.boot(guest)).access, initial.access);
});

test('native SQL catalog reload accepts a fourth published identity and its welcome audio, without reinitializing seed', async (t) => {
  const f = setup(t),
    guest = client();
  assert.equal((await f.boot(guest)).characters.length, 3);
  const before = await f.fixture<any>('/fixture/stats');
  await f.fixture('/fixture/catalog/fourth');
  await f.restart();
  const view = await f.boot(guest);
  assert.equal(view.characters.length, 4);
  assert.equal(view.slots.filter((s) => s.kind === 'preview').length, 11);
  const fourth = view.characters.find((c) => c.characterId === 'fourth-synthetic')!;
  assert.equal(fourth.availability.state, 'available');
  assert.equal(fourth.welcome.audio.state, 'available');
  if (fourth.welcome.audio.state !== 'available') throw Error('fixture welcome missing');
  const audio = await f.request(fourth.welcome.audio.url, guest);
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/wav');
  assert.ok((await audio.arrayBuffer()).byteLength > 44);
  assert.deepEqual(await f.fixture('/fixture/stats'), before);
});

test('native atomic character publication survives restart and replay while preserving player history, quota and accounting', async (t) => {
  const f = setup(t),
    owner = client(),
    editor = client(),
    player = client();
  await f.fixture('/fixture/assets');
  await f.boot(player);
  const sent = await f.send(player),
    completed = await f.settle(player, sent.operation.operationId);
  assert.equal(completed.status, 'published');
  const before = await f.boot(player),
    stats = await f.fixture<any>('/fixture/stats');
  const grant = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: grant.token });
  const base = `${API}/admin/characters/wei-guagua`,
    detail = await f.call(`${base}/detail`, owner, {});
  const profile = detail.published.profile;
  profile.template.version++;
  profile.template.persona += '离线版本发布验证';
  profile.presentation.displayName = '已发布的合成名字';
  const saved = await f.call(`${base}/save`, owner, { expectedRevision: null, profile });
  const input = {
    requestId: randomUUID(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    previewId: 'missing-preview',
    acknowledgeReview: true,
  };
  assert.equal((await f.call(`${base}/publish`, owner, input, 409)).error.code, 'VALID_PREVIEW_REQUIRED');
  // Test-only simulated proof through the real parser; never a real provider acceptance claim.
  const review = await f.fixture<{ previewId: string }>('/fixture/catalog/review', { characterId: 'wei-guagua' });
  input.previewId = review.previewId;
  await f.call(`${base}/publish`, player, input, 401);
  await f.call(`${base}/publish`, owner, input, 403, { origin: 'https://evil.invalid' });
  const member = await f.call(`${API}/admin/members/issue`, owner, {
    requestId: randomUUID(),
    label: 'Editor only',
    memberId: null,
    permissions: ['characters.read:wei-guagua', 'characters.edit:wei-guagua'],
  });
  await f.call(`${API}/admin/login`, editor, { token: member.token });
  await f.call(`${base}/publish`, editor, input, 403);
  const result = await f.call(`${base}/publish`, owner, input);
  assert.equal(result.version, profile.template.version);
  assert.deepEqual(await f.call(`${base}/publish`, owner, input), result);
  const changed = await f.boot(player);
  assert.equal(
    changed.characters.find((c) => c.characterId === 'wei-guagua')!.displayName,
    profile.presentation.displayName,
  );
  assert.deepEqual(changed.access, before.access);
  assert.deepEqual(changed.conversations, before.conversations);
  assert.deepEqual(await f.fixture('/fixture/stats'), stats);
  assert.deepEqual(await f.call(`${API}/operations/${sent.operation.operationId}`, player), completed);
  await f.restart();
  assert.deepEqual(await f.call(`${base}/publish`, owner, input), result);
  const restored = await f.call(`${base}/detail`, owner, {});
  assert.equal(restored.draft, null);
  assert.deepEqual(restored.published.profile, profile);
  const next = await f.send(player);
  assert.equal((await f.settle(player, next.operation.operationId)).status, 'published');
  assert.equal((await f.boot(player)).access.remainingReplies, 1);
});

test('administrator email identity and granular permissions persist; removal never logs out accounts or mutates player sessions', async (t) => {
  const f = setup(t),
    owner = client(),
    member = client(),
    second = client(),
    guest = client();
  const playerBefore = await f.boot(guest),
    before = await f.fixture<any>('/fixture/stats');
  const first = await f.fixture<any>('/fixture/grant');
  const ownerLogin = await f.call(`${API}/admin/login`, owner, { token: first.token });
  assert.equal(ownerLogin.member.role, 'owner');
  const input = {
    requestId: randomUUID(),
    label: 'Offline collaborator',
    memberId: null,
    permissions: ['invites.issue'],
  };
  const grant = await f.call(`${API}/admin/members/issue`, owner, input);
  const login = await f.call(`${API}/admin/login`, member, { token: grant.token });
  assert.equal(login.member.email, null);
  assert.deepEqual(login.member.permissions, ['invites.issue']);
  await f.call(`${API}/admin/members/list`, member, {}, 403);
  await f.call(
    `${API}/admin/email/register`,
    client(),
    { email: 'public@example.com', password: 'Offline password 123' },
    404,
  );
  const invitation = await f.call(
    `${API}/admin/invites/issue`,
    member,
    {
      requestId: randomUUID(),
      redeemBy: null,
      accessDurationMs: null,
      batch: 'before-email',
      note: null,
    },
    201,
  );
  await f.call(`${API}/admin/invites/revoke-code`, member, { id: invitation.inviteId }, 403);
  const bind = await f.call(`${API}/admin/email/bind/start`, member, { email: 'COLLAB@example.com' });
  const mails = await f.fixture<any[]>('/fixture/admin-mail');
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'collab@example.com');
  assert.match(mails[0].code, /^[0-9]{6}$/);
  const old = { ...member },
    password = 'Offline email 123';
  const bound = await f.call(`${API}/admin/email/bind/finish`, member, {
    challengeId: bind.challengeId,
    code: mails[0].code,
    password,
  });
  assert.equal(bound.member.id, grant.memberId);
  assert.notEqual(member.cookie, old.cookie);
  await f.call(`${API}/admin/session`, old, undefined, 401);
  await f.call(`${API}/admin/email/login`, second, { email: 'collab@example.com', password });
  const allCookies = [member.cookie, second.cookie];
  await f.call(`${API}/admin/members/permissions`, owner, { memberId: grant.memberId, permissions: [] });
  for (const actor of [member, second]) {
    const current = await f.call(`${API}/admin/session`, actor);
    assert.deepEqual(current.member.permissions, []);
    await f.call(
      `${API}/admin/invites/issue`,
      actor,
      {
        requestId: randomUUID(),
        redeemBy: null,
        accessDurationMs: null,
        batch: 'forbidden',
        note: null,
      },
      403,
    );
  }
  assert.deepEqual([member.cookie, second.cookie], allCookies);
  await f.restart();
  assert.deepEqual((await f.call(`${API}/admin/session`, member)).member.permissions, []);
  assert.equal((await f.call(`${API}/admin/session`, second)).member.id, grant.memberId);
  const playerAfter = await f.boot(guest);
  assert.deepEqual(playerAfter.access, playerBefore.access);
  const after = await f.fixture<any>('/fixture/stats');
  assert.deepEqual(after.operations, before.operations);
  assert.deepEqual(after.calls, before.calls);
  assert.deepEqual(after.spending, before.spending);
  await f.call(`${API}/admin/members/permissions`, owner, {
    memberId: grant.memberId,
    permissions: ['invites.revoke'],
  });
  await f.call(`${API}/admin/invites/revoke-code`, member, { id: invitation.inviteId });
  await f.call(`${API}/admin/invites/list`, member, { beforeId: null }, 403);
  await f.call(`${API}/admin/members/permissions`, owner, {
    memberId: grant.memberId,
    permissions: ['invites.read'],
    expectedPermissions: ['invites.revoke'],
  });
  await f.call(
    `${API}/admin/members/permissions`,
    owner,
    { memberId: grant.memberId, permissions: [], expectedPermissions: ['invites.revoke'] },
    409,
  );
  const records = await f.call(`${API}/admin/invites/list`, member, { beforeId: null });
  assert.equal(records.records.length, 1);
  assert.equal(records.records[0].status, 'revoked');
  assert.equal(records.next, null);
  assert.ok(!JSON.stringify(records).includes(invitation.code));
  assert.ok(!JSON.stringify(records).includes('digest'));
  await f.restart();
  assert.equal(
    (await f.call(`${API}/admin/invites/list`, member, { beforeId: null })).records[0].inviteId,
    invitation.inviteId,
  );
  await f.call(`${API}/admin/invites/revoke-code`, member, { id: invitation.inviteId }, 403);
  await f.call(
    `${API}/admin/members/permissions`,
    member,
    { memberId: grant.memberId, permissions: ['invites.issue'] },
    403,
  );
  await f.call(`${API}/admin/members/permissions`, owner, { memberId: ownerLogin.member.id, permissions: [] }, 403);
  await f.call(
    `${API}/admin/members/permissions`,
    { ...owner, csrf: '0'.repeat(64) },
    { memberId: grant.memberId, permissions: [] },
    403,
  );
  await f.call(`${API}/admin/session`, guest, undefined, 401);
});

test('native workerd password reset/unknown-email parity/replay and login limits survive restart', async (t) => {
  const f = setup(t),
    owner = client(),
    first = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: first.token });
  const bind = await f.call(`${API}/admin/email/bind/start`, owner, { email: 'owner@example.com' });
  let mails = await f.fixture<any[]>('/fixture/admin-mail');
  await f.call(`${API}/admin/email/bind/finish`, owner, {
    challengeId: bind.challengeId,
    code: mails[0].code,
    password: 'First123',
  });
  const unknown = await f.call(`${API}/admin/email/reset/start`, client(), { email: 'missing@example.com' });
  const reset = await f.call(`${API}/admin/email/reset/start`, client(), { email: 'owner@example.com' });
  assert.deepEqual(Object.keys(unknown), Object.keys(reset));
  mails = await f.fixture<any[]>('/fixture/admin-mail');
  assert.equal(mails.length, 2);
  assert.match(mails[1].code, /^[0-9]{6}$/);
  await f.restart();
  await f.call(`${API}/admin/email/reset/finish`, client(), {
    challengeId: reset.challengeId,
    code: mails[1].code,
    password: 'Second password123',
  });
  await f.call(`${API}/admin/session`, owner, undefined, 401);
  await f.call(
    `${API}/admin/email/reset/finish`,
    client(),
    {
      challengeId: reset.challengeId,
      code: mails[1].code,
      password: 'Third pwd 789',
    },
    400,
  );
  const next = await f.call(`${API}/admin/email/login`, owner, {
    email: 'owner@example.com',
    password: 'Second password123',
  });
  assert.equal(next.member.role, 'owner');
  for (let n = 0; n < 5; n++)
    await f.call(
      `${API}/admin/email/login`,
      client(),
      {
        email: 'missing@example.com',
        password: 'Offline invalid password 123',
      },
      401,
    );
  await f.restart();
  await f.call(
    `${API}/admin/email/login`,
    client(),
    { email: 'owner@example.com', password: 'Second password123' },
    429,
  );
});

test('cloud HTTP: catalog/welcome, three automatic rounds/footer, scoped private audio, exact replay and restart', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const guest = client(),
    initial = await f.boot(guest);
  assert.equal(initial.mode, 'provider-cloud');
  assert.equal(initial.region, 'public');
  assert.equal(initial.fixture, false);
  assert.equal(initial.slots.length, 15);
  assert.ok(!JSON.stringify(initial).includes('synthetic-wei-guagua'));
  const welcome = initial.characters[0]!.welcome.audio;
  assert.equal(welcome.state, 'available');
  if (welcome.state !== 'available') throw Error('missing welcome');
  const clip = await f.request(welcome.url, client());
  assert.equal(clip.status, 200);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await clip.arrayBuffer()))
      .digest('hex'),
    welcome.sha256,
  );
  const requestId = randomUUID();
  const first = await f.send(guest, 'wei-guagua', requestId);
  assert.equal((await f.settle(guest, first.operation.operationId)).status, 'published');
  assert.equal((await f.send(guest, 'jojo', randomUUID(), 403)).error.code, 'TRIAL_CHARACTER_LOCKED');
  for (let n = 2; n <= 3; n++) {
    const sent = await f.send(guest);
    const result = await f.settle(guest, sent.operation.operationId);
    assert.equal(result.status, 'published');
    if (n === 3) assert.ok(result.publication.footerMessageId);
  }
  assert.equal((await f.send(guest, 'wei-guagua', randomUUID(), 403)).error.code, 'TRIAL_EXHAUSTED');
  const after = await f.boot(guest),
    conv = after.conversations.find((row) => row.characterId === 'wei-guagua')!;
  assert.equal(after.access.canSend, false);
  const path = `${API}/conversations/${conv.conversationId}/history`;
  const history = await f.call(path, guest);
  assert.equal(history.messages.filter((row: any) => row.origin === 'trial_footer').length, 1);
  const voiced = history.messages.find((row: any) => row.origin === 'narrative' && row.audio);
  const audioPath = `${API}/conversations/${conv.conversationId}/messages/${voiced.messageId}/audio/${voiced.audio.mediaId}`;
  const audio = await f.request(audioPath, guest);
  assert.equal(audio.status, 200);
  const hash = createHash('sha256')
    .update(Buffer.from(await audio.arrayBuffer()))
    .digest('hex');
  const other = client();
  await f.boot(other);
  await f.call(path, other, undefined, 404);
  await f.call(audioPath, other, undefined, 404);
  await f.call(audioPath, client(), undefined, 401);
  await f.call(`${API}/sync?cursor=${after.syncCursor}`, other, undefined, 400);
  const before = await f.fixture('/fixture/stats');
  await f.restart();
  assert.deepEqual(await f.call(path, guest), history);
  const replay = await f.send(guest, 'wei-guagua', requestId, 200);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.operation.operationId, first.operation.operationId);
  const read = await f.call(`${API}/operations/by-request/${requestId}`, guest);
  assert.equal(read.operationId, first.operation.operationId);
  const reopened = await f.request(audioPath, guest);
  assert.equal(reopened.status, 200);
  assert.equal(
    createHash('sha256')
      .update(Buffer.from(await reopened.arrayBuffer()))
      .digest('hex'),
    hash,
  );
  assert.deepEqual(await f.fixture('/fixture/stats'), before);
  await f.fixture('/fixture/revoke-on-read', { principalId: after.access.principalId });
  await f.call(audioPath, guest, undefined, 401);
});

test('cloud HTTP invites use actual admin login, in-place upgrade, recovery rotation and revocation', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const admin = client(),
    guest = client(),
    other = client();
  const grant = await f.fixture<{ token: string }>('/fixture/grant');
  await f.call(`${API}/admin/login`, admin, { token: grant.token });
  await f.call(`${API}/admin/login`, client(), { token: grant.token }, 403);
  await f.call(`${API}/admin/session`, admin);
  const issued = await f.call(
    `${API}/admin/invites/issue`,
    admin,
    { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: 'offline-http', note: null },
    201,
  );
  const original = await f.boot(guest);
  await f.boot(other);
  assert.equal(
    (await f.call(`${API}/invites/redeem`, guest, { requestId: randomUUID(), code: 'A'.repeat(43) }, 409)).error.code,
    'WEB_INVITE_UNAVAILABLE',
  );
  const redeemed = await f.call(`${API}/invites/redeem`, guest, { requestId: randomUUID(), code: issued.code }, 201);
  const upgraded = await f.boot(guest);
  assert.equal(upgraded.access.kind, 'invite');
  assert.equal(upgraded.access.worldId, original.access.worldId);
  assert.equal(upgraded.access.principalId, original.access.principalId);
  await f.call(`${API}/invites/redeem`, other, { requestId: randomUUID(), code: issued.code }, 409);
  for (const character of ['jojo', 'chen-jimi']) {
    const sent = await f.send(guest, character);
    assert.equal((await f.settle(guest, sent.operation.operationId)).status, 'published');
  }
  const credential = await f.call(`${API}/invites/credential`, guest, {}, 201);
  const recovered = client();
  await f.call(`${API}/invites/recover`, recovered, { requestId: randomUUID(), secret: credential.secret });
  assert.equal((await f.boot(recovered)).access.worldId, original.access.worldId);
  await f.call(`${API}/sync`, guest, undefined, 401);
  await f.call(`${API}/admin/invites/revoke-grant`, admin, { id: redeemed.grantId });
  await f.call(`${API}/sync`, recovered, undefined, 410);
  await f.call(`${API}/admin/logout`, admin, {});
  await f.call(`${API}/admin/session`, admin, undefined, 401);
});

test('cloud HTTP SSE streams scoped events, limits duplicates, releases disconnected slots and closes after revocation', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const guest = client(),
    boot = await f.boot(guest);
  let response = await f.request(`${API}/events?cursor=${boot.syncCursor}`, guest);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /text\/event-stream/);
  let reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /heartbeat/);
  await f.call(`${API}/events`, guest, undefined, 429);
  await reader.cancel();
  await sleep(1100);
  response = await f.request(`${API}/events?cursor=${boot.syncCursor}`, guest);
  assert.equal(response.status, 200);
  reader = response.body!.getReader();
  try {
    await reader.read();
    const send = await f.send(guest);
    let stream = '';
    const end = Date.now() + 20_000;
    while (!stream.includes('"kind":"publication"')) {
      const chunk = await reader.read();
      assert.equal(chunk.done, false);
      stream += new TextDecoder().decode(chunk.value);
      assert.ok(Date.now() < end, stream);
    }
    assert.ok(stream.includes(send.operation.operationId));
    await f.fixture('/fixture/revoke', { principalId: boot.access.principalId });
    let ended = false;
    for (let n = 0; n < 3; n++)
      if ((await reader.read()).done) {
        ended = true;
        break;
      }
    assert.equal(ended, true);
  } finally {
    await reader.cancel();
  }
});

test('cloud HTTP rejects forged origin/cookie/CSRF/body, cancels before first Alarm and cannot spoof guest IP quota', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  const guest = client();
  await f.boot(guest);
  await f.call(`${API}/bootstrap`, guest, undefined, 403, { origin: 'https://evil.invalid' });
  await f.call(`${API}/bootstrap`, guest, undefined, 403, { host: 'evil.invalid' });
  await f.call(`${API}/bootstrap`, guest, undefined, 403, { 'sec-fetch-site': 'cross-site' });
  await f.call(`${API}/bootstrap`, guest, undefined, 400, { cookie: guest.cookie + '; ' + guest.cookie });
  await f.call(`${API}/sync?cursor=a&cursor=b`, guest, undefined, 400);
  const body = { requestId: randomUUID(), text: 'bad', delivery: 'voice' };
  const sendPath = `${API}/characters/wei-guagua/operations`;
  await f.call(sendPath, guest, body, 403, { 'x-csrf-token': 'bad' });
  await f.call(sendPath, guest, { ...body, provider: 'fake' }, 400);
  await f.call(sendPath, guest, { ...body, text: 'a'.repeat(9000) }, 400);
  const sent = await f.send(guest);
  const cancelled = await f.call(`${API}/operations/${sent.operation.operationId}/cancel`, guest, {});
  assert.equal(cancelled.status, 'cancelled');
  await f.restart();
  assert.equal((await f.settle(guest, sent.operation.operationId)).status, 'cancelled');
  const stats = await f.fixture<{ calls: unknown[] }>('/fixture/stats');
  assert.deepEqual(stats.calls, []);
  for (let n = 1; n < 32; n++)
    await f.call(`${API}/bootstrap`, client(), undefined, 200, { 'x-forwarded-for': `203.0.113.${n}` });
  await f.call(`${API}/bootstrap`, client(), undefined, 429, {
    'x-forwarded-for': '198.51.100.42',
    'cf-connecting-ip': '198.51.100.42',
  });
  await f.restart();
  await f.call(`${API}/bootstrap`, client(), undefined, 429);
  assert.equal((await f.fixture<{ principals: number }>('/fixture/stats')).principals, 32);
});

test('native materials: private upload, two-clip approval, new role and voice promotion persist; old private chat audio survives', async (t) => {
  const f = setup(t),
    owner = client(),
    player = client(),
    denied = client();
  await f.fixture('/fixture/assets');
  await f.boot(player);
  // Complete three offline replies so both old generated audio and the old fixed footer are exercised.
  for (let i = 0; i < 3; i++) {
    const sent = await f.send(player);
    assert.equal((await f.settle(player, sent.operation.operationId)).status, 'published');
  }
  const before = await f.boot(player),
    conv = before.conversations.find((c) => c.characterId === 'wei-guagua')!;
  const historyPath = `${API}/conversations/${conv.conversationId}/history`,
    history = await f.call(historyPath, player);
  const oldAudio = new Map<string, string>();
  for (const item of history.messages.filter((m: any) => m.audio)) {
    const path = `${API}/conversations/${conv.conversationId}/messages/${item.messageId}/audio/${item.audio.mediaId}`;
    const result = await f.request(path, player);
    assert.equal(result.status, 200);
    oldAudio.set(
      path,
      createHash('sha256')
        .update(Buffer.from(await result.arrayBuffer()))
        .digest('hex'),
    );
  }
  assert.ok(history.messages.some((m: any) => m.origin === 'trial_footer'));
  const grant = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: grant.token });
  const source = (await f.call(`${API}/admin/characters/wei-guagua/detail`, owner, {})).published.profile;
  const stats = await f.fixture('/fixture/stats');
  for (const id of ['wei-guagua', 'new-material-role']) {
    const base = `${API}/admin/characters/${id}`,
      profile = structuredClone(source);
    profile.template.id = id;
    profile.template.version = id === 'wei-guagua' ? source.template.version + 1 : 1;
    profile.template.voice = { profileId: id + '-next', version: 1, speed: 1 };
    profile.presentation.welcome = { text: '离线新素材欢迎语', version: 'new-welcome' };
    const saved = await f.call(base + '/save', owner, { expectedRevision: null, profile });
    const material = await f.call(base + '/material-prepare', owner, {
      requestId: randomUUID(),
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      referenceId: 'offline-existing-voice',
      model: 's2.1-pro',
    });
    const upload = { materialId: material.materialId, kind: 'welcome', base64: syntheticTone(500).toString('base64') };
    await f.call(base + '/material-upload', denied, upload, 401);
    await f.call(base + '/material-upload', owner, upload, 403, { 'x-csrf-token': 'wrong' });
    await f.call(base + '/material-upload', owner, upload);
    const read = await f.call(base + '/material-audio', owner, { materialId: material.materialId, kind: 'welcome' });
    assert.equal(read.base64, upload.base64);
    await f.restart(); // Persisted R2/SQL material can be resumed before approval or publication.
    await f.call(base + '/material-upload', owner, { ...upload, kind: 'footer' });
    await f.call(base + '/material-approve', owner, {
      materialId: material.materialId,
      acknowledgeRights: true,
      acknowledgeWelcomeListening: true,
      acknowledgeFooterListening: true,
      note: '离线合成试听认可',
    });
    const review = await f.fixture<any>('/fixture/catalog/review', { characterId: id });
    const input = {
      requestId: randomUUID(),
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: review.previewId,
      materialId: material.materialId,
      acknowledgeReview: true,
    };
    const published = await f.call(base + '/publish', owner, input);
    await f.restart();
    assert.deepEqual(await f.call(base + '/publish', owner, input), published);
    const current = await f.boot(player),
      role = current.characters.find((c) => c.characterId === id)!;
    assert.equal(role.welcome.text, profile.presentation.welcome.text);
    assert.equal(role.welcome.audio.state, 'available');
    if (role.welcome.audio.state !== 'available') throw Error('missing clip');
    const audio = await f.request(role.welcome.audio.url, client());
    assert.equal(audio.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await audio.arrayBuffer()))
        .digest('hex'),
      read.sha256,
    );
  }
  assert.deepEqual(await f.call(historyPath, player), history);
  assert.deepEqual((await f.boot(player)).access, before.access);
  assert.equal((await f.boot(player)).characters.length, 4);
  assert.deepEqual(await f.fixture('/fixture/stats'), stats, 'material operations never call or bill providers');
  for (const [path, hash] of oldAudio) {
    const response = await f.request(path, player);
    assert.equal(response.status, 200);
    assert.equal(
      createHash('sha256')
        .update(Buffer.from(await response.arrayBuffer()))
        .digest('hex'),
      hash,
    );
    await f.call(path, denied, undefined, 401);
  }
  // Explicit offline invitation allows a new player to use the newly published role without resetting IP quota.
  const invite = await f.call(
    `${API}/admin/invites/issue`,
    owner,
    { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: 'offline-material', note: null },
    201,
  );
  const fresh = client();
  await f.boot(fresh);
  await f.call(`${API}/invites/redeem`, fresh, { requestId: randomUUID(), code: invite.code }, 201);
  await f.boot(fresh);
  const sent = await f.send(fresh, 'new-material-role');
  assert.equal((await f.settle(fresh, sent.operation.operationId)).status, 'published');
});

test('scoped role deletion over actual HTTP keeps another role, identities and used quota; alarm finishes and restart preserves tombstone', async (t) => {
  const f = setup(t),
    owner = client(),
    member = client(),
    invited = client(),
    guest = client();
  await f.fixture('/fixture/assets');
  const ownerGrant = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: ownerGrant.token });
  const memberGrant = await f.call(`${API}/admin/members/issue`, owner, {
    requestId: randomUUID(),
    label: 'scoped deletion',
    memberId: null,
    permissions: ['characters.read:wei-guagua', 'characters.delete:jojo'],
  });
  await f.call(`${API}/admin/login`, member, { token: memberGrant.token });
  await f.boot(invited);
  await f.boot(guest);
  const invite = await f.call(
    `${API}/admin/invites/issue`,
    owner,
    { requestId: randomUUID(), redeemBy: null, accessDurationMs: null, batch: 'deletion-isolation', note: null },
    201,
  );
  await f.call(`${API}/invites/redeem`, invited, { requestId: randomUUID(), code: invite.code }, 201);
  await f.boot(invited);
  const ops = [];
  for (const [actor, id] of [
    [invited, 'wei-guagua'],
    [invited, 'jojo'],
    [guest, 'wei-guagua'],
  ] as const) {
    const sent = await f.send(actor, id);
    assert.equal((await f.settle(actor, sent.operation.operationId)).status, 'published');
    ops.push(sent.operation.operationId);
  }
  const invitedBefore = await f.boot(invited),
    guestBefore = await f.boot(guest),
    stats = await f.fixture('/fixture/stats');
  const old = invitedBefore.conversations.find((c) => c.characterId === 'wei-guagua')!,
    keep = invitedBefore.conversations.find((c) => c.characterId === 'jojo')!;
  const oldPath = `${API}/conversations/${old.conversationId}/history`,
    keepPath = `${API}/conversations/${keep.conversationId}/history`;
  const goneHistory = await f.call(oldPath, invited),
    keptHistory = await f.call(keepPath, invited);
  const audioPath = (conv: string, msg: any) =>
    `${API}/conversations/${conv}/messages/${msg.messageId}/audio/${msg.audio.mediaId}`;
  const goneAudio = audioPath(
    old.conversationId,
    goneHistory.messages.find((m: any) => m.audio),
  );
  const keptAudio = audioPath(
    keep.conversationId,
    keptHistory.messages.find((m: any) => m.audio),
  );
  const hash = async () => {
    const r = await f.request(keptAudio, invited);
    assert.equal(r.status, 200);
    return createHash('sha256')
      .update(Buffer.from(await r.arrayBuffer()))
      .digest('hex');
  };
  const beforeHash = await hash(),
    base = `${API}/admin/characters/wei-guagua`;
  await f.call(`${base}/delete-preview`, member, {}, 403);
  await f.call(`${base}/delete-preview`, guest, {}, 401);
  const profile = (await f.call(`${base}/detail`, owner, {})).published.profile;
  profile.template.version++;
  const impact = await f.call(`${base}/delete-preview`, owner, {});
  assert.equal(impact.conversations, 2);
  const input = { requestId: randomUUID(), previewHash: impact.previewHash, acknowledgeDeleteAllChats: true };
  await f.call(`${base}/delete-start`, { ...owner, csrf: '0'.repeat(64) }, input, 403);
  await f.call(`${base}/delete-start`, member, input, 403);
  await f.call(`${API}/admin/members/permissions`, owner, {
    memberId: memberGrant.memberId,
    permissions: ['characters.read:wei-guagua', 'characters.delete:wei-guagua'],
  });
  const memberCookie = member.cookie;
  await f.call(`${base}/delete-start`, member, input, 202);
  await f.call(oldPath, invited, undefined, 404);
  await f.call(goneAudio, invited, undefined, 404);
  await f.call(`${API}/operations/${ops[0]}`, invited, undefined, 404);
  await f.send(invited, 'wei-guagua', randomUUID(), 404);
  const welcome = invitedBefore.characters.find((c) => c.characterId === 'wei-guagua')!.welcome.audio;
  assert.equal(welcome.state, 'available');
  if (welcome.state === 'available') await f.call(welcome.url, client(), undefined, 404);
  const deadline = Date.now() + 20_000;
  let done;
  do {
    done = await f.call(`${base}/delete-status`, member, {});
    if (done.state === 'deleted') break;
    assert.ok(Date.now() < deadline, JSON.stringify(done));
    await sleep(100);
  } while (true);
  assert.equal(done.total, 2);
  assert.equal(done.databaseCleared, 2);
  assert.equal(done.audioCleared, 2);
  await f.call(`${base}/save`, owner, { expectedRevision: null, profile }, 409);
  await f.call(`${API}/admin/members/permissions`, owner, { memberId: memberGrant.memberId, permissions: [] });
  assert.deepEqual((await f.call(`${API}/admin/session`, member)).member.permissions, []);
  assert.equal(member.cookie, memberCookie);
  await f.call(`${base}/delete-start`, member, input, 403);
  await f.restart();
  const invitedAfter = await f.boot(invited),
    guestAfter = await f.boot(guest);
  assert.deepEqual(invitedAfter.access, invitedBefore.access);
  assert.equal(guestAfter.access.canSend, false);
  assert.equal(guestAfter.access.remainingReplies, guestBefore.access.remainingReplies);
  assert.equal(guestAfter.conversations.length, 0);
  assert.ok(!invitedAfter.characters.some((c) => c.characterId === 'wei-guagua'));
  assert.deepEqual(invitedAfter.conversations, [keep]);
  assert.deepEqual(await f.call(keepPath, invited), keptHistory);
  assert.equal(await hash(), beforeHash);
  assert.deepEqual(await f.fixture('/fixture/stats'), stats);
  await f.call(oldPath, invited, undefined, 404);
  assert.equal((await f.call(`${base}/delete-status`, owner, {})).state, 'deleted');
});

test('bootstrap never clears active, unknown, rotated or invited cookies', async (t) => {
  const f = setup(t),
    owner = client(),
    guest = client();
  await f.fixture('/fixture/assets');
  await f.boot(guest);
  const active = await f.request(`${API}/bootstrap`, guest);
  assert.equal(active.status, 200);
  assert.equal(active.headers.get('set-cookie'), null);
  const unknown = await f.request(`${API}/bootstrap`, { cookie: '__Host-fixture=' + 'z'.repeat(43), csrf: '' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.headers.get('set-cookie'), null);
  const grant = await f.fixture<any>('/fixture/grant');
  await f.call(`${API}/admin/login`, owner, { token: grant.token });
  const issued = await f.call(
    `${API}/admin/invites/issue`,
    owner,
    {
      requestId: randomUUID(),
      batch: 'expiry-boundary',
      note: 'synthetic',
      redeemBy: Date.now() + 600000,
      accessDurationMs: null,
    },
    201,
  );
  const old = { ...guest };
  await f.call(`${API}/invites/redeem`, guest, { requestId: randomUUID(), code: issued.code }, 201);
  const invited = await f.boot(guest);
  const rotated = await f.request(`${API}/bootstrap`, old);
  assert.notEqual(rotated.status, 200);
  assert.equal(rotated.headers.get('set-cookie'), null);
  await f.fixture('/fixture/session-expire', { principalId: invited.access.principalId });
  await f.restart();
  const expired = await f.request(`${API}/bootstrap`, guest);
  assert.equal(expired.status, 401);
  assert.equal(((await expired.json()) as any).error.code, 'SESSION_EXPIRED');
  assert.equal(expired.headers.get('set-cookie'), null);
});
