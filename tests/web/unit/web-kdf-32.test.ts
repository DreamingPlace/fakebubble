// Part 32 (audit F-08): the KDF split, at class level (the workerd test is web-kdf-32.integration.test.ts).
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { WEB_KDF_LIMITS } from '../../../config/web-v1.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { WebKdfBinding } from '../../../packages/contracts/web-kdf-rpc.ts';
import { kdfHash, kdfVerify, remotePasswords, serveKdf } from '../../../apps/server/cloudflare/web-kdf.ts';
import { adminPasswords, playerPasswords } from '../../../apps/server/admin/web-admin-password.ts';
import { KdfGate } from '../../../apps/server/identity/kdf-gate.ts';
import { PLAYER_LIMITS } from '../../../apps/server/identity/web-player-accounts.ts';

/** The stored format with the parameters written out here, not imported. */
const stored = (password: string, saltHex: string) =>
  `scrypt-16384-8-5$${saltHex}$${scryptSync(password, Buffer.from(saltHex, 'hex'), 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }).toString('hex')}`;
const code = async (work: Promise<unknown>) =>
  work.then(
    () => 'no error',
    (error: unknown) => (error instanceof DomainError ? error.code : `other: ${String(error)}`),
  );

test('the entrypoint computes the stored format: old hashes verify, new ones match the independent computation', async () => {
  const salt = randomBytes(16).toString('hex'),
    password = 'an old password';
  assert.equal(await kdfVerify(password, stored(password, salt)), true);
  assert.equal(await kdfVerify('another one', stored(password, salt)), false);
  assert.equal(await kdfVerify(password, null), false);
  const made = await kdfHash(password);
  assert.equal(made, stored(password, made.split('$')[1]!));
  // Both policies' verifiers (the old in-process ones) accept what the entrypoint made, and the reverse.
  assert.equal(await playerPasswords.verify(password, made), true);
  assert.equal(await adminPasswords.verify(password, made), true);
  assert.equal(await kdfVerify(password, await playerPasswords.hash(password)), true);
  await assert.rejects(kdfVerify(password, 'scrypt-16384-8-5$zz$zz'), { message: 'WEB_ADMIN_PASSWORD_FORMAT_INVALID' });
});

test('a failure leaves the entrypoint as a fixed code, never anything of the input', async () => {
  const canary = `CANARY${randomBytes(5).toString('hex')}`;
  for (const [call, expected] of [
    [() => kdfHash(canary + 'x'.repeat(WEB_KDF_LIMITS.passwordMaxBytes)), 'WEB_KDF_FAILED'],
    [() => kdfHash(42), 'WEB_KDF_FAILED'],
    [() => kdfVerify(canary, 'x'.repeat(300)), 'WEB_KDF_FAILED'],
    // A stored value in the wrong shape keeps the code it always had.
    [() => kdfVerify(canary, canary), 'WEB_ADMIN_PASSWORD_FORMAT_INVALID'],
  ] as const)
    await assert.rejects(call(), (error: Error) => error.message === expected && !error.message.includes(canary));
});

test('the entrypoint refuses beyond its isolate budget instead of queueing', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const running = Array.from({ length: WEB_KDF_LIMITS.isolateConcurrent }, () => serveKdf(() => held));
  await assert.rejects(
    serveKdf(async () => 'late'),
    { message: 'RATE_LIMITED' },
  );
  release();
  await Promise.all(running);
  assert.equal(await serveKdf(async () => 'again'), 'again');
});

