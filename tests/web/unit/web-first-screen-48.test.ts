// Part 48 (weight and round trips): the bare address serves the player with no redirect, hashed build files are cached at the edge
// (and only those), and the player stylesheet is derived from the one source without the console's styles.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import edge, { type WebEdgeCache, type WebEdgeEnvironment } from '../../../workers/web-cloudflare/edge.ts';
import { buildWebPlayer } from '../../../scripts/build-web-player.ts';
import { playerCss, playerSelector, playerUsage } from '../../../scripts/player-css.ts';

const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const origin = 'https://fakebubble.example';

function setup(extra: Record<string, string> = {}) {
  const css = 'body{color:red}';
  const files: Record<string, string> = {
    'index.html': '<!doctype html><script type="module" src="/assets/main-ABCD1234.js"></script>',
    'assets/main-ABCD1234.js': 'export const main = 1;',
    [`assets/static-${hash(css)}.css`]: css,
    'favicon.ico': 'icon',
    'player-manifest.json': '',
    ...extra,
  };
  files['player-manifest.json'] = JSON.stringify({
    version: 1,
    files: Object.fromEntries(
      Object.entries(files)
        .filter(([n]) => n !== 'player-manifest.json')
        .map(([n, c]) => [n, hash(c)]),
    ),
  });
  const reads: string[] = [];
  const env: WebEdgeEnvironment = {
    ORIGIN: origin,
    BUSINESS_OBJECT_ID: 'a'.repeat(64),
    ASSET_MANIFEST_SHA256: hash(files['player-manifest.json']!),
    ASSETS: {
      async fetch(request) {
        const name = new URL(request.url).pathname.slice(1);
        reads.push(name);
        return new Response(files[name] ?? null, { status: files[name] === undefined ? 404 : 200 });
      },
    },
    BUSINESS: { idFromString: (id) => id, get: () => ({ fetch: async () => new Response('{}') }) },
  };
  return { files, env, reads, css: `assets/static-${hash(css)}.css` };
}
function fakeCache() {
  const store = new Map<string, Response>();
  const puts: string[] = [];
  const cache: WebEdgeCache & { failMatch?: boolean } = {
    async match(request) {
      if (cache.failMatch) throw new Error('cache down');
      return store.get(request.url)?.clone();
    },
    async put(request, response) {
      puts.push(request.url);
      store.set(request.url, response);
    },
  };
  return { cache, puts, store };
}
async function withCache<T>(cache: WebEdgeCache | undefined, run: (waits: Promise<unknown>[]) => Promise<T>) {
  const global = globalThis as { caches?: unknown };
  const before = global.caches;
  global.caches = cache ? { default: cache } : undefined;
  const waits: Promise<unknown>[] = [];
  try {
    return await run(waits);
  } finally {
    global.caches = before;
  }
}
const get = (f: ReturnType<typeof setup>, path: string, waits: Promise<unknown>[]) =>
  edge.fetch(new Request(origin + path), f.env, { waitUntil: (p) => void waits.push(p) });

test('the bare address serves the player at once; ?mode=provider and ?mode=provider-admin are unchanged; bad modes are still 404', async () => {
  const f = setup();
  await withCache(undefined, async (waits) => {
    for (const path of ['/', '/index.html', '/?mode=provider', '/?mode=provider-admin']) {
      const response = await get(f, path, waits);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('location'), null, `${path} does not redirect`);
      assert.equal(response.headers.get('cache-control'), 'no-store', 'the HTML stays no-store');
      assert.equal(await response.text(), f.files['index.html']);
    }
    for (const path of ['/?mode=preview', '/?mode=provider&mode=provider-admin', '/?mode=local-3'])
      assert.equal((await get(f, path, waits)).status, 404, path);
  });
});

