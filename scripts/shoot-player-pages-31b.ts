import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 31b: before/after screenshots of the player's sheets and pages (no explanatory text, removals only), at 390 and 1440.
 * usage: node scripts/shoot-player-pages-31b.ts <screenshot-dir> <prefix>      (prefix = before | after)
 */
const dir = resolve(process.argv[2] ?? 'shots');
const prefix = process.argv[3] ?? 'shot';
mkdirSync(dir, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const f = await startConsoleFixture({ signup: true, freeTier: true });
try {
  for (const [width, height, tag] of [
    [390, 844, 'm'],
    [1440, 900, 'd'],
  ] as const) {
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page: Page = await ctx.newPage();
    const snap = async (name: string) => {
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(dir, `${prefix}-${name}-${tag}.png`) });
    };
    await page.goto(`${f.origin}/?mode=provider`);
    await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    await snap('home');
    const head = (text: string) =>
      page.locator('.site-head .head-account', { hasText: text }).filter({ visible: true }).first();
    // 注册
    await head(width < 600 ? '登录/注册' : '注册').click();
    await page.locator('.acct-sheet').waitFor();
    if (width < 600) await page.locator('.acct-links button', { hasText: '注册' }).click();
    await page.locator('.acct-sheet.acct-signup').waitFor();
    await snap('signup');
    await page.keyboard.press('Escape');
    await page
      .locator('.acct-sheet')
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => undefined);
    // 登录, 忘记密码
    await head(width < 600 ? '登录/注册' : '登录').click();
    await page.locator('.acct-sheet.acct-login').waitFor();
    await snap('login');
    await page.locator('.acct-links button', { hasText: '忘记密码' }).click();
    await page.locator('.acct-sheet.acct-reset').waitFor();
    await snap('reset');
    await page.keyboard.press('Escape');
    await page
      .locator('.acct-sheet')
      .waitFor({ state: 'detached', timeout: 5000 })
      .catch(() => undefined);
    // 我的信息, 消费记录
    await page.locator('.site-head .head-account', { hasText: '我的信息' }).filter({ visible: true }).first().click();
    await page.waitForTimeout(600);
    await snap('info');
    await page
      .locator('button', { hasText: '消费记录' })
      .first()
      .click()
      .catch(() => undefined);
    await page.waitForTimeout(800);
    await snap('billing');
    await ctx.close();
  }
  console.log('shot', dir);
} finally {
  await f.close();
}
