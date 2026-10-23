import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import type { CostsView, PlayerStatsView } from '../../../packages/contracts/web-stats.ts';

const API = '/api/web/provider',
  ADMIN = `${API}/admin`,
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
const DAY = 86_400_000;
type Client = { cookie: string; csrf: string; peer: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type Counter = { day: string; metric: string; characterId: string; model: string; value: number };
let peers = 0;
const client = (): Client => ({
  cookie: '',
  csrf: '',
  peer: `10.23.${Math.floor(peers / 250)}.${(++peers % 250) + 1}`,
});
const a = (path: string) => `${API}/account${path}`;
const utc = (at = Date.now()) => new Date(at).toISOString().slice(0, 10);
const COMBOS = [
  { bonus: true, choice: true },
  { bonus: true, choice: false },
  { bonus: false, choice: true },
  { bonus: false, choice: false },
];

/** Part 22c: one real-HTTP workerd database; the reply pipeline is the real one (queue, runner, ledger, publisher). */
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
  /** Every response body this test has read from a real route: scanned at the end for anything that must never leave. */
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
  const send = (actor: Client, characterId: string, status = 202) =>
    call(
      `${API}/characters/${characterId}/operations`,
      actor,
      { requestId: randomUUID(), text: '你好', delivery: 'voice' },
      status,
    );
  const settle = async (actor: Client, id: string, until = ['published', 'failed', 'cancelled', 'unknown']) => {
    const end = Date.now() + 60_000;
    for (;;) {
      const operation = await call(`${API}/operations/${id}`, actor);
      if (until.includes(operation.status)) return operation;
      assert.ok(Date.now() < end, JSON.stringify(operation));
      await sleep(100);
    }
  };
  const reply = async (actor: Client, characterId: string) =>
    (await settle(actor, (await send(actor, characterId)).operation.operationId)).status as string;
  const counters = () => runtime.call<Counter[]>('/fixture/stats/counters', {});
  const sum = (rows: Counter[], metric: string, where: Partial<Counter> = {}) =>
    rows
      .filter((r) => r.metric === metric && Object.entries(where).every(([k, v]) => r[k as keyof Counter] === v))
      .reduce((n, r) => n + r.value, 0);
  const admin = async () => {
    const owner = client();
    await call(`${ADMIN}/login`, owner, { token: (await runtime.call<{ token: string }>('/fixture/grant')).token });
    return owner;
  };
  return {
    ...runtime,
    request,
    call,
    refuse,
    signUp,
    send,
    settle,
    reply,
    counters,
    sum,
    admin,
    seen,
    fixture: runtime.call,
  };
}

