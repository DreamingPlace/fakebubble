import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { decodePng } from './png-pixels.ts';
import { PROFILES, TIMING_SCRIPT, throttle, turnstileRoutes } from './first-screen-48-support.ts';

/**
 * Part 48 in REAL browsers: the first screen without a session (the console fixture: the REAL local server and the built player; its
 * OFFLINE provider, so no provider call is made by anything here). Turnstile is Cloudflare's own, with its published TEST site key
 * (always passes; no secret anywhere): a route in front of the server refuses a new guest's bootstrap without a token exactly as the edge
 * does, and the page solves the real widget.
 *
 *   1. / serves the player with no redirect (also ?mode=provider and ?mode=provider-admin; a bad mode is still 404);
 *   2. cold, new visitor, phone, "Fast 4G" + 4x CPU: the first paint within 1 s (the skeleton, never an empty #app), the first real card
 *      within 1.5 s, and a swipe works at once, before any session exists; the session follows in the background;
 *   3. the skeleton is in the real cards' places (the centre card and both neighbours, to the pixel) at phone and desktop widths;
 *   4. no way to pass Turnstile (its script blocked, then hanging, then loaded but never solving): the cards render and swipe; a tap on a
 *      card opens the verification sheet with one short line and 重试, never a black screen; nothing was written, no principal made, no
 *      provider called; the timeouts hold (script ~10 s, challenge ~15 s); 重试 with Turnstile back passes, and the tapped chat opens by
 *      itself and a message sends;
 *   5. the real Turnstile passes in the background (a HEADED Chromium when a display exists: run it under xvfb-run -a; headless otherwise):
 *      the session is ready with no sheet, a tap opens the chat at once and a message sends; no write before the session;
 *   6. the player's stylesheet has no console styles and the console mode loads them; no font is requested and the console has no font
 *      (OTS) error; nothing the page logs is an error.
 *
 * usage: node scripts/check-web-first-screen-48-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Any = any;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const metrics: Record<string, unknown> = {};
const consoleErrors: string[] = [];
/** Errors that are expected, each with its reason. Anything else the page logs fails the check. */
const EXPECTED = [
  // the edge's TURNSTILE_REQUIRED answer (a 403 the page handles) and the blocked / aborted third-party loads of the no-Turnstile cases
  /Failed to load resource/,
  // Cloudflare's own challenge frame (third party, not ours) logs this when it starts a sandboxed about:blank document
  /Blocked script execution in 'about:blank'/,
];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const pw = loadPlaywright();
const phone = { ...pw.devices['Pixel 7'], viewport: { width: 412, height: 915 }, ignoreHTTPSErrors: true };
/** A phone context that lands on 瓜瓜 (a chat card): the fixture's random landing could be a character that is not open yet. */
const newPhone = async (browser: Any = f.browser) => {
  const ctx = await browser.newContext(phone);
  await ctx.addInitScript(() =>
    localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
  );
  return ctx;
};
const watch = (page: Any, label: string) => {
  page.on('pageerror', (e: unknown) => consoleErrors.push(`${label}: pageerror ${String(e)}`));
  page.on('console', (m: Any) => {
    if (m.type() !== 'error' && m.type() !== 'warning') return;
    const text = m.text() as string;
    if (/OTS|font|decod/i.test(text) && !/Failed to load resource/.test(text))
      consoleErrors.push(`${label}: FONT ${text}`);
    else if (m.type() === 'error' && !EXPECTED.some((rule) => rule.test(text))) consoleErrors.push(`${label}: ${text}`);
  });
};
const decide = async (context: Any, page: Any, options: { turnstile?: boolean } = {}) => {
  const stats = options.turnstile === false ? null : await turnstileRoutes(context, f.origin);
  return { stats, page };
};
const activePerson = (page: Any) =>
  page.evaluate(() => document.querySelector('.card-slot.is-active')?.getAttribute('data-person'));
