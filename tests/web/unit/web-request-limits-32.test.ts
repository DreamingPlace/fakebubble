// Part 32 (audit F-01): the reproduction first. The limiter that held at most 512 keys a minute refused visitor 171, because
// one visitor makes three per-IP keys. Part 29 F replaced it; this test drives the real class with the calls web-http.ts makes
// for one visitor (load the page, play one welcome clip, send one message) and pins that the audit's case is gone.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';
import { CloudRequestLimits, RATE_KEY_CAP } from '../../../apps/server/cloudflare/request-limits.ts';
import { WebSecurityCounters } from '../../../apps/server/admin/web-admin-actions.ts';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE cf_http_rates(key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>0)) STRICT',
  );
  db.exec(
    'CREATE TABLE web_turnstile_counts(day TEXT NOT NULL,outcome TEXT NOT NULL,n INTEGER NOT NULL,PRIMARY KEY(day,outcome))',
  );
  const store = {
    transaction: <T>(work: () => T) => {
      db.exec('BEGIN');
      try {
        const out = work();
        db.exec('COMMIT');
        return out;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },
    run: (sql: string, ...args: never[]) => db.prepare(sql).run(...args),
    get: (sql: string, ...args: never[]) => db.prepare(sql).get(...args),
    all: (sql: string, ...args: never[]) => db.prepare(sql).all(...args),
  };
  const clock = { now: () => 1_800_000_000_000 };
  const counters = new WebSecurityCounters(store as never, clock);
  return { db, clock, counters, limits: new CloudRequestLimits(store as never, clock, () => counters.overflow()) };
}
/**
 * The calls WebProviderHTTP makes for one visitor: a page load, one welcome clip, one message. The welcome clip has its OWN
 * global limit (300 plays a minute, on purpose), so only that many visitors play one; everyone else loads and writes.
 */
function visit(limits: CloudRequestLimits, id: number) {
  limits.rate('web:global', WEB_HTTP_LIMITS.requestsGlobalPerMinute);
  limits.rate(`web:ip:${id}`, WEB_HTTP_LIMITS.requestsPerIpPerMinute);
  if (id <= WEB_HTTP_LIMITS.welcomeGlobalPerMinute) {
    limits.rate(`web:welcome:${id}`, WEB_HTTP_LIMITS.welcomePerIpPerMinute);
    limits.rate('web:welcome:global', WEB_HTTP_LIMITS.welcomeGlobalPerMinute);
  }
  limits.rate(`web:write:${id}`, WEB_HTTP_LIMITS.writesPerIpPerMinute);
}

test('the audit case: visitor 171 (and every one after) is served; the old cap was 512 rows = 170 visitors', () => {
  const f = fixture();
  // Three per-IP keys per visitor: 170 visitors fill 510 rows, and visitor 171 was the first refused.
  for (let id = 1; id <= 170; id++) visit(f.limits, id);
  assert.doesNotThrow(() => visit(f.limits, 171));
  // A trend spike: a thousand distinct visitors in the same minute, none refused.
  for (let id = 172; id <= 1000; id++) assert.doesNotThrow(() => visit(f.limits, id), `visitor ${id}`);
  const rows = f.db.prepare('SELECT count(*) n FROM cf_http_rates').get() as { n: number };
  assert.ok(rows.n > 512, 'the table holds more than the old cap');
  assert.ok(rows.n <= RATE_KEY_CAP + 2, 'and is still bounded: the cap plus the two global keys');
  assert.equal(f.counters.read(f.clock.now()).rateOverflowToday, 0, 'nothing was shed at this volume');
});

test('a full table sheds the per-IP check, counts it as a number only, and the global limit still holds', () => {
  const f = fixture();
  const insert = f.db.prepare('INSERT INTO cf_http_rates VALUES (?,?,1)');
  f.db.exec('BEGIN');
  for (let i = 0; i < RATE_KEY_CAP; i++) insert.run(`web:ip:filled-${i}`, f.clock.now() + 60_000);
  f.db.exec('COMMIT');
  assert.doesNotThrow(() => visit(f.limits, 99_999));
  const shown = f.counters.read(f.clock.now());
  assert.ok(shown.rateOverflowToday >= 1);
  // What 系统状态 receives is counts: no key, address or hash is in it.
  for (const value of Object.values(shown)) assert.equal(typeof value, 'number');
  // The global limit is exempt from the cap and still refuses at its own maximum.
  const global = fixture();
  for (let n = 0; n < 5; n++) global.limits.rate('web:global', 5);
  assert.throws(() => global.limits.rate('web:global', 5), /RATE_LIMITED/);
});