test('hashed immutable build files are cached at the edge: one verified read, then hits; nothing else is ever cached', async () => {
  const f = setup();
  const { cache, puts } = fakeCache();
  await withCache(cache, async (waits) => {
    const first = await get(f, '/assets/main-ABCD1234.js', waits);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(first.headers.get('x-edge-asset-cache'), null, 'a miss');
    assert.equal(await first.text(), f.files['assets/main-ABCD1234.js']);
    await Promise.all(waits);
    assert.equal(puts.length, 1);
    // the key carries the manifest digest and the Turnstile switch: another deploy never reads this entry
    assert.ok(puts[0]!.includes(f.env.ASSET_MANIFEST_SHA256) && puts[0]!.endsWith('/false/assets/main-ABCD1234.js'));
    const readsAfterFirst = f.reads.length;
    const second = await get(f, '/assets/main-ABCD1234.js', waits);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-edge-asset-cache'), 'hit');
    assert.equal(await second.text(), f.files['assets/main-ABCD1234.js']);
    assert.equal(f.reads.length, readsAfterFirst, 'a hit reads no asset and verifies nothing again');
    // the security headers of every response are still set on a hit
    assert.equal(second.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(second.headers.get('strict-transport-security'), 'max-age=31536000');
    // the content-addressed stylesheet is cached the same way
    await get(f, `/${f.css}`, waits);
    await Promise.all(waits);
    assert.equal(puts.length, 2);
    // never cached: the HTML, the favicon (not content-addressed), a path with a query, an unknown or non-hashed name
    for (const path of [
      '/',
      '/?mode=provider',
      '/favicon.ico',
      '/assets/main-ABCD1234.js?x=1',
      '/assets/other.js',
      '/assets/main-abcd1234.js',
    ])
      await get(f, path, waits);
    await Promise.all(waits);
    assert.equal(puts.length, 2, 'only the two hashed files were put');
  });
});

test('a failing or missing Cache API changes nothing: the verified reader answers', async () => {
  const f = setup();
  const { cache } = fakeCache();
  cache.failMatch = true;
  await withCache(cache, async (waits) => {
    const response = await get(f, '/assets/main-ABCD1234.js', waits);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), f.files['assets/main-ABCD1234.js']);
  });
  await withCache(undefined, async (waits) => {
    assert.equal((await get(f, '/assets/main-ABCD1234.js', waits)).status, 200);
  });
});

test('a tampered entry or one that lost its immutable header is not trusted', async () => {
  const f = setup();
  const { cache, store } = fakeCache();
  await withCache(cache, async (waits) => {
    await get(f, '/assets/main-ABCD1234.js', waits);
    await Promise.all(waits);
    const [key] = [...store.keys()];
    store.set(key!, new Response('poisoned', { headers: { 'cache-control': 'no-store' } }));
    const response = await get(f, '/assets/main-ABCD1234.js', waits);
    assert.equal(await response.text(), f.files['assets/main-ABCD1234.js'], 'the verified reader answered');
  });
});

