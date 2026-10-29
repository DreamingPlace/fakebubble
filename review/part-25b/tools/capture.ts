import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { billingFixture } from './billing-data.ts';
import { origin, close, loadPlaywright, mails, config } from './fixture.ts';

const out = process.argv[2]!;
const only = process.argv[3]; // optional: 'guest' | 'player' | 'video'
mkdirSync(out, { recursive: true });
const { chromium } = loadPlaywright();
const browser = await chromium.launch();
const SIZES = [[390, 844], [1440, 900]] as const;
const SCHEMES = ['light', 'dark'] as const;
const PASSWORD = 'correct horse battery';
const errors: string[] = [];

async function open(w: number, h: number, scheme: string, opts: { lock?: boolean; video?: string } = {}) {
  const ctx = await browser.newContext({
    ignoreHTTPSErrors: true, viewport: { width: w, height: h }, hasTouch: w < 600, colorScheme: scheme, deviceScaleFactor: 1,
    ...(opts.video ? { recordVideo: { dir: opts.video, size: { width: w, height: h } } } : {}),
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e: unknown) => errors.push(String(e)));
  if (opts.lock)
    await page.route('**/bootstrap', async (route: any) => {
      const res = await route.fetch();
      const json = await res.json();
      if (json.access?.kind === 'guest') json.access.lockedCharacterIds = [];
      await route.fulfill({ response: res, json });
    });
  await page.goto(`${origin}/?mode=provider`);
  await page.locator('.card-slot.is-active').waitFor({ timeout: 15000 });
  await page.waitForTimeout(1200);
  return { ctx, page };
}
const openChat = async (page: any, w: number, h: number) => {
  await page.mouse.click(w / 2, h * 0.45);
  await page.waitForTimeout(1400);
  // dismiss the one-time guide bubble so it does not cover the header in review shots
  await page.locator('.chat-guide').click({ timeout: 1000 }).catch(() => {});
  await page.waitForTimeout(300);
};

if (!only || only === 'guest') {
  for (const scheme of SCHEMES)
    for (const [w, h] of SIZES) {
      const tag = `${scheme}-${w}`;
      const { ctx, page } = await open(w, h, scheme);
      await page.screenshot({ path: join(out, `home-${tag}.png`) });
      await openChat(page, w, h);
      await page.screenshot({ path: join(out, `chat-${tag}.png`) });
      // 外观: open the ⋯ menu, then the sheet
      await page.locator('.card-slot.is-chat .chat-more').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: join(out, `menu-${tag}.png`) });
      await page.getByRole('menuitem', { name: '外观' }).click();
      await page.waitForTimeout(700);
      await page.screenshot({ path: join(out, `look-${tag}.png`) });
      // a custom colour and a frame
      await page.locator('.look-color').evaluate((el: HTMLInputElement) => {
        el.value = '#7fd6c2';
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.getByRole('radio', { name: '葡萄' }).click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(out, `look-custom-${tag}.png`) });
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      // send a message so own avatar + bubbles show
      await page.locator('.card-slot.is-chat textarea').fill('我驾照考过了！！');
      if (await page.locator('.card-slot.is-chat .send-button').isEnabled()) {
        await page.locator('.card-slot.is-chat .send-button').click();
        await page.waitForTimeout(2500);
      }
      await page.screenshot({ path: join(out, `chat-custom-${tag}.png`) });
      // 我的信息 (guest)
      await page.locator('.card-slot.is-chat .back-button').click();
      await page.waitForTimeout(900);
      await page.getByRole('button', { name: '我的信息' }).first().click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(out, `myinfo-guest-${tag}.png`) });
      await ctx.close();
    }
  // guest prompt
  for (const scheme of SCHEMES)
    for (const [w, h] of SIZES) {
      const { ctx, page } = await open(w, h, scheme, { lock: true });
      await openChat(page, w, h);
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `guest-prompt-${scheme}-${w}.png`) });
      await ctx.close();
    }
}