for (const combo of COMBOS) {
  test(`22c the real pipeline end to end, then the purges: PLAYER_MODEL_CHOICE_ENABLED=${combo.choice} SIGNUP_BONUS_ENABLED=${combo.bonus}`, async (t) => {
    const f = setup(t);
    await f.fixture('/fixture/assets');
    await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
    await f.fixture('/fixture/system/operator-renew', {});
    await f.fixture('/fixture/cross/choice', { on: combo.choice });
    await f.fixture('/fixture/cross/signup-switch', { on: combo.bonus });
    await f.fixture('/fixture/stats/provider', { text: 'ok' });
    const today = utc();
    const owner = await f.admin();

    // G: a guest. One reply with voice, one that fails (HTTP 402 from every model: a definite "not billed").
    const G = client(),
      R = client(),
      I = client();
    const boot = async (actor: Client) =>
      (await f.call(`${API}/bootstrap`, actor)) as { access: { principalId: string } };
    const guestId = (await boot(G)).access.principalId;
    assert.equal(await f.reply(G, 'wei-guagua'), 'published');
    await f.fixture('/fixture/stats/provider', { text: 'fail' });
    // A guest has no model row: its reply is exactly what it was before model choice existed, so a DeepSeek error after the send is
    // UNKNOWN (never retried, its reservation never released) whatever the switches say.
    assert.equal(await f.reply(G, 'wei-guagua'), 'unknown');
    await f.fixture('/fixture/stats/provider', { text: 'ok' });

    // R: a registered player: two replies; with points on, the second asks for xAI and is answered by the backup model, and a third
    // meets a definite "not billed" from every model: the reply fails at once (the chain is exhausted) and its points come back.
    const registeredId = (await boot(R)).access.principalId;
    await f.signUp(R, 'registered@example.com');
    assert.equal(await f.reply(R, 'jojo'), 'published');
    let chosenXai = false;
    if (combo.choice) {
      const set = await f.request(a('/model'), R, { model: 'xai' });
      chosenXai = set.status === 200;
      await set.text();
    }
    await f.fixture('/fixture/stats/provider', { text: 'backup' });
    assert.equal(await f.reply(R, 'jojo'), 'published');
    if (chosenXai) {
      await f.fixture('/fixture/stats/provider', { text: 'fail' });
      assert.equal(await f.reply(R, 'jojo'), 'failed');
    }
    await f.fixture('/fixture/stats/provider', { text: 'ok' });
    await boot(R); // reading the balance settles the backup difference and the refund (once)

    // I: signs up, never chats. A returning cookie is not a new guest.
    const inactiveId = (await boot(I)).access.principalId;
    await f.signUp(I, 'inactive@example.com');
    await boot(I);
    await boot(G);

    const before = await f.counters();
    assert.ok(
      before.every((r) => r.day === today),
      'one UTC day (a test started at midnight would say otherwise)',
    );
    // Replies: counted when they reach their final state, by character and chosen model.
    assert.equal(f.sum(before, 'reply_published'), 3);
    assert.equal(f.sum(before, 'reply_failed'), chosenXai ? 1 : 0);
    assert.equal(f.sum(before, 'reply_unknown'), 1);
    assert.equal(f.sum(before, 'reply_voice'), 3, 'all three published replies carry voice');
    assert.equal(f.sum(before, 'reply_published', { characterId: 'wei-guagua' }), 1);
    assert.equal(f.sum(before, 'reply_published', { characterId: 'jojo' }), 2);
    assert.equal(f.sum(before, 'reply_unknown', { characterId: 'wei-guagua' }), 1);
    assert.equal(
      f.sum(before, 'reply_failed', { characterId: 'jojo', model: chosenXai ? 'xai' : '' }),
      chosenXai ? 1 : 0,
    );
    if (chosenXai)
      assert.equal(
        f.sum(before, 'reply_published', { characterId: 'jojo', model: 'xai' }),
        1,
        'chosen xAI, written by the backup',
      );
    // Signups, new guests (G, R, I once each, however often they came back).
    assert.equal(f.sum(before, 'signups'), 2);
    assert.equal(f.sum(before, 'new_guests'), 3);
    // Points: exactly the ledger, source by source and model by model (it still exists: nobody is purged yet).
    const ledger = () => f.fixture<{ source: string; model: string; points: number }[]>('/fixture/stats/ledger', {});
    const pointsName = (source: string) =>
      `points_${{ spend: 'spent', refund: 'refunded', grant: 'granted' }[source as 'spend'] ?? source}`;
    const pointsMatchLedger = async () => {
      const fromLedger = (await ledger()).map((e) => `${pointsName(e.source)}|${e.model}|${e.points}`).sort();
      const fromCounters = (await f.counters())
        .filter((r) => r.metric.startsWith('points_'))
        .map((r) => `${r.metric}|${r.model}|${r.value}`)
        .sort();
      assert.deepEqual(fromCounters, fromLedger);
    };
    await pointsMatchLedger();
    if (combo.choice && combo.bonus) {
      assert.ok(f.sum(before, 'points_spent') > 0 && f.sum(before, 'points_bonus') > 0);
      assert.equal(
        f.sum(before, 'points_refunded', { model: 'xai' }) > 0,
        chosenXai,
        'the backup refund is counted once, by the chosen model',
      );
    }

    // The two pages, from the same numbers.
    const players = (await f.call(`${ADMIN}/stats/players`, owner, { range: 7 })) as PlayerStatsView;
    const row = players.days[0]!;
    assert.equal(row.day, today);
    assert.deepEqual(
      [row.repliesPublished, row.repliesFailed, row.repliesUnknown, row.voiceReplies, row.signups, row.newGuests],
      [3, chosenXai ? 1 : 0, 1, 3, 2, 3],
    );
    assert.deepEqual(
      [row.activeRegistered, row.activeGuests, row.chatRegistered, row.chatGuests],
      [2, 1, 1, 1],
      'R and I opened the site as registered players, G as a guest; R and G sent messages',
    );
    assert.deepEqual([row.deletedAccounts, row.inactivePurged, row.expiredPurged], [0, 0, 0]);
    assert.equal(row.d1, null, 'a cohort is not closed on the day it signs up');
    assert.match(players.since ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(players.totals.repliesPublished, 3);
    const names = (await f.call(`${API}/bootstrap`, G)).characters.map(
      (c: { characterId: string; displayName: string }) => [c.characterId, c.displayName],
    );
    const nameOf = (id: string) => names.find((n: string[]) => n[0] === id)![1];
    assert.deepEqual(
      players.byCharacter.map((c) => [c.name, c.published, c.failed + c.unknown, c.voice]),
      [
        [nameOf('jojo'), 2, chosenXai ? 1 : 0, 2],
        [nameOf('wei-guagua'), 1, 1, 1],
      ],
      '按角色 lists the display name, never an id',
    );
    assert.equal(
      players.byModel.reduce((n, m) => n + m.published, 0),
      3,
    );
    if (chosenXai)
      assert.deepEqual(
        players.byModel.find((m) => m.model === 'xai'),
        { model: 'xai', published: 1, failed: 1, unknown: 0, voice: 1 },
      );
    const costs = (await f.call(`${ADMIN}/stats/costs`, owner, { range: 30 })) as CostsView;
    assert.equal(costs.usdCny, 6.7);
    assert.ok(costs.rows.length >= 3, 'draft, review and speech');
    assert.ok(
      costs.rows.every((r) => r.ledgerChargedMicros !== null && r.ledgerChargedMicros > 0),
      'this Part wrote the ledger amount',
    );
    const listTotal = costs.rows.reduce((n, r) => n + r.listCostMicros, 0);
    assert.equal(costs.daily[0]!.publishedReplies, 3);
    assert.equal(costs.daily[0]!.listCostMicros, listTotal);
    assert.equal(costs.daily[0]!.costPerReplyMicros, Math.round(listTotal / 3));
    assert.equal(costs.month.month, today.slice(0, 7));
    assert.equal(costs.month.spansDramaPriceChange, today.startsWith('2026-11'));
    assert.equal(costs.month.listCostRmbFen, Math.round((costs.month.listCostMicros * 6.7) / 10_000));
    // 导出表格: a CSV with a BOM, the page's columns, audited with the administrator, the range and the row count.
    const exported = (await f.call(`${ADMIN}/stats/players-export`, owner, { range: 7 })) as {
      csv: string;
      rows: number;
    };
    assert.equal(exported.csv.charCodeAt(0), 0xfeff);
    const lines = exported.csv.slice(1).trimEnd().split('\r\n');
    assert.equal(lines.length, players.days.length + 2);
    assert.equal(lines[0]!.split(',').length, 18);
    assert.equal(lines[1]!.split(',')[0], today);
    const outcomes = chosenXai ? '1,1' : '0,1';
    assert.equal(lines[1], `${today},2,3,2,1,1,1,3,${outcomes},3,0,0,0,—,—,—,—`);
    assert.equal(lines.at(-1), `合计,2,3,2,1,1,1,3,${outcomes},3,0,0,0,—,—,—,—`);
    const exportedCosts = (await f.call(`${ADMIN}/stats/costs-export`, owner, { range: 30 })) as {
      csv: string;
      rows: number;
    };
    assert.equal(exportedCosts.rows, costs.rows.length);
    const audit = await f.fixture<{ actorId: string; action: string; targetId: string }[]>('/fixture/system/audit', {});
    assert.deepEqual(
      audit.filter((e) => e.action.startsWith('stats-export:')).map((e) => [e.action, e.targetId]),
      [
        ['stats-export:players', `7d/${players.days.length}`],
        ['stats-export:costs', `30d/${costs.rows.length}`],
      ],
    );
    assert.ok(audit.filter((e) => e.action.startsWith('stats-export:')).every((e) => e.actorId));

    // The purges. G's trial runs out, I has been away for more than 180 days, R deletes the account.
    const deleted = await f.call(a('/delete'), R, { password: PASSWORD, confirm: '删除' });
    if (!deleted.complete) console.error(JSON.stringify(await f.fixture('/fixture/retention-reports', {})));
    assert.deepEqual(deleted, { deleted: true, complete: true });
    await f.fixture('/fixture/world/age', { principalId: guestId, ms: 30 * DAY });
    await f.fixture('/fixture/world/age', { principalId: inactiveId, ms: 181 * DAY });
    assert.deepEqual(await f.fixture('/fixture/world/sweep'), { processed: 2, failed: 0, error: null });
    assert.deepEqual(
      await f.fixture('/fixture/world/sweep'),
      { processed: 0, failed: 0, error: null },
      'T1 happens once',
    );
    const after = await f.counters();
    const purge = (rows: Counter[]) => rows.filter((r) => r.metric.startsWith('purge_'));
    assert.deepEqual(
      purge(after).map((r) => [r.metric, r.value]),
      [
        ['purge_deleted', 1],
        ['purge_expired', 1],
        ['purge_inactive', 1],
      ],
    );
    // Purging must not change a past count: every other counter is what it was, to the number.
    assert.deepEqual(
      after.filter((r) => !r.metric.startsWith('purge_')),
      before,
    );
    assert.equal((await ledger()).length, 0, 'the points ledger went with the players; the counters above did not');
    const players2 = (await f.call(`${ADMIN}/stats/players`, owner, { range: 7 })) as PlayerStatsView;
    const day2 = players2.days[0]!;
    assert.deepEqual(
      [day2.repliesPublished, day2.repliesFailed, day2.repliesUnknown, day2.voiceReplies, day2.signups, day2.newGuests],
      [3, chosenXai ? 1 : 0, 1, 3, 2, 3],
    );
    assert.deepEqual([day2.deletedAccounts, day2.inactivePurged, day2.expiredPurged], [1, 1, 1]);
    assert.deepEqual(
      players2.byCharacter.map((c) => [c.name, c.published, c.failed, c.unknown]),
      players.byCharacter.map((c) => [c.name, c.published, c.failed, c.unknown]),
    );
    const costs2 = (await f.call(`${ADMIN}/stats/costs`, owner, { range: 30 })) as CostsView;
    assert.deepEqual(costs2.rows, costs.rows, 'the consumption table does not move when players are purged');

    // Nothing that identifies anyone, and no marker, left through any route.
    const { markers } = await f.fixture<{ markers: string[] }>('/fixture/stats/markers', {});
    assert.ok(markers.length >= 3);
    const text = f.seen.join('\n') + exported.csv + exportedCosts.csv;
    for (const marker of markers) assert.equal(text.includes(marker), false, 'a marker is never returned by any route');
    // The two pages and their exports hold no id and no address either.
    for (const body of [
      JSON.stringify(players),
      JSON.stringify(players2),
      JSON.stringify(costs),
      exported.csv,
      exportedCosts.csv,
    ])
      for (const secret of [guestId, registeredId, inactiveId, 'example.com'])
        assert.equal(body.includes(secret), false);
  });
}

test('22c a reply still in flight when its player is purged fails once (TRIAL_EXPIRED), by its admission day, and the replay counts nothing', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const G = client();
  const principalId = (await f.call(`${API}/bootstrap`, G)).access.principalId as string;
  await f.fixture('/fixture/stats/provider', { text: 'hold' });
  const sent = await f.send(G, 'wei-guagua');
  await f.settle(G, sent.operation.operationId, ['text_running']);
  const finals = () => f.counters().then((rows) => rows.filter((r) => /^(reply|purge)_/.test(r.metric)));
  assert.deepEqual(await finals(), [], 'in flight: nothing is final');
  await f.fixture('/fixture/world/age', { principalId, ms: 30 * DAY });
  assert.deepEqual(await f.fixture('/fixture/world/sweep'), { processed: 1, failed: 0, error: null });
  const rows = await finals();
  assert.deepEqual(
    rows.map((r) => [r.metric, r.characterId, r.value]),
    [
      ['purge_expired', '', 1],
      ['reply_failed', 'wei-guagua', 1],
    ],
  );
  // The provider answers after the purge: nothing more is counted.
  await f.fixture('/fixture/stats/provider', { text: 'release' });
  await sleep(500);
  assert.deepEqual(await finals(), rows);
});

