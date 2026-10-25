import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import type { ChartView, CostsView, SpendView } from '../../../packages/contracts/web-stats.ts';
import { ARCHIVE_TTL_MS } from '../../../apps/server/review/web-chat-review.ts';

const API = '/api/web/provider',
  ADMIN = `${API}/admin`,
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type Extras = {
  hourly: { hour: string; metric: string; characterId: string; value: number }[];
  chatDays: { day: string; characterId: string; n: number }[];
  chatHours: { hour: string; characterId: string; n: number }[];
  userTypes: { userType: string; n: number }[];
  spend: { day: string; userType: string; kind: string; calls: number; chargedMicros: number }[];
  due: number | null;
  now: number;
  archive: number;
  archiveDue: number | null;
  archiveArchivedAt: number | null;
};
let peers = 0;
const client = (): Client => ({
  cookie: '',
  csrf: '',
  peer: `10.24.${Math.floor(peers / 250)}.${(++peers % 250) + 1}`,
});
const a = (path: string) => `${API}/account${path}`;
const last = <T>(values: T[]) => values[values.length - 1]!;

/** Part 22d: one real-HTTP workerd database with the real reply pipeline (the harness of 22c's HTTP test). */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-stats-worker.ts',
    { STATE: 'WebStatsFixture', PREVIEW_BUDGET: 'PreviewBudgetFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const request = (path: string, actor: Client, body?: unknown, headers: Record<string, string> = {}) =>
    runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-peer': actor.peer,
        'x-fixture-host': 'fixture.invalid',
        ...headers,
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  /** Every response body this test has read: scanned at the end for anything that must never leave. */
  const seen: string[] = [];
  const call = async (path: string, actor: Client, body?: unknown, status = 200) => {
    const response = await request(path, actor, body),
      text = await response.text();
    assert.equal(response.status, status, text);
    seen.push(text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  const refuse = async (path: string, actor: Client, body: unknown, status: number, code: string) => {
    const response = await request(path, actor, body),
      text = await response.text();
    assert.equal(response.status, status, `${path}: ${text}`);
    assert.equal(JSON.parse(text).error.code, code, `${path}: ${text}`);
  };
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email });
    let mail: Mail | undefined;
    for (let i = 0; i < 100 && !mail; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length > before) mail = list.at(-1);
      else await sleep(20);
    }
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail!.code });
    return call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '阿泡' });
  };
  const reply = async (actor: Client, characterId: string) => {
    const sent = await call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId: randomUUID(), text: '你好', delivery: 'voice' },
      202,
    );
    const end = Date.now() + 60_000;
    for (;;) {
      const operation = await call(`${API}/operations/${sent.operation.operationId}`, actor);
      if (['published', 'failed', 'cancelled', 'unknown'].includes(operation.status)) return operation.status as string;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  const admin = async () => {
    const owner = client();
    await call(`${ADMIN}/login`, owner, { token: (await runtime.call<{ token: string }>('/fixture/grant')).token });
    return owner;
  };
  return { ...runtime, request, call, refuse, signUp, reply, admin, seen, fixture: runtime.call };
}

