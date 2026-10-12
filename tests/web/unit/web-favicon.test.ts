import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CloudWebAssets } from '../../../apps/server/cloudflare/web-assets.ts';
import { buildWebPlayer } from '../../../scripts/build-web-player.ts';
import { serveLocalStatic } from '../../../apps/server/platform/web-local-static.ts';

const repo = join(import.meta.dirname, '../../..');
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

test('the real player build ships hashed svg/png favicons linked from index.html plus a root /favicon.ico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-favicon-'));
  const output = join(dir, 'dist');
  try {
    buildWebPlayer({ root: repo, output });
    const manifest = JSON.parse(readFileSync(join(output, 'player-manifest.json'), 'utf8')).files as Record<
      string,
      string
    >;
    const html = readFileSync(join(output, 'index.html'), 'utf8');
    const svg = Object.keys(manifest).find((name) => /^assets\/static-[a-f0-9]{64}\.svg$/.test(name))!;
    const png = Object.keys(manifest).find((name) => /^assets\/static-[a-f0-9]{64}\.png$/.test(name))!;
    assert.ok(svg && png && 'favicon.ico' in manifest);
    assert.match(html, new RegExp(`<link rel="icon" type="image/svg\\+xml" href="/${svg}">`));
    assert.match(html, new RegExp(`<link rel="icon" type="image/png"[^>]*href="/${png}">`));
    assert.doesNotMatch(html, /apps\/player-web\/src\/assets/);
    assert.equal(manifest['favicon.ico'], sha(readFileSync(join(output, 'favicon.ico'))));
    assert.deepEqual([...readFileSync(join(output, 'favicon.ico')).subarray(0, 4)], [0, 0, 1, 0]);

    const server = createServer((req, res) => {
      if (!serveLocalStatic(req, res, output)) res.writeHead(418).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const get = (path: string, method = 'GET') => fetch(`http://127.0.0.1:${address.port}${path}`, { method });
      const ico = await get('/favicon.ico');
      assert.equal(ico.status, 200);
      assert.equal(ico.headers.get('content-type'), 'image/x-icon');
      assert.equal(ico.headers.get('cache-control'), 'public, max-age=86400');
      assert.equal(sha(new Uint8Array(await ico.arrayBuffer())), manifest['favicon.ico']);
      assert.equal((await get('/favicon.ico', 'HEAD')).status, 200);
      for (const name of [svg, png])
        assert.equal((await get('/' + name)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
      assert.equal((await get('/favicon.png')).status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }

    // Cloud edge reader: same manifest, same bytes, same cache policy.
    const manifestBytes = readFileSync(join(output, 'player-manifest.json'));
    const binding = {
      fetch: async (request: Request) => {
        const name = new URL(request.url).pathname.slice(1);
        return new Response(readFileSync(join(output, name)));
      },
    };
    const assets = new CloudWebAssets(binding, sha(manifestBytes));
    const cloud = await assets.fetch(new Request('https://fixture.invalid/favicon.ico'));
    assert.equal(cloud.status, 200);
    assert.equal(cloud.headers.get('content-type'), 'image/x-icon');
    assert.equal(cloud.headers.get('cache-control'), 'public, max-age=86400');
    assert.equal(sha(new Uint8Array(await cloud.arrayBuffer())), manifest['favicon.ico']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