test('player CSS: rules for the console go, rules for the page stay, order and shared rules are untouched', () => {
  const css = `
    :root{--a:1}
    body{margin:0}
    /* a comment { with a brace */
    .card-slot{color:red}
    .account-admin-page .row{color:blue}
    .card-slot,.admin-shell .x{color:green}
    @media (max-width:600px){.card-slot{width:1px}.admin-nav{display:none}}
    @media (min-width:900px){.admin-only{display:block}}
    .share-btn{background:url("data:image/svg+xml,%3Csvg%3E{}%3C/svg%3E")}
    @keyframes spin{to{opacity:0}}
    @keyframes gone{to{opacity:1}}
    .card-slot{animation:spin 1s}
    .bl-row--${'$'}{x}{}
  `;
  const out = playerCss(css, 'class="card-slot share-btn"; `bl-row--${state}`');
  assert.match(out, /:root\{--a:1\}/);
  assert.match(out, /body\{margin:0\}/);
  assert.match(out, /\.card-slot\{color:red\}/);
  assert.doesNotMatch(out, /account-admin-page/);
  assert.match(
    out,
    /\.card-slot,\.admin-shell \.x\{color:green\}/,
    "a selector list stays whole when one selector is the page's",
  );
  assert.match(out, /@media \(max-width:600px\)\{[\s\S]*\.card-slot\{width:1px\}/);
  assert.doesNotMatch(out, /admin-nav|admin-only/);
  assert.doesNotMatch(out, /@media \(min-width:900px\)/, 'a media block with nothing left goes');
  assert.match(out, /share-btn\{background:url\("data:image\/svg\+xml,%3Csvg%3E\{\}%3C\/svg%3E"\)\}/);
  assert.match(out, /@keyframes spin/);
  assert.doesNotMatch(out, /@keyframes gone/);
  const used = playerUsage('card-slot');
  assert.equal(playerSelector('.card-slot:hover', used), true);
  assert.equal(playerSelector('.card-slot .admin-x', used), false);
  assert.equal(playerSelector('body > p', used), true, 'no class or id: kept');
});

test('the player build: player pages load the player stylesheet only; the console mode finds the whole one; no font file exists', () => {
  const output = mkdtempSync(join(tmpdir(), 'player-48-'));
  try {
    buildWebPlayer({ root: process.cwd(), output });
    const manifest = JSON.parse(readFileSync(join(output, 'player-manifest.json'), 'utf8')) as {
      files: Record<string, string>;
    };
    const page = readFileSync(join(output, 'index.html'), 'utf8');
    const sheets = [...page.matchAll(/<link rel="stylesheet" href="(\/assets\/static-[a-f0-9]{64}\.css)"/g)].map(
      (m) => m[1]!,
    );
    assert.equal(sheets.length, 1, 'the page links exactly one stylesheet');
    const adminHref = /<meta name="admin-css" content="(\/assets\/static-[a-f0-9]{64}\.css)">/.exec(page)?.[1];
    assert.ok(adminHref && adminHref !== sheets[0], 'the console stylesheet is only named in a <meta>, never linked');
    const player = readFileSync(join(output, sheets[0]!.slice(1)), 'utf8');
    const whole = readFileSync(join(output, adminHref!.slice(1)), 'utf8');
    const source = readFileSync('apps/player-web/src/styles/main.css', 'utf8');
    assert.equal(whole, source, 'the console gets the source exactly, in its original order');
    for (const admin of [
      '.account-admin-page',
      '.admin-shell',
      '.admin-nav',
      '#admin-cocreation',
      '.wb-card',
      '.invite-admin-page',
    ])
      assert.equal(player.includes(admin), false, `${admin} is not in the player stylesheet`);
    for (const used of [
      '.card-slot',
      '.page-shell',
      '.vs-sheet',
      '.sk-slot',
      '.share-page',
      '.legal-doc',
      '.cc-sheet',
      '.signed-out-page',
    ])
      assert.equal(player.includes(used), true, `${used} is in the player stylesheet`);
    assert.ok(
      Buffer.byteLength(player) < 200_000 && Buffer.byteLength(player) < Buffer.byteLength(whole) / 3,
      'the player stylesheet is small',
    );
    // the legal pages use the player stylesheet
    assert.ok(readFileSync(join(output, 'privacy.html'), 'utf8').includes(sheets[0]!));
    // WOFF2: the player ships no font at all (the site has no @font-face), so the browser has nothing to decode
    assert.equal(
      Object.keys(manifest.files).some((name) => /\.woff2?$|\.ttf$|\.otf$/.test(name)),
      false,
    );
    assert.equal(/@font-face/.test(player + whole), false);
    // the skeleton in the page uses classes the player stylesheet has
    for (const name of ['sk-slot', 'sk-left', 'is-skeleton', 'card-face'])
      assert.ok(page.includes(name) && player.includes(`.${name}`), name);
    assert.ok(readdirSync(join(output, 'assets')).some((name) => name.startsWith('main-')));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
