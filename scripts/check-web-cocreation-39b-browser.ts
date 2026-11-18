import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 39b in a REAL browser, on the synthetic site of console-fixture-24b6.ts (nothing leaves the machine).
 *
 *   PLAYER  the sheet opened from 瓜瓜 at 390 (touch) and 1440 (mouse): five themes in order, each showing ONE enabled wording of the
 *           character's pool (a plain default where the pool is empty), ↻ picks again, a written theme records the question it
 *           answered; then the relationship card: the dice makes 瓜瓜 + one OTHER character, the ratings are 瓜瓜 对 X and X 对 瓜瓜, 🎲
 *           and ＋ add members, 瓜瓜 can never be removed. The pair flow (choose, rate, reason, story, send) and the group flow (story,
 *           send) are clicked through completely at 390 and 1440, and EVERY step asserts its layout: no vertical text, the stars and
 *           every control inside the card, the card as wide as the board, the fonts of the page, no sideways scroll, 上一步 / 下一步
 *           answering mouse, touch and keyboard (Enter and Space). The layout of the rating and group screens is also asserted at 768 and 1280.
 *   ADMIN   共创收件箱 → 「题目」 at 1440: the pool in console order, an added wording, 生成 (estimate, the second click pays, drafts land
 *           switched OFF), the inbox shows the theme AND the exact wording of the player's note.
 *   MOTION  under reduced motion no step animates.
 *
 * usage: node scripts/check-web-cocreation-39b-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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

type LayoutReport = { issues: string[]; card: { width: number; left: number; right: number } | null };
/** The layout of the relationship screen as it is right now, measured in the page. */
async function layout(page: Page, at: string, vw: number): Promise<void> {
  const report: LayoutReport = await page.evaluate((viewport: number) => {
    const issues: string[] = [];
    const screen = document.querySelector('.cc-rel') as HTMLElement | null;
    if (!screen) return { issues: ['the relationship screen is not on the page'], card: null };
    const sheetFont = getComputedStyle(document.querySelector('.cc-sheet')!).fontFamily;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const cards = [...screen.querySelectorAll('.cc-rel-card')].filter(visible) as HTMLElement[];
    // 1. no vertical text, no collapsed text: every element that carries three or more characters is horizontal and wider than a letter or two.
    for (const el of screen.querySelectorAll('*')) {
      if (!visible(el)) continue;
      const own = [...el.childNodes]
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent ?? '')
        .join('')
        .trim();
      if ([...own].length < 3) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (style.writingMode !== 'horizontal-tb') issues.push(`vertical writing mode on ${el.className || el.tagName}`);
      if (rect.width < parseFloat(style.fontSize) * 2.4)
        issues.push(`${el.className || el.tagName} collapsed to ${Math.round(rect.width)}px (text runs down)`);
    }
    // 2. the stars, the zero and every control sit INSIDE their card.
    for (const el of screen.querySelectorAll(
      '.cc-star, .cc-zero, .cc-rel-area, .cc-rel-chip, .cc-rel-again, .cc-rel-plus',
    )) {
      if (!visible(el)) continue;
      const host = (el.closest('.cc-rel-card') as HTMLElement | null)?.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (!host) issues.push(`${el.className} is outside every card`);
      else if (r.left < host.left - 1 || r.right > host.right + 1 || r.top < host.top - 1 || r.bottom > host.bottom + 1)
        issues.push(`${el.className} leaves its card`);
    }
    // 3. the card is as wide as the board: a full column on a phone, a real column on a wide screen.
    const main = cards.at(-1);
    const width = main ? main.getBoundingClientRect().width : 0;
    const wanted = viewport < 900 ? Math.min(viewport, 560) - 36 - 2 : 380;
    if (!main) issues.push('no card on the screen');
    else if (width < wanted) issues.push(`the card is ${Math.round(width)}px wide, expected at least ${wanted}`);
    // 4. the fonts of the page: every control and box of the screen uses the sheet's own family, never the browser's default.
    for (const el of screen.querySelectorAll('button, textarea, .cc-rel-prompt, .cc-rel-chip, .cc-rate-who'))
      if (visible(el) && getComputedStyle(el).fontFamily !== sheetFont)
        issues.push(`${el.className || el.tagName} uses another font than the page`);
    // 5. no sideways scroll, and nothing wider than the viewport.
    if (document.documentElement.scrollWidth > viewport) issues.push('the page scrolls sideways');
    if (screen.scrollWidth > screen.clientWidth + 1) issues.push('the screen scrolls sideways');
    // 6. the footer buttons are on top where they are drawn (nothing covers them) and big enough to press.
    for (const el of screen.querySelectorAll('.cc-rel-back, .cc-rel-next')) {
      if (!visible(el)) continue;
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1));
      if (r.top < innerHeight && hit && !el.contains(hit))
        issues.push(`${el.className} is covered by ${hit.className || hit.tagName}`);
      if (r.height < 44) issues.push(`${el.className} is only ${Math.round(r.height)}px tall`);
    }
    const r = main?.getBoundingClientRect();
    return { issues, card: r ? { width: r.width, left: r.left, right: r.right } : null };
  }, vw);
  for (const issue of report.issues) problems.push(`${at}: ${issue}`);
}

