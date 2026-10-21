import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
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

function loadPlaywright(): typeof import('playwright') {
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
const { parent, port } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `browser-check-${randomUUID().slice(0, 12)}`);
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
  page.on('pageerror', (error) => errors.push(String(error)));
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };

  // The bare URL opens the player (the demo prototype is gone).
  const first = await page.goto(`${origin}/`);
  assert.equal(new URL(page.url()).searchParams.get('mode'), 'provider', 'the bare URL redirects to ?mode=provider');
  assert.ok(first && first.status() === 200);
  await page.waitForSelector('button, main', { timeout: 15_000 });
  const cookieName = config.cookieName;
  const cookies = await context.cookies();
  assert.ok(
    cookies.some((cookie) => cookie.name === cookieName && cookie.httpOnly && cookie.secure),
    'the guest session is an httpOnly secure cookie set by the server',
  );

  // A dead cookie opens the signed-out page: the server clears it and the page offers 登录 / 注册 / 以访客继续.
  await context.clearCookies();
  await context.addCookies([
    { name: cookieName, value: 'dead-cookie-value', url: origin, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  await page.goto(`${origin}/?mode=provider`);
  await page.getByText('你还没有登录').waitFor({ timeout: 15_000 });
  for (const label of ['登录', '注册', '以访客继续']) await page.getByRole('button', { name: label, exact: true }).waitFor();
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === cookieName && cookie.value === 'dead-cookie-value'),
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
  await page.getByRole('button', { name: '完成' }).click();
  await page.waitForLoadState('networkidle');
  const signedUp = (await context.cookies()).find((cookie) => cookie.name === cookieName);
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
  await page.getByText('你还没有登录').waitFor({ timeout: 15_000 });
  assert.equal(
    (await context.cookies()).some((cookie) => cookie.name === cookieName),
    false,
    'logout cleared the cookie',
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
  await second.screenshot({ path: shots ? join(shots, 'login.png') : undefined as never }).catch(() => {});
  await second.getByRole('button', { name: '登录', exact: true }).last().click();
  await second.waitForLoadState('networkidle');
  await second.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 15_000 });
  const logged = (await other.cookies()).find((cookie) => cookie.name === cookieName);
  assert.ok(logged && logged.httpOnly && logged.secure, 'login set a session cookie');
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
void readFileSync;
