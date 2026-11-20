import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { TEST_NAMES, openNamedHome } from './part-44-names.ts';

/**
 * Part 46 (the Deploy W hotfix) in REAL browsers, Android Chrome emulation (412x915 @3.5, isMobile, hasTouch) and iOS WebKit:
 *  1. the home cards' names do not twitch: for EVERY card (Part 44's long and mixed test names included) --name-size, the name's box and
 *     the text's width are sampled every 100 ms for 5 s with no input at all, and they must not change; the fit writes --name-size a
 *     bounded number of times after load and fonts; no ResizeObserver-loop error is raised.
 *  (the share button by touch is checked in check-web-share-45-browser.ts)
 *
 * usage: node scripts/check-web-part-46-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * WebKit: set PLAYWRIGHT_BROWSERS_PATH to a directory that has it (`playwright install webkit`).
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const f = await startConsoleFixture({ provider: { draftMs: 40, reviewMs: 40 }, speech: false });
const pw = loadPlaywright();
const webkit = await pw.webkit.launch();
try {
  const phones = [
    [
      'android',
      f.browser,
      {
        ...pw.devices['Pixel 7'],
        viewport: { width: 412, height: 915 },
        deviceScaleFactor: 3.5,
        userAgent: ANDROID_UA,
        isMobile: true,
        hasTouch: true,
      },
    ],
    ['ios', webkit, { ...pw.devices['iPhone 14'] }],
  ] as const;
  for (const [label, browser, device] of phones) {
    const ctx = await browser.newContext({
      ...device,
      ignoreHTTPSErrors: true,
      // the review recording: 5 s of idle home cards on Android
      ...(shots && label === 'android'
        ? { recordVideo: { dir: `${shots}/video`, size: { width: 412, height: 915 } } }
        : {}),
    });
    await ctx.addCookies(await f.context.cookies());
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(`${label}: pageerror ${String(e)}`));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      // (WebKit: Playwright's own screenshot style is refused by the page's CSP; that is the tool, not the page)
      if (
        m.type() === 'error' &&
        !/status of 4\d\d|Failed to load resource|Refused to apply a stylesheet/.test(m.text())
      )
        errors.push(`${label}: console ${m.text()}`);
    });
    // every write of a card's inline style, from the first byte of the page (the fit writes --name-size there)
    await page.addInitScript(() => {
      const writes = new Map<string, number>();
      const last = new Map<string, string>();
      (window as unknown as { __nameWrites: Map<string, number> }).__nameWrites = writes;
      const watch = () =>
        new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target as HTMLElement;
            if (!el.classList?.contains('card-slot')) continue;
            const key = String([...el.parentElement!.children].indexOf(el));
            const size = el.style.getPropertyValue('--name-size');
            if (last.get(key) === size) continue; // only a CHANGE of --name-size counts
            last.set(key, size);
            writes.set(key, (writes.get(key) ?? 0) + 1);
          }
        }).observe(document, { attributes: true, attributeFilter: ['style'], subtree: true });
      watch();
    });
    await openNamedHome(page, f.origin, TEST_NAMES);
    const before = await page.evaluate(() => [
      ...(window as unknown as { __nameWrites: Map<string, number> }).__nameWrites.values(),
    ]);
    // 5 s with no input at all: sample every card's --name-size, the name's box and the text's width every 100 ms
    const samples: string[][] = await page.evaluate(
      () =>
        new Promise<string[][]>((done) => {
          const out: string[][] = [];
          const read = () =>
            [...document.querySelectorAll<HTMLElement>('.card-slot')].map((slot) => {
              const box = slot.querySelector<HTMLElement>('.card-face:not(.face-reserve) .face-name');
              const text = slot.querySelector<HTMLElement>('.face-name-text');
              if (!box || !text) return 'none';
              // layout values (offset*), not rects: the front card breathes with a transform, which moves a rect without moving the name
              return [
                slot.style.getPropertyValue('--name-size'),
                getComputedStyle(box).fontSize,
                box.offsetWidth,
                box.offsetHeight,
                box.offsetLeft,
                box.offsetTop,
                text.offsetWidth,
                text.offsetHeight,
              ].join('|');
            });
          const timer = setInterval(() => out.push(read()), 100);
          setTimeout(() => {
            clearInterval(timer);
            done(out);
          }, 5000);
        }),
    );
    const after: number[] = await page.evaluate(() => [
      ...(window as unknown as { __nameWrites: Map<string, number> }).__nameWrites.values(),
    ]);
    const cards = samples[0]!.length;
    check(samples.length >= 45 && cards >= 15, `${label}: sampled ${samples.length} times, ${cards} cards`);
    let twitching = 0;
    for (let c = 0; c < cards; c++) {
      const seen = new Set(samples.map((s) => s[c]));
      if (seen.size > 1) {
        twitching++;
        check(
          false,
          `${label}: card ${c} moved while idle (${seen.size} different readings: ${[...seen].slice(0, 3).join(' ; ')})`,
        );
      }
    }
    console.log(`${label}: ${cards} cards, ${samples.length} samples, twitching cards: ${twitching}`);
    // the fit writes a bounded number of times after load and fonts, and none while idle
    const idleWrites =
      after.reduce((a: number, b: number) => a + b, 0) - before.reduce((a: number, b: number) => a + b, 0);
    check(idleWrites === 0, `${label}: ${idleWrites} --name-size changes while idle`);
    const most = Math.max(...before);
    console.log(`${label}: most --name-size changes on one card since load: ${most}`);
    check(most <= 4, `${label}: a card's --name-size changed ${most} times since load`);
    if (shots) await page.screenshot({ path: `${shots}/${label}-home.png` });
    const video = page.video?.();
    await ctx.close();
    if (shots && video) await video.saveAs(`${shots}/${label}-idle-5s.webm`).catch(() => undefined);
  }

  // ================= sideways swipes are the app's, never the browser's "back" =================
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
  for (const [label, browser, device] of [...phones, ['desktop', f.browser, desktop]] as const) {
    const ios = label === 'ios';
    const touch = label !== 'desktop';
    const ctx = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
    await ctx.addCookies(await f.context.cookies());
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(`${label} nav: pageerror ${String(e)}`));
    await openNamedHome(page, f.origin, TEST_NAMES);
    const activeIndex = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.avatar-nav button')].findIndex(
          (b) => b.getAttribute('aria-current') === 'true',
        ),
      );
    const facts = () =>
      page.evaluate(() => ({
        length: history.length,
        url: location.href,
        phase: document.querySelector('.page-shell')?.getAttribute('data-phase'),
      }));
    const start = await facts();
    const origin0 = start.url;
    // the browser is told to leave sideways overscroll alone, on the page and on every swiper
    const overscroll = await page.evaluate(() =>
      ['html', 'body', '.carousel', '.card-deck', '.avatar-nav'].map((q) => [
        q,
        getComputedStyle(document.querySelector(q)!).overscrollBehaviorX,
      ]),
    );
    for (const [q, v] of overscroll) check(v === 'none', `${label}: overscroll-behavior-x of ${q} is none (${v})`);
    // a swipe: a real touch on Chromium (CDP), pointer events on WebKit (it has no CDP); a horizontal wheel on the desktop
    const swipe = async (fromX: number, toX: number) => {
      const y = 450;
      if (!ios) {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: fromX, y }] });
        for (let i = 1; i <= 8; i++) {
          await cdp.send('Input.dispatchTouchEvent', {
            type: 'touchMove',
            touchPoints: [{ x: fromX + ((toX - fromX) * i) / 8, y }],
          });
          await wait(16);
        }
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.evaluate(
          ([a, b, yy]: number[]) => {
            const el = document.querySelector('.carousel')!;
            const fire = (type: string, x: number) =>
              el.dispatchEvent(
                new PointerEvent(type, {
                  pointerId: 7,
                  pointerType: 'touch',
                  isPrimary: true,
                  clientX: x,
                  clientY: yy,
                  bubbles: true,
                  cancelable: true,
                }),
              );
            fire('pointerdown', a!);
            for (let i = 1; i <= 8; i++) fire('pointermove', a! + ((b! - a!) * i) / 8);
            fire('pointerup', b!);
          },
          [fromX, toX, y],
        );
      }
      await wait(700);
    };
    if (!touch) {
      const before = await activeIndex();
      const prevented = await page.evaluate(async () => {
        const el = document.querySelector('.carousel')!;
        await new Promise((r) => setTimeout(r, 400));
        const e = new WheelEvent('wheel', { deltaX: 120, deltaY: 0, bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      });
      check(prevented, `${label}: a horizontal wheel that moves the cards is taken by the page (preventDefault)`);
      await wait(700);
      check((await activeIndex()) !== before, `${label}: the horizontal wheel moved the cards`);
      const vertical = await page.evaluate(async () => {
        await new Promise((r) => setTimeout(r, 400));
        const e = new WheelEvent('wheel', { deltaX: 0, deltaY: 120, bubbles: true, cancelable: true });
        document.querySelector('.carousel')!.dispatchEvent(e);
        return e.defaultPrevented;
      });
      check(!vertical, `${label}: a vertical wheel is left alone`);
      await page.mouse.move(720, 450);
      const before2 = await activeIndex();
      await page.mouse.wheel(400, 0);
      await wait(700);
      check((await activeIndex()) !== before2, `${label}: a real horizontal wheel moves the cards`);
    } else {
      const w = (await page.viewportSize()).width;
      const before = await activeIndex();
      await swipe(w - 8, 40); // starts inside the right gutter
      check(
        (await activeIndex()) === before,
        `${label}: a swipe that starts in the edge gutter does not start a swipe`,
      );
      await swipe(8, w - 40);
      check((await activeIndex()) === before, `${label}: nor from the left gutter`);
      const middle = await activeIndex();
      await swipe(w / 2 + 60, w / 2 - 120);
      check((await activeIndex()) !== middle, `${label}: a swipe from the middle moves the cards`);
    }
    const idle = await facts();
    check(
      idle.length === start.length,
      `${label}: no history entry without a user action (${start.length} -> ${idle.length})`,
    );
    // open the chat: one entry; the system back closes it and the page stays
    const open = async () => {
      if (touch) await page.locator('.card-slot.is-active .face-name').first().tap({ force: true });
      else await page.locator('.card-slot.is-active').first().click({ force: true });
      await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    };
    await open();
    const opened = await facts();
    check(
      opened.length === idle.length + 1,
      `${label}: opening the chat pushes ONE history entry (${idle.length} -> ${opened.length})`,
    );
    await page.evaluate(() => history.back());
    await page.locator('.page-shell[data-phase="browse"], .page-shell[data-phase="hover"]').waitFor({ timeout: 5_000 });
    const back = await facts();
    check(
      back.url === opened.url && new URL(back.url).origin === new URL(origin0).origin,
      `${label}: system back closed the chat and stayed on the site (${back.url})`,
    );
    // the in-app close takes its entry off again: three open/close cycles never stack entries
    for (let i = 0; i < 3; i++) {
      await open();
      await page
        .locator('.card-slot.is-active .back-button')
        .tap?.({ force: true })
        .catch(() => undefined);
      if (!touch)
        await page
          .locator('.card-slot.is-active .back-button')
          .click({ force: true })
          .catch(() => undefined);
      await page
        .locator('.page-shell[data-phase="browse"], .page-shell[data-phase="hover"]')
        .waitFor({ timeout: 5_000 });
      await wait(400);
    }
    const cycles = await facts();
    check(
      cycles.length <= opened.length,
      `${label}: three open/close cycles do not stack history entries (${opened.length} -> ${cycles.length})`,
    );
    page.removeAllListeners('pageerror'); // (the page it leaves for is about:blank)
    // with nothing open, back is the browser's own: it leaves the page for the entry before it (nothing of ours traps it)
    await page.evaluate(() => history.back()).catch(() => undefined); // (the page goes away under the call)
    await wait(1200);
    check(
      !page.url().startsWith(new URL(origin0).origin),
      `${label}: with nothing open, back leaves the page (no trap): ${page.url()}`,
    );
    await ctx.close();
  }
  check(errors.length === 0, `no page errors: ${errors.slice(0, 5).join(' | ')}`);
} finally {
  await webkit.close();
  await f.close?.();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-web-part-46-browser: all checks passed');
process.exit(0);
