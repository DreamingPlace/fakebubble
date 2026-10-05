import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import edge, { WEB_CLOUD_COMPATIBILITY_FLAGS, type WebEdgeEnvironment } from '../../../workers/web-cloudflare/edge.ts';
import { trustedWebRequest } from '../../../apps/server/cloudflare/web-edge-request.ts';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const origin = 'https://fakebubble.example';

test('edge template keeps all assets behind the worker and disables every implicit public preview', () => {
  const config = JSON.parse(readFileSync('workers/web-cloudflare/deploy/edge.json.example', 'utf8'));
  assert.deepEqual(config.compatibility_flags, [...WEB_CLOUD_COMPATIBILITY_FLAGS]);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.deepEqual(config.routes, []);
  assert.equal(config.assets.run_worker_first, true);
  assert.equal(config.assets.html_handling, 'none');
  assert.equal(config.assets.not_found_handling, 'none');
  assert.equal(config.vars.ORIGIN, origin);
  assert.equal(config.durable_objects.bindings[0].script_name, 'fakebubble-business');
  assert.equal(config.services, undefined);
  assert.equal(config.r2_buckets, undefined);
});
function setup() {
  const files: Record<string, string> = {
    'index.html': '<!doctype html><script src="/app.js"></script>',
    'app.js': 'export const offline = true;',
    'portrait.webp': 'offline-image',
  };
  files['player-manifest.json'] = JSON.stringify({
    version: 1,
    files: Object.fromEntries(Object.entries(files).map(([name, content]) => [name, hash(content)])),
  });
  const requests: string[] = [],
    handled: { request: Request; peer: string }[] = [];
  const env: WebEdgeEnvironment = {
    ORIGIN: origin,
    BUSINESS_OBJECT_ID: 'a'.repeat(64),
    ASSET_MANIFEST_SHA256: hash(files['player-manifest.json']!),
    ASSETS: {
      async fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        requests.push(name);
        return new Response(files[name] ?? null, { status: files[name] === undefined ? 404 : 200 });
      },
    },
    BUSINESS: {
      idFromString(id) {
        assert.equal(id, 'a'.repeat(64));
        return id;
      },
      get() {
        return {
          async fetch(incoming) {
            const { request, peer } = trustedWebRequest(incoming);
            handled.push({ request, peer });
            return new Response('data: offline\n\n', {
              headers: {
                'content-type': 'text/event-stream',
                'set-cookie': '__Host-paopao=offline; Path=/; Secure; HttpOnly; SameSite=Lax',
              },
            });
          },
        };
      },
    },
  };
  const call = (path: string, init?: RequestInit) => edge.fetch(new Request(origin + path, init), env);
  return { files, requests, handled, env, call };
}

test('public edge serves only pinned player bytes, no synthetic entry, manifest, secrets or SPA fallback', async () => {
  const f = setup();
  assert.ok(WEB_CLOUD_COMPATIBILITY_FLAGS.includes('enable_request_signal'));
  for (const method of ['GET', 'HEAD']) {
    const response = await f.call('/', { method });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?mode=provider');
  }
  const page = await f.call('/?mode=provider');
  assert.equal(page.status, 200);
  assert.equal(await page.text(), f.files['index.html']);
  assert.match(page.headers.get('content-security-policy')!, /script-src 'self'/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await f.call('/?mode=provider-admin')).status, 200);
  const head = await f.call('/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await f.call('/portrait.webp')).headers.get('content-type'), 'image/webp');
  for (const path of [
    '/?mode=preview',
    '/?mode=local-3',
    '/?mode=provider&mode=provider-admin',
    '/player-manifest.json',
    '/.env',
    '/runtime/private.sqlite',
    '/api/web/local/bootstrap',
    '/missing-route',
    '/%2eenv',
  ])
    assert.equal((await f.call(path)).status, 404, path);
  assert.equal((await f.call('/app.js', { headers: { range: 'bytes=0-3' } })).status, 404);
  assert.deepEqual(f.handled, []);
  f.files['app.js'] = 'tampered';
  assert.equal((await f.call('/app.js')).status, 503);
});

test('public edge strips internal/forwarded hints, pins the private DO and streams its cookie response', async () => {
  const f = setup();
  const response = await f.call('/api/web/provider/events', {
    headers: {
      'cf-connecting-ip': '2001:db8::1',
      'x-internal-admin': '1',
      'x-internal-web-peer': '198.51.100.99',
      'x-fixture-host': 'evil.invalid',
      'x-forwarded-for': '198.51.100.1',
      authorization: 'Bearer offline',
      cookie: '__Host-paopao=offline',
      origin,
    },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'data: offline\n\n');
  assert.match(response.headers.get('set-cookie')!, /^__Host-paopao=/);
  assert.equal(f.handled[0]!.peer, '2001:db8::1');
  const forwarded = f.handled[0]!.request;
  for (const key of [
    'cf-connecting-ip',
    'x-internal-admin',
    'x-internal-web-peer',
    'x-fixture-host',
    'x-forwarded-for',
    'authorization',
  ])
    assert.equal(forwarded.headers.has(key), false);
  assert.equal(forwarded.headers.get('cookie'), '__Host-paopao=offline');
  assert.equal(f.requests.length, 0);
  assert.equal((await f.call('/api/web/provider/bootstrap')).status, 503);
  assert.equal((await edge.fetch(new Request('https://other.workers.dev/?mode=provider'), f.env)).status, 404);
  assert.equal((await f.call('/', { headers: { host: 'evil.invalid' } })).status, 404);
});

test('public edge fails closed on manifest substitution, encoding, oversized assets and unavailable private service', async () => {
  for (const mutation of ['manifest', 'encoding', 'size', 'rpc']) {
    const f = setup();
    if (mutation === 'manifest') f.files['player-manifest.json'] += ' ';
    if (mutation === 'encoding')
      f.env.ASSETS = {
        async fetch() {
          return new Response('x', { headers: { 'content-encoding': 'gzip' } });
        },
      };
    if (mutation === 'size') f.files['app.js'] = 'x'.repeat(2_000_001);
    if (mutation === 'rpc')
      f.env.BUSINESS.get = () => ({
        fetch: async () => {
          throw Error('private synthetic secret');
        },
      });
    const response = await f.call(
      mutation === 'rpc' ? '/api/web/provider/bootstrap' : mutation === 'size' ? '/app.js' : '/?mode=provider',
      { headers: { 'cf-connecting-ip': '192.0.2.1' } },
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes('secret'), false);
  }
});
