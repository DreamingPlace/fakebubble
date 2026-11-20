import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';

/**
 * Part 37b in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the
 * machine): 说话档案.
 *
 *  1  共创收件箱 → 加入说话档案: a note into 核心卡 (幽默方式) and a note into 说话样本 (安慰); both only into the 草稿 (the 正式版本 is untouched);
 *     the note is marked 已采用; the same line for ANOTHER character is blocked (it is too close to the first one's).
 *  2  角色工作台 → 说话档案: the 核心卡 (four fields), the samples grouped by the eight situations with x/6 counts, 删除 and 移到 (an old free
 *     situation reads 未分类 and is never rewritten).
 *  3  多轮预演: 新+档案 is a column next to 旧 and 新, the eight 档案 scripts are a group of the rail, a run on 新+档案 completes, and ⭐ on a
 *     character line opens the same adopt box for that character's draft.
 *
 * usage: node scripts/check-web-profile-37b-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const f = await startConsoleFixture({ provider: { draftMs: 40, reviewMs: 40 }, speech: false });
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (e: unknown) => errors.push(`pageerror ${String(e)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
      errors.push(`console ${m.text()}`);
  });
  const bodies: { url: string; body: string }[] = [];
  page.on('request', (r: { method: () => string; url: () => string; postData: () => string | null }) => {
    if (r.method() === 'POST') bodies.push({ url: r.url(), body: r.postData() ?? '' });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const wait = (ms = 500) => quietWait(page, ms);
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: resolve(shots, `${name}.png`) });
  };
  const json = async (path: string, body: unknown = {}) => (await f.post(path, body)).json();
  const draftOf = async (id: string) => (await json(`characters/${id}/detail`)).draft;
  const settingsOf = (
    draft: { profile: { template: { authorCanon?: { settings: Record<string, unknown> } } } } | null,
  ) => draft?.profile.template.authorCanon?.settings ?? {};

  // ---- both characters have a saved draft to start from (the adopt box saves into the draft; 正式版本 stays as it is) ----
  for (const id of ['wei-guagua', 'jojo']) {
    const detail = await json(`characters/${id}/detail`);
    if (!detail.draft) {
      const profile = structuredClone(detail.published.profile);
      profile.template.version += 1;
      await json(`characters/${id}/save`, { expectedRevision: null, profile });
    }
  }
  const publishedBefore = (await json('characters/wei-guagua/detail')).published.version;

  // ---- three notes straight into the tables (what a player's submit writes) ----
  const principal = f.store.get<{ id: string }>('SELECT id FROM web_principals ORDER BY rowid LIMIT 1')!.id;
  const note = (id: string, characterId: string, body: string) => {
    f.store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,status,starred) VALUES (?,?,?,?,?,?,'new',0)`,
      id,
      characterId,
      principal,
      `req-${id}`,
      'c'.repeat(64),
      Date.now() - 1000,
    );
    f.store.run(
      `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,0,'free-1','free','text',?)`,
      id,
      JSON.stringify(body),
    );
  };
  const HUMOR = '先怼两句再递台阶，嘴硬心软，被夸了就岔开话题';
  const SAMPLE = '哎呀行了行了，抱一下，别哭了，我在呢';
  note('n37b-card', 'wei-guagua', HUMOR);
  note('n37b-sample', 'wei-guagua', SAMPLE);
  // the other character's note is the same words with different punctuation: the same line once normalised
  note('n37b-copy', 'jojo', `${HUMOR}！！`);

  // ======================= 1. the inbox =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/cocreation`);
  await page.reload();
  await page.locator('#admin-cocreation .cc-row-open').first().waitFor({ timeout: 20_000 });
  await wait(900);
  const openNote = async (text: string, notText = '！！') => {
    await page
      .locator('#admin-cocreation .cc-row-open', { hasText: text })
      .filter({ hasNotText: notText })
      .first()
      .click();
    await page.locator('.cc-answer .cc-adopt-profile').first().waitFor({ timeout: 10_000 });
    await wait(500);
  };
  await openNote(HUMOR);
  // the first note that is wei-guagua's: the one whose first line is the humor text
  await shot('inbox-note');
  await page.locator('.cc-detail .cc-adopt-profile:not([disabled])').first().click();
  await page.locator('.sp-adopt').waitFor({ timeout: 10_000 });
  await wait(700);
  await shot('adopt-box-sample');
  check(
    (await page.locator('.admin-drawer-head h3').innerText()).includes('加入说话档案'),
    'the adopt box has its title',
  );
  const options = await page.locator('.sp-adopt select[aria-label="样本的情境"] option').allTextContents();
  check(
    options.length === 8 && options.every((o: string) => /（\d\/6）$/.test(o)),
    `eight situations with x/6 counts (${options})`,
  );
  // → 核心卡 + 幽默方式
  await page.locator('.sp-adopt [data-seg="card"]').click();
  await wait(300);
  await page.locator('.sp-adopt select[aria-label="核心卡的哪一栏"]').selectOption('humor');
  await wait(300);
  await shot('adopt-box-card');
  const counter = await page.locator('.sp-adopt .sp-pane:not([hidden]) .sp-count').innerText();
  check(/\/ 300$/.test(counter), `the card counter says the limit (${counter})`);
  await page.locator('.sp-adopt .admin-primary').click();
  await page.locator('.sp-adopt').waitFor({ state: 'detached', timeout: 15_000 });
  await wait(700);
  let draft = await draftOf('wei-guagua');
  check(
    settingsOf(draft).humorStyle === HUMOR,
    `核心卡 幽默方式 is in the 草稿 (${JSON.stringify(settingsOf(draft).humorStyle)})`,
  );
  check(
    (await json('characters/wei-guagua/detail')).published.version === publishedBefore,
    'the 正式版本 did not change',
  );
  check(
    (await page.locator('.cc-answer .cc-chip-adopted').count()) > 0 ||
      (await page.locator('#admin-cocreation').innerText()).includes('已采用'),
    'the note is marked 已采用',
  );

  // → 说话样本 + 安慰
  await openNote(SAMPLE);
  await page.locator('.cc-detail .cc-adopt-profile:not([disabled])').first().click();
  await page.locator('.sp-adopt').waitFor({ timeout: 10_000 });
  await wait(500);
  await page.locator('.sp-adopt select[aria-label="样本的情境"]').selectOption('安慰');
  await page.locator('.sp-adopt input[aria-label="玩家说"]').fill('我今天被老板骂了，好难过');
  await page.locator('.sp-adopt .admin-primary').click();
  await page.locator('.sp-adopt').waitFor({ state: 'detached', timeout: 15_000 });
  await wait(700);
  draft = await draftOf('wei-guagua');
  const examples = (settingsOf(draft).dialogueExamples ?? []) as {
    situation?: string;
    player?: string;
    reply?: string[];
  }[];
  check(
    examples.some((e) => e.situation === '安慰' && e.player === '我今天被老板骂了，好难过' && e.reply?.[0] === SAMPLE),
    `说话样本 安慰 is in the 草稿 (${JSON.stringify(examples)})`,
  );

  // the same line for ANOTHER character: blocked
  let blocked = false;
  {
    await page.locator('#admin-cocreation .cc-row-open', { hasText: '！！' }).first().click();
    await page.locator('.cc-detail .cc-adopt-profile:not([disabled])').first().waitFor({ timeout: 10_000 });
    await wait(500);
    await page.locator('.cc-detail .cc-adopt-profile:not([disabled])').first().click();
    await page.locator('.sp-adopt').waitFor({ timeout: 10_000 });
    await wait(500);
    await page.locator('.sp-adopt [data-seg="card"]').click();
    await page.locator('.sp-adopt select[aria-label="核心卡的哪一栏"]').selectOption('humor');
    await page.locator('.sp-adopt .admin-primary').click();
    await page.locator('.sp-error:not([hidden])').waitFor({ timeout: 10_000 });
    const text = await page.locator('.sp-error').innerText();
    check(/太像|不能保存/.test(text), `another character's identical line is blocked (${text})`);
    await shot('adopt-box-blocked');
    blocked = true;
    await page.locator('.sp-adopt .admin-secondary').click();
  }
  check(blocked, "the other character's note was found and blocked");
  check(!settingsOf(await draftOf('jojo')).humorStyle, 'nothing was written for the other character');

  // the old 「+ 加入草稿」 into 说话风格 (what the 核心卡 is made of) is checked the same way
  {
    // (the note is still open from the step above; a second click would close it)
    if ((await page.locator('.cc-target select').count()) === 0)
      await page.locator('#admin-cocreation .cc-row-open', { hasText: '！！' }).first().click();
    await wait(500);
    const speechBefore = JSON.stringify(settingsOf(await draftOf('jojo')).speechStyle ?? null);
    await page.locator('.cc-target select').selectOption('speechStyle');
    await wait(500);
    await page.locator('.cc-detail .cc-adopt-open:not([disabled])').first().click();
    await wait(500);
    await page.locator('.cc-adopt-save:not([disabled])').click();
    await page.locator('.cc-adopt-error:not([hidden])').waitFor({ timeout: 10_000 });
    const legacy = await page.locator('.cc-adopt-error').innerText();
    check(/太像|不能保存/.test(legacy), `the old 加入草稿 is blocked for the same line (${legacy})`);
    check(
      JSON.stringify(settingsOf(await draftOf('jojo')).speechStyle ?? null) === speechBefore,
      'nothing was written for the other character through the old path either',
    );
    await page.locator('.cc-adopt-cancel').click();
    await wait(400);
  }

  // ======================= 2. 角色工作台 → 说话档案 =======================
  // an old example with a free situation, as before this Part
  {
    const detail = await json('characters/wei-guagua/detail');
    const profile = structuredClone(detail.draft.profile);
    const canon = profile.template.authorCanon ?? { kind: 'author_canon', settings: {} };
    canon.settings.dialogueExamples = [
      ...(canon.settings.dialogueExamples ?? []),
      { situation: '随便聊聊', player: '早上好', reply: ['早呀，今天也要加油'] },
    ];
    profile.template.authorCanon = canon;
    await json('characters/wei-guagua/save', { expectedRevision: detail.draft.revision, profile });
  }
  await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
  await page.reload();
  await page.locator('.wb-tab', { hasText: '说话档案' }).waitFor({ timeout: 20_000 });
  await wait(900);
  await page.locator('.wb-tab', { hasText: '说话档案' }).click();
  await page.locator('.sp-panel').waitFor({ timeout: 10_000 });
  await wait(600);
  await shot('workbench-profile');
  // only this section is showing: the form's own 说话方式 is hidden, and 说话档案 is what the card shows
  const showing = await page.evaluate(() => ({
    panel:
      !!document.querySelector('.sp-panel') &&
      (document.querySelector('.wb-speech') as HTMLElement).offsetParent !== null,
    form: [...document.querySelectorAll('.cn-pane')].some((el) => (el as HTMLElement).offsetParent !== null),
    tabs: [...document.querySelectorAll('.wb-tab[aria-current="true"]')].map((el) => el.textContent),
  }));
  check(showing.panel, '说话档案 is showing');
  check(!showing.form, "the form's own 说话方式 pane is not showing beside it");
  check(showing.tabs.length === 1 && /说话档案/.test(showing.tabs[0] ?? ''), `one tab is current (${showing.tabs})`);
  check((await page.locator('.sp-card textarea').count()) === 4, 'the 核心卡 shows four fields');
  const humorValue = await page.locator('.sp-card textarea[data-field="humor"]').inputValue();
  check(humorValue === HUMOR, `the 幽默方式 field holds the adopted text (${humorValue})`);
  const labels = await page.locator('.sp-card .sp-field-head b').allTextContents();
  check(labels.join(',') === '说话习惯,幽默方式,绝不会说的话,回复长短', `the four fields (${labels})`);
  check((await page.locator('.sp-group[data-situation]').count()) === 9, 'eight situations and 未分类');
  check((await page.locator('.sp-group[data-situation="安慰"] [data-count]').innerText()) === '1/6', '安慰 counts 1/6');
  check(
    (await page.locator('.sp-group[data-situation="未分类"] [data-count]').innerText()).includes('1'),
    '未分类 counts the old example',
  );
  // move the old one to 调侃
  await page.locator('.sp-group[data-situation="未分类"] select[data-sp="move"]').selectOption('调侃');
  await page.locator('.sp-group[data-situation="调侃"] .sp-sample').waitFor({ timeout: 15_000 });
  await wait(500);
  check(
    (await page.locator('.sp-group[data-situation="调侃"] [data-count]').innerText()) === '1/6',
    '调侃 counts 1/6 after the move',
  );
  check(
    (await page.locator('.sp-group[data-situation="未分类"]').count()) === 0,
    '未分类 is gone once everything is tagged',
  );
  // delete the 安慰 sample
  await page.locator('.sp-group[data-situation="安慰"] button[data-sp="delete"]').click();
  await page.waitForFunction(
    () => document.querySelector('.sp-group[data-situation="安慰"] [data-count]')?.textContent === '0/6',
    undefined,
    { timeout: 15_000 },
  );
  draft = await draftOf('wei-guagua');
  check(
    !((settingsOf(draft).dialogueExamples ?? []) as { situation?: string }[]).some((e) => e.situation === '安慰'),
    '删除 removed it from the 草稿',
  );
  // edit the card: too long is refused (button off), a short text is saved
  const box = page.locator('.sp-card textarea[data-field="neverSay"]');
  await box.fill('好'.repeat(301));
  await wait(200);
  check(
    await page
      .locator('.sp-card ~ .sp-actions button[data-sp="save"], .sp-actions button[data-sp="save"]')
      .first()
      .isDisabled(),
    'over 300 characters: save is off',
  );
  await box.fill('不说“亲亲”，不说客服腔');
  await wait(200);
  await page.locator('.sp-actions button[data-sp="save"]').first().click();
  await page.waitForFunction(() => !!document.querySelector('.sp-card textarea[data-field="neverSay"]'), undefined, {
    timeout: 15_000,
  });
  await wait(900);
  draft = await draftOf('wei-guagua');
  check(settingsOf(draft).neverSay === '不说“亲亲”，不说客服腔', '核心卡 绝不会说的话 saved to the 草稿');

  // ======================= 3. 多轮预演 =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
  await page.reload();
  await page.getByText('预演', { exact: true }).first().click();
  await page.locator('.pw-split .pw-half-rehearsal .rh-rail .rh-pick').first().waitFor({ timeout: 20_000 });
  await wait(1200);
  const toggles = await page.locator('.rh-model').first().locator('.rh-toggle').allTextContents();
  check(toggles.join(',') === '旧,新,新+档案', `three writers per model (${toggles})`);
  const profileScripts = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('.rh-rail > *')];
    const at = kids.findIndex((el) => el.tagName === 'H4' && /说话档案/.test(el.textContent ?? ''));
    let n = 0;
    for (const el of kids.slice(at + 1)) {
      if (el.tagName === 'H4') break;
      if (el.classList.contains('rh-pick')) n++;
    }
    return at < 0 ? -1 : n;
  });
  check(profileScripts === 8, `eight 档案 scripts in the rail (${profileScripts})`);
  await page.locator('.rh-rail .rh-pick', { hasText: '调侃' }).click();
  await wait(500);
  // 新+档案 only
  const dsOld = page.locator('.rh-toggle[data-model="deepseek"]');
  if ((await dsOld.getAttribute('aria-pressed')) === 'true') await dsOld.click();
  await page.locator('.rh-toggle[data-model="deepseek-v8p"]').click();
  await wait(900);
  await shot('rehearsal-profile-setup');
  const send = page.locator('[data-pw-send="rehearsal"]');
  await send.waitFor();
  const label = (await send.textContent()) as string;
  check(/8 次调用/.test(label), `4 turns on one column are 8 calls (${label})`);
  const runsBefore = await page.locator('.rh-run').count();
  await send.click();
  await send.click();
  await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
  const started = bodies.filter((b) => /rehearsal\/start/.test(b.url)).at(-1)!;
  const startBody = JSON.parse(started.body);
  check(
    JSON.stringify(startBody.models) === JSON.stringify(['deepseek-v8p']),
    `the start carries the 新+档案 column (${JSON.stringify(startBody.models)})`,
  );
  check(!('relationship' in startBody), 'the start carries no relationship');
  await page.waitForFunction(
    (n: number) =>
      document.querySelectorAll('.rh-run').length > n &&
      /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
    runsBefore,
    { timeout: 90_000 },
  );
  const heads = await page.locator('.rh-head').allTextContents();
  check(heads.slice(1).join(',') === 'DeepSeek·新+档案', `the column is named (${heads})`);
  const turns = await page.locator('.rh-player').count();
  check(turns === 4, `the 档案 script has four turns (${turns})`);
  await shot('rehearsal-profile-run');
  // ⭐ opens the adopt box for this character's draft
  const star = page.locator('.rh-bubble .rh-star').first();
  await star.waitFor({ timeout: 10_000 });
  await star.click();
  await page.locator('.sp-adopt').waitFor({ timeout: 10_000 });
  await wait(600);
  const title = await page.locator('.admin-drawer-head h3').innerText();
  check(title.includes('加入说话档案'), `⭐ opens the adopt box (${title})`);
  const from = await page.locator('.sp-adopt .sp-from').innerText();
  check(from.length > 3, `the box shows the line (${from})`);
  const player = await page.locator('.sp-adopt input[aria-label="玩家说"]').inputValue();
  check(player.length > 0, 'the player line of that turn is filled in');
  await shot('rehearsal-star-box');
  await page.locator('.sp-adopt select[aria-label="样本的情境"]').selectOption('调侃');
  await page.locator('.sp-adopt .admin-primary').click();
  await page.locator('.sp-adopt').waitFor({ state: 'detached', timeout: 15_000 });
  await wait(700);
  draft = await draftOf('wei-guagua');
  const tease = ((settingsOf(draft).dialogueExamples ?? []) as { situation?: string }[]).filter(
    (e) => e.situation === '调侃',
  );
  check(tease.length === 2, `the ⭐ line is a second 调侃 sample (${tease.length})`);
  check(
    (await json('characters/wei-guagua/detail')).published.version === publishedBefore,
    'the 正式版本 still did not change',
  );
  check(!(await page.locator('main').innerText()).includes('现行'), 'admin: no 「现行」 on the page');

  for (const e of errors.slice(0, 8)) problems.push(e);
} catch (error) {
  problems.push(`script error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await f.close?.();
}
if (problems.length) {
  console.error(`profile-37b browser check FAILED (${problems.length}):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('profile-37b browser check passed');
process.exit(0);
