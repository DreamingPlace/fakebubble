import assert from 'node:assert/strict';
import test from 'node:test';
import { WEB_HTTP_LIMITS } from '../../../config/web-v1.ts';
import { CloudRequestLimits, RATE_KEY_CAP } from '../../../apps/server/cloudflare/request-limits.ts';
import { DatabaseSync } from 'node:sqlite';

/** Part 29 F (audit F-01): the global keys never compete with per-IP keys, and a full table sheds the per-IP check. */
function fixture(now = { value: 1_000_000 }) {
  const db = new DatabaseSync(':memory:');
  db.exec(
    'CREATE TABLE cf_http_rates(key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,count INTEGER NOT NULL CHECK(count>0)) STRICT',
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
  let overflow = 0;
  const limits = new CloudRequestLimits(store as never, { now: () => now.value }, () => overflow++);
  return { limits, db, now, overflow: () => overflow };
}

test('1,000 distinct IP hashes in one minute: none is refused before its own limit, and the cap is derived from the global limit', () => {
  const f = fixture();
  assert.equal(RATE_KEY_CAP, WEB_HTTP_LIMITS.requestsGlobalPerMinute * 3);
  for (let i = 0; i < 1000; i++) {
    f.limits.rate('web:global', WEB_HTTP_LIMITS.requestsGlobalPerMinute);
    f.limits.rate(`web:ip:${i}`, WEB_HTTP_LIMITS.requestsPerIpPerMinute);
    f.limits.rate(`web:welcome:${i}`, WEB_HTTP_LIMITS.welcomePerIpPerMinute);
    f.limits.rate(`web:write:${i}`, WEB_HTTP_LIMITS.writesPerIpPerMinute);
  }
  assert.equal(f.overflow(), 0);
  // A visitor still has its own limit.
  assert.throws(() => {
    for (let n = 0; n < WEB_HTTP_LIMITS.requestsPerIpPerMinute + 1; n++)
      f.limits.rate('web:ip:0', WEB_HTTP_LIMITS.requestsPerIpPerMinute);
  }, /RATE_LIMITED/);
});

test('a full table fails open for per-IP checks (counted) and the global limit still trips', () => {
  const f = fixture();
  const now = f.now.value;
  const insert = f.db.prepare('INSERT INTO cf_http_rates VALUES (?,?,1)');
  f.db.exec('BEGIN');
  for (let i = 0; i < RATE_KEY_CAP; i++) insert.run(`web:ip:filled-${i}`, now + 60_000);
  f.db.exec('COMMIT');
  // A newcomer is not refused; the shed is counted.
  f.limits.rate('web:ip:newcomer', 5);
  assert.equal(f.overflow(), 1);
  // The global key was never part of the cap: it is created and it counts, and it trips at its maximum.
  for (let n = 0; n < 3; n++) f.limits.rate('web:global', 3);
  assert.throws(() => f.limits.rate('web:global', 3), /RATE_LIMITED/);
  assert.equal(f.overflow(), 1, 'global keys are never shed');
  // Keys expire after a minute: the table drains and per-IP keys are kept again.
  f.now.value += 61_000;
  f.limits.rate('web:ip:newcomer', 5);
  assert.equal(f.overflow(), 1);
  assert.equal(f.db.prepare("SELECT count(*) n FROM cf_http_rates WHERE key='web:ip:newcomer'").get()!.n, 1);
});
