import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24k-1 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts, started with its offline provider AND its offline
 * Fish stand-in (a short wait, then a synthetic tone; nothing reaches a provider), at 1440x900 and 1280x800:
 *   - 声音: after 准备新素材版本 each empty slot offers 生成 next to the upload. The first click only asks (amber, the cost on the button, the API
 *     not called); the second sends; the clip lands in the slot marked 生成; 加载…试听 plays it; 批准此素材版本 stays off until the human ticks;
 *   - 预演: a succeeded row opens with 试听: first click asks, second speaks the final bubbles and plays them; afterwards a free 播放 replaces
 *     the paid button (no second charge); a character without a voice reference shows the button off with 「先填音色 referenceId」;
 *   - no sideways scroll, no layer opened, nothing outside its box.
 * `--baseline` runs the same site WITHOUT the speech path (the page as it was before this Part) and only takes the two "before" shots.
 *
 * usage: node scripts/check-web-speech-24k1-browser.ts [screenshot-dir] [--baseline]   (run `pnpm web:player:build` first)
 */
const args = process.argv.slice(2);
const baseline = args.includes('--baseline');
const dir = args.find((a) => !a.startsWith('--'));
const shots = dir ? resolve(dir) : null;
if (shots) mkdirSync(shots, { recursive: true });

