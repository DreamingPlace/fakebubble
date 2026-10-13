import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import {
  ALERT_COOLDOWN_MS,
  HOUR_MS,
  WebAlerts,
  memoryAlertState,
  type AlertBudgetRow,
} from '../../../apps/server/cloudflare/web-alerts.ts';
import { ALERT_DEFAULTS, webPublicFromEnv, type WebAlertConfig } from '../../../config/web-public.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const T0 = Date.parse('2026-10-11T00:30:00.000Z');
const config: WebAlertConfig = {
  to: 'owner@example.com',
  errorsPerHour: 5,
  dailySpendMicros: 1_000_000,
  budgetPercent: 80,
  validationFailPercent: 20,
  validationMinSamples: 10,
  digestHourUtc: 1,
};

function fixture(overrides: Partial<WebAlertConfig> = {}, budget: AlertBudgetRow[] = []) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE web_operations(id TEXT PRIMARY KEY,status TEXT,created_at INTEGER);
    CREATE TABLE web_provider_attempts(operation_id TEXT,state TEXT,settled_at INTEGER,charged_micros INTEGER);
    CREATE TABLE web_embed_attempts(id TEXT,state TEXT,settled_at INTEGER,charged_micros INTEGER);
    CREATE TABLE web_external_attempts(operation_id TEXT,dispatch_state TEXT);
    CREATE TABLE web_player_email_daily(day TEXT PRIMARY KEY,sends INTEGER);
    CREATE TABLE web_player_logins(principal_id TEXT PRIMARY KEY,email_norm TEXT,created_at INTEGER);
  `);
  const store = {
    get: (sql: string, ...args: never[]) => db.prepare(sql).get(...args),
    all: (sql: string, ...args: never[]) => db.prepare(sql).all(...args),
  };
  let now = T0;
  const mails: { subject: string; text: string }[] = [];
  const failing = { value: false };
  const state = memoryAlertState();
  const make = (emailDailyCap: number | null = 200) =>
    new WebAlerts({
      store: store as never,
      clock: { now: () => now },
      config: { ...config, ...overrides },
      mail: {
        send: async (message) => {
          mails.push(message);
          if (failing.value) throw new Error('mail down: owner@example.com');
        },
      },
      state,
      budget: async () => budget,
      emailDailyCap,
    });
  let ops = 0;
  return {
    db,
    state,
    mails,
    failing,
    alerts: make(),
    make,
    advance: (ms: number) => void (now += ms),
    now: () => now,
    op: (status: string, ageMs = 1000) =>
      db.prepare('INSERT INTO web_operations VALUES (?,?,?)').run(`op-${++ops}`, status, now - ageMs),
    spend: (micros: number, ageMs = 1000) =>
      db.prepare("INSERT INTO web_provider_attempts VALUES ('x','known',?,?)").run(now - ageMs, micros),
    unknown: (table: 'web_provider_attempts' | 'web_embed_attempts' | 'web_external_attempts') =>
      db.exec(
        table === 'web_external_attempts'
          ? "INSERT INTO web_external_attempts VALUES ('x','unknown')"
          : `INSERT INTO ${table} VALUES ('x','unknown',NULL,NULL)`,
      ),
  };
}
const quiet = (alert: { subject: string; text: string }) => {
  // No player content: no address, no long hex id/token, no token-like string, no chat text.
  assert.doesNotMatch(alert.text + alert.subject, /@|[a-f0-9]{16,}|[A-Za-z0-9_-]{32,}/);
  assert.match(alert.subject, /^FAKE 泡泡 /);
};

test('nothing fires below the thresholds, and the hour gate runs the pass once per hour', async () => {
  const f = fixture({ digestHourUtc: 23 });
  for (let i = 0; i < 9; i++) f.op('published');
  assert.deepEqual(await f.alerts.check(), { ran: true, sent: [] });
  assert.deepEqual(await f.alerts.check(), { ran: false, sent: [] }, 'same hour: skipped');
  f.advance(HOUR_MS - 1);
  assert.equal((await f.alerts.check()).ran, false);
  f.advance(1);
  assert.equal((await f.alerts.check()).ran, true);
  assert.equal(f.mails.length, 0);
});

test('every alert type fires, once per 6 hours, in plain Chinese with no player data', async () => {
  const budget: AlertBudgetRow[] = [
    { provider: 'deepseek', allowanceMicros: 1_000_000, spentMicros: 700_000, heldMicros: 100_000 },
    { provider: 'fish', allowanceMicros: null, spentMicros: 5, heldMicros: 0 },
  ];
  const f = fixture({}, budget);
  // 5xx count
  for (let i = 0; i < 5; i++) await f.alerts.recordError();
  // daily spend, unknown attempts (one per source), email cap, 10 replies of which 3 failed
  f.spend(1_500_000);
  for (const table of ['web_provider_attempts', 'web_embed_attempts', 'web_external_attempts'] as const)
    f.unknown(table);
  f.db
    .prepare('INSERT INTO web_player_email_daily VALUES (?,?)')
    .run(new Date(f.now()).toISOString().slice(0, 10), 200);
  for (let i = 0; i < 7; i++) f.op('published');
  for (let i = 0; i < 3; i++) f.op('failed');
  // a message that must never appear in a mail
  f.db.prepare('INSERT INTO web_player_logins VALUES (?,?,?)').run('principal-1', 'someone@example.com', f.now());

  const first = await f.alerts.check();
  assert.deepEqual(first.sent.sort(), [
    'budget-cap',
    'daily-spend',
    'email-cap',
    'errors',
    'unknown-attempt',
    'validation-rate',
  ]);
  assert.equal(f.mails.length, 6);
  for (const mail of f.mails) quiet(mail);
  const bySubject = (needle: string) => f.mails.find((mail) => mail.subject.includes(needle))!.text;
  assert.match(bySubject('服务错误'), /5 次错误.*阈值 5/);
  assert.match(bySubject('今日花费'), /1\.50.*1\.00/);
  assert.match(bySubject('结果未知'), /文字\/语音 1 条，外部 1 条，向量 1 条/);
  assert.match(bySubject('预算'), /已达预算上限的 80%（阈值 80%）/);
  assert.match(bySubject('验证邮件'), /200 封/);
  assert.match(bySubject('失败率'), /3\/10.*30%.*20%/);

  // Inside the 6-hour cooldown the same conditions send nothing, however often the hourly pass runs.
  for (let hour = 1; hour <= 5; hour++) {
    f.advance(HOUR_MS);
    assert.deepEqual(
      (await f.alerts.check()).sent.filter((type) => type !== 'digest'),
      [],
      `hour ${hour}`,
    );
  }
  assert.equal(f.mails.filter((mail) => !mail.subject.includes('日报')).length, 6);
  // After 6 hours the standing conditions send again (unknown only when a NEW unknown appeared).
  f.advance(HOUR_MS);
  const again = await f.alerts.check();
  // (the errors and the failed replies are older than an hour by now, so those conditions no longer hold)
  assert.deepEqual(again.sent.filter((type) => type !== 'digest').sort(), ['budget-cap', 'daily-spend', 'email-cap']);
  f.unknown('web_embed_attempts');
  f.advance(ALERT_COOLDOWN_MS);
  assert.ok((await f.alerts.check()).sent.includes('unknown-attempt'));
});

test('a failed mail is claimed first and never retried inside the window', async () => {
  const f = fixture();
  f.failing.value = true;
  f.unknown('web_provider_attempts');
  assert.deepEqual(await f.alerts.check(), { ran: true, sent: [] });
  assert.equal(f.mails.length, 1, 'one attempt');
  // The mailer recovers; the next hourly passes (inside the window) do not retry.
  f.failing.value = false;
  for (let i = 0; i < 5; i++) {
    f.advance(HOUR_MS);
    await f.alerts.check();
  }
  assert.equal(f.mails.filter((mail) => mail.subject.includes('结果未知')).length, 1);
  // A restart (a new object over the same stored state) does not resend either.
  const restarted = f.make();
  f.advance(1000);
  await restarted.check();
  assert.equal(f.mails.filter((mail) => mail.subject.includes('结果未知')).length, 1);
  // The error text of the failing mailer (it contained an address) was never put into any mail or report.
  for (const mail of f.mails) assert.ok(!mail.text.includes('mail down'));
});

test('a throwing evaluator does not stop the others, and its error text is not reported', async () => {
  const reports: string[] = [];
  const f = fixture();
  f.db.exec('DROP TABLE web_operations');
  for (let i = 0; i < 5; i++) await f.alerts.recordError();
  const alerts = new WebAlerts({
    store: { get: (sql: string, ...a: never[]) => f.db.prepare(sql).get(...a), all: () => [] } as never,
    clock: { now: () => f.now() },
    config,
    mail: { send: async (message) => void f.mails.push(message) },
    state: f.state,
    budget: async () => {
      throw new Error('budget down');
    },
    emailDailyCap: 200,
    report: (event) => void reports.push(event),
  });
  const result = await alerts.check();
  assert.deepEqual(result.sent, ['errors']);
  assert.ok(reports.some((event) => event.startsWith('alert_evaluate_failed:')));
  assert.ok(reports.every((event) => !event.includes('down')));
});

test('daily digest: once per UTC day at the configured hour, short and without player data', async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.op('published');
  f.op('failed');
  f.spend(250_000);
  f.db.prepare('INSERT INTO web_player_logins VALUES (?,?,?)').run('p1', 'a@example.com', f.now());
  f.db.prepare('INSERT INTO web_player_logins VALUES (?,?,?)').run('p2', 'b@example.com', f.now());
  assert.deepEqual((await f.alerts.check()).sent, [], '00:30 UTC is before the digest hour');
  f.advance(HOUR_MS); // 01:30
  assert.deepEqual((await f.alerts.check()).sent, ['digest']);
  const digest = f.mails.at(-1)!;
  quiet(digest);
  assert.match(digest.text, /回复：4 条/);
  assert.match(digest.text, /新注册：2 人/);
  assert.match(digest.text, /约 0\.25/);
  assert.match(digest.text, /失败回复：1 条/);
  for (let i = 0; i < 5; i++) {
    f.advance(HOUR_MS);
    assert.deepEqual((await f.alerts.check()).sent, [], 'no second digest the same UTC day');
  }
  // The next day's digest.
  f.advance(24 * HOUR_MS);
  assert.deepEqual((await f.alerts.check()).sent, ['digest']);
});

test('a low sample is not a failure rate, and an unlimited budget never alerts', async () => {
  const f = fixture({}, [{ provider: 'deepseek', allowanceMicros: null, spentMicros: 9e12, heldMicros: 0 }]);
  f.op('failed');
  f.op('failed');
  assert.deepEqual(await f.alerts.check(), { ran: true, sent: [] });
});

test('the alarm asks to wake an hour after the last pass', async () => {
  const f = fixture();
  assert.equal(f.alerts.nextDue(), T0 + HOUR_MS);
  await f.alerts.check();
  assert.equal(f.alerts.nextDue(), T0 + HOUR_MS);
  f.advance(10 * 60_000);
  await f.alerts.check();
  assert.equal(f.alerts.nextDue(), T0 + HOUR_MS, 'gated: still an hour after the real pass');
});

test('thresholds are Worker vars with safe defaults, validated, and everything is off by default', () => {
  assert.equal(webPublicFromEnv({}).alerts, null);
  assert.equal(webPublicFromEnv({ ALERTS_ENABLED: 'false', ALERT_EMAIL_TO: 'owner@example.com' }).alerts, null);
  const on = webPublicFromEnv({ ALERTS_ENABLED: 'true', ALERT_EMAIL_TO: 'owner@example.com' }).alerts!;
  assert.deepEqual(
    { ...on, to: undefined },
    { ...ALERT_DEFAULTS, to: undefined },
    'the documented defaults apply when no threshold is set',
  );
  assert.equal(
    webPublicFromEnv({ ALERTS_ENABLED: 'true', ALERT_EMAIL_TO: 'owner@example.com', ALERT_ERRORS_PER_HOUR: '3' })
      .alerts!.errorsPerHour,
    3,
  );
  for (const bad of [
    { ALERT_EMAIL_TO: 'not an address' },
    {},
    { ALERT_EMAIL_TO: 'a@b.co', ALERT_BUDGET_PERCENT: '0' },
    { ALERT_EMAIL_TO: 'a@b.co', ALERT_ERRORS_PER_HOUR: 'many' },
    { ALERT_EMAIL_TO: 'a@b.co', ALERT_DIGEST_HOUR_UTC: '24' },
  ])
    assert.throws(
      () => webPublicFromEnv({ ALERTS_ENABLED: 'true', ...bad }),
      (error) => error instanceof DomainError,
    );
});
