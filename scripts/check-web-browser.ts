import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { localRuntime, initProviderInstance } from '../apps/server/platform/web-local-config.ts';
import { WebProviderOffline } from '../apps/server/generation/web-provider-offline.ts';
import { WebProviderRunner } from '../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../apps/server/generation/web-provider-server.ts';
import { DeepSeekTextGenerator } from '../apps/server/generation/deepseek.ts';
import { readWebV7Request } from '../apps/server/generation/web-v7-request.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../apps/server/conversation/web-vertical-publisher.ts';
import { WEB_PROVIDER_WELCOME } from '../config/web-v1.ts';
import { WebProviderBudget } from '../apps/server/budget/web-provider-budget.ts';
import { migrateProvider, openProviderStore } from './web-provider.ts';
import { syntheticSelection } from '../tests/web/fixtures/provider-selection.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../tests/text-fixtures.ts';

/**
 * Part 22x: the signed-out page, signup and login in a REAL browser (Chromium): JavaScript runs, cookies are set and sent by the
 * browser, and nothing is replayed. The server is the provider-local listener over HTTPS with offline providers and a captured
 * mailbox; the player is the build in apps/player-web/dist (run `pnpm web:player:build` first).
 *
 * usage: node scripts/check-web-browser.ts [screenshot-dir]
 * Playwright is not a dependency of the repository: it is resolved from PLAYWRIGHT_MODULE, the working tree, or the usual global
 * tool directories, and the script exits with a clear message when no Chromium is available.
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });

type Cookie = { name: string; value: string; httpOnly: boolean; secure: boolean; expires: number };

// Playwright is not a repository dependency, so it has no types here.
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
function loadPlaywright(): any {
  const candidates = [
    process.env.PLAYWRIGHT_MODULE,
    'playwright',
    '/node-tools/node_modules/playwright',
    '/opt/node22/lib/node_modules/playwright',
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      return createRequire(import.meta.url)(candidate);
    } catch {
      /* try the next one */
    }
  }
  throw new Error('Playwright is not installed: set PLAYWRIGHT_MODULE to its directory');
}

const PASSWORD = 'correct horse battery';
const EMAIL = 'browser.player@example.com';
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-browser-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection());
const { config, store } = openProviderStore(root);
const clock = { now: () => Date.now() };
const budgetPath = join(root, 'browser-budget.sqlite');
WebProviderBudget.initialize(
  budgetPath,
  ['deepseek', 'fish'].map((provider) => ({
    source: 'synthetic',
    provider: provider as 'deepseek' | 'fish',
    digest: 'a'.repeat(64),
    spentMicros: 0,
    heldMicros: 0,
  })),
);
const shared = new WebProviderBudget(budgetPath, clock);
const ledger = new WebProviderOffline(store, clock);
for (const characterId of ['wei-guagua', 'jojo', 'chen-jimi'] as const) {
  const voiceVersion = `${characterId}-fish:v1`;
  ledger.registerApprovedFooter({
    characterId,
    voiceVersion,
    body: SYNTHETIC_TRIAL_FOOTER,
    wav: syntheticTone(),
    approved: true,
  });
  if (characterId !== 'chen-jimi')
    ledger.registerWelcome({
      characterId,
      voiceVersion,
      body: WEB_PROVIDER_WELCOME[characterId].text,
      wav: syntheticTone(),
    });
}
const running = () =>
  store.get<{ id: string }>("SELECT id FROM web_operations WHERE status='text_running' ORDER BY admission_seq LIMIT 1")!
    .id;
