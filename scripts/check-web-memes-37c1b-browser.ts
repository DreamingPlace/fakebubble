import './player-build-guard.ts';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { xlsxOf } from '../apps/server/export/web-export-file.ts';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';

/**
 * Part 37c-1b in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts (its OFFLINE provider; nothing leaves the
 * machine): the re-curated library, the editable page and the 待审 queue.
 *
 *  1  the page: 共 1,806 条 · 已开启 546 条 · 待审 0 条; category and source on every row; filters for category, source, 默认关闭, 已删除
 *  2  添加词条 (the entry is ON, source 手动), a duplicate is refused with a link to the existing entry
 *  3  编辑 (a shipped entry shows 已改; 恢复原文 puts the shipped text back)
 *  4  删除: his own entry for good after the explaining confirm; a shipped one goes to 已删除 and comes back with 恢复; bulk delete
 *  5  上传导入: a csv preview with every row's status or reason, the side by side of an existing term, 曾删除; a .xlsx; 放入待审
 *  6  待审: edit before 通过 (the library gets the edit), 不要, bulk 通过所选
 *  7  导出: the columns 分类 / 来源 / 已删除; uploading the export back leaves nothing new for 待审
 *
 * usage: node scripts/check-web-memes-37c1b-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const tmp = resolve(process.cwd(), 'work', 'check-web-memes-37c1b');
mkdirSync(tmp, { recursive: true });
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (e: unknown) => errors.push(`pageerror ${String(e)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
      errors.push(`console ${m.text()}`);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const wait = (ms = 500) => quietWait(page, ms);
  const shot = async (name: string) => {
    if (shots) await page.screenshot({ path: resolve(shots, `${name}.png`) });
  };
  const root = '#admin-memes';
  const rows = `${root} [data-mm-panel="library"] .admin-table-region:not([hidden]) tbody tr`;
  const head = async () => (await page.locator(`${root} .head-status`).innerText()).replace(/\s+/g, ' ');
  const drawer = '.admin-drawer:not([hidden])';
  const entryRow = (term: string) =>
    page
      .locator(rows)
      .filter({ has: page.locator('.mm-term', { hasText: term }) })
      .first();
  const search = async (text: string, state = 'all') => {
    await page.locator(`${root} select[aria-label="状态"]`).selectOption(state);
    await page.locator(`${root} input[type="search"]`).fill(text);
    await wait(900);
  };
  const waitHead = (re: RegExp) =>
    page.waitForFunction(
      (src: string) => new RegExp(src).test(document.querySelector('#admin-memes .head-status')?.textContent ?? ''),
      re.source,
      { timeout: 15_000 },
    );
  const toast = (text: string) => page.locator('.admin-toast', { hasText: text }).first().waitFor({ timeout: 10_000 });
  const db = <T>(sql: string, ...args: (string | number | null)[]) => f.store.get<T>(sql, ...args);

  // ======================= 1. the page =======================
  await page.goto(`${f.origin}/?mode=provider-admin#/memes`);
  await page.reload();
  await page.locator(rows).first().waitFor({ timeout: 20_000 });
  await wait(900);
  check((await head()) === '共 1,806 条 已开启 546 条 待审 0 条', `the head line (${await head()})`);
  check((await page.locator(rows).count()) === 50, 'fifty rows a page');
  check(
    (await page.locator(`${rows} .mm-category`).count()) === 50 &&
      (await page.locator(`${rows} .mm-source`).count()) === 50,
    'category and source on every row',
  );
  check((await page.locator(`${rows} .mm-source`).first().innerText()) === '自带', 'a shipped row says 自带');
  const columns = await page.locator(`${root} .admin-table:visible thead th`).allInnerTexts();
  check(
    ['词', '释义', '分类', '来源', '开关'].every((c) => columns.some((t: string) => t.includes(c))),
    `columns (${columns})`,
  );
  await shot('library-page');
  // category and source filters
  await page.locator(`${root} select[aria-label="分类"]`).selectOption('心情');
  await wait(900);
  check(/符合 98 条/.test(await page.locator(`${root} .mm-page`).innerText()), 'the 心情 filter lists 98');
  check(
    (await page.locator(`${rows} .mm-category`).allInnerTexts()).every((t: string) => t === '心情'),
    'every row of it is 心情',
  );
  await page.locator(`${root} select[aria-label="分类"]`).selectOption('AI科技');
  await wait(900);
  check(
    /符合 823 条/.test(await page.locator(`${root} .mm-page`).innerText()),
    'the AI科技 filter lists the 823 dropped ones',
  );
  check((await page.locator(`${rows} .mm-switch[aria-checked="false"]`).count()) === 50, 'a dropped entry is off');
  await page.locator(`${root} select[aria-label="分类"]`).selectOption('');
  await page.locator(`${root} select[aria-label="来源"]`).selectOption('manual');
  await wait(900);
  check((await page.locator(rows).count()) === 0, 'no entry of the owner yet');
  await page.locator(`${root} select[aria-label="来源"]`).selectOption('');
  await page.locator(`${root} select[aria-label="状态"]`).selectOption('deleted');
  await wait(800);
  check((await page.locator(`${root} .admin-empty:visible`).count()) >= 1, '已删除 is empty at first');
  await page.locator(`${root} select[aria-label="状态"]`).selectOption('all');
  await wait(600);

  // ======================= 2. 添加 =======================
  await page.locator(`${root} button`, { hasText: '添加词条' }).click();
  await page.locator(drawer).waitFor();
  await wait(500);
  await page.locator(`${drawer} input[aria-label="词"]`).fill('浏览器新词');
  await page.locator(`${drawer} textarea[aria-label="释义"]`).fill('在浏览器里加的一个词，用来测试。');
  await page.locator(`${drawer} select[aria-label="分类"]`).selectOption('关系');
  await shot('add-form');
  await page.locator(`${drawer} button`, { hasText: '保存' }).click();
  await toast('已添加');
  await wait(900);
  check(
    (await head()).includes('共 1,807 条') && (await head()).includes('已开启 547 条'),
    `an added entry counts and is on (${await head()})`,
  );
  const added = db<{ enabled: number; source: string; category: string }>(
    "SELECT enabled,source,category FROM web_memelib_entry WHERE term='浏览器新词'",
  );
  check(
    added?.enabled === 1 && added.source === 'manual' && added.category === '关系',
    'stored by the business object: on, 手动, 关系',
  );
  check((await entryRow('浏览器新词').locator('.mm-source').innerText()) === '手动', 'the row says 手动');
  await shot('added-row');
  // a duplicate is refused, with a link to the existing entry
  await page.locator(`${root} button`, { hasText: '添加词条' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} input[aria-label="词"]`).fill('松弛感');
  await page.locator(`${drawer} textarea[aria-label="释义"]`).fill('重复的词');
  await page.locator(`${drawer} button`, { hasText: '保存' }).click();
  await page.locator(`${drawer} .mm-error`).waitFor({ state: 'visible', timeout: 10_000 });
  check(
    (await page.locator(`${drawer} .mm-error`).innerText()).includes('词库里已经有这个词了'),
    'the duplicate is refused in words',
  );
  await shot('add-duplicate');
  await page.locator(`${drawer} .mm-link`).click();
  await wait(1000);
  check(
    (await page.locator(rows).first().locator('.mm-term').innerText()) === '松弛感',
    'the link takes the owner to the existing entry',
  );
  // limits show on the form (no explanation text): a 41-character term is refused by the server with its sentence
  await page.locator(`${root} button`, { hasText: '添加词条' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} input[aria-label="词"]`).fill('长'.repeat(41));
  await page.locator(`${drawer} textarea[aria-label="释义"]`).fill('x');
  await page.locator(`${drawer} button`, { hasText: '保存' }).click();
  await page.locator(`${drawer} .mm-error`).waitFor({ state: 'visible', timeout: 10_000 });
  check(
    (await page.locator(`${drawer} .mm-error`).innerText()).includes('最多 40'),
    'a too long term is refused with its sentence',
  );
  await page.locator(`${drawer} button`, { hasText: '取消' }).click();
  await wait(500);

  // ======================= 3. 编辑 / 恢复原文 =======================
  await search('松弛感');
  await entryRow('松弛感').locator('button', { hasText: '编辑' }).click();
  await page.locator(drawer).waitFor();
  const shipped = await page.locator(`${drawer} textarea[aria-label="释义"]`).inputValue();
  await page.locator(`${drawer} textarea[aria-label="释义"]`).fill('我在浏览器里改过的释义');
  await page.locator(`${drawer} select[aria-label="分类"]`).selectOption('句式');
  await shot('edit-form');
  await page.locator(`${drawer} button`, { hasText: '保存' }).click();
  await toast('已保存');
  await wait(900);
  check(
    (await entryRow('松弛感').locator('.mm-meaning').innerText()) === '我在浏览器里改过的释义',
    'the edited meaning is on the row',
  );
  check((await entryRow('松弛感').locator('.mm-category').innerText()) === '句式', 'the edited category is on the row');
  check((await entryRow('松弛感').locator('.mm-edited').count()) === 1, 'an edited shipped entry says 已改');
  await entryRow('松弛感').locator('button', { hasText: '编辑' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} button`, { hasText: '恢复原文' }).click();
  await toast('已恢复原文');
  await wait(900);
  check(
    (await entryRow('松弛感').locator('.mm-meaning').innerText()) === shipped,
    '恢复原文 brings the shipped meaning back',
  );
  check(
    (await entryRow('松弛感').locator('.mm-edited').count()) === 0 &&
      db<{ n: number }>('SELECT COUNT(*) n FROM web_memelib_override')!.n === 0,
    'and no edit is left',
  );

  // ======================= 4. 删除 =======================
  await search('浏览器新词');
  await entryRow('浏览器新词').locator('button', { hasText: '删除' }).click();
  await page.locator(`${root} .ic-text`).waitFor({ timeout: 10_000 });
  check(
    (await page.locator(`${root} .ic-text`).innerText()).includes('无法找回'),
    'the permanent delete says it cannot be undone',
  );
  await wait(400);
  await shot('delete-confirm');
  await page.locator(`${root} .ic-go`).click();
  await toast('已删除');
  await wait(900);
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_entry WHERE term='浏览器新词'")!.n === 0,
    'his own entry is gone for good',
  );
  check((await head()).includes('共 1,806 条'), 'and no longer counts');
  // a shipped entry: no confirm, into 已删除, back with 恢复
  await search('松弛感');
  await entryRow('松弛感').locator('button', { hasText: '删除' }).click();
  await toast('已删除');
  await wait(900);
  check((await page.locator(`${root} .ic-text`).count()) === 0, 'a shipped delete needs no confirm');
  check((await head()).includes('共 1,805 条'), 'a deleted shipped entry no longer counts');
  await search('', 'deleted');
  check(
    (await page.locator(rows).count()) === 1 &&
      (await page.locator(rows).first().locator('.mm-term').innerText()) === '松弛感',
    '已删除 lists it',
  );
  check(
    (await page.locator(`${root} select[aria-label="状态"] option[value="deleted"]`).innerText()).includes('（1）'),
    'the filter counts it',
  );
  await shot('deleted-list');
  await page.locator(rows).first().locator('button', { hasText: '恢复' }).click();
  await toast('已恢复');
  await wait(900);
  check((await head()).includes('共 1,806 条'), 'restored: it counts again');
  // bulk delete of ticked shipped rows
  await search('');
  await page.locator(`${root} .admin-table:visible tbody tr`).nth(0).locator('input[type="checkbox"]').check();
  await page.locator(`${root} .admin-table:visible tbody tr`).nth(1).locator('input[type="checkbox"]').check();
  await page.locator(`${root} .admin-bulk-bar button`, { hasText: '删除所选' }).click();
  await toast('已删除');
  await wait(900);
  check((await head()).includes('共 1,804 条'), 'bulk delete');
  await search('', 'deleted');
  await page.locator(`${root} .admin-table:visible thead input[type="checkbox"]`).check();
  await page.locator(`${root} .admin-bulk-bar button`, { hasText: '恢复所选' }).click();
  await toast('已恢复');
  await wait(900);
  check((await head()).includes('共 1,806 条'), 'bulk restore');
  await search('');

  // ======================= 5. 上传导入 =======================
  // a shipped entry deleted first, so the upload can say 曾删除
  await search('蛐蛐');
  await entryRow('蛐蛐').locator('button', { hasText: '删除' }).click();
  await toast('已删除');
  await search('');
  const csv = [
    '词,释义,分类,备注',
    '上传词一,第一个上传的词,日常,x',
    ',没有词,日常,x',
    '上传词二,,心情,x',
    `${'长'.repeat(41)},词太长,日常,x`,
    '上传词三,分类不对,乱写,x',
    '松弛感,上传里改过的松弛感释义,句式,x',
    '蛐蛐,回来的蛐蛐,关系,x',
    '上传词四,第四个上传的词,句式,x',
  ].join('\r\n');
  writeFileSync(resolve(tmp, 'upload.csv'), csv);
  await page.locator(`${root} button`, { hasText: '上传导入' }).click();
  await page.locator(drawer).waitFor();
  await wait(500);
  check(
    await page.locator(`${drawer} button`, { hasText: '放入待审' }).isDisabled(),
    'nothing to put in 待审 before a preview',
  );
  await page.locator(`${drawer} input[type="file"]`).setInputFiles(resolve(tmp, 'upload.csv'));
  await page.locator(`${drawer} button`, { hasText: '预览' }).click();
  await page.locator(`${drawer} .mm-import-table`).waitFor({ timeout: 10_000 });
  await wait(500);
  const summary = await page.locator(`${drawer} .mm-import-summary`).innerText();
  check(/共 8 行/.test(summary) && /不能导入 4 行/.test(summary), `the preview counts (${summary})`);
  const table = await page.locator(`${drawer} .mm-import-table`).innerText();
  for (const reason of ['词是空的', '释义是空的', '词超过 40 个字', '分类不在可选的五个里'])
    check(table.includes(reason), `the reason "${reason}" is shown with its row`);
  check((await page.locator(`${drawer} .mm-import-row`).count()) === 8, 'every row is shown, none dropped');
  check(
    (await page.locator(`${drawer} .mm-compare`).count()) === 2,
    'an existing term and a deleted one show current and new side by side',
  );
  check(table.includes('曾删除'), 'a deleted term is flagged 曾删除');
  await shot('import-preview');
  await page.locator(`${drawer} button`, { hasText: '放入待审' }).click();
  await toast('已放入待审 4 条');
  await wait(900);
  check((await head()).includes('待审 4 条'), `the head counts the queue (${await head()})`);
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_entry WHERE term LIKE '上传词%'")!.n === 0,
    'nothing went into the library',
  );
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_queue WHERE source='upload'")!.n === 4,
    'four rows are in the queue, source 上传',
  );
  // a .xlsx (the page is on 待审 now: back to 词库, where the upload button is)
  await page.locator(`${root} .seg-button`, { hasText: '词库' }).click();
  await wait(600);
  writeFileSync(
    resolve(tmp, 'upload.xlsx'),
    xlsxOf([
      {
        name: '词',
        header: ['词', '释义', '分类'],
        rows: [
          ['表格词一', '来自表格', '日常'],
          ['表格词二', '也来自表格', '心情'],
        ],
      },
    ]),
  );
  await page.locator(`${root} button`, { hasText: '上传导入' }).click();
  await page.locator(drawer).waitFor();
  await page.locator(`${drawer} input[type="file"]`).setInputFiles(resolve(tmp, 'upload.xlsx'));
  await page.locator(`${drawer} button`, { hasText: '预览' }).click();
  await page.locator(`${drawer} .mm-import-table`).waitFor({ timeout: 10_000 });
  check(/共 2 行/.test(await page.locator(`${drawer} .mm-import-summary`).innerText()), 'an .xlsx is read too');
  await page.locator(`${drawer} button`, { hasText: '放入待审' }).click();
  await toast('已放入待审 2 条');
  await wait(900);

  // ======================= 6. 待审 =======================
  check(
    (await page.locator(`${root} [data-mm-panel="queue"]`).isVisible()) && (await head()).includes('待审 6 条'),
    'the page switched to 待审 (6 items)',
  );
  const queueRows = `${root} [data-mm-panel="queue"] tbody tr`;
  check((await page.locator(queueRows).count()) === 6, 'six items in the queue');
  check(
    (await page.locator(`${root} [data-mm-panel="queue"] .mm-compare`).count()) === 2,
    'the existing term and the deleted one stand side by side',
  );
  check(
    (await page.locator(`${root} [data-mm-panel="queue"] .mm-chip-revive`).count()) === 1,
    'and a deleted term says 曾删除',
  );
  check(
    (await page.locator(`${root} [data-mm-panel="queue"] .mm-source`).allInnerTexts()).every(
      (t: string) => t === '上传',
    ),
    'every item says 上传',
  );
  await shot('queue');
  // edit before approving, then 通过
  const item = (term: string) =>
    page
      .locator(queueRows)
      .filter({ has: page.locator(`input[aria-label="词：${term}"]`) })
      .first();
  await item('上传词一').locator('textarea').fill('通过前改过的释义');
  await item('上传词一').locator('select').selectOption('心情');
  await item('上传词一').locator('button', { hasText: '通过' }).click();
  await toast('已通过');
  await wait(900);
  const approved = db<{ meaning: string; category: string; enabled: number; source: string }>(
    "SELECT meaning,category,enabled,source FROM web_memelib_entry WHERE term='上传词一'",
  );
  check(
    approved?.meaning === '通过前改过的释义' &&
      approved.category === '心情' &&
      approved.enabled === 1 &&
      approved.source === 'upload',
    'approved with the edit: in the library, on, 上传',
  );
  // 不要
  await item('上传词四').locator('button', { hasText: '不要' }).click();
  await toast('已不要');
  await wait(900);
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_dismissed WHERE term='上传词四'")!.n === 1,
    '不要 is remembered',
  );
  // an existing term approved updates it
  await item('松弛感').locator('button', { hasText: '通过' }).click();
  await wait(1000);
  check(
    db<{ meaning: string }>("SELECT meaning FROM web_memelib_override WHERE term='松弛感'")?.meaning ===
      '上传里改过的松弛感释义',
    'approving an existing term updates it',
  );
  // bulk 通过所选 for the two sheet rows
  await page
    .locator(queueRows)
    .filter({ has: page.locator('input[aria-label="词：表格词一"]') })
    .locator('input[type="checkbox"]')
    .check();
  await page
    .locator(queueRows)
    .filter({ has: page.locator('input[aria-label="词：表格词二"]') })
    .locator('input[type="checkbox"]')
    .check();
  await page.locator(`${root} .admin-bulk-bar button:visible`, { hasText: '通过所选' }).click();
  await toast('已通过 2 条');
  await wait(900);
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_entry WHERE term IN ('表格词一','表格词二') AND enabled=1")!
      .n === 2,
    'bulk approval',
  );
  await shot('queue-after');
  // the deleted one comes back when approved
  await item('蛐蛐').locator('button', { hasText: '通过' }).click();
  await wait(1000);
  check(
    db<{ n: number }>("SELECT COUNT(*) n FROM web_memelib_deleted WHERE term='蛐蛐'")!.n === 0,
    'approving a 曾删除 term brings it back',
  );
  check((await head()).includes('待审 0 条'), `the queue is empty (${await head()})`);
  // back to the library tab
  await page.locator(`${root} .seg-button`, { hasText: '词库' }).click();
  await wait(700);

  // ======================= 7. 导出 =======================
  await search('');
  const exportAs = async (format: 'CSV' | 'Excel') => {
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出' });
    await dialog.waitFor();
    await dialog.locator('.seg-button', { hasText: format }).first().click();
    const got: { path: () => Promise<string>; suggestedFilename: () => string }[] = [];
    const onDownload = (d: (typeof got)[number]) => got.push(d);
    page.on('download', onDownload);
    await dialog.getByRole('button', { name: '导出', exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 60_000 });
    page.off('download', onDownload);
    check(got.length === 1, `one ${format} file`);
    const path = resolve(tmp, `export-${format}.${format === 'CSV' ? 'csv' : 'xlsx'}`);
    writeFileSync(path, readFileSync(await got[0]!.path()));
    return path;
  };
  const roundTrip = async (path: string, label: string) => {
    await page.locator(`${root} button`, { hasText: '上传导入' }).click();
    await page.locator(drawer).waitFor();
    await page.locator(`${drawer} input[type="file"]`).setInputFiles(path);
    await page.locator(`${drawer} button`, { hasText: '预览' }).click();
    await page
      .locator(`${drawer} .mm-import-table`)
      .waitFor({ timeout: 20_000 })
      .catch(async (e: unknown) => {
        throw new Error(
          `${label} upload preview: ${await page.locator(`${drawer} .mm-error`).innerText()} (${String(e).slice(0, 80)})`,
        );
      });
    await wait(600);
    const back = await page.locator(`${drawer} .mm-import-summary`).innerText();
    check(/可放入待审 0 行/.test(back) && !/不能导入/.test(back), `the ${label} round trip has nothing new (${back})`);
    check(
      await page.locator(`${drawer} button`, { hasText: '放入待审' }).isDisabled(),
      `${label}: nothing to put in 待审`,
    );
    if (label === 'CSV') await shot('export-roundtrip');
    await page.locator(`${drawer} button`, { hasText: '关闭' }).first().click();
    await wait(500);
  };
  const csvPath = await exportAs('CSV');
  const text = readFileSync(csvPath, 'utf8');
  check(
    text.split('\r\n')[0]!.replace('\uFEFF', '') === '词,释义,年份,标签,状态,默认关闭,分类,来源,已删除',
    `the export header (${text.split('\r\n')[0]})`,
  );
  check(
    text.includes(',上传,') && text.includes(',手动,') === false && text.includes(',自带,'),
    'the export carries the 来源',
  );
  await roundTrip(csvPath, 'CSV');
  await roundTrip(await exportAs('Excel'), 'Excel');

  // ======================= no console errors =======================
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
} finally {
  await f.close();
}
if (problems.length) {
  console.error(problems.map((p) => `FAIL ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-web-memes-37c1b-browser: ok');
