import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SITEVERIFY_URL,
  TurnstileGate,
  siteverifyVerifier,
  type TurnstileVerifier,
} from '../../../apps/server/identity/web-turnstile.ts';
import { webPublicFromEnv } from '../../../config/web-public.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const gate = (verifier: TurnstileVerifier, now = { value: 1_000 }) =>
  new TurnstileGate({
    siteKey: '1x00000000000000000000AA',
    secret: 'unit-test-secret',
    origin: 'https://play.example.com',
    verifier,
    clock: { now: () => now.value },
  });
const code = async (work: Promise<unknown>) => {
  try {
    await work;
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return null;
};

test('the real verifier posts the secret, token and peer to siteverify and nothing else (fake fetch, no network)', async () => {
  const seen: { url: string; body: string; method: string }[] = [];
  const verifier = siteverifyVerifier((async (url: string, init: RequestInit) => {
    seen.push({ url: String(url), body: String(init.body), method: String(init.method) });
    return Response.json({ success: true, hostname: 'play.example.com', action: 'guest', 'error-codes': [], extra: 1 });
  }) as unknown as typeof fetch);
  const verdict = await verifier.verify({ secret: 's3cret-value', token: 'tok-1', remoteIp: '192.0.2.7' });
  assert.deepEqual(verdict, { success: true, hostname: 'play.example.com', action: 'guest' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.url, SITEVERIFY_URL);
  assert.equal(seen[0]!.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(seen[0]!.body)), {
    secret: 's3cret-value',
    response: 'tok-1',
    remoteip: '192.0.2.7',
  });
  // Without a peer the field is simply absent.
  seen.length = 0;
  await verifier.verify({ secret: 's', token: 't', remoteIp: null });
  assert.ok(!new URLSearchParams(seen[0]!.body).has('remoteip'));
  // A non-200, a non-JSON body and a body without "success" all throw (the gate turns that into UNAVAILABLE).
  for (const response of [
    new Response('no', { status: 500 }),
    new Response('<html>', { status: 200 }),
    Response.json({ ok: 1 }),
  ])
    await assert.rejects(
      siteverifyVerifier((async () => response) as unknown as typeof fetch).verify({
        secret: 's',
        token: 't',
        remoteIp: null,
      }),
    );
});

test('the gate fails closed on a missing, malformed, rejected, mis-targeted or unverifiable token', async () => {
  const calls: string[] = [];
  let verdict: Awaited<ReturnType<TurnstileVerifier['verify']>> | 'throw' = {
    success: true,
    hostname: 'play.example.com',
    action: 'guest',
  };
  const g = gate({
    verify: async ({ token }) => {
      calls.push(token);
      if (verdict === 'throw') throw new Error('network');
      return verdict;
    },
  });
  assert.equal(await code(g.require(null, 'guest', null)), 'TURNSTILE_REQUIRED');
  assert.equal(await code(g.require('', 'guest', null)), 'TURNSTILE_REQUIRED');
  assert.equal(await code(g.require('has space', 'guest', null)), 'TURNSTILE_FAILED');
  assert.equal(await code(g.require('x'.repeat(2049), 'guest', null)), 'TURNSTILE_FAILED');
  assert.deepEqual(calls, [], 'malformed tokens never reach siteverify');
  assert.equal(await code(g.require('ok-1', 'guest', '192.0.2.1')), null);
  verdict = { success: false };
  assert.equal(await code(g.require('rejected-1', 'guest', null)), 'TURNSTILE_FAILED');
  verdict = { success: true, hostname: 'evil.example.net', action: 'guest' };
  assert.equal(
    await code(g.require('other-host-1', 'guest', null)),
    'TURNSTILE_FAILED',
    'a token minted for another site',
  );
  verdict = { success: true, hostname: 'play.example.com', action: 'login' };
  assert.equal(
    await code(g.require('other-action-1', 'guest', null)),
    'TURNSTILE_FAILED',
    'a token minted for another action',
  );
  verdict = 'throw';
  assert.equal(await code(g.require('down-1', 'guest', null)), 'TURNSTILE_UNAVAILABLE');
});

test('each token works once, concurrent use of one token passes once, and an outage gives the token back', async () => {
  const now = { value: 1_000 };
  let release: () => void = () => {};
  const gated = new Promise<void>((resolve) => (release = resolve));
  let down = false;
  const g = gate(
    {
      verify: async ({ token }) => {
        if (down) throw new Error('network');
        if (token === 'slow-1') await gated;
        return { success: true, hostname: 'play.example.com', action: 'code' };
      },
    },
    now,
  );
  const [first, second] = [g.require('slow-1', 'code', null), g.require('slow-1', 'code', null)];
  assert.equal(
    await code(second),
    'TURNSTILE_FAILED',
    'the second user of the same token is refused while the first verifies',
  );
  release();
  assert.equal(await code(first), null);
  assert.equal(await code(g.require('slow-1', 'code', null)), 'TURNSTILE_FAILED', 'and afterwards');
  down = true;
  assert.equal(await code(g.require('retry-1', 'code', null)), 'TURNSTILE_UNAVAILABLE');
  down = false;
  assert.equal(await code(g.require('retry-1', 'code', null)), null, 'the token was not spent by the outage');
  // The ledger forgets a token after its lifetime (Turnstile itself rejects it by then).
  now.value += 11 * 60_000;
  assert.equal(await code(g.require('slow-1', 'code', null)), null);
});

test('the flag parser: off by default, and an enabled gate needs a site key and a secret', () => {
  assert.equal(webPublicFromEnv({}).turnstile, null);
  assert.equal(webPublicFromEnv({ TURNSTILE_ENABLED: 'false', TURNSTILE_SITE_KEY: '0x4AAAA' }).turnstile, null);
  assert.deepEqual(
    webPublicFromEnv({
      TURNSTILE_ENABLED: 'true',
      TURNSTILE_SITE_KEY: '0x4AAAAAAA',
      TURNSTILE_SECRET: 'longenoughsecret',
    }).turnstile,
    {
      siteKey: '0x4AAAAAAA',
      secret: 'longenoughsecret',
    },
  );
  for (const env of [
    { TURNSTILE_ENABLED: 'true' },
    { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: '0x4AAAAAAA' },
    { TURNSTILE_ENABLED: 'true', TURNSTILE_SECRET: 'longenoughsecret' },
    { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'bad key', TURNSTILE_SECRET: 'longenoughsecret' },
    { TURNSTILE_ENABLED: 'true', TURNSTILE_SITE_KEY: '0x4AAAAAAA', TURNSTILE_SECRET: 'short' },
  ])
    assert.throws(
      () => webPublicFromEnv(env),
      (error) => error instanceof DomainError,
    );
});