const text = new DeepSeekTextGenerator({
  apiKey: 'offline-only',
  fetch: async (_url, init) => {
    const { request } = readWebV7Request(store, running());
    const tool = JSON.parse(String(init?.body)).tools[0].function.name;
    return Response.json(tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
  },
});
const runner = new WebProviderRunner(
  store,
  clock,
  text,
  async (request) => ({ audio: syntheticTone(), receipt: { id: 'fake' }, usageUnits: request.billedTextBytes }),
  shared,
);
const mails: { to: string; kind: string; code: string | null }[] = [];
const app = new WebProviderServer(store, config, clock, runner, undefined, undefined, {
  signupEnabled: true,
  mailer: {
    send: async (message: { to: string; kind: string; code: string | null }) => void mails.push(message),
    waitUntil: (task: Promise<void>) => void task,
  },
  dailyCap: 50,
});
await app.listen();

const { chromium } = loadPlaywright();
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const origin = new URL(config.origin).origin;
let failure: unknown;
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error: unknown) => errors.push(String(error)));
  const shot = async (name: string) => {
    await page.waitForTimeout(800); // let the sheet's fade-in finish
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };

  // The bare URL opens the player (the demo prototype is gone).
  const first = await page.goto(`${origin}/`);
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'provider', 'the bare URL redirects to ?mode=provider');
  assert.ok(first && first.status() === 200);
  await page.locator('button:visible').first().waitFor({ timeout: 15_000 });
  const cookieName = config.cookieName;
  const cookies = await context.cookies();
  assert.ok(
    cookies.some((cookie: Cookie) => cookie.name === cookieName && cookie.httpOnly && cookie.secure),
    'the guest session is an httpOnly secure cookie set by the server',
  );

  // A dead cookie opens the signed-out page: the server clears it and the page offers 登录 / 注册 / 以访客继续.
  await context.clearCookies();
  await context.addCookies([
    { name: cookieName, value: 'dead-cookie-value', url: origin, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  await page.goto(`${origin}/?mode=provider`);
  await page.getByText('你还没有登录').waitFor({ timeout: 15_000 });
  for (const label of ['登录', '注册', '以访客继续'])
    await page.getByRole('button', { name: label, exact: true }).waitFor();
  assert.equal(
    (await context.cookies()).some(
      (cookie: Cookie) => cookie.name === cookieName && cookie.value === 'dead-cookie-value',
    ),
    false,
    'the dead cookie was cleared by the server',
  );
  await shot('signed-out');

  // 注册: the browser sends the code request, verifies, then sets a password and a nickname.
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByLabel('邮箱').fill(EMAIL);
  await shot('signup-email');
  await page.getByRole('button', { name: '发送验证码' }).click();
  for (let i = 0; i < 100 && mails.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  const code = mails.at(-1)?.code;
  assert.ok(code, 'the mailbox received a code');
  await page.getByLabel('验证码（6 位数字）').fill(code);
  await page.getByRole('button', { name: '验证', exact: true }).click();
  const passwords = page.locator('input[type=password]');
  await passwords.first().waitFor({ timeout: 15_000 });
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await page.getByLabel('昵称').fill('阿泡');
  await shot('signup-password');
  await page.getByRole('button', { name: '完成注册' }).click();
  await page.getByText(/注册成功/).waitFor({ timeout: 15_000 });
  // The sheet closes itself and the page reloads as the signed-up player.
  await page.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  const signedUp = (await context.cookies()).find((cookie: Cookie) => cookie.name === cookieName);
  assert.ok(signedUp && signedUp.httpOnly && signedUp.secure, 'signup left a session cookie');
  assert.ok(signedUp.expires > Date.now() / 1000 + 300 * 86_400, 'a signed-up session cookie is long-lived (400 days)');

  // 我的信息 for a registered player.
  await page.getByRole('button', { name: /阿泡/ }).first().click();
  await page.getByText('资料', { exact: true }).waitFor({ timeout: 15_000 });
  await page.getByText('注册玩家').waitFor();
  await page.getByText('b***@example.com').waitFor();
  await shot('my-info');
  assert.equal(await page.getByText(/恢复码/).count(), 0, 'no recovery-code UI anywhere');
  assert.equal(await page.getByText(/绑定邮箱/).count(), 0);
  await page.getByRole('button', { name: '退出登录' }).click();
  // Logging out ends the session: the page reloads as a fresh visitor and the signed-up cookie is gone.
  await page.getByRole('button', { name: '登录/注册' }).first().waitFor({ timeout: 15_000 });
  assert.equal(await page.getByRole('button', { name: /阿泡/ }).count(), 0, 'the nickname button is gone');
  assert.notEqual(
    (await context.cookies()).find((cookie: Cookie) => cookie.name === cookieName)?.value,
    signedUp.value,
    'logout replaced the signed-in session cookie',
  );

  // 登录 from a second browser context (another device): cookies start empty.
  const other = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const second = await other.newPage();
  await other.addCookies([
    { name: cookieName, value: 'dead-cookie-value', url: origin, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  await second.goto(`${origin}/?mode=provider`);
  await second.getByRole('button', { name: '登录', exact: true }).click();
  await second.getByLabel('邮箱').fill(EMAIL);
  await second.locator('input[type=password]').first().fill(PASSWORD);
  await second.waitForTimeout(800);
  if (shots) await second.screenshot({ path: join(shots, 'login.png') });
  await second.getByRole('button', { name: '登录', exact: true }).last().click();
  await second.waitForLoadState('networkidle');
  await second.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 15_000 });
  const logged = (await other.cookies()).find((cookie: Cookie) => cookie.name === cookieName);
  assert.ok(logged && logged.httpOnly && logged.secure, 'login set a session cookie');

  // ---- Part 25b: the player's pages in a phone-sized browser ------------------------------------------------------------------
  // A fresh guest on a 390x844 phone: the stack of cards, the swipe, the welcome pill, the chat's own colour (kept across a reload),
  // the guest's line in the middle, night mode (system and toggle) and the slide-up of the sheets.
  const phoneContext = async (colorScheme: 'light' | 'dark', lockGuest = false) => {
    const phone = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      colorScheme,
    });
    const view = await phone.newPage();
    view.on('pageerror', (error: unknown) => errors.push(String(error)));
    if (lockGuest)
      await view.route('**/bootstrap', async (route: any) => {
        const response = await route.fetch();
        const json = await response.json();
        if (json.access?.kind === 'guest') json.access.lockedCharacterIds = [];
        await route.fulfill({ response, json });
      });
    await view.goto(`${origin}/?mode=provider`);
    await view.locator('.card-slot.is-active .face-voice').waitFor({ timeout: 15_000 });
    await view.waitForTimeout(1200);
    return { phone, view };
  };
  const selectedName = (view: any) => view.locator('.avatar-choice.selected').getAttribute('aria-label');
  {
    const { phone, view } = await phoneContext('light');
    // The stack: the front card is narrower than the screen and a neighbour peeks out on both sides.
    const front = await view.locator('.card-slot.is-active').boundingBox();
    assert.ok(front.width <= 300 && front.width >= 240, `the front card is ${front.width}px wide on a 390px phone`);
    assert.ok(Math.abs(front.x + front.width / 2 - 195) < 3, 'the front card is in the middle');
    for (const side of ['l', 'r']) {
      const box = await view.locator(`.card-slot[data-side="${side}"]:not(.is-hidden-slot)`).first().boundingBox();
      const shown =
        side === 'l' ? front.x - Math.max(box.x, 0) : Math.min(box.x + box.width, 390) - (front.x + front.width);
      assert.ok(shown >= 30, `the ${side} neighbour shows ${Math.round(shown)}px beside the front card`);
      assert.equal(
        await view
          .locator(`.card-slot[data-side="${side}"]:not(.is-hidden-slot)`)
          .first()
          .evaluate((el: Element) => getComputedStyle(el).visibility),
        'visible',
      );
    }
    // The welcome is a pill with a waveform and a length - and none of the welcome words is on the card.
    const face = view.locator('.card-slot.is-active .card-face');
    assert.equal(await face.locator('.face-voice .face-wave').count(), 1);
    assert.match(await face.locator('.face-dur').innerText(), /^\d:\d\d$/);
    const faceText: string = await face.evaluate((el: HTMLElement) => el.textContent ?? '');
    for (const entry of Object.values(WEB_PROVIDER_WELCOME) as { text: string }[])
      assert.equal(faceText.includes(entry.text), false, 'no welcome transcript on the card');
    // Swipe: a sideways drag turns to the next card; the card in front changes.
    const before = await selectedName(view);
    await view.mouse.move(195, 420);
    await view.mouse.down();
    for (let step = 1; step <= 8; step++) await view.mouse.move(195 - step * 20, 420, { steps: 2 });
    await view.mouse.up();
    await view.waitForTimeout(900);
    assert.notEqual(await selectedName(view), before, 'a swipe turns to another card');
    // Back to a character, then open its chat: the top bar fades and lifts (it is not removed), the chat fills the screen.
    await view.locator('.avatar-choice[aria-label^="选择"]').first().click();
    await view.waitForTimeout(900);
    await view.mouse.click(195, 380);
    await view.waitForSelector('.page-shell[data-phase="chat"]');
    await view.waitForTimeout(700);
    const bar = await view.locator('.site-head').evaluate((el: Element) => {
      const style = getComputedStyle(el);
      return {
        display: style.display,
        opacity: style.opacity,
        visibility: style.visibility,
        transform: style.transform,
      };
    });
    assert.notEqual(bar.display, 'none', 'the top bar is animated away, not removed');
    assert.equal(bar.opacity, '0');
    assert.equal(bar.visibility, 'hidden');
    const chat = await view.locator('.card-slot.is-chat').boundingBox();
    assert.ok(chat.width >= 388 && chat.height >= 840, `the chat fills the phone (${chat.width}x${chat.height})`);
    // The header is centred: the name sits in the middle of the card.
    const name = await view.locator('.card-slot.is-chat .chat-head strong').boundingBox();
    assert.ok(Math.abs(name.x + name.width / 2 - 195) < 4, 'the chat title is centred');
    // 外观: a preset, then a custom colour - applied at once, and still there after a reload.
    await view
      .locator('.chat-guide')
      .click({ timeout: 1000 })
      .catch(() => {});
    await view.locator('.card-slot.is-chat .chat-more').click();
    await view.getByRole('menuitem', { name: '外观' }).click();
    const sheetMotion = await view
      .locator('.look-sheet .mp-panel')
      .evaluate((el: Element) => getComputedStyle(el).animationName);
    assert.equal(sheetMotion, 'bb-up', 'the 外观 sheet slides up');
    const shellColour = () =>
      view.locator('.card-slot.is-chat .card-shell').evaluate((el: Element) => getComputedStyle(el).backgroundColor);
    await view.getByRole('radiogroup', { name: '背景' }).getByRole('radio', { name: '薄荷' }).click();
    await view.waitForTimeout(500);
    assert.equal(await shellColour(), 'rgb(221, 244, 234)', 'the preset is the chat background');
    await view.locator('.look-color').evaluate((el: HTMLInputElement) => {
      el.value = '#7fd6c2';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await view.waitForTimeout(500);
    assert.equal(await shellColour(), 'rgb(127, 214, 194)', 'a custom colour is the chat background');
    await view.getByRole('radiogroup', { name: '头像框' }).getByRole('radio', { name: '葡萄' }).click();
    await view.locator('.look-sheet .acct-close').click();
    await view.reload();
    await view.locator('.card-slot.is-active .face-voice').waitFor({ timeout: 15_000 });
    await view.waitForTimeout(900);
    await view.locator('.avatar-choice[aria-label^="选择"]').first().click();
    await view.waitForTimeout(700);
    await view.mouse.click(195, 380);
    await view.waitForSelector('.page-shell[data-phase="chat"]');
    await view.waitForTimeout(900);
    assert.equal(await shellColour(), 'rgb(127, 214, 194)', 'the colour is remembered for that character');
    assert.equal(
      await view.evaluate(() =>
        getComputedStyle(document.querySelector('.page-shell') as Element)
          .getPropertyValue('--own-a')
          .trim(),
      ),
      '#7C4DEB',
      'the player’s own avatar frame is remembered',
    );
    if (shots) await view.screenshot({ path: join(shots, 'chat-custom-390.png') });
    await phone.close();
  }
  {
    // The guest's line: in the middle of the chat area, below the header and above the input.
    const { phone, view } = await phoneContext('light', true);
    await view.locator('.avatar-choice[aria-label^="选择"]').first().click();
    await view.waitForTimeout(700);
    await view.mouse.click(195, 380);
    await view.waitForSelector('.page-shell[data-phase="chat"]');
    await view.waitForTimeout(900);
    const note = await view.locator('.card-slot.is-chat .guest-note').boundingBox();
    const head = await view.locator('.card-slot.is-chat .chat-head').boundingBox();
    const composer = await view.locator('.card-slot.is-chat .composer').boundingBox();
    assert.equal(await view.locator('.card-slot.is-chat .guest-note').innerText(), '新客人，就决定是这位小四四了吗？');
    assert.ok(note.y >= head.y + head.height - 1, 'the line is below the header');
    assert.ok(note.y + note.height <= composer.y, 'the line is not on the input');
    const middle = (head.y + head.height + composer.y) / 2;
    assert.ok(Math.abs(note.y + note.height / 2 - middle) < 40, 'the line is in the middle of the chat area');
    assert.ok(Math.abs(note.x + note.width / 2 - 195) < 4, 'and centred sideways');
    if (shots) await view.screenshot({ path: join(shots, 'guest-prompt-390.png') });
    await phone.close();
  }
  {
    // Night mode follows the system, and the toggle in 我的信息 overrides it; the account sheets slide up.
    const { phone, view } = await phoneContext('dark');
    const theme = () => view.evaluate(() => document.documentElement.getAttribute('data-theme'));
    const paper = () => view.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
    assert.equal(await theme(), 'dark');
    assert.equal(await paper(), 'rgb(12, 11, 16)');
    await view.getByRole('button', { name: '我的信息' }).first().click();
    const motion = await view.locator('.mi-sheet').evaluate((el: Element) => getComputedStyle(el).animationName);
    assert.equal(motion, 'bb-sheet', '我的信息 slides up');
    await view.waitForTimeout(900);
    if (shots) await view.screenshot({ path: join(shots, 'my-info-night-390.png') });
    await view.getByText('日间', { exact: true }).click();
    await view.waitForTimeout(900);
    assert.equal(await theme(), 'light', 'the toggle overrides the system');
    assert.equal(await paper(), 'rgb(250, 248, 246)');
    await view.reload();
    await view.locator('.card-slot.is-active .face-voice').waitFor({ timeout: 15_000 });
    assert.equal(await theme(), 'light', 'and the pick is remembered');
    await view.getByRole('button', { name: '登录/注册' }).first().click();
    const sheetMotionLogin = await view
      .locator('.acct-sheet')
      .evaluate((el: Element) => getComputedStyle(el).animationName);
    assert.equal(sheetMotionLogin, 'bb-sheet', 'the account sheets slide up');
    await phone.close();
  }

  {
    // Reduced motion: the sheets do not slide and the top bar does not animate, whatever the page would otherwise do.
    const calm = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    const view = await calm.newPage();
    view.on('pageerror', (error: unknown) => errors.push(String(error)));
    await view.goto(`${origin}/?mode=provider`);
    await view.locator('.card-slot.is-active .face-voice').waitFor({ timeout: 15_000 });
    await view.getByRole('button', { name: '登录/注册' }).first().click();
    assert.equal(
      await view.locator('.acct-sheet').evaluate((el: Element) => getComputedStyle(el).animationName),
      'none',
      'no slide-up under reduced motion',
    );
    await calm.close();
  }
  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write('browser check: PASS\n');
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await app.close();
  shared.close();
  try {
    store.close();
  } catch {
    /* already closed */
  }
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
