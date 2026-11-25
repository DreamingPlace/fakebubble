import './player-build-guard.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';

/**
 * Part 37c-1 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the
 * machine): the internet-meme dictionary and the fourth 回复写法.
 *
 *  1  角色 → 网络梗: the page lists the shipped 1,806 entries (50 a page), search puts the exact term first, year / tag / state filter,
 *     one switch and a ticked bulk switch change the count of entries that are on; nothing about it says where it came from in words.
 *  2  角色工作台 → 说话档案 → 网络梗: a character's default level (会用 / 只懂 / 不碰) and one single-entry setting are saved into the
 *     草稿 only (the 正式版本 does not change); a term the dictionary does not hold is refused.
 *  3  多轮预演: 新+档案+梗 is a fourth column; the four 网络梗 scripts are a group of the rail; a run on it completes and the counts of
 *     memes matched and meanings given are numbers; the character's own settings are in the frozen request only as the level.
 *  4  系统 → 模型与价格 → 回复写法: four choices, 新+档案+梗 selectable (and put back to 旧).
 *  5  the credit line (the exact notice and the link) is on the terms page and nowhere else.
 *
 * Part 37c-1b NAMED EXCEPTION: the counts below follow the re-curated default (1,806 entries, 546 ship ON, 1,260 ship OFF), the head line is
 * 共 N 条 · 已开启 N 条 · 待审 N 条 and the 默认关闭 count moved into the 状态 filter's label. Everything the script checks is the same.
 *
 * usage: node scripts/check-web-memes-37c1-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const NOTICE = 'chinese-meme-dict — 作者：sky（出力）、楠（出token）— CC BY 4.0';
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
  const settingsOf = (
    draft: { profile: { template: { authorCanon?: { settings: Record<string, unknown> } } } } | null,
  ) => draft?.profile.template.authorCanon?.settings ?? {};
  const statusOn = async () => {
    const text = await page.locator('#admin-memes .head-status').innerText();
    return Number(/已开启\s*([\d,]+)\s*条/.exec(text)?.[1]?.replaceAll(',', '') ?? -1);
  };

  // ======================= 1. 网络梗 =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/memes`);
  await page.reload();
  await page.locator('#admin-memes .admin-table tbody tr').first().waitFor({ timeout: 20_000 });
  await wait(900);
  check(
    (await page.locator('.admin-nav-item[data-page="memes"]').innerText()).includes('网络梗'),
    '网络梗 is in the nav',
  );
  check((await page.locator('#admin-memes .page-head h2').innerText()) === '网络梗', 'the page is titled 网络梗');
  check((await page.locator('#admin-memes .admin-table tbody tr').count()) === 50, 'fifty entries a page');
  const head = await page.locator('#admin-memes .head-status').innerText();
  check(
    /共 1,806 条/.test(head) && /已开启 546 条/.test(head) && /待审 0 条/.test(head),
    `the count of entries (${head})`,
  );
  check(/第 1 \/ 37 页/.test(await page.locator('#admin-memes .mm-page').innerText()), 'the pager says 37 pages');
  await shot('memes-page');
  // search: the exact term first
  await page.locator('#admin-memes input[type="search"]').fill('松弛感');
  await page.waitForFunction(
    () => document.querySelector('#admin-memes .admin-table tbody tr .mm-term')?.textContent === '松弛感',
    null,
    { timeout: 10_000 },
  );
  await wait(400);
  check((await page.locator('#admin-memes .admin-table tbody tr').count()) >= 1, 'the search finds 松弛感');
  // one switch
  const sw = page.locator('#admin-memes .admin-table tbody tr').first().locator('.mm-switch');
  check((await sw.getAttribute('aria-checked')) === 'true', 'an entry is on by default');
  await sw.click();
  await page.waitForFunction(
    () => /已开启 545 条/.test(document.querySelector('#admin-memes .head-status')?.textContent ?? ''),
    null,
    {
      timeout: 10_000,
    },
  );
  check((await statusOn()) === 545, 'the count of entries that are on follows the switch');
  check(
    f.store
      .all<{ entry_key: string }>('SELECT entry_key FROM web_meme_switch WHERE enabled=0')
      .map((r) => r.entry_key)
      .join(',') === '松弛感',
    'the switch is stored by the business object',
  );
  check(
    JSON.parse(bodies.filter((b) => /cast\/memes-set/.test(b.url)).at(-1)!.body).keys.join() === '松弛感',
    'the request names the one entry',
  );
  await shot('memes-search-off');
  // the state filter
  await page.locator('#admin-memes select[aria-label="状态"]').selectOption('off');
  await wait(700);
  await page.locator('#admin-memes input[type="search"]').fill('');
  await wait(900);
  check(
    (await page.locator('#admin-memes select[aria-label="状态"] option[value="default-off"]').innerText()).includes(
      '默认关闭（1,260）',
    ),
    'the 状态 filter counts the default-off entries',
  );
  check(
    /符合 1,261 条/.test(await page.locator('#admin-memes .mm-page').innerText()),
    'the off filter shows the default-off entries and the one switched off',
  );
  await page.locator('#admin-memes select[aria-label="状态"]').selectOption('default-off');
  await wait(700);
  check(
    /符合 1,260 条/.test(await page.locator('#admin-memes .mm-page').innerText()),
    'the 默认关闭 filter lists them',
  );
  check(
    (await page.locator('#admin-memes .mm-default-off').count()) === 50,
    'every row of it carries the 默认关闭 badge',
  );
  const dsw = page.locator('#admin-memes .admin-table tbody tr').first().locator('.mm-switch');
  check((await dsw.getAttribute('aria-checked')) === 'false', 'a default-off entry is off');
  await shot('memes-default-off');
  await dsw.click();
  await page.waitForFunction(
    () => /已开启 546 条/.test(document.querySelector('#admin-memes .head-status')?.textContent ?? ''),
    null,
    { timeout: 10_000 },
  );
  check(
    f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_meme_switch WHERE enabled=1')!.n === 1,
    'a default-off entry turned on is stored as an override',
  );
  await page.locator('#admin-memes input[type="search"]').fill('');
  await page.locator('#admin-memes select[aria-label="状态"]').selectOption('all');
  await wait(900);
  // year and tag
  await page.locator('#admin-memes select[aria-label="年份"]').selectOption('2023');
  await wait(800);
  const years = await page.locator('#admin-memes .admin-table tbody tr td:nth-child(4)').allTextContents();
  check(years.length > 0 && years.every((y: string) => y.trim() === '2023'), `the year filter (${years.slice(0, 3)})`);
  await page.locator('#admin-memes select[aria-label="年份"]').selectOption('');
  await wait(600);
  const firstTag = await page.locator('#admin-memes select[aria-label="标签"] option').nth(1).getAttribute('value');
  await page.locator('#admin-memes select[aria-label="标签"]').selectOption(firstTag);
  await wait(800);
  const tagRows = await page.locator('#admin-memes .admin-table tbody tr .mm-tags').allTextContents();
  check(tagRows.length > 0 && tagRows.every((t: string) => t.includes(String(firstTag))), 'the tag filter');
  await page.locator('#admin-memes select[aria-label="标签"]').selectOption('');
  await wait(600);
  // the next page, and a ticked bulk switch back on
  await page.locator('#admin-memes .mm-pager button', { hasText: '下一页' }).click();
  await wait(700);
  check(/第 2 \//.test(await page.locator('#admin-memes .mm-page').innerText()), 'the next page');
  await page.locator('#admin-memes .admin-table thead input[type="checkbox"]').check();
  await page.locator('#admin-memes .admin-bulk-bar button', { hasText: '关闭所选' }).click();
  await page.waitForFunction(
    () => /已开启 [45]\d\d 条/.test(document.querySelector('#admin-memes .head-status')?.textContent ?? ''),
    null,
    {
      timeout: 10_000,
    },
  );
  await shot('memes-bulk-off');
  await page.locator('#admin-memes select[aria-label="状态"]').selectOption('off');
  await wait(700);
  await page.locator('#admin-memes .admin-table thead input[type="checkbox"]').check();
  await page.locator('#admin-memes .admin-bulk-bar button', { hasText: '开启所选' }).click();
  await wait(900);
  await page.locator('#admin-memes select[aria-label="状态"]').selectOption('all');
  await wait(700);
  check((await statusOn()) > 500, 'a ticked page switches back on');
  // put everything back on: one entry (松弛感) stays off for the run below on purpose
  check(
    f.store.get<{ n: number }>('SELECT COUNT(*) n FROM web_meme_switch')!.n >= 1,
    'something is still off for the rehearsal below',
  );
  f.store.run('DELETE FROM web_meme_switch');
  const text1 = await page.locator('#admin-memes').innerText();
  check(!/CC BY|chinese-meme-dict/.test(text1), 'the admin page itself carries no credit text');
  check(!/现行/.test(text1), '网络梗: no 「现行」');

  // ======================= 2. 说话档案 → 网络梗 =======================
  const detail0 = await json('characters/wei-guagua/detail');
  if (!detail0.draft) {
    const profile = structuredClone(detail0.published.profile);
    profile.template.version += 1;
    await json('characters/wei-guagua/save', { expectedRevision: null, profile });
  }
  const publishedBefore = (await json('characters/wei-guagua/detail')).published.version;
  await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
  await page.reload();
  await page.locator('.wb-tab', { hasText: '说话档案' }).waitFor({ timeout: 20_000 });
  await wait(900);
  await page.locator('.wb-tab', { hasText: '说话档案' }).click();
  await page.locator('.mm-use').waitFor({ timeout: 10_000 });
  await wait(600);
  const levels = await page.locator('.mm-use .seg-button').allTextContents();
  check(levels.join(',') === '会用,只懂,不碰', `three levels (${levels})`);
  check(
    (await page.locator('.mm-use .seg-button[data-seg="know"]').getAttribute('aria-pressed')) === 'true',
    'a character nobody set up is 只懂',
  );
  await shot('profile-memes-before');
  await page.locator('.mm-use .seg-button[data-seg="use"]').click();
  await wait(300);
  // a term the dictionary does not hold is refused
  await page.locator('.mm-use .mm-use-add input').fill('这个词不在词库里');
  await page.locator('[data-sp="meme-add"]').click();
  await page.locator('.sp-error:not([hidden])').waitFor({ timeout: 10_000 });
  check(/词库里没有/.test(await page.locator('.sp-error').innerText()), 'an unknown term is refused');
  await page.locator('.mm-use .mm-use-add input').fill('摆烂');
  await page.locator('.mm-use .mm-use-add select').selectOption('avoid');
  await page.locator('[data-sp="meme-add"]').click();
  await page.locator('.mm-use-item[data-term="摆烂"]').waitFor({ timeout: 10_000 });
  await shot('profile-memes-edited');
  await page.locator('[data-sp="meme-save"]').click();
  await page.waitForFunction(() => !!document.querySelector('.mm-use'), null, { timeout: 15_000 });
  await wait(1100);
  const draft = (await json('characters/wei-guagua/detail')).draft;
  const settings = settingsOf(draft);
  check(settings.memeLevel === 'use', `the default level is in the 草稿 (${JSON.stringify(settings.memeLevel)})`);
  check(
    JSON.stringify(settings.memeOverrides) === JSON.stringify({ 摆烂: 'avoid' }),
    'the single-entry setting is in the 草稿',
  );
  check(
    (await json('characters/wei-guagua/detail')).published.version === publishedBefore,
    'the 正式版本 did not change',
  );
  check(
    !JSON.stringify((await json('characters/wei-guagua/detail')).published.profile).includes('memeLevel'),
    'players see nothing until 发布',
  );
  await shot('profile-memes-saved');

  // ======================= 3. 多轮预演 =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
  await page.reload();
  await page.getByText('预演', { exact: true }).first().click();
  await page.locator('.pw-split .pw-half-rehearsal .rh-rail .rh-pick').first().waitFor({ timeout: 20_000 });
  await wait(1200);
  const toggles = await page.locator('.rh-model').first().locator('.rh-toggle').allTextContents();
  check(toggles.join(',') === '旧,新,新+档案,新+档案+梗', `four writers per model (${toggles})`);
  const netScripts = await page.evaluate(() => {
    const kids = [...document.querySelectorAll('.rh-rail > *')];
    const at = kids.findIndex((el) => el.tagName === 'H4' && /网络梗/.test(el.textContent ?? ''));
    let n = 0;
    for (const el of kids.slice(at + 1)) {
      if (el.tagName === 'H4') break;
      if (el.classList.contains('rh-pick')) n++;
    }
    return at < 0 ? -1 : n;
  });
  check(netScripts === 4, `four 网络梗 scripts in the rail (${netScripts})`);
  await page.locator('.rh-rail .rh-pick', { hasText: '日常' }).last().click();
  await wait(500);
  const dsOld = page.locator('.rh-toggle[data-model="deepseek"]');
  if ((await dsOld.getAttribute('aria-pressed')) === 'true') await dsOld.click();
  await page.locator('.rh-toggle[data-model="deepseek-v8p"]').click();
  await page.locator('.rh-toggle[data-model="deepseek-v8m"]').click();
  await wait(900);
  await shot('rehearsal-memes-setup');
  const send = page.locator('[data-pw-send="rehearsal"]');
  await send.waitFor();
  const runsBefore = await page.locator('.rh-run').count();
  await send.click();
  await send.click();
  await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
  const startBody = JSON.parse(bodies.filter((b) => /rehearsal\/start/.test(b.url)).at(-1)!.body);
  check(
    JSON.stringify(startBody.models) === JSON.stringify(['deepseek-v8p', 'deepseek-v8m']),
    `the start carries both columns (${JSON.stringify(startBody.models)})`,
  );
  await page.waitForFunction(
    (n: number) =>
      document.querySelectorAll('.rh-run').length > n &&
      /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
    runsBefore,
    { timeout: 90_000 },
  );
  const heads = await page.locator('.rh-head').allTextContents();
  check(heads.slice(1).join(',') === 'DeepSeek·新+档案,DeepSeek·新+档案+梗', `the columns are named (${heads})`);
  check((await page.locator('.rh-player').count()) === 6, 'the script has six turns');
  // the counts of memes: numbers for the 梗 column, a dash for the other
  await page
    .getByRole('button', { name: /统计/ })
    .first()
    .click()
    .catch(() => {});
  await wait(600);
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('.rh-counts tbody tr')].map((tr) =>
      [...tr.children].map((c) => (c.textContent ?? '').trim()),
    ),
  );
  const matched = rows.find((r: string[]) => r[0]?.startsWith('命中的梗'));
  const given = rows.find((r: string[]) => r[0]?.startsWith('给出释义'));
  check(
    !!matched && matched[1] === '—' && Number(matched[2]) >= 6,
    `命中的梗: — and a number (${JSON.stringify(matched)})`,
  );
  check(
    !!given && given[1] === '—' && Number(given[2]) >= 6 && Number(given[2]) <= Number(matched?.[2]),
    `给出释义 (${JSON.stringify(given)})`,
  );
  await shot('rehearsal-memes-run');
  // the stored counts are by code and level by level: 使用 for the default, 不碰 for 摆烂
  const runId = f.store.get<{ id: string }>('SELECT id FROM web_rehearsal_runs ORDER BY created_at DESC LIMIT 1')!.id;
  const detail = await json('rehearsal/detail', { characterId: 'wei-guagua', runId });
  const column = detail.columns.find((c: { key: string }) => c.key === 'deepseek-v8m');
  check(
    !!column?.netMemes && column.netMemes.avoid >= 1 && column.netMemes.use >= 1 && column.netMemes.know === 0,
    `levels in the counts (${JSON.stringify(column?.netMemes)})`,
  );
  check(
    detail.columns.find((c: { key: string }) => c.key === 'deepseek-v8p')?.netMemes === null,
    'the 新+档案 column has no meme counts',
  );
  const frozenJson = f.store.get<{ frozen_json: string }>(
    'SELECT frozen_json FROM web_rehearsal_runs WHERE id=?',
    runId,
  )!.frozen_json;
  check(
    JSON.parse(frozenJson).memeOff.includes('优化'),
    'the run froze which entries are off (the common words included)',
  );

  // ======================= 4. 回复写法: four choices =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/models`);
  await page.reload();
  await page.locator('.models-writer').waitFor({ timeout: 20_000 });
  await wait(900);
  const card = page.locator('.models-writer');
  const choices = await card.locator('.seg-button').allTextContents();
  check(choices.join(',') === '旧写法,新写法,新+档案,新+档案+梗', `four choices (${choices})`);
  check((await card.locator('[data-seg="v7"]').getAttribute('aria-pressed')) === 'true', 'the default (旧) is pressed');
  await shot('writer-switch-four');
  await card.locator('[data-seg="v8m"]').click();
  await wait(500);
  await page.locator('.models-writer .models-confirm button', { hasText: /确认切换/ }).click();
  await page.waitForFunction(
    () => /当前：新\+档案\+梗/.test(document.querySelector('.models-writer')?.textContent ?? ''),
    null,
    {
      timeout: 15_000,
    },
  );
  check(
    JSON.parse(bodies.filter((b) => /system\/writer-save/.test(b.url)).at(-1)!.body).writer === 'v8m',
    'the save carries v8m',
  );
  check(
    f.store.get<{ writer: string }>('SELECT writer FROM web_writer_setting')?.writer === 'v8m',
    'the live setting is 新+档案+梗',
  );
  await shot('writer-switch-memes');
  await card.locator('[data-seg="v7"]').click();
  await wait(500);
  await page.locator('.models-writer .models-confirm button', { hasText: /确认切换/ }).click();
  await page.waitForFunction(
    () => /当前：旧写法/.test(document.querySelector('.models-writer')?.textContent ?? ''),
    null,
    {
      timeout: 15_000,
    },
  );
  check(
    f.store.get<{ writer: string }>('SELECT writer FROM web_writer_setting')?.writer === 'v7',
    "put back to 旧: the production value is the owner's",
  );

  // ======================= 5. the credit line =======================
  const built = readFileSync(resolve('apps/player-web/dist/terms.html'), 'utf8');
  await page.setContent(built);
  const legalText = await page.locator('body').innerText();
  check(legalText.includes(NOTICE), 'the terms page carries the exact notice');
  check(
    (await page.locator('a[href="https://github.com/re-skylar/chinese-meme-dict"]').count()) === 1,
    'and its link, once',
  );
  const lines = legalText.split('\n').filter((l: string) => l.includes('chinese-meme-dict'));
  check(lines.length === 1, 'one line');
  await shot('legal-credit');
  const privacy = readFileSync(resolve('apps/player-web/dist/privacy.html'), 'utf8');
  check(!privacy.includes('chinese-meme-dict'), 'the privacy page does not carry it');

  for (const e of errors.slice(0, 8)) problems.push(e);
} catch (error) {
  problems.push(`script error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await f.close?.();
}
if (problems.length) {
  console.error(`memes-37c1 browser check FAILED (${problems.length}):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('memes-37c1 browser check passed');
process.exit(0);
