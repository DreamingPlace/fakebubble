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
import { WebAccountAdmin } from '../apps/server/admin/web-account-admin.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../tests/text-fixtures.ts';

/**
 * Part 22a2: the viewable invite codes and the redeem dialog in a REAL browser (Chromium). The owner and two administrators with
 * invites.manage each open a batch's detail (plain codes for the owner and the creator, ******** for the second administrator,
 * the server decides), 导出表格 downloads the CSV, and a signed-in player's 输入邀请码 dialog has no 注册 button while a guest's
 * does. The server is the provider-local listener over HTTPS with offline providers and a captured mailbox; the player is the build
 * in apps/player-web/dist (run `pnpm web:player:build` first).
 *
 * usage: node scripts/check-web-invite-codes-browser.ts [screenshot-dir]
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
const EMAIL = 'redeem.player@example.com';
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-invite-codes-${randomUUID().slice(0, 12)}`);
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
const API = `${origin}/api/web/provider`;
let failure: unknown;
try {
  const errors: string[] = [];
  const admins = new WebAccountAdmin(store, clock, config.origin);
  type Actor = { context: any; csrf: string };
  const post = async (actor: Actor, path: string, data: unknown, status = 200) => {
    const response = await actor.context.request.post(`${API}${path}`, {
      data,
      headers: { origin: config.origin, 'x-csrf-token': actor.csrf },
    });
    const body = await response.json();
    assert.equal(response.status(), status, `${path}: ${JSON.stringify(body)}`);
    return body;
  };
  const adminLogin = async (token: string): Promise<Actor> => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 1500 } });
    const response = await context.request.post(`${API}/admin/login`, {
      data: { token },
      headers: { origin: config.origin },
    });
    assert.equal(response.status(), 200);
    return { context, csrf: (await response.json()).csrf };
  };
  const owner = await adminLogin(admins.issueLoginGrant().token);
  const member = async (label: string) =>
    adminLogin(
      (
        await post(owner, '/admin/members/issue', {
          requestId: randomUUID(),
          label,
          memberId: null,
          permissions: ['invites.manage'],
        })
      ).token,
    );
  const adminA = await member('A'),
    adminB = await member('B');
  const batch = (actor: Actor, name: string) =>
    post(
      actor,
      '/admin/invites/batch-create',
      {
        requestId: randomUUID(),
        name,
        count: 3,
        tier: { kind: 'unlimited' },
        durationDays: 30,
        redeemBy: null,
      },
      201,
    ) as Promise<{ batchId: string; codes: string[] }>;
  const ownerBatch = await batch(owner, '主管理员批次'),
    aBatch = await batch(adminA, '管理员A批次');

  // ---- the player: signed in, the 输入邀请码 dialog has a code field and 兑换 and nothing about signing up ----
  const playerContext = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const player = await playerContext.newPage();
  player.on('pageerror', (error: unknown) => errors.push(String(error)));
  const shot = async (page: any, name: string) => {
    await page.waitForTimeout(800);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  await player.goto(`${origin}/?mode=provider`);
  await player.getByRole('button', { name: '登录/注册' }).first().waitFor({ timeout: 15_000 });
  // The GUEST's dialog first: it carries the sign-up line and button, hidden until a code is entered.
  await player.getByRole('button', { name: '我的信息' }).first().click();
  await player.getByRole('button', { name: '输入邀请码' }).click();
  await player.locator('.invite-dialog').waitFor();
  const guestSignup = await player.locator('.invite-dialog .invite-signup').count();
  assert.equal(guestSignup, 1, 'a guest’s dialog carries the sign-up block');
  assert.equal(
    await player.locator('.invite-dialog .invite-signup').isVisible(),
    false,
    'hidden until the guest submits a code',
  );
  await player.locator('.invite-dialog input').fill('A'.repeat(43));
  await player.getByRole('button', { name: '兑换', exact: true }).click();
  await player.locator('.invite-dialog .invite-signup').waitFor({ state: 'visible' });
  await player.getByText('注册后即可使用邀请码').waitFor();
  await shot(player, 'redeem-dialog-guest');
  await player
    .getByRole('button', { name: '取消' })
    .or(player.getByRole('button', { name: '关闭' }))
    .first()
    .click();

  // Sign up, then open the dialog again.
  await player.getByRole('button', { name: '登录/注册' }).first().click();
  await player.getByRole('button', { name: '没有账号？注册' }).click();
  await player.getByLabel('邮箱').fill(EMAIL);
  await player.getByRole('button', { name: '发送验证码' }).click();
  for (let i = 0; i < 100 && mails.length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  await player.getByLabel('验证码（6 位数字）').fill(mails.at(-1)!.code!);
  await player.getByRole('button', { name: '验证', exact: true }).click();
  const passwords = player.locator('input[type=password]');
  await passwords.first().waitFor({ timeout: 15_000 });
  await passwords.nth(0).fill(PASSWORD);
  await passwords.nth(1).fill(PASSWORD);
  await player.getByLabel('昵称').fill('阿泡');
  await player.getByRole('button', { name: '完成注册' }).click();
  await player.getByRole('button', { name: /阿泡/ }).first().waitFor({ timeout: 20_000 });
  await player.waitForLoadState('networkidle');
  await player.getByRole('button', { name: /阿泡/ }).first().click();
  await player.getByRole('button', { name: '输入邀请码' }).click();
  await player.locator('.invite-dialog').waitFor();
  assert.equal(
    await player.locator('.invite-dialog .invite-signup').count(),
    0,
    'no sign-up block for a signed-in player',
  );
  assert.equal(await player.locator('.invite-dialog').getByText('注册后即可使用邀请码').count(), 0);
  assert.equal(await player.locator('.invite-dialog').getByRole('button', { name: '注册' }).count(), 0);
  assert.equal(
    await player.locator('.invite-dialog').getByRole('button', { name: '兑换', exact: true }).isVisible(),
    true,
  );
  await shot(player, 'redeem-dialog-signed-in');
  // And it redeems.
  await player.locator('.invite-dialog input').fill(aBatch.codes[0]!);
  await player.getByRole('button', { name: '兑换', exact: true }).click();
  await player.locator('.invite-dialog').waitFor({ state: 'detached', timeout: 15_000 });

  // ---- the administrators: the batch detail as the owner, the creator and the second administrator ----
  const open = async (actor: Actor, name: string) => {
    const page = await actor.context.newPage();
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    await page.goto(`${origin}/?mode=provider-admin#/invites`);
    const row = page.locator('tr', { hasText: name }).first();
    await row.waitFor({ timeout: 20_000 });
    // Named exception (Part 24b-6, Invites3): there is no 查看 button; a click on the batch's row opens its codes directly below it.
    await row.click();
    await page.locator('.tiers-codes-table tbody tr').first().waitFor({ timeout: 15_000 });
    await page.locator('.tiers-detail').scrollIntoViewIfNeeded();
    return page;
  };
  const ownerPage = await open(owner, '管理员A批次');
  for (const code of aBatch.codes) await ownerPage.getByText(code).waitFor();
  // Named exception (Part 24b-6): 复制全部未使用 also contains 复制, so the per-code buttons are counted by their class.
  assert.equal(await ownerPage.locator('.tiers-copy').count(), 3, 'every plain code has its own 复制');
  await shot(ownerPage, 'batch-detail-owner');
  const [download] = await Promise.all([
    ownerPage.waitForEvent('download'),
    ownerPage.getByRole('button', { name: '导出表格' }).click(),
  ]);
  const { readFileSync } = await import('node:fs');
  const csv = readFileSync(await download.path());
  assert.deepEqual([...csv.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the saved file starts with a UTF-8 BOM');
  for (const code of aBatch.codes) assert.ok(csv.toString('utf8').includes(code));

  const bPage = await open(adminB, '管理员A批次');
  assert.equal((await bPage.getByText('********').count()) >= 3, true);
  assert.equal(await bPage.locator('.tiers-copy').count(), 0, 'no 复制 for a masked code');
  const bText = await bPage.locator('body').innerText();
  for (const code of [...aBatch.codes, ...ownerBatch.codes])
    assert.equal(bText.includes(code), false, 'no plain code in the page');
  await bPage.getByText('其他管理员创建').waitFor();
  await shot(bPage, 'batch-detail-admin-b-masked');
  const [bDownload] = await Promise.all([
    bPage.waitForEvent('download'),
    bPage.getByRole('button', { name: '导出表格' }).click(),
  ]);
  const bCsv = readFileSync(await bDownload.path()).toString('utf8');
  for (const code of aBatch.codes)
    assert.equal(bCsv.includes(code), false, 'the second administrator’s CSV is masked too');
  assert.ok(bCsv.includes('********'));

  const aPage = await open(adminA, '管理员A批次');
  for (const code of aBatch.codes) await aPage.getByText(code).waitFor();
  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write('invite codes browser check: PASS\n');
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
