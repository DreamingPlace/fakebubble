import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
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
import { characterProfileHash } from '../apps/server/characters/web-character-catalog.ts';

/**
 * Part 24f in a REAL browser (Chromium) on a real migrated provider-local instance with synthetic data: 版本历史 and 恢复此版本 in
 * 角色工作台 as the owner and as a non-owner, 管理员与权限 without a delete item, and the delete control hidden or refused for
 * everyone but the owner. Versions are written the way a publication writes them (rows straight into the version tables, "[示例]"
 * data); the colour-only publication and the restore themselves go through the real routes.
 *
 * usage: node scripts/check-web-history-24f-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const DAY = 86_400_000;
const ID = 'wei-guagua';
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-history-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection(), NOW - 20 * DAY);
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
  const login = async (token: string) => {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    const response = await context.request.post(`${API}/admin/login`, {
      data: { token },
      headers: { origin: config.origin },
    });
    assert.equal(response.status(), 200);
    const csrf = (await response.json()).csrf as string;
    const post = (path: string, data: unknown) =>
      context.request.post(`${API}/admin/${path}`, { data, headers: { origin: config.origin, 'x-csrf-token': csrf } });
    return { context, csrf, post };
  };
  const owner = await login(admins.issueLoginGrant().token);
  const okPost = async (who: typeof owner, path: string, data: unknown) => {
    const response = await who.post(path, data);
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response.json();
  };

  // ---- 版本 of wei-guagua: written as a publication writes them, newest last ----
  const ownerId = store.get<{ id: string }>("SELECT id FROM web_admin_members WHERE role='owner'")!.id;
  const seed = (await okPost(owner, `characters/${ID}/detail`, {})).published as { version: number; profile: any };
  const SEED = seed.version;
  const publishRow = (at: number, change: (profile: any) => void) => {
    const live = JSON.parse(
      store.get<{ profile_json: string }>(
        'SELECT profile_json FROM web_character_versions WHERE character_id=? ORDER BY version DESC LIMIT 1',
        ID,
      )!.profile_json,
    );
    const profile = structuredClone(live);
    profile.template.version = live.template.version + 1;
    change(profile);
    const configJson = JSON.stringify(profile.template);
    store.run('INSERT INTO character_template_versions VALUES (?,?,?,?)', ID, profile.template.version, configJson, at);
    store.run(
      'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
      profile.template.version,
      configJson,
      ID,
    );
    store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,?)',
      ID,
      profile.template.version,
      JSON.stringify(profile),
      characterProfileHash(profile),
      at,
    );
    store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', profile.template.version, ID);
    store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      ownerId,
      `character-published:${profile.template.version}`,
      ID,
      at,
    );
  };
  // SEED+1: a new welcome line (its clip was never made: this version can never be restored) and a longer persona.
  publishRow(NOW - 12 * DAY, (p) => {
    p.presentation.welcomes = [{ id: 'welcome-draft', text: '（示例）新的欢迎词，还没有配音', weight: 100 }];
    p.template.persona += '\n她偶尔会提起自己的奶茶店。';
  });
  // SEED+2: back to the approved welcome line, a different persona.
  publishRow(NOW - 6 * DAY, (p) => {
    p.presentation.welcomes = structuredClone(seed.profile.presentation.welcomes);
    p.template.persona = `${seed.profile.template.persona}\n说话更慢一点，爱用省略号。`;
    p.presentation.publicDescription = '（示例）慢热的邻家同学';
  });
  // SEED+3: the main colour only, through the real route (no 预演 needed).
  {
    const live = (await okPost(owner, `characters/${ID}/detail`, {})).published.profile;
    live.template.version += 1;
    live.presentation.color = '#E8561E';
    const saved = await okPost(owner, `characters/${ID}/save`, { expectedRevision: null, profile: live });
    await okPost(owner, `characters/${ID}/publish`, {
      requestId: randomUUID(),
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      acknowledgeReview: true,
    });
  }
  // A saved draft on jojo so the workbench has its usual company; wei-guagua gets one too (based on the live version).
  const jojo = (await okPost(owner, 'characters/jojo/detail', {})).published.profile;
  jojo.template.version += 1;
  jojo.template.persona += ' 说话更慢一点。';
  await okPost(owner, 'characters/jojo/save', { expectedRevision: null, profile: jojo });
  const LIVE = SEED + 3;

  // ---- a non-owner who may read, edit and manage categories ----
  const memberGrant = await okPost(owner, 'members/issue', {
    requestId: randomUUID(),
    label: '共创写手',
    memberId: null,
    permissions: ['category.characters', 'category.publication', 'characters.read:*', 'cocreation.read'],
  });
  const helper = await login(memberGrant.token);

  const pageOf = async (who: typeof owner, route: string, ready: string) => {
    const page = await who.context.newPage();
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (message: { type: () => string; text: () => string }) => {
      // A refused request is logged by the browser as a failed load; the response listener below judges it.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(`console: ${message.text()}`);
    });
    page.on('response', (response: { status: () => number; url: () => string }) => {
      // Refusals asked for on purpose are listed by the test that asks (see `expected`); anything else is an error.
      if (response.status() >= 400 && !expected.some((e) => response.url().endsWith(e)))
        errors.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${origin}/?mode=provider-admin#/${route}`);
    await page.locator(ready).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(700);
    return page;
  };
  const expected: string[] = [];
  const snap = async (page: any, name: string) => {
    await page.waitForTimeout(500);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const rail = (page: any, label: string) => page.locator('.wb-card .wb-tab', { hasText: label });
  // Named exception (Part 24b-6b): the list is the console's open-below table (.ot-row), one row per version; the snapshot opens BELOW its
  // row and 恢复此版本 asks IN its row (no side drawer, no dialog), and only the latest 5 versions are listed.
  const rows = (page: any) => page.locator('.vh .ot-row');
  const detailOf = (page: any, version: number) =>
    page.locator(`.vh [data-key="${version}"] .ot-panel[data-state="open"]`);

  // =============== the owner: history list ===============
  const page = await pageOf(owner, `characters/${ID}`, '.wb-card .wb-tab');
  assert.equal(await rail(page, '版本历史').count(), 1, '版本历史 is in the rail');
  await rail(page, '版本历史').click();
  await rows(page).first().waitFor();
  assert.equal(await rows(page).count(), 4, 'every published version is listed');
  const text = async (row: number) => ((await rows(page).nth(row).innerText()) as string).replace(/\s+/g, ' ');
  assert.match(await text(0), new RegExp(`v${LIVE} 当前 2026-10-24 09:30 UTC 主管理员 仅改主色 只改了主色`)); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「现行」
  assert.match(await text(1), new RegExp(`v${SEED + 2} .* 主管理员 发布 改动：身份与展示、欢迎词、人设`));
  assert.match(await text(2), new RegExp(`v${SEED + 1} .* 主管理员 发布 改动：欢迎词、人设 .*不可恢复`));
  assert.match(await text(3), new RegExp(`v${SEED} .* 系统导入 发布 初始版本`));
  assert.ok(!/@/.test(await page.locator('.vh').innerText()), 'no email or id in the list');
  assert.equal(await page.locator('.vh [data-restore]').count(), 2, 'restore on the two restorable non-live versions');
  assert.equal(await rows(page).nth(0).locator('[data-restore]').count(), 0, 'no restore on the live version');
  assert.equal(await rows(page).nth(2).locator('[data-restore]').count(), 0, 'no restore on a 不可恢复 version');
  await snap(page, '01-history-list');

  // =============== the hard rules, at three window sizes ===============
  // Nothing sideways, no clipped label, no chip, badge or button on a second line, no ellipsis, the rail inside its card.
  const audit = () =>
    page.evaluate(() => {
      const found: string[] = [];
      const name = (n: Element) =>
        `${n.tagName.toLowerCase()}.${String((n as HTMLElement).className).split(' ')[0]} "${(n.textContent ?? '').trim().slice(0, 16)}"`;
      const wrap = document.querySelector('.vh .ot') as HTMLElement | null;
      if (wrap && wrap.scrollWidth > wrap.clientWidth + 1) found.push('the table scrolls sideways');
      if (document.documentElement.scrollWidth > document.documentElement.clientWidth)
        found.push('the page scrolls sideways');
      for (const n of document.querySelectorAll('.vh button, .vh .admin-badge, .vh-version')) {
        const box = n.getBoundingClientRect();
        if (box.width > 0 && box.height > 40) found.push(`on two lines: ${name(n)}`);
      }
      for (const n of document.querySelectorAll('.vh *'))
        if (getComputedStyle(n).textOverflow === 'ellipsis') found.push(`ellipsis: ${name(n)}`);
      const card = document.querySelector('.wb-card')?.getBoundingClientRect();
      for (const n of document.querySelectorAll('.wb-card .wb-tab')) {
        const box = n.getBoundingClientRect();
        if (card && (box.right > card.right || box.left < card.left)) found.push(`tab outside the card: ${name(n)}`);
      }
      return found;
    });
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1680, 1050],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);
    assert.deepEqual(await audit(), [], `layout rules at ${width}×${height}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);

  // =============== a snapshot with its difference from the live version ===============
  await rows(page).nth(3).click();
  const drawer = detailOf(page, SEED);
  await drawer.locator('.vh-title').first().waitFor();
  const drawerText = (await drawer.innerText()) as string;
  assert.equal(
    await page.locator('.admin-drawer:not([hidden]), .admin-dialog').count(),
    0,
    'no drawer and no dialog is open',
  );
  const rowBox = await rows(page).nth(3).boundingBox();
  const panelBox = await drawer.boundingBox();
  assert.ok(panelBox.y >= rowBox.y + rowBox.height - 2, 'the detail opens directly below its row');
  assert.match(drawerText, /完整快照（只读）/);
  assert.match(drawerText, /与正式版本的差异/); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「与现行版本的差异」
  assert.equal(await drawer.locator('textarea, input').count(), 0, 'the snapshot is read only');
  assert.ok((await drawer.locator('.pd-grid').count()) >= 2, 'the diff uses the 资料改动 comparison');
  assert.match(drawerText, /主色/, 'the colour differs from live');
  await snap(page, '02-snapshot-and-diff');

  // =============== the restore confirm ===============
  await rows(page).nth(3).locator('[data-restore]').click();
  const confirm = page.locator('.vh .vh-confirm');
  await confirm.waitFor();
  assert.equal(
    ((await confirm.locator('.vh-confirm-text').innerText()) as string).trim(),
    `以 v${LIVE + 1} 重新发布 v${SEED} 的内容`,
  );
  assert.equal(await page.locator('.admin-dialog, dialog[open]').count(), 0, 'the question is inline, not a dialog');
  await snap(page, '03-restore-confirm');
  await confirm.getByRole('button', { name: '取消' }).click();
  assert.equal(await page.locator('.vh .vh-confirm').count(), 0);
  await rows(page).nth(3).click();

  // =============== 不可恢复: the row, and a direct call ===============
  await snap(page, '04-unrestorable-row');
  expected.push(`/characters/${ID}/restore`);
  const direct = await owner.post(`characters/${ID}/restore`, {
    requestId: randomUUID(),
    version: SEED + 1,
    liveVersion: LIVE,
  });
  assert.equal(direct.status(), 409);
  assert.equal((await direct.json()).error.code, 'CHARACTER_VERSION_NOT_RESTORABLE');

  // =============== busy: an unfinished player task refuses the restore, and nothing is cancelled ===============
  store.db.exec('PRAGMA foreign_keys=OFF');
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at)
     VALUES ('busy-op','p','r','h','w','c',?,'m','i','text_running','reserved',?,?)`,
    ID,
    NOW,
    NOW + 60_000,
  );
  await rows(page).nth(1).locator('[data-restore]').click();
  await page.locator('.vh').getByRole('button', { name: '确认恢复' }).click();
  await page.locator('.vh .vh-note[role="status"]:not([hidden])').waitFor({ timeout: 5000 });
  // The toast says the same as the note under the intro; the picture is taken once it has gone, so it covers nothing.
  await page.locator('.admin-toast').waitFor({ state: 'detached', timeout: 8000 });
  await snap(page, '05-restore-busy');
  assert.match(await page.locator('.vh .vh-note[role="status"]').innerText(), /未结束的玩家任务.*不会取消或重发/);
  assert.equal(
    store.get<{ status: string }>("SELECT status FROM web_operations WHERE id='busy-op'")!.status,
    'text_running',
  );
  assert.equal(
    store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions WHERE character_id=?', ID)!.n,
    4,
  );
  await snap(page, '05-restore-busy');
  store.run("DELETE FROM web_operations WHERE id='busy-op'");
  store.db.exec('PRAGMA foreign_keys=ON');

  // =============== restore, for real ===============
  const draftBase = (await okPost(owner, `characters/${ID}/detail`, {})).draft;
  await rows(page).nth(1).locator('[data-restore]').click();
  await page.locator('.vh').getByRole('button', { name: '确认恢复' }).click();
  await page.locator('.vh .ot-row').nth(4).waitFor();
  assert.equal(await rows(page).count(), 5);
  assert.match(await text(0), new RegExp(`v${LIVE + 1} 当前 .* 主管理员 恢复自 v${SEED + 2}`)); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「现行」
  assert.equal(
    await rows(page).nth(1).locator('.admin-badge', { hasText: '当前' }).count(), // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「现行」
    0,
    'only one live version',
  );
  await snap(page, '06-after-restore');
  const detail = await okPost(owner, `characters/${ID}/detail`, {});
  assert.equal(detail.published.version, LIVE + 1);
  assert.equal(draftBase, detail.draft, 'a draft (here none) is untouched');
  assert.equal(
    store.get<{ n: number }>(
      'SELECT count(*) n FROM web_admin_audit WHERE action=?',
      `restore:v${SEED + 2}->v${LIVE + 1}`,
    )!.n,
    1,
    'one audit row per restore',
  );

  // =============== the stale draft, shown the way the draft panel already shows an old base ===============
  {
    // A draft saved on the live version, then a restore beneath it.
    const live = (await okPost(owner, `characters/${ID}/detail`, {})).published.profile;
    live.template.version += 1;
    live.template.persona += '\n（示例）草稿里新写的一句。';
    const saved = await okPost(owner, `characters/${ID}/save`, { expectedRevision: null, profile: live });
    await okPost(owner, `characters/${ID}/restore`, { requestId: randomUUID(), version: SEED, liveVersion: LIVE + 1 });
    const after = (await okPost(owner, `characters/${ID}/detail`, {})).draft;
    assert.deepEqual(
      [after.revision, after.contentHash, after.baseVersion],
      [saved.revision, saved.contentHash, LIVE + 1],
    );
    assert.equal((await okPost(owner, `characters/${ID}/detail`, {})).published.version, LIVE + 2);
    await page.reload();
    await page.locator('.wb-card .wb-tab').first().waitFor();
    await page.waitForTimeout(900);
    const chip = (await page.locator('.head-status', { hasText: '草稿' }).innerText()) as string;
    assert.match(chip, /草稿/, 'the draft chip still shows the draft');
    await rail(page, '发布').click();
    await page.waitForTimeout(500);
    await snap(page, '07-stale-draft');
    expected.push(`/characters/${ID}/publish`);
    const stale = await owner.post(`characters/${ID}/publish`, {
      requestId: randomUUID(),
      draftRevision: saved.revision,
      profileHash: saved.contentHash,
      previewId: 'x',
      acknowledgeReview: true,
    });
    assert.equal(stale.status(), 409);
    assert.equal((await stale.json()).error.code, 'LIVE_VERSION_CONFLICT');
  }

  // =============== owner: delete is there, and asks for its confirmation ===============
  assert.equal(await page.locator('#wb-delete').count(), 1, 'the owner sees 删除角色 in the danger zone of 发布');

  // =============== the non-owner: history yes, restore no, delete neither shown nor accepted ===============
  const view = await pageOf(helper, `characters/${ID}`, '.wb-card .wb-tab');
  assert.equal(await rail(view, '删除角色').count(), 0, 'no 删除角色 entry in the bar');
  await rail(view, '发布').click();
  assert.equal(await view.locator('#wb-delete').count(), 0, 'no danger-zone 删除角色 for a non-owner');
  assert.equal(await view.getByRole('button', { name: /删除/ }).count(), 0, 'no delete button anywhere on the page');
  await rail(view, '版本历史').click();
  await rows(view).first().waitFor();
  // Named exception (Part 24b-6b): six versions exist by now, and the list shows the latest 5 (the older one stays in the database).
  assert.equal(await rows(view).count(), 5, 'the non-owner sees the latest five versions');
  // Named exception (Part 24b-6c): the count is the visible text, the explanation is its hover tip.
  assert.equal((await view.locator('.vh .vh-more').innerText()).replace(/\s+/g, ''), '共6个');
  assert.match((await view.locator('.vh .vh-more').textContent()) ?? '', /只列出最近 5 个版本，共 6 个/);
  assert.equal(await view.locator('[data-restore]').count(), 0, 'no restore button for a non-owner');
  await snap(view, '08-non-owner-list');
  await rows(view).nth(2).click();
  await view.locator('.vh .ot-panel[data-state="open"] .admin-kv').first().waitFor();
  assert.equal(await view.locator('.vh [data-restore]').count(), 0, 'nor in the snapshot');
  await snap(view, '08b-non-owner-snapshot');
  expected.push(`/characters/${ID}/delete-preview`, `/characters/${ID}/delete-start`, `/characters/${ID}/restore`);
  for (const [path, body] of [
    ['delete-preview', {}],
    ['delete-start', { requestId: randomUUID(), previewHash: 'a'.repeat(64), acknowledgeDeleteAllChats: true }],
    ['restore', { requestId: randomUUID(), version: SEED, liveVersion: LIVE + 2 }],
  ] as const) {
    const response = await helper.post(`characters/${ID}/${path}`, body);
    assert.equal(response.status(), 403, `non-owner ${path}`);
  }

  // =============== 管理员与权限: no delete anywhere, an old stored grant is shown as dead ===============
  await okPost(owner, 'members/issue', {
    requestId: randomUUID(),
    label: '旧授权',
    memberId: null,
    permissions: ['characters.read:*', 'characters.delete:*'],
  });
  const members = await pageOf(owner, 'members', '.account-admin-page .permission-matrix');
  assert.equal(await members.locator('[data-permission="characters.delete"]').count(), 0, 'no delete item');
  await members.waitForTimeout(1800); // let the page finish its own reads before a row is opened
  const oldRow = members.locator('.ot-row', { hasText: '旧授权' }).first();
  if ((await oldRow.getAttribute('aria-expanded')) !== 'true') await oldRow.click({ position: { x: 14, y: 8 } });
  // Named exception (Part 24b-6c): the row's hover tip now lists what is held by name, so the same words also sit in that tip. The grid's own
  // entry (class permission-dead) is what these checks look at.
  const dead = members.locator('.permission-dead', { hasText: '删除角色（已失效）' });
  await dead.waitFor({ timeout: 10_000 });
  await members.waitForTimeout(600);
  await snap(members, '09-members-without-delete');
  // The add form (no stored grant) has no delete row at all; the old stored grant is named, never shown as a raw key.
  assert.equal(await dead.count(), 1, 'the old grant reads 删除角色（已失效）');
  assert.equal(await members.getByText(/characters\.delete/).count(), 0, 'never the raw key');

  assert.deepEqual(errors, [], 'no page errors, no unexpected failed requests');
  process.stdout.write('history 24f browser check: PASS\n');
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
