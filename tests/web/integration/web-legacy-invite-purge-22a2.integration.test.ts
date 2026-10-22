import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer?: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type Sweep = { processed: number; failed: number; error: string | null };
type WorldState = {
  rows: Record<string, number>;
  retention: { state: string; db_cleared_at: number | null };
  foreignKeyViolations: number;
};
type LegacyRows = {
  grants: number;
  unrevokedGrants: number;
  redemptions: number;
  credentials: number;
  identityReceipts: number;
  credentialReceipts: number;
};

/**
 * Part 22a2, item 1. Production reported purging=2, failing=2 after the 22x deploy: migration 126 turned the old kind-'invite'
 * principals into expired guests but left their rows in the old invite tables, with the grant UNREVOKED, and the 'cleared'
 * audit refuses a world that still holds an unrevoked grant (WEB_RETENTION_UNEXPECTED_WORLD_DATA, sub 'audit_cleared').
 * Real HTTP into workerd SQLite; the principal is built in exactly the shape 126 leaves and then purged by the alarm sweep
 * (the expired guest) and by the player's own account deletion - both through WebCloudRetention.clearDatabase.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-cross-path-worker.ts',
    { STATE: 'WebCrossPathFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  let tokens = 0;
  const call = async (path: string, actor: Client, body?: unknown, status = 200, turnstile?: string) => {
    const response = await runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        ...(turnstile ? { 'x-turnstile-token': `good-${turnstile}-${++tokens}` } : {}),
        ...(actor.peer ? { 'x-fixture-peer': actor.peer } : {}),
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const text = await response.text();
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
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
  const reply = async (actor: Client, text: string) => {
    const sent = await call(
      `${API}/characters/wei-guagua/operations`,
      actor,
      { requestId: randomUUID(), text, delivery: 'voice' },
      202,
    );
    assert.equal((await settle(actor, sent.operation.operationId)).status, 'published');
  };
  const boot = async (actor: Client) =>
    (await call(`${API}/bootstrap`, actor, undefined, 200, 'guest')).access.principalId as string;
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(`${API}/account/request-code`, actor, { purpose: 'signup', email }, 200, 'code');
    let mail: Mail | undefined;
    for (let i = 0; i < 100 && !mail; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length > before) mail = list.at(-1);
      else await sleep(20);
    }
    await call(`${API}/account/verify-code`, actor, { challengeId: challenge.challengeId, code: mail!.code });
    return call(`${API}/account/signup`, actor, {
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: '阿泡',
      adult: true,
    });
  };
  return { runtime, call, reply, boot, signUp, fixture: runtime.call };
}

/** What may remain of a purged player: shells of ids, times and counters, never content. */
const SHELLS = new Set([
  'world_characters',
  'conversations',
  'participants',
  'contacts',
  'web_principals',
  'web_operations',
  'web_sessions',
  'web_guest_retention',
  'web_invite_grants',
  'web_external_attempts',
  'web_provider_attempts',
  'cf_web_audio_objects',
]);

