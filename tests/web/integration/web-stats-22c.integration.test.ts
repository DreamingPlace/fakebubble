import assert from 'node:assert/strict';
import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { applyDailyRefill, ensureBalance, reconcilePoints } from '../../../apps/server/admission/web-points.ts';
import {
  migrateWebProviderInviteCodes,
  migrateWebProviderInviteTiers,
  migrateWebProviderLegacyInvites,
  migrateWebProviderModelSettings,
  migrateWebProviderStats,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { WebSecurityCounters, installWebAdminActions } from '../../../apps/server/admin/web-admin-actions.ts';
import { WebSystemAdmin } from '../../../apps/server/admin/web-system-admin.ts';
import { csvDocument } from '../../../apps/server/invites/web-invite-export.ts';
import { readCosts, readPlayerStats, playerStatsCsv, costsCsv } from '../../../apps/server/admin/web-stats-admin.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { DAY, T0, tiersFixture, STATS_SEAL_KEY } from '../fixtures/invite-tiers.ts';
import { modelFixture, NOW, type FetchCall } from '../fixtures/model-choice.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const DRAFT = 'submit_dialogue_draft';
const utc = (at: number) => new Date(at).toISOString().slice(0, 10);
const sql128 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/128_stats.sql', import.meta.url), 'utf8');
type Row = { day: string; metric: string; character_id: string; model: string; value: number };
/** Every counter of one metric family as `metric|character|model|value` (one day at most is expected unless said). */
const counters = (store: { all<T>(sql: string, ...p: unknown[]): T[] }, like: string, day?: string) =>
  store
    .all<Row>(
      `SELECT day,metric,character_id,model,value FROM web_stats_daily WHERE metric LIKE ? ${day ? 'AND day=?' : ''}
      ORDER BY metric,character_id,model,day`,
      ...(day ? [like, day] : [like]),
    )
    .map((r) => `${r.metric}|${r.character_id}|${r.model}|${r.value}`);
const all = (store: { all<T>(sql: string, ...p: unknown[]): T[] }) =>
  counters(store, '%').filter((line) => !line.startsWith('stats_started'));
/** modelFixture is a schema-123 store; the steps after it are what a deployment applied one by one. */
const up128 = (store: Parameters<typeof migrateWebProviderStats>[0], now = NOW) => {
  migrateWebProviderModelSettings(store);
  migrateWebProviderInviteTiers(store);
  migrateWebProviderLegacyInvites(store);
  migrateWebProviderInviteCodes(store);
  migrateWebProviderStats(store, now);
};
const answer =
  (over: Partial<Record<FetchCall['provider'], (call: FetchCall) => Response>> = {}) =>
  (call: FetchCall, _n: number, request: Parameters<typeof draftEnvelope>[0]) =>
    over[call.provider]?.(call) ??
    Response.json(call.tool === DRAFT ? draftEnvelope(request) : acceptedAuditEnvelope(request));

test('128 is its own step: same SQL on both authorities, 53 steps, 1-127 unchanged; an old database gets nothing backfilled', (t) => {
  const f = tiersFixture(t); // the real schema through 127, no statistics yet
  const old = f.player('old', { signedUp: true });
  const first = f.admit(old.principalId, 'old-1');
  f.finish(first.operationId, 'published');
  f.store.run(
    `INSERT INTO web_provider_usage(day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies)
    VALUES ('2027-01-10','deepseek','deepseek-v4-flash','draft',3,100,10,50,0,1234,2)`,
  );
  const before = JSON.stringify([
    f.store.all('SELECT * FROM web_operations'),
    f.store.all('SELECT * FROM web_provider_usage'),
    f.store.all('SELECT * FROM web_points_events'),
    f.store.all('SELECT * FROM web_player_logins'),
  ]);
  assert.equal(
    f.store.get("SELECT 1 FROM sqlite_master WHERE name IN ('web_stats_daily','web_daily_active')"),
    undefined,
  );

  migrateWebProviderStats(f.store, T0);
  assert.equal(f.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 128);
  assert.equal(f.store.get('PRAGMA foreign_key_check'), undefined);
  assert.throws(() => migrateWebProviderStats(f.store, T0), /WEB_PROVIDER_STATS_MIGRATION_REQUIRED/);
  // Nothing backfilled: the only row is the day the counters started; the old operation, login and points event count for nothing.
  assert.deepEqual(
    f.store.all<Row>('SELECT * FROM web_stats_daily').map((r) => [r.day, r.metric, r.value]),
    [[utc(T0), 'stats_started', 1]],
  );
  assert.equal(f.store.get('SELECT 1 FROM web_daily_active'), undefined);
  // Old rows are untouched but for the new column, which reads 0.
  const after = JSON.stringify([
    f.store.all('SELECT * FROM web_operations'),
    f.store.all(
      'SELECT day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies FROM web_provider_usage',
    ),
    f.store.all('SELECT * FROM web_points_events'),
    f.store.all('SELECT * FROM web_player_logins'),
  ]);
  assert.equal(after, before);
  assert.equal(
    f.store.get<{ n: number }>("SELECT ledger_charged_micros n FROM web_provider_usage WHERE day='2027-01-10'")?.n,
    0,
  );
  // The consumption table still shows the old history, and the ledger column reads — (unknown) for it.
  f.store.run(
    `INSERT INTO web_provider_usage(day,provider,model,phase,calls,cost_micros,replies,ledger_charged_micros)
    VALUES ('2027-01-16','deepseek','deepseek-v4-flash','draft',1,10,1,77)`,
  );
  const costs = readCosts(f.store, T0 + DAY, 30);
  assert.deepEqual(
    costs.rows.map((r) => [r.day, r.listCostMicros, r.ledgerChargedMicros]),
    [
      ['2027-01-16', 10, 77],
      ['2027-01-10', 1234, null],
    ],
  );
  // New events after the step are counted; the old ones still are not.
  const second = f.admit(old.principalId, 'new-1');
  f.finish(second.operationId, 'published');
  assert.deepEqual(counters(f.store, 'reply_%'), ['reply_published|fixture-character|deepseek|1']);
  assert.equal(readPlayerStats(f.store, T0 + DAY, 30).days.at(-1)!.day, utc(T0), 'no day before the counters started');

  // The ledger of steps.
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(inline.length, 54);
  assert.equal(r2.length, 54);
  assert.equal(inline.at(-2)!.version, 128);
  assert.equal(inline.at(-2)!.sha256, createHash('sha256').update(sql128()).digest('hex'));
  assert.deepEqual(r2.at(-2), inline.at(-2));
  // 1-127 are byte for byte what Part 22a2 deployed.
  assert.equal(
    inline.find((m) => m.version === 127)!.sha256,
    '3cc1d4c03ebbdf90f02ce751341a7aa175804c35799dfe34b29034dd1ae54ecf',
  );
  assert.equal(
    inline.find((m) => m.version === 126)!.sha256,
    '68526f0cfc26957124a4a2f7ea9bcc600cc11c6ba0fcb3702b866aba67efec4e',
  );
});

test('replies: the publisher counts a published voice reply once, by character and chosen model; a replay counts nothing', async (t) => {
  const f = modelFixture(t, { chosen: 'xai', fetch: answer() });
  up128(f.store);
  await f.runText();
  assert.deepEqual(all(f.store), []);
  await f.finishReply('operation');
  assert.equal(f.status(), 'published');
  assert.deepEqual(all(f.store), ['reply_published|character|xai|1', 'reply_voice|character|xai|1']);
  assert.equal(
    f.get<{ day: string }>("SELECT day FROM web_stats_daily WHERE metric='reply_published'")!.day,
    utc(NOW),
    'the admission day, UTC',
  );
  // A replay: a second update of a final row, whatever it says, counts nothing.
  for (const status of ['published', 'failed', 'unknown', 'cancelled'])
    f.store.run("UPDATE web_operations SET status=?,stage_version=stage_version+1 WHERE id='operation'", status);
  assert.deepEqual(all(f.store), ['reply_published|character|xai|1', 'reply_voice|character|xai|1']);
});

test('replies: a text fallback is published but not a voice reply', async (t) => {
  const f = modelFixture(t, {
    chosen: 'deepseek',
    fish: async () => {
      throw new DomainError('FISH_RATE_LIMITED');
    },
    fetch: answer(),
  });
  up128(f.store);
  await f.runText();
  for (const backoff of [2000, 4000, 8000, 0]) {
    const claim = f.queue.claimAudio(f.lease, 'audio-worker');
    assert.ok(claim);
    await f.runner.runSpeech(claim, f.signal());
    f.advance(backoff);
  }
  await f.runner.publishTextFallback(f.lease, 'operation');
  assert.equal(
    f.get<{ n: number }>('SELECT count(*) n FROM messages WHERE voice_fallback=1')!.n > 0,
    true,
    'published as text',
  );
  assert.deepEqual(all(f.store), ['reply_published|character|deepseek|1']);
});

test('replies: a known failure at once (dispatch ledger), UNKNOWN (recovery) and an expiry (terminate) each count once; cancelled counts none', async (t) => {
  // Failed at once: the last model of the chain says "not billed".
  const failed = modelFixture(t, {
    chosen: 'deepseek',
    keys: { xai: 'offline-xai' },
    fetch: answer({
      deepseek: (call) => (call.tool === DRAFT ? new Response('{}', { status: 429 }) : Response.json({})),
    }),
  });
  up128(failed.store);
  await assert.rejects(failed.runText(), /MODEL_UNAVAILABLE/);
  assert.equal(failed.status(), 'failed');
  assert.deepEqual(all(failed.store), ['reply_failed|character|deepseek|1']);
  failed.store.run("UPDATE web_operations SET status='failed',stage_version=stage_version+1 WHERE id='operation'");
  assert.deepEqual(all(failed.store), ['reply_failed|character|deepseek|1'], 'a replay counts nothing');

  // UNKNOWN: sent, then a server error; the stage's lease runs out and the recovery says unknown. Never retried.
  const unknown = modelFixture(t, {
    chosen: 'xai',
    fetch: answer({ xai: () => new Response('{"error":"internal"}', { status: 500 }) }),
  });
  up128(unknown.store);
  await assert.rejects(unknown.runText());
  assert.deepEqual(all(unknown.store), [], 'still running: nothing is final yet');
  unknown.advance(10 * 60_000);
  const ledger = new WebDispatchLedger(unknown.store as WebStore, unknown.clock);
  const takeover = unknown.queue.acquireCoordinator('takeover');
  assert.equal(ledger.recover(takeover, ledger.fence('operation')).status, 'unknown');
  assert.deepEqual(all(unknown.store), ['reply_unknown|character|xai|1']);
  // The operation later expires: unknown is final for the count, so the expiry adds nothing.
  unknown.store.run("UPDATE web_operations SET status='failed',stage_version=stage_version+1 WHERE id='operation'");
  assert.deepEqual(all(unknown.store), ['reply_unknown|character|xai|1']);

  // terminate(): an expired operation fails (counted), a cancelled one counts none.
  for (const [terminal, reason, expected] of [
    ['failed', 'expired', ['reply_failed|character|deepseek|1']],
    ['cancelled', 'cancel', []],
  ] as const) {
    const f = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
    up128(f.store);
    const claim = f.queue.claimText(f.lease, 'text-worker')!;
    assert.ok(claim);
    const lg = new WebDispatchLedger(f.store as WebStore, f.clock);
    const fence = lg.fence('operation');
    if (reason === 'expired') f.advance(310_000);
    const lease = reason === 'expired' ? f.queue.acquireCoordinator('later') : f.lease;
    assert.equal(lg.terminate(lease, fence, fence.principalId, terminal, reason).status, terminal);
    assert.deepEqual(all(f.store), expected, `${terminal}/${reason}`);
    assert.equal(lg.terminate(lease, fence, fence.principalId, terminal, reason).duplicate, true);
    assert.deepEqual(all(f.store), expected, 'the replay of the same termination counts nothing');
  }
});

test('replies: admission.finalize stays fenced on every schema 104-128 (the dispatch ledger replaced it): it writes, and counts, nothing', (t) => {
  const f = tiersFixture(t, { stats: true });
  const a = f.player('a');
  const op = f.admit(a.principalId, 'fa');
  assert.deepEqual(all(f.store), [], 'admission itself is not a final write');
  assert.throws(() => f.admission.finalize(op.operationId, 'failed'), /WEB_DISPATCH_FENCE_REQUIRED/);
  assert.deepEqual(all(f.store), []);
  assert.equal(
    f.store.get<{ status: string }>('SELECT status FROM web_operations WHERE id=?', op.operationId)?.status,
    'queued',
  );
});

test('replies: the stage queue claim sets a running status, which is not final and counts nothing', async (t) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
  up128(f.store);
  assert.ok(f.queue.claimText(f.lease, 'text-worker'));
  assert.equal(f.status(), 'text_running');
  assert.deepEqual(all(f.store), []);
});