test('22d the real pipeline: chat users per character, user types frozen at admission, spend by type, the two read routes', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  await f.fixture('/fixture/system/operator-renew', {});
  await f.fixture('/fixture/cross/choice', { on: true });
  await f.fixture('/fixture/cross/signup-switch', { on: true });
  await f.fixture('/fixture/stats/provider', { text: 'ok' });
  const owner = await f.admin();
  const G = client(),
    R = client();
  const boot = (actor: Client) => f.call(`${API}/bootstrap`, actor);
  await boot(G);
  await boot(R);
  await f.signUp(R, 'registered@example.com');
  await boot(R);

  // G (a guest) and R (registered) both write to wei-guagua; only R writes to jojo; R writes to wei-guagua again.
  assert.equal(await f.reply(G, 'wei-guagua'), 'published');
  assert.equal(await f.reply(R, 'wei-guagua'), 'published');
  assert.equal(await f.reply(R, 'jojo'), 'published');
  assert.equal(await f.reply(R, 'wei-guagua'), 'published');
  // R redeems a code of a TEST batch; its next reply is the test group's. The earlier ones stay what they were.
  const batch = await f.call(
    `${ADMIN}/invites/batch-create`,
    owner,
    {
      requestId: randomUUID(),
      name: 'test group',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
      test: true,
    },
    201,
  );
  await f.call(`${API}/invites/redeem`, R, { requestId: randomUUID(), code: batch.codes[0] }, 201);
  assert.equal(await f.reply(R, 'jojo'), 'published');

  const extras = await f.fixture<Extras>('/fixture/stats/extras', {});
  assert.deepEqual(
    extras.userTypes,
    [
      { userType: 'guest', n: 1 },
      { userType: 'registered', n: 3 },
      { userType: 'test', n: 1 },
    ],
    'frozen per reply: R was registered for three replies, then in the test group',
  );
  // Chat users: per day, wei-guagua 2 (G, R), jojo 1 (R); per hour the same plus the total of 2 players.
  assert.deepEqual(
    extras.chatDays.map((r) => r.n),
    [1, 2],
  );
  assert.deepEqual(
    extras.hourly.filter((r) => r.metric === 'chat_users' && r.characterId === '').map((r) => r.value),
    [2],
    'a player who wrote to two characters is one player in the total',
  );

  const chart = async (metric: string, range: string) =>
    (await f.call(`${ADMIN}/stats/chart`, owner, { metric, range })) as ChartView;
  const names = (await f.call(`${API}/bootstrap`, G)).characters.map(
    (c: { characterId: string; displayName: string }) => [c.characterId, c.displayName],
  );
  const nameOf = (id: string) => names.find((n: string[]) => n[0] === id)![1];
  for (const range of ['24h', '7d', '14d']) {
    const users = await chart('chat_users', range);
    assert.equal(users.bucket, range === '24h' ? 'hour' : 'day');
    assert.equal(users.buckets.length, range === '24h' ? 24 : range === '7d' ? 7 : 14);
    assert.equal(last(users.total), 2, `${range}: two players chatted`);
    assert.deepEqual(
      users.characters.map((c) => [c.name, last(c.values)]),
      [
        [nameOf('wei-guagua'), 2],
        [nameOf('jojo'), 1],
      ],
      `${range}: per character, by display name`,
    );
    const replies = await chart('replies', range);
    assert.equal(last(replies.total), 5, `${range}: five published replies`);
    assert.deepEqual(
      replies.characters.map((c) => [c.name, last(c.values)]),
      [
        [nameOf('wei-guagua'), 3],
        [nameOf('jojo'), 2],
      ],
    );
  }

  // Spend by user type: every call lands in the type frozen for its reply, text and voice apart, and it adds up to 22c's ledger column.
  const spend = (await f.call(`${ADMIN}/stats/spend-by-type`, owner, { range: 7 })) as SpendView;
  const costs = (await f.call(`${ADMIN}/stats/costs`, owner, { range: 7 })) as CostsView;
  assert.equal(spend.usdCny, costs.usdCny);
  const today = spend.days[0]!;
  assert.deepEqual(
    today.types!.map((r) => r.userType),
    ['test', 'unlimited', 'daily_refill', 'registered', 'guest'],
  );
  const by = (type: string) => today.types!.find((r) => r.userType === type)!;
  for (const type of ['test', 'registered', 'guest'])
    assert.ok(by(type).textMicros > 0 && by(type).voiceMicros > 0, `${type}: text and voice`);
  for (const type of ['unlimited', 'daily_refill']) assert.equal(by(type).textMicros + by(type).voiceMicros, 0, type);
  assert.equal(today.unclassifiedMicros, 0);
  assert.equal(
    today.totalMicros,
    costs.rows.filter((r) => r.day === today.day).reduce((sum, r) => sum + (r.ledgerChargedMicros ?? 0), 0),
  );
  assert.ok(
    spend.days.slice(1).every((d) => d.types === null && d.totalMicros === null),
    'days before the counters: —',
  );
  assert.equal(by('registered').voiceMicros, by('registered').voiceMicros);

  // Part 24b-1 read-only additions: the alert threshold the owner alerts use, and real price changes only.
  assert.equal(spend.alertMicros, 5_000_000, 'the production ALERT_DAILY_SPEND_MICROS while alerts are on');
  assert.deepEqual(spend.priceChanges, [], 'no price changed yet: nothing to mark');
  await f.fixture('/fixture/stats/price-version', {
    provider: 'deepseek',
    model: 'deepseek-flash',
    phase: 'draft',
    same: true,
  });
  assert.deepEqual(
    ((await f.call(`${ADMIN}/stats/spend-by-type`, owner, { range: 7 })) as SpendView).priceChanges,
    [],
    'a renewal at the same number is not a change',
  );
  await f.fixture('/fixture/stats/price-version', { provider: 'deepseek', model: 'deepseek-flash', phase: 'draft' });
  assert.deepEqual(((await f.call(`${ADMIN}/stats/spend-by-type`, owner, { range: 7 })) as SpendView).priceChanges, [
    { day: today.day, provider: 'deepseek', model: 'deepseek-flash', phase: 'draft' },
  ]);

  // The routes: no stats.read -> 403 before the body is read; the owner and stats.read are in; the rest of the wall.
  const staff = async (label: string, permissions: string[]) => {
    const issued = await f.call(`${ADMIN}/members/issue`, owner, {
      requestId: randomUUID(),
      label,
      memberId: null,
      permissions,
    });
    const actor = client();
    await f.call(`${ADMIN}/login`, actor, { token: issued.token });
    return actor;
  };
  const nothing = await staff('nothing', []);
  const others = await staff('others', ['system.read', 'points.grant', 'invites.manage', 'models.manage']);
  const reader = await staff('stats', ['stats.read']);
  const routes = {
    chart: ['stats/chart', { metric: 'replies', range: '24h' }],
    spend: ['stats/spend-by-type', { range: 30 }],
  } as const;
  for (const [name, [path, body]] of Object.entries(routes)) {
    for (const actor of [nothing, others]) {
      await f.refuse(`${ADMIN}/${path}`, actor, body, 403, 'ADMIN_PERMISSION_REQUIRED');
      await f.refuse(`${ADMIN}/${path}`, actor, { nonsense: 1 }, 403, 'ADMIN_PERMISSION_REQUIRED');
    }
    await f.call(`${ADMIN}/${path}`, reader, body);
    await f.call(`${ADMIN}/${path}`, owner, body);
    await f.refuse(`${ADMIN}/${path}`, client(), body, 401, 'ADMIN_UNAUTHORIZED');
    await f.refuse(`${ADMIN}/${path}`, { ...owner, csrf: 'f'.repeat(64) }, body, 403, 'ADMIN_CSRF_REQUIRED');
    assert.equal(
      (await f.request(`${ADMIN}/${path}`, owner, body, { origin: 'https://evil.invalid' })).status,
      403,
      name,
    );
    assert.equal(
      (await f.request(`${ADMIN}/${path}`, owner, body, { 'sec-fetch-site': 'cross-site' })).status,
      403,
      name,
    );
    assert.notEqual((await f.request(`${ADMIN}/${path}`, owner)).status, 200, 'GET is never a route');
  }
  for (const bad of [
    { metric: 'points', range: '24h' },
    { metric: 'replies', range: '30d' },
    { metric: 'replies' },
    {},
  ])
    await f.refuse(`${ADMIN}/stats/chart`, reader, bad, 400, 'INVALID_REQUEST');
  for (const bad of [{ range: 5 }, { range: '7' }, {}, { range: 7, metric: 'x' }])
    await f.refuse(`${ADMIN}/stats/spend-by-type`, reader, bad, 400, 'INVALID_REQUEST');

  // The batch field: optional, boolean only, and a 22a body without it is still valid.
  await f.call(
    `${ADMIN}/invites/batch-create`,
    owner,
    {
      requestId: randomUUID(),
      name: 'plain',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
    },
    201,
  );
  await f.refuse(
    `${ADMIN}/invites/batch-create`,
    owner,
    {
      requestId: randomUUID(),
      name: 'bad',
      count: 1,
      tier: { kind: 'unlimited' },
      durationDays: null,
      redeemBy: null,
      test: 'yes',
    },
    409,
    'WEB_INVITE_TERMS_REQUIRED',
  );
  const listed = await f.call(`${ADMIN}/invites/batch-list`, owner, {});
  assert.deepEqual(listed.batches.map((b: { name: string; test?: boolean }) => [b.name, b.test === true]).sort(), [
    ['plain', false],
    ['test group', true],
  ]);

  // Counts only: no marker, id, email or IP hash in any answer this test read.
  const text = f.seen.join('\n');
  assert.doesNotMatch(text, /registered@example\.com/);
  const extrasAfter = JSON.stringify(await f.fixture('/fixture/stats/extras', {}));
  assert.doesNotMatch(extrasAfter, /[0-9a-f]{64}/, 'no marker or hash leaves through the fixture either');
});