for (const on of [true, false]) {
  test(`legacy invite rows in the shape migration 126 leaves are purged by the sweep and by account deletion (switches ${on ? 'on' : 'off'})`, async (t) => {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', {
      signupEnabled: true,
      accountDelete: true,
      legalPages: true,
      graceMs: 86_400_000,
      turnstile: true,
    });
    await f.fixture('/fixture/cross/choice', { on });
    await f.fixture('/fixture/cross/signup-switch', { on });
    await f.fixture('/fixture/cross/review-switch', { on });

    // A: an expired guest without a login (the alarm sweep). B: a signed-up player who deletes the account.
    const A: Client = { cookie: '', csrf: '', peer: '10.9.0.1' };
    const idA = await f.boot(A);
    await f.reply(A, '旧邀请测试账号');
    const B: Client = { cookie: '', csrf: '', peer: '10.9.0.2' };
    const idB = await f.boot(B);
    await f.signUp(B, 'old-invite@example.com');
    await f.reply(B, '旧邀请注册玩家');
    for (const principalId of [idA, idB]) {
      await f.fixture('/fixture/cross/legacy-126', { principalId });
      const before = await f.fixture<LegacyRows>('/fixture/cross/legacy-rows', { principalId });
      assert.deepEqual(before, {
        grants: 1,
        unrevokedGrants: 1,
        redemptions: 1,
        credentials: 1,
        identityReceipts: 1,
        credentialReceipts: 1,
      });
    }

    // B asks for the deletion while the legacy rows are there: it must complete, not stay 'purging'.
    assert.deepEqual(await f.call(`${API}/account/delete`, B, { password: PASSWORD, confirm: '删除' }), {
      deleted: true,
      complete: true,
    });
    // A is an expired guest: the alarm sweep purges it.
    assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 1, failed: 0, error: null });
    assert.deepEqual(await f.fixture('/fixture/world/reports'), [], 'no failure was reported');

    for (const principalId of [idA, idB]) {
      const after = await f.fixture<WorldState>('/fixture/world/state', { principalId });
      assert.equal(after.retention.state, 'purged');
      assert.equal(after.foreignKeyViolations, 0);
      assert.deepEqual(
        Object.keys(after.rows).filter((table) => !SHELLS.has(table)),
        [],
        'only shells remain',
      );
      assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });
      const legacy = await f.fixture<LegacyRows>('/fixture/cross/legacy-rows', { principalId });
      assert.equal(legacy.unrevokedGrants, 0, 'no live grant survives');
      assert.deepEqual(
        [legacy.redemptions, legacy.credentials, legacy.identityReceipts, legacy.credentialReceipts],
        [0, 0, 0, 0],
        'nothing but the revoked grant shell remains',
      );
    }
    assert.equal((await f.fixture<{ failing: number }>('/fixture/world/health')).failing, 0);
  });
}

// Part 22a2: the next diagnosis must not need a live tail. The operator's health (the retention block of inspect) lists, for each
// failing principal, where its last failure broke and how often in a row - labels and counts only.
test('the retention health names phase, sub, error class, message shape and failure count of each failing principal, never an id', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', {
    signupEnabled: true,
    accountDelete: true,
    legalPages: true,
    graceMs: 86_400_000,
    turnstile: true,
  });
  const email = 'secret.person@example.com';
  const A: Client = { cookie: '', csrf: '', peer: '10.9.1.1' };
  const idA = await f.boot(A);
  await f.reply(A, '这是我的私密聊天内容');
  await f.fixture('/fixture/cross/legacy-126', { principalId: idA });
  const message = `boom ${idA} ${email} at row 4711`;
  await f.fixture('/fixture/world/poison', { on: true, message });
  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), {
    processed: 1,
    failed: 1,
    error: 'WEB_RETENTION_FAILED',
  });
  const first = await f.fixture<{ failing: number; failures: Record<string, unknown>[] }>('/fixture/world/health');
  assert.equal(first.failing, 1);
  assert.equal(first.failures.length, 1);
  assert.deepEqual(
    { ...first.failures[0], messageShape: undefined },
    {
      code: 'WEB_RETENTION_FAILED',
      phase: 'clearDatabase',
      sub: 'messages',
      errorName: 'Error',
      count: 1,
      messageShape: undefined,
    },
  );
  assert.match(String(first.failures[0]!.messageShape), /^boom <tok> <email> at row <n>/);
  // A second failure in a row (after the backoff) raises the count.
  await f.fixture('/fixture/world/skew', { ms: 60_000 });
  assert.equal((await f.fixture<Sweep>('/fixture/world/sweep')).failed, 1);
  assert.equal((await f.fixture<{ failures: { count: number }[] }>('/fixture/world/health')).failures[0]!.count, 2);
  const serialized = JSON.stringify(await f.fixture('/fixture/world/health'));
  for (const secret of [idA, email, 'secret.person', '私密', '4711'])
    assert.ok(!serialized.includes(secret), `the health does not contain ${secret}`);
  // The fault goes away: the purge finishes (the legacy rows no longer block it) and the list empties.
  await f.fixture('/fixture/world/poison', { on: false });
  await f.fixture('/fixture/world/skew', { ms: 6 * 60 * 60_000 });
  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 1, failed: 0, error: null });
  assert.deepEqual(await f.fixture('/fixture/world/health').then((h: any) => [h.failing, h.failures]), [0, []]);
});
