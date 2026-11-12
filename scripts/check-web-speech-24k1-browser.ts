import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24k-1 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts, started with its offline provider AND its offline
 * Fish stand-in (a short wait, then a synthetic tone; nothing reaches a provider), at 1440x900 and 1280x800:
 *   - 声音 (Part 30: slots and takes, no 素材版本): each empty slot offers 生成 next to the upload. The first click only asks (amber, the cost on
 *     the button, the API not called); the second sends; the take lands in the slot marked 生成 with its own player; 批准 stays off until the human ticks;
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

// Part 29 D (named exception): the free tier is OFF here, as before, so the 结束成品 slot this check looks at exists.
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: !baseline, freeTier: false });
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

  // Part 29 (named exception): a second character with a saved draft for the second viewport (see 声音: 生成 below).
  {
    const second = await (await f.post('characters/chen-jimi/detail', {})).json();
    if (!second.draft) {
      const again = structuredClone(second.published.profile);
      again.template.version = second.published.version + 1;
      await f.post('characters/chen-jimi/save', { expectedRevision: null, profile: again });
    }
  }

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
      // Part 29 C (named exception): a new 素材版本 now carries over the clips of an earlier one whose text and voice are unchanged,
      // so the second viewport uses another character (a fresh one has empty slots, as this check expects).
      const voiceOf = width === 1440 ? 'jojo' : 'chen-jimi';
      await open(`characters/${voiceOf}`);
      await tab('声音');
      // Part 29 B (named exception): one Fish id field on the 声音 tab; the draft is saved with it, then the 素材版本 is prepared.
      const reference = page.locator('label:has-text("Fish 音色 ID") input').first();
      if (!(await reference.inputValue())) {
        await reference.fill('fake-reference-24k1');
        await page.locator('button:has-text("保存草稿")').first().click();
        await wait(1500);
      }
      // Part 30 (named exception): there is no 准备新素材版本 any more; the slots are on the tab at once (one per welcome line, the footer
      // while it is required) and each empty one offers 生成 next to its upload. The steps below are the same ones the Part 24k-1 check
      // made, in the take layout: the first click asks (amber, the cost on the button, the API not called); the second sends; the take
      // lands in the slot marked 生成 with its own player (no 加载 button); 批准 stays off until a slot is heard and ticked.
      const emptySlots = 'section.vc-slot[data-state="empty"]';
      const generateOne = `${emptySlots} [data-pw-send^="generate-"]:not([data-pw-send="generate-all"])`;
      await page.locator(emptySlots).first().waitFor({ timeout: 15_000 });
      const total = await page.locator('section.vc-slot').count();
      check(total >= 1, `声音 ${at}: no slots`);
      for (let n = 1; n <= total; n++) {
        const gen = page.locator(generateOne).first();
        const name = `位置 ${n}`;
        check(
          (await page.locator('button:has-text("上传")').count()) >= 1 || (await page.locator('.vc-pick').count()) >= 1,
          `声音 ${at} ${name}: the upload is gone`,
        );
        await page.waitForFunction(
          (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? ''),
          await gen.elementHandle(),
          { timeout: 15_000 },
        );
        check(!(await gen.isDisabled()), `声音 ${at} ${name}: 生成 is off (${await gen.innerText()})`);
        check(/约 .*[$µ]/.test(await gen.innerText()), `声音 ${at} ${name}: the cost is not on the button`);
        const before = calls(/take-generate$/);
        const takesBefore = await page.locator('.vc-take').count();
        await gen.click();
        check((await gen.getAttribute('data-state')) === 'confirm', `声音 ${at} ${name}: the first click did not ask`);
        check(/确认付费/.test(await gen.innerText()), `声音 ${at} ${name}: the armed button does not say 确认付费`);
        check(calls(/take-generate$/) === before, `声音 ${at} ${name}: the first click called the API`);
        if (n === 1) await shot(`generate-confirm-${at}`);
        await gen.click();
        await page
          .waitForFunction((k: number) => document.querySelectorAll('.vc-take').length > k, takesBefore, {
            timeout: 20_000,
          })
          .catch(() => check(false, `声音 ${at} ${name}: no take appeared in the slot`));
        check(calls(/take-generate$/) === before + 1, `声音 ${at} ${name}: not exactly one generate call`);
        await wait(800);
        check(
          (await page.locator('.vc-take .vc-meta:has-text("生成")').count()) >= 1,
          `声音 ${at} ${name}: the take is not marked 生成`,
        );
        await sideways(`声音 ${at} ${name}`);
      }
      check(
        (await page.locator(generateOne).count()) === 0,
        `声音 ${at}: an empty slot is left after every slot was generated`,
      );
      await page
        .waitForFunction((k: number) => document.querySelectorAll('audio.vc-player[src^="blob:"]').length >= k, total, {
          timeout: 10_000,
        })
        .catch(() => check(false, `声音 ${at}: the players are not ready for listening`));
      const approve = page.locator('.vc-approval button:text-is("批准")').first();
      check(await approve.isDisabled(), `声音 ${at}: 批准 is on before the human ticked anything`);
      check(calls(/take-approve/) === 0 && calls(/material-approve/) === 0, `声音 ${at}: generation approved`);
      await shot(`generated-ready-${at}`);
      await inside(`声音 ${at}`, '.vc-take', '.admin-content');
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
