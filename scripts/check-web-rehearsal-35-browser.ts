import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 35: 多轮预演 in a REAL browser, on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the
 * machine; every call is a scripted answer after a short wait). At 1280×800 and 1440×900:
 *   - a script editor (a saved script of 6 turns, the name, the count);
 *   - the paid button names the calls and the total, a first click only arms it, the second sends exactly the confirmed total;
 *   - a three-model run: the conversations side by side, aligned by turn, one column per model, mid-conversation and finished;
 *   - the counts per model; the 梗与故事 hit / miss table;
 *   - NO relationship selector, no 初识 / 朋友 / 亲近朋友 / 恋人, no test slider, anywhere on the page or in a request;
 *   - no id on the screen; no sideways scroll; no solid primary added by the panel.
 *
 * usage: node scripts/check-web-rehearsal-35-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const f = await startConsoleFixture({ provider: { draftMs: 350, reviewMs: 350 } });
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
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
    await page.reload();
    await page.getByText('预演', { exact: true }).first().click();
    await page.locator('[data-pw-rehearsal]').waitFor({ timeout: 20_000 });
    await wait(1200);
    const at = `${width}`;

    // ---- no relationship concept anywhere ----
    const page0 = await page.evaluate(() => ({
      text: document.body.innerText,
      ranges: document.querySelectorAll('input[type="range"]').length,
      labels: [...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
    }));
    check(!/初识|亲近朋友|恋人|预演关系/.test(page0.text), `${at}: relationship wording on the page`);
    check(!page0.labels.includes('预演关系'), `${at}: a 预演关系 control`);
    check(page0.ranges === 0, `${at}: a slider on the page`);
    await shot(`preview-no-relationship-${at}`);

    await page.locator('[data-pw-rehearsal]').click();
    await page.locator('.rh-rail .rh-pick').first().waitFor({ timeout: 10_000 });
    await wait(900);

    // ---- the script editor ----
    await page.locator('.rh-add').click();
    await page.locator('.rh-editor input[type="text"]').fill(`脚本${at}`);
    await page
      .locator('.rh-editor textarea')
      .fill(['嗨，在干嘛呢', '今天有点无聊', '刚吃完饭', '周末你怎么过', '突然想吃火锅', '好啦我去洗碗了'].join('\n'));
    await wait(400);
    check((await page.locator('.rh-count').textContent()) === '6 轮', `${at}: the count reads 6 轮`);
    await shot(`script-editor-${at}`);
    await page.locator('.rh-editor .rh-actions button', { hasText: '保存' }).click();
    await wait(900);
    check(
      await page.locator('.rh-rail .rh-pick', { hasText: `脚本${at}` }).count(),
      `${at}: the saved script is in the rail`,
    );

    // ---- a three-model run on 日常闲聊 ----
    await page.locator('.rh-rail .rh-pick', { hasText: '日常闲聊' }).click();
    for (const id of ['gemini', 'xai']) {
      const t = page.locator(`.rh-toggle[data-model="${id}"]`);
      if ((await t.getAttribute('aria-pressed')) !== 'true') await t.click();
    }
    await wait(700);
    const send = page.locator('[data-pw-send="rehearsal"]');
    await send.waitFor();
    const label = (await send.textContent()) as string;
    check(/48 次调用/.test(label) && /\$/.test(label), `${at}: the button names 48 calls and the total (${label})`);
    const runsBefore = await page.locator('.rh-run').count();
    const before = bodies.filter((b) => /rehearsal\/start/.test(b.url)).length;
    await send.click();
    check((await send.getAttribute('data-state')) === 'confirm', `${at}: the first click only arms the button`);
    check(
      bodies.filter((b) => /rehearsal\/start/.test(b.url)).length === before,
      `${at}: the first click sent nothing`,
    );
    await shot(`estimate-confirm-${at}`);
    await send.click();
    await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
    const started = bodies.filter((b) => /rehearsal\/start/.test(b.url)).at(-1)!;
    const sent = JSON.parse(started.body);
    check(!('relationship' in sent), `${at}: the request carries no relationship`);
    check(
      Number.isSafeInteger(sent.acknowledgeMicros) && sent.acknowledgeMicros > 0,
      `${at}: the confirmed total is sent`,
    );
    // mid-conversation: some replies are in, others still wait
    await page.waitForFunction(() => document.querySelectorAll('.rh-cell[data-state="done"]').length >= 6, null, {
      timeout: 30_000,
    });
    const heads = await page.locator('.rh-head').allTextContents();
    check(
      heads.length === 4 && heads.slice(1).join(',') === 'DeepSeek,Gemini 3.8 Flash,Grok 4.7',
      `${at}: one column per model (${heads})`,
    );
    await shot(`three-models-mid-${at}`);
    // aligned: every row's cells share the row's top
    const rows = await page.evaluate(() => {
      const grid = document.querySelector('.rh-grid')!;
      const cells = [...grid.querySelectorAll('.rh-player, .rh-cell')] as HTMLElement[];
      const byRow = new Map<number, number>();
      for (const c of cells)
        byRow.set(
          Math.round(c.getBoundingClientRect().top),
          (byRow.get(Math.round(c.getBoundingClientRect().top)) ?? 0) + 1,
        );
      return { rows: [...byRow.values()], cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length };
    });
    check(
      rows.cols === 4 && rows.rows.every((n: number) => n === 4),
      `${at}: the turns are aligned across the columns (${JSON.stringify(rows)})`,
    );
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll('.rh-run').length > n &&
        /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
      runsBefore,
      { timeout: 90_000 },
    );
    await shot(`three-models-done-${at}`);

    // ---- the counts ----
    await page.locator('.seg-button', { hasText: '统计' }).click();
    await page.locator('.rh-counts').waitFor();
    await wait(700);
    const counts = await page
      .locator('.rh-counts tbody tr')
      .evaluateAll((trs: HTMLElement[]) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
    check(counts.length === 8, `${at}: eight counts per model (${counts.length})`);
    check(/答全每条 8 \/ 8/.test(counts[0] ?? ''), `${at}: answers counted (${counts[0]})`);
    check(
      /客服腔 0 \d+ \d+/.test(counts[5] ?? '') && !/客服腔 0 0 0/.test(counts[5] ?? ''),
      `${at}: customer-service phrases counted (${counts[5]})`,
    );
    await shot(`counts-${at}`);

    // ---- 梗与故事 ----
    await page.locator('.rh-rail .rh-pick', { hasText: '梗与故事' }).click();
    await wait(700);
    check(
      (await page.locator('.rh-toggle', { hasText: '带关系与故事' }).getAttribute('aria-pressed')) === 'true',
      `${at}: 带关系与故事 is on for 梗与故事`,
    );
    const memeSend = page.locator('[data-pw-send="rehearsal"]');
    await page.waitForFunction(
      () => /次调用/.test(document.querySelector('[data-pw-send="rehearsal"]')?.textContent ?? ''),
      null,
      { timeout: 15_000 },
    );
    const memeBefore = await page.locator('.rh-run').count();
    await memeSend.click();
    await memeSend.click();
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll('.rh-run').length > n &&
        /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
      memeBefore,
      { timeout: 120_000 },
    );
    await page.locator('.seg-button', { hasText: '梗与故事' }).click();
    await page.locator('.rh-memes').waitFor();
    await wait(700);
    const memeText = await page.locator('.rh-memes').innerText();
    check(
      /命中/.test(memeText) && /漏/.test(memeText) && /没误触/.test(memeText),
      `${at}: the table says 命中 / 漏 / 没误触`,
    );
    await shot(`meme-table-${at}`);

    // ---- what is on the screen ----
    const all = await page.evaluate(() => ({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      primaries: [...document.querySelectorAll('.admin-drawer button')].filter(
        (b) => getComputedStyle(b).backgroundColor === 'rgb(91, 79, 196)',
      ).length,
    }));
    check(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(all.text), `${at}: an id is on the screen`);
    check(!/初识|亲近朋友|恋人/.test(all.text), `${at}: relationship wording after the run`);
    check(all.overflow <= 0, `${at}: sideways scroll of ${all.overflow}px`);
    check(all.primaries <= 1, `${at}: ${all.primaries} solid primaries in the panel`);
    await page.keyboard.press('Escape');
    await wait(400);
  }
  check(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
} finally {
  await f.close();
}
assert.deepEqual(problems, [], problems.join('\n'));
console.log('part 35 browser checks passed');
