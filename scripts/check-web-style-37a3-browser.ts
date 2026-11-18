import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 37a-3 in a REAL browser, on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider and judge. At 1440×900
 * and 1280×800, 多轮预演 with DeepSeek·旧 next to DeepSeek·新:
 *   - 评估说话方式 is off at first (the button names 32 calls); pressing it adds one judge call per column (34) and the start says so;
 *   - when the run is done the counts table has 说了自己的事 / 主动起话题 / 情绪起伏 as `n / 8`, and 以问句结尾 with its target;
 *   - no id, email or nickname on the screen; no sideways scroll; no browser error.
 *
 * usage: node scripts/check-web-style-37a3-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
  const detail = await (await f.post('characters/wei-guagua/detail', {})).json();
  const profile = structuredClone(detail.published.profile);
  profile.template.version += 1;
  await f.post('characters/wei-guagua/save', { expectedRevision: detail.draft?.revision ?? null, profile });

  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    const at = `${width}`;
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
    await page.reload();
    await page.getByText('预演', { exact: true }).first().click();
    if (width >= 1280) {
      await page.locator('.pw-split .pw-half-rehearsal .rh-rail .rh-pick').first().waitFor({ timeout: 20_000 });
      await wait(1000);
    } else {
      await page.locator('[data-pw-rehearsal]').waitFor({ timeout: 20_000 });
      await wait(1000);
      await page.locator('[data-pw-rehearsal]').click();
    }
    await page.locator('.rh-rail .rh-pick').first().waitFor({ timeout: 10_000 });
    await wait(700);
    await page.locator('.rh-rail .rh-pick', { hasText: '日常闲聊' }).click();
    const v8 = page.locator('.rh-toggle[data-model="deepseek-v8"]');
    if ((await v8.getAttribute('aria-pressed')) !== 'true') await v8.click();
    await wait(800);
    const styleToggle = page.locator('.rh-toggle', { hasText: '评估说话方式' });
    check((await styleToggle.getAttribute('aria-pressed')) === 'false', `${at}: 评估说话方式 is off at first`);
    const send = page.locator('[data-pw-send="rehearsal"]');
    await send.waitFor();
    check(/32 次调用/.test((await send.textContent()) as string), `${at}: off, the button names 32 calls`);
    await page.mouse.move(5, 5);
    await shot(`style-setup-off-${at}`);
    await styleToggle.click();
    await page.waitForFunction(
      () => /34 次调用/.test(document.querySelector('[data-pw-send="rehearsal"]')?.textContent ?? ''),
      null,
      { timeout: 15_000 },
    );
    check((await styleToggle.getAttribute('aria-pressed')) === 'true', `${at}: the toggle reads as pressed`);
    await styleToggle.hover();
    await wait(500);
    await shot(`style-setup-on-${at}`);
    await page.mouse.move(5, 5);
    const runsBefore = await page.locator('.rh-run').count();
    await send.click();
    await send.click();
    await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
    const started = bodies.filter((b) => /rehearsal\/start/.test(b.url)).at(-1)!;
    check(JSON.parse(started.body).style === true, `${at}: the start carries style: true (${started.body})`);
    await page.waitForFunction(
      (n: number) =>
        document.querySelectorAll('.rh-run').length > n &&
        /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
      runsBefore,
      { timeout: 120_000 },
    );
    await page.locator('.seg-button', { hasText: '统计' }).click();
    await page.locator('.rh-counts').waitFor();
    await wait(900);
    const rows = await page
      .locator('.rh-counts tbody tr')
      .evaluateAll((trs: HTMLElement[]) => trs.map((tr) => tr.innerText.replace(/\s+/g, ' ')));
    const own = rows.find((r) => r.startsWith('说了自己的事'));
    const topic = rows.find((r) => r.startsWith('主动起话题'));
    const feeling = rows.find((r) => r.startsWith('情绪起伏'));
    const question = rows.find((r) => r.startsWith('以问句结尾'));
    check(own && /\d \/ 8 \d \/ 8$/.test(own), `${at}: 说了自己的事 is n / 8 per column (${own})`);
    check(topic && /\d \/ 8 \d \/ 8$/.test(topic), `${at}: 主动起话题 (${topic})`);
    check(feeling && /\d \/ 8 \d \/ 8$/.test(feeling), `${at}: 情绪起伏 (${feeling})`);
    check(
      question && /目标/.test(question) && /\d \/ 8/.test(question),
      `${at}: 以问句结尾 stays, with its target (${question})`,
    );
    check(!rows.some((r) => /^答全每条/.test(r) && /未得出|等待/.test(r)), `${at}: nothing left waiting`);
    const order = rows.map((r) => r.split(' ')[0]);
    check(
      order.indexOf('说了自己的事') < order.indexOf('主动起话题') &&
        order.indexOf('情绪起伏') < order.indexOf('以问句结尾'),
      `${at}: the three counts sit before 以问句结尾 (${order})`,
    );
    await shot(`style-counts-${at}`);
    const all = await page.evaluate(() => ({
      text: document.body.innerText,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      tableOverflow: Math.max(
        0,
        ...Array.from(document.querySelectorAll('.rh-counts')).map(
          (t) => t.scrollWidth - (t.parentElement?.clientWidth ?? 0),
        ),
      ),
    }));
    check(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(all.text), `${at}: an id is on the screen`);
    check(!/@|初识|亲近朋友|恋人/.test(all.text), `${at}: an email or relationship wording on the screen`);
    check(all.overflow <= 0, `${at}: sideways scroll of ${all.overflow}px`);
    check(all.tableOverflow <= 0, `${at}: the counts table overflows its box by ${all.tableOverflow}px`);
    await page.keyboard.press('Escape');
    await wait(400);
  }
  check(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
} finally {
  await f.close();
}
assert.deepEqual(problems, [], problems.join('\n'));
console.log('part 37a-3 browser checks passed');