test('22c a cohort closes on the alarm on day +2 (D1) and +8 (D7), once; markers older than 35 days go, their counts stay', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true, accountDelete: true });
  const owner = await f.admin();
  const R = client(),
    B = client();
  const boot = (actor: Client) => f.call(`${API}/bootstrap`, actor);
  await boot(R);
  await boot(B);
  await f.signUp(R, 'cohort-r@example.com');
  await f.signUp(B, 'cohort-b@example.com');
  // (the page loads the player again after signing up)
  await boot(R);
  await boot(B);
  const day0 = utc();
  // Day +1: only R comes back. (Day +1 is a day on the skewed UTC clock of the whole object.)
  await f.fixture('/fixture/stats/clock', { days: 1 });
  await boot(R);
  await f.fixture('/fixture/run-alarm', {});
  assert.deepEqual(
    (await f.counters()).filter((r) => r.metric.startsWith('d')),
    [],
    'not closed on day +1',
  );
  await f.fixture('/fixture/stats/clock', { days: 1 });
  await f.fixture('/fixture/run-alarm', {});
  const closed = () =>
    f.counters().then((rows) => rows.filter((r) => /^d[17]_/.test(r.metric)).map((r) => [r.metric, r.day, r.value]));
  assert.deepEqual(await closed(), [
    ['d1_cohort', day0, 2],
    ['d1_retained', day0, 1],
  ]);
  await f.fixture('/fixture/run-alarm', {});
  assert.deepEqual((await closed()).length, 2, 'once');
  await f.fixture('/fixture/stats/clock', { days: 6 });
  await f.fixture('/fixture/run-alarm', {});
  assert.deepEqual(await closed(), [
    ['d1_cohort', day0, 2],
    ['d1_retained', day0, 1],
    ['d7_cohort', day0, 2],
    ['d7_retained', day0, 0],
  ]);
  const view = (await f.call(`${ADMIN}/stats/players`, owner, { range: 30 })) as PlayerStatsView;
  assert.deepEqual(view.days.find((d) => d.day === day0)!.d1, { cohort: 2, retained: 1 });
  assert.deepEqual(view.days.find((d) => d.day === day0)!.d7, { cohort: 2, retained: 0 });
  // 36 days after day 0 the markers of day 0 are gone; the active counts written down before that are not.
  const mark = (await f.fixture<{ days: { day: string }[] }>('/fixture/stats/markers', {})).days.map((d) => d.day);
  assert.ok(mark.includes(day0), 'still there on day +8');
  await f.fixture('/fixture/stats/clock', { days: 28 });
  await f.fixture('/fixture/run-alarm', {});
  const left = (await f.fixture<{ days: { day: string }[] }>('/fixture/stats/markers', {})).days.map((d) => d.day);
  assert.equal(left.includes(day0), false, 'pruned');
  assert.ok((await f.counters()).some((r) => r.metric === 'active_registered' && r.day === day0 && r.value === 2));
  const old = (await f.call(`${ADMIN}/stats/players`, owner, { range: 90 })) as PlayerStatsView;
  assert.equal(old.days.find((d) => d.day === day0)!.activeRegistered, 2);
});