const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: !baseline });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  const page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  const sent: string[] = [];
  page.on('request', (request: { method: () => string; url: () => string }) => {
    if (request.method() === 'POST') sent.push(request.url());
  });
  const calls = (pattern: RegExp) => sent.filter((url) => pattern.test(url)).length;
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
  const sideways = async (where: string) => {
    const gap = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(gap <= 0, `${where}: sideways scroll of ${gap}px`);
  };
  const noLayers = async (where: string) => {
    const n = await page.evaluate(
      () => document.querySelectorAll('.admin-drawer:not([hidden]), .admin-dialog, dialog[open]').length,
    );
    check(n === 0, `${where}: a drawer or dialog is open (${n})`);
  };
  const inside = async (where: string, selector: string, container: string) => {
    const ok = await page.evaluate(
      ({ selector: s, container: c }: { selector: string; container: string }) => {
        const el = document.querySelector(s)?.getBoundingClientRect();
        const box = document.querySelector(c)?.getBoundingClientRect();
        return !el || !box || (el.left >= box.left - 1 && el.right <= box.right + 1);
      },
      { selector, container },
    );
    check(ok, `${where}: ${selector} sticks out of ${container}`);
  };
  const tab = (label: string) => page.locator(`button.wb-tab:has(span:text-is("${label}"))`).first().click();

  // A character without any voice reference, with a saved draft (its published profile, one version on).
  const was = await (await f.post('characters/c04/detail', {})).json();
  const next = structuredClone(was.published.profile);
  next.template.version = was.published.version + 1;
  await f.post('characters/c04/save', { expectedRevision: null, profile: next });

  /** Submits one line on the open 预演 tab (two clicks: ask, then send) and opens its finished row. */
  const runPreview = async (text: string) => {
    await tab('预演');
    await page.locator('textarea[aria-label="预演输入"]').fill(text);
    const send = page.locator('[data-pw-send="preview"]');
    await send.click();
    await send.click();
    const row = page.locator('.pw-line', { hasText: text }).first();
    await row.locator('.admin-badge:has-text("完成")').waitFor({ timeout: 30_000 });
    await row.locator('.pw-row').first().click();
    await row.locator('.pw-detail').waitFor({ timeout: 10_000 });
    if (!baseline) await row.locator('.pw-listen').waitFor({ timeout: 10_000 });
    return row;
  };

  if (baseline) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await open('characters/jojo');
    await tab('声音');
    await wait(500);
    await shot('before-voice-1440');
    const row = await runPreview('基线：早上好');
    check((await row.locator('.pw-listen:visible').count()) === 0, 'baseline: the speech path must be off');
    await shot('before-preview-1440');
  } else
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });

      // ============================== 声音: 生成 ==============================
      await open('characters/jojo');
      await tab('声音');
      const reference = page.locator('label:has-text("已有 Fish 音色 referenceId") input').first();
      await reference.fill('fake-reference-24k1');
      await page.locator('button:has-text("准备新素材版本")').first().click();
      // The newest 素材版本 is not always listed first: a slot is found by still offering 生成 (a filled slot has none).
      const slotOf = (n: string) =>
        page.locator(`section:has(> h4:text-is("${n}")):has([data-pw-send^="generate-"])`).first();
      await slotOf('欢迎成品').waitFor({ timeout: 15_000 });
      for (const name of ['欢迎成品', '结束成品'] as const) {
        const slot = slotOf(name);
        const gen = slot.locator('[data-pw-send^="generate-"]');
        const upload = slot.locator(`button:has-text("上传所选${name}")`);
        check((await upload.count()) === 1, `声音 ${at} ${name}: the upload is gone`);
        await page.waitForFunction(
          (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? ''),
          await gen.elementHandle(),
          { timeout: 15_000 },
        );
        check(!(await gen.isDisabled()), `声音 ${at} ${name}: 生成 is off (${await gen.innerText()})`);
        check(/约 .*[$µ]/.test(await gen.innerText()), `声音 ${at} ${name}: the cost is not on the button`);
        const before = calls(/material-generate/);
        const loadedBefore = await page.locator(`button:has-text("加载${name}试听")`).count();
        const genBefore = await page.locator('[data-pw-send^="generate-"]').count();
        await gen.click();
        check((await gen.getAttribute('data-state')) === 'confirm', `声音 ${at} ${name}: the first click did not ask`);
        check(/确认付费/.test(await gen.innerText()), `声音 ${at} ${name}: the armed button does not say 确认付费`);
        check(calls(/material-generate/) === before, `声音 ${at} ${name}: the first click called the API`);
        if (name === '欢迎成品') await shot(`generate-confirm-${at}`);
        await gen.click();
        // The page re-reads after generating, so the slot is found again by what changed: one more loaded clip, one fewer 生成.
        await page
          .waitForFunction(
            ({ n, k }: { n: string; k: number }) =>
              [...document.querySelectorAll('button')].filter((b) => b.textContent === `加载${n}试听`).length > k,
            { n: name, k: loadedBefore },
            { timeout: 20_000 },
          )
          .catch(() => check(false, `声音 ${at} ${name}: no clip appeared in the slot`));
        check(calls(/material-generate/) === before + 1, `声音 ${at} ${name}: not exactly one generate call`);
        check(
          (await page.locator('.vc-origin').count()) >= 1 &&
            (await page.locator('.vc-origin').first().innerText()) === '生成',
          `声音 ${at} ${name}: the clip is not marked 生成`,
        );
        check(
          (await page.locator('[data-pw-send^="generate-"]').count()) === genBefore - 1,
          `声音 ${at} ${name}: 生成 stays on a filled slot`,
        );
        await sideways(`声音 ${at} ${name}`);
      }
      for (const name of ['欢迎成品', '结束成品'])
        await page.locator(`button:has-text("加载${name}试听")`).first().click();
      await page
        .waitForFunction(() => document.querySelectorAll('audio[src^="blob:"]').length >= 2, null, { timeout: 10_000 })
        .catch(() => check(false, `声音 ${at}: both clips are not loaded for listening`));
      const approve = page.locator('button:has-text("批准此素材版本")').first();
      check(await approve.isDisabled(), `声音 ${at}: 批准 is on before the human ticked anything`);
      check(calls(/material-approve/) === 0, `声音 ${at}: generation approved`);
      await shot(`generated-ready-${at}`);
      await inside(`声音 ${at}`, '[data-pw-send^="generate-"]', '.admin-content');
      await noLayers(`声音 ${at}`);

      // ============================== 预演: 试听 ==============================
      await open('characters/jojo');
      const line = `试听检查 ${at}`;
      const row = await runPreview(line);
      const listen = row.locator('.pw-listen');
      const button = listen.locator('[data-pw-send^="listen-"]');
      await page.waitForFunction(
        (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? ''),
        await button.elementHandle(),
        { timeout: 15_000 },
      );
      check(!(await button.isDisabled()), `预演 ${at}: 试听 is off (${await button.innerText()})`);
      const before = calls(/preview-listen/);
      await listen.scrollIntoViewIfNeeded();
      await page.evaluate(() => document.querySelector('.pw-listen')?.scrollIntoView({ block: 'center' }));
      await button.click();
      check((await button.getAttribute('data-state')) === 'confirm', `预演 ${at}: the first 试听 click did not ask`);
      check(/确认付费/.test(await button.innerText()), `预演 ${at}: the armed 试听 does not say 确认付费`);
      check(calls(/preview-listen/) === before, `预演 ${at}: the first 试听 click called the API`);
      await shot(`listen-confirm-${at}`);
      await button.click();
      const inState = (state: string) => row.locator(`.pw-listen[data-state="${state}"]`);
      await inState('speaking').or(inState('playing')).first().waitFor({ timeout: 10_000 });
      await inState('playing').waitFor({ timeout: 20_000 });
      check(calls(/preview-listen/) === before + 1, `预演 ${at}: not exactly one listen call`);
      await shot(`listen-playing-${at}`);
      const play = listen.locator('[data-pw-play]');
      await play.waitFor({ state: 'visible', timeout: 20_000 });
      check(
        (await listen.locator('[data-pw-send^="listen-"]:visible').count()) === 0,
        `预演 ${at}: the paid button stays after 试听`,
      );
      await play.click();
      await inState('playing').waitFor({ timeout: 10_000 });
      check(calls(/preview-listen/) === before + 1, `预演 ${at}: playing again called the paid API`);
      await play.waitFor({ state: 'visible', timeout: 20_000 });
      await shot(`listen-ready-${at}`);
      await inside(`预演 ${at}`, '.pw-listen', '.admin-content');
      await sideways(`预演 ${at}`);
      await noLayers(`预演 ${at}`);

      // ============================== no voice reference: off, with the reason ==============================
      await open('characters/c04');
      const quiet = await runPreview(`无音色检查 ${at}`);
      const off = quiet.locator('[data-pw-send^="listen-"]');
      check(await off.isDisabled(), `预演 ${at}: 试听 is on without a voice reference`);
      check(
        ((await quiet.locator('.pw-listen .pw-reason').innerText()) as string).trim() === '先填音色 referenceId',
        `预演 ${at}: the reason is not 「先填音色 referenceId」`,
      );
      await page.evaluate(() => document.querySelector('.pw-listen')?.scrollIntoView({ block: 'center' }));
      await shot(`listen-disabled-${at}`);
    }
} catch (error) {
  failure = error;
  if (shots)
    for (const page of f.context.pages()) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
} finally {
  await f.close();
}
if (problems.length) console.error(`24k-1 problems (${problems.length}):\n- ${problems.join('\n- ')}`);
if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
if (failure) console.error(failure);
if (problems.length || errors.length || failure) process.exitCode = 1;
else console.log('speech 24k-1 browser check: PASS');
