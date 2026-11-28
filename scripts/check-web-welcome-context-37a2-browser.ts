import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 37a-2 in a REAL browser, on the synthetic site of console-fixture-24b6.ts (offline provider). At 1440×900 and 1280×800:
 *   - 欢迎内容: every welcome line has a 情境 box under its words, the same size and look as the words' box; its only explanation is the
 *     hover tip (no sentence on the page); 200 characters is its end;
 *   - typing a note and 保存草稿 keeps it: after a reload it is still in the line, and the saved draft holds it exactly as typed;
 *   - no sideways scroll, no browser error.
 *
 * usage: node scripts/check-web-welcome-context-37a2-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const NOTE = '弟弟家朋用你的账号在他的电话手表上加了玩家，你刚发现。这是你和玩家第一次说话。';
const f = await startConsoleFixture({ provider: { draftMs: 250, reviewMs: 250 } });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  const wait = (ms = 500) => page.waitForTimeout(ms);
  const shot = async (name: string) => {
    if (!shots) return;
    await wait(350);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const open = async (route: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.reload();
    await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
    await wait(1200);
  };
  const tab = (label: string) => page.locator(`button.wb-tab:has(span:text-is("${label}"))`).first().click();

  for (const [width, height, who] of [
    [1440, 900, 'jojo'],
    [1280, 800, 'chen-jimi'],
  ] as const) {
    const at = `${width}x${height}`;
    await page.setViewportSize({ width, height });
    await open(`characters/${who}`);
    await tab('欢迎内容');
    await page.locator('.wl-row').first().waitFor({ timeout: 10_000 });
    await page.locator('.wl-add').click();
    await wait(400);
    const rows = await page.locator('.wl-row').count();
    check(rows === 2, `${at}: expected two lines, got ${rows}`);
    check((await page.locator('.wl-row textarea.wl-context').count()) === rows, `${at}: a line has no 情境 box`);
    // consistent sizes: the 情境 box is as wide and as tall as the words' box, and sits under it
    const box = await page.evaluate(() => {
      const row = document.querySelector('.wl-row')!;
      const rect = (el: Element | null) => {
        const r = el!.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
      };
      return {
        text: rect(row.querySelector('textarea.wl-text:not(.wl-context)')),
        note: rect(row.querySelector('.wl-note')),
      };
    });
    check(box.text.w === box.note.w, `${at}: the 情境 box is ${box.note.w}px wide, the words' box ${box.text.w}px`);
    check(box.text.h === box.note.h, `${at}: the 情境 box is ${box.note.h}px tall, the words' box ${box.text.h}px`);
    check(box.note.top > box.text.top, `${at}: the 情境 box is not under the words`);
    // the only explanation is the hover tip
    const tip = await page.locator('.wl-note').first().getAttribute('title');
    check(!!tip && /朗读/.test(tip) && /玩家看不到/.test(tip), `${at}: the 情境 tip is missing or wrong (${tip})`);
    check(
      !(await page.locator('.wl').innerText()).includes('不会被朗读'),
      `${at}: the tip's sentence is printed on the page`,
    );
    check(
      (await page.locator('.wl-context').first().getAttribute('maxlength')) === '200',
      `${at}: 情境 is not capped at 200`,
    );
    // write a note on line 1 (and the words of both lines, the second left without a note), save
    const texts = page.locator('.wl-row textarea.wl-text:not(.wl-context)');
    await texts.nth(0).fill('家朋怎么又拿电话手表乱加人');
    await texts.nth(1).fill('嗨，你来啦');
    await page.locator('.wl-context').nth(0).fill(NOTE);
    await wait(300);
    await shot(`welcome-context-${at}`);
    await page.locator('.wb-savebar button', { hasText: '保存草稿' }).click();
    await wait(1500);
    await open(`characters/${who}`);
    await tab('欢迎内容');
    await page.locator('.wl-row').first().waitFor({ timeout: 10_000 });
    check((await page.locator('.wl-context').nth(0).inputValue()) === NOTE, `${at}: the note did not survive a reload`);
    check((await page.locator('.wl-context').nth(1).inputValue()) === '', `${at}: the second line gained a note`);
    // saved on the server as part of the draft
    const detail = await (await f.post(`characters/${who}/detail`, {})).json();
    const lines = detail.draft.profile.presentation.welcomes;
    check(
      lines[0].context === NOTE && !('context' in lines[1]),
      `${at}: the draft does not hold the note exactly as typed`,
    );
    const gap = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(gap <= 0, `${at}: sideways scroll of ${gap}px`);
  }
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
for (const message of [...problems, ...errors]) console.error(message);
if (problems.length || errors.length) process.exitCode = 1;
else if (!failure) console.log('37a-2 browser check: ok');