test('points: bonus, spend, refund (by model), grant, reset and daily refill each appear once; replays add nothing', (t) => {
  const f = tiersFixture(t, { stats: true });
  installWebAdminActions(f.store);
  const live = { now: () => f.clock() };
  const admin = new WebSystemAdmin(f.store, live, f.accounts, {
    ops: undefined,
    security: new WebSecurityCounters(f.store, live),
    emailKey: Buffer.alloc(32, 7),
  });
  const reg = f.player('reg', { signedUp: true, opening: 100 });
  // The opening bonus is an event of the ledger like any other.
  assert.deepEqual(counters(f.store, 'points_%'), ['points_bonus|||100']);
  // spend (admission, by the model the player chose) ...
  const op = f.admit(reg.principalId, 'spend-1');
  const spent = f.store.get<{ delta: number }>("SELECT delta FROM web_points_events WHERE source='spend'")!.delta;
  assert.equal(spent, -12, 'DeepSeek 10 + voice 2');
  assert.deepEqual(counters(f.store, 'points_spent'), ['points_spent||deepseek|12']);
  // ... and the refund when no reply came: settled once however often the balance is read.
  f.finish(op.operationId, 'failed');
  reconcilePoints(f.store as never, f.clock(), reg.principalId);
  reconcilePoints(f.store as never, f.clock(), reg.principalId);
  assert.deepEqual(counters(f.store, 'points_refunded'), ['points_refunded||deepseek|12']);
  // grant: one event per receiving player; the same request id is a stored answer and adds nothing.
  const grant = { requestId: 'grant-request-1', target: { kind: 'all' }, amount: 30, note: '' };
  admin.pointsGrant(f.owner, grant);
  assert.equal(admin.pointsGrant(f.owner, grant).duplicate, true);
  assert.deepEqual(counters(f.store, 'points_granted'), ['points_granted|||30']);
  // reset: below 100 becomes 100 (one 'reset' event of the difference); a second reset finds nobody below.
  f.store.run('UPDATE web_points_balance SET balance=40 WHERE principal_id=?', reg.principalId);
  admin.resetPoints(f.owner, { requestId: 'reset-request-1' });
  admin.resetPoints(f.owner, { requestId: 'reset-request-2' });
  assert.deepEqual(counters(f.store, 'points_reset'), ['points_reset|||60']);
  // daily refill: once per UTC day, however often the player is seen.
  const refill = f.player('refill', { signedUp: true, opening: 100 });
  f.redeem(
    refill,
    f.create(f.owner, { count: 1, tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 } }).codes![0]!,
  );
  applyDailyRefill(f.store as never, f.clock(), refill.principalId);
  applyDailyRefill(f.store as never, f.clock(), refill.principalId);
  assert.deepEqual(counters(f.store, 'points_daily_refill'), ['points_daily_refill|||50']);
  f.advance(DAY);
  applyDailyRefill(f.store as never, f.clock(), refill.principalId);
  assert.equal(
    f.store.get<{ n: number }>("SELECT sum(value) n FROM web_stats_daily WHERE metric='points_daily_refill'")!.n,
    100,
    'the next UTC day pays again',
  );
  // The counters are exactly the ledger, source by source.
  const name = (source: string) =>
    `points_${{ spend: 'spent', refund: 'refunded', grant: 'granted' }[source as 'spend'] ?? source}`;
  assert.deepEqual(
    f.store
      .all<{ metric: string; value: number }>(
        "SELECT metric,sum(value) value FROM web_stats_daily WHERE metric LIKE 'points_%' GROUP BY metric ORDER BY metric",
      )
      .map((r) => `${r.metric}:${r.value}`),
    f.store
      .all<{ source: string; n: number }>('SELECT source,sum(abs(delta)) n FROM web_points_events GROUP BY source')
      .map((r) => `${name(r.source)}:${r.n}`)
      .sort(),
  );
  void ensureBalance;
});

