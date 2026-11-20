import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { CARD_IDS, TEST_NAMES, measureNames, nameEnvironments, openNamedHome, shootFront } from './part-44-names.ts';

/**
 * Part 44: one screenshot of every test nickname on the front home card, per environment (Android emulation 412×915 @3.5, desktop, iOS
 * WebKit where the browser exists), and what each name measures. Used for the before / after board of the owner's review.
 *
 * usage: node scripts/shoot-part-44-names.ts <screenshot-dir>   (run `pnpm web:player:build` first)
 */
const out = process.argv[2];
if (!out) throw new Error('usage: node scripts/shoot-part-44-names.ts <screenshot-dir>');
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 } });
try {
  const pw = loadPlaywright();
  // P44_ENV=ios-webkit and P44_ONLY=2,8,10,14 narrow a run (the site's request limiter refuses a long run of page loads from one address)
  const only = process.env.P44_ONLY?.split(',').map(Number);
  for (const env of nameEnvironments(pw)) {
    if (process.env.P44_ENV && process.env.P44_ENV !== env.key) continue;
    let browser: Awaited<ReturnType<typeof env.launch>>;
    try {
      browser = await env.launch();
    } catch {
      console.log(`${env.key}: browser not available here`);
      continue;
    }
    for (let i = 0; i < TEST_NAMES.length; i++) {
      if (only && !only.includes(i + 1)) continue;
      const ctx = await browser.newContext({ ...env.context, ignoreHTTPSErrors: true });
      const page = await ctx.newPage();
      await openNamedHome(page, f.origin, TEST_NAMES, CARD_IDS[i]);
      if (i === (only?.[0] ?? 1) - 1)
        for (const x of await measureNames(page))
          console.log(env.key, x.text, `size ${x.size.toFixed(3)}`, `font ${x.fontPx.toFixed(1)}px`);
      await shootFront(page, `${out}/${env.key}-${String(i + 1).padStart(2, '0')}.png`);
      await ctx.close();
    }
    await browser.close();
  }
} finally {
  await f.close?.();
}
