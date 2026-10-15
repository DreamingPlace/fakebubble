import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { testModules } from '../../cloudflare/modules.ts';
import { SITEVERIFY_URL } from '../../../apps/server/identity/web-turnstile.ts';

// Part 17e: workerd rejects fetch(..., { redirect: 'error' }) before dispatch, which turned every production guest
// creation into TURNSTILE_UNAVAILABLE. Fake verifiers never reach fetch, so this executes the real call in workerd.
test('the real siteverify fetch runs in workerd and fails closed on non-200 answers', async (t) => {
  const seen: string[] = [];
  const mf = new Miniflare({
    modulesRoot: resolve('.'),
    compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    modules: testModules('tests/web/fixtures/cloudflare-turnstile-worker.ts'),
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      assert.equal(url.origin + url.pathname, 'https://stub.invalid/siteverify', 'only the test stub is reachable');
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get('secret'), 'secret');
      assert.equal(form.get('remoteip'), '203.0.113.7');
      const kind = url.searchParams.get('case')!;
      seen.push(kind);
      if (kind === 'ok') return Response.json({ success: true, hostname: 'example.test', action: 'guest' });
      if (kind === 'denied') return Response.json({ success: false, 'error-codes': ['invalid-input-response'] });
      if (kind === 'redirect')
        return new Response(null, { status: 302, headers: { location: 'https://untrusted.invalid/steal' } });
      return new Response('boom', { status: 500 });
    },
  });
  t.after(() => mf.dispose());
  const run = async (kind: string) =>
    (await (await mf.dispatchFetch('http://localhost/?case=' + kind)).json()) as { ok: boolean; code?: string };
  assert.equal(SITEVERIFY_URL, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.deepEqual(await run('ok'), { ok: true, production: SITEVERIFY_URL });
  assert.deepEqual(await run('denied'), { ok: false, code: 'TURNSTILE_FAILED' });
  assert.deepEqual(await run('redirect'), { ok: false, code: 'TURNSTILE_UNAVAILABLE' });
  assert.deepEqual(await run('server-error'), { ok: false, code: 'TURNSTILE_UNAVAILABLE' });
  assert.deepEqual(seen, ['ok', 'denied', 'redirect', 'server-error']);
});
