import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 47 in a REAL browser, on the synthetic site of console-fixture-24b6.ts (nothing leaves the machine).
 *
 *   PLAYER  Android (412×915 @3.5, real touch taps), iOS WebKit (when this machine has it) and desktop 1440 (mouse), each in day and night:
 *           the deck order (five themes, 「一天」, the relation card last); the 一天 card (six parts, needs one, hands over one text answer
 *           per written part, none with a wording); the relation card shown directly (no separate dice card, no chip row, no explanation line,
 *           no 🎲 at the start of any text); the partner picked by tapping the name and by 🎲; ＋ adds to the sentence, ✕ removes; two people →
 *           ratings, three → the group story.
 *   ADMIN   共创收件箱 shows the 一天 answer with its parts labelled; one part is adopted into 一天的安排 of the 草稿 (the 正式版本 is
 *           untouched); 说话档案 shows and edits 一天的安排 (a part over its cap cannot be saved).
 *
 * usage: node scripts/check-web-cocreation-47-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const f = await startConsoleFixture({});
const pw = loadPlaywright();
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const DAY_TEXT = { morning: '一睁眼先去喂猫，再慢慢煮咖啡', whole: '休息日就窝在阳台晒太阳' };

type Run = { name: string; browser: unknown; device: Record<string, unknown>; touch: boolean };
let webkit: { close: () => Promise<void> } | null = null;
try {
  webkit = await pw.webkit.launch();
} catch (error) {
  console.log(`webkit unavailable on this machine, iOS is not run here: ${String(error).split('\n')[0]}`);
}
const runs: Run[] = [
  {
    name: 'android',
    browser: f.browser,
    touch: true,
    device: {
      viewport: { width: 412, height: 915 },
      deviceScaleFactor: 3.5,
      isMobile: true,
      hasTouch: true,
      userAgent: ANDROID_UA,
    },
  },
  ...(webkit ? [{ name: 'ios', browser: webkit, touch: true, device: pw.devices['iPhone 15'] } as Run] : []),
  {
    name: 'desktop',
    browser: f.browser,
    touch: false,
    device: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  },
];