test('markers are keyed (HKDF label stats-active-v1 over day and principal), once per day and scope, kind follows a signup', (t) => {
  const f = tiersFixture(t, { stats: true });
  const guest = f.player('g');
  const key = Buffer.from(hkdfSync('sha256', STATS_SEAL_KEY, Buffer.alloc(0), 'stats-active-v1', 32));
  const marker = (day: string, principalId: string) =>
    createHmac('sha256', key).update(day).update('\0').update(principalId).digest('hex');
  f.stats!.markActive(guest.principalId, 'visit', f.clock());
  f.stats!.markActive(guest.principalId, 'visit', f.clock() + 1000);
  assert.deepEqual(
    f.store.all<Record<string, string>>('SELECT day,marker,kind,scope FROM web_daily_active').map((r) => ({ ...r })),
    [{ day: utc(T0), marker: marker(utc(T0), guest.principalId), kind: 'guest', scope: 'visit' }],
  );
  // The same player signs up that day: still one marker, now registered.
  f.store.run(
    'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
    guest.principalId,
    'g@example.com',
    'x',
    f.clock(),
    f.clock(),
    f.clock(),
  );
  f.stats!.markActive(guest.principalId, 'visit', f.clock());
  assert.deepEqual(
    f.store.all<{ kind: string }>('SELECT kind FROM web_daily_active').map((r) => r.kind),
    ['registered'],
  );
  // A message marks 'chat' (a different scope), once per day, and a new day is a new marker.
  const chatter = f.player('chatter', { signedUp: true });
  f.admit(chatter.principalId, 'c-1');
  f.admit(chatter.principalId, 'c-2');
  assert.deepEqual(
    f.store.all<{ kind: string }>("SELECT kind FROM web_daily_active WHERE scope='chat'").map((r) => r.kind),
    ['registered'],
  );
  f.advance(DAY);
  f.admit(chatter.principalId, 'c-3');
  assert.equal(f.store.all("SELECT 1 FROM web_daily_active WHERE scope='chat'").length, 2);
  // The id of the principal is nowhere in the table.
  assert.doesNotMatch(JSON.stringify(f.store.all('SELECT * FROM web_daily_active')), /principal-|g@example/);
});

