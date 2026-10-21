import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { initLocalInstance, localRuntime, readLocalConfig } from '../../../apps/server/platform/web-local-config.ts';
import { parseWebDailyReplyLimit, webDailyReplyLimitFromEnv } from '../../../config/web-concurrency.ts';
import { RetryAfterError } from '../../../packages/domain/errors.ts';
import { tiersFixture } from '../fixtures/invite-tiers.ts';

const DAY = 24 * 60 * 60_000;

/**
 * Named exception (Part 22x): the fixture's vehicle was a legacy kind-'invite' principal on a schema-112 local instance. That
 * kind no longer decides anything, so the player is now an unlimited-entitlement holder (a signed-up guest redeeming a real
 * code through WebInviteTiers) on the real schema 126; the daily limit is still the one WebAdmission applies to an unmetered tier.
 */
function fixture(t: test.TestContext, dailyReplyLimit: number) {
  const f = tiersFixture(t);
  Object.assign(f.store, { dailyReplyLimit });
  const batch = f.create(f.owner, { count: 8, tier: { kind: 'unlimited' } });
  const codes = [...(batch.codes ?? [])];
  const player = (name: string, kind: 'invite' | 'guest' = 'invite') => {
    if (kind === 'guest') return f.player(name).principalId;
    const who = f.player(name, { signedUp: true });
    f.redeem(who, codes.shift()!);
    return who.principalId;
  };
  const admit = (principalId: string, requestId: string) => f.admit(principalId, requestId);
  // Finishing an operation frees the per-player pending slot; quota_state stays as the admission left it.
  const finish = (requestId: string, status: 'published' | 'failed' = 'published', quota?: 'released') =>
    f.store.run(
      `UPDATE web_operations SET status=?,stage_version=stage_version+1${quota ? ",quota_state='released'" : ''}
      WHERE request_id=?`,
      status,
      requestId,
    );
  const count = () => f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations')!.n;
  return { store: f.store, admit, finish, player, count, advance: f.advance, now: f.clock };
}

test('the limit+1th player reply in 24h is refused at admission, before any reservation, then allowed once the window passes', (t) => {
  const f = fixture(t, 3);
  const id = f.player('a');
  const started = f.now();
  f.admit(id, 'r1');
  f.finish('r1');
  f.advance(60_000);
  f.admit(id, 'r2');
  f.finish('r2');
  f.advance(60_000);
  f.admit(id, 'r3');
  f.finish('r3');
  const before = f.count();
  let refused: unknown;
  try {
    f.admit(id, 'r4');
  } catch (error) {
    refused = error;
  }
  assert.ok(refused instanceof RetryAfterError);
  assert.equal(refused.code, 'WEB_DAILY_LIMIT_REACHED');
  // retryAfterMs is until the OLDEST counted operation leaves the rolling window.
  assert.equal(refused.retryAfterMs, started + DAY - f.now());
  assert.equal(f.count(), before, 'nothing was admitted, queued or reserved');
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_operations WHERE request_id=?', 'r4')!.n, 0);
  for (const table of ['messages', 'outbox'])
    assert.equal(
      f.store.get<{ n: number }>(`SELECT count(*) n FROM ${table}`)!.n,
      3,
      `${table}: the refused request wrote no input message or outbox row`,
    );
  // Idempotent replay of an already-admitted request is still answered.
  assert.equal(f.admit(id, 'r2').duplicate, true);
  f.advance(refused.retryAfterMs);
  assert.equal(f.admit(id, 'r4').duplicate, false);
  f.finish('r4');
  // The rolling window now holds r2, r3, r4 and refuses again until r2 leaves.
  assert.throws(() => f.admit(id, 'r5'), /WEB_DAILY_LIMIT_REACHED/);
});

test('the limit is per principal; the guest trial keeps its own cap of 3 and ignores the daily limit', (t) => {
  const f = fixture(t, 1);
  const a = f.player('a'),
    b = f.player('b'),
    guest = f.player('g', 'guest');
  f.admit(a, 'a1');
  f.finish('a1');
  assert.throws(() => f.admit(a, 'a2'), /WEB_DAILY_LIMIT_REACHED/);
  assert.equal(f.admit(b, 'b1').duplicate, false);
  // Named exception (Part 22x): the fixture runs the real schema, so the free tier is switched off for the plain trial path and
  // each trial reply is finished first (one pending operation per player).
  Object.assign(f.store, { publicFreeTier: false });
  for (const n of [1, 2, 3]) {
    f.admit(guest, `g${n}`);
    f.finish(`g${n}`);
  }
  assert.throws(() => f.admit(guest, 'g4'), /TRIAL_EXHAUSTED/);
});

test('operations whose reservation was released do not count; proactive messages are not operations', (t) => {
  const f = fixture(t, 2);
  const id = f.player('a');
  f.admit(id, 'r1');
  f.finish('r1', 'failed', 'released');
  // Proactive/scheduled character messages are messages, never player operations: they do not count.
  const conversation = f.store.get<{ id: string; world_id: string }>('SELECT id,world_id FROM conversations')!;
  for (const n of [1, 2, 3, 4])
    f.store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive,quota_day)
      VALUES (?,?,?,'character','fixture-character','hi',0,'text',1,'2023-11-14')`,
      `proactive-${n}`,
      conversation.world_id,
      conversation.id,
    );
  f.admit(id, 'r2');
  f.finish('r2');
  f.admit(id, 'r3');
  f.finish('r3');
  assert.throws(() => f.admit(id, 'r4'), /WEB_DAILY_LIMIT_REACHED/);
});

test('DAILY_REPLY_LIMIT defaults to 100, accepts 1–10000 and an invalid value refuses to start', () => {
  assert.equal(webDailyReplyLimitFromEnv({}), 100);
  assert.equal(webDailyReplyLimitFromEnv({ DAILY_REPLY_LIMIT: '1' }), 1);
  assert.equal(webDailyReplyLimitFromEnv({ DAILY_REPLY_LIMIT: '10000' }), 10_000);
  for (const bad of ['0', '10001', '-1', '1.5', 'abc', '', ' 5']) {
    assert.throws(
      () => webDailyReplyLimitFromEnv({ DAILY_REPLY_LIMIT: bad }),
      /WEB_CONCURRENCY_INVALID_DAILY_REPLY_LIMIT/,
      `value ${JSON.stringify(bad)}`,
    );
  }
  assert.throws(() => parseWebDailyReplyLimit(0), /WEB_CONCURRENCY_INVALID_DAILY_REPLY_LIMIT/);
  assert.equal(parseWebDailyReplyLimit(250), 250);
});

test('a local instance reads dailyReplyLimit from local-config.json and refuses to start when it is invalid', (t) => {
  const { parent } = localRuntime();
  mkdirSync(parent, { recursive: true });
  const root = join(parent, `local-daily-${randomUUID().slice(0, 8)}`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  initLocalInstance(root);
  const path = join(root, 'local-config.json');
  const written = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  assert.equal(readLocalConfig(root).dailyReplyLimit, 100);
  for (const value of [0, 10_001, 2.5, 'x']) {
    writeFileSync(path, JSON.stringify({ ...written, dailyReplyLimit: value }));
    assert.throws(() => readLocalConfig(root), /WEB_CONCURRENCY_INVALID_DAILY_REPLY_LIMIT/);
  }
  writeFileSync(path, JSON.stringify({ ...written, dailyReplyLimit: 7 }));
  assert.equal(readLocalConfig(root).dailyReplyLimit, 7);
});
