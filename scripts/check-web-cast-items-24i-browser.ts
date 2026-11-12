import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24i: the two ordered text lists of 关系与故事 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts:
 * a character's 别名 (text, 类型, 态度) and a direction's 称呼. It drives the real page: add / delete / reorder / save / reload for a
 * 12-alias list (with a 16-unit English name with spaces) and a 6-address direction, flags a 17-unit item on its own row (the text is
 * never cut), and checks the page keeps the console rules at 1440×900 and 1280×800 (no sideways scroll, nothing outside its box).
 *
 * usage: node scripts/check-web-cast-items-24i-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * With a directory it also writes the screenshots (the review branch gets them).
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
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  const wait = (ms = 500) => page.waitForTimeout(ms);
  const open = async () => {
    await page.goto(`${f.origin}/?mode=provider-admin#/cast`);
    await page.reload();
    await page.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
    await wait(1200);
  };
  const shot = async (name: string) => {
    if (!shots) return;
    await wait(300);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const list = (kind: 'aliases' | 'addresses') => page.locator(`.cs-items[data-list="${kind}"]`).first();
  const texts = (kind: 'aliases' | 'addresses') =>
    list(kind)
      .locator('.cs-item-text')
      .evaluateAll((nodes: HTMLInputElement[]) => nodes.map((n) => n.value));
  const kinds = () =>
    list('aliases')
      .locator('.cs-item')
      .evaluateAll((rows: HTMLElement[]) =>
        rows.map((row) => [
          (row.querySelector('select.cs-item-kind') as HTMLSelectElement).selectedOptions[0]!.textContent,
          (row.querySelector('select.cs-item-attitude') as HTMLSelectElement).selectedOptions[0]!.textContent,
        ]),
      );
  const counts = (kind: 'aliases' | 'addresses') => list(kind).locator('.cs-items-count').first().textContent();
  const add = async (kind: 'aliases' | 'addresses') => {
    await list(kind).locator('button.cs-add').click();
    await wait(60);
  };
  const fill = async (kind: 'aliases' | 'addresses', index: number, text: string) => {
    await list(kind).locator('.cs-item-text').nth(index).fill(text);
  };
  const save = async () => {
    await page.getByRole('button', { name: '保存草稿' }).first().click();
    await wait(1500);
  };
  const layout = async (label: string) => {
    const read = await page.evaluate(() => ({
      sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      outside: [
        ...document.querySelectorAll('.cs-items button, .cs-items input, .cs-items select, .cs-items .cs-item-error'),
      ].filter((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
      }).length,
      clipped: [...document.querySelectorAll('.cs-items .cs-item-row')].filter((row) => {
        const r = row.getBoundingClientRect();
        return [...row.children].some((c) => {
          const b = c.getBoundingClientRect();
          return b.width > 0 && (b.right > r.right + 1 || b.left < r.left - 1);
        });
      }).length,
    }));
    check(read.sideways <= 0, `${label}: sideways scroll ${read.sideways}px`);
    check(read.outside === 0, `${label}: ${read.outside} controls outside the window`);
    check(read.clipped === 0, `${label}: ${read.clipped} rows hold a control outside the row`);
  };

  // ---- 别名: a character's name card -----------------------------------------------------------------------------------
  await page.setViewportSize({ width: 1440, height: 900 });
  await open();
  await page.locator('.cs-head-col').first().click();
  await wait(700);
  const before = await texts('aliases');
  check(before.length === 2, `the sample character starts with 2 aliases (${before.length})`);
  const KINDS = ['别名', '自称', '中性称呼', '黑称'] as const;
  const FEELS = ['喜欢', '可以', '不喜欢'] as const;
  const names = [
    '小满',
    'Mary Jane Watson', // 16 units with inner spaces
    '本姑娘',
    '路人甲',
    '怂包',
    '满满同学',
    'Hazel Zhou',
    '阿满',
    '小满满',
    '满仔',
    '😀'.repeat(8), // 16 units, astral
    '字'.repeat(16),
  ];
  while ((await texts('aliases')).length < 12) await add('aliases');
  check((await counts('aliases')) === '12/12', `list count 12/12 (${await counts('aliases')})`);
  check(await list('aliases').locator('button.cs-add').isDisabled(), '加一项 is disabled at 12');
  for (const [index, text] of names.entries()) {
    await fill('aliases', index, text);
    await list('aliases')
      .locator('select.cs-item-kind')
      .nth(index)
      .selectOption({ label: KINDS[index % 4]! });
    await list('aliases')
      .locator('select.cs-item-attitude')
      .nth(index)
      .selectOption({ label: FEELS[index % 3]! });
  }
  const counted = await list('aliases').locator('.cs-item-count').allTextContents();
  check(
    // Part 24l addendum 3: alias cap 25 (the 16-unit items now count 16/25; 称呼 stays x/16)
    counted[1] === '16/25' && counted[10] === '16/25' && counted[11] === '16/25',
    `16-unit items count 16/25 (${counted})`,
  );
  check(
    (await list('aliases').locator('.cs-item[data-invalid="true"]').count()) === 0,
    'no error row for 16-unit items',
  );
  await shot('aliases-12-1440');
  // Part 24l addendum 3: alias cap 25 - a 26-unit item: kept as typed, flagged on its own row
  await fill('aliases', 3, '字'.repeat(26));
  const flagged = list('aliases').locator('.cs-item').nth(3);
  check((await flagged.getAttribute('data-invalid')) === 'true', 'the 26-unit row is flagged');
  const sentence = (await flagged.locator('.cs-item-error').textContent()) ?? '';
  check(/别名 第 4 项 — 超过 25 字/.test(sentence), `the row says 「…别名 第 4 项 — 超过 25 字」 (${sentence})`);
  check((await texts('aliases'))[3]!.length === 26, 'the 26 units are kept, not cut');
  check(
    (await list('aliases').locator('.cs-item-count').nth(3).textContent()) === '26/25',
    'the row count reads 26/25',
  );
  await shot('aliases-error-1440');
  await layout('别名 1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await wait(500);
  await shot('aliases-error-1280');
  await layout('别名 1280');
  await fill('aliases', 3, '路人甲');
  await shot('aliases-12-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  await wait(400);
  // Part 27 (named exception): 上移 / 下移 are gone. Reorder: row 3's handle is dragged up with the pointer (with motion), and the
  // first row cannot move up with Alt+↑ either.
  const order = await texts('aliases');
  const handleOf = (kind: 'aliases' | 'addresses', n: number) =>
    list(kind)
      .locator('.cs-item-handle')
      .nth(n - 1);
  const from = (await handleOf('aliases', 3).boundingBox())!;
  const to = (await handleOf('aliases', 2).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 4, { steps: 6 });
  await page.mouse.up();
  await wait(500);
  const moved = await texts('aliases');
  check(
    moved[1] === order[2] && moved[2] === order[1],
    `dragging row 3's handle up swaps rows 2 and 3 (${moved.slice(0, 3)})`,
  );
  await handleOf('aliases', 1).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await wait(150);
  check(JSON.stringify(await texts('aliases')) === JSON.stringify(moved), 'the first row cannot move up');
  // delete the last row and add it back
  await list('aliases').locator('button[aria-label="删除别名第 12 项"]').click();
  await wait(100);
  check((await counts('aliases')) === '11/12', '删除 gives 11/12');
  await add('aliases');
  await fill('aliases', 11, '字'.repeat(16));
  await list('aliases').locator('select.cs-item-kind').nth(11).selectOption({ label: '黑称' });
  const expectTexts = await texts('aliases');
  const expectKinds = await kinds();
  await save();
  await open();
  await page.locator('.cs-head-col').first().click();
  await wait(700);
  check(
    JSON.stringify(await texts('aliases')) === JSON.stringify(expectTexts),
    `aliases reload in order (${await texts('aliases')})`,
  );
  check(
    JSON.stringify(await kinds()) === JSON.stringify(expectKinds),
    `kind and attitude reload per row (${JSON.stringify(await kinds())})`,
  );

  // ---- 称呼: a direction ------------------------------------------------------------------------------------------------
  await page.locator('.cs-cell[data-from][data-to]').first().click();
  await wait(700);
  check((await list('addresses').count()) === 1, 'the direction editor shows its 称呼 list');
  while ((await texts('addresses')).length < 6) await add('addresses');
  const wanted = ['小羊', 'XX老师', 'XXX', 'Mary Jane', '😀'.repeat(8), '字'.repeat(16)];
  for (const [index, text] of wanted.entries()) await fill('addresses', index, text);
  check((await counts('addresses')) === '6/6', `address count 6/6 (${await counts('addresses')})`);
  check(await list('addresses').locator('button.cs-add').isDisabled(), '加一项 is disabled at 6');
  await list('addresses').scrollIntoViewIfNeeded();
  await shot('addresses-6-1440');
  await fill('addresses', 1, '字'.repeat(17));
  check(
    (await list('addresses').locator('.cs-item-error').nth(1).textContent())?.includes('称呼 第 2 项 — 超过 16 字'),
    'the address row names its item',
  );
  await list('addresses').scrollIntoViewIfNeeded();
  await shot('addresses-error-1440');
  await layout('称呼 1440');
  await page.setViewportSize({ width: 1280, height: 800 });
  await wait(500);
  await list('addresses').scrollIntoViewIfNeeded();
  await shot('addresses-error-1280');
  await layout('称呼 1280');
  await fill('addresses', 1, 'XX老师');
  await list('addresses').scrollIntoViewIfNeeded();
  await shot('addresses-6-1280');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Part 27 (named exception): keyboard reorder, Alt+↑ on the focused handle of item 3, announced to screen readers.
  await handleOf('addresses', 3).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await wait(200);
  check(
    /移到第 2 位，共 6 项/.test((await list('addresses').locator('[role="status"]').textContent()) ?? ''),
    'the keyboard move is announced',
  );
  check(
    (await page.evaluate(() => document.activeElement?.classList.contains('cs-item-handle'))) === true,
    'the focus stays on the handle after the keyboard move',
  );
  const addrOrder = await texts('addresses');
  check(addrOrder[1] === 'XXX' && addrOrder[2] === 'XX老师', `称呼 reorder (${addrOrder.slice(0, 3)})`);
  const joined = addrOrder.join(' / ');
  const tip = await page.locator('.cs-cell[data-from][data-to]').first().getAttribute('aria-label');
  check(!!tip && tip.includes(joined), `the grid cell's hover text shows the items joined with " / " (${tip})`);
  await save();
  await open();
  await page.locator('.cs-cell[data-from][data-to]').first().click();
  await wait(700);
  check(
    JSON.stringify(await texts('addresses')) === JSON.stringify(addrOrder),
    `addresses reload in order (${await texts('addresses')})`,
  );
  await list('addresses').scrollIntoViewIfNeeded();
  await shot('addresses-after-reload-1440');
  check(errors.length === 0, `browser errors: ${errors.slice(0, 3).join(' | ')}`);
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) throw failure;
assert.deepEqual(problems, [], problems.join('\n'));
console.log('check-web-cast-items-24i-browser: ok');
