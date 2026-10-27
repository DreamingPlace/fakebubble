import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const root = new URL('../../../workers/apex-site/', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

test('apex cover verifies ownership without ads, scripts, or chat-service bindings', () => {
  const html = read('public/index.html');
  const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  assert.equal((html.match(/name="google-adsense-account"/g) ?? []).length, 1);
  assert.ok(head.includes('<meta name="google-adsense-account" content="ca-pub-2616924162927534">'));
  assert.match(html, /class="enter" href="https:\/\/paopao\.4th-generation\.fans\/"/);
  assert.doesNotMatch(html, /<script\b|<iframe\b|<form\b|http-equiv|adsbygoogle|googlesyndication|\son\w+=/i);
  const config = JSON.parse(read('wrangler.json'));
  assert.deepEqual(config, {
    name: 'fake-paopao-apex',
    compatibility_date: '2026-10-13',
    workers_dev: false,
    preview_urls: false,
    routes: [],
    assets: { directory: './public', not_found_handling: 'none' },
  });
  assert.deepEqual(readdirSync(new URL('public/', root)).sort(), [
    '_headers',
    'favicon.svg',
    'index.html',
    'style.css',
  ]);
  assert.equal(
    read('public/favicon.svg'),
    readFileSync(new URL('../../../apps/player-web/src/assets/favicon.svg', import.meta.url), 'utf8'),
  );
  assert.match(read('public/_headers'), /default-src 'none'; style-src 'self'; img-src 'self'/);
  assert.doesNotMatch(read('public/style.css'), /@import|url\(/);
});
