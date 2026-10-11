import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import edge from '../../../workers/web-cloudflare/edge.ts';
import { playerCsp, TURNSTILE_ORIGIN } from '../../../apps/server/cloudflare/web-assets.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
/** The Content-Security-Policy the edge sent before Part 17, byte for byte: the default must not move. */
const BEFORE_PART_17 =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

const files: Record<string, string> = {
  'index.html': '<!doctype html><title>player</title>',
  'privacy.html': '<!doctype html><title>隐私政策</title>',
  'terms.html': '<!doctype html><title>用户协议</title>',
};
const manifest = JSON.stringify({
  version: 1,
  files: Object.fromEntries(Object.entries(files).map(([name, body]) => [name, sha(body)])),
});
function env(extra: Record<string, string> = {}) {
  return {
    ORIGIN: 'https://play.example.com',
    BUSINESS_OBJECT_ID: '0'.repeat(64),
    ASSET_MANIFEST_SHA256: sha(manifest),
    ASSETS: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (path === '/player-manifest.json') return new Response(manifest);
        const body = files[path.slice(1)];
        return body === undefined ? new Response(null, { status: 404 }) : new Response(body);
      },
    },
    BUSINESS: { idFromString: (id: string) => id, get: () => ({ fetch: async () => new Response('{}') }) },
    ...extra,
  };
}
const get = (path: string, e: ReturnType<typeof env>) => edge.fetch(new Request('https://play.example.com' + path), e);

test('the default CSP is byte-identical to before Part 17 and Turnstile adds exactly its own host', async () => {
  assert.equal(playerCsp(false), BEFORE_PART_17);
  const response = await get('/?mode=provider', env());
  // `/` first redirects to ?mode=provider; follow it the way a browser would.
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-security-policy'), BEFORE_PART_17);
  const on = playerCsp(true);
  assert.notEqual(on, BEFORE_PART_17);
  // Only the three directives Turnstile documents: script, frame and connect - no wildcard, no unsafe-*, nothing else changes.
  assert.equal(
    on,
    BEFORE_PART_17.replace("script-src 'self'", `script-src 'self' ${TURNSTILE_ORIGIN}`).replace(
      "connect-src 'self'",
      `connect-src 'self' ${TURNSTILE_ORIGIN}; frame-src ${TURNSTILE_ORIGIN}`,
    ),
  );
  assert.doesNotMatch(on, /unsafe|\*/);
  const sent = await get('/?mode=provider', env({ TURNSTILE_ENABLED: 'true' }));
  assert.equal(sent.headers.get('content-security-policy'), on);
  assert.equal(
    (await get('/?mode=provider', env({ TURNSTILE_ENABLED: 'false' }))).headers.get('content-security-policy'),
    BEFORE_PART_17,
  );
});

test('the legal pages are hidden until LEGAL_PAGES_ENABLED, then served as static pinned bytes', async () => {
  for (const path of ['/privacy.html', '/terms.html']) {
    assert.equal((await get(path, env())).status, 404, `${path} off by default`);
    assert.equal((await get(path, env({ LEGAL_PAGES_ENABLED: 'false' }))).status, 404);
    const page = await get(path, env({ LEGAL_PAGES_ENABLED: 'true' }));
    assert.equal(page.status, 200);
    assert.equal(await page.text(), files[path.slice(1)]);
    assert.match(page.headers.get('content-type')!, /text\/html/);
    assert.equal(page.headers.get('content-security-policy'), BEFORE_PART_17);
  }
  // Tampering with the served bytes is still caught by the manifest pin.
  files['terms.html'] = 'changed';
  assert.equal((await get('/terms.html', env({ LEGAL_PAGES_ENABLED: 'true' }))).status, 503);
  files['terms.html'] = '<!doctype html><title>用户协议</title>';
});
