import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { templateFile } from '../tests/web/fixtures/profile-template.ts';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24b-7 (offline provider only; nothing reaches a provider): the newer admin pieces in the V3 console, in a REAL browser at
 * 1280, 1440 and 1920. 导入角色资料 is an inline panel (no drawer) with three steps; 草稿记录 shows a mark per administrator and
 * 恢复到这一稿 saves a draft revision without publishing; an opened 整页版本 row shows its content and its difference from live;
 * 预演's opened result has no id, and its run header is two controls (checkbox, open/close button); nothing scrolls sideways and
 * the nav stays put. Synthetic site (console-fixture-24b6.ts).
 *
 * usage: node scripts/check-web-admin-24b7-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
let failure: unknown = null;
try {
  const dir = mkdtempSync(join(tmpdir(), 'admin-24b7-'));
  const write = (name: string, text: string) => (writeFileSync(join(dir, name), text), join(dir, name));
  const page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(`console: ${message.text()}`);
  });
  const wait = (ms = 500) => page.waitForTimeout(ms);

  // ---- the cast: two published versions (the second differs), then an empty draft so imports fit ------------------------------
  const castNow = await (await f.post('cast/draft', {})).json();
  let revision = castNow.revision as number;
  const pub = async (doc: unknown) => {
    const saved = await (
      await f.post('cast/save', { requestId: crypto.randomUUID(), expectedRevision: revision, doc })
    ).json();
    await f.post('cast/publish', { requestId: crypto.randomUUID(), expectedRevision: saved.revision });
    revision = saved.revision;
  };
  if (!(await (await f.post('cast/versions', {})).json()).versions.length) {
    await pub(castNow.doc);
    const second = structuredClone(castNow.doc);
    second.world = { ...second.world, background: '第二版改过的世界背景。' };
    second.characters[0].identity.oneLiner = '第二版改过的名片一句话。';
    second.groups = second.groups.slice(0, 2);
    await pub(second);
  }
  const emptyDoc = {
    schema: 2,
    world: { background: '' },
    characters: [],
    people: [],
    ratings: {},
    directions: [],
    groups: [],
    stories: [],
    memes: [],
  };
  const saved = await (
    await f.post('cast/save', { requestId: crypto.randomUUID(), expectedRevision: revision, doc: emptyDoc })
  ).json();
  revision = saved.revision;

  // ---- a second administrator (the second mark of the table), with its own session -----------------------------------------
  const grant = await (
    await f.post('members/issue', {
      requestId: crypto.randomUUID(),
      label: '小安',
      memberId: null,
      permissions: ['characters.read:*', 'characters.edit:*'],
    })
  ).json();
  const second = await f.browser.newContext({ ignoreHTTPSErrors: true });
  const login = await second.request.post(`${f.API}/admin/login`, {
    data: { token: grant.token },
    headers: { origin: f.origin },
  });
  assert.equal(login.status(), 200);
  const secondCsrf = (await login.json()).csrf as string;
  const post2 = (path: string, data: unknown) =>
    second.request.post(`${f.API}/admin/${path}`, { data, headers: { origin: f.origin, 'x-csrf-token': secondCsrf } });
  const detailOf = async () => (await (await f.post('characters/jojo/detail', {})).json()) as any;
  const saveAs = async (who: 'owner' | 'second', change: (profile: any) => void) => {
    const d = await detailOf();
    const profile = structuredClone(d.draft?.profile ?? d.published.profile);
    if (!d.draft) profile.template.version = d.published.version + 1;
    change(profile);
    const body = { expectedRevision: d.draft?.revision ?? null, profile };
    const r = who === 'owner' ? await f.post('characters/jojo/save', body) : await post2('characters/jojo/save', body);
    assert.equal(r.status(), 200, await r.text());
  };
  const tab = (label: string) => page.locator(`button.wb-tab:has(span:text-is("${label}"))`).first();
  const openChar = async (id: string, hash = 'characters') => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${hash}/${id}`);
    await page.reload();
    await page.locator('.wb-tab').first().waitFor({ timeout: 20_000 });
    await wait(900);
  };
  const noSideways = async (label: string) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(over <= 0, `${label}: sideways scroll ${over}px`);
  };

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    const w = String(width);
    await page.setViewportSize({ width, height });
    const shot = async (name: string) => {
      if (shots) {
        await wait(350);
        await page.screenshot({ path: join(shots, `${name}-${w}.png`) });
      }
    };
    const base = { '网页展示名／昵称': '示例', 欢迎词: '「你好」', 陌生时的相处方式: '客气，话少。' };
    const fileNew = write(
      `new${w}.md`,
      templateFile({
        ...base,
        角色代码: `NEW${w}`,
        人设名称: `示例新角${w}`,
        生日: '2001-03-04',
        欢迎词: '「你好」\n「今天过得怎么样」',
        角色主色: '「#2F4858 深墨蓝（主）」「#C9A227 旧金」「雾蓝」',
      }),
    );
    const fileNew2 = write(
      `newb${w}.md`,
      templateFile({ ...base, 角色代码: `NWB${w}`, 人设名称: `示例二号${w}`, 生日: '2002-05-06' }),
    );

    // three saves in turn: the owner changes 人设, 小安 changes 身份与展示, the owner changes 主色
    await saveAs('owner', (p) => (p.template.persona += ` 第一次保存${w}。`));
    await saveAs('second', (p) => (p.presentation.publicDescription = `小安改的描述${w}`));
    await saveAs('owner', (p) => (p.presentation.color = '#336699'));

    // =================== 导入角色资料: an inline panel, two files, preview, 确认导入 ===================
    await openChar('jojo');
    await shot('01-identity');
    await page.locator('#wb-import').evaluate((el: HTMLElement) => el.click());
    const panel = page.locator('.pi-panel');
    await panel.waitFor({ state: 'visible', timeout: 5000 });
    check((await page.locator('.admin-drawer:visible').count()) === 0, `${w}: no drawer`);
    check((await page.locator('.admin-backdrop:visible').count()) === 0, `${w}: no scrim`);
    check((await panel.locator('.pi-steps li').allInnerTexts()).join('|').includes('选择文件'), `${w}: three steps`);
    const above = await page.evaluate(() => {
      const p = document.querySelector('.pi-panel')!.getBoundingClientRect();
      const t = document.querySelector('#wb-title')!.getBoundingClientRect();
      return p.top >= t.bottom - 1;
    });
    check(above, `${w}: the panel sits under the title row`);
    await shot('02-import-choose');
    await panel.locator('input[type=file]').setInputFiles([fileNew, fileNew2]);
    await panel.locator('.pi-card').first().waitFor({ timeout: 10_000 });
    check((await panel.locator('.pi-card').count()) === 2, `${w}: the preview shows both characters`);
    const confirm = panel.getByRole('button', { name: '确认导入' });
    check(await confirm.isEnabled(), `${w}: 确认导入 is on`);
    check(
      (await page.locator('main .admin-primary:visible').count()) <= 3,
      `${w}: one solid primary per area (panel + header + save)`,
    );
    await shot('03-import-preview');
    await confirm.click();
    await panel.locator('.pi-done').waitFor({ timeout: 10_000 });
    check((await panel.locator('.pi-done li').count()) === 2, `${w}: the result stays in the panel`);
    check((await page.locator('.admin-drawer:visible').count()) === 0, `${w}: still no drawer after the import`);
    await noSideways(`${w} import`);
    await shot('04-import-done');
    await panel.getByRole('button', { name: '关闭' }).click();
    check((await panel.isHidden()) === true, `${w}: 关闭 closes the panel`);

    // =================== 草稿记录 ===================
    await openChar('jojo');
    await tab('资料改动').click();
    await page.locator('.dh .ot-row').first().waitFor({ timeout: 10_000 });
    const marks = await page.$$eval('.dh-group', (nodes: Element[]) =>
      nodes.map((n) => ({
        group: (n as HTMLElement).dataset.group,
        initial: n.querySelector('.mb-mark')!.textContent,
        colour: getComputedStyle(n.querySelector('.mb-mark')!).backgroundColor,
      })),
    );
    const mark = (g: string) => marks.find((m: any) => m.group === g);
    check(mark('人设')?.initial === '主', `${w}: 人设 was last changed by the owner (${JSON.stringify(mark('人设'))})`);
    check(mark('身份与展示')?.initial === '小', `${w}: 身份与展示 by 小安`);
    check(mark('主色')?.initial === '主', `${w}: 主色 by the owner`);
    check(
      mark('身份与展示')?.colour !== mark('人设')?.colour,
      `${w}: two administrators have two colours (${JSON.stringify(marks)})`,
    );
    const recordText = (await page.locator('.dh').innerText()) as string;
    check(!UUID.test(recordText) && !/@/.test(recordText), `${w}: 草稿记录 shows no id or email`);
    check(/小安/.test(recordText), `${w}: the label of the saver is shown`);
    const tabText = (await page.locator('.wb-card-body').innerText()) as string;
    check(
      !/"id"\s*:/.test(tabText) && !/\bw-[0-9a-f]{8,}/.test(tabText),
      `${w}: 资料改动 shows no id (welcome-line ids are left out)`,
    );
    await shot('05-draft-record');
    // open an older revision: its difference from the one before it opens BELOW the row
    const rows = page.locator('.dh .ot-item');
    const count = await rows.count();
    check(count >= 3, `${w}: at least three revisions listed (${count})`);
    await rows.nth(1).locator('.ot-row').click();
    await rows.nth(1).locator('.ot-panel[data-state="open"] .pd-grid').first().waitFor({ timeout: 5000 });
    check(
      (await rows.nth(1).locator('.pd-add, .pd-del').count()) > 0,
      `${w}: the older revision shows what changed in it`,
    );
    await shot('06-draft-diff');
    // 恢复到这一稿: an inline confirm in the row; the draft changes (a new revision), live does not
    const before = await detailOf();
    const history = await (await f.post('characters/jojo/draft-history', {})).json();
    const target = history.revisions[history.revisions.length - 1];
    const oldest = rows.nth(count - 1);
    await oldest.locator('[data-restore]').click();
    check((await oldest.locator('[data-restore-go]').count()) === 1, `${w}: the confirm is in the same row`);
    check((await page.locator('.admin-dialog:visible').count()) === 0, `${w}: no dialog for it`);
    await shot('07-draft-restore-confirm');
    await oldest.locator('[data-restore-go]').click();
    await wait(1500);
    const after = await detailOf();
    check(after.draft.revision === before.draft.revision + 1, `${w}: the restore made ONE new draft revision`);
    check(
      JSON.stringify(after.published) === JSON.stringify(before.published),
      `${w}: live did not change (nothing was published)`,
    );
    check(
      JSON.stringify(after.draft.profile) === JSON.stringify(target.profile),
      `${w}: the draft now holds exactly the restored revision's profile`,
    );
    await shot('08-draft-restored');

    // =================== 关系与故事: an opened version shows its content and its difference from live ===================
    await page.goto(`${f.origin}/?mode=provider-admin#/cast`);
    await page.reload();
    await page.locator('.cs-versions .ot-item').first().waitFor({ timeout: 20_000 });
    await wait(900);
    const vrows = page.locator('.cs-versions .ot-item');
    check((await vrows.count()) >= 2, `${w}: two versions listed`);
    const older = vrows.last();
    await older.locator('.ot-row').click();
    await older.locator('.cv-part').first().waitFor({ timeout: 10_000 });
    const cvText = (await older.locator('.ot-panel').innerText()) as string;
    check(/角色/.test(cvText) && /新增|删除|改动/.test(cvText), `${w}: the content with its difference from live`);
    check(!UUID.test(cvText) && !/\be_[0-9a-f]{8}/.test(cvText), `${w}: no id in the version content`);
    await noSideways(`${w} cast`);
    await shot('09-cast-version-open');

    // =================== 预演: the opened result has no id; the run header is two controls, by keyboard ===================
    await openChar('jojo');
    await tab('预演').click();
    await wait(500);
    const text = `示例输入${w}`;
    await page.locator('textarea[aria-label="预演输入"]').fill(`${text}\n第二行${w}`);
    await page.locator('[data-pw-send="preview"]').click();
    await wait(400);
    await page.locator('[data-pw-send="preview"]').click();
    const run = page.locator('.pw-run-head').first();
    await run.waitFor({ timeout: 15_000 });
    check((await page.locator('.pw-run-head[role]').count()) === 0, `${w}: the run header is not a role=button`);
    check((await run.locator('input[type=checkbox]').count()) === 1, `${w}: the checkbox is in the header`);
    check((await run.locator('.pw-run-toggle').count()) === 1, `${w}: the open/close control is its own button`);
    const toggle = run.locator('.pw-run-toggle');
    const expanded = async () => await toggle.getAttribute('aria-expanded');
    const was = await expanded();
    // keyboard: Tab from the checkbox reaches the button; Space on the checkbox ticks it and does not open the run
    await run.locator('input[type=checkbox]').focus();
    await page.keyboard.press('Space');
    check((await run.locator('input[type=checkbox]').isChecked()) === true, `${w}: Space ticks the checkbox`);
    check((await expanded()) === was, `${w}: ticking does not open or close the run`);
    await page.keyboard.press('Tab');
    check(
      await toggle.evaluate((el: Element) => el === document.activeElement),
      `${w}: Tab moves to the open/close button`,
    );
    await page.keyboard.press('Enter');
    await wait(300);
    check((await expanded()) !== was, `${w}: Enter on the button opens or closes the run`);
    await page.keyboard.press('Space');
    await wait(300);
    check((await expanded()) === was, `${w}: Space on the button toggles it back`);
    await run.locator('input[type=checkbox]').uncheck();
    // wait for the lines to finish, open a result
    const line = page.locator('.pw-line', { hasText: text }).first();
    if ((await expanded()) !== 'true') await toggle.click();
    await line.locator('.admin-badge:has-text("完成")').waitFor({ timeout: 30_000 });
    await line.locator('.pw-row').first().click();
    await line.locator('.pw-detail').waitFor({ timeout: 10_000 });
    const detailText = (await line.locator('.pw-detail').innerText()) as string;
    check(
      !UUID.test(detailText),
      `${w}: the opened result shows no id: …${detailText.slice(Math.max(0, detailText.search(UUID) - 60), detailText.search(UUID) + 40).replace(/\s+/g, ' ')}…`,
    );
    check(/第 1 条/.test(detailText) || !/覆盖与引用/.test(detailText), `${w}: the quote is placed as 第 N 条`);
    await noSideways(`${w} preview`);
    await shot('10-preview-result');

    // =================== the nav stays put ===================
    await page.evaluate(() => window.scrollTo(0, 400));
    await wait(200);
    const navTop = await page.evaluate(
      () => document.querySelector('.admin-nav, nav.admin-sidebar, aside')?.getBoundingClientRect().top ?? 0,
    );
    check(navTop >= -1 && navTop < 200, `${w}: the nav stays in view when the page scrolls (top ${navTop})`);
  }
} catch (error) {
  failure = error;
} finally {
  for (const p of f.context.pages())
    if (shots) await p.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
  await f.close();
}
if (errors.length) problems.push(...errors);
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else if (!failure) console.log('check:web:admin-24b7 ok');
