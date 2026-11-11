import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SAMPLE_NAMES } from '../tests/web/fixtures/cast-sample.ts';
import { templateFile } from '../tests/web/fixtures/profile-template.ts';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24j: 导入角色资料 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts. At 1440×900 and again at
 * 1280×800 it drives the real page: choose three files (one new character, one existing, one 将绑定代码) -> preview (writes nothing)
 * -> a file with blocking errors -> confirm -> reload; then the 角色代码 field and the checklist on 身份与展示, the Fish id prefilled on
 * 声音, a refused code, and a dismissal that survives a reload. It also checks that the same files again read 没有变化, and that
 * there is no sideways scroll and nothing outside its box. Every file is synthetic.
 *
 * usage: node scripts/check-web-profile-import-24j-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;

const f = await startConsoleFixture();
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  const dir = mkdtempSync(join(tmpdir(), 'profile-import-24j-'));
  const write = (name: string, text: string) => {
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  };
  const base = { '网页展示名／昵称': '示例', 欢迎词: '「你好」', 陌生时的相处方式: '客气，话少。' };
  // jojo gets a code by hand; a file for that code is an EXISTING character.
  await f.post('characters/jojo/code-save', { code: 'JOJ' });
  // The synthetic cast already holds the 15 characters the cast allows; start from an empty cast draft so new characters fit.
  const castNow = await (await f.post('cast/draft', {})).json();
  await f.post('cast/save', {
    requestId: crypto.randomUUID(),
    expectedRevision: castNow.revision,
    doc: {
      schema: 2,
      world: { background: '' },
      characters: [],
      people: [],
      ratings: {},
      directions: [],
      groups: [],
      stories: [],
      memes: [],
    },
  });

  /** The three files of pass `n`: a new character, JOJO (existing), and a character without a code that is found by its name. */
  const files = (n: number) => {
    const bindName = SAMPLE_NAMES[2 + n]!; // c04 on the first pass, c05 on the second: neither has a code yet
    return {
      bindName,
      newName: `新角${n}`,
      newFile: write(
        `new${n}.md`,
        templateFile(
          {
            ...base,
            角色代码: `NEW${n}`,
            人设名称: `示例新角${n}`,
            '网页展示名／昵称': `新角${n}`,
            一句话描述: '刚来的合成角色',
            生日: '2001-03-04',
            是否为成长中角色: '是',
            '头像／形象图片文件': `new${n}.png`,
            '音色模型 ID（Fish Audio）': `fish_ref_new${n}`,
            欢迎词: '「你好」\n「今天过得怎么样」',
            角色主色: '「#2F4858 深墨蓝（主）」「#C9A227 旧金」「雾蓝」',
            身高: '168cm',
            不可改变的核心设定: '2001-03-04 生。',
          },
          [
            {
              code: 'JOJ',
              cp: `合成搭档${n}`,
              addresses: '「小J」「J老师」',
              attitude: '互相照应。',
              shared: '同一间教室。',
            },
          ],
        ),
      ),
      existingFile: write(
        `jojo${n}.md`,
        templateFile({
          ...base,
          角色代码: 'JOJ',
          人设名称: 'JOJO',
          一句话描述: `喜欢慢慢说话${n}`,
          熟悉后的变化: '会多说两句。',
        }),
      ),
      bindFile: write(
        `bind${n}.md`,
        templateFile({
          ...base,
          角色代码: `BND${n}`,
          人设名称: bindName,
          自称: '「我」',
          '别名（含英文名）': '「Bee」',
        }),
      ),
      errorFile: write(
        `bad${n}.md`,
        templateFile({
          ...base,
          角色代码: 'BAD1',
          人设名称: '错误示例',
          生日: '2001-02-30',
          // Part 24l (named exception): 26 units, one over the new alias cap of 25 (was a 17-unit item over 16).
          自称: `「${'字'.repeat(26)}」`,
          角色主色: '「#111111 一（主）」「#222222 二（主）」',
        }),
      ),
    };
  };

  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const wait = (ms = 500) => page.waitForTimeout(ms);
  // Named exception (Part 24b-7): 导入角色资料 is an inline panel under the title row, not a drawer; same steps, requests and results.
  // The result now stays in the panel, so a panel that is left open is closed with its own 关闭 (it used to close itself).
  const drawer = '.pi-panel';
  const open = async (hash = '#/characters') => {
    await page.goto(`${f.origin}/?mode=provider-admin${hash}`);
    await page.reload();
    await page.locator('#wb-import').waitFor({ state: 'attached', timeout: 20_000 });
    await wait(1200);
  };
  const layout = async (label: string, scope: string) => {
    const read = await page.evaluate(
      (selector: string) => ({
        sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        outside: [...document.querySelectorAll(`${selector} button, ${selector} input, ${selector} table`)].filter(
          (el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
          },
        ).length,
      }),
      scope,
    );
    check(read.sideways <= 0, `${label}: sideways scroll ${read.sideways}px`);
    check(read.outside === 0, `${label}: ${read.outside} elements outside the window`);
  };
  const choose = async (...paths: string[]) => {
    await page.locator(`${drawer} input[type=file]`).setInputFiles(paths);
    await page.locator(`${drawer} .pi-card, ${drawer} .pi-problems`).first().waitFor({ timeout: 10_000 });
    await wait(400);
  };

  let pass = 0;
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    pass++;
    const w = `${width}`;
    const shot = async (name: string, selector?: string) => {
      if (!shots) return;
      await wait(300);
      const path = join(shots, `${name}-${w}.png`);
      if (selector) await page.locator(selector).first().screenshot({ path });
      else await page.screenshot({ path });
    };
    const one = files(pass);
    await page.setViewportSize({ width, height });
    await open();
    await page.locator('#wb-import').evaluate((el: HTMLElement) => el.click());
    await wait(400);
    const before = await (await f.post('characters/list', {})).json();

    // ---- three characters: new / existing / 将绑定代码 ---------------------------------------------------------------------
    await choose(one.newFile, one.existingFile, one.bindFile);
    check((await page.locator(`${drawer} .pi-card`).count()) === 3, `${w}: the preview shows 3 characters`);
    const text = await page.locator(drawer).innerText();
    check(
      text.includes('新角色') && text.includes('已有角色') && text.includes(`将绑定代码 BND${pass}`),
      `${w}: the three modes are named`,
    );
    check(
      // Part 24k-2 (named exception): the second welcome line is a line now, not a checklist item.
      !text.includes('欢迎词 第 2 条 等 24k 多欢迎词') && text.includes('颜色 雾蓝 没有色值'),
      `${w}: the checklist is in the preview`,
    );
    const after = await (await f.post('characters/list', {})).json();
    check(after.characters.length === before.characters.length, `${w}: the preview wrote nothing (no new character)`);
    check(!(await page.locator(`${drawer} .pi-problems`).count()), `${w}: no error on the good files`);
    await layout(`${w} preview`, drawer);
    await shot('preview-3-characters');

    // ---- a blocking error --------------------------------------------------------------------------------------------
    await choose(one.errorFile);
    const bad = await page.locator(drawer).innerText();
    check(bad.includes('整次导入被阻止'), `${w}: the error blocks the import`);
    check(new RegExp(`bad${pass}\\.md · 1 基本信息 · 生日`).test(bad), `${w}: the bad date is located`);
    check(
      new RegExp(`bad${pass}\\.md · 1 基本信息 · 自称 · 第 1 项`).test(bad),
      `${w}: the long alias is located with its item number`,
    );
    check(new RegExp(`bad${pass}\\.md · 2 展示与欢迎内容 · 角色主色`).test(bad), `${w}: the two （主） are located`);
    check(await page.getByRole('button', { name: '确认导入' }).isDisabled(), `${w}: 确认导入 is off`);
    await layout(`${w} error`, drawer);
    await shot('blocking-error');

    // ---- confirm the three, then reload ----------------------------------------------------------------------------
    await choose(one.newFile, one.existingFile, one.bindFile);
    await page.getByRole('button', { name: '确认导入' }).click();
    await wait(1800);
    const toast = await page.locator('.admin-toast').allInnerTexts();
    check(
      toast.some((x: string) => x.includes('已导入 3 个角色的草稿')),
      `${w}: the import says what it did (${toast.join('|')})`,
    );
    await page.reload();
    await page.locator('#wb-import').waitFor({ state: 'attached', timeout: 20_000 });
    await wait(1200);
    const listed = await (await f.post('characters/list', {})).json();
    const made = listed.characters.find((c: { displayName: string }) => c.displayName === one.newName);
    check(!!made, `${w}: the new character is in the roster after the reload`);
    assert.ok(made, problems.join('\n'));
    check(
      listed.characters.length === before.characters.length + 1,
      `${w}: exactly one character was made (the other two were matched)`,
    );

    // ---- the same files again: 没有变化 -----------------------------------------------------------------------------------
    await page.locator('#wb-import').evaluate((el: HTMLElement) => el.click());
    await wait(300);
    await choose(one.newFile, one.existingFile, one.bindFile);
    check(
      (await page.locator(drawer).innerText()).includes('没有变化：这些文件和现在的草稿完全一致'),
      `${w}: the same files again read 没有变化`,
    );
    check(await page.getByRole('button', { name: '确认导入' }).isDisabled(), `${w}: and there is nothing to confirm`);
    await shot('preview-unchanged');
    await page.locator(`${drawer}`).getByRole('button', { name: '关闭' }).click();

    // ---- 身份与展示 of the new character: the code field and the checklist -----------------------------------------
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/${made.characterId}`);
    await page.reload();
    await page.locator('[data-wb-code]').waitFor({ timeout: 20_000 });
    await wait(900);
    check(
      (await page.locator('[data-wb-code]').inputValue()) === `NEW${pass}`,
      `${w}: the code field shows NEW${pass} after the reload`,
    );
    check(
      (await page.locator('.wb-tab .wb-dot:visible').count()) === 0,
      `${w}: opening the role leaves no unsaved dot`,
    );
    const items = await page.locator('.wb-checklist li').allInnerTexts();
    check(
      items.some((x: string) => x.includes(`头像 new${pass}.png 待 25e 上传`)),
      `${w}: the avatar item is on the checklist`,
    );
    check(
      !items.some((x: string) => x.includes('欢迎词 第 2 条 等 24k 多欢迎词')),
      `${w}: the welcome item is gone from the checklist (24k-2: every line imports)`,
    );
    check(
      items.some((x: string) => x.includes('颜色 雾蓝 没有色值，请在工作台选色')),
      `${w}: the colour item is on the checklist`,
    );
    await layout(`${w} identity`, '.wb-card');
    await page.locator('.wb-checklist').first().scrollIntoViewIfNeeded();
    await shot('identity-code-and-checklist');
    await shot('code-field', '.wb-code');

    // ---- 声音: the Fish id is prefilled ------------------------------------------------------------------------------
    await page.locator('.wb-tab', { hasText: '声音' }).first().click();
    await wait(500);
    // Part 29 B (named exception): the one voice field is 「Fish 音色 ID」 (it was 「已有 Fish 音色 referenceId」 on the materials fold).
    const reference = page.locator('label', { hasText: 'Fish 音色 ID' }).locator('input').first();
    check(
      (await reference.inputValue()) === `fish_ref_new${pass}`,
      `${w}: the voice page prefills the Fish referenceId`,
    );
    await layout(`${w} voice`, '.wb-card');
    await shot('voice-prefilled-reference-id');

    // ---- the code is saved on its own; a code held by another character is refused ---------------------------------------
    await page.locator('.wb-tab', { hasText: '身份与展示' }).first().click();
    await page.locator('[data-wb-code]').fill('joj');
    await page.getByRole('button', { name: '保存代码' }).click();
    await wait(800);
    check(
      (await page.locator('.wb-code-note').innerText()).includes('已被别的角色使用'),
      `${w}: a code held by another character is refused, case-insensitively`,
    );
    await page.locator('[data-wb-code]').fill(`NEW${pass}`);
    // dismiss one checklist item and reload: it stays dismissed
    const open0 = await page.locator('.wb-checklist button').count();
    await page.locator('.wb-checklist button').first().click();
    await wait(900);
    check(
      (await page.locator('.wb-checklist li').count()) === open0 - 1,
      `${w}: dismissing removes one checklist item`,
    );
    await page.reload();
    await page.locator('[data-wb-code]').waitFor({ timeout: 20_000 });
    await wait(800);
    check((await page.locator('.wb-checklist li').count()) === open0 - 1, `${w}: the dismissal survives a reload`);

    // ---- the existing and the bound characters ------------------------------------------------------------------------
    const jojo = await (await f.post('characters/jojo/detail', {})).json();
    check(
      jojo.draft?.profile.presentation.publicDescription === `喜欢慢慢说话${pass}`,
      `${w}: jojo: 公开简介 imported into its draft`,
    );
    check(jojo.profileMeta.code === 'JOJ', `${w}: jojo keeps its code`);
    const bound = listed.characters.find((c: { displayName: string }) => c.displayName === one.bindName);
    const detail = await (await f.post(`characters/${bound.characterId}/detail`, {})).json();
    check(detail.profileMeta.code === `BND${pass}`, `${w}: ${one.bindName} was bound to BND${pass}`);
  }
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) throw failure;
// The two 409s are the refused code (PROFILE_CODE_TAKEN) the script asks for on purpose, once per width; the browser logs every 4xx.
for (let i = 0; i < 2; i++) {
  const taken = errors.findIndex((e) => /status of 409/.test(e));
  check(taken >= 0, 'the held code was refused with a 409');
  if (taken >= 0) errors.splice(taken, 1);
}
assert.deepEqual(errors, [], `browser errors:\n${errors.join('\n')}`);
assert.deepEqual(problems, [], `problems:\n${problems.join('\n')}`);
console.log('check-web-profile-import-24j-browser: ok');