test('the client validates policy first, drops the far side message, and distrusts the answer', async () => {
  const calls: string[] = [];
  const canary = `CANARY${randomBytes(5).toString('hex')}`;
  let answer: () => Promise<unknown> = async () => stored('correct horse', '00'.repeat(16));
  const binding = {
    hash: async (p: string) => (calls.push('hash'), answer()),
    verify: async (p: string, e: string | null) => (calls.push('verify'), answer()),
  } as unknown as WebKdfBinding;
  const { admin, player } = remotePasswords(binding);
  // A password the policy refuses never crosses.
  assert.equal(await code(player.hash('short')), 'PLAYER_PASSWORD_INVALID');
  assert.equal(await code(admin.hash('x'.repeat(19))), 'ADMIN_PASSWORD_INVALID');
  assert.equal(await code(admin.verify('short', null)), 'ADMIN_PASSWORD_INVALID');
  assert.deepEqual(calls, []);
  // The far side's own message is never carried: only a code from the fixed list, else WEB_KDF_FAILED.
  answer = async () => {
    throw new Error(`boom ${canary}`);
  };
  const failed = await player.hash('correct horse').catch((error: DomainError) => error);
  assert.equal((failed as DomainError).code, 'WEB_KDF_FAILED');
  assert.equal((failed as DomainError).message.includes(canary), false);
  for (const fixed of ['RATE_LIMITED', 'WEB_ADMIN_PASSWORD_FORMAT_INVALID']) {
    answer = async () => {
      throw new Error(fixed);
    };
    assert.equal(await code(player.verify('correct horse', null)), fixed);
  }
  // A hash that is not in the stored format, or a verdict that is not a boolean, is never trusted.
  answer = async () => 'plaintext';
  assert.equal(await code(player.hash('correct horse')), 'WEB_KDF_FAILED');
  answer = async () => 'yes';
  assert.equal(await code(player.verify('correct horse', null)), 'WEB_KDF_FAILED');
  answer = async () => true;
  assert.equal(await player.verify('correct horse', 'whatever'), true);
  // No binding (a deploy without it) fails closed with its own code; nothing is hashed in this process.
  assert.equal(await code(remotePasswords(undefined).player.hash('correct horse')), 'WEB_KDF_UNAVAILABLE');
});

test('the gate: running and waiting limits, then RATE_LIMITED; a queued job starts on a later turn', async () => {
  const gate = new KdfGate(2, 3);
  const releases: (() => void)[] = [];
  const job = () => gate.run(() => new Promise<void>((resolve) => releases.push(resolve)));
  const jobs = Array.from({ length: 5 }, job);
  assert.equal(releases.length, 2, 'two run, three wait');
  assert.equal(await code(job()), 'RATE_LIMITED');
  releases.shift()!();
  await jobs[0];
  assert.equal(releases.length, 1, 'the waiting job has not started in the same turn');
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(releases.length, 2);
  for (let pass = 0; pass < 5; pass++) {
    while (releases.length) releases.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await Promise.all(jobs);
  // Idle again: a new job runs at once.
  let ran = false;
  await gate.run(async () => void (ran = true));
  assert.equal(ran, true);
});

test('memory: what the business object can send at once fits the entrypoint isolate, with room to spare', () => {
  assert.equal(WEB_KDF_LIMITS.scryptWorkingSetBytes, 128 * WEB_KDF_LIMITS.scryptN * WEB_KDF_LIMITS.scryptR);
  assert.equal(WEB_KDF_LIMITS.scryptWorkingSetBytes, 16 * 1024 * 1024);
  assert.ok(WEB_KDF_LIMITS.scryptMaxmemBytes >= WEB_KDF_LIMITS.scryptWorkingSetBytes);
  // Even if every admitted call held its own working set at once (the entrypoint takes turns, so only one does):
  assert.ok(
    WEB_KDF_LIMITS.isolateConcurrent * WEB_KDF_LIMITS.scryptWorkingSetBytes <= WEB_KDF_LIMITS.isolateLimitBytes / 2,
  );
  // The business object sends at most this many at once: the player gate's running slots plus the admin's one.
  assert.ok(PLAYER_LIMITS.kdfConcurrent + 1 <= WEB_KDF_LIMITS.isolateConcurrent);
});

test('the deploy: business.json.example binds the business script to its own WebKdfService, and nothing else is added', () => {
  const config = JSON.parse(readFileSync('workers/web-cloudflare/deploy/business.json.example', 'utf8')) as {
    name: string;
    services: { binding: string; service: string; entrypoint: string }[];
    durable_objects: unknown;
  };
  assert.deepEqual(
    config.services.find((service) => service.binding === 'KDF'),
    { binding: 'KDF', service: config.name, entrypoint: 'WebKdfService' },
  );
  assert.deepEqual(config.services.map((service) => service.binding).sort(), ['BUDGET', 'GENERATION', 'KDF']);
  // The entrypoint is exported by the business script the deploy builds.
  assert.match(
    readFileSync('workers/web-cloudflare/business.ts', 'utf8'),
    /export class WebKdfService extends WorkerEntrypoint/,
  );
  // And it holds nothing: the class reads no env and no storage.
  const source = readFileSync('workers/web-cloudflare/business.ts', 'utf8');
  const body = source.slice(source.indexOf('export class WebKdfService'), source.indexOf('/** Invoked only through'));
  assert.equal(/this\.(env|ctx)/.test(body), false);
});