test('D1 / D7: a cohort closes once on day +2 / +8 (across UTC midnight), counts a member deleted before the close, never a guest', (t) => {
  const f = tiersFixture(t, { stats: true });
  const stats = f.stats!;
  // Day D, late evening: three registered signups and a guest.
  const D = Date.parse('2027-02-01T20:00:00Z');
  f.setNow(D);
  const [a, b, c] = ['a', 'b', 'c'].map((n) => f.player(n, { signedUp: true }));
  const g = f.player('guest');
  assert.deepEqual(counters(f.store, 'signups', '2027-02-01'), ['signups|||3']);
  const visit = (who: { principalId: string }, at: string) =>
    stats.markActive(who.principalId, 'visit', Date.parse(at));
  // Day D+1: a, c and the guest visit; c deletes the account before the close.
  visit(a!, '2027-02-02T09:00:00Z');
  visit(c!, '2027-02-02T10:00:00Z');
  visit(g, '2027-02-02T11:00:00Z');
  f.store.run('DELETE FROM web_player_logins WHERE principal_id=?', c!.principalId);
  // Day D+7: a visits again, b never does.
  visit(a!, '2027-02-08T09:00:00Z');
  const closed = () => counters(f.store, 'd%');
  stats.maintain(Date.parse('2027-02-02T23:59:59.999Z'));
  assert.deepEqual(closed(), [], 'not before day +2');
  stats.maintain(Date.parse('2027-02-03T00:00:00Z'));
  assert.deepEqual(
    closed(),
    ['d1_cohort|||3', 'd1_retained|||1'],
    'c is in the cohort, not retained; the guest is not in it',
  );
  // Frozen once written: a late marker and another run change nothing.
  visit(b!, '2027-02-02T12:00:00Z');
  stats.maintain(Date.parse('2027-02-04T00:00:00Z'));
  assert.deepEqual(closed(), ['d1_cohort|||3', 'd1_retained|||1']);
  stats.maintain(Date.parse('2027-02-08T23:59:59Z'));
  assert.deepEqual(closed(), ['d1_cohort|||3', 'd1_retained|||1'], 'D7 not before day +8');
  stats.maintain(Date.parse('2027-02-09T00:00:00Z'));
  assert.deepEqual(closed(), ['d1_cohort|||3', 'd1_retained|||1', 'd7_cohort|||3', 'd7_retained|||1']);
  // The page: "x / y" appears only for a closed cohort; the day before it closes reads —.
  const view = readPlayerStats(f.store, Date.parse('2027-02-09T12:00:00Z'), 30);
  const day = view.days.find((d) => d.day === '2027-02-01')!;
  assert.deepEqual(
    [day.d1, day.d7],
    [
      { cohort: 3, retained: 1 },
      { cohort: 3, retained: 1 },
    ],
  );
  assert.deepEqual(
    [view.days.find((d) => d.day === '2027-02-02')!.d1, view.totals.d1],
    [null, { cohort: 3, retained: 1 }],
  );
});

