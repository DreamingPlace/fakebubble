// Part 50: verification at page load. Pure logic only (the real page is driven by scripts/check-web-verify-50-browser.ts):
// the public catalog may carry the PUBLIC site key (and nothing else new), (the session starting alongside the catalog read is driven in the browser check)
// the early challenge token is used once for a new guest and never for anything else, a returning visitor starts none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProviderApi, ProviderApiError } from '../../src/services/provider-api.ts';
import { parseWebPublicCatalog } from '../../../../packages/contracts/web-public-catalog.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { playerCsp, playerLink } from '../../../../apps/server/cloudflare/web-assets.ts';

const slots = [
  ...Array.from({ length: 15 }, (_, i) => ({ kind: 'preview' as const, slotId: `p${i + 1}`, label: '敬请期待' })),
];
const base = { characters: [], slots };

test('the public catalog may carry the public site key, strictly', () => {
  assert.equal(parseWebPublicCatalog(base).turnstileSiteKey, undefined);
  assert.equal(
    parseWebPublicCatalog({ ...base, turnstileSiteKey: '1x00000000000000000000AA' }).turnstileSiteKey,
    '1x00000000000000000000AA',
  );
  for (const bad of ['', 'a b', 'x'.repeat(65), 7, null, '<script>'])
    assert.throws(() => parseWebPublicCatalog({ ...base, turnstileSiteKey: bad }), /WEB_PUBLIC_CATALOG_INVALID/);
  assert.throws(() => parseWebPublicCatalog({ ...base, turnstileSecret: 'nope' }), /WEB_PUBLIC_CATALOG_INVALID/);
});

test("the document hints Cloudflare's script and connection only when Turnstile is on, and the CSP allows exactly that host", () => {
  assert.equal(playerLink(false), null);
  const link = playerLink(true)!;
  assert.match(
    link,
    /^<https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit>; rel=preload; as=script, <https:\/\/challenges\.cloudflare\.com>; rel=preconnect$/,
  );
  assert.match(playerCsp(true), /script-src 'self' https:\/\/challenges\.cloudflare\.com/);
  assert.doesNotMatch(playerCsp(false), /cloudflare/);
});

const refuse = () => Response.json({ error: { code: 'TURNSTILE_REQUIRED' } }, { status: 403 });

test("the early token is spent once on a new guest's bootstrap; no /account read; a returning visitor starts no challenge", async () => {
  const seen: string[] = [];
  let tokens = 0;
  const api = new ProviderApi(async (input, init) => {
    const path = String(input);
    const token = (init?.headers as Record<string, string> | undefined)?.['X-Turnstile-Token'];
    seen.push(`${path}${token ? ` [${token}]` : ''}`);
    return token ? Response.json(syntheticProviderBootstrap()) : refuse();
  });
  const asked: string[] = [];
  api.setHumanCheck(async (key, action, onRender) => {
    asked.push(`${key}/${action}`);
    onRender?.();
    return `token${++tokens}`;
  });
  const storage = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  };
  try {
    const started = api.primeHuman('1x00000000000000000000AA');
    await started;
    assert.deepEqual(asked, ['1x00000000000000000000AA/guest'], 'the challenge started before any bootstrap answer');
    await api.bootstrap();
    assert.deepEqual(seen, ['/api/web/provider/bootstrap', '/api/web/provider/bootstrap [token1]']);
    assert.deepEqual(asked.length, 1, 'no second challenge: the early token was used');
    // the session is now known on this device: a later visit starts no early challenge
    await api.primeHuman('1x00000000000000000000AA');
    assert.equal(asked.length, 1);
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('an early check that fails is reported as TURNSTILE_FAILED only when its token is needed', async () => {
  const api = new ProviderApi(async () => refuse());
  let n = 0;
  api.setHumanCheck(async () => {
    if (++n === 1) throw new Error('TURNSTILE_ERROR');
    throw new Error('TURNSTILE_ERROR');
  });
  await api.primeHuman('1x00000000000000000000AA'); // does not throw, nothing is shown yet
  await assert.rejects(api.bootstrap(), (e: unknown) => e instanceof ProviderApiError && e.code === 'TURNSTILE_FAILED');
});
