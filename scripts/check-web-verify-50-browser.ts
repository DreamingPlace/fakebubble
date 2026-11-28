import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { realClock, throttle, turnstileRoutes } from './first-screen-48-support.ts';

/**
 * Part 50 in a REAL browser: verification starts at page load (the console fixture: the REAL local server and the built player, its
 * OFFLINE provider so nothing reaches a provider; Cloudflare's Turnstile is the real widget with its published always-pass TEST key, and
 * a route in front of the server refuses a new guest's bootstrap without a token exactly as the edge does, and puts the public site key
 * into the catalog answer as the edge does). Run under xvfb-run -a for a headed browser when a display is wanted; headless otherwise.
 *
 *   1. the bootstrap request leaves BEFORE the catalog answer arrives (the catalog is held back 1.5 s here), not after it;
 *   2. the session becomes ready with the Turnstile test key and no user action: no sheet, one refusal and one pass, and no /account
 *      read to learn the key (it came with the catalog); a guest is created only by the bootstrap that carried the token;
 *   3. the first tap on a card opens the chat with no verification sheet; a message sends, after the session (no write before it);
 *   4. the document carries the preload / preconnect hint for Cloudflare's script (Turnstile on) and the page asks for the script at once.
 *
 * usage: node scripts/check-web-verify-50-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Any = any;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
try {
  const pw = loadPlaywright();
  // two visits: the catalog answered at once (the key arrives with it), and held back 1.5 s (the session must not wait for it)
  for (const CATALOG_HELD_MS of [0, 1500]) {
    const phone = { ...pw.devices['Pixel 7'], viewport: { width: 412, height: 915 }, ignoreHTTPSErrors: true };
    const ctx = await f.browser.newContext(phone);
    await realClock(ctx); // (the real Turnstile compares the clock)
    await ctx.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
    );
    const stats = await turnstileRoutes(ctx, f.origin);
    // registered after the Turnstile routes, so it runs first and hands on after the delay (the catalog's answer is late on purpose)
    await ctx.route(`${f.origin}/api/web/provider/catalog`, async (route: Any) => {
      if (CATALOG_HELD_MS) await new Promise((r) => setTimeout(r, CATALOG_HELD_MS));
      await route.fallback();
    });
    const page = await ctx.newPage();
    await throttle(ctx, page, 'fast4g');
    const t0 = Date.now();
    const at: Record<string, number> = {};
    const order: string[] = [];
    const mark = (name: string) => {
      at[name] ??= Date.now() - t0;
    };
    page.on('request', (r: Any) => {
      const url = r.url() as string;
      if (url.endsWith('/provider/catalog')) mark('catalogRequest');
      if (url.endsWith('/provider/bootstrap')) {
        mark('bootstrapRequest');
        order.push('bootstrap');
      }
      if (url.endsWith('/provider/account')) order.push('account');
      if (url.includes('challenges.cloudflare.com/turnstile/v0/api.js')) mark('turnstileScript');
    });
    page.on('response', (r: Any) => {
      if ((r.url() as string).endsWith('/provider/catalog')) mark('catalogAnswer');
    });
    const response = await page.goto(`${f.origin}/`, { waitUntil: 'commit' });
    const link = (await response.headerValue('link')) ?? '';
    check(
      /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit>; rel=preload; as=script/.test(link) &&
        /<https:\/\/challenges\.cloudflare\.com>; rel=preconnect/.test(link),
      `the document hints Cloudflare's script and connection (Link: ${link})`,
    );
    await page.waitForSelector('.card-slot[data-ready="true"]', { timeout: 60_000 });
    at.ready = Date.now() - t0;
    // 1. the bootstrap left before the catalog answer arrived
    check(
      at.bootstrapRequest !== undefined && at.catalogAnswer !== undefined,
      'both the bootstrap and the catalog were requested',
    );
    if (CATALOG_HELD_MS)
      check(
        at.bootstrapRequest! < at.catalogAnswer!,
        `the bootstrap request left before the catalog answer arrived (bootstrap ${at.bootstrapRequest} ms, catalog answer ${at.catalogAnswer} ms)`,
      );
    check(
      at.bootstrapRequest! < 1000,
      `the bootstrap starts at page load, not after the catalog (${at.bootstrapRequest} ms)`,
    );
    check(
      at.turnstileScript !== undefined && at.turnstileScript < 500,
      `Cloudflare's script is requested at once (${at.turnstileScript} ms)`,
    );
    // 2. ready with no user action
    check(
      stats.refused === 1 && stats.withToken === 1,
      `one refusal without a token, one pass with the widget's token (${stats.refused}, ${stats.withToken})`,
    );
    check(
      !(await page.locator('.vs-root[data-open="true"]').count()),
      'the session became ready with the Turnstile test key and no user action: the sheet never opened',
    );
    const firstAccount = order.indexOf('account');
    const secondBootstrap = order.lastIndexOf('bootstrap');
    if (!CATALOG_HELD_MS)
      check(
        firstAccount === -1 || firstAccount > secondBootstrap,
        `the site key came with the catalog: no /account read before the token-carrying bootstrap (${order.join(' > ')})`,
      );
    check(stats.writes.length === 0, 'no write of any kind before the player acts');
    // 3. the first tap
    await page.waitForFunction(() => !document.querySelector('.is-skeleton'), null, { timeout: 5000 });
    await page.waitForTimeout(700);
    await page.locator('.card-slot.is-active .card-face').click({ position: { x: 60, y: 200 }, force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 8000 });
    check(
      !(await page.locator('.vs-root[data-open="true"]').count()),
      'the first tap on a card opens the chat with no verification sheet',
    );
    await page.locator('.card-slot.is-chat textarea').fill('一开页面就验证');
    await page.locator('.card-slot.is-chat .send-button').click();
    await page.locator('.card-slot.is-chat .text-bubble', { hasText: '一开页面就验证' }).waitFor({ timeout: 20_000 });
    check(
      // Part 36 NAMED EXCEPTION: a message is sent as a BUBBLE now (POST .../bubbles); it was POST .../operations.
      stats.writes.some((w) => /operations|bubbles/.test(w.call) && w.sessionsBefore >= 1),
      'the message was sent, after the session',
    );
    if (shots) await page.screenshot({ path: `${shots}/chat-verify-50-phone-${CATALOG_HELD_MS}.png` });
    console.log(JSON.stringify({ throttle: 'fast4g', catalogHeldMs: CATALOG_HELD_MS, ...at }));
    await ctx.close();
  }
} finally {
  await f.close();
}
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log('check:web:verify-50 ok');