try {
  let handedBy = '';
  for (const run of runs) {
    for (const scheme of ['light', 'dark'] as const) {
      const tag = `${run.name}/${scheme}`;
      // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
      const ctx = await (run.browser as any).newContext({
        ...run.device,
        ignoreHTTPSErrors: true,
        colorScheme: scheme,
      });
      const page: Page = await ctx.newPage();
      page.on('pageerror', (e: unknown) => errors.push(`${tag}: pageerror ${String(e)}`));
      page.on('console', (m: { type: () => string; text: () => string }) => {
        if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
          errors.push(`${tag}: console ${m.text()}`);
      });
      // The partner of the card comes from the random number the script sets.
      await page.addInitScript(() => {
        (window as unknown as { __rnd: number }).__rnd = 0;
        Math.random = () => (window as unknown as { __rnd: number }).__rnd;
      });
      watchRequests(page);
      const wait = (ms = 500) => quietWait(page, ms);
      const shot = async (name: string) => {
        if (!shots) return;
        await wait(450);
        await page.screenshot({ path: join(shots, `cocreation-47-${run.name}-${scheme}-${name}.png`) });
      };
      /** A tap on a phone, a click with the mouse. */
      const press = async (selector: string) => {
        const target = page.locator(selector).first();
        await target.scrollIntoViewIfNeeded();
        await target.waitFor({ state: 'visible', timeout: 5000 });
        if (run.touch) await target.tap();
        else await target.click();
      };
      const setRandom = (n: number) =>
        page.evaluate((v: number) => ((window as unknown as { __rnd: number }).__rnd = v), n);
      const openSheet = async () => {
        const card = page.locator('.card-slot.is-active');
        await card.waitFor({ timeout: 20_000 });
        if ((await page.locator('.page-shell[data-phase="chat"]').count()) === 0) {
          await card.click({ force: true });
          await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
          await wait(900);
        }
        await card.locator('.chat-head [aria-haspopup]').first().click();
        await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
        await page.locator('.cc-sheet').waitFor();
        await wait(800);
      };
      const sentence = async () =>
        (await page.locator('.cc-rel-sentence').innerText()).replace(/\s+/g, '').replace(/[▾✕]/g, '');

      await page.goto(`${f.origin}/?mode=provider`);
      if (scheme === 'dark')
        check(
          (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' ||
            (await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)),
          `${tag}: night mode is on`,
        );
      await openSheet();

      // ---- the deck order ----
      const order: string[] = await page
        .locator('.cc-deck .cc-card')
        .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-card') ?? ''));
      check(
        JSON.stringify(order) ===
          JSON.stringify([
            'theme-know',
            'theme-experience',
            'theme-habit',
            'theme-catchphrase',
            'theme-recent',
            'day',
            'relation',
          ]),
        `${tag}: five themes, 一天, then the relation card last (${order})`,
      );
      check(
        (await page.locator('.cc-rel-dice').count()) === 1 &&
          !(await page.locator('.cc-rel-entry button', { hasText: '掷' }).count()),
        `${tag}: no separate dice card to tap first`,
      );
      check(
        (await page.locator('[data-card="day"] .cc-prompt').innerText()).trim() === '瓜瓜的一天都会干什么？',
        `${tag}: the 一天 title`,
      );
      await shot('1-deck');

      // ---- the 一天 card ----
      await press('[data-card="day"] .cc-face');
      await page.locator('[data-card="day"] .cc-day-editor:not([hidden])').waitFor({ timeout: 4000 });
      await wait(450);
      const labels: string[] = (await page.locator('[data-card="day"] .cc-day-label').allInnerTexts()).map(
        (t: string) => t.replace(/[✓\s]/g, ''),
      );
      check(
        JSON.stringify(labels) === JSON.stringify(['早上', '中午', '下午', '晚上', '深夜', '一整天的故事']),
        `${tag}: six parts (${labels})`,
      );
      check(await page.locator('.cc-send').isDisabled(), `${tag}: one part is needed to hand it in`);
      const pageWidth = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(pageWidth <= 1, `${tag}: no sideways scroll on the 一天 card (${pageWidth})`);
      await shot('2-day-open');
      if (!handedBy) {
        handedBy = tag;
        await page.locator('[data-card="day"] textarea[data-part="whole"]').fill(DAY_TEXT.whole);
        await page.locator('[data-card="day"] textarea[data-part="morning"]').fill(DAY_TEXT.morning);
        await wait(300);
        check(!(await page.locator('.cc-send').isDisabled()), `${tag}: one part opens the hand-over`);
        check((await page.locator('.cc-progress').innerText()).trim() === '1 / 6', `${tag}: the card counts once`);
        await shot('3-day-written');
        const handed: unknown[] = [];
        page.on('request', (r: { url: () => string; method: () => string; postData: () => string | null }) => {
          if (r.url().endsWith('/cocreation/submit') && r.method() === 'POST')
            handed.push(JSON.parse(r.postData() ?? 'null'));
        });
        await press('.cc-send');
        await page.locator('.cc-thanks:not([hidden])').waitFor({ timeout: 5000 });
        await shot('4-thanks');
        const answers = (handed[0] as { answers: { cardId: string; text: string; wording?: string }[] } | undefined)
          ?.answers;
        check(
          !!answers &&
            JSON.stringify(answers) ===
              JSON.stringify([
                { cardId: 'day-morning', text: DAY_TEXT.morning },
                { cardId: 'day-whole', text: DAY_TEXT.whole },
              ]),
          `${tag}: one text answer per written part, in the order of the day, no wording (${JSON.stringify(answers)})`,
        );
        await page.locator('.cc-sheet').waitFor({ state: 'detached', timeout: 8000 });
        await wait(500);
        await openSheet();
        check(
          (await page.locator('[data-card="day"]').getAttribute('class'))?.includes('is-used'),
          `${tag}: 一天 is spent for the day`,
        );
      } else {
        await press('[data-card="day"] .cc-skip');
      }

      // ---- the relation card, shown directly ----
      await setRandom(0);
      await page.locator('[data-card="relation"]').scrollIntoViewIfNeeded();
      await wait(500);
      check(
        await page.locator('.cc-rel-sentence').isVisible(),
        `${tag}: the sentence is on the last card, no tap needed`,
      );
      const firstSentence = await sentence();
      check(
        /^瓜瓜和.+🎲之间有什么故事？$/u.test(firstSentence),
        `${tag}: 「瓜瓜和[搭档]🎲之间有什么故事？」 (${firstSentence})`,
      );
      check(
        (await page.locator('.cc-rel-me').evaluate((e: Element) => e.tagName)) === 'SPAN',
        `${tag}: the main character is fixed text`,
      );
      check((await page.locator('.cc-rel-chip, .cc-rel-chips').count()) === 0, `${tag}: no chip row`);
      const cardText: string = await page.locator('[data-card="relation"]').innerText();
      check(
        !cardText.includes('随机再加一位') && !cardText.includes('可以打分') && !cardText.includes('自己挑'),
        `${tag}: no explanation line`,
      );
      check(!/^🎲/u.test(cardText.trim()), `${tag}: no 🎲 at the start of any text`);
      const fits = await page.evaluate(() => {
        const card = document.querySelector('[data-card="relation"]')!.getBoundingClientRect();
        return [...document.querySelectorAll('[data-card="relation"] button')].every((b) => {
          const r = b.getBoundingClientRect();
          return r.left >= card.left - 1 && r.right <= card.right + 1;
        });
      });
      check(fits, `${tag}: every control stays inside the card`);
      await shot('5-relation');

      // pick the partner by tapping the name
      await press('.cc-rel-slot');
      await page.locator('.cc-rel-list:not([hidden]) .cc-rel-option').first().waitFor({ timeout: 3000 });
      await wait(400);
      const options: string[] = await page
        .locator('.cc-rel-list .cc-rel-option')
        .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-option') ?? ''));
      check(
        options.length >= 2 && !options.includes('wei-guagua'),
        `${tag}: the list holds other characters only (${options.length})`,
      );
      await shot('6-pick');
      const choice = options.find((id) => firstSentence.length > 0 && !firstSentence.includes(id)) ?? options[1]!;
      const choiceName = (await page.locator(`.cc-rel-option[data-option="${choice}"]`).innerText())
        .replace('✓', '')
        .trim();
      await press(`.cc-rel-option[data-option="${choice}"]`);
      await wait(400);
      check(
        (await sentence()) === `瓜瓜和${choiceName}🎲之间有什么故事？`,
        `${tag}: tapping the name picks the partner (${await sentence()})`,
      );
      check((await page.locator('.cc-rel-list:not([hidden])').count()) === 0, `${tag}: the list closes after a pick`);
      // 🎲 beside it picks a random other
      const before = await sentence();
      await setRandom(0.5);
      await press('.cc-rel-dice');
      await wait(400);
      const rolled = await sentence();
      check(
        rolled !== before && /^瓜瓜和.+🎲之间有什么故事？$/u.test(rolled),
        `${tag}: 🎲 picked another (${before} → ${rolled})`,
      );
      // ＋ adds to the sentence
      await press('.cc-rel-plus');
      await page.locator('.cc-rel-list:not([hidden]) .cc-rel-option:not(.is-taken)').first().waitFor({ timeout: 3000 });
      await wait(300);
      await press('.cc-rel-list .cc-rel-option:not(.is-taken):not(.is-mine) >> nth=0');
      await wait(400);
      const three = await sentence();
      check(/^瓜瓜、.+和.+之间有什么故事？$/u.test(three), `${tag}: ＋ joins the sentence (${three})`);
      check((await page.locator('.cc-rel-x').count()) === 2, `${tag}: each added person can be removed`);
      check((await page.locator('.cc-rel-dice').count()) === 0, `${tag}: a group has no 🎲`);
      await shot('7-three');
      // three people → the group story
      await press('.cc-rel-card-next');
      await page.locator('.cc-rel[data-mode="group"]').waitFor({ timeout: 5000 });
      await wait(450);
      check((await page.locator('.cc-star').count()) === 0, `${tag}: three people: the group story, no ratings`);
      await shot('8-group-story');
      await press('.cc-close');
      await page.locator('[data-card="relation"] .cc-rel-sentence').waitFor({ state: 'visible', timeout: 5000 });
      await wait(400);
      // remove back to two → ratings
      await press('.cc-rel-x');
      await wait(400);
      check((await page.locator('.cc-rel-x').count()) === 0, `${tag}: back to two people nobody can be removed`);
      check(/^瓜瓜和.+🎲之间有什么故事？$/u.test(await sentence()), `${tag}: removing leaves the pair`);
      await press('.cc-rel-card-next');
      await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 5000 });
      await wait(450);
      check((await page.locator('.cc-rate').count()) === 2, `${tag}: two people: the ratings step`);
      await shot('9-ratings');
      await ctx.close();
    }
  }
  await webkit?.close();

  // ======================= ADMIN =======================
  const json = async (path: string, body: unknown = {}) => (await f.post(path, body)).json();
  const detail = await json('characters/wei-guagua/detail');
  if (!detail.draft) {
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await json('characters/wei-guagua/save', { expectedRevision: null, profile });
  }
  const publishedBefore = (await json('characters/wei-guagua/detail')).published.version;
  const admin: Page = await f.context.newPage();
  admin.on('pageerror', (e: unknown) => errors.push(`admin pageerror ${String(e)}`));
  admin.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
      errors.push(`admin console: ${m.text()}`);
  });
  watchRequests(admin);
  await admin.setViewportSize({ width: 1440, height: 900 });
  await admin.goto(`${f.origin}/?mode=provider-admin#/cocreation`);
  await admin.reload();
  await admin.locator('.cc-row-open').first().waitFor({ timeout: 20_000 });
  await quietWait(admin, 900);
  const row = admin.locator('.cc-row-open', { hasText: '一睁眼先去喂猫' }).first();
  await row.waitFor({ timeout: 10_000 });
  for (let attempt = 0; attempt < 3 && !(await admin.locator('.cc-card-prompt').count()); attempt++) {
    await row.click();
    await admin
      .locator('.cc-card-prompt')
      .first()
      .waitFor({ timeout: 4000 })
      .catch(() => undefined);
  }
  await quietWait(admin, 600);
  const prompts: string[] = (await admin.locator('.cc-card-prompt').allInnerTexts()).map((t: string) => t.trim());
  check(prompts.includes('瓜瓜的一天都会干什么？ · 早上'), `admin: the 早上 part is labelled (${prompts})`);
  check(
    prompts.includes('瓜瓜的一天都会干什么？ · 一整天的故事'),
    `admin: the 一整天的故事 part is labelled (${prompts})`,
  );
  check(
    (await admin.locator('.cc-group h4', { hasText: '一天的安排' }).count()) === 1,
    'admin: the parts are grouped under 一天的安排',
  );
  check(
    (await admin.locator('.cc-answer[data-ordinal="0"] .cc-adopt-profile').count()) === 0,
    'admin: a 一天 part has no 加入说话档案 (it goes to 一天的安排 of the 草稿)',
  );
  if (shots) await admin.screenshot({ path: join(shots, 'cocreation-47-admin-inbox-1440.png'), fullPage: true });
  await admin.locator('.cc-answer[data-ordinal="0"] .cc-adopt-open').click();
  await admin.locator('.cc-draft-box textarea').first().waitFor({ timeout: 8000 });
  await quietWait(admin, 500);
  check(
    (await admin.locator('.cc-target-label').innerText()).includes('一天的安排 · 早上'),
    `admin: the target is 一天的安排 · 早上 (${await admin.locator('.cc-target-label').innerText()})`,
  );
  check(
    (await admin.locator('.cc-draft-box textarea').first().inputValue()).includes(DAY_TEXT.morning),
    'admin: the part is in the box',
  );
  await admin.locator('.cc-adopt-save').click();
  await admin.locator('.cc-saved').waitFor({ timeout: 10_000 });
  const afterAdopt = await json('characters/wei-guagua/detail');
  const dailyLife = afterAdopt.draft.profile.template.authorCanon?.settings?.dailyLife;
  check(
    dailyLife?.morning === DAY_TEXT.morning && Object.keys(dailyLife ?? {}).length === 1,
    `admin: only 早上 was adopted into the 草稿 (${JSON.stringify(dailyLife)})`,
  );
  check(afterAdopt.published.version === publishedBefore, 'admin: nothing was published by adopting');
  check(
    afterAdopt.published.profile.template.authorCanon?.settings?.dailyLife === undefined,
    'admin: the 正式版本 has no 一天的安排',
  );
  // the second part, then 说话档案
  await admin.locator('.cc-answer[data-ordinal="1"] .cc-adopt-open').click();
  await admin.locator('.cc-draft-box textarea').first().waitFor({ timeout: 8000 });
  await quietWait(admin, 500);
  check(
    (await admin.locator('.cc-target-label').innerText()).includes('一天的安排 · 一整天的故事'),
    'admin: the next part targets 一整天的故事',
  );
  await admin.locator('.cc-adopt-save').click();
  await admin.locator('.cc-saved').waitFor({ timeout: 10_000 });
  const both = (await json('characters/wei-guagua/detail')).draft.profile.template.authorCanon.settings.dailyLife;
  check(both.morning === DAY_TEXT.morning && both.whole === DAY_TEXT.whole, 'admin: both parts are in the 草稿');

  await admin.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
  await admin.reload();
  await admin.locator('.wb-tab', { hasText: '说话档案' }).waitFor({ timeout: 20_000 });
  await admin.locator('.wb-tab', { hasText: '说话档案' }).click();
  await admin.locator('.sp-daily').waitFor({ timeout: 10_000 });
  await quietWait(admin, 600);
  check((await admin.locator('.sp-daily textarea').count()) === 6, 'admin: 说话档案 shows the six parts of 一天的安排');
  check(
    (await admin.locator('.sp-daily textarea[data-part="morning"]').inputValue()) === DAY_TEXT.morning,
    'admin: 说话档案 shows the adopted 早上',
  );
  if (shots) await admin.screenshot({ path: join(shots, 'cocreation-47-admin-profile-1440.png'), fullPage: true });
  const noon = admin.locator('.sp-daily textarea[data-part="noon"]');
  await noon.fill('好'.repeat(301));
  await quietWait(admin, 200);
  check(await admin.locator('[data-sp="save-daily"]').isDisabled(), 'admin: over 300 characters: save is off');
  await noon.fill('午饭一定要吃热的');
  await quietWait(admin, 200);
  await admin.locator('[data-sp="save-daily"]').click();
  await admin.waitForFunction(() => !!document.querySelector('.sp-daily textarea[data-part="noon"]'), undefined, {
    timeout: 10_000,
  });
  await quietWait(admin, 800);
  const saved = (await json('characters/wei-guagua/detail')).draft.profile.template.authorCanon.settings.dailyLife;
  check(
    saved.noon === '午饭一定要吃热的' && saved.morning === DAY_TEXT.morning,
    `admin: 说话档案 saved 中午 (${JSON.stringify(saved)})`,
  );
  check(
    (await json('characters/wei-guagua/detail')).published.version === publishedBefore,
    'admin: 正式版本 is still untouched',
  );
  await admin.close();

  if (errors.length) for (const e of errors.slice(0, 8)) problems.push(e);
} catch (error) {
  problems.push(`script error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await f.close?.();
}
if (problems.length) {
  console.error(`cocreation-47 browser check FAILED (${problems.length}):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('cocreation-47 browser check passed');
process.exit(0);
