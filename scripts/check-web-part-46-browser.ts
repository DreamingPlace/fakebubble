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
    const idleWrites = after.reduce((a, b) => a + b, 0) - before.reduce((a, b) => a + b, 0);
    check(idleWrites === 0, `${label}: ${idleWrites} --name-size changes while idle`);
    const most = Math.max(...before);
    console.log(`${label}: most --name-size changes on one card since load: ${most}`);
    check(most <= 4, `${label}: a card's --name-size changed ${most} times since load`);
    if (shots) await page.screenshot({ path: `${shots}/${label}-home.png` });
    const video = page.video?.();
    await ctx.close();
    if (shots && video) await video.saveAs(`${shots}/${label}-idle-5s.webm`).catch(() => undefined);
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