test('markers are pruned after 35 days; the daily counts they gave are written down first and survive', (t) => {
  const f = tiersFixture(t, { stats: true });
  const p = f.player('p', { signedUp: true });
  const day = Date.parse('2027-03-01T10:00:00Z');
  f.stats!.markActive(p.principalId, 'visit', day);
  f.stats!.markActive(p.principalId, 'chat', day);
  const left = () => f.store.all('SELECT day FROM web_daily_active').length;
  // today is read from the markers; a finished day from its written-down counts.
  assert.equal(readPlayerStats(f.store, day, 7).days.find((d) => d.day === '2027-03-01')!.activeRegistered, 1);
  f.stats!.maintain(day + 35 * DAY);
  assert.equal(left(), 2, 'a marker of day X is kept through X + 35');
  f.stats!.maintain(day + 36 * DAY);
  assert.equal(left(), 0, 'gone on X + 36');
  const view = readPlayerStats(f.store, day + 60 * DAY, 90);
  const row = view.days.find((d) => d.day === '2027-03-01')!;
  assert.deepEqual([row.activeRegistered, row.chatRegistered, row.activeGuests], [1, 1, 0]);
  assert.deepEqual(counters(f.store, 'active_%'), ['active_registered|||1']);
});

test('the ledger column: the charge the budget ledger took is added at the same site as the list cost', async (t) => {
  const f = modelFixture(t, { chosen: 'deepseek', fetch: answer() });
  up128(f.store);
  await f.runText();
  await f.finishReply('operation');
  const usage = f.all<{
    phase: string;
    model: string;
    calls: number;
    ledger_charged_micros: number;
    cost_micros: number;
  }>('SELECT phase,model,calls,ledger_charged_micros,cost_micros FROM web_provider_usage ORDER BY phase');
  assert.ok(usage.length >= 3, 'draft, review and speech');
  for (const row of usage) {
    const charged = f.get<{ n: number }>(
      'SELECT sum(charged_micros) n FROM web_provider_attempts WHERE phase=? AND model=?',
      row.phase,
      row.model,
    )!.n;
    assert.equal(row.ledger_charged_micros, charged, `${row.phase}: the attempt's charged amount`);
    assert.ok(row.ledger_charged_micros > 0);
  }
});