if (!only || only === 'player') {
  for (const scheme of SCHEMES)
    for (const [w, h] of SIZES) {
      const tag = `${scheme}-${w}`;
      const { ctx, page } = await open(w, h, scheme);
      const email = `shot.${scheme}.${w}@example.com`;
      await page.getByRole('button', { name: /登录\/注册|注册/ }).first().click();
      await page.waitForTimeout(700);
      if (!(await page.getByRole('button', { name: '发送验证码' }).isVisible())) {
        await page.screenshot({ path: join(out, `login-${tag}.png`) });
        await page.locator('.acct-sheet').getByRole('button', { name: /没有账号/ }).click();
        await page.waitForTimeout(500);
      }
      await page.getByLabel('邮箱').fill(email);
      await page.getByRole('button', { name: '发送验证码' }).click();
      for (let i = 0; i < 100 && !mails.some((m: any) => m.to === email); i++) await new Promise((r) => setTimeout(r, 50));
      const code = [...mails].reverse().find((m: any) => m.to === email)?.code;
      await page.getByLabel('验证码（6 位数字）').fill(code!);
      await page.getByRole('button', { name: '验证', exact: true }).click();
      const pw = page.locator('input[type=password]');
      await pw.first().waitFor({ timeout: 15000 });
      await pw.nth(0).fill(PASSWORD);
      await pw.nth(1).fill(PASSWORD);
      await page.getByLabel('昵称').fill('阿泡');
      await page.waitForTimeout(600);
      await page.screenshot({ path: join(out, `signup-${tag}.png`) });
      await page.getByRole('button', { name: '完成注册' }).click();
      await page.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 20000 });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(600);
      await page.getByRole('button', { name: /阿泡/ }).first().click();
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(out, `myinfo-player-${tag}.png`) });
      // the same page for an invited player: a daily refill (470 / +50) and an unlimited one, from the server's own shapes
      const models = [{ id: 'deepseek', points: 10, voicePoints: 2 }, { id: 'gemini', points: 20, voicePoints: 2 }, { id: 'xai', points: 25, voicePoints: 2 }];
      for (const kind of ['refill', 'unlimited'] as const) {
        await page.unroute('**/account').catch(() => {});
        await page.route('**/account', async (route: any) => {
          const res = await route.fetch();
          const json = await res.json();
          if (route.request().method() === 'GET' && json.signedIn) {
            const plan = kind === 'refill' ? { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: Date.UTC(2027, 0, 20) } : { kind: 'unlimited', expiresAt: Date.UTC(2027, 0, 20) };
            json.tier = { kind: kind === 'refill' ? 'daily_refill' : 'unlimited', unlimited: kind === 'unlimited', plan };
            json.modelChoice = { models, selected: 'deepseek', metered: kind === 'refill', balance: 470, repliesLeft: 47, version: 1, plan };
          }
          await route.fulfill({ response: res, json });
        });
        await page.reload();
        await page.locator('.card-slot.is-active').waitFor();
        await page.waitForTimeout(900);
        await page.getByRole('button', { name: /阿泡/ }).first().click();
        await page.waitForTimeout(1100);
        await page.screenshot({ path: join(out, `myinfo-${kind}-${tag}.png`) });
      }
      await ctx.close();
    }
}

if (only === 'sheets') {
  for (const scheme of SCHEMES) {
    const [w, h] = [390, 844];
    const tag = `${scheme}-${w}`;
    const { ctx, page } = await open(w, h, scheme);
    const email = `sheets.${scheme}@example.com`;
    await page.getByRole('button', { name: /登录\/注册|注册/ }).first().click();
    await page.waitForTimeout(700);
    await page.locator('.acct-sheet').getByRole('button', { name: /没有账号/ }).click();
    await page.getByLabel('邮箱').fill(email);
    await page.getByRole('button', { name: '发送验证码' }).click();
    for (let i = 0; i < 100 && !mails.some((m: any) => m.to === email); i++) await new Promise((r) => setTimeout(r, 50));
    const code = [...mails].reverse().find((m: any) => m.to === email)?.code;
    await page.getByLabel('验证码（6 位数字）').fill(code!);
    await page.getByRole('button', { name: '验证', exact: true }).click();
    const pw = page.locator('input[type=password]');
    await pw.first().waitFor({ timeout: 15000 });
    await pw.nth(0).fill(PASSWORD);
    await pw.nth(1).fill(PASSWORD);
    await page.getByLabel('昵称').fill('阿泡');
    await page.getByRole('button', { name: '完成注册' }).click();
    await page.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 20000 });
    await page.waitForLoadState('networkidle');
    const models = [{ id: 'deepseek', points: 10, voicePoints: 2 }, { id: 'gemini', points: 20, voicePoints: 2 }, { id: 'xai', points: 25, voicePoints: 2 }];
    await page.route('**/account', async (route: any) => {
      const res = await route.fetch();
      const json = await res.json();
      if (route.request().method() === 'GET' && json.signedIn) {
        const plan = { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null };
        json.tier = { kind: 'daily_refill', unlimited: false, plan };
        json.modelChoice = { models, selected: 'deepseek', metered: true, balance: 470, repliesLeft: 47, version: 1, plan };
      }
      await route.fulfill({ response: res, json });
    });
    await page.reload();
    await page.locator('.card-slot.is-active').waitFor();
    await page.waitForTimeout(900);
    await page.mouse.click(w / 2, h * 0.45);
    await page.waitForTimeout(1400);
    await page.locator('.chat-guide').click({ timeout: 1000 }).catch(() => {});
    await page.locator('.card-slot.is-chat .chat-more').click();
    await page.getByRole('menuitem').first().click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(out, `model-${tag}.png`) });
    await page.locator('.mp-sheet .acct-close').click();
    await page.waitForTimeout(300);
    await page.locator('.card-slot.is-chat .chat-more').click();
    await page.getByRole('menuitem', { name: /共创/ }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, `cocreate-${tag}.png`) });
    await page.locator('.cc-sheet .acct-close, .cc-sheet .cc-close').first().click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(out, `after-cocreate-${tag}.png`) });
    await page.locator('.card-slot.is-chat .back-button').click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /阿泡/ }).first().click();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: '消费记录' }).click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, `billing-${tag}.png`) });
    await ctx.close();
  }
}

