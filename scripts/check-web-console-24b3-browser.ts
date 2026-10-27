import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
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
 * Part 24b-3: the polished console (one page frame, calmer colours, fixed sidebar, no endless pages) in a REAL browser (Chromium), as the owner sees
 * them, on a real migrated provider-local instance. The cast and the co-creation notes are SYNTHETIC ("[示例]" style fixtures):
 * the cast is the 15-person test fixture, written through the cast API; the notes are rows written straight into the inbox tables.
 * Every console page is opened at 1440×900: one viewport shot (what the administrator sees without scrolling), one full-page shot
 * and the height of the page's working area. The check also asserts the page frame (sticky sidebar, one title-row height, one
 * content width), that no page scrolls sideways at 1280, 1440 and 1680, and that the colours stay out of pure black.
 *
 * usage: node scripts/check-web-console-24b3-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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

  // ---- jojo gets a saved draft (two sections differ from the published profile) so the title row, 发布 and 预演 have something to show ----
  const detail = await (await post('characters/jojo/detail', {})).json();
  const next = structuredClone(detail.published.profile);
  next.template.version = detail.published.version + 1;
  next.template.persona += ' 说话更慢一点。';
  next.presentation.welcome.text += '（新）';
  await post('characters/jojo/save', { expectedRevision: null, profile: next });

  // ---- the cast draft: the 15-person fixture ----
  const cast0 = await (await post('cast/draft', {})).json();
  await post('cast/save', { requestId: randomUUID(), expectedRevision: cast0.revision, doc: sampleCastRaw() });

  // A player's first visit creates the principal the synthetic notes belong to.
  const player = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 420, height: 860 } });
  const home = await player.newPage();
  await home.goto(`${origin}/?mode=provider`);
  await home.locator('button:visible').first().waitFor({ timeout: 20_000 });
  await home.waitForTimeout(1200);
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
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('pageerror', (error: unknown) => errors.push(String(error)));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const wait = (n = 800) => page.waitForTimeout(n);
  const heights: Record<string, number> = {};
  /** The working area of a page: the scrolling content region's height (what a reader would scroll through). */
  const pageHeight = () =>
    page.evaluate(() => {
      const content = document.querySelector('.admin-content') as HTMLElement | null;
      return Math.max(content?.scrollHeight ?? 0, document.documentElement.scrollHeight);
    });
  const shot = async (name: string) => {
    await wait(900);
    heights[name] = await pageHeight();
    if (!shots) return;
    await page.screenshot({ path: join(shots, `${name}.png`) });
    const total = heights[name]!;
    await page.setViewportSize({ width: 1440, height: Math.min(Math.max(total, 900), 6000) });
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, `${name}-full.png`) });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
  };
  const noSideways = async (label: string) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      `no sideways scroll: ${label}`,
    );
  const noSidewaysAll = async (label: string) => {
    for (const width of [1280, 1440, 1680]) {
      await page.setViewportSize({ width, height: 900 });
      await wait(300);
      await noSideways(`${label} ${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  const go = async (route: string, ready: string) => {
    await page.goto(`${origin}/?mode=provider-admin#/${route}`);
    await page.locator(ready).first().waitFor({ timeout: 20_000 });
  };

  await post('members/issue', {
    requestId: randomUUID(),
    label: '共创写手',
    memberId: null,
    permissions: ['characters.read:*', 'cast.read', 'cocreation.read'],
  });
  await go('overview', '.admin-content :is(h1,h2):visible');
  await wait(1200);
  await shot('overview');
  await noSidewaysAll('总览');
  // ---- helpers that read the page as the administrator sees it ----
  /** Visible text that is too faint, and fills that are pure black, anywhere in the console. */
  const paintAudit = () =>
    page.evaluate(() => {
      const parse = (value: string) => {
        const m = /rgba?\(([^)]+)\)/.exec(value);
        if (!m) return null;
        const [r, g, b, a] = m[1]!
          .split(/[ ,/]+/)
          .filter(Boolean)
          .map(Number);
        return { r: r!, g: g!, b: b!, a: a ?? 1 };
      };
      const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const backdrop = (node: Element) => {
        for (let n: Element | null = node; n; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.9) return c;
        }
        return { r: 246, g: 244, b: 241, a: 1 };
      };
      const faint: string[] = [],
        black: string[] = [];
      for (const node of document.querySelectorAll('.admin-shell *')) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height) continue;
        const style = getComputedStyle(node);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        const bg = parse(style.backgroundColor);
        if (bg && bg.a > 0.5 && ((bg.r < 24 && bg.g < 24 && bg.b < 24) || (bg.r === 20 && bg.g === 20 && bg.b === 20)))
          black.push(`${node.tagName}.${(node as HTMLElement).className}`);
        const own = [...node.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim());
        if (!own || (node as HTMLButtonElement).disabled) continue;
        const fg = parse(style.color);
        if (!fg) continue;
        const back = backdrop(node);
        const a = lum(fg),
          b = lum(back);
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        const large =
          parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
        if (ratio < (large ? 3 : 4.5) && Number(style.opacity) === 1)
          faint.push(
            `${ratio.toFixed(2)} ${node.tagName}.${(node as HTMLElement).className} "${(node.textContent ?? '').trim().slice(0, 16)}"`,
          );
      }
      return { faint, black };
    });
  const frame = async (name: string) => {
    const head = await page.locator('.admin-content .page-head:visible').first().boundingBox();
    assert.ok(head, `${name}: a title row`);
    assert.equal(Math.round(head.height), 56, `${name}: title row height`);
    heads[name] = Math.round(head.y);
    const audit = await paintAudit();
    assert.deepEqual(audit.black, [], `${name}: no black fills`);
    assert.deepEqual(audit.faint, [], `${name}: text contrast`);
  };
  const heads: Record<string, number> = {};
  for (const [route, ready, name] of [
    ['characters/jojo', '.wb-editor form.character-profile-form', 'workbench'],
    ['cast', '.cs-cell[data-from]', 'cast'],
    ['cocreation', '.cc-row', 'inbox'],
    ['invites', '.admin-content :is(form,table):visible', 'invites'],
    ['points', '.admin-content :is(form,table):visible', 'points'],
    ['stats', '.admin-content :is(h1,h2):visible', 'stats'],
    ['costs', '.admin-content :is(h1,h2):visible', 'costs'],
    ['models', '.admin-content :is(h1,h2):visible', 'models'],
    ['system', '.admin-content :is(h1,h2):visible', 'system'],
    ['members', '.permission-matrix', 'members'],
    ['account', '.admin-content :is(h1,h2):visible', 'account'],
  ] as const) {
    await go(route, ready);
    await wait(1200);
    await shot(name);
    await frame(name);
    await noSidewaysAll(name);
  }
  assert.equal(
    new Set(Object.values(heads)).size,
    1,
    `every title row starts on the same line: ${JSON.stringify(heads)}`,
  );

  // ---- the sidebar stays while a long page scrolls ----
  await go('cast', '.cs-cell[data-from]');
  const sideBefore = await page.locator('.admin-sidebar').boundingBox();
  await page.mouse.wheel(0, 700);
  await wait(500);
  const scrolled = await page.evaluate(() => window.scrollY);
  assert.ok(scrolled > 300, 'the cast page scrolls');
  const sideAfter = await page.locator('.admin-sidebar').boundingBox();
  assert.equal(Math.round(sideAfter!.y), 0, 'the sidebar did not move');
  assert.equal(Math.round(sideAfter!.height), 900, 'the sidebar is as tall as the window');
  assert.equal(sideBefore!.x, sideAfter!.x);
  await page.evaluate(() => window.scrollTo(0, 0));

  // ---- 角色工作台: one section at a time, edits survive a visit elsewhere, a dot marks the changed section ----
  await go('characters/jojo', '.wb-editor form.character-profile-form');
  const rail = page.locator('#wb-rail .wb-rail-item');
  await page.waitForFunction(() => document.querySelectorAll('#wb-rail .wb-rail-item').length >= 8);
  await wait(500);
  assert.deepEqual(await rail.allInnerTexts(), [
    '身份与展示',
    '欢迎内容',
    '性格',
    '作者设定与样例',
    '声音',
    '资料改动',
    '发布',
    '删除角色',
  ]);
  assert.equal(await page.locator('.wb-card-head h2').innerText(), '身份与展示');
  const visibleSections = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('.wb-card-body > form > :is(fieldset, details)')].filter(
          (n) => (n as HTMLElement).offsetParent,
        ).length,
    );
  assert.equal(await visibleSections(), 1);
  await rail.filter({ hasText: '性格' }).click();
  assert.equal(await page.locator('.wb-card-head h2').innerText(), '性格');
  const persona = page.locator('.wb-card-body textarea').filter({ visible: true }).first();
  await persona.fill('改过的人设');
  assert.equal(await page.locator('#wb-rail .wb-rail-item', { hasText: '性格' }).locator('.wb-dot').isVisible(), true);
  assert.equal(await page.locator('.wb-savestate').innerText(), '未保存 1 处');
  await rail.filter({ hasText: '身份与展示' }).click();
  await rail.filter({ hasText: '发布' }).click();
  assert.equal(await page.locator('#wb-head .admin-primary').isVisible(), false, 'the title-row button hides on 发布');
  await rail.filter({ hasText: '性格' }).click();
  assert.equal(await persona.inputValue(), '改过的人设', 'the edit survived the visit to other sections');
  await rail.filter({ hasText: '删除角色' }).click();
  assert.equal(await page.locator('.wb-card-head h2').innerText(), '删除角色');
  await shot('workbench-delete');
  await rail.filter({ hasText: '发布' }).click();
  await shot('workbench-publish');
  await page.getByRole('button', { name: '放弃本页未保存修改' }).click();
  assert.equal(await page.locator('.wb-dot:visible').count(), 0, 'the dots are gone once the edit is dropped');

  // ---- 共创收件箱: one fixed grid per row, nothing stacked ----
  await go('cocreation', '.cc-row-open');
  await wait(900);
  const rows = await page.locator('.cc-row-open').evaluateAll((nodes: Element[]) =>
    nodes.map((n: Element) => {
      const text = (n.querySelector('.cc-first') as HTMLElement).getBoundingClientRect();
      const state = (n.querySelector('.cc-state') as HTMLElement).getBoundingClientRect();
      return {
        state: state.height,
        textAlign: getComputedStyle(n.querySelector('.cc-first')!).getPropertyValue('text-align'),
        text: text.width,
        x: text.x,
      };
    }),
  );
  for (const row of rows) {
    assert.ok(row.state <= 24, 'the state chip stays on one line');
    assert.equal(row.textAlign, 'left', JSON.stringify(row));
  }
  assert.equal(new Set(rows.map((r: { x: number }) => Math.round(r.x))).size, 1, 'the text column lines up');
  // ---- two short recordings: a long page scrolling under the fixed sidebar, and the workbench switching sections ----
  if (shots) {
    const film = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      storageState: await context.storageState(),
      recordVideo: { dir: join(shots, 'video'), size: { width: 1440, height: 900 } },
    });
    const take = async (name: string, work: (p: typeof page) => Promise<void>) => {
      const p = await film.newPage();
      await work(p);
      await p.waitForTimeout(500);
      const path = await p.video()?.path();
      await p.close();
      if (path) await film.close().catch(() => {});
      if (path) {
        for (let i = 0; i < 20 && !existsSync(path); i++) await new Promise((r) => setTimeout(r, 100));
        renameSync(path, join(shots, `${name}.webm`));
      }
    };
    await take('scroll-with-fixed-sidebar', async (p) => {
      await p.goto(`${origin}/?mode=provider-admin#/cast`);
      await p.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
      await p.waitForTimeout(800);
      for (let i = 0; i < 6; i++) {
        await p.mouse.wheel(0, 320);
        await p.waitForTimeout(450);
      }
      for (let i = 0; i < 6; i++) {
        await p.mouse.wheel(0, -320);
        await p.waitForTimeout(250);
      }
    });
    const film2 = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      storageState: await context.storageState(),
      recordVideo: { dir: join(shots, 'video'), size: { width: 1440, height: 900 } },
    });
    const p2 = await film2.newPage();
    await p2.goto(`${origin}/?mode=provider-admin#/characters/jojo`);
    await p2.locator('#wb-rail .wb-rail-item').first().waitFor({ timeout: 20_000 });
    await p2.waitForTimeout(900);
    const items = p2.locator('#wb-rail .wb-rail-item');
    await items.filter({ hasText: '欢迎内容' }).click();
    await p2.waitForTimeout(700);
    await items.filter({ hasText: '性格' }).click();
    await p2.waitForTimeout(500);
    await p2.locator('.wb-card-body textarea').filter({ visible: true }).first().fill('在这里改一点点');
    await p2.waitForTimeout(900);
    await items.filter({ hasText: '身份与展示' }).click();
    await p2.waitForTimeout(700);
    await items.filter({ hasText: '发布' }).click();
    await p2.waitForTimeout(900);
    await items.filter({ hasText: '性格' }).click();
    await p2.waitForTimeout(900);
    const path2 = await p2.video()?.path();
    await film2.close();
    if (path2) {
      for (let i = 0; i < 20 && !existsSync(path2); i++) await new Promise((r) => setTimeout(r, 100));
      renameSync(path2, join(shots, 'workbench-switch-sections.webm'));
    }
  }
  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write(`console 24b-3 page heights at 1440×900: ${JSON.stringify(heights)}\n`);
  process.stdout.write('console 24b-3 browser check: PASS\n');
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
