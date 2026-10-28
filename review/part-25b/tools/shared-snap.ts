import { loadPlaywright } from './fixture-lite.ts';
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const out = process.argv[2]!;
for (const scheme of ['light', 'dark'])
  for (const [w, h] of [[390, 844], [1440, 900]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme, hasTouch: w < 600 });
    const page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => console.log('ERR', String(e)));
    await page.goto('file://' + process.cwd() + '/review/part-25b/tools/shared-index.html');
    await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/shared-${scheme}-${w}.png` });
    await ctx.close();
  }
await browser.close();