if (only === 'misc') {
  for (const scheme of SCHEMES) {
    const [w, h] = [390, 844];
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: w, height: h }, hasTouch: true, colorScheme: scheme });
    await ctx.addCookies([{ name: config.cookieName, value: 'dead-cookie-value', url: origin, httpOnly: true, secure: true, sameSite: 'Lax' }]);
    const page = await ctx.newPage();
    await page.goto(`${origin}/?mode=provider`);
    await page.getByText('你还没有登录').waitFor({ timeout: 15000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `signed-out-${scheme}-390.png`) });
    await page.getByRole('button', { name: '以访客继续' }).click();
    await page.locator('.card-slot.is-active').waitFor({ timeout: 15000 });
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: '我的信息' }).first().click();
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '输入邀请码' }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(out, `invite-${scheme}-390.png`) });
    await ctx.close();
  }
}

if (only === 'billing' || only === 'guide') {
  for (const scheme of SCHEMES) {
    const [w, h] = [390, 844];
    const { ctx, page } = await open(w, h, scheme);
    if (only === 'guide') {
      await page.mouse.click(w / 2, h * 0.45);
      await page.waitForSelector('.chat-guide');
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(out, `guide-${scheme}-${w}.png`) });
      await ctx.close();
      continue;
    }
    const email = `bill.${scheme}@example.com`;
    await page.getByRole('button', { name: /登录\/注册|注册/ }).first().click();
    await page.waitForTimeout(700);
    await page.locator('.acct-sheet').getByRole('button', { name: /没有账号/ }).click();
    await page.getByLabel('邮箱').fill(email);
    await page.getByRole('button', { name: '发送验证码' }).click();
    for (let i = 0; i < 100 && !mails.some((m: any) => m.to === email); i++) await new Promise((r) => setTimeout(r, 50));
    await page.getByLabel('验证码（6 位数字）').fill([...mails].reverse().find((m: any) => m.to === email)!.code!);
    await page.getByRole('button', { name: '验证', exact: true }).click();
    const pw = page.locator('input[type=password]');
    await pw.first().waitFor({ timeout: 15000 });
    await pw.nth(0).fill(PASSWORD);
    await pw.nth(1).fill(PASSWORD);
    await page.getByLabel('昵称').fill('阿泡');
    await page.getByRole('button', { name: '完成注册' }).click();
    await page.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 20000 });
    await page.waitForLoadState('networkidle');
    await page.route('**/billing/history', (route: any) => route.fulfill({ json: billingFixture() }));
    await page.route('**/account', async (route: any) => {
      const res = await route.fetch();
      const json = await res.json();
      if (route.request().method() === 'GET' && json.signedIn) {
        const plan = { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null };
        json.tier = { kind: 'daily_refill', unlimited: false, plan };
        json.modelChoice = { models: [{ id: 'deepseek', points: 10, voicePoints: 2 }], selected: 'deepseek', metered: true, balance: 470, repliesLeft: 47, version: 1, plan };
      }
      await route.fulfill({ response: res, json });
    });
    await page.reload();
    await page.locator('.card-slot.is-active').waitFor();
    await page.waitForTimeout(900);
    await page.getByRole('button', { name: /阿泡/ }).first().click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: '消费记录' }).click();
    await page.waitForSelector('.bl-row');
    await page.waitForTimeout(1000);
    await page.screenshot({ path: join(out, `billing-${scheme}-${w}.png`) });
    await ctx.close();
  }
}

if (!only || only === 'video') {
  const dir = join(out, 'video');
  const { ctx, page } = await open(390, 844, 'light', { video: dir });
  const swipe = async (dx: number) => {
    await page.mouse.move(195, 420);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(195 + (dx * i) / 8, 420, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  await swipe(-160); await swipe(-160); await swipe(160); await swipe(160); await swipe(160);
  await ctx.close();
  const ctx2 = (await open(390, 844, 'light', { video: join(out, 'video-chat') }));
  await ctx2.page.waitForTimeout(500);
  await ctx2.page.mouse.click(195, 380);
  await ctx2.page.waitForTimeout(1600);
  await ctx2.page.locator('.card-slot.is-chat .back-button').click();
  await ctx2.page.waitForTimeout(1400);
  await ctx2.ctx.close();
}
console.log('errors', errors);
await browser.close();
await close();
