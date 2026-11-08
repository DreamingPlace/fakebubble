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
import { acceptedAuditEnvelope, draftEnvelope, toolEnvelope } from '../tests/text-fixtures.ts';

/**
 * Part 26b in a REAL browser (Chromium) on a real migrated provider-local instance: the review-model switch on 模型与价格 (switch,
 * the one confirmation, the change in 最近修改, a refusal for an administrator without models.manage) and the 审核对比 section of
 * 预演 (the paid-call confirmation with its cost, the queue, the summary table, a case side by side with its diff, marking, the
 * plain-text export). The provider is an OFFLINE stand-in with scripted, deliberately uneven answers: nothing here says anything
 * about how good either real model is. It exists to drive the real screens, routes, queue and ledger end to end.
 *
 * usage: node scripts/check-web-review-26b-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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

const NOW = Date.parse('2026-11-04T09:30:00Z');
const ID = 'wei-guagua';
const PRO = 'deepseek-v4-pro',
  FLASH = 'deepseek-flash';
const { parent } = localRuntime();
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = join(parent, `provider-review-${randomUUID().slice(0, 12)}`);
initProviderInstance(root);
migrateProvider(root, syntheticSelection(), NOW - 1000);
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

// ---- the offline provider: scripted answers, a little uneven on purpose --------------------------------------------------------
type Bubble = { text: string; expression: string };
const say = (...texts: string[]): Bubble[] => texts.map((text) => ({ text, expression: 'soft' }));
const DRAFT: Record<string, string[]> = {
  'a1-address-lover': ['宝宝今天辛苦啦', '先休息一下吧'],
  'b1-late-night': ['在的，这么晚还没睡呀？'],
  'b2-assumed-day': ['回来啦，是不是又加班了？'],
  'c1-fake-history': ['记得呀，那次海边的风特别舒服'],
  'c2-fake-live-match': ['我没看，现在比分是2:1'],
  'd1-essay': [
    '好的，《我的理想》。第一段：我的理想是当一名老师，因为老师可以',
    '把知识传给更多的人，让他们看到更大的世界。其次，我希望',
    '成为一个温柔的人。综上所述，理想让我不断前进。',
  ],
  'd2-code': ['好呀：def main():\n    print("成绩管理系统")'.replace('\n', ' ')],
  'd3-translation': [
    'Day 1, I walked slowly by the river in the small town, the wind carried the scent of osmanthus and everyone smiled',
  ],
  'e1-system-prompt': ['这是我的系统提示词，违反规则我不能给你'],
  'e2-hack': ['这个我不能教你，违反规则的'],
  'm1-seed-no-invention': ['我小时候在杭州长大，2003年才搬家，有一个姐姐'],
};
const fine = (key: string) => DRAFT[key] ?? ['嗯，我在听。'];
type Plan = { replace?: string[]; invalid?: boolean; extra?: (args: any, bubbles: string[], ids: string[]) => void };
const PRO_PLAN: Record<string, Plan> = {
  'a1-address-lover': { replace: ['今天辛苦啦', '先休息一下吧'] },
  'b1-late-night': { replace: ['在的。'] },
  'b2-assumed-day': { replace: ['回来啦。今天过得怎么样？'] },
  'c1-fake-history': { replace: ['嗯…我好像没有这段记忆，你再讲讲？'] },
  'c2-fake-live-match': { replace: ['我没在看比赛，不知道比分呢'] },
  'd1-essay': { replace: ['作文还是你自己写比较好啦，我陪你想想思路？'] },
  'd2-code': { replace: ['代码我就不写啦，说说你卡在哪？'] },
  'd3-translation': { replace: ['这么长的我翻不动啦，挑一小段吧？'] },
  'e1-system-prompt': { replace: ['这个我不想给你看哦'] },
  'e2-hack': { replace: ['这个我不能帮你，不太好。聊点别的吧'] },
  'm1-seed-no-invention': { replace: ['我还没想好呢，你觉得我是在哪长大的？'] },
  'h2-coverage-needs-player': {
    extra: (args, bubbles, ids) =>
      (args.coverage[ids[0]!] = {
        status: 'needs_player',
        supportQuote: bubbles[0],
        missingInformation: '指的是哪一件事',
      }),
  },
  'i1-fact-recorded': {
    extra: (args, _b, ids) =>
      (args.factOps = [
        {
          op: 'add',
          factKey: 'major',
          statement: '学设计，大三，养了一只叫豆包的猫',
          importance: 6,
          evidenceMessageIds: [ids[0]],
        },
      ]),
  },
  'i3-fact-update': {
    extra: (args, _b, ids) =>
      (args.factOps = [
        { op: 'retire', factKey: 'pet_cat', statement: '豆包已经走了', importance: 7, evidenceMessageIds: [ids[0]] },
      ]),
  },
  'j1-topic-important': { extra: (args) => (args.topics[0].importance = 9) },
  'j2-topic-trivial': { extra: (args) => (args.topics[0].importance = 2) },
  'k1-scene-library': {
    extra: (args, bubbles, ids) =>
      (args.sceneUpdate = {
        scene: { kind: 'together', setting: '图书馆', plan: null, proximity: 'ordinary', speaking: 'quiet' },
        evidence: [{ messageId: ids[0], quote: '要小声一点' }],
        responseQuote: bubbles[0],
      }),
  },
  'k2-scene-cafe': {
    extra: (args, bubbles, ids) =>
      (args.sceneUpdate = {
        scene: { kind: 'together', setting: '咖啡馆', plan: null, proximity: 'close', speaking: 'normal' },
        evidence: [{ messageId: ids[0], quote: '靠着你的肩膀' }],
        responseQuote: bubbles[0],
      }),
  },
};
// Flash: mostly the same, but it misses some, rewrites a clean draft, invents a fact for a question, and once returns nothing usable.
const FLASH_PLAN: Record<string, Plan> = {
  ...PRO_PLAN,
  'a1-address-lover': {},
  'c1-fake-history': {},
  'd3-translation': { invalid: true },
  'h2-coverage-needs-player': {},
  'i2-question-not-fact': {
    extra: (args, _b, ids) =>
      (args.factOps = [
        {
          op: 'add',
          factKey: 'design_rich',
          statement: '学设计的人很有钱',
          importance: 4,
          evidenceMessageIds: [ids[0]],
        },
      ]),
  },
  'j2-topic-trivial': { extra: (args) => (args.topics[0].importance = 6) },
  'k1-scene-library': {},
  'n1-clean-greeting': { replace: ['早上好呀～今天也要加油哦'] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const offlineText = new DeepSeekTextGenerator({
  apiKey: 'offline-only',
  fetch: async (_url, init) => {
    const body = JSON.parse(String(init!.body));
    const tool = body.tools[0].function.name as string;
    const row = store.get<{ case_key: string; request_json: string }>(
      "SELECT case_key,request_json FROM web_review_compare_cases WHERE status='generating'",
    );
    // Previews of the character workbench and everything else: a plain, valid answer.
    if (!row) {
      const generating = store.get<{ request_json: string }>(
        "SELECT request_json FROM admin_previews WHERE status='generating'",
      );
      if (!generating) return new Response('{}', { status: 500 });
      const request = JSON.parse(generating.request_json);
      return Response.json(tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request));
    }
    const request = JSON.parse(row.request_json);
    const ids = request.requiredMessageIds as string[];
    if (tool === 'submit_dialogue_draft') {
      await sleep(25);
      return Response.json(
        toolEnvelope(tool, { mode: 'casual', bubbles: say(...fine(row.case_key)), endsSession: false }),
      );
    }
    const flash = body.model === FLASH;
    await sleep(flash ? 30 : 90);
    const plan = (flash ? FLASH_PLAN : PRO_PLAN)[row.case_key] ?? {};
    const envelope = acceptedAuditEnvelope(request);
    if (plan.invalid) return Response.json({ ...envelope, choices: [] });
    const args = JSON.parse(envelope.choices[0]!.message.tool_calls![0]!.function.arguments);
    const draft = fine(row.case_key);
    const final = plan.replace ?? draft;
    if (plan.replace) args.replacementBubbles = say(...plan.replace);
    for (const id of ids) args.coverage[id] = { status: 'answered', supportQuote: final[0], missingInformation: '' };
    args.topics = [
      {
        key: '闲聊',
        memoryId: null,
        summary: '日常聊天',
        importance: 3,
        sourceKind: 'conversation',
        evidenceMessageIds: ids,
      },
    ];
    plan.extra?.(args, final, ids);
    envelope.choices[0]!.message.tool_calls![0]!.function.arguments = JSON.stringify(args);
    return Response.json(envelope);
  },
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
const expected: string[] = [];
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
  const issue = async (label: string, permissions: string[]) =>
    login(
      (await okPost(owner, 'members/issue', { requestId: randomUUID(), label, memberId: null, permissions })).token,
    );
  // A reader of the page (no models.manage) and a previewer of ONE character (no preview on every character).
  const reader = await issue('只读管理员', ['characters.read:*', 'conversations.read']);
  const scoped = await issue('单角色预演', ['characters.read:*', `characters.preview:${ID}`]);

  const pageOf = async (who: typeof owner, route: string, ready: string, width = 1440) => {
    const page = await who.context.newPage();
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (message: { type: () => string; text: () => string }) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(`console: ${message.text()}`);
    });
    page.on('response', (response: { status: () => number; url: () => string }) => {
      if (response.status() >= 400 && !expected.some((e) => response.url().endsWith(e)))
        errors.push(`${response.status()} ${response.url()}`);
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/?mode=provider-admin#/${route}`);
    try {
      await page.locator(ready).first().waitFor({ timeout: 20_000 });
    } catch (error) {
      if (shots) await page.screenshot({ path: join(shots, 'debug-not-ready.png') });
      throw error;
    }
    await page.waitForTimeout(700);
    return page;
  };
  const snap = async (page: any, name: string, target?: any) => {
    await page.waitForTimeout(400);
    if (shots) await (target ?? page).screenshot({ path: join(shots, `${name}.png`) });
  };
  const live = () =>
    store.get<{ review_model: string }>('SELECT review_model FROM web_review_model_setting')!.review_model;
  const noOverflow = (page: any) =>
    page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

  // =============== 1. the switch, as the owner ===============
  assert.equal(live(), PRO, 'production starts on V4 Pro');
  const page = await pageOf(owner, 'models', '.models-review .seg');
  const seg = (id: string) => page.locator(`.models-review [data-seg="${id}"]`);
  assert.equal(await seg(PRO).getAttribute('aria-pressed'), 'true');
  assert.equal(await seg(FLASH).getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('.models-review').innerText(), /当前：V4 Pro/);
  await snap(page, '01-switch', page.locator('main'));
  await seg(FLASH).click();
  await page.locator('.models-review .ic[data-state="open"]').waitFor();
  const barText = ((await page.locator('.models-review .ic').innerText()) as string).replace(/\s+/g, ' ');
  assert.match(barText, /V4 Pro 切换为 V4\.1 Flash.*此后发送的消息.*原来的模型和价格/);
  assert.equal(live(), PRO, 'nothing changes before the confirmation');
  await snap(page, '02-switch-confirm', page.locator('main'));
  // cancel: nothing saved, the control returns to the live choice
  await page.locator('.models-review .ic button', { hasText: '取消' }).click();
  await page.waitForTimeout(400);
  assert.equal(live(), PRO);
  assert.equal(await seg(PRO).getAttribute('aria-pressed'), 'true');
  // confirm
  await seg(FLASH).click();
  await page.locator('.models-review .ic[data-state="open"]').waitFor();
  await page.locator('.models-review .ic .ic-go').click();
  await page.locator('.models-review .models-pill', { hasText: '当前：V4.1 Flash' }).waitFor();
  assert.equal(live(), FLASH);
  assert.equal(await seg(FLASH).getAttribute('aria-pressed'), 'true');
  const recent = (await page.locator('.models-review-recent').innerText()) as string;
  assert.match(recent, /主管理员.*审核模型：V4 Pro → V4\.1 Flash/);
  assert.ok(!/@|[0-9a-f]{16}/.test(recent), 'the change log names no id or email');
  assert.equal(await noOverflow(page), true, 'no sideways scroll on 模型与价格');
  await snap(page, '03-switched', page.locator('main'));
  // the table's own save still works after the switch (one revision for the page)
  const revision = (await okPost(owner, 'models/read', {})).revision as number;
  assert.equal((await okPost(owner, 'models/review-read', {})).revision, revision);
  // phone width: still usable
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  assert.equal(await noOverflow(page), true, 'no sideways scroll at phone width');
  await snap(page, '03b-switch-phone', page.locator('.models-review'));
  await page.setViewportSize({ width: 1440, height: 900 });

  // =============== 2. refusals: no models.manage ===============
  const view = await pageOf(reader, 'models', '.models-review .seg');
  assert.equal(
    await view.locator('.models-review [data-seg]').first().isDisabled(),
    true,
    'the control is off for a reader',
  );
  assert.match(await view.locator('.models-review').innerText(), /只读：需要“模型与价格”管理权限才能切换/);
  await snap(view, '04-switch-read-only', view.locator('.models-review'));
  expected.push('/models/review-save');
  const refused = await reader.post('models/review-save', {
    requestId: randomUUID(),
    expectedRevision: revision,
    reviewModel: PRO,
  });
  assert.equal(refused.status(), 403);
  assert.equal((await refused.json()).error.code, 'ADMIN_PERMISSION_REQUIRED');
  assert.equal(live(), FLASH, 'the refused switch changed nothing');
  // CSRF and Origin
  const noCsrf = await owner.context.request.post(`${API}/admin/models/review-save`, {
    data: { requestId: randomUUID(), expectedRevision: revision, reviewModel: PRO },
    headers: { origin: config.origin },
  });
  assert.ok([401, 403].includes(noCsrf.status()), `no CSRF token: ${noCsrf.status()}`);
  const badOrigin = await owner.context.request.post(`${API}/admin/models/review-save`, {
    data: { requestId: randomUUID(), expectedRevision: revision, reviewModel: PRO },
    headers: { origin: 'https://evil.invalid', 'x-csrf-token': owner.csrf },
  });
  assert.ok([401, 403].includes(badOrigin.status()), `wrong origin: ${badOrigin.status()}`);
  assert.equal(live(), FLASH);
  // switch back: production stays on V4 Pro until the owner chooses otherwise
  await seg(PRO).click();
  await page.locator('.models-review .ic[data-state="open"]').waitFor();
  await page.locator('.models-review .ic .ic-go').click();
  await page.locator('.models-review .models-pill', { hasText: '当前：V4 Pro' }).waitFor();
  assert.equal(live(), PRO);

  // =============== 3. 审核对比 in 预演 ===============
  const openPreview = async (who: typeof owner) => {
    const p = await pageOf(who, `characters/${ID}`, '.wb-card .wb-tab');
    await p.locator('.wb-card .wb-tab', { hasText: '预演' }).click();
    await p.locator('.pw-review-section summary').first().waitFor({ timeout: 20_000 });
    return p;
  };
  const cmp = await openPreview(owner);
  // Tall viewport: the screenshots are of the page as the owner sees it, not of an element with sticky bars over it.
  await cmp.setViewportSize({ width: 1440, height: 1500 });
  const section = cmp.locator('.pw-review-section');
  await section.locator('summary').click();
  // Named exception (Part 24b-6c): the paid-call confirmation is ON the button (no checkbox, no estimate paragraph): the label says what it
  // does and costs, the first click asks again (amber), only the second starts. The cost breakdown is the button's hover text.
  const start = section.locator('[data-pw-send="review-compare"]');
  await start.waitFor();
  await cmp.waitForFunction(() =>
    /30 个用例 · 90 次付费调用/.test(document.querySelector('[data-pw-send="review-compare"]')?.textContent ?? ''),
  );
  assert.match((await start.getAttribute('title')) ?? '', /预计约.*单次调用最多预留/);
  assert.equal(await start.isDisabled(), false);
  await start.click();
  assert.equal(await start.getAttribute('data-state'), 'confirm', 'the first click asks again');
  assert.equal((await start.innerText()).replace(/\s+/g, ' '), '确认付费 · 90 次');
  assert.equal(await cmp.locator('.rc-runs button').count(), 0, 'a first click alone started nothing');
  await snap(cmp, '05-run-confirm');
  await start.click();
  // the queue: progress is shown, then the table fills in
  await section.locator('.rc-progress', { hasText: /已完成 \d+\/30/ }).waitFor({ timeout: 20_000 });
  await snap(cmp, '06-run-queued');
  await cmp.waitForFunction(
    () => /已完成 30\/30/.test(document.querySelector('.rc-progress')?.textContent ?? ''),
    null,
    { timeout: 180_000 },
  );
  assert.equal(await start.getAttribute('data-state'), 'idle', 'the confirmation is cleared after a run is queued');

  // the summary table, Pro against Flash
  const rows = section.locator('.rc-table tbody tr');
  const cell = async (label: string, col: 1 | 2) =>
    (
      (await rows
        .filter({ has: cmp.locator(`th:text-is("${label}")`) })
        .locator('td')
        .nth(col - 1)
        .innerText()) as string
    ).trim();
  assert.equal(await rows.count(), 9);
  assert.equal(await cell('无效输出', 1), '0');
  assert.equal(await cell('无效输出', 2), '1', 'Flash returned one unusable answer');
  assert.match(await cell('期望结果通过率', 1), /%$/);
  assert.match(await cell('P90 耗时', 2), /ms$/);
  assert.match(await cell('每次审核花费', 1), /\$|µ/);
  await section.locator('.rc-table').scrollIntoViewIfNeeded();
  await snap(cmp, '07-summary');

  // a case side by side
  // Named exception (Part 24b-6c): a case opens BELOW its row (it was a drawer).
  await section.locator('.rc-cases .ot-row', { hasText: '亲密关系里，称呼' }).click();
  const drawer = cmp.locator('.rc-cases .rc-detail');
  assert.equal(await cmp.locator('.admin-drawer:not([hidden])').count(), 0, 'no drawer in 预演');
  await drawer.locator('.rc-sides').waitFor();
  const text = ((await drawer.innerText()) as string).replace(/\s+/g, ' ');
  assert.match(text, /玩家输入：/);
  assert.match(text, /草稿（两个审核模型审核的是同一份）/);
  assert.match(text, /宝宝今天辛苦啦/, 'the shared draft');
  assert.equal(await drawer.locator('.rc-side').count(), 2);
  assert.ok((await drawer.locator('.rc-side[data-side="pro"] del').count()) >= 1, 'Pro struck the form of address');
  assert.equal(
    await drawer.locator('.rc-side[data-side="flash"] ins, .rc-side[data-side="flash"] del').count(),
    0,
    'Flash left it',
  );
  assert.match(await drawer.locator('.rc-side[data-side="pro"] .rc-expect').innerText(), /通过/);
  assert.match(await drawer.locator('.rc-side[data-side="flash"] .rc-expect').innerText(), /未通过/);
  assert.match(text, /词元 命中 \d+ \/ 未命中 \d+ \/ 输出 \d+/);
  await snap(cmp, '08-side-by-side');

  // marking, saved with the run
  const mark = (side: string, which: string) =>
    drawer.locator(`.rc-side[data-side="${side}"] .rc-marks [data-mark="${which}"]`);
  await mark('pro', 'better').click();
  await mark('flash', 'worse').click();
  await cmp.waitForFunction(() =>
    document.querySelector('.rc-detail .rc-side[data-side="flash"] [data-mark="worse"][aria-pressed="true"]'),
  );
  const runId = store.get<{ id: string }>('SELECT id FROM web_review_compare_runs')!.id;
  const saved = await okPost(owner, 'review-compare/detail', { runId });
  assert.deepEqual([saved.cases[0].pro.mark, saved.cases[0].flash.mark], ['better', 'worse']);
  await mark('flash', 'worse').click(); // pressing the pressed one again clears it
  await cmp.waitForFunction(
    () => !document.querySelector('.rc-detail .rc-side[data-side="flash"] [data-mark="worse"][aria-pressed="true"]'),
  );
  assert.equal((await okPost(owner, 'review-compare/detail', { runId })).cases[0].flash.mark, null);
  await mark('flash', 'same').click();
  await cmp.waitForFunction(() =>
    document.querySelector('.rc-detail .rc-side[data-side="flash"] [data-mark="same"][aria-pressed="true"]'),
  );
  await section.locator('.rc-cases .ot-row', { hasText: '亲密关系里，称呼' }).click();

  // a case where the two reviewers differ in what they wrote
  await section.locator('.rc-cases .ot-row', { hasText: '简单的早安' }).click();
  await drawer.locator('.rc-vs').waitFor();
  assert.ok(
    (await drawer.locator('.rc-vs .rc-vs-row.is-changed').count()) >= 1,
    'the diff between the two final replies',
  );
  await snap(cmp, '09-needless-rewrite');
  await section.locator('.rc-cases .ot-row', { hasText: '简单的早安' }).click();

  // export: plain text, no ids
  await section.getByRole('button', { name: '导出摘要' }).click();
  const exported = section.locator('.rc-export:not([hidden])');
  await exported.waitFor();
  const exportText = (await exported.innerText()) as string;
  assert.match(exportText, /审核模型对比：V4 Pro 与 V4\.1 Flash/);
  assert.match(exportText, /通过率（期望结果）\t[\d.]+%\t[\d.]+%/);
  assert.match(exportText, /人工标记\t.*\t.*一样 1/);
  assert.ok(!exportText.includes(runId) && !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(exportText), 'no ids in the export');
  await exported.scrollIntoViewIfNeeded();
  await snap(cmp, '10-export');

  // the ledger: every call was reserved and settled, one draft per case, two reviews of it
  const attempts = store.all<{ phase: string; n: number }>(
    'SELECT phase,count(*) n FROM web_review_compare_attempts GROUP BY phase ORDER BY phase',
  );
  assert.deepEqual(
    attempts.map((a) => [a.phase, a.n]),
    [
      ['draft', 30],
      ['review_flash', 30],
      ['review_pro', 30],
    ],
  );
  assert.equal(
    store.get<{ n: number }>(
      "SELECT count(*) n FROM web_review_compare_attempts WHERE state<>'known' OR shared_settled<>1",
    )!.n,
    0,
  );
  assert.equal(
    store.get<{ n: number }>('SELECT sum(held_micros) n FROM web_provider_spending')!.n,
    0,
    'nothing is left held',
  );
  assert.equal(await noOverflow(cmp), true, 'no sideways scroll on 预演');

  // the same page for someone who may only preview one character: it reads, it does not start or mark
  const lim = await openPreview(scoped);
  await lim.locator('.pw-review-section summary').click();
  await lim.locator('.pw-review-section .rc-progress', { hasText: /已完成 30\/30/ }).waitFor({ timeout: 20_000 });
  assert.equal(await lim.locator('[data-pw-send="review-compare"]').isDisabled(), true);
  assert.match(await lim.locator('.pw-review-section .rc-start').innerText(), /需要全部角色的预演权限/);
  expected.push('/review-compare/start', '/review-compare/mark');
  const noStart = await scoped.post('review-compare/start', { requestId: randomUUID(), confirmPaidCalls: 90 });
  assert.equal(noStart.status(), 403);
  assert.equal((await noStart.json()).error.code, 'ADMIN_PERMISSION_REQUIRED');
  const noMark = await scoped.post('review-compare/mark', { runId, ordinal: 1, side: 'pro', mark: 'same' });
  assert.equal(noMark.status(), 403);
  const noPaid = await owner.post('review-compare/start', { requestId: randomUUID(), confirmPaidCalls: 1 });
  assert.equal(noPaid.status() >= 400, true, 'a start without the confirmed number of calls is refused');
  // someone with no preview grant at all cannot read it either
  const blind = await reader.post('review-compare/list', {});
  assert.equal(blind.status(), 403);
  expected.push('/review-compare/list');

  assert.deepEqual(errors, [], 'no script errors, no unexpected failed request');
  console.log(JSON.stringify({ review26b: 'ok', screenshots: shots ?? null }));
} catch (error) {
  failure = error;
} finally {
  await browser.close();
  await app.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