test('API shapes and CSV: counts only, a UTF-8 BOM, the formula guard of the invite export, same columns as the page', async (t) => {
  const f = modelFixture(t, { chosen: 'gemini', fetch: answer() });
  up128(f.store);
  await f.runText();
  await f.finishReply('operation');
  const now = NOW + 3600_000;
  const view = readPlayerStats(f.store, now, 7);
  assert.equal(view.since, utc(NOW));
  assert.equal(view.byModel[0]!.model, 'gemini');
  assert.equal(view.byCharacter[0]!.name, '已删除的角色', 'a character with no display name never shows its id');
  assert.doesNotMatch(JSON.stringify(view), /"character"|principal/);
  const csv = playerStatsCsv(view);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0]!.split(',').length, 18);
  assert.match(lines.at(-1)!, /^合计,/);
  assert.equal(lines.length, view.days.length + 2);
  assert.equal(readCosts(f.store, now, 7).usdCny, 6.7);
  assert.equal(costsCsv(readCosts(f.store, now, 7)).charCodeAt(0), 0xfeff);
  // csvDocument is the 22a2 helper: BOM, CRLF, and a tab in front of anything a spreadsheet would read as a formula.
  assert.equal(csvDocument([['=1+1', '+2', '-3', '@4', 'ok']]), '\uFEFF"\t=1+1","\t+2","\t-3","\t@4",ok\r\n');
});

test('a marker is never logged, listed or sent: no statistics code writes a log line, and no contract has a marker field', () => {
  for (const file of ['apps/server/stats/web-stats.ts', 'apps/server/admin/web-stats-admin.ts'])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.|logger|report\(/, `${file} writes no log line`);
  assert.doesNotMatch(
    readFileSync('packages/contracts/web-stats.ts', 'utf8'),
    /\bmarker\??\s*:/,
    'no contract has a marker field',
  );
  // The one query that reads the markers back only counts them.
  const admin = readFileSync('apps/server/admin/web-stats-admin.ts', 'utf8');
  const queries = [...admin.matchAll(/'(SELECT [^']*FROM web_daily_active[^']*)'/g)];
  assert.ok(queries.length >= 2);
  for (const [, query] of queries) assert.match(query!, /count\(\*\)/, query);
  assert.doesNotMatch(admin, /SELECT\s+marker|SELECT\s+\*\s+FROM web_daily_active/);
});
