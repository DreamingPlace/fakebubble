import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync } from 'node:fs';
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
import { sampleCastRaw } from '../tests/web/fixtures/cast-sample.ts';

/**
 * Part 24b-2: 角色工作台 (list | editor | 预演), 主色, 关系与故事, 共创收件箱 and 管理员与权限 in a REAL browser (Chromium), as the owner sees
 * them, on a real migrated provider-local instance. The cast and the co-creation notes are SYNTHETIC ("[示例]" style fixtures):
 * the cast is the 15-person test fixture, written through the cast API; the notes are rows written straight into the inbox tables.
 * The check also publishes a main colour for one character WITHOUT a 预演 (the colour-only rule) and looks at the player's home
 * and chat for that character, and verifies that no page scrolls sideways at 1280, 1440 and 1680.
 *
 * usage: node scripts/check-web-console-24b2-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * Playwright is resolved like check-web-stats-browser.ts.
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

const NOW = Date.parse('2026-10-24T09:30:00Z');
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-console-${randomUUID().slice(0, 12)}`);
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
// Offline: no provider is ever reached. 预演 is switched on (so the panel is the real one) but a submitted one would simply fail.
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
const pageErrors = errors;
let failure: unknown;
try {
  const admins = new WebAccountAdmin(store, clock, config.origin);
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } });
  const loginResponse = await context.request.post(`${API}/admin/login`, {
    data: { token: admins.issueLoginGrant().token },
    headers: { origin: config.origin },
  });
  assert.equal(loginResponse.status(), 200);
  const csrf = (await loginResponse.json()).csrf as string;
  const post = async (path: string, data: unknown, ok = true) => {
    const response = await context.request.post(`${API}/admin/${path}`, {
      data,
      headers: { origin: config.origin, 'x-csrf-token': csrf },
    });
    if (ok) assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response;
  };

  // ---- a main colour for jojo, published without a 预演 (colour only) ----
  const detail = await (await post('characters/jojo/detail', {})).json();
  const next = structuredClone(detail.published.profile);
  next.template.version = detail.published.version + 1;
  next.presentation.color = '#2BA84A';
  const saved = await (await post('characters/jojo/save', { expectedRevision: null, profile: next })).json();
  const withoutPreview = await post('characters/jojo/publish', {
    requestId: randomUUID(),
    draftRevision: saved.revision,
    profileHash: saved.contentHash,
    acknowledgeReview: true,
  });
  assert.equal((await withoutPreview.json()).version, detail.published.version + 1);
  // ...and the same request without a colour change is refused (every other change needs its 预演)
  const other = structuredClone(next);
  other.template.version += 1;
  other.template.persona += ' ';
  other.presentation.color = '#7C4DEB';
  const second = await (await post('characters/jojo/save', { expectedRevision: null, profile: other })).json();
  const refused = await post(
    'characters/jojo/publish',
    {
      requestId: randomUUID(),
      draftRevision: second.revision,
      profileHash: second.contentHash,
      acknowledgeReview: true,
    },
    false,
  );
  assert.notEqual(refused.status(), 200, 'a persona change with a colour still needs its 预演');
  await post('characters/jojo/discard', { expectedRevision: second.revision });

  // ---- the cast draft: the 15-person fixture ----
  const cast0 = await (await post('cast/draft', {})).json();
  await post('cast/save', { requestId: randomUUID(), expectedRevision: cast0.revision, doc: sampleCastRaw() });

  // ---- the player's home and chat for jojo carry the published colour ----
  const player = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const home = await player.newPage();
  home.on('pageerror', (error: unknown) => errors.push(String(error)));
  await home.goto(`${origin}/?mode=provider`);
  await home.locator('button:visible').first().waitFor({ timeout: 20_000 });
  await home.waitForTimeout(1200);
  const bootstrap = await (await player.request.get(`${API}/bootstrap`)).json();
  const colours = Object.fromEntries(
    bootstrap.characters.map((c: { characterId: string; mainColor: string | null }) => [c.characterId, c.mainColor]),
  );
  assert.deepEqual(colours, { 'wei-guagua': null, jojo: '#2BA84A', 'chen-jimi': null });
  const shotPlayer = async (
    page: { screenshot: (o: unknown) => Promise<unknown>; waitForTimeout: (n: number) => Promise<void> },
    name: string,
  ) => {
    await page.waitForTimeout(900);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  await shotPlayer(home, 'player-home');
  const principal = store.get<{ id: string }>('SELECT id FROM web_principals ORDER BY rowid LIMIT 1')!.id;

  // ---- synthetic inbox notes ----
  const notes = [
    ['jojo', 'persona', 'text', '"这把是我 carry 的，你承认吧。"说完又补一句"你也还行"。', 'new', 1],
    ['jojo', 'speechStyle', 'text', '"网卡了。"然后马上开下一把。', 'new', 0],
    [
      'jojo',
      'dialogueExamples',
      'dialogue',
      { player: '我再玩十分钟', replies: ['十分钟？你上次说十分钟玩到三点。睡。'] },
      'processed',
      0,
    ],
    ['wei-guagua', 'persona', 'text', '装作很凶地问你吃饭没，问完就开始碎碎念。', 'new', 1],
    ['chen-jimi', 'free', 'text', '这句太像客服了，不像他会说的话。', 'archived', 0],
  ] as const;
  notes.forEach(([characterId, field, kind, body, status, star], index) => {
    const id = `note-${index + 1}`;
    store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,status,starred)
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      characterId,
      principal,
      `req-${index}`,
      'a'.repeat(64),
      NOW - (index + 1) * 3_600_000,
      status,
      star,
    );
    store.run(
      `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,?,?,?,?,?)`,
      id,
      0,
      'free-1',
      field,
      kind,
      JSON.stringify(body),
    );
  });

  // ---- the console ----
  const page = await context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(String(error)));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const wait = (n = 800) => page.waitForTimeout(n);
  const shot = async (name: string, locator?: unknown) => {
    await wait(900);
    if (!shots) return;
    // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
    if (locator) await (locator as any).screenshot({ path: join(shots, `${name}.png`) });
    else {
      // The console scrolls inside its own frame, so a tall window is what shows the whole page.
      await page.setViewportSize({ width: 1440, height: 2600 });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, `${name}.png`) });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
  };
  const noSideways = async (label: string) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      `no sideways scroll: ${label}`,
    );

  await page.goto(`${origin}/?mode=provider-admin#/characters/jojo`);
  await page.locator('.wb-editor form.character-profile-form').waitFor({ timeout: 20_000 });
  // Named exception (Part 24b-6, Workbench4): 预演 is the editor's last section (one section shows at a time), so it is opened from the bar.
  await page.locator('.wb-tab', { hasText: '预演' }).click();
  await page.locator('#wb-preview .pw').waitFor({ timeout: 20_000 });
  // the old 预演测试 address lands here
  await page.goto(`${origin}/?mode=provider-admin#/preview/jojo`);
  await page.waitForFunction(() => location.hash === '#/characters/jojo');
  assert.equal(await page.locator('.admin-nav [data-page="preview"]').count(), 0, 'no separate 预演测试 page');
  assert.equal(await page.getByRole('button', { name: '打开资料' }).count(), 0, 'no 打开资料 button');
  assert.equal(await page.locator('#wb-roles .admin-pick').count(), 3);
  assert.equal(await page.locator('.colour-field input[type="text"]').inputValue(), '#2BA84A');
  const castSwitch = page.locator('#wb-preview [aria-label="关系与故事"] button');
  assert.deepEqual(await castSwitch.allInnerTexts(), ['不用', '已发布', '草稿']);
  assert.equal(await castSwitch.first().getAttribute('aria-pressed'), 'true');
  await shot('workbench-with-preview');
  await page.locator('.wb-tab', { hasText: '身份与展示' }).click();
  await shot('colour-field', page.locator('.colour-field'));
  // the colour field takes RGB and refuses nonsense
  const colourInput = page.locator('.colour-field input[type="text"]');
  await colourInput.fill('232, 86, 30');
  assert.equal(await page.locator('.colour-chip').getAttribute('data-state'), 'ok');
  await colourInput.fill('nonsense');
  assert.equal(await colourInput.getAttribute('aria-invalid'), 'true');
  await colourInput.fill('#2BA84A');
  for (const width of [1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 1000 });
    await wait(300);
    await noSideways(`角色工作台 ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // The colour field was typed into: leaving needs the edit saved or dropped, as for any unsaved role.
  // Named exception (Part 24b-6): the button reads 放弃本页修改 and sits in the save bar.
  await page.getByRole('button', { name: '放弃本页修改' }).click();
  // 关系与故事
  await page.locator('.admin-nav [data-page="cast"]').click();
  await page
    .locator('.cs-cell[data-from]')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(async (error: unknown) => {
      process.stderr.write(`cast page text: ${(await page.locator('.admin-content').innerText()).slice(0, 600)}\n`);
      throw error;
    });
  // Named exception (Part 24b-6, Cast3): the grid is the workbench roster (3 roles here) plus any cast entry that is not in it (15 sample
  // characters c01..c15), 18 in all; with a real roster the two are the same fifteen.
  assert.equal(await page.locator('.cs-cell[data-from]').count(), 18 * 17);
  const cell = page.locator('.cs-cell[data-from="c02"][data-to="c03"]');
  await cell.hover();
  await cell.click();
  assert.ok((await page.locator('.cs-cell.is-lit').count()) > 20, 'the row and the column light up');
  // star editing: one-way, half stars; record it
  const video = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
    storageState: await context.storageState(),
    ...(shots ? { recordVideo: { dir: join(shots, 'video'), size: { width: 1440, height: 1000 } } } : {}),
  });
  const film = await video.newPage();
  await film.goto(`${origin}/?mode=provider-admin#/cast`);
  await film.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
  for (const [from, to] of [
    ['c02', 'c03'],
    ['c03', 'c02'],
    ['c05', 'c01'],
    ['c01', 'c10'],
  ]) {
    const c = film.locator(`.cs-cell[data-from="${from}"][data-to="${to}"]`);
    await c.hover();
    await film.waitForTimeout(350);
    await c.click();
    await film.waitForTimeout(450);
  }
  const pair = film.locator('.cs-dir[data-from="c01"][data-to="c10"]');
  await pair.locator('.cs-star-hit[aria-label="2.5 星"]').click();
  await film.waitForTimeout(500);
  await pair.locator('.cs-star-hit[aria-label="4 星"]').click();
  await film.waitForTimeout(500);
  await film.locator('.cs-dir[data-from="c10"][data-to="c01"] .cs-star-hit[aria-label="1.5 星"]').click();
  await film.waitForTimeout(500);
  assert.equal(await pair.locator('.cs-rating').getAttribute('data-rating'), '4');
  await film.getByRole('button', { name: '保存草稿' }).click();
  await film
    .getByText('草稿已保存')
    .first()
    .waitFor({ timeout: 10_000 })
    .catch(async (error: unknown) => {
      process.stderr.write(
        `film toasts: ${await film.locator('.admin-toasts').innerText()} / ${await film.locator('.cs-notices').innerText()}\n`,
      );
      throw error;
    });
  await film.waitForTimeout(600);
  await video.close();
  if (shots) {
    const path = await film.video()?.path();
    if (path) renameSync(path, join(shots, 'cast-grid-and-stars.webm'));
  }
  const saved2 = await (await post('cast/draft', {})).json();
  assert.equal(saved2.doc.ratings.c01.c10, 4, 'c01 → c10 saved as 4');
  assert.equal(saved2.doc.ratings.c10.c01, 1.5, 'c10 → c01 saved on its own');

  await page.reload();
  await page.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
  await page.locator('.cs-cell[data-from="c02"][data-to="c03"]').hover();
  await page.locator('.cs-cell[data-from="c02"][data-to="c03"]').click();
  await shot('cast-selected-cell');
  // Named exceptions (Part 24b-6, Cast3): a group is a row of the 组合 table that opens below it; a story opens from the panel of a pair
  // that shares it (the cell marked with the small story dot); its card is .cs-story-card.
  await page.locator('.cs-groups-table .ot-row').first().click();
  await shot('cast-group-panel');
  await page.locator('.cs-cell[data-from]:has(.cs-story-dot)').first().click();
  await page.locator('.cs-story-title').first().click();
  await page.locator('.cs-know-matrix .cs-know:not(.is-override)').nth(4).click();
  assert.equal((await page.locator('.cs-know-matrix .cs-know.is-override').count()) >= 1, true);
  await shot('cast-story-with-override', page.locator('.cs-story-card'));
  // what a character sees
  await page.locator('.cs-head-row').nth(4).click();
  await page.getByText('看到的').first().waitFor();
  await page.waitForFunction(() => document.querySelector('.cs-sees .cs-sees-block'));
  await shot('cast-what-the-character-sees', page.locator('.cs-sees'));
  await shot('cast-full-page');
  for (const width of [1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 1000 });
    await wait(300);
    await noSideways(`关系与故事 ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 共创收件箱
  await page.locator('.admin-nav [data-page="cocreation"]').click();
  await page.locator('.cc-row').first().waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('#admin-cocreation select').count(), 0, 'no dropdowns');
  assert.equal(await page.getByRole('button', { name: '更多' }).count(), 0, 'no 更多 button');
  await page.locator('.cc-filter-chip', { hasText: '★ 只看星标' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cc-row').length === 2);
  await page.locator('.cc-filter-chip', { hasText: '★ 只看星标' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cc-row').length >= 4);
  await page.keyboard.press('j');
  await shot('inbox');
  for (const width of [1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 1000 });
    await wait(300);
    await noSideways(`共创收件箱 ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  // 管理员与权限
  await post('members/issue', {
    requestId: randomUUID(),
    label: '共创写手',
    memberId: null,
    permissions: ['characters.read:*', 'cast.read', 'cocreation.read'],
  });
  await page.locator('.admin-nav [data-page="members"]').click();
  // Named exception (Part 24b-6, Members3): a person's permission grid opens below their row.
  await page.locator('#admin-members-table .ot-row', { hasText: '共创写手' }).waitFor({ timeout: 20_000 });
  await wait(1200);
  // (the first administrator who is not the owner is already open when the page loads)
  await page.locator('.ot-panel[data-state="open"] .permission-matrix').waitFor({ timeout: 20_000 });
  await page.locator('.permission-matrix').first().waitFor({ timeout: 20_000 });
  assert.equal(await page.locator('.permission-help').count(), 0, 'no description lines in the grid');
  assert.equal(await page.locator('details.admin-confirm').count(), 0, 'no fold around 收回全部功能权限');
  await page.getByRole('button', { name: '收回全部功能权限' }).waitFor();
  await page.locator('.ot-panel[data-state="open"] .permission-row').first().hover();
  await wait(300);
  assert.equal(
    await page.locator('.ot-panel[data-state="open"] .permission-row:hover .permission-tip').first().isVisible(),
    true,
    'the tooltip shows on hover',
  );
  await shot('members');
  for (const width of [1280, 1440, 1680]) {
    await page.setViewportSize({ width, height: 1000 });
    await wait(300);
    await noSideways(`管理员与权限 ${width}`);
  }

  // ---- the player's chat with jojo, in the published colour ----
  const chat = await player.newPage();
  chat.on('pageerror', (error: unknown) => errors.push(String(error)));
  await chat.goto(`${origin}/?mode=provider`);
  await chat.waitForTimeout(1500);
  await chat
    .getByText('JOJO', { exact: false })
    .first()
    .click()
    .catch(() => undefined);
  await shotPlayer(chat, 'player-chat-jojo');
  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write('console 24b-2 browser check: PASS\n');
} catch (error) {
  failure = error;
  process.stderr.write(`page errors so far: ${JSON.stringify(pageErrors)}\n`);
} finally {
  await browser.close();
  await app.close();
  store.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
