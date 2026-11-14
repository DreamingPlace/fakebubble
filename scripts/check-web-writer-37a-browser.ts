import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 37a in a REAL browser, on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the machine).
 * At 1440×900 and 1280×800:
 *   - 系统 → 模型与价格: the owner sees 回复写法 with 现行 pressed; 新 asks one in-place confirmation; the save carries a request id and
 *     the value and nothing else; the pill and the pressed option move; a reload still says 新; 现行 comes back the same way;
 *   - 多轮预演: each model has its own 现行 / 新; DeepSeek·现行 next to DeepSeek·新 runs, aligned by turn; the 新 column carries no
 *     "answered every message" claim (—), and the live switch plays no part;
 *   - no id, email or nickname on the screen; no sideways scroll; no browser error; no relationship wording.
 *
 * usage: node scripts/check-web-writer-37a-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const SIZES = [
  [1440, 900],
  [1280, 800],
] as const;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const f = await startConsoleFixture({ provider: { draftMs: 250, reviewMs: 250 } });
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  page.on('response', (r: { status: () => number; url: () => string }) => {
    if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
  });
  const bodies: { url: string; body: string }[] = [];
  page.on('request', (r: { method: () => string; url: () => string; postData: () => string | null }) => {
    if (r.method() === 'POST') bodies.push({ url: r.url(), body: r.postData() ?? '' });
  });
  watchRequests(page);
  const wait = (ms = 600) => quietWait(page, ms);
  const shot = async (name: string) => {
    if (!shots) return;
    await wait(300);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  // a saved draft for the role (a 预演 runs on the SAVED draft)
  const detail = await (await f.post('characters/wei-guagua/detail', {})).json();
  const profile = structuredClone(detail.published.profile);
  profile.template.version += 1;
  await f.post('characters/wei-guagua/save', { expectedRevision: detail.draft?.revision ?? null, profile });

  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    const at = `${width}`;

    // ---- 系统 → 模型与价格: the switch ----
    await page.goto(`${f.origin}/?mode=provider-admin#/models`);
    await page.reload();
    await page.locator('.models-writer').waitFor({ timeout: 20_000 });
    await wait(900);
    const card = page.locator('.models-writer');
    check(
      (await card.locator('[data-seg="v7"]').getAttribute('aria-pressed')) === 'true',
      `${at}: 现行 is pressed at first`,
    );
    check(/当前：现行/.test(await card.innerText()), `${at}: the pill says 当前：现行`);
    const cardText = await card.innerText();
    check(cardText.replace(/\s+/g, '').length <= 60, `${at}: the card is minimal (${cardText.length} characters)`);
    await shot(`writer-switch-current-${at}`);
    const savesBefore = bodies.filter((b) => /system\/writer-save/.test(b.url)).length;
    await card.locator('[data-seg="v8"]').click();
    await wait(500);
    await shot(`writer-switch-confirm-${at}`);
    check(
      bodies.filter((b) => /system\/writer-save/.test(b.url)).length === savesBefore,
      `${at}: choosing 新 sends nothing before the confirmation`,
    );
    await page.locator('.models-writer .models-confirm button', { hasText: /确认切换/ }).click();
    await page.waitForFunction(
      () => /当前：新/.test(document.querySelector('.models-writer')?.textContent ?? ''),
      null,
      {
        timeout: 15_000,
      },
    );
    const saved = bodies.filter((b) => /system\/writer-save/.test(b.url)).at(-1)!;
    const sent = JSON.parse(saved.body);
    check(
      Object.keys(sent).sort().join(',') === 'requestId,writer' &&
        sent.writer === 'v8' &&
        typeof sent.requestId === 'string',
      `${at}: the save is {requestId, writer} (${saved.body})`,
    );
    check(
      (await card.locator('[data-seg="v8"]').getAttribute('aria-pressed')) === 'true',
      `${at}: 新 is pressed after the save`,
    );
    await shot(`writer-switch-new-${at}`);
    await page.reload();
    await page.locator('.models-writer').waitFor({ timeout: 20_000 });
    await wait(700);
    check(/当前：新/.test(await page.locator('.models-writer').innerText()), `${at}: a reload still says 新`);

    // ---- 多轮预演: 现行 next to 新 (the live switch says 新; the columns decide) ----
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
    await page.reload();
    await page.getByText('预演', { exact: true }).first().click();
    await page.locator('[data-pw-rehearsal]').waitFor({ timeout: 20_000 });
    await wait(1000);
    await page.locator('[data-pw-rehearsal]').click();
    await page.locator('.rh-rail .rh-pick').first().waitFor({ timeout: 10_000 });
    await wait(700);
    await page.locator('.rh-rail .rh-pick', { hasText: '日常闲聊' }).click();
    const groups = await page.locator('.rh-model').count();
    check(groups === 3, `${at}: one group per model (${groups})`);
    check(
      (await page.locator('.rh-toggle[data-model="deepseek"]').getAttribute('aria-pressed')) === 'true',
      `${at}: DeepSeek·现行 is on at first`,
    );
    const v8 = page.locator('.rh-toggle[data-model="deepseek-v8"]');
    if ((await v8.getAttribute('aria-pressed')) !== 'true') await v8.click();
    await wait(800);
    // A pressed toggle looks pressed even under the pointer (the hover must not repaint it as an unpressed one).
    const hovered = await page.evaluate(() => {
      const b = document.querySelector('.rh-toggle[data-model="deepseek-v8"]') as HTMLElement;
      return {
        pressed: b.getAttribute('aria-pressed'),
        bg: getComputedStyle(b).backgroundColor,
        border: getComputedStyle(b).borderColor,
      };
    });
    const idle = await page.evaluate(() => {
      const b = document.querySelector('.rh-toggle[data-model="xai-v8"]') as HTMLElement;
      return { pressed: b.getAttribute('aria-pressed'), bg: getComputedStyle(b).backgroundColor };
    });
    check(
      hovered.pressed === 'true' && hovered.bg !== idle.bg,
      `${at}: DeepSeek·新 reads as pressed (${JSON.stringify(hovered)} vs ${JSON.stringify(idle)})`,
    );
    await page.mouse.move(5, 5);
    await wait(400);
    await shot(`rehearsal-columns-${at}`);
    const send = page.locator('[data-pw-send="rehearsal"]');
    await send.waitFor();
    const label = (await send.textContent()) as string;
    check(/32 次调用/.test(label) && /\$/.test(label), `${at}: the button names 32 calls and the total (${label})`);
    const runsBefore = await page.locator('.rh-run').count();
    await send.click();
    await send.click();
    await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
    const started = bodies.filter((b) => /rehearsal\/start/.test(b.url)).at(-1)!;
    const startBody = JSON.parse(started.body);
    check(
      JSON.stringify(startBody.models) === JSON.stringify(['deepseek', 'deepseek-v8']),
      `${at}: the start carries both columns (${JSON.stringify(startBody.models)})`,
    );
    check(!('relationship' in startBody), `${at}: the request carries no relationship`);
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll('.rh-run').length > n &&
        /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
      runsBefore,
      { timeout: 90_000 },
    );
    const heads = await page.locator('.rh-head').allTextContents();
    check(heads.slice(1).join(',') === 'DeepSeek·现行,DeepSeek·新', `${at}: the columns are named (${heads})`);
    await shot(`rehearsal-run-${at}`);
    await page.locator('.seg-button', { hasText: '统计' }).click();
    await page.locator('.rh-counts').waitFor();
    await wait(700);
    const counts = await page
      .locator('.rh-counts tbody tr')
      .evaluateAll((trs: HTMLElement[]) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
    check(/答全每条 8 \/ 8 —/.test(counts[0] ?? ''), `${at}: 现行 answers counted, 新 says — (${counts[0]})`);
    await shot(`rehearsal-counts-${at}`);

    // ---- what is on the screen ----
    const all = await page.evaluate(() => ({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    check(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(all.text), `${at}: an id is on the screen`);
    check(!/@|初识|亲近朋友|恋人/.test(all.text), `${at}: an email or relationship wording on the screen`);
    check(all.overflow <= 0, `${at}: sideways scroll of ${all.overflow}px`);
    await page.keyboard.press('Escape');
    await wait(400);

    // back to 现行 for the next size, the same way
    await page.goto(`${f.origin}/?mode=provider-admin#/models`);
    await page.reload();
    await page.locator('.models-writer').waitFor({ timeout: 20_000 });
    await wait(700);
    await page.locator('.models-writer [data-seg="v7"]').click();
    await page.locator('.models-writer .models-confirm button', { hasText: /确认切换/ }).click();
    await page.waitForFunction(
      () => /当前：现行/.test(document.querySelector('.models-writer')?.textContent ?? ''),
      null,
      {
        timeout: 15_000,
      },
    );
  }
  check(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
} finally {
  await f.close();
}
assert.deepEqual(problems, [], problems.join('\n'));
console.log('part 37a browser checks passed');