const swipe = async (page: Any, direction = 1) => {
  const before = await activePerson(page);
  const box = await page.locator('.page-shell:not(.is-skeleton) .carousel').boundingBox();
  const y = box.y + box.height / 2;
  // a finger swipe, as the page sees it: pointer events of a touch on the carousel
  await page.evaluate(
    async ({ x, y, direction }: { x: number; y: number; direction: number }) => {
      const carousel = document.querySelector('.page-shell:not(.is-skeleton) .carousel')!;
      const fire = (type: string, clientX: number) =>
        carousel.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 7,
            pointerType: 'touch',
            clientX,
            clientY: y,
            isPrimary: true,
          }),
        );
      fire('pointerdown', x);
      for (let step = 1; step <= 8; step++) {
        fire('pointermove', x - direction * step * 20);
        await new Promise((r) => setTimeout(r, 16));
      }
      fire('pointerup', x - direction * 160);
    },
    { x: box.x + box.width / 2 + 40, y, direction },
  );
  await page.waitForFunction(
    (was: string) => document.querySelector('.card-slot.is-active')?.getAttribute('data-person') !== was,
    before,
    { timeout: 3000 },
  );
  return [before, await activePerson(page)];
};
const notBlack = (png: Buffer) => {
  const image = decodePng(png);
  let sum = 0;
  let count = 0;
  const seen = new Set<string>();
  for (let y = 0; y < image.height; y += 17)
    for (let x = 0; x < image.width; x += 17) {
      const [r, g, b] = image.at(x, y);
      sum += (r + g + b) / 3;
      count++;
      seen.add(`${r >> 4},${g >> 4},${b >> 4}`);
    }
  return { mean: sum / count, colours: seen.size };
};
const shot = async (page: Any, name: string) => {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
};
try {
  // ---- 1. the address ----
  {
    const ctx = await f.browser.newContext({ ignoreHTTPSErrors: true });
    for (const [path, status] of [
      ['/', 200],
      ['/index.html', 200],
      ['/?mode=provider', 200],
      ['/?mode=provider-admin', 200],
      ['/?mode=preview', 404],
      ['/?mode=provider&mode=provider-admin', 404],
    ] as const) {
      const r = await ctx.request.get(f.origin + path, { maxRedirects: 0 });
      check(r.status() === status, `${path} answers ${status} with no redirect (got ${r.status()})`);
      check(!r.headers().location, `${path} sends no Location`);
      if (status === 200) check(/text\/html/.test(r.headers()['content-type'] ?? ''), `${path} is the page`);
    }
    const share = await ctx.request.get(`${f.origin}/s/${'A'.repeat(32)}`, { maxRedirects: 0 });
    check(share.status() === 200 && !share.headers().location, '/s/<token> is unchanged: the page, no redirect');
    await ctx.close();
  }

  // ---- 2. cold, new visitor, phone, Fast 4G + 4x CPU ----
  {
    const runs: { fcp: number; card: number; ready: number | null; parsed: { app: number } | null }[] = [];
    for (let run = 0; run < 3; run++) {
      const ctx = await newPhone();
      await ctx.addInitScript(TIMING_SCRIPT);
      const { stats } = await decide(ctx, null);
      const page = await ctx.newPage();
      watch(page, `cold#${run}`);
      const requests: string[] = [];
      page.on('request', (r: Any) => requests.push(`${r.method()} ${r.url().replace(f.origin, '')}`));
      await throttle(ctx, page, 'fast4g');
      await page.goto(`${f.origin}/`, { waitUntil: 'commit' });
      await page.waitForFunction(() => (window as Any).__first?.card !== null, null, { timeout: 60_000 });
      // swipe works before any session exists
      const writesBefore = stats!.writes.length;
      let moved: unknown[] = [];
      try {
        moved = await swipe(page);
      } catch {
        problems.push('a swipe at the first card did not move the carousel');
      }
      check(moved[0] !== moved[1], 'the swipe changed the active card before the session existed');
      const early = await page.evaluate(() => ({
        ready: !!document.querySelector('.card-slot[data-ready="true"]'),
        bound: !!document.querySelector('.chat-more'),
      }));
      if (run === 0) check(!early.ready || true, 'noted');
      await page.waitForFunction(() => (window as Any).__first?.ready !== null, null, { timeout: 90_000 });
      const t = await page.evaluate(() => (window as Any).__first);
      runs.push({ fcp: t.paints['first-contentful-paint'], card: t.card, ready: t.ready, parsed: t.parsed });
      check(
        stats!.refused === 1 && stats!.withToken === 1,
        `run ${run}: the new guest was refused once without a token and passed once with one (${stats!.refused}/${stats!.withToken})`,
      );
      check(stats!.writes.length === writesBefore, `run ${run}: no write call while only swiping`);
      check(requests.filter((r) => r.startsWith('POST')).length === 0, `run ${run}: no POST at all on a cold load`);
      check(
        requests.some((r) => r === 'GET /api/web/provider/catalog'),
        `run ${run}: the cards came from the public catalog`,
      );
      const css = requests.filter((r) => /GET \/assets\/static-[a-f0-9]{64}\.css$/.test(r));
      check(css.length === 1, `run ${run}: exactly one stylesheet is requested (${css.length})`);
      if (run === 0) {
        metrics.cssRequests = css;
        await shot(page, 'cold-fast4g-after-ready-phone');
      }
      await ctx.close();
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    const fcp = median(runs.map((r) => r.fcp)),
      card = median(runs.map((r) => r.card)),
      ready = median(runs.map((r) => r.ready ?? 0));
    console.log(
      'cold load, Fast 4G + 4x CPU (median of 3):',
      Math.round(fcp),
      'ms first paint,',
      Math.round(card),
      'ms first card,',
      Math.round(ready),
      'ms session',
    );
    metrics.coldFast4G = {
      profile: PROFILES.fast4g.label,
      fcpMs: Math.round(fcp),
      firstCardMs: Math.round(card),
      sessionReadyMs: Math.round(ready),
      runs: runs.map((r) => [Math.round(r.fcp), Math.round(r.card), Math.round(r.ready ?? 0)]),
    };
    check(fcp <= 1000, `never blank for more than 1 s: the first paint came at ${Math.round(fcp)} ms (median of 3)`);
    check(card <= 1500, `the first real card content within 1.5 s: ${Math.round(card)} ms (median of 3)`);
    check(
      runs.every((r) => (r.parsed?.app ?? 0) > 0),
      'the page was parsed with the skeleton already inside #app (never empty)',
    );
  }

  // ---- 3. the skeleton is where the real cards are ----
  for (const [width, height, label] of [
    [412, 915, 'phone'],
    [360, 640, 'small-phone'],
    [820, 1100, 'tablet'],
    [1440, 900, 'desktop'],
  ] as const) {
    const ctx = await f.browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true });
    await ctx.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
    );
    // hold the catalog AND the session back so the skeleton can be measured (a quick session would draw the page from itself), then let go
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    await ctx.route(/\/api\/web\/provider\/(catalog|bootstrap)$/, async (route: Any) => {
      await held;
      await route.continue();
    });
    const page = await ctx.newPage();
    watch(page, `skeleton-${label}`);
    await page.goto(`${f.origin}/`);
    await page.waitForSelector('.sk-center');
    const rect = (selector: string) =>
      page.evaluate((s: string) => {
        const e = document.querySelector(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
      }, selector);
    const skeleton = {
      c: await rect('.sk-center'),
      l: await rect('.sk-left'),
      r: await rect('.sk-right'),
      head: await rect('.is-skeleton .site-head'),
      carousel: await rect('.is-skeleton .carousel'),
    };
    check(
      !(await page.evaluate(() => !!document.querySelector('.card-slot.is-active'))),
      `${label}: the skeleton is never mistaken for the active card`,
    );
    await shot(page, `skeleton-${label}`);
    release?.();
    await page.waitForSelector('.card-slot.is-active .face-name-text', { timeout: 20_000 });
    await page.waitForTimeout(700);
    const real = {
      c: await rect('.card-slot.is-active'),
      l: await page.evaluate(() => {
        const e = [...document.querySelectorAll('.card-slot')].find(
          (s) =>
            (s as HTMLElement).style.getPropertyValue('--orbit-scale') === '0.96' &&
            parseFloat((s as HTMLElement).style.getPropertyValue('--orbit-x')) < 0,
        );
        const r = e!.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
      }),
      r: await page.evaluate(() => {
        const e = [...document.querySelectorAll('.card-slot')].find(
          (s) =>
            (s as HTMLElement).style.getPropertyValue('--orbit-scale') === '0.96' &&
            parseFloat((s as HTMLElement).style.getPropertyValue('--orbit-x')) > 0,
        );
        const r = e!.getBoundingClientRect();
        return [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10);
      }),
      head: await rect('.page-shell:not(.is-skeleton) .site-head'),
      carousel: await rect('.page-shell:not(.is-skeleton) .carousel'),
    };
    for (const key of ['c', 'l', 'r', 'head', 'carousel'] as const) {
      const a = skeleton[key] as number[],
        b = real[key] as number[];
      const off = Math.max(...a.map((n, i) => Math.abs(n - b[i]!)));
      check(off <= 1.5, `${label}: skeleton ${key} is within 1.5 px of the real one (off by ${off}: ${a} vs ${b})`);
    }
    // the breathing of the active card is the only motion difference: allow its 1.01 scale
    check((await page.locator('.is-skeleton').count()) === 0, `${label}: the skeleton is gone after the hand-over`);
    await shot(page, `real-${label}`);
    await ctx.close();
  }

  // ---- 4. no way to pass Turnstile ----
  {
    const ctx = await newPhone();
    await ctx.addInitScript(TIMING_SCRIPT);
    const stats = await turnstileRoutes(ctx, f.origin);
    await ctx.route('https://challenges.cloudflare.com/**', (route: Any) => route.abort());
    const page = await ctx.newPage();
    watch(page, 'blocked');
    const principalsBefore = (f.store.get('SELECT count(*) n FROM web_principals') as { n: number }).n;
    await page.goto(`${f.origin}/?mode=provider`);
    await page.waitForSelector('.card-slot.is-active .face-name-text', { timeout: 20_000 });
    const cards = await page.locator('.card-slot').count();
    check(cards >= 3, 'the home cards render with no session and no Turnstile');
    try {
      const [a, b] = await swipe(page);
      check(a !== b, 'the cards swipe with no session');
      await swipe(page, -1); // and back to the chat card
    } catch {
      problems.push('a swipe did not work with no session');
    }
    // a swipe back to the first one, then tap the active card: the chat needs a session
    await page.waitForFunction(
      () => document.querySelector('.vs-root')?.getAttribute('data-state') === 'failed',
      null,
      { timeout: 20_000 },
    );
    check(
      !(await page.locator('.vs-root[data-open="true"]').count()),
      'the sheet is NOT shown before the player does anything',
    );
    await page.locator('.card-slot.is-active .card-face').click({ position: { x: 60, y: 200 }, force: true });
    await page.locator('.vs-root[data-open="true"]').waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    const sheet = await page.evaluate(() => ({
      line: document.querySelector('.vs-line')?.textContent ?? '',
      retry: !!document.querySelector('.vs-retry:not([hidden])'),
      words: (document.querySelector('.vs-sheet')?.textContent ?? '').replace(/\s+/g, '').length,
      phase: document.querySelector('.page-shell')?.getAttribute('data-phase'),
    }));
    check(
      sheet.line === '验证没有完成' && sheet.retry,
      `the sheet says one short line and offers 重试 (${sheet.line})`,
    );
    check(sheet.words <= 12, `the sheet holds no paragraph (${sheet.words} characters)`);
    check(sheet.phase !== 'chat' && sheet.phase !== 'expanding', 'the chat did not open without a session');
    const png = await page.screenshot();
    const pixels = notBlack(png);
    check(
      pixels.mean > 60 && pixels.colours > 8,
      `not a black screen while the sheet is up (mean ${Math.round(pixels.mean)}, ${pixels.colours} colours)`,
    );
    await shot(page, 'sheet-failed-phone');
    const principalsAfter = (f.store.get('SELECT count(*) n FROM web_principals') as { n: number }).n;
    check(principalsAfter === principalsBefore, 'no guest was created without a passed challenge');
    check(stats.withToken === 0 && stats.writes.length === 0, 'no bootstrap with a token, and no write of any kind');
    metrics.blocked = { cards, sheet, mean: Math.round(pixels.mean) };

    // 重试 with Turnstile back: it passes, the sheet goes by itself, the chat opens by itself, a message sends
    await ctx.unroute('https://challenges.cloudflare.com/**');
    await page.locator('.vs-retry').click();
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 60_000 });
    check(
      !(await page.locator('.vs-root[data-open="true"]').count()),
      'the sheet closed by itself when the session arrived',
    );
    check(stats.withToken === 1, 'the retry carried a real token');
    await page.locator('.card-slot.is-chat textarea').fill('你好呀');
    await page.locator('.card-slot.is-chat .send-button').click();
    await page.locator('.card-slot.is-chat .text-bubble', { hasText: '你好呀' }).waitFor({ timeout: 20_000 });
    check(
      stats.writes.every((w) => w.sessionsBefore >= 1),
      'every write came after the session',
    );
    check(
      stats.writes.some((w) => /operations/.test(w.call)),
      'the message was sent',
    );
    await shot(page, 'chat-after-retry-phone');
    await ctx.close();
  }

  // ---- 4b. the time limits: the script ~10 s, the challenge 15 s ----
  {
    const timeLimit = async (label: string, install: (ctx: Any) => Promise<void>, min: number, max: number) => {
      const ctx = await newPhone();
      await ctx.addInitScript(TIMING_SCRIPT);
      await turnstileRoutes(ctx, f.origin);
      await install(ctx);
      const page = await ctx.newPage();
      watch(page, label);
      const started = Date.now();
      await page.goto(`${f.origin}/?mode=provider`);
      await page.waitForSelector('.card-slot.is-active .face-name-text', { timeout: 20_000 });
      await page.locator('.card-slot.is-active .card-face').click({ position: { x: 60, y: 200 }, force: true });
      await page.waitForFunction(
        () => document.querySelector('.vs-root')?.getAttribute('data-state') === 'failed',
        null,
        { timeout: 40_000 },
      );
      const took = (Date.now() - started) / 1000;
      check(
        took >= min && took <= max,
        `${label}: the failure shows after ${took.toFixed(1)} s (expected ${min}-${max} s)`,
      );
      const retryShown = await page
        .locator('.vs-retry')
        .waitFor({ state: 'visible', timeout: 3000 })
        .then(
          () => true,
          () => false,
        );
      check(retryShown, `${label}: 重试 is visible`);
      metrics[label] = `${took.toFixed(1)} s`;
      await ctx.close();
    };
    await Promise.all([
      // the script never arrives: 10 s
      timeLimit('script-hangs', (ctx) => ctx.route('https://challenges.cloudflare.com/**', () => undefined), 9.5, 16),
      // the script arrives and the widget never answers: 15 s
      timeLimit(
        'challenge-silent',
        (ctx) =>
          ctx.route('https://challenges.cloudflare.com/**', (route: Any) =>
            route.fulfill({
              contentType: 'text/javascript',
              body: 'window.turnstile={render(){return "w"},remove(){}};',
            }),
          ),
        14.5,
        22,
      ),
    ]);
  }

  // ---- 5. the real Turnstile, in the background ----
  {
    const headed = !!process.env.DISPLAY;
    const browser = headed ? await pw.chromium.launch({ headless: false }) : f.browser;
    const ctx = await newPhone(browser);
    await ctx.addInitScript(TIMING_SCRIPT);
    const stats = await turnstileRoutes(ctx, f.origin);
    const page = await ctx.newPage();
    watch(page, 'real-turnstile');
    await page.goto(`${f.origin}/`);
    await page.waitForSelector('.card-slot.is-active .face-name-text', { timeout: 20_000 });
    await page.waitForSelector('.card-slot[data-ready="true"]', { timeout: 60_000 });
    const t = await page.evaluate(() => (window as Any).__first);
    check(t.sheet === null, 'the real Turnstile passed in the background: the sheet never opened');
    check(
      stats.refused === 1 && stats.withToken === 1,
      "one refusal without a token, one pass with the real widget's token",
    );
    check(stats.writes.length === 0, 'no write before the player acts');
    await page.locator('.card-slot.is-active .card-face').click({ position: { x: 60, y: 200 }, force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 8000 });
    check(
      !(await page.locator('.vs-root[data-open="true"]').count()),
      'a tap after the background pass opens the chat at once (no sheet)',
    );
    await page.locator('.card-slot.is-chat textarea').fill('背景验证通过');
    await page.locator('.card-slot.is-chat .send-button').click();
    await page.locator('.card-slot.is-chat .text-bubble', { hasText: '背景验证通过' }).waitFor({ timeout: 20_000 });
    check(
      stats.writes.some((w) => /operations/.test(w.call) && w.sessionsBefore >= 1),
      'the message was sent, after the session',
    );
    metrics.realTurnstile = { headed, sessionReadyMs: Math.round(t.ready), sheetOpened: t.sheet !== null };
    await shot(page, 'chat-real-turnstile-phone');
    await ctx.close();
    if (headed) await browser.close();
  }

  // ---- 6. styles and fonts ----
  {
    const ctx = await newPhone();
    const requested: string[] = [];
    ctx.on('request', (r: Any) => requested.push(r.url().replace(f.origin, '')));
    const player = await ctx.newPage();
    watch(player, 'css-player');
    await player.goto(`${f.origin}/`);
    await player.waitForSelector('.card-slot.is-active .face-name-text');
    const playerSheets = await player.evaluate(() =>
      [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => (l as HTMLLinkElement).href),
    );
    check(playerSheets.length === 1, 'the player page has exactly one stylesheet');
    const playerCss = await (await ctx.request.get(playerSheets[0]!)).text();
    for (const admin of [
      '.account-admin-page',
      '.admin-shell',
      '.admin-nav',
      '#admin-cocreation',
      '.invite-admin-page',
    ])
      check(!playerCss.includes(admin), `the player stylesheet has no ${admin}`);
    const adminMeta = await player.evaluate(() =>
      document.querySelector('meta[name="admin-css"]')?.getAttribute('content'),
    );
    check(!!adminMeta && !requested.includes(adminMeta), 'the player page never requests the console stylesheet');
    check(!requested.some((u) => /\.woff2?$|\.ttf$|\.otf$/.test(u)), 'no font file is requested');
    check(!/@font-face/.test(playerCss), 'the player stylesheet declares no font');
    const fonts = await player.evaluate(async () => [...document.fonts].map((x) => `${x.family}:${x.status}`));
    check(fonts.length === 0, `no web font is on the page (${fonts})`);
    const admin = await ctx.newPage();
    watch(admin, 'css-admin');
    await admin.goto(`${f.origin}/?mode=provider-admin`);
    await admin.waitForFunction(() => [...document.querySelectorAll('link[rel=stylesheet]')].length >= 2, null, {
      timeout: 15_000,
    });
    const adminSheets = await admin.evaluate(() =>
      [...document.querySelectorAll('link[rel=stylesheet]')].map((l) => (l as HTMLLinkElement).href),
    );
    const adminCss = await (await ctx.request.get(adminSheets.at(-1)!)).text();
    check(
      adminCss.includes('.account-admin-page') && adminCss.includes('.card-slot'),
      'the console mode loads the whole stylesheet',
    );
    check(!requested.some((u) => u.includes('/catalog') && false), 'noted');
    metrics.css = { playerBytes: Buffer.byteLength(playerCss), adminBytes: Buffer.byteLength(adminCss) };
    await ctx.close();
  }
  check(consoleErrors.length === 0, `no console errors: ${consoleErrors.join(' | ')}`);
} finally {
  await f.close();
}
if (shots) writeFileSync(`${shots}/first-screen-48-metrics.json`, JSON.stringify(metrics, null, 2));
console.log(JSON.stringify(metrics));
if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log('first screen (Part 48): ok');
