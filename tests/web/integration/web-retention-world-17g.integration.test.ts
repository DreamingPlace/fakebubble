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
type World = {
  rows: Record<string, number>;
  retention: { state: string; db_cleared_at: number | null };
  foreignKeyViolations: number;
};
type Sweep = { processed: number; failed: number; error: string | null };
type Health = { failing: number; oldestAgeBucket: string | null; lastSuccessAt: number | null };
const client = (peer?: string): Client => ({ cookie: '', csrf: '', ...(peer ? { peer } : {}) });
const a = (path: string) => `${API}/account${path}`;

/**
 * Part 17g. Real HTTP into workerd SQLite with EVERY switch that touches a purge on (signup bonus, chat review, model
 * choice and points, account deletion, guest grace) and every kind of principal the retention sweep handles in one place.
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
  const settle = async (actor: Client, id: string, timeout = 30_000) => {
    const end = Date.now() + timeout;
    while (true) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (['published', 'failed', 'cancelled'].includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  const reply = async (actor: Client, text: string, timeout?: number) => {
    const sent = await call(
      `${API}/characters/wei-guagua/operations`,
      actor,
      { requestId: randomUUID(), text, delivery: 'voice' },
      202,
    );
    assert.equal((await settle(actor, sent.operation.operationId, timeout)).status, 'published');
  };
  const boot = async (actor: Client) =>
    (await call(`${API}/bootstrap`, actor, undefined, 200, 'guest')).access.principalId as string;
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
  return { ...runtime, request, call, reply, boot, signUp, owner, fixture: runtime.call };
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
  'web_invite_redemptions',
  'web_external_attempts',
  'web_provider_attempts',
  'cf_web_audio_objects',
]);

async function world(t: test.TestContext) {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', {
    signupEnabled: true,
    accountDelete: true,
    legalPages: true,
    graceMs: DAY,
    turnstile: true,
  });
  const owner = await f.owner();
  const submit = (actor: Client, n: number) =>
    f.call(
      `${API}/cocreation/submit`,
      actor,
      { characterId: 'wei-guagua', requestId: `co-${n}`, answers: [{ cardId: 'catchphrase', text: '哎呀妈呀' }] },
      201,
    );
  const stateOf = (principalId: string) => f.fixture<World>('/fixture/world/state', { principalId });
  const seed = (principalId: string, code: string) => f.fixture('/fixture/world/seed', { principalId, code });
  const block = (principalId: string, on: boolean) => f.fixture('/fixture/purge-block', { principalId, on });
  // NAMED EXCEPTION: an old invited player (a guest since migration 126, holding the unlimited entitlement migration 125 backfilled
  // for one with a login) is OLD DATA; the legacy redemption that used to create it no longer runs there.
  const invited = async (actor: Client) =>
    f.fixture('/fixture/cross/legacy', { principalId: await f.boot(actor), login: true });
  const make = async (peer: string) => {
    const actor = client(peer);
    return { actor, principalId: await f.boot(actor) };
  };
  return { f, owner, submit, stateOf, seed, block, invited, make };
}

// Part 17g, the reproduction the diagnostics asked for. Before the fix the sweep reported
// {phase:'clearDatabase', sub:'web_provider_media_assets', errorName:'Error', messageShape:'WEB_PROVIDER_MEDIA_IMMUTABLE: ...',
// principalKind:'invite', state:'purging'} for the invited player every ~30 s, forever.
test('one world with every kind of principal and every feature table: sweep() and finishDeletion() purge them all without a failure', async (t) => {
  const { f, owner, submit, stateOf, seed, block, invited, make } = await world(t);

  // E: the same kind of invited player, deleting while nothing is blocked: finishDeletion() itself must complete
  // (done first: a stuck purge gate row anywhere makes every clear fail closed, which C and D below rely on).
  const E = await make('10.7.0.5');
  await f.signUp(E.actor, 'eee@example.com');
  await f.reply(E.actor, '受邀玩家二号');
  await invited(E.actor);
  await submit(E.actor, 5);
  await seed(E.principalId, 'X8YD');
  const deleted = await f.call(a('/delete'), E.actor, { password: PASSWORD, confirm: '删除' });
  assert.deepEqual(deleted, {
    deleted: true,
    complete: true,
  });

  // A: an expired plain guest.
  const A = await make('10.7.0.1');
  await f.reply(A.actor, '普通访客');
  await submit(A.actor, 1);
  await seed(A.principalId, 'K7M2');

  // B: a guest with signup bonus + login (points, free operations, nickname card), one reply delivered as text fallback.
  const B = await make('10.7.0.2');
  await f.signUp(B.actor, 'bee@example.com');
  for (let n = 0; n < 3; n++) await f.reply(B.actor, `第${n}句`);
  await f.fixture('/fixture/world/speech-fail', { on: true });
  await f.reply(B.actor, '语音失败后的文字回复', 120_000);
  await f.fixture('/fixture/world/speech-fail', { on: false });
  await f.call(`${API}/admin/conversations/list`, owner, { characterId: null, scope: null, page: 0 });
  await submit(B.actor, 2);
  await seed(B.principalId, 'Q9ZH');

  // C: a guest that asked to clear its data while the clear is blocked: state 'purging', all data still there.
  const C = await make('10.7.0.3');
  await f.reply(C.actor, '请求清除');
  await submit(C.actor, 3);
  await seed(C.principalId, 'R4TN');
  await block(C.principalId, true);
  assert.deepEqual(await f.call(a('/delete'), C.actor, { password: '', confirm: '清除' }), {
    deleted: true,
    complete: false,
  });

  // D: an invited player (signed up, then redeemed a code) who deleted the account: grants revoked, 'purging'.
  const D = await make('10.7.0.4');
  await f.signUp(D.actor, 'dee@example.com');
  await f.reply(D.actor, '受邀玩家');
  await invited(D.actor);
  await submit(D.actor, 4);
  await seed(D.principalId, 'W2XE');
  await block(D.principalId, true);
  assert.deepEqual(await f.call(a('/delete'), D.actor, { password: PASSWORD, confirm: '删除' }), {
    deleted: true,
    complete: false,
  });

  // Time passes: A is past trial + grace, B has been away for more than 180 days.
  await f.fixture('/fixture/world/age', { principalId: A.principalId, ms: 30 * DAY });
  await f.fixture('/fixture/world/age', { principalId: B.principalId, ms: 181 * DAY });
  for (const { principalId } of [A, B, C, D]) {
    const before = await stateOf(principalId);
    for (const table of [
      'messages',
      'memory_facts',
      'memory_embeddings',
      'web_cocreation_submissions',
      'web_points_events',
      'web_provider_media_assets',
    ])
      assert.ok(before.rows[table]! > 0, `${table} holds rows before the purge`);
  }
  assert.ok((await stateOf(B.principalId)).rows.web_signup_bonus === 1, 'B holds the signup bonus');
  assert.ok((await stateOf(B.principalId)).rows.web_player_logins === 1, 'B has a login');
  await block(C.principalId, false);
  await block(D.principalId, false);

  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 4, failed: 0, error: null });
  assert.deepEqual(await f.fixture('/fixture/world/reports'), [], 'no sweep report');
  // (The fixture's own alarm may also have retried the blocked C and D as 'sweep' reports.) The only deletion reports are the two blocked ones above (C, D), each naming the fixed code and where it stopped.
  assert.deepEqual(
    (
      await f.fixture<{ step: string; code: string; phase: string; sub: string; principalKind: string }[]>(
        '/fixture/retention-reports',
      )
    )
      .filter((r) => r.step === 'deletion')
      .map((r) => [r.step, r.code, r.phase, r.sub, r.principalKind]),
    [
      ['deletion', 'WEB_RETENTION_SCOPE_UNSAFE', 'clearDatabase', 'scope', 'guest'],
      // Named exception (Part 22x): D is an old invited player, now a guest holding an entitlement (migration 126), so its
      // blocked deletion reports principalKind 'guest'; the kind 'invite' no longer exists.
      ['deletion', 'WEB_RETENTION_SCOPE_UNSAFE', 'clearDatabase', 'scope', 'guest'],
    ],
  );
  for (const { principalId } of [A, B, C, D, E]) {
    const after = await stateOf(principalId);
    assert.equal(after.retention.state, 'purged');
    assert.equal(after.foreignKeyViolations, 0);
    assert.deepEqual(
      Object.keys(after.rows).filter((table) => !SHELLS.has(table)),
      [],
      'only shells remain',
    );
    assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId }), { clean: true, loginsRemain: false });
  }
  // The anonymous archive was written for the players who had chats, and nothing is left to do.
  const review = await f.fixture<{ archive: unknown[] }>('/fixture/review-state');
  assert.ok(review.archive.length > 0);
  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 0, failed: 0, error: null });
  const health = await f.fixture<Health>('/fixture/world/health');
  assert.equal(health.failing, 0);
  assert.ok(health.lastSuccessAt !== null);
});

test('a failing purge reports where it broke and never what is in it; it backs off 1 min, 5 min, 30 min, then 6 h, and the others still go', async (t) => {
  const { f, submit, stateOf, seed, make } = await world(t);
  const email = 'secret.person@example.com',
    ipHash = 'ab12'.repeat(16),
    text = '这是我的私密聊天内容 only-for-me';
  const bad = await make('10.8.0.1');
  await f.reply(bad.actor, text);
  await seed(bad.principalId, 'K7M2');
  const good = await make('10.8.0.2');
  await f.reply(good.actor, '另一个访客');
  await submit(good.actor, 1);
  for (const p of [bad, good]) await f.fixture('/fixture/world/age', { principalId: p.principalId, ms: 30 * DAY });
  // The error text carries an id, an e-mail address, an IP hash, a nickname (quoted, ASCII and Chinese) and chat text.
  const message = `boom ${bad.principalId} ${email} ${ipHash} nick "阿泡" 'Nick' ${text} at row 4711`;
  await f.fixture('/fixture/world/poison', { on: true, message });
  // Only the bad principal fails: the poison trigger is armed for every delete, so arm it and let the good one go first.
  await f.fixture('/fixture/world/poison', { on: false });
  await f.fixture('/fixture/world/poison', { on: true, message });

  const first = await f.fixture<Sweep>('/fixture/world/sweep');
  assert.equal(first.processed, 2);
  assert.equal(first.failed, 2, 'the trigger fails every clear');
  const reports = await f.fixture<Record<string, unknown>[]>('/fixture/world/reports');
  assert.equal(reports.length, 1, 'both failures are one cause: one report');
  const report = reports[0]!;
  assert.deepEqual(
    { event: report.event, step: report.step, code: report.code, failed: report.failed, stuck: report.stuck },
    { event: 'web_retention_failed', step: 'sweep', code: 'WEB_RETENTION_FAILED', failed: 2, stuck: 2 },
  );
  assert.equal(report.phase, 'clearDatabase');
  assert.equal(report.sub, 'messages');
  assert.equal(report.errorName, 'Error');
  assert.equal(report.principalKind, 'guest');
  assert.equal(report.state, 'purging');
  assert.match(String(report.oldestAgeBucket), /^(<1d|1-7d|7-30d|>30d)$/);
  assert.match(String(report.at), /^[A-Za-z0-9._-]+\.(ts|js|mjs):\d+$/);
  assert.match(String(report.messageShape), /^boom <tok> <email> <tok> nick <q> <q> /);
  assert.ok(String(report.messageShape).length <= 160);
  const serialized = JSON.stringify(reports);
  for (const secret of [bad.principalId, email, 'secret.person', ipHash, '阿泡', 'Nick', '私密', 'only-for-me', '4711'])
    assert.ok(!serialized.includes(secret), `the report does not contain ${secret}`);
  // The tail line the production object writes is exactly this JSON.
  assert.ok(Object.keys(report).every((key) => /^[a-zA-Z]+$/.test(key)));

  // Backoff: nothing is retried inside the first minute, the alarm still runs, and the delay grows 1 min, 5 min, 30 min, 6 h.
  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 0, failed: 0, error: null });
  assert.equal((await f.fixture<unknown[]>('/fixture/world/reports')).length, 1, 'no new report while backed off');
  await f.fixture('/fixture/run-alarm');
  let attempts = 1;
  for (const wait of [60_000, 5 * 60_000, 30 * 60_000, 6 * 60 * 60_000, 6 * 60 * 60_000]) {
    await f.fixture('/fixture/world/skew', { ms: wait - 1_000 });
    assert.equal((await f.fixture<Sweep>('/fixture/world/sweep')).processed, 0, `still waiting ${wait} ms`);
    await f.fixture('/fixture/world/skew', { ms: 1_000 });
    const again = await f.fixture<Sweep>('/fixture/world/sweep');
    assert.deepEqual([again.processed, again.failed], [2, 2], `retried after ${wait} ms`);
    attempts++;
  }
  assert.equal(attempts, 6);
  const health = await f.fixture<Health>('/fixture/world/health');
  assert.equal(health.failing, 2);
  assert.match(String(health.oldestAgeBucket), /^(<1d|1-7d|7-30d|>30d)$/);
  assert.equal(health.lastSuccessAt, null);

  // The fault goes away: both finish on the next due retry, and the ledger forgets them.
  await f.fixture('/fixture/world/poison', { on: false });
  await f.fixture('/fixture/world/skew', { ms: 6 * 60 * 60_000 });
  assert.deepEqual(await f.fixture<Sweep>('/fixture/world/sweep'), { processed: 2, failed: 0, error: null });
  assert.equal((await stateOf(bad.principalId)).retention.state, 'purged');
  assert.equal((await stateOf(good.principalId)).retention.state, 'purged');
  const healed = await f.fixture<Health>('/fixture/world/health');
  assert.equal(healed.failing, 0);
  assert.ok(healed.lastSuccessAt !== null);
});

// Part 17h. A SQLite-backed Durable Object that has used the key-value API also holds workerd's reserved _cf_KV table.
// Reading it is denied, so before the fix the world audit failed every purge, reporting
// {phase:'clearDatabase', sub:'audit_source', errorName:'Error', messageShape:'not <tok>: SQLITE_AUTH'} (reproduced here).
test('17h: with the key-value API in use (alerts key + retention ledger) the purge succeeds, the audit is clean and lastSuccessAt is set', async (t) => {
  const { f, stateOf, seed, make } = await world(t);
  const player = await make('10.9.0.1');
  await f.reply(player.actor, '普通访客');
  await seed(player.principalId, 'K7M2');
  await f.fixture('/fixture/world/age', { principalId: player.principalId, ms: 30 * DAY });
  await f.fixture('/fixture/world/kv', { key: 'alerts:probe', value: 1 });
  assert.deepEqual(await f.fixture('/fixture/world/sweep'), { processed: 1, failed: 0, error: null });
  assert.deepEqual(await f.fixture('/fixture/world/reports'), []);
  const after = await stateOf(player.principalId);
  assert.equal(after.retention.state, 'purged');
  assert.equal(after.foreignKeyViolations, 0);
  assert.deepEqual(await f.fixture('/fixture/audit-world', { principalId: player.principalId }), {
    clean: true,
    loginsRemain: false,
  });
  const health = await f.fixture<Health>('/fixture/world/health');
  assert.equal(health.failing, 0);
  assert.ok(health.lastSuccessAt !== null, 'a success is recorded in the ledger');
});

test('17h: workerd refuses an application table named _cf_*, so the audit skips that prefix only; any other unknown table still fails closed', async (t) => {
  const { f, stateOf, seed, make } = await world(t);
  for (const name of ['_cf_x', '_CF_x', '_cf_KV'])
    assert.equal((await f.fixture<{ created: boolean }>('/fixture/world/create-table', { name })).created, false, name);
  const player = await make('10.9.0.2');
  await f.reply(player.actor, '普通访客');
  await seed(player.principalId, 'K7M2');
  await f.fixture('/fixture/world/age', { principalId: player.principalId, ms: 30 * DAY });
  await f.fixture('/fixture/world/kv', { key: 'alerts:probe', value: 1 });
  assert.equal(
    (
      await f.fixture<{ created: boolean }>('/fixture/world/create-table', {
        name: 'web_unknown_17h',
        principalId: player.principalId,
      })
    ).created,
    true,
  );
  const sweep = await f.fixture<Sweep>('/fixture/world/sweep');
  assert.deepEqual([sweep.processed, sweep.failed], [1, 1], 'an unknown table holding the world fails closed');
  assert.notEqual((await stateOf(player.principalId)).retention.state, 'purged');
  const [report] = await f.fixture<{ sub: string; messageShape: string }[]>('/fixture/world/reports');
  assert.match(String(report?.messageShape), /UNEXPECTED_WORLD_DATA|UNRECOGNIZED|SCOPE_UNSAFE/);
});

// Part 17h, real HTTP. An account that signed up before Part 17b: a login and no bonus row. Past its 7-day window it was
// answered TRIAL_EXPIRED (HTTP 410) while the page still showed points; now the first touch grants the bonus once.
test('17h: a signed-in account with no bonus row, past its trial window, chats and is charged in points (bonus granted once)', async (t) => {
  const { f, stateOf, make } = await world(t);
  const player = await make('10.9.1.1');
  await f.signUp(player.actor, 'old.account@example.com');
  await f.fixture('/fixture/world/unbonus', { principalId: player.principalId });
  await f.fixture('/fixture/world/age', { principalId: player.principalId, ms: 10 * DAY });
  assert.equal((await stateOf(player.principalId)).rows.web_signup_bonus, undefined);
  await f.reply(player.actor, '很久以前注册的账号');
  await f.reply(player.actor, '第二句');
  const after = await stateOf(player.principalId);
  assert.equal(after.rows.web_signup_bonus, 1, 'granted once, on the first touch');
  assert.ok(after.rows.web_points_events! >= 3, 'the opening balance and both replies are points events');
  const account = await f.call(`${API}/account`, player.actor);
  assert.equal(account.hasLogin, true);
  assert.equal(account.modelChoice.metered, true);
});
