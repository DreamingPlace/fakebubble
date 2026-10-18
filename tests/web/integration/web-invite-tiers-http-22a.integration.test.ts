import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
const client = (): Client => ({ cookie: '', csrf: '' });
const a = (path: string) => `${API}/account${path}`;

/**
 * Part 22a. Real HTTP into workerd SQLite with the free tier AND model choice on (the all-switches fixture): the owner makes a
 * batch, a guest is refused without consuming the code, a signed-up player redeems it, and every figure agrees on both sides.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-retention-world-worker.ts',
    { STATE: 'WebRetentionWorldFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const seen: string[] = [];
  const request = (path: string, actor: Client, body?: unknown) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const call = async (path: string, actor: Client, body?: unknown, status = 200) => {
    const response = await request(path, actor, body),
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
  return { ...runtime, request, call, signUp, seen, fixture: runtime.call };
}

test('22a over real HTTP: a guest’s code is refused unconsumed; a signed-up player redeems it and stays the same principal', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client(),
    player = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  const made = await f.call(
    `${API}/admin/invites/batch-create`,
    owner,
    {
      requestId: 'http-batch-1',
      name: '春季内测',
      count: 2,
      tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
      durationDays: null,
      redeemBy: null,
    },
    201,
  );
  const [first, second] = made.codes as string[];
  assert.equal(made.duplicate, false);
  // The same request id again: the same batch, and NO codes.
  const again = await f.call(
    `${API}/admin/invites/batch-create`,
    owner,
    {
      requestId: 'http-batch-1',
      name: '春季内测',
      count: 2,
      tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
      durationDays: null,
      redeemBy: null,
    },
    200,
  );
  assert.deepEqual([again.duplicate, again.codes, again.batchId], [true, null, made.batchId]);

  const principal = (await f.call(`${API}/bootstrap`, player)).access.principalId as string;
  // A guest enters a code: refused, and the code is NOT consumed.
  assert.equal(
    (await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: first }, 409)).error.code,
    'PLAYER_LOGIN_REQUIRED',
  );
  const listed = (await f.call(`${API}/admin/invites/batch-list`, owner, {})).batches;
  assert.deepEqual([listed[0].codes, listed[0].redeemed, listed[0].holders], [2, 0, 0]);

  await f.signUp(player, 'tier.one@example.com');
  const info0 = await f.call(a(''), player);
  assert.match(info0.playerNumber, /^[0-9A-HJKMNP-TV-Z]{8}$/, '玩家编号 from the moment of signup');
  assert.equal(info0.modelChoice.plan, undefined, 'no entitlement yet: a registered player');
  const before = info0.modelChoice.balance as number;

  const cookies = f.seen.length;
  const redeemed = await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: first }, 201);
  assert.deepEqual(redeemed.entitlement, { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null });
  assert.equal(f.seen.length, cookies, 'no new session: nothing about the player changed');
  const booted = await f.call(`${API}/bootstrap`, player);
  assert.equal(booted.access.principalId, principal, 'same principal');
  assert.equal(booted.access.kind, 'guest', 'principal kind is never changed by a redemption');

  const info = await f.call(a(''), player);
  assert.deepEqual(info.modelChoice.plan, { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null });
  assert.equal(info.modelChoice.balance, before + 50, 'the redemption was the first visit of the day: +50, once');
  assert.equal((await f.call(a(''), player)).modelChoice.balance, before + 50, 'a second visit the same day pays nothing');
  const billing = await f.call(`${API}/billing/history`, player, { page: 1 });
  assert.ok(billing.items.some((item: { kind: string; points: number }) => item.kind === 'daily_refill' && item.points === 50));
  // Redeeming the same code again (a new request) is refused; the replay of the first request answers the same.
  assert.equal(
    (await f.call(`${API}/invites/redeem`, player, { requestId: randomUUID(), code: first }, 409)).error.code,
    'WEB_INVITE_UNAVAILABLE',
  );

  // The administrator sees counts and the holder's 玩家编号 - nothing else of the player.
  const batches = (await f.call(`${API}/admin/invites/batch-list`, owner, {})).batches;
  assert.deepEqual([batches[0].codes, batches[0].redeemed, batches[0].holders], [2, 1, 1]);
  const detail = await f.call(`${API}/admin/invites/batch-detail`, owner, { batchId: made.batchId });
  const used = detail.codes.find((c: { state: string }) => c.state === 'redeemed');
  assert.equal(used.playerNumber, info.playerNumber);
  const text = JSON.stringify([batches, detail]);
  for (const secret of ['tier.one', 'example.com', principal, '阿泡']) assert.equal(text.includes(secret), false, secret);

  // The owner lowers N and the cap; it applies from the next refill, and nothing is taken away.
  const edit = await f.call(`${API}/admin/invites/batch-edit`, owner, {
    requestId: 'http-edit-1',
    batchId: made.batchId,
    dailyAmount: 20,
    cap: 100,
  });
  assert.deepEqual([edit.duplicate, edit.holders], [false, 1]);
  assert.equal((await f.call(a(''), player)).modelChoice.balance, before + 50);

  // Ending the redeemed code's entitlement: a registered player at once, with the balance that remains.
  await f.call(`${API}/admin/invites/entitlement-revoke`, owner, { id: used.id });
  const after = await f.call(a(''), player);
  assert.equal(after.modelChoice.plan, undefined);
  assert.equal(after.modelChoice.balance, before + 50);
  assert.equal((await f.call(`${API}/bootstrap`, player)).access.canSend, true, 'never a trial-ended state');

  // The second code still redeems for another signed-up player; revoking the whole batch afterwards leaves its holder alone.
  const other = client();
  await f.call(`${API}/bootstrap`, other);
  await f.signUp(other, 'tier.two@example.com');
  assert.equal((await f.call(`${API}/invites/redeem`, other, { requestId: randomUUID(), code: second }, 201)).entitlement.kind, 'daily_refill');
  assert.equal((await f.call(`${API}/admin/invites/batch-revoke`, owner, { batchId: made.batchId })).revoked, 0);
  assert.equal((await f.call(a(''), other)).modelChoice.plan.kind, 'daily_refill');
});
