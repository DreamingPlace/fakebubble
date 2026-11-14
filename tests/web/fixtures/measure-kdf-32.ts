// Part 32 measurement (run by hand: node tests/web/fixtures/measure-kdf-32.ts). Not a test: it prints numbers.
// Time per hash, and the workerd process's resident memory idle / after one hash / after 20 concurrent signups.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomBytes, scryptSync } from 'node:crypto';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';

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
    },
  ],
});
const post = async (path: string, body: object) =>
  (await (
    await mf.dispatchFetch(`http://probe.invalid${path}`, { method: 'POST', body: JSON.stringify(body) })
  ).json()) as Record<string, any>;
const kb = (name: string) => {
  const pids = execFileSync('pgrep', ['-f', 'workerd'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  let rss = 0,
    hwm = 0;
  for (const pid of pids) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      rss = Math.max(rss, Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0));
      hwm = Math.max(hwm, Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0));
    } catch {}
  }
  console.log(name.padEnd(34), 'RSS', (rss / 1024).toFixed(1), 'MiB   peak (VmHWM)', (hwm / 1024).toFixed(1), 'MiB');
  return { rss, hwm };
};
// Start the object (a poll), read the baseline BEFORE any hash, then the first hash alone.
for (let i = 0; i < 3; i++) await (await mf.dispatchFetch('http://probe.invalid/poll')).text();
await new Promise((r) => setTimeout(r, 500));
const idle = kb('baseline, before any hash');
await post('/hash', { kind: 'player', password: 'first-hash-password' });
const first = kb('after the first hash');
console.log('peak growth from the first hash:', ((first.hwm - idle.hwm) / 1024).toFixed(1), 'MiB');

const times: number[] = [];
for (let i = 0; i < 10; i++) {
  const t0 = performance.now();
  await post('/hash', { kind: 'player', password: 'pw-' + randomBytes(5).toString('hex') });
  times.push(performance.now() - t0);
}
times.sort((a, b) => a - b);
console.log(
  'one hash through the entrypoint (ms): min',
  times[0]!.toFixed(0),
  'median',
  times[5]!.toFixed(0),
  'max',
  times.at(-1)!.toFixed(0),
);
const one = kb('after 10 sequential hashes');

const burst = await Promise.all(
  Array.from({ length: 20 }, () => post('/hash', { kind: 'player', password: 'pw-' + randomBytes(5).toString('hex') })),
);
console.log(
  'burst of 20: hashed',
  burst.filter((r) => r.hash).length,
  'limited',
  burst.filter((r) => r.error === 'RATE_LIMITED').length,
);
const many = kb('after 20 concurrent');
console.log(
  'peak growth over idle: one-by-one',
  ((one.hwm - idle.hwm) / 1024).toFixed(1),
  'MiB; with 20 concurrent',
  ((many.hwm - idle.hwm) / 1024).toFixed(1),
  'MiB',
);

// Native Node scrypt for the same parameters, for scale.
const t0 = performance.now();
for (let i = 0; i < 10; i++) scryptSync('pw', randomBytes(16), 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 });
console.log('node scryptSync, same parameters (ms each):', ((performance.now() - t0) / 10).toFixed(0));
await mf.dispose();