try {
  // ---- the pool: wei-guagua has wordings (one switched off), jojo has none ----
  let seeded = 0;
  const add = (characterId: string, themeId: string, text: string, enabled: boolean) =>
    f.post('cocreation/wordings/add', { characterId, themeId, text, enabled, requestId: `seed-${++seeded}` });
  await add('wei-guagua', 'theme-know', '{name}给你的第一印象是什么？', true);
  await add('wei-guagua', 'theme-know', '用三个词形容{name}', true);
  await add('wei-guagua', 'theme-know', '这一条是关着的{name}', false);
  await add('wei-guagua', 'theme-habit', '{name}睡前一定会做什么？', true);
  const enabledKnow = ['瓜瓜给你的第一印象是什么？', '用三个词形容瓜瓜'];

  for (const [width, height, tag] of [
    [390, 844, 'm'],
    [1440, 900, 'd'],
  ] as const) {
    const touch = width < 600;
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      deviceScaleFactor: 2,
      hasTouch: touch,
      isMobile: touch,
    });
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(`${tag}: pageerror ${String(e)}`));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
        errors.push(`${tag}: console ${m.text()}`);
    });
    // The home card is chosen by the first random number; the dice and ↻ read the one the script sets.
    await page.addInitScript(() => {
      (window as unknown as { __rnd: number }).__rnd = 0;
      Math.random = () => (window as unknown as { __rnd: number }).__rnd;
    });
    watchRequests(page);
    const wait = (ms = 500) => quietWait(page, ms);
    const shot = async (name: string) => {
      if (!shots) return;
      await wait(450);
      await page.screenshot({ path: join(shots, `cocreation-39b-${name}-${width}.png`) });
    };
    /** Presses a control the way a person at this width would: a tap on a phone, a click with the mouse. */
    const press = async (selector: string) => {
      const target = page.locator(selector).first();
      await target.waitFor({ state: 'visible', timeout: 5000 });
      if (touch) await target.tap();
      else await target.click();
    };
    const setRandom = (n: number) =>
      page.evaluate((v: number) => ((window as unknown as { __rnd: number }).__rnd = v), n);

    await page.goto(`${f.origin}/?mode=provider`);
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await wait(900);
    await card.locator('.chat-head [aria-haspopup]').first().click();
    await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
    await page.locator('.cc-sheet').waitFor();
    await wait(800);

    // ---- the deck: five themes in order, one question each ----
    const titles = await page
      .locator('.cc-deck .cc-card[data-card^="theme-"]')
      .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-card')));
    check(
      JSON.stringify(titles) ===
        JSON.stringify(['theme-know', 'theme-experience', 'theme-habit', 'theme-catchphrase', 'theme-recent']),
      `${tag}: five themes in order (${titles})`,
    );
    check((await page.locator('.cc-deck .cc-card').count()) === 6, `${tag}: five themes and the relationship card`);
    const prompt = (id: string) => page.locator(`[data-card="${id}"] .cc-prompt`).innerText();
    const know = await prompt('theme-know');
    check(enabledKnow.includes(know), `${tag}: the first theme shows an ENABLED wording, got “${know}”`);
    check(
      !(await page.locator('.cc-deck').innerText()).includes('这一条是关着的'),
      `${tag}: a switched-off wording is never shown`,
    );
    check((await prompt('theme-habit')) === '瓜瓜睡前一定会做什么？', `${tag}: a pool of one shows that wording`);
    check((await prompt('theme-experience')) === '瓜瓜经历过哪些事？', `${tag}: an empty pool shows the plain default`);
    check((await prompt('theme-catchphrase')) === '瓜瓜常挂在嘴边的话', `${tag}: plain default 口头禅`);
    check((await prompt('theme-recent')) === '瓜瓜最近在忙什么？', `${tag}: plain default 近况`);
    for (const old of ['生气时', '怎么安慰人', '被夸时', '小秘密', '怪癖', '随便写点什么'])
      check(!(await page.locator('.cc-sheet').innerText()).includes(old), `${tag}: the old card “${old}” is gone`);
    await shot('1-deck');
    // ↻ shows the other wording of a pool
    await setRandom(0.99);
    await press('.cc-shuffle');
    await wait(500);
    const swapped = await prompt('theme-know');
    check(
      enabledKnow.includes(swapped) && swapped !== know,
      `${tag}: ↻ picked another wording (“${know}” → “${swapped}”)`,
    );
    // a written theme keeps the question it answers, and travels with it
    await press('[data-card="theme-know"] .cc-face');
    await page.locator('[data-card="theme-know"] textarea').fill('很会逗人，嘴硬心软');
    await page.locator('[data-card="theme-know"] .cc-done').click();
    await wait(400);
    await shot('2-theme-written');
    await setRandom(0);
    await press('.cc-shuffle');
    await wait(400);
    check((await prompt('theme-know')) === swapped, `${tag}: a written theme keeps its question over ↻`);
    if (touch) {
      // hand the theme note over (the inbox below shows its theme and the exact question), then open a new sheet
      const handed: unknown[] = [];
      page.on('request', (r: { url: () => string; method: () => string; postData: () => string | null }) => {
        if (r.url().endsWith('/cocreation/submit') && r.method() === 'POST')
          handed.push(JSON.parse(r.postData() ?? 'null'));
      });
      await press('.cc-send');
      await page.locator('.cc-thanks:not([hidden])').waitFor({ timeout: 5000 });
      await shot('2b-thanks');
      const answers = (handed[0] as { answers: { cardId: string; text: string; wording: string }[] } | undefined)
        ?.answers;
      check(
        !!answers && answers.length === 1 && answers[0]!.cardId === 'theme-know' && answers[0]!.wording === swapped,
        `${tag}: the note records the theme and the exact question shown (${JSON.stringify(answers)})`,
      );
      await page.locator('.cc-sheet').waitFor({ state: 'detached', timeout: 8000 });
      await wait(500);
      await card.locator('.chat-head [aria-haspopup]').first().click();
      await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
      await page.locator('.cc-sheet').waitFor();
      await wait(700);
    }

    // ---- the relationship card: 瓜瓜 + one OTHER character ----
    await page.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
    await setRandom(0);
    await press('.cc-rel-dice');
    await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 5000 });
    await wait(500);
    const chips = async (): Promise<Member[]> =>
      page.locator('.cc-rel-chip').evaluateAll((els: Element[]) =>
        els.map((e) => ({
          id: e.getAttribute('data-member'),
          anchor: e.getAttribute('data-anchor') === 'true',
          x: !!e.querySelector('.cc-rel-x'),
        })),
      );
    type Member = { id: string | null; anchor: boolean; x: boolean };
    let members: Member[] = await chips();
    check(members.length === 2, `${tag}: the dice makes a pair (${members.length})`);
    check(
      members.some((m) => m.id === 'wei-guagua' && m.anchor && !m.x),
      `${tag}: 瓜瓜 is a member and has no ✕`,
    );
    check(members.filter((m) => m.id !== 'wei-guagua').length === 1, `${tag}: exactly one OTHER character`);
    await layout(page, `${tag}/choose`, width);
    await shot('3-choose');
    // 🎲 adds one more (a group), ＋ lists everyone and adds the chosen one; 瓜瓜 stays
    await press('.cc-rel-again');
    await wait(300);
    members = await chips();
    check(
      members.length === 3 && members.some((m) => m.id === 'wei-guagua'),
      `${tag}: 🎲 adds a third member, 瓜瓜 stays`,
    );
    await press('.cc-rel-plus');
    await page.locator('.cc-rel-menu').waitFor({ timeout: 3000 });
    await wait(300);
    const menu = await page.locator('.cc-rel-menu').boundingBox();
    check(menu && menu.x >= 0 && menu.x + menu.width <= width + 1, `${tag}: the ＋ list stays inside the screen`);
    await shot('4-choose-menu');
    await page.evaluate(() => document.querySelector<HTMLElement>('.cc-rel-plus[aria-expanded="true"]')?.click());
    // back to a pair: remove the others until two remain (the anchor has no ✕)
    for (let guard = 0; guard < 8 && (await page.locator('.cc-rel-x').count()) > 0; guard++) {
      await page.locator('.cc-rel-x').first().click();
      await wait(250);
    }
    members = await chips();
    check(
      members.length === 2 && members.some((m) => m.id === 'wei-guagua'),
      `${tag}: removing the others never removes 瓜瓜`,
    );
    const other = members.find((m) => m.id !== 'wei-guagua')!.id!;
    const otherName = (await page.locator(`.cc-rel-chip[data-member="${other}"] .cc-rel-name`).innerText()).trim();

    // ---- THE PAIR FLOW, clicked through ----
    // choose → rate with 下一步 (mouse / tap)
    await press('.cc-rel-next');
    await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 5000 });
    await wait(500);
    const groups = await page
      .locator('.cc-rate')
      .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('aria-label')));
    check(
      JSON.stringify(groups) === JSON.stringify([`瓜瓜对${otherName}`, `${otherName}对瓜瓜`]),
      `${tag}: A 对 X and X 对 A (${groups})`,
    );
    check(await page.locator('.cc-rel-next').isDisabled(), `${tag}: 下一步 waits for both ratings`);
    await layout(page, `${tag}/rate-empty`, width);
    await shot('5-rate');
    await press('.cc-rate >> nth=0 >> [data-stars="4"]');
    await press('.cc-rate >> nth=1 >> [data-stars="2"]');
    await wait(400);
    check((await page.locator('.cc-rate >> nth=0 >> .cc-star.is-on').count()) === 4, `${tag}: four stars are lit`);
    await layout(page, `${tag}/rate-rated`, width);
    await shot('6-rate-rated');
    // 上一步 / 下一步 answer the keyboard too (Enter and Space), here and in every step
    await page.locator('.cc-rel-back').focus();
    await page.keyboard.press('Enter');
    await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 3000 });
    await page.locator('.cc-rel-next').focus();
    await page.keyboard.press('Space');
    await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 3000 });
    check(
      (await page.locator('.cc-rate >> nth=0 >> .cc-star.is-on').count()) === 4,
      `${tag}: the stars are still there after back and forth`,
    );
    await press('.cc-rel-next');
    await page.locator('.cc-rel[data-step="reason"]').waitFor({ timeout: 5000 });
    await wait(450);
    await layout(page, `${tag}/reason`, width);
    await shot('7-reason');
    check(await page.locator('.cc-rel-next').isDisabled(), `${tag}: 下一步 waits for the reason`);
    await page.locator('.cc-rel-area').fill('一个爱闹一个嫌吵，但谁也离不开谁');
    await press('.cc-rel-next');
    await page.locator('.cc-rel[data-step="story"]').waitFor({ timeout: 5000 });
    await wait(450);
    await layout(page, `${tag}/story`, width);
    check((await page.locator('.cc-rel-next').innerText()).trim() === '发送', `${tag}: the last step sends`);
    await page.locator('.cc-rel-area').fill('小学同桌三年，一起躲过同一把伞。');
    await shot('8-story');
    // 上一步 by mouse/touch goes back to the reason and keeps the text
    await press('.cc-rel-back');
    await page.locator('.cc-rel[data-step="reason"]').waitFor({ timeout: 3000 });
    check((await page.locator('.cc-rel-area').inputValue()).includes('谁也离不开谁'), `${tag}: the reason is kept`);
    await press('.cc-rel-next');
    await page.locator('.cc-rel[data-step="story"]').waitFor({ timeout: 3000 });
    const sent: unknown[] = [];
    page.on('request', (r: { url: () => string; method: () => string; postData: () => string | null }) => {
      if (r.url().endsWith('/cocreation/relation') && r.method() === 'POST')
        sent.push(JSON.parse(r.postData() ?? 'null'));
    });
    await press('.cc-rel-next');
    await page.locator('.cc-thanks:not([hidden])').waitFor({ timeout: 5000 });
    await shot('9-thanks');
    const body = sent[0] as
      | { characterIds: string[]; ratings: { from: string; to: string; stars: number }[]; reason: string }
      | undefined;
    check(
      !!body && body.characterIds.includes('wei-guagua') && body.characterIds.length === 2,
      `${tag}: the pair went out with 瓜瓜`,
    );
    check(
      !!body &&
        body.ratings.length === 2 &&
        body.ratings[0]!.from === 'wei-guagua' &&
        body.ratings[1]!.to === 'wei-guagua',
      `${tag}: ratings are 瓜瓜 对 X and X 对 瓜瓜`,
    );
    check(!!body && body.ratings[0]!.stars === 4 && body.ratings[1]!.stars === 2, `${tag}: the stars that were given`);
    await page
      .locator('.cc-sheet')
      .waitFor({ state: 'detached', timeout: 8000 })
      .catch(() => check(false, `${tag}: the sheet closes after the thanks`));

    // ---- THE GROUP FLOW (another sheet: three members, the story only) ----
    await wait(600);
    await card.locator('.chat-head [aria-haspopup]').first().click();
    await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
    await page.locator('.cc-sheet').waitFor();
    await wait(600);
    await page.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
    await setRandom(0);
    await press('.cc-rel-dice');
    await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 5000 });
    await press('.cc-rel-again');
    await wait(450);
    check((await page.locator('.cc-rel-chip').count()) === 3, `${tag}: a group of three`);
    // with three members the screen IS the group flow: the people and the story on one screen
    await page.locator('.cc-rel[data-mode="group"]').waitFor({ timeout: 3000 });
    await layout(page, `${tag}/group-choose`, width);
    await shot('10-group-choose');
    const mode = await page.locator('.cc-rel').getAttribute('data-mode');
    check(mode === 'group', `${tag}: three members are the group flow (${mode})`);
    check((await page.locator('.cc-star').count()) === 0, `${tag}: a group has no stars`);
    await layout(page, `${tag}/group`, width);
    await shot('11-group');
    // a group is ONE screen: the story and 发送 (no 上一步); 发送 answers the keyboard
    check(!(await page.locator('.cc-rel-back').isVisible()), `${tag}: a group has no 上一步`);
    check(await page.locator('.cc-rel-next').isDisabled(), `${tag}: 发送 waits for the story`);
    await page.locator('.cc-rel-area').fill('三个人一起在天台吃过泡面。');
    const groupSent: unknown[] = [];
    page.on('request', (r: { url: () => string; method: () => string; postData: () => string | null }) => {
      if (r.url().endsWith('/cocreation/relation') && r.method() === 'POST')
        groupSent.push(JSON.parse(r.postData() ?? 'null'));
    });
    await page.locator('.cc-rel-next').focus();
    await page.keyboard.press('Enter');
    await page.locator('.cc-thanks:not([hidden])').waitFor({ timeout: 5000 });
    const g = groupSent[0] as { characterIds: string[]; ratings: unknown; reason: unknown } | undefined;
    check(
      !!g &&
        g.characterIds.length === 3 &&
        g.characterIds.includes('wei-guagua') &&
        g.ratings === null &&
        g.reason === null,
      `${tag}: the group went out with 瓜瓜, no ratings, no reason`,
    );
    await shot('12-group-thanks');

    // ---- the rating and group layout at the other widths (768 and 1280 are asserted once, from the desktop context) ----
    if (!touch) {
      for (const [w, h] of [
        [768, 1000],
        [1280, 800],
      ] as const) {
        await wait(600);
        await page.setViewportSize({ width: w, height: h });
        // a fresh sheet: reopen it (the last one closed itself) and go to the rating step
        await wait(2200);
        if ((await page.locator('.cc-sheet').count()) === 0) {
          await card.locator('.chat-head [aria-haspopup]').first().click();
          await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
          await page.locator('.cc-sheet').waitFor();
        }
        await page.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
        await press('.cc-rel-dice');
        await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 5000 });
        await wait(400);
        await layout(page, `${w}/choose`, w);
        await press('.cc-rel-next');
        await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 3000 });
        await wait(450);
        await layout(page, `${w}/rate`, w);
        await shot2(page, shots, `13-rate`, w);
        await press('.cc-rate >> nth=0 >> [data-stars="5"]');
        await press('.cc-rate >> nth=1 >> [data-stars="3"]');
        await press('.cc-rel-next');
        await page.locator('.cc-rel[data-step="reason"]').waitFor({ timeout: 3000 });
        await wait(400);
        await layout(page, `${w}/reason`, w);
        await press('.cc-rel-back');
        await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 3000 });
        await press('.cc-rel-back');
        await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 3000 });
        await press('.cc-rel-again');
        await page.locator('.cc-rel[data-mode="group"]').waitFor({ timeout: 3000 });
        await wait(450);
        await layout(page, `${w}/group`, w);
        await shot2(page, shots, `14-group`, w);
        await press('.cc-close');
        await wait(300);
        await press('.cc-close');
        await wait(500);
      }
      await page.setViewportSize({ width, height });
    }

    // ---- reduced motion: nothing animates on the steps ----
    if (!touch) {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      if ((await page.locator('.cc-sheet').count()) === 0) {
        await card.locator('.chat-head [aria-haspopup]').first().click();
        await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
        await page.locator('.cc-sheet').waitFor();
      }
      await wait(500);
      await page.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
      await press('.cc-rel-dice');
      await page.locator('.cc-rel[data-step="choose"]').waitFor({ timeout: 3000 });
      await press('.cc-rel-next');
      await page.locator('.cc-rel[data-step="rate"]').waitFor({ timeout: 3000 });
      const moving: string[] = await page.evaluate(() =>
        [...document.querySelectorAll('.cc-rel, .cc-rel *, .cc-sheet')]
          .filter((el) => {
            const s = getComputedStyle(el);
            // the skin's blanket rule cuts every duration to 0.01 ms under reduced motion
            return (
              Math.max(
                ...s.animationDuration.split(',').map(parseFloat),
                ...s.transitionDuration.split(',').map(parseFloat),
              ) > 0.001
            );
          })
          .map((el) => `${el.className || el.tagName}`),
      );
      check(
        moving.length === 0,
        `${tag}: under reduced motion ${moving.length} elements still animate or transition (${[...new Set(moving)].slice(0, 8).join(', ')})`,
      );
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    }
    await ctx.close();
  }

  // ---- ADMIN: 共创收件箱 → 「题目」 ----
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
  // the note the player just handed over shows its theme AND the question
  const noteRow = admin.locator('.cc-row-open', { hasText: '很会逗人' }).first();
  await noteRow.waitFor({ timeout: 10_000 });
  // the list may still be settling: open the note again if its detail has not appeared
  for (let attempt = 0; attempt < 3 && !(await admin.locator('.cc-card-prompt').count()); attempt++) {
    await noteRow.click();
    await admin
      .locator('.cc-card-prompt')
      .first()
      .waitFor({ timeout: 4000 })
      .catch(() => undefined);
  }
  await quietWait(admin, 600);
  const prompts: string[] = await admin.locator('.cc-card-prompt').allInnerTexts();
  check(
    prompts.some((t) => /^认识这个人 · (瓜瓜给你的第一印象是什么？|用三个词形容瓜瓜)$/.test(t.trim())),
    `admin: the inbox shows the theme AND the exact wording (${prompts})`,
  );
  if (shots) await admin.screenshot({ path: join(shots, 'cocreation-39b-admin-inbox-1440.png'), fullPage: true });
  await admin.locator('#admin-cocreation [data-seg="wordings"]').click();
  await admin.locator('.cw-character').first().waitFor({ timeout: 8000 });
  await quietWait(admin, 900);
  const order: string[] = await admin
    .locator('.cw-character')
    .evaluateAll((els: Element[]) => els.map((e) => e.getAttribute('data-character') ?? ''));
  const homeOrder: string[] = (await (await f.post('characters/home-order', {})).json()).order;
  check(
    JSON.stringify(order) === JSON.stringify(homeOrder.filter((id) => order.includes(id))),
    `admin: characters in the console order (${order})`,
  );
  const guagua = admin.locator('.cw-character[data-character="wei-guagua"]');
  await guagua
    .locator('summary')
    .click()
    .catch(() => undefined);
  if (!(await guagua.getAttribute('open'))) await guagua.locator('summary').click();
  await quietWait(admin, 500);
  check(
    (await guagua.locator('[data-theme="theme-know"] .cw-row').count()) === 3,
    'admin: the three wordings of the first theme',
  );
  check(
    (await guagua.locator('[data-theme="theme-know"] [data-enabled="false"]').count()) === 1,
    'admin: one is switched off',
  );
  if (shots) await admin.screenshot({ path: join(shots, 'cocreation-39b-admin-wordings-1440.png'), fullPage: true });
  // add, edit, switch, delete
  const theme = guagua.locator('[data-theme="theme-catchphrase"]');
  await theme.locator('.cw-new').fill('{name}总爱说的那句');
  await theme.locator('.cw-add').click();
  await theme.locator('.cw-row').first().waitFor({ timeout: 4000 });
  const row = theme.locator('.cw-row').first();
  await row.locator('.cw-text').fill('{name}最爱说的那一句');
  await row.locator('.cw-text').press('Enter');
  await quietWait(admin, 500);
  check((await row.locator('.cw-text').inputValue()) === '{name}最爱说的那一句', 'admin: edited');
  await row.locator('.cw-switch').click();
  await quietWait(admin, 400);
  check((await row.getAttribute('data-enabled')) === 'false', 'admin: switched off');
  await row.locator('.cw-del').click();
  await quietWait(admin, 400);
  check((await theme.locator('.cw-row').count()) === 0, 'admin: deleted');
  // 生成: the estimate is on the button, the second click pays, the drafts land switched off
  const gen = admin.locator('[data-pw-send="wordings-wei-guagua"]');
  await gen.waitFor({ timeout: 8000 });
  await quietWait(admin, 700);
  check(
    /生成 · 1 次付费调用 · 约 \$/.test(await gen.innerText()),
    `admin: the estimate is on the button (${await gen.innerText()})`,
  );
  await gen.click();
  check(/确认付费/.test(await gen.innerText()), 'admin: the first click asks');
  check(
    (await guagua.locator('[data-source="generated"]').count()) === 0,
    'admin: nothing is generated before the second click',
  );
  await gen.click();
  await guagua.locator('[data-source="generated"]').first().waitFor({ timeout: 10_000 });
  await quietWait(admin, 600);
  const generated = await guagua.locator('[data-source="generated"]').count();
  check(generated === 40, `admin: 8 drafts for each of the five themes (${generated})`);
  check(
    (await guagua.locator('[data-source="generated"][data-enabled="true"]').count()) === 0,
    'admin: the drafts land switched OFF',
  );
  if (shots) await admin.screenshot({ path: join(shots, 'cocreation-39b-admin-generated-1440.png'), fullPage: true });
  // nothing reaches players until switched on
  const asPlayer = async (characterId: string) => {
    const c = await f.browser.newContext({ ignoreHTTPSErrors: true });
    const p: Page = await c.newPage();
    await p.goto(`${f.origin}/?mode=provider`);
    await p.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    const result = await p.evaluate(async (id: string) => {
      const boot = await (await fetch('/api/web/provider/bootstrap', { credentials: 'include' })).json();
      const r = await fetch('/api/web/provider/cocreation/wordings', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json', 'x-csrf-token': boot.csrf },
        body: JSON.stringify({ characterId: id }),
      });
      return r.json();
    }, characterId);
    await c.close();
    return result as { themes: Record<string, string[]> };
  };
  const live = await asPlayer('wei-guagua');
  check(
    live.themes['theme-experience']!.length === 0 && live.themes['theme-recent']!.length === 0,
    'admin: generated drafts are not visible to players until switched on',
  );
  await guagua.locator('[data-theme="theme-experience"] .cw-switch').first().click();
  await quietWait(admin, 500);
  const after = await asPlayer('wei-guagua');
  check(after.themes['theme-experience']!.length === 1, 'admin: a wording switched on reaches players');
  await admin.close();

  if (errors.length) for (const e of errors.slice(0, 8)) problems.push(e);
} catch (error) {
  problems.push(`script error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await f.close?.();
}
if (problems.length) {
  console.error(`cocreation-39b browser check FAILED (${problems.length}):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('cocreation-39b browser check passed');
process.exit(0);

async function shot2(page: Page, dir: string | null, name: string, width: number) {
  if (!dir) return;
  await quietWait(page, 450);
  await page.screenshot({ path: join(dir, `cocreation-39b-${name}-${width}.png`) });
}
