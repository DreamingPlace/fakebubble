import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { localRuntime, initProviderInstance } from '../apps/server/platform/web-local-config.ts';
import { WebProviderOffline } from '../apps/server/generation/web-provider-offline.ts';
import { WebCharacterPreviewRunner } from '../apps/server/characters/web-character-preview-runner.ts';
import { WebProviderRunner } from '../apps/server/generation/web-provider-runner.ts';
import { WebProviderServer } from '../apps/server/generation/web-provider-server.ts';
import { DeepSeekTextGenerator } from '../apps/server/generation/deepseek.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../apps/server/conversation/web-vertical-publisher.ts';
import { WebAccountAdmin } from '../apps/server/admin/web-account-admin.ts';
import { WEB_PROVIDER_WELCOME } from '../config/web-v1.ts';
import { migrateProvider, openProviderStore } from './web-provider.ts';
import { syntheticSelection } from '../tests/web/fixtures/provider-selection.ts';

/**
 * Part 24b-5: 导入文件 / 导出文件 on 关系与故事 in a REAL browser (Chromium), on a real migrated provider-local instance. The file is
 * examples/cast-file.example.json with its two "existing" characters pointed at two of the instance's own (wei-guagua, jojo), so
 * the server can find them. The walk: choose the file -> the summary (nothing saved yet) -> 确认导入 -> the result (one new draft
 * character, no `new:` key left, nothing published) -> 导出文件 -> import the exported file again -> "没有改动".
 *
 * usage: node scripts/check-web-cast-file-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });

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

const NOW = Date.parse('2026-10-28T09:30:00Z');
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-castfile-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection(), NOW - 20 * 86_400_000);
const { config, store } = openProviderStore(root);
const clock = { now: () => NOW };
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
  ledger.registerWelcome({
    characterId,
    voiceVersion,
    body: WEB_PROVIDER_WELCOME[characterId].text,
    wav: syntheticTone(),
  });
}
const offlineText = new DeepSeekTextGenerator({
  apiKey: 'offline-only',
  fetch: async () => new Response('{}', { status: 500 }),
});
const runner = new WebProviderRunner(store, clock, offlineText, async (request) => ({
  audio: syntheticTone(),
  receipt: { id: 'fake' },
  usageUnits: request.billedTextBytes,
}));
const previews = new WebCharacterPreviewRunner(store, clock, offlineText, { reserve() {}, settle() {} });
const app = new WebProviderServer(store, config, clock, runner, undefined, previews, { signupEnabled: false });
await app.listen();

const { chromium } = loadPlaywright();
const browser = await chromium.launch(
  process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
);
const origin = new URL(config.origin).origin;
const API = `${origin}/api/web/provider`;
const errors: string[] = [];
let failure: unknown;
try {
  const admins = new WebAccountAdmin(store, clock, config.origin);
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  const login = await context.request.post(`${API}/admin/login`, {
    data: { token: admins.issueLoginGrant().token },
    headers: { origin: config.origin },
  });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(String(error)));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const shot = async (name: string, selector?: string) => {
    if (!shots) return;
    if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const button = (label: string) => page.locator('.cs button', { hasText: label }).filter({ visible: true });

  const exampleText = readFileSync('examples/cast-file.example.json', 'utf8')
    .replaceAll('role-example01', 'wei-guagua')
    .replaceAll('role-example02', 'jojo');
  const castRows = (sql: string) => store.all<Record<string, unknown>>(sql);
  const draftCount = () => castRows('SELECT character_id FROM web_character_drafts').length;

  await page.goto(`${origin}/?mode=provider-admin#/cast`);
  await page.locator('.cs-start, .cs-bar').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  // On an empty draft the start card offers it too, so the bar's own button is the one held to the size rule.
  assert.ok((await button('导入文件').count()) >= 1, 'the import button is in the page');
  assert.ok((await button('导出文件').count()) >= 1, 'the export button is in the page');
  const heights = await page.evaluate(() =>
    [...document.querySelectorAll('.cs-bar button')].map((b) =>
      Math.round((b as HTMLElement).getBoundingClientRect().height),
    ),
  );
  assert.ok(
    heights.length >= 2 && heights.every((h: number) => h === 36),
    `the bar buttons are standard size (36): ${heights}`,
  );
  await shot('01-export-button', '.cs-bar');

  // choose the file: a summary, and nothing saved
  const before = { drafts: draftCount(), revision: castRows('SELECT revision FROM web_cast_draft')[0]!.revision };
  await page.setInputFiles('[data-cast-file]', {
    name: 'cast.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exampleText),
  });
  await page.locator('.cs-import').filter({ visible: true }).waitFor({ timeout: 20_000 });
  const summary = await page.locator('.cs-import').innerText();
  assert.match(summary, /新增角色 3：.*林小满/);
  assert.match(summary, /会同时建立 1 个角色草稿/);
  assert.equal(draftCount(), before.drafts, 'choosing a file created no character');
  assert.equal(castRows('SELECT revision FROM web_cast_draft')[0]!.revision, before.revision, 'and saved nothing');
  await shot('02-import-summary', '.cs-import');

  // confirm: one new draft character, no `new:` key left, nothing published
  await page.locator('.cs-import button', { hasText: '确认导入' }).click();
  await page.locator('.cs-import').waitFor({ state: 'hidden', timeout: 20_000 });
  await page.locator('.cs-grid-card').waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  assert.equal(draftCount(), before.drafts + 1);
  const stored = String(castRows('SELECT doc_json FROM web_cast_draft')[0]!.doc_json);
  assert.ok(!stored.includes('new:') && !stored.includes('new-'));
  assert.equal(castRows('SELECT version FROM web_cast_publications').length, 0, 'nothing was published');
  assert.match(await page.locator('.cs-bar').innerText(), /草稿 修订 2/);
  assert.match(await page.locator('.cs').innerText(), /林小满/);
  await shot('03-after-import');

  // export, and import the exported file again: no change
  const [download] = await Promise.all([page.waitForEvent('download'), button('导出文件').click()]);
  const exported = readFileSync(await download.path(), 'utf8');
  const file = JSON.parse(exported);
  assert.equal(file.format, 'burbur-cast');
  assert.ok(!exported.includes('workbench'));
  if (shots) writeFileSync(join(shots, 'exported-cast.json'), exported);
  await page.setInputFiles('[data-cast-file]', {
    name: 'again.json',
    mimeType: 'application/json',
    buffer: Buffer.from(exported),
  });
  await page.locator('.cs-import').filter({ visible: true }).waitFor({ timeout: 20_000 });
  assert.match(await page.locator('.cs-import').innerText(), /完全一样/);
  await shot('04-round-trip-no-change', '.cs-import');
  await page.locator('.cs-import button', { hasText: '确认导入' }).click();
  await page.locator('.cs-import').waitFor({ state: 'hidden', timeout: 20_000 });
  assert.equal(castRows('SELECT revision FROM web_cast_draft')[0]!.revision, 2, 'the round trip changed nothing');
  assert.equal(draftCount(), before.drafts + 1);

  // a broken file: the problems are in words and the import button is locked
  const broken = JSON.parse(exampleText);
  broken.ratings['wei-guagua'].jojo = 3.3;
  await page.setInputFiles('[data-cast-file]', {
    name: 'broken.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(broken)),
  });
  await page.locator('.cs-import').filter({ visible: true }).waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.cs-import button', { hasText: '确认导入' }).isDisabled(), true);
  assert.match(await page.locator('.cs-import').innerText(), /半星/);
  await shot('05-import-problems', '.cs-import');

  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write('cast file browser check: PASS\n');
} catch (error) {
  failure = error;
  process.stderr.write(`page errors so far: ${JSON.stringify(errors)}\n`);
} finally {
  await browser.close();
  await app.close();
  store.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