test('22d the alarm still goes idle: hourly rows, chat markers and their counts never keep it awake', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  await f.fixture('/fixture/system/operator-renew', {});
  await f.fixture('/fixture/stats/provider', { text: 'ok' });
  const owner = await f.admin();
  const G = client();
  await f.call(`${API}/bootstrap`, G);
  assert.equal(await f.reply(G, 'wei-guagua'), 'published');
  const day0 = new Date().toISOString().slice(0, 10);
  let extras = await f.fixture<Extras>('/fixture/stats/extras', {});
  assert.ok(extras.hourly.length > 0 && extras.chatDays.length === 1 && extras.chatHours.length > 0);
  assert.notEqual(extras.due, null, 'the guest trial is running: a purge is due');
  // The guest's trial window ends; the alarm purges it. Nothing about the statistics asks for another wake.
  for (let i = 0; i < 3; i++) {
    await f.fixture('/fixture/stats/clock', { days: 3 });
    await f.fixture('/fixture/run-alarm', {});
  }
  extras = await f.fixture<Extras>('/fixture/stats/extras', {});
  // Part 24b-1 (named precision, not a weakening): the one wake that is left is traced to its source. It is the anonymous
  // chat-review archive (web_review_archive), which expires on its own clock: archived_at + ARCHIVE_TTL_MS (180 days). It is not
  // the statistics (their wake would be the next UTC midnight) and not a guest purge (the guest was purged above).
  assert.ok(
    extras.archive > 0 && extras.archiveArchivedAt !== null,
    'the purged guest left its anonymous review archive',
  );
  assert.equal(extras.due, extras.archiveDue, 'the pending wake IS the review archive expiry');
  assert.equal(
    extras.archiveDue,
    extras.archiveArchivedAt + ARCHIVE_TTL_MS,
    'and it falls exactly 180 days after archiving',
  );
  assert.ok(
    extras.archiveDue! - extras.now > 179 * 86_400_000,
    'about 180 days from the (moved) test clock, never a midnight',
  );
  // The day was written down by the sweep before its markers were pruned; the hourly rows are long gone.
  assert.deepEqual(extras.hourly, []);
  assert.deepEqual(extras.chatHours, []);
  const counters = await f.fixture<{ day: string; metric: string; characterId: string; value: number }[]>(
    '/fixture/stats/counters',
    {},
  );
  assert.deepEqual(
    counters.filter((r) => r.metric === 'chat_users').map((r) => [r.day, r.value]),
    [[day0, 1]],
  );
  // Another sweep on an idle object changes nothing and still wants nothing.
  await f.fixture('/fixture/run-alarm', {});
  assert.deepEqual(
    (await f.fixture<Extras>('/fixture/stats/extras', {})).due,
    extras.due,
    'a further sweep asks for nothing new',
  );
  const chart = (await f.call(`${ADMIN}/stats/chart`, owner, { metric: 'chat_users', range: '14d' })) as ChartView;
  assert.ok(chart.characters.length <= 1);
});
