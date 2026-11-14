// Part 32 (audit F-08): password hashing outside the business object, in real workerd. The business Worker script's own
// WebKdfService, bound to itself as KDF (the same shape as workers/web-cloudflare/deploy/business.json.example).
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';

/** A stored hash computed HERE with the parameters written out (not imported), so a changed constant cannot hide. */
const stored = (password: string, saltHex: string) =>
  `scrypt-16384-8-5$${saltHex}$${scryptSync(password, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }).toString('hex')}`;

async function runtime(t: test.TestContext, logs: string[]) {
  const mf = new Miniflare({
    workers: [
      {
        name: 'business',
        modules: testModules('tests/web/fixtures/cloudflare-kdf-32-worker.ts'),
        modulesRoot: resolve('.'),
        compatibilityDate: '2026-07-30',
        compatibilityFlags: ['nodejs_compat', 'enable_request_signal'],
        durableObjects: { PROBE: { className: 'KdfProbe', useSQLite: true } },
        serviceBindings: { KDF: { name: 'business', entrypoint: 'WebKdfService' } },
        handleRuntimeStdio: (out: import('node:stream').Readable, err: import('node:stream').Readable) => {
          for (const stream of [out, err]) stream.on('data', (chunk: Buffer) => logs.push(String(chunk)));
        },
      },
    ],
  });
  t.after(() => mf.dispose());
  const post = async (path: string, body: object) => {
    const response = await mf.dispatchFetch(`http://probe.invalid${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  const poll = async () => {
    const start = performance.now();
    await (await mf.dispatchFetch('http://probe.invalid/poll')).text();
    return performance.now() - start;
  };
  return { post, poll };
}

test('an old hash still verifies byte for byte; a wrong password and an unknown identity are refused', async (t) => {
  const logs: string[] = [];
  const f = await runtime(t, logs);
  const salt = randomBytes(16).toString('hex');
  const password = `old-${randomBytes(5).toString('hex')}-pw`;
  const old = stored(password, salt);
  for (const kind of ['player', 'admin'] as const) {
    assert.deepEqual((await f.post('/verify', { kind, password, encoded: old })).body, { valid: true });
    assert.deepEqual((await f.post('/verify', { kind, password: password + 'x', encoded: old })).body, {
      valid: false,
    });
    // An unknown identity (no stored hash) pays the same work and is refused.
    assert.deepEqual((await f.post('/verify', { kind, password, encoded: null })).body, { valid: false });
  }
  // A stored value in any other shape is refused with the same code as before the move.
  const broken = await f.post('/verify', { kind: 'player', password, encoded: 'scrypt-16384-8-5$zz$zz' });
  assert.equal(broken.body.error, 'WEB_ADMIN_PASSWORD_FORMAT_INVALID');
  // A new hash is the same format, with a fresh salt, and the independent computation agrees with it.
  const made = (await f.post('/hash', { kind: 'player', password })).body.hash as string;
  const parts = made.split('$');
  assert.match(made, /^scrypt-16384-8-5\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.notEqual(parts[1], salt);
  assert.equal(made, stored(password, parts[1]!));
  // The password policies are checked before anything crosses to the entrypoint.
  assert.equal((await f.post('/hash', { kind: 'player', password: 'short' })).body.error, 'PLAYER_PASSWORD_INVALID');
  assert.equal(
    (await f.post('/hash', { kind: 'admin', password: 'x'.repeat(19) })).body.error,
    'ADMIN_PASSWORD_INVALID',
  );
  // Admin login still accepts the older, longer passwords.
  const long = 'L'.repeat(100);
  assert.deepEqual((await f.post('/verify', { kind: 'admin', password: long, encoded: stored(long, salt) })).body, {
    valid: true,
  });
});

test('nothing secret is logged, answered or put in an error', async (t) => {
  const logs: string[] = [];
  const f = await runtime(t, logs);
  const canary = `CANARY${randomBytes(6).toString('hex')}`;
  const salt = randomBytes(16).toString('hex');
  const old = stored(canary, salt);
  const answers: string[] = [];
  for (const call of [
    { path: '/hash', body: { kind: 'player', password: canary } },
    { path: '/verify', body: { kind: 'player', password: canary, encoded: old } },
    { path: '/verify', body: { kind: 'player', password: canary + '!', encoded: old } },
    { path: '/verify', body: { kind: 'admin', password: canary, encoded: 'not-a-hash' } },
    { path: '/hash', body: { kind: 'player', password: 'x' } },
  ])
    answers.push((await f.post(call.path, call.body)).text);
  // Past the client's policy, the far side fails with a fixed code, whatever the input was.
  const oversize = await f.post('/raw-hash', { password: canary + 'y'.repeat(2000) });
  assert.equal(oversize.body.message, 'WEB_KDF_FAILED');
  answers.push(oversize.text);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const seen = [...logs, ...answers].join('\n');
  for (const secret of [canary, salt, old.split('$')[2]!]) assert.equal(seen.includes(secret), false);
});

test('20 concurrent signups while a chat poll runs: the poll waits for one hash, not for all of them', async (t) => {
  const logs: string[] = [];
  const f = await runtime(t, logs);
  for (let i = 0; i < 5; i++) await f.poll();
  const burst = async (inline: boolean) => {
    const jobs = Array.from({ length: 20 }, () =>
      f.post('/hash', { password: 'pw-' + randomBytes(6).toString('hex'), inline }),
    );
    const polls: number[] = [];
    let done = false;
    const all = Promise.all(jobs).then((r) => ((done = true), r));
    while (!done) {
      polls.push(await f.poll());
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const results = await all;
    return {
      worst: Math.max(...polls),
      hashed: results.filter((r) => r.body.hash).length,
      limited: results.filter((r) => r.body.error === 'RATE_LIMITED').length,
      other: results.filter((r) => !r.body.hash && r.body.error !== 'RATE_LIMITED').length,
    };
  };
  // The control: the old in-process hash behind the same gate. The one object thread does all 20 before it answers the poll.
  const before = await burst(true);
  const after = await burst(false);
  t.diagnostic(
    `poll during 20 hashes: in-process worst ${before.worst.toFixed(0)} ms, entrypoint worst ${after.worst.toFixed(0)} ms`,
  );
  // Every signup got a hash or the gate's RATE_LIMITED, nothing else.
  assert.equal(after.other, 0);
  assert.equal(after.hashed + after.limited, 20);
  assert.ok(after.hashed >= 2);
  // Hashing is synchronous CPU in workerd, so the poll is not free during a burst; it waits for the hash that is running,
  // not for the whole queue.
  assert.ok(after.worst < before.worst / 2, `entrypoint ${after.worst} vs in-process ${before.worst}`);
});
