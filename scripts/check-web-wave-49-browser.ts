import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture, loadPlaywright } from './console-fixture-24b6.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';

/**
 * Part 49 in REAL browsers (the console fixture, its OFFLINE provider): a playing voice pill shows playback by colouring the played
 * part of its waveform bars (the same implementation as the chat's voice bubbles) and has NO separate progress line:
 *   - the home card's pill, the chat's welcome row and the share page /s/<token> (a mocked public route; no provider call anywhere);
 *   - while it plays the played copy of the bars is clipped to the playhead, the clip opens progressively (two samples, growing), it is
 *     drawn in a different colour from the grey bars, and no `.face-progress` element exists;
 *   - nothing else moves: the pill's own box and the name's box are identical before and after it starts playing;
 *   - reduced motion: the played copy has no transition.
 *
 * usage: node scripts/check-web-wave-49-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * With a screenshot directory it also takes the review pictures and a short recording of a playing pill (.webm).
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const pw = loadPlaywright();
const webkit = await pw.webkit.launch();
const TOKEN = 'A'.repeat(32);
try {
  const ANDROID = {
    ...pw.devices['Pixel 7'],
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5,
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  };
  const configs = [
    ['android', ANDROID, f.browser],
    ['ios', { ...pw.devices['iPhone 14'] }, webkit],
    ['desktop', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, f.browser],
  ] as [string, Record<string, unknown>, typeof f.browser][];

  /** The facts of one voice button, read in the page. `bars` is the wrapper of its waveform. */
  const read = (page: Page, button: string) =>
    page.evaluate((sel: string) => {
      const b = document.querySelector<HTMLElement>(sel)!;
      const bars = b.querySelector<HTMLElement>('.face-bars, .sound-bars')!;
      const played = bars.querySelector<SVGElement>('.pk-played');
      const base = bars.querySelector<SVGElement>('svg:not(.pk-played)');
      // layout offsets inside the card, so a card's idle float or a hover scale does not count as the pill moving
      const rect = (e: Element) => {
        const h = e as HTMLElement;
        return [h.offsetLeft, h.offsetTop, h.offsetWidth, h.offsetHeight].join(',');
      };
      const clip = played ? getComputedStyle(played).clipPath : '';
      const right = /inset\([^\s]+\s+([\d.]+)(%|px)/.exec(clip);
      return {
        playing: b.getAttribute('data-playing') === 'true',
        progress: Number(b.style.getPropertyValue('--pk-progress') || '0'),
        hasPlayed: !!played,
        playedColour: played ? `${getComputedStyle(played).color}/${getComputedStyle(played).opacity}` : '',
        baseColour: base ? `${getComputedStyle(base).color}/${getComputedStyle(base).opacity}` : '',
        clip,
        clipRight: right ? Number(right[1]) : null,
        transition: played ? getComputedStyle(played).transitionDuration : '',
        legacyLine: document.querySelectorAll('.face-progress').length,
        box: rect(b),
        name: document.querySelector('.face-name') ? rect(document.querySelector('.face-name')!) : '',
      };
    }, button);

  /** Plays it and checks the colouring while it plays. */
  const exercise = async (page: Page, label: string, button: string, shot: string) => {
    const before = await read(page, button);
    check(before.hasPlayed || button.includes('play-button'), `${label}: the pill has a played copy of its bars`);
    check(before.legacyLine === 0, `${label}: no separate progress line exists`);
    await page.locator(button).click({ force: true });
    await page.waitForFunction((s: string) => document.querySelector(s)?.getAttribute('data-playing') === 'true', button, {
      timeout: 10_000,
    });
    await page.waitForFunction(
      (s: string) => Number(document.querySelector<HTMLElement>(s)?.style.getPropertyValue('--pk-progress') || 0) > 0.05,
      button,
      { timeout: 10_000 },
    );
    const a = await read(page, button);
    if (shots) await page.screenshot({ path: `${shots}/${shot}.png` });
    await wait(700);
    const b = await read(page, button);
    check(a.hasPlayed, `${label}: playing: the played copy of the bars is there`);
    check(a.legacyLine === 0 && b.legacyLine === 0, `${label}: no separate progress line while it plays`);
    check(a.progress > 0 && b.progress > a.progress, `${label}: progress grows (${a.progress} -> ${b.progress})`);
    check(
      a.clip.startsWith('inset(') && a.clipRight !== null && a.clipRight > 0,
      `${label}: the played bars are clipped to the playhead (${a.clip})`,
    );
    check(
      b.clipRight !== null && a.clipRight !== null && b.clipRight < a.clipRight,
      `${label}: the coloured part grows (${a.clipRight} -> ${b.clipRight})`,
    );
    check(a.playedColour !== a.baseColour, `${label}: played bars are coloured (${a.playedColour} vs ${a.baseColour})`);
    check(
      before.box === a.box && before.box === b.box && before.name === b.name,
      `${label}: nothing moves: ${before.box} / ${b.box}; name ${before.name} / ${b.name}`,
    );
    return b;
  };

  // two characters need a revision (the voice speaks from a saved draft), as the workbench leaves them
  for (const id of ['wei-guagua']) {
    const detail = await (await f.post(`characters/${id}/detail`, {})).json();
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await f.post(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
  }

  for (const [name, device, engine] of configs) {
    const ctx = await engine.newContext({
      ...device,
      ignoreHTTPSErrors: true,
      ...(shots ? { recordVideo: { dir: `${shots}/video-${name}`, size: { width: 412, height: 915 } } } : {}),
    });
    // the offline provider's welcome clips are one second long; a playing pill needs a few to be measured, so the welcome audio is a
    // 4 s tone here (the same route, only longer)
    await ctx.route('**/api/web/provider/public-audio/**', (route: Page) =>
      route.fulfill({ body: syntheticTone(4000), contentType: 'audio/wav' }),
    );
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(`${name}: ${String(e)}`));
    await page.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
    );
    await page.goto(`${f.origin}/?mode=provider`);
    const card = '.card-slot.is-active .face-voice';
    await page.locator(card).waitFor({ timeout: 20_000 });
    await wait(1200);
    // 1. the home card
    if (shots) await page.screenshot({ path: `${shots}/${name}-1-home-idle.png` });
    await exercise(page, `${name} home card`, card, `${name}-2-home-playing`);
    // a playing voice is never interrupted: it keeps playing for another moment with the card idle
    check(
      (await read(page, card)).playing || (await read(page, card)).progress === 0,
      `${name}: playing state is consistent`,
    );
    // 2. the chat's welcome row (the same bars, the chat's own bubble)
    await page.locator('.card-slot.is-active .card-face').click({ position: { x: 150, y: 200 }, force: true });
    await page.waitForSelector('.page-shell[data-phase="chat"]', { timeout: 20_000 });
    await wait(1200);
    const row = '.card-slot.is-active .welcome-row .play-button';
    await page.locator(row).waitFor({ timeout: 20_000 });
    await exercise(page, `${name} welcome row`, row, `${name}-3-welcome-playing`);
    // reduced motion: no transition on the played copy
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reduced = await read(page, row);
    check(
      reduced.transition === '' || reduced.transition.split(',').every((t: string) => Number.parseFloat(t) < 0.001), // the page's global reduced-motion rule reads back as 1e-05s
      `${name}: reduced motion has no transition (${reduced.transition})`,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    // 3. the share page: a mocked public route (the card and a 3 s tone), no session, no provider call
    const share = await ctx.newPage();
    share.on('pageerror', (e: unknown) => errors.push(`${name} share: ${String(e)}`));
    await share.route(`**/api/web/provider/shares/${TOKEN}`, (route: Page) =>
      route.fulfill({
        json: {
          characterId: 'wei-guagua',
          displayName: '瓜瓜',
          portraitUrl: null,
          mainColor: null,
          palette: null,
          birthDate: null,
          noRank: 7,
          durationMs: 3000,
          voiceUrl: `/api/web/provider/shares/${TOKEN}/audio`,
        },
      }),
    );
    await share.route(`**/api/web/provider/shares/${TOKEN}/audio`, (route: Page) =>
      route.fulfill({ body: syntheticTone(3000), contentType: 'audio/wav' }),
    );
    await share.goto(`${f.origin}/s/${TOKEN}`);
    await share.locator('.share-page .face-voice').waitFor({ timeout: 20_000 });
    await wait(1200);
    if (shots) await share.screenshot({ path: `${shots}/${name}-4-share-idle.png` });
    await exercise(share, `${name} share page`, '.share-page .face-voice', `${name}-5-share-playing`);
    await share.close();
    await ctx.close();
  }
} finally {
  await webkit.close();
  await f.close();
}
for (const e of errors) problems.push(`page error: ${e}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log("check-web-wave-49-browser: all checks passed");
process.exit(0);
