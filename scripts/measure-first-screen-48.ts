import { mkdirSync, renameSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { PROFILES, TIMING_SCRIPT, throttle, turnstileRoutes, type ProfileName } from './first-screen-48-support.ts';

/**
 * Part 48: a cold, new-visitor mobile load, measured (and optionally filmed).
 *
 *   node scripts/measure-first-screen-48.ts [--label after] [--profile fast4g|slow4g] [--turnstile on|off] [--video dir] [--shot file]
 *
 * It starts the offline console fixture (the REAL local server and the built player in apps/player-web/dist), opens the page in a fresh
 * browser context (cold cache, no cookie, a phone viewport) under the network and CPU profile, and prints one JSON line:
 *   fcp           first paint of anything (the skeleton, after Part 48; the first card before it)
 *   firstCard     the first real card content is on the screen
 *   ready         the session is in place (the cards are bound; Part 48 only: before it, the same moment as firstCard)
 *   sheetOpen     (only when asked) the verification sheet is showing
 *   turnstileMs   from the first bootstrap request to the end of the one that carried a token (Turnstile on)
 * The same script runs against the old build (check out the old commit, build it, run this) for the "before" column.
 * With --turnstile on the server side is production-like: no token = 403 TURNSTILE_REQUIRED, and the page solves the REAL Turnstile with
 * Cloudflare's published test site key (it needs the network; it always passes).
 */
const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const label = arg('label', 'run')!;
const profile = arg('profile', 'fast4g') as ProfileName;
const turnstile = arg('turnstile', 'on') === 'on';
const video = arg('video');
const shot = arg('shot');
if (!(profile in PROFILES)) throw new Error('unknown profile');
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
try {
  const pw = loadPlaywright();
  const context = await f.browser.newContext({
    ...pw.devices['Pixel 7'],
    viewport: { width: 412, height: 915 },
    ignoreHTTPSErrors: true,
    ...(video ? { recordVideo: { dir: resolve(video), size: { width: 412, height: 915 } } } : {}),
  });
  await context.addInitScript(TIMING_SCRIPT);
  const stats = turnstile ? await turnstileRoutes(context, f.origin) : null;
  const page = await context.newPage();
  await throttle(context, page, profile);
  const started = Date.now();
  await page.goto(`${f.origin}/?mode=provider`, { waitUntil: 'commit' });
  await page.waitForFunction(
    () => (window as unknown as { __first: { card: number | null } }).__first?.card !== null,
    null,
    {
      timeout: 120_000,
    },
  );
  const firstCardAt = Date.now() - started;
  // The session: Part 48 marks bound cards; the old build has no such mark (its first card IS the session).
  await page
    .waitForFunction(
      () =>
        !!document.querySelector('.card-slot[data-ready="true"]') || !document.querySelector('.is-skeleton, .vs-root'),
      null,
      { timeout: 120_000 },
    )
    .catch(() => undefined);
  await page.waitForTimeout(1500);
  const t = await page.evaluate(() => {
    const first = (
      window as unknown as { __first: { paints: Record<string, number>; card: number | null; ready: number | null } }
    ).__first;
    const entries = (performance.getEntriesByType('resource') as PerformanceResourceTiming[]).map((e) => ({
      name: e.name,
      start: e.startTime,
      end: e.responseEnd,
    }));
    return { paints: first.paints, card: first.card, ready: first.ready, entries };
  });
  const boots = t.entries.filter((e: { name: string }) => e.name.endsWith('/bootstrap'));
  const script = t.entries.find((e: { name: string }) => e.name.includes('challenges.cloudflare.com'));
  const out = {
    label,
    profile: PROFILES[profile].label,
    turnstile,
    fcpMs: Math.round(t.paints['first-contentful-paint'] ?? -1),
    firstCardMs: Math.round(t.card ?? -1),
    readyMs: Math.round(t.ready ?? t.card ?? -1),
    turnstileMs: stats && boots.length >= 2 ? Math.round(boots.at(-1)!.end - boots[0]!.start) : null,
    turnstileScriptMs: script ? Math.round(script.end - script.start) : null,
    bootstraps: boots.length,
    wallFirstCardMs: firstCardAt,
  };
  if (shot) await page.screenshot({ path: resolve(shot) });
  await context.close();
  if (video) {
    const recorded = readdirSync(resolve(video)).filter((n) => n.endsWith('.webm'));
    if (recorded.length) renameSync(join(resolve(video), recorded.at(-1)!), join(resolve(video), `${label}.webm`));
  }
  console.log(JSON.stringify(out));
} finally {
  await f.close();
}
