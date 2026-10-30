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
import { SAMPLE_NAMES, sampleCastRaw, sampleId } from '../tests/web/fixtures/cast-sample.ts';
import { characterProfileHash } from '../apps/server/characters/web-character-catalog.ts';

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
/**
 * SUPERSEDED in Part 24b-6 (reason): this walk-through pins the Part 24b-3/24b-4 layouts - the pill row of roles, the rail of sections with
 * 删除角色 in it, the start card's + 角色, vertical grid headers, the two-column inbox, modal confirms. The V3 console replaced every one of
 * those (a 64 px rail, one section bar, danger zones, a roster grid with horizontal headers, rows of fixed cards). What it checked that still
 * holds - no sideways scroll at 1280 / 1440 / 1680, one title-row height, the sidebar staying, colours out of pure black, one section at a
 * time - is checked by scripts/check-web-console-24b6-browser.ts on the V3 pages. The body below is kept as it was, unchanged, for history.
 */
if (!process.env.RUN_SUPERSEDED_24B3) {
  process.stdout.write(
    'check-web-console-24b3-browser: SUPERSEDED by check-web-console-24b6-browser.ts (Part 24b-6); not run.\n',
  );
  process.exit(0);
}
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

// ---- Part 24b-4: a cast of 15. Three are the instance's own characters, nine more are live (written straight into the catalog tables,
// as a publication would), and the last three are made on 关系与故事 itself with + 角色 (角色工作台's 新建角色): saved drafts, not yet live in chat, but in the cast. ----
const OWN = ['wei-guagua', 'jojo', 'chen-jimi'] as const;
const TINTS = [
  '#E8561E',
  '#2F7DE1',
  '#7C4DDB',
  '#F2A33A',
  '#3FA776',
  '#E4568F',
  '#2BA6C7',
  '#8E6BD0',
  '#D98B3A',
  '#6CAB4B',
  '#D96A6A',
  '#4F74D9',
];
/** The cast fixture's c01…c15 become the 15 real ids: the 3 own characters, then c04…c15. */
/** The ids of the three characters made through + 角色 on 关系与故事 (c13…c15 of the fixture), in the order they were made. */
const created: string[] = [];
const castId = (fixtureId: string) => {
  const n = Number(fixtureId.slice(1));
  return n <= 3 ? OWN[n - 1]! : n <= 12 ? fixtureId : created[n - 13]!;
};
const liveNew = Array.from({ length: 9 }, (_, i) => sampleId(i + 3));
const template0 = JSON.parse(
  store.get<{ config_json: string }>("SELECT config_json FROM character_templates WHERE id='jojo'")!.config_json,
);
liveNew.forEach((id, i) => {
  const name = SAMPLE_NAMES[Number(id.slice(1)) - 1]!;
  const template = { ...structuredClone(template0), id, name, version: 1, persona: `${name}是一个虚构的高中生。` };
  delete template.voice;
  const profile = {
    template,
    presentation: {
      displayName: name,
      publicDescription: '',
      welcome: { text: `${name}：来啦？`, version: 'welcome-v1' },
      color: TINTS[i]!,
    },
  };
  const config = JSON.stringify(template);
  store.run('INSERT INTO character_templates VALUES (?,?,?)', id, 1, config);
  store.run('INSERT INTO character_template_versions VALUES (?,?,?,NULL)', id, 1, config);
  store.run(
    'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
    id,
    1,
    JSON.stringify(profile),
    characterProfileHash(profile),
  );
  store.run('INSERT INTO web_character_catalog VALUES (?,?,?)', id, 1, i + 3);
});

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
  const SIZES = [
    [1280, 800],
    [1440, 900],
    [1680, 1050],
  ] as const;
  /** A viewport shot and a full-page shot at 1280×800 and 1440×900 (the review material); the height is the one at 1440×900. */
  /** `focus`: a selector scrolled into view before the viewport shot (Part 24b-4: the group and story editors are far down the page). */
  const shot = async (name: string, focus?: string) => {
    for (const [width, height] of SIZES.slice(0, 2)) {
      await page.setViewportSize({ width, height });
      await wait(width === 1440 ? 900 : 700);
      const total = await pageHeight();
      if (width === 1440) heights[name] = total;
      if (!shots) continue;
      if (focus) await page.locator(focus).first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `${name}-${width}.png`) });
      await page.setViewportSize({ width, height: Math.min(Math.max(total, height), 6000) });
      await page.waitForTimeout(500);
      await page.screenshot({ path: join(shots, `${name}-${width}-full.png`) });
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(300);
  };
  const noSideways = async (label: string) =>
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      `no sideways scroll: ${label}`,
    );
  /**
   * The hard rules, read off the page: nothing visible overflows its own box (a scroll area such as a table or a list may), no text
   * is cut with an ellipsis, no chip, badge or button runs onto a second line, and a select is wide enough for the value it shows.
   */
  const overflowAudit = () =>
    page.evaluate(() => {
      const found: string[] = [];
      const name = (n: Element) =>
        `${n.tagName.toLowerCase()}${
          (n as HTMLElement).className
            ? `.${String((n as HTMLElement).className)
                .split(' ')
                .join('.')}`
            : ''
        } "${(n.textContent ?? '').trim().slice(0, 20)}"`;
      const shown = (n: Element) => {
        const box = n.getBoundingClientRect();
        if (box.width < 2 || box.height < 2) return false;
        for (let p: Element | null = n; p; p = p.parentElement) {
          const style = getComputedStyle(p);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
        }
        return true;
      };
      // Lines of TEXT: the element's own text nodes only (Part 24b-4: a colour dot inside a chip is a box, not a line, and its centre
      // can sit in the next 8 px bucket without the label having wrapped).
      const lines = (n: Element) => {
        const tops = new Set<number>();
        for (const child of n.childNodes) {
          if (child.nodeType !== 3 || !(child.textContent ?? '').trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(child);
          for (const r of range.getClientRects()) if (r.width > 0) tops.add(Math.round((r.top + r.bottom) / 2 / 8));
        }
        return tops.size;
      };
      const measure = document.createElement('canvas').getContext('2d')!;
      for (const n of document.querySelectorAll('.admin-shell *')) {
        if (
          [
            'INPUT',
            'TEXTAREA',
            'OPTION',
            'svg',
            'path',
            'circle',
            'rect',
            'line',
            'text',
            'g',
            'use',
            'STYLE',
            'SCRIPT',
            'BR',
          ].includes(n.tagName)
        )
          continue;
        if (n.closest('svg') || n.closest('.sr-only') || !shown(n)) continue;
        const style = getComputedStyle(n);
        const own = [...n.childNodes].some((c) => c.nodeType === 3 && (c.textContent ?? '').trim());
        const scrollArea = ['auto', 'scroll'].includes(style.overflowX);
        if (n.tagName === 'SELECT') {
          const select = n as HTMLSelectElement;
          measure.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
          const width = measure.measureText(select.selectedOptions[0]?.textContent ?? '').width;
          if (width > select.clientWidth - 40)
            found.push(
              `select too narrow for its value: ${name(n)} (${Math.round(width)} > ${select.clientWidth - 40})`,
            );
          continue;
        }
        if (!scrollArea && n.scrollWidth > n.clientWidth + 1)
          found.push(`overflows its box: ${name(n)} (${n.scrollWidth} > ${n.clientWidth})`);
        if (own && style.textOverflow === 'ellipsis') found.push(`ellipsis: ${name(n)}`);
        if (
          n.matches(
            'button, .admin-badge, .cc-chip, .cs-chip-static, .cs-tag, .wb-chip, .cocreation-badge, .ov-status, .cost-chip, .seg-button, .admin-pick-cc, .cs-level, .cs-know, .cs-lived, .cs-chip, .page-kicker, .admin-tag',
          ) &&
          own &&
          lines(n) > 1
        )
          found.push(`wraps inside itself: ${name(n)}`);
      }
      return found;
    });
  const overflow: Record<string, Record<string, string[]>> = {};
  /** Runs the hard-rule audit on the page that is open, at all three sizes. */
  const noSidewaysAll = async (label: string) => {
    overflow[label] = {};
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await wait(500);
      await noSideways(`${label} ${width}`);
      overflow[label]![`${width}x${height}`] = await overflowAudit();
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
  // ---- Part 24b-4: 关系与故事 from the empty start to a cast of 15 -------------------------------------------------------------
  // The first screen of an empty draft is one clear start; 从旧资料导入 brings in every existing (live) character, + 角色 makes a new
  // draft character through the same route as 角色工作台's 新建角色 and adds it to the cast. Then the cast (with three characters that
  // are not live yet) is saved and PUBLISHED, which is what 24a's publish rule used to refuse.
  await go('cast', '.cs-start');
  await wait(900);
  await shot('cast-empty');
  const startButtons = await page
    .locator('.cs-start button')
    .evaluateAll((nodes: Element[]) => nodes.map((n) => [n.textContent, Math.round(n.getBoundingClientRect().height)]));
  // Named exception (Part 24b-5): the start card also offers 导入文件 (a cast file); every button is still 36 high.
  assert.deepEqual(startButtons, [
    ['从旧资料导入', 36],
    ['导入文件', 36],
    ['+ 角色', 36],
  ]);
  await page.getByRole('button', { name: '从旧资料导入', exact: true }).click();
  await page.getByRole('button', { name: '导入', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.cs-head-row').length === 12, null, { timeout: 20_000 });
  const NEW_NAMES = [SAMPLE_NAMES[12]!, SAMPLE_NAMES[13]!, SAMPLE_NAMES[14]!];
  for (const [i, name] of NEW_NAMES.entries()) {
    await page.locator('.cs-grid-card').getByRole('button', { name: '+ 角色', exact: true }).click();
    await page.locator('.cs-adder input').fill(name);
    await page.getByRole('button', { name: '创建', exact: true }).click();
    await page.waitForFunction((n: number) => document.querySelectorAll('.cs-head-row').length === n, 13 + i, {
      timeout: 20_000,
    });
  }
  assert.equal(await page.locator('.cs-head-row').count(), 15);
  assert.equal(
    await page.locator('.cs-grid-card').getByRole('button', { name: '+ 角色', exact: true }).count(),
    0,
    'no + 角色 once the cast is full',
  );
  // The three new ones are saved drafts (角色工作台 lists them), not live characters.
  const listed = (await (await post('characters/list', {})).json()).characters as {
    characterId: string;
    displayName: string;
    publishedVersion: number | null;
    draftRevision: number | null;
  }[];
  for (const name of NEW_NAMES) {
    const row = listed.find((c) => c.displayName === name)!;
    assert.ok(row, `${name} exists as a character`);
    assert.equal(row.publishedVersion, null, `${name} is not live`);
    assert.ok(row.draftRevision !== null, `${name} has a saved draft`);
    created.push(row.characterId);
  }
  await wait(600);
  await shot('cast-added');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('有没保存的修改'), null, { timeout: 20_000 });
  await page.getByRole('button', { name: /^发布 v1$/ }).click();
  await page.getByRole('button', { name: '发布', exact: true }).click();
  await page.waitForSelector('.cs-version[data-version="1"]', { timeout: 20_000 });
  const published = await (await post('cast/versions', {})).json();
  assert.equal(published.latest, 1, 'the cast was published with three characters that are not live');
  assert.equal(published.versions[0].counts.characters, 15);
  // From here on the whole fixture (ratings, groups, stories, people) is the draft.
  const draftNow = await (await post('cast/draft', {})).json();
  const castDoc = JSON.parse(
    JSON.stringify(sampleCastRaw()).replace(/"(c\d\d)"/g, (_, id: string) => `"${castId(id)}"`),
  );
  await post('cast/save', { requestId: randomUUID(), expectedRevision: draftNow.revision, doc: castDoc });
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
  // ---- Part 24b-4: the layout system, read off the page ----
  /**
   * Named exceptions to "every button is 36 or 30 px": the cells and heads of the 关系网 and the star hit areas (sized by the data they
   * show), and the buttons that ARE a whole row or card of a list (inbox row, story row, group card), which hold lines of text.
   */
  const BUTTON_EXEMPT = '.cs-cell, .cs-head, .cs-star-hit, .cc-row-open, .cs-story-title, .cs-group-card';
  /** Buttons that sit side by side in one group, which must be one height. */
  const BUTTON_GROUPS =
    '.cs-bar, .cs-start-actions, .cs-adder-row, .cc-bulk, .cc-detail-actions, .cc-answer-actions, .permission-presets, .wb-savebar-actions, .members-list .admin-member, .cc-adopt-actions';
  const layoutAudit = () =>
    page.evaluate(
      ([exempt, groups]: [string, string]) => {
        const found: string[] = [];
        const content = document.querySelector('.admin-content') as HTMLElement;
        const box = content.getBoundingClientRect();
        const pad = getComputedStyle(content);
        const left = box.left + parseFloat(pad.paddingLeft);
        const right = box.right - parseFloat(pad.paddingRight);
        const section = [...content.querySelectorAll(':scope > section[data-panel]')].find(
          (n) => !(n as HTMLElement).hidden && (n as HTMLElement).offsetParent,
        ) as HTMLElement;
        const visible = (n: Element) => {
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && (n as HTMLElement).offsetParent !== null;
        };
        // 1. the content spans the width: the right edge of the widest card is within 15% of the content's right edge
        let reach = left;
        for (const n of section.querySelectorAll('*')) {
          if (!visible(n)) continue;
          const r = n.getBoundingClientRect();
          const bg = getComputedStyle(n).backgroundColor;
          if (r.width >= 200 && (bg === 'rgb(255, 255, 255)' || bg === 'rgb(251, 250, 248)'))
            reach = Math.max(reach, r.right);
        }
        const unused = (right - reach) / (right - left);
        if (unused > 0.15) found.push(`unused right area ${(unused * 100).toFixed(0)}%`);
        // 2. every button is 36 or 30 high
        for (const b of section.querySelectorAll('button')) {
          if (!visible(b) || b.matches(exempt)) continue;
          const h = Math.round(b.getBoundingClientRect().height);
          if (h !== 36 && h !== 30)
            found.push(`button ${h}px: ${b.className || 'button'} "${(b.textContent ?? '').trim().slice(0, 14)}"`);
        }
        // 3. buttons in one group are one height
        for (const g of section.querySelectorAll(groups)) {
          const heights = new Set(
            [...g.querySelectorAll(':scope > button, :scope > * > button')]
              .filter((b) => visible(b) && !b.matches('.cs-clear'))
              .map((b) => Math.round(b.getBoundingClientRect().height)),
          );
          if (heights.size > 1) found.push(`group ${g.className} has buttons of ${[...heights].join('/')}px`);
        }
        return found;
      },
      [BUTTON_EXEMPT, BUTTON_GROUPS] as [string, string],
    );
  const layoutFindings: string[] = [];
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
    for (const [width, height] of SIZES.slice(0, 2)) {
      await page.setViewportSize({ width, height });
      await wait(500);
      for (const item of await layoutAudit()) layoutFindings.push(`${name} @${width}: ${item}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    await noSidewaysAll(name);
  }
  if (layoutFindings.length) process.stderr.write(`${layoutFindings.join('\n')}\n`);
  assert.deepEqual(layoutFindings, [], 'the layout system holds on every page at 1280×800 and 1440×900');
  assert.equal(
    new Set(Object.values(heads)).size,
    1,
    `every title row starts on the same line: ${JSON.stringify(heads)}`,
  );

  // ---- Part 24b-4: hover help is a light bubble to the lower right of the pointer, never on the item it explains ----
  await go('members', '.members-list .permission-row');
  await wait(600);
  const tipRow = page.locator('.members-list .permission-row').nth(3);
  const rowBox = (await tipRow.boundingBox())!;
  await page.mouse.move(rowBox.x + 40, rowBox.y + rowBox.height / 2);
  await wait(300);
  const tip = await tipRow.locator('.permission-tip').evaluate((n: Element) => {
    const style = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    const rgb = style.backgroundColor.match(/\d+/g)!.map(Number);
    return { bg: rgb, color: style.color, w: r.width, h: r.height, x: r.x, y: r.y, shown: style.display !== 'none' };
  });
  assert.equal(tip.shown, true, 'the help shows on hover');
  assert.ok(Math.min(...tip.bg.slice(0, 3)) >= 245, `the help is on a light background: ${tip.bg}`);
  assert.equal(tip.color, 'rgb(43, 40, 51)', 'its text is #2B2833');
  assert.ok(tip.x > rowBox.x + 40, 'to the right of the pointer');
  assert.ok(tip.y >= rowBox.y + rowBox.height - 1, 'below the hovered item: it does not cover it');
  await shot('members-tooltip');
  // the cost line of 预演 is a tooltip as well
  await go('characters/jojo', '.pw-ack');
  await wait(800);
  await page.locator('.pw-ack').hover();
  await wait(300);
  const costTip = await page
    .locator('.pw-estimate')
    .evaluate((n: Element) => [getComputedStyle(n).display, getComputedStyle(n).backgroundColor, n.textContent]);
  assert.notEqual(costTip[0], 'none');
  assert.equal(costTip[1], 'rgb(255, 255, 255)');
  assert.match(String(costTip[2]), /次付费调用/);
  assert.equal(await page.getByText('固定身份不可修改').count(), 0, 'the leftover explanation line is gone');

  // ---- 共创收件箱: dots with the full name, labelled actions, a bulk bar for several rows ----
  await go('cocreation', '.cc-row-open');
  await wait(900);
  await shot('inbox-one-selected');
  const iconOnly = await page
    .locator('.cc-layout button')
    .evaluateAll((nodes: Element[]) =>
      nodes
        .filter((n) => (n as HTMLElement).offsetParent !== null && !(n.textContent ?? '').trim())
        .map((n) => n.className),
    );
  assert.deepEqual(iconOnly, [], 'no icon-only button in the inbox');
  const detailActions = await page
    .locator('.cc-detail-actions button')
    .evaluateAll((nodes: Element[]) =>
      nodes.map((n) => [(n.textContent ?? '').trim(), Math.round(n.getBoundingClientRect().height)]),
    );
  assert.deepEqual(
    detailActions.map((a: (string | number)[]) => a[0]),
    ['★ 已星标', '标为已处理', '归档'],
  );
  assert.ok(
    detailActions.every((a: (string | number)[]) => a[1] === 30),
    'the detail actions are compact',
  );
  const names = await page
    .locator('.cc-row-open .cc-name')
    .evaluateAll((nodes: Element[]) =>
      nodes.map((n) => [n.querySelector('.cs-dot') !== null, (n.textContent ?? '').trim()]),
    );
  assert.ok(
    names.every((n: (string | boolean)[]) => n[0] === true && String(n[1]).length >= 2),
    'a colour dot and the full name',
  );
  await page.locator('.cc-row input[type="checkbox"]').nth(0).check();
  await page.locator('.cc-row input[type="checkbox"]').nth(1).check();
  await page.locator('.cc-row input[type="checkbox"]').nth(3).check();
  await wait(400);
  const bulk = await page
    .locator('.cc-bulk button')
    .evaluateAll((nodes: Element[]) =>
      nodes.map((n) => [(n.textContent ?? '').trim(), Math.round(n.getBoundingClientRect().height)]),
    );
  assert.deepEqual(bulk, [
    ['标为已处理（3）', 30],
    ['归档所选（3）', 30],
    ['取消选择', 30],
  ]);
  await shot('inbox-several-selected');
  await page.getByRole('button', { name: '取消选择' }).click();
  assert.equal(await page.locator('.cc-bulk').isVisible(), false, 'the bulk bar goes away with the selection');

  // ---- 关系与故事: every editor, with cast.edit and with cast.read only ----
  await go('cast', '.cs-cell[data-from]');
  await wait(900);
  assert.equal(await page.locator('.cs-version[data-version="1"]').count(), 1);
  // a group with members picked
  await page.locator('.cs-group-card').nth(1).click();
  const memberChips = page.locator('.cs-groups-card .cs-picker .cs-chip');
  const pressed = () =>
    memberChips.evaluateAll((n: Element[]) => n.filter((c) => c.getAttribute('aria-pressed') === 'true').length);
  const before = await pressed();
  await memberChips.filter({ hasNotText: /^$/ }).nth(14).click();
  assert.equal(await pressed(), before + (before < 15 ? 1 : 0));
  await page.locator('.cs-groups-card .cs-picker').scrollIntoViewIfNeeded();
  await shot('cast-group-members', '.cs-groups-card .cs-picker');
  // a story with participants picked (characters and people)
  await page.locator('.cs-story-title').nth(2).click();
  const people = page.locator('.cs-stories .cs-picker .cs-chip.is-person');
  assert.ok((await people.count()) >= 1, 'people are in the participant picker');
  const storyBefore = await page.locator('.cs-stories .cs-picker .cs-chip[aria-pressed="true"]').count();
  await people.first().click();
  await page.locator('.cs-stories .cs-picker .cs-chip:not(.is-person)').nth(12).click();
  const storyAfter = await page.locator('.cs-stories .cs-picker .cs-chip[aria-pressed="true"]').count();
  assert.ok(storyAfter !== storyBefore, 'the picker changed the participants');
  await page.locator('.cs-stories .cs-picker').scrollIntoViewIfNeeded();
  await shot('cast-story-participants', '.cs-stories .cs-picker');
  // a person is added and edited here
  await page.getByRole('button', { name: '+ 人物', exact: true }).click();
  await page.locator('.cs-adder input').fill('新来的邻居');
  await page.getByRole('button', { name: '创建', exact: true }).click();
  assert.ok((await page.locator('.cs-person-row').count()) >= 7);
  await page.locator('.cs-people-card input[type="text"]').first().fill('新来的邻居阿姨');
  assert.equal(
    await page
      .locator('.cs-person-row')
      .last()
      .innerText()
      .then((t: string) => t.includes('新来的邻居')),
    true,
  );
  // the grid at 15×15: names on both axes, the selected row and column lit
  await page.locator('.cs-cell[data-from][data-to]').nth(20).click();
  const grid = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.cs-head-row .cs-head-name')].map((n) => (n.textContent ?? '').trim()),
    cols: [...document.querySelectorAll('.cs-head-col .cs-head-name')].map((n) =>
      (n.textContent ?? '').replace(/\n/g, ''),
    ),
    litRows: document.querySelectorAll('.cs-head-row.is-lit').length,
    litCols: document.querySelectorAll('.cs-head-col.is-lit').length,
    cells: [...document.querySelectorAll('.cs-cell[data-from]')].every(
      (c) => c.getBoundingClientRect().width >= 22 && c.getBoundingClientRect().height >= 30,
    ),
  }));
  assert.equal(grid.rows.length, 15);
  assert.deepEqual(grid.rows, grid.cols, 'the same names on both axes');
  assert.ok(
    grid.rows.every((n: string) => n.length >= 2),
    'whole names, not one character',
  );
  assert.deepEqual([grid.litRows, grid.litCols, grid.cells], [1, 1, true]);
  // read-only and edit-only members
  const asMember = async (permissions: string[]) => {
    const issued = await (
      await post('members/issue', {
        requestId: randomUUID(),
        label: `验证${permissions.length}`,
        memberId: null,
        permissions,
      })
    ).json();
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
    const login = await ctx2.request.post(`${API}/admin/login`, {
      data: { token: issued.token },
      headers: { origin: config.origin },
    });
    assert.equal(login.status(), 200);
    const p2 = await ctx2.newPage();
    await p2.goto(`${origin}/?mode=provider-admin#/cast`);
    await p2.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
    await p2.waitForTimeout(700);
    return { p2, ctx2 };
  };
  const reader = await asMember(['cast.read']);
  const readerState = await reader.p2.evaluate(() => ({
    editable: document.querySelectorAll('.cs input[type="text"]:not([readonly]), .cs textarea:not([readonly])').length,
    adds: [...document.querySelectorAll('.cs button')].filter((b) =>
      /^\+ |^删除|^从阵容移除|^保存草稿$|^发布 v|^回滚/.test((b.textContent ?? '').trim()),
    ).length,
    stars: [...document.querySelectorAll('.cs-star-hit')].every((b) => (b as HTMLButtonElement).disabled),
    know: [...document.querySelectorAll('.cs-know')].every((b) => (b as HTMLButtonElement).disabled),
    chips: [...document.querySelectorAll('.cs-picker .cs-chip')].every((b) => (b as HTMLButtonElement).disabled),
  }));
  assert.deepEqual(
    readerState,
    { editable: 0, adds: 0, stars: true, know: true, chips: true },
    'cast.read alone cannot change anything',
  );
  await reader.ctx2.close();
  const editor = await asMember(['cast.read', 'cast.edit']);
  await editor.p2.locator('.cs-pair-texts input').first().fill('可以改');
  assert.equal(
    await editor.p2.getByRole('button', { name: '保存草稿', exact: true }).count(),
    1,
    'editing shows 保存草稿',
  );
  assert.equal(await editor.p2.getByRole('button', { name: /^发布 v/ }).count(), 0, 'cast.edit alone cannot publish');
  assert.equal(
    await editor.p2.getByRole('button', { name: '+ 角色', exact: true }).count(),
    0,
    'no + 角色 without characters.create',
  );
  assert.ok((await editor.p2.getByRole('button', { name: '+ 故事', exact: true }).count()) >= 1);
  await editor.p2.locator('.cs-story-title').first().click();
  await editor.p2.locator('.cs-stories input[type="text"]').first().fill('改过的标题');
  await editor.p2.getByRole('button', { name: '保存草稿', exact: true }).click();
  await editor.p2.waitForFunction(() => !document.body.innerText.includes('有没保存的修改'), null, { timeout: 20_000 });
  await editor.ctx2.close();

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
  const rail = page.locator('.wb-card .wb-rail-item');
  await page.waitForFunction(() => document.querySelectorAll('.wb-card .wb-rail-item').length >= 8);
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
  assert.equal(await page.locator('.wb-card .wb-rail-item', { hasText: '性格' }).locator('.wb-dot').isVisible(), true);
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

  // ---- every section of the workbench and of a character panel obeys the same hard rules, at every size ----
  const sectionFindings: string[] = [];
  const sweep = async (label: string, tabs: string, ready: () => Promise<void>) => {
    for (const [width, height] of SIZES) {
      await page.setViewportSize({ width, height });
      await wait(400);
      const count = await page.locator(tabs).count();
      for (let i = 0; i < count; i++) {
        await page.locator(tabs).nth(i).click();
        await ready();
        await page.waitForTimeout(350);
        const name = await page.locator(tabs).nth(i).innerText();
        for (const item of await overflowAudit()) sectionFindings.push(`${label} ${name} @${width}x${height}: ${item}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 900 });
  };
  await go('characters/jojo', '.wb-card .wb-rail-item');
  await page.waitForFunction(() => document.querySelectorAll('.wb-card .wb-rail-item').length >= 8);
  await wait(500);
  if (process.env.DEBUG_WB) {
    await page.locator('.wb-card .wb-rail-item', { hasText: '发布' }).click();
    process.stderr.write(
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll('.wb-card-body details')]
            .filter((n) => (n as HTMLElement).offsetParent)
            .map((n) => {
              const c = getComputedStyle(n);
              return {
                w: n.getBoundingClientRect().width,
                display: c.display,
                cols: c.gridTemplateColumns,
                cls: n.className,
              };
            }),
        ),
      ) + '\n',
    );
  }
  await sweep('角色工作台', '.wb-card .wb-rail-item', async () => {});
  await go('cast', '.cs-cell[data-from]');
  await wait(800);
  await sweep('关系与故事', '.cs-character .wb-rail-item', async () => {});
  if (sectionFindings.length) process.stderr.write(`${sectionFindings.join('\n')}\n`);
  assert.deepEqual(sectionFindings, [], 'every section obeys the hard rules');

  // ---- 共创收件箱: one fixed grid per row, nothing stacked ----
  await go('cocreation', '.cc-row-open');
  await wait(900);
  if (process.env.DEBUG_CC)
    process.stderr.write(
      JSON.stringify(
        await page.evaluate(() =>
          [...document.querySelectorAll('.cc-row-open')].slice(0, 2).map((n) =>
            [...n.children].map((c) => {
              const r = c.getBoundingClientRect();
              return [c.className, Math.round(r.x), Math.round(r.width), c.scrollWidth];
            }),
          ),
        ),
      ) + '\n',
    );
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
    await p2.locator('.wb-card .wb-rail-item').first().waitFor({ timeout: 20_000 });
    await p2.waitForTimeout(900);
    const items = p2.locator('.wb-card .wb-rail-item');
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
  const failures = Object.entries(overflow).flatMap(([label, sizes]) =>
    Object.entries(sizes).flatMap(([size, list]) => list.map((item) => `${label} @${size}: ${item}`)),
  );
  process.stdout.write(
    `overflow check per page: ${Object.entries(overflow)
      .map(([label, sizes]) => `${label} ${Object.values(sizes).every((l) => !l.length) ? 'ok' : 'FAIL'}`)
      .join(' · ')}\n`,
  );
  if (failures.length)
    process.stderr.write(`${[...new Set(failures.map((f) => f.replace(/@\d+x\d+/, '@size')))].join('\n')}\n`);
  assert.deepEqual(failures, [], 'the hard rules hold on every page at 1280×800, 1440×900 and 1680×1050');
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