test('22c every new route: no stats.read → 403 (before the body is read), the owner and stats.read are in, anonymous and cross-site are refused, the old pages are gone', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = await f.admin();
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
  const everythingElse = await staff('everything else', [
    'system.read',
    'points.grant',
    'invites.manage',
    'models.manage',
    'cocreation.manage',
  ]);
  const reader = await staff('stats', ['stats.read']);
  const routes = {
    players: ['stats/players', { range: 7 }],
    playersExport: ['stats/players-export', { range: 7 }],
    costs: ['stats/costs', { range: 30 }],
    costsExport: ['stats/costs-export', { range: 30 }],
  } as const;
  for (const [name, [path, body]] of Object.entries(routes)) {
    for (const actor of [nothing, everythingElse]) {
      await f.refuse(`${ADMIN}/${path}`, actor, body, 403, 'ADMIN_PERMISSION_REQUIRED');
      // A refused administrator learns nothing about the body: an invalid range is still a 403, not a 400.
      await f.refuse(`${ADMIN}/${path}`, actor, { range: 'abc', extra: 1 }, 403, 'ADMIN_PERMISSION_REQUIRED');
    }
    await f.call(`${ADMIN}/${path}`, reader, body);
    await f.call(`${ADMIN}/${path}`, owner, body);
    const anonymous = client();
    await f.refuse(`${ADMIN}/${path}`, anonymous, body, 401, 'ADMIN_UNAUTHORIZED');
    await f.refuse(`${ADMIN}/${path}`, { ...owner, csrf: 'f'.repeat(64) }, body, 403, 'ADMIN_CSRF_REQUIRED');
    assert.equal(
      (await f.request(`${ADMIN}/${path}`, owner, body, { origin: 'https://evil.invalid' })).status,
      403,
      `${name}: foreign Origin`,
    );
    assert.equal(
      (await f.request(`${ADMIN}/${path}`, owner, body, { 'sec-fetch-site': 'cross-site' })).status,
      403,
      `${name}: cross-site`,
    );
  }
  // Exact body: a range outside 7 / 30 / 90 is refused for someone who may read.
  for (const bad of [{ range: 5 }, { range: '7' }, {}, { range: 7, days: 7 }])
    await f.refuse(`${ADMIN}/stats/players`, reader, bad, 400, 'INVALID_REQUEST');
  // The stats.read holder gets the stats and nothing else; the 概览 numbers of 22c are theirs, not everyone's.
  const overviewReader = await f.call(`${ADMIN}/overview/read`, reader, {});
  const overviewNothing = await f.call(`${ADMIN}/overview/read`, nothing, {});
  assert.ok(overviewReader.stats && typeof overviewReader.stats.monthListCostRmbFen === 'number');
  assert.equal(overviewNothing.stats, null);
  await f.refuse(`${ADMIN}/system/status`, reader, {}, 403, 'ADMIN_PERMISSION_REQUIRED');
  assert.notEqual((await f.request(`${ADMIN}/stats/players`, owner)).status, 200, 'GET is never a route');
  assert.equal((await f.request(`${ADMIN}/stats/nope`, owner, {})).status, 404);
  // The owner's 概览 carries yesterday and this month.
  const ov = await f.call(`${ADMIN}/overview/read`, owner, {});
  assert.deepEqual(Object.keys(ov.stats.yesterday).sort(), ['active', 'day', 'replies', 'signups']);
});
