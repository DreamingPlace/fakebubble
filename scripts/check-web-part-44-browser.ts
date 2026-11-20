import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';
import { TEST_NAMES, openNamedHome, nameEnvironments, type NameFact } from './part-44-names.ts';

/**
 * Part 44 in REAL browsers, on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the machine).
 *
 *  FIX 1  多轮预演 result tables at 1280 and 1440 with 4, 5 and 6 columns: both tables (对话, 统计) scroll sideways INSIDE the result panel
 *         (mouse wheel and a dragged scrollbar); every column header can be reached, is whole (not clipped) and is not under the sticky
 *         column; the sticky first column stays on the left while scrolled; the page itself never scrolls sideways.
 *  FIX 2  题目: 全选 + one bulk 上线 / 下线 request (online status only; a wording that could not switch is named); the player's deck shows ONE
 *         online wording per theme, a new pick each time the cards open, never an offline one, no card for a theme with none.
 *  FIX 3  the home cards' nicknames (the owner's bad cases and the other shapes): each name is fully inside its box (no glyph clipped, no
 *         overflow), the size is within [min, max] and is the same fixed size wherever the name fits.
 *
 * usage: node scripts/check-web-part-44-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const watch = (page: Page, label: string) => {
  page.on('pageerror', (e: unknown) => errors.push(`${label}: pageerror ${String(e)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d|Failed to load resource/.test(m.text()))
      errors.push(`${label}: console ${m.text()}`);
  });
};
const f = await startConsoleFixture({ provider: { draftMs: 40, reviewMs: 40 }, speech: false });
try {
  // ======================= FIX 1: 多轮预演 columns =======================
  {
    // a browser with real (classic) scrollbars: headless Chromium hides them by default, and the owner drags a VISIBLE one
    const rb = await loadPlaywright().chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
    const rctx = await rb.newContext({ ignoreHTTPSErrors: true, storageState: await f.context.storageState() });
    const page: Page = await rctx.newPage();
    watch(page, 'rehearsal');
    const wait = (ms = 500) => quietWait(page, ms);
    const detail = await (await f.post('characters/wei-guagua/detail', {})).json();
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await f.post('characters/wei-guagua/save', { expectedRevision: detail.draft?.revision ?? null, profile });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
    await page.reload();
    await page.getByText('预演', { exact: true }).first().click();
    await page.locator('.pw-split .pw-half-rehearsal .rh-rail .rh-pick').first().waitFor({ timeout: 20_000 });
    await wait(1200);
    await page.locator('.rh-rail .rh-pick', { hasText: '日常闲聊' }).click();
    const KEYS = ['deepseek', 'deepseek-v8', 'gemini', 'gemini-v8', 'xai', 'xai-v8'];
    let widthOfColumn = 0;

    /** Everything the owner asked for, for the table that is on screen now. */
    const reach = async (tag: string, headSelector: string, firstSelector: string, columns: number) => {
      const scroller = page.locator('.rh-scroll').first();
      await scroller.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'start' }));
      await wait(200);
      await scroller.evaluate((el: HTMLElement) => (el.scrollLeft = 0));
      await wait(150);
      const facts = await scroller.evaluate((el: HTMLElement, sel: string) => {
        const heads = [...el.querySelectorAll<HTMLElement>(sel)];
        return {
          scrollable: el.scrollWidth > el.clientWidth + 1,
          heads: heads.length,
          widths: heads.map((h) => Math.round(h.getBoundingClientRect().width)),
          pageScroll: document.documentElement.scrollWidth > innerWidth + 1,
        };
      }, headSelector);
      check(facts.heads === columns, `${tag}: ${columns} column headers (${facts.heads})`);
      check(!facts.pageScroll, `${tag}: the page itself scrolls sideways`);
      check(facts.scrollable, `${tag}: the result panel scrolls sideways`);
      check(new Set(facts.widths).size === 1, `${tag}: every column has the same fixed width (${facts.widths})`);
      widthOfColumn = facts.widths[0] ?? widthOfColumn;
      const box = await scroller.boundingBox();
      // the horizontal scrollbar is visible with the top of the table on screen: inside the viewport AND inside the panel's own frame
      const hbar = page.locator('.rh-hbar').first();
      const barBox = await hbar.boundingBox();
      const vh = (page.viewportSize() as { height: number }).height;
      const frame = await page.locator('.pw-half-rehearsal').boundingBox();
      const thickness: number = await hbar.evaluate((el: HTMLElement) => el.offsetHeight - el.clientHeight);
      check(thickness >= 6, `${tag}: a visible scrollbar (${thickness}px)`);
      check(
        barBox.y >= 0 &&
          barBox.y + barBox.height <= vh &&
          barBox.y >= frame.y &&
          barBox.y + barBox.height <= frame.y + frame.height + 1,
        `${tag}: the scrollbar is inside the viewport (${Math.round(barBox.y)}–${Math.round(barBox.y + barBox.height)} of ${vh})`,
      );
      check(
        Math.abs(barBox.width - box.width) <= 2,
        `${tag}: the scrollbar is as wide as the table box (${Math.round(barBox.width)} / ${Math.round(box.width)})`,
      );
      const reached = new Set<number>();
      let lastSeen = '';
      const sweep = async () => {
        const seen: { i: number; whole: boolean; text: string; why: string }[] = await scroller.evaluate(
          (el: HTMLElement, [sel, firstSel]: [string, string]) => {
            const root = el.getBoundingClientRect();
            const first = el.querySelector<HTMLElement>(firstSel)!.getBoundingClientRect();
            return [...el.querySelectorAll<HTMLElement>(sel)].map((h: HTMLElement, i: number) => {
              const r = h.getBoundingClientRect();
              const inside =
                r.left >= first.right - 1 &&
                r.right <= root.right + 0.5 &&
                r.top >= root.top &&
                r.bottom <= root.bottom;
              const readable = h.scrollWidth <= h.clientWidth + 1 && getComputedStyle(h).textOverflow !== 'ellipsis';
              const at = document.elementFromPoint((r.left + r.right) / 2, (r.top + r.bottom) / 2);
              const uncovered = !!at && (at === h || h.contains(at));
              return {
                i,
                whole: inside && readable && uncovered,
                text: h.textContent ?? '',
                why: `${inside ? '' : 'outside '}${readable ? '' : 'clipped '}${uncovered ? '' : 'covered'}`,
              };
            });
          },
          [headSelector, firstSelector] as [string, string],
        );
        for (const s of seen) if (s.whole) reached.add(s.i);
        lastSeen = seen
          .filter((x) => !x.whole)
          .map((x) => `${x.text}:${x.why}`)
          .join(',');
      };
      // by wheel / trackpad: bring each header, in turn, to just after the sticky column, with real wheel events
      await page.mouse.move(box.x + box.width / 2, box.y + 80);
      for (let i = 0; i < columns; i++) {
        const target: number = await scroller.evaluate(
          (el: HTMLElement, [sel, firstSel, n]: [string, string, number]) => {
            const heads = [...el.querySelectorAll<HTMLElement>(sel)];
            const first = el.querySelector<HTMLElement>(firstSel)!.getBoundingClientRect();
            const h = heads[n]!.getBoundingClientRect();
            return Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + h.left - first.right));
          },
          [headSelector, firstSelector, i] as [string, string, number],
        );
        const now: number = await scroller.evaluate((el: HTMLElement) => el.scrollLeft);
        // the last column is brought to the very end (a wheel past the end just stops there)
        await page.mouse.wheel(target - now + (i === columns - 1 ? 60 : 0), 0);
        await wait(350);
        await sweep();
      }
      await sweep();
      lastSeen +=
        ' ' +
        JSON.stringify(
          await scroller.evaluate((el: HTMLElement, sel: string) => {
            const hs = [...el.querySelectorAll<HTMLElement>(sel)];
            const l = hs.at(-1)!.getBoundingClientRect();
            const r = el.getBoundingClientRect();
            return {
              sl: el.scrollLeft,
              sw: el.scrollWidth,
              cw: el.clientWidth,
              rootL: r.left,
              rootR: r.right,
              lastL: l.left,
              lastR: l.right,
              first: el
                .querySelector<HTMLElement>(
                  sel === '.rh-grid .rh-head[data-model]' ? '.rh-grid .rh-corner' : '.rh-counts thead th:first-child',
                )!
                .getBoundingClientRect().right,
            };
          }, headSelector),
        );
      check(
        reached.size === columns,
        `${tag}: by wheel, every header reached whole (${reached.size}/${columns}; last view not whole: ${lastSeen})`,
      );
      // the first column is still on the left, visible and on top, at the far end
      const sticky = await scroller.evaluate((el: HTMLElement, sel: string) => {
        const root = el.getBoundingClientRect();
        const first = el.querySelector<HTMLElement>(sel)!;
        const r = first.getBoundingClientRect();
        const at = document.elementFromPoint(r.left + 6, r.top + r.height / 2);
        return {
          atLeft: Math.abs(r.left - root.left) <= 2,
          onTop: !!at && (at === first || first.contains(at)),
          scrolled: el.scrollLeft,
        };
      }, firstSelector);
      check(
        sticky.scrolled > 0 && sticky.atLeft && sticky.onTop,
        `${tag}: the sticky first column stays visible while scrolled (${JSON.stringify(sticky)})`,
      );
      // by dragging the scrollbar
      await scroller.evaluate((el: HTMLElement) => (el.scrollLeft = 0));
      await wait(150);
      const geom = await scroller.evaluate((el: HTMLElement) => ({
        cw: el.clientWidth,
        sw: el.scrollWidth,
        max: el.scrollWidth - el.clientWidth,
      }));
      const thumb = (geom.cw * geom.cw) / geom.sw;
      const y = barBox.y + barBox.height / 2;
      await page.mouse.move(barBox.x + 16 + thumb / 2, y);
      await page.mouse.down();
      await page.mouse.move(barBox.x + barBox.width - 4, y, { steps: 8 });
      await page.mouse.up();
      await wait(150);
      const dragged = await scroller.evaluate((el: HTMLElement) => el.scrollLeft);
      check(dragged > geom.max * 0.8, `${tag}: dragging the scrollbar scrolls to the end (${dragged} of ${geom.max})`);
      await scroller.evaluate((el: HTMLElement) => (el.scrollLeft = el.scrollWidth));
      await sweep();
      check(
        reached.size === columns,
        `${tag}: after the drag every header is still whole (${reached.size}/${columns})`,
      );
    };

    for (const columns of [4, 5, 6]) {
      // choose exactly the first `columns` columns
      for (const key of KEYS) {
        const toggle = page.locator(`.rh-toggle[data-model="${key}"]`);
        const want = KEYS.indexOf(key) < columns;
        if (((await toggle.getAttribute('aria-pressed')) === 'true') !== want) await toggle.click();
      }
      await wait(600);
      const send = page.locator('[data-pw-send="rehearsal"]');
      await page.waitForFunction(
        () => /次调用/.test(document.querySelector('[data-pw-send="rehearsal"]')?.textContent ?? ''),
        null,
        { timeout: 20_000 },
      );
      const runs = await page.locator('.rh-run').count();
      await send.click();
      await send.click();
      await page.waitForFunction(
        (n: number) =>
          document.querySelectorAll('.rh-run').length > n &&
          /完成/.test(document.querySelector('.rh-runhead .admin-badge')?.textContent ?? ''),
        runs,
        { timeout: 120_000 },
      );
      for (const width of [1440, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await wait(500);
        const at = `${width}×${columns}`;
        await page.locator('.seg-button', { hasText: '对话' }).click();
        await page.locator('.rh-grid').waitFor();
        await wait(400);
        await reach(`${at} 对话`, '.rh-grid .rh-head[data-model]', '.rh-grid .rh-corner', columns);
        if (shots) await page.screenshot({ path: join(shots, `rehearsal-chat-${at}.png`) });
        await page.locator('.seg-button', { hasText: '统计' }).click();
        await page.locator('.rh-counts').waitFor();
        await wait(400);
        await reach(`${at} 统计`, '.rh-counts thead th:not(:first-child)', '.rh-counts thead th:first-child', columns);
        if (shots) await page.screenshot({ path: join(shots, `rehearsal-counts-${at}.png`) });
      }
    }
    console.log(`rehearsal columns: ${widthOfColumn}px each`);
    await rb.close();
  }

  // ======================= FIX 2: 题目 =======================
  {
    let seeded = 0;
    const add = async (characterId: string, themeId: string, text: string, enabled: boolean) =>
      (await (
        await f.post('cocreation/wordings/add', { characterId, themeId, text, enabled, requestId: `p44-${++seeded}` })
      ).json()) as { id: string };
    const know = [
      await add('wei-guagua', 'theme-know', '{name}第一问', true),
      await add('wei-guagua', 'theme-know', '{name}第二问', true),
      await add('wei-guagua', 'theme-know', '{name}第三问', true),
    ];
    const off = await add('wei-guagua', 'theme-know', '{name}已下线的问', false);
    const habit = await add('wei-guagua', 'theme-habit', '{name}习惯问', true);
    await add('jojo', 'theme-recent', 'JOJO近况问', false);

    // ---- admin: 全选 and the bulk request ----
    const admin: Page = await f.context.newPage();
    watch(admin, 'admin');
    const posts: { url: string; body: string }[] = [];
    admin.on('request', (r: { method: () => string; url: () => string; postData: () => string | null }) => {
      if (r.method() === 'POST') posts.push({ url: r.url(), body: r.postData() ?? '' });
    });
    await admin.setViewportSize({ width: 1440, height: 900 });
    await admin.goto(`${f.origin}/?mode=provider-admin#/cocreation`);
    await admin.reload();
    await admin.locator('#admin-cocreation [data-seg="wordings"]').waitFor({ timeout: 20_000 });
    await admin.locator('#admin-cocreation [data-seg="wordings"]').click();
    await admin.locator('.cw-character').first().waitFor({ timeout: 8000 });
    await quietWait(admin, 800);
    for (const d of await admin.locator('.cw-character').all())
      await d.evaluate((el: HTMLDetailsElement) => (el.open = true));
    const total = await admin.locator('.cw-row').count();
    check(total >= 6, `admin: the pool is on screen (${total} rows)`);
    const bulk = admin.locator('.cw-bulkbar');
    check(
      (await bulk.locator('.cw-bulk').first().isDisabled()) === true,
      'admin: 上线 / 下线 are off while nothing is ticked',
    );
    await admin.locator('.cw-all input').check();
    check((await admin.locator('.cw-row .cw-tick:checked').count()) === total, 'admin: 全选 ticks every row');
    check(/已选 \d+ 条/.test(await bulk.locator('.cw-picked').innerText()), 'admin: the count of ticked rows is shown');
    const before = posts.length;
    await bulk.locator('.cw-bulk', { hasText: '下线' }).click();
    await admin.waitForFunction(() => document.querySelectorAll('.cw-row[data-enabled="true"]').length === 0, null, {
      timeout: 8000,
    });
    const sent = posts.slice(before).filter((p) => /set-enabled/.test(p.url));
    check(sent.length === 1, `admin: ONE request for the whole selection (${sent.length})`);
    const sentBody = JSON.parse(sent[0]?.body ?? '{}');
    check(
      sentBody.enabled === false && sentBody.ids?.length === total && !('text' in sentBody),
      'admin: the request carries ids and the status only',
    );
    check(!(await admin.locator('#admin-cocreation').innerText()).includes('现行'), 'admin: no 「现行」 on the page');
    // the player-facing pool is empty now: nothing is online
    // hover tips only: no explanation line beside the bulk buttons
    check((await bulk.locator('.ad-tip').count()) >= 2, 'admin: the bulk controls explain themselves on hover');
    check((await bulk.locator('p').count()) === 0, 'admin: no explanation text beside 上线 / 下线');
    if (shots) await admin.screenshot({ path: join(shots, 'wordings-bulk-off.png') });
    // untick all, tick two, 上线
    await admin.locator('.cw-all input').uncheck();
    check((await admin.locator('.cw-row .cw-tick:checked').count()) === 0, 'admin: unticking 全选 clears the rows');
    const rows = admin.locator('.cw-character[data-character="wei-guagua"] [data-theme="theme-know"] .cw-row');
    await rows.nth(0).locator('.cw-tick').check();
    await rows.nth(1).locator('.cw-tick').check();
    // one of the two disappears on the server meanwhile: it must be NAMED, never silently skipped
    const gone = know[1]!;
    await f.post('cocreation/wordings/delete', { id: gone.id });
    await bulk.locator('.cw-bulk', { hasText: '上线' }).click();
    await admin.locator('.cw-error:not([hidden])').waitFor({ timeout: 8000 });
    const message = await admin.locator('.cw-error').innerText();
    check(
      /没有上线/.test(message) && /第二问/.test(message),
      `admin: a wording that did not switch is named (${message})`,
    );
    check((await rows.nth(0).getAttribute('data-enabled')) === 'true', 'admin: the others did switch');
    // the text of every wording is unchanged by the bulk request
    const texts: string[] = await admin
      .locator('.cw-text')
      .evaluateAll((els: HTMLInputElement[]) => els.map((e) => e.value));
    check(texts.includes('{name}第一问') && texts.includes('{name}第三问'), 'admin: the wording text is untouched');
    // back on: switch everything on for the player part
    await admin.locator('.cw-all input').check();
    await bulk.locator('.cw-bulk', { hasText: '上线' }).click();
    // the wording deleted meanwhile cannot switch: it is the one row that stays off, and it is named again
    await admin.waitForFunction(() => document.querySelectorAll('.cw-row[data-enabled="false"]').length === 1, null, {
      timeout: 8000,
    });
    check(/第二问/.test(await admin.locator('.cw-error').innerText()), 'admin: the failed one is named again');
    await admin.close();
    // the deleted one stays deleted; take 「已下线的问」 offline again for the player part
    await f.post('cocreation/wordings/set-enabled', { ids: [off.id], enabled: false });

    // ---- player: one online wording per theme, a new pick on every open ----
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const page: Page = await ctx.newPage();
    watch(page, 'player');
    await page.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
    );
    await page.goto(`${f.origin}/?mode=provider`);
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await quietWait(page, 900);
    const picks: string[] = [];
    const online = new Set(['瓜瓜第一问', '瓜瓜第三问']);
    for (let i = 0; i < 14; i++) {
      await card.locator('.chat-head [aria-haspopup]').first().click();
      await page.locator('.chat-menu-item', { hasText: '一起共创' }).click();
      await page.locator('.cc-sheet').waitFor();
      await quietWait(page, 350);
      const cards: { id: string; prompts: string[] }[] = await page
        .locator('.cc-deck .cc-card[data-card^="theme-"]')
        .evaluateAll((els: Element[]) =>
          els.map((e) => ({
            id: e.getAttribute('data-card')!,
            prompts: [...e.querySelectorAll('.cc-prompt')].map((p) => p.textContent ?? ''),
          })),
        );
      check(
        JSON.stringify(cards.map((c) => c.id)) ===
          JSON.stringify(['theme-know', 'theme-experience', 'theme-habit', 'theme-catchphrase', 'theme-recent']),
        `player open ${i}: one card per theme (${cards.map((c) => c.id)})`,
      );
      for (const c of cards) check(c.prompts.length === 1, `player open ${i}: exactly one wording on ${c.id}`);
      const k = cards.find((c) => c.id === 'theme-know')?.prompts[0] ?? '';
      check(online.has(k), `player open ${i}: an ONLINE wording, never an offline or deleted one (“${k}”)`);
      check(
        cards.find((c) => c.id === 'theme-experience')?.prompts[0] === '瓜瓜经历过哪些事？',
        `player open ${i}: a theme with no online wording shows its plain default`,
      );
      check(
        cards.find((c) => c.id === 'theme-habit')?.prompts[0] === '瓜瓜习惯问',
        `player open ${i}: a pool of one shows it`,
      );
      picks.push(k);
      if (i === 0 && shots) await page.screenshot({ path: join(shots, 'player-deck-one-per-theme.png') });
      await page.locator('.cc-close').first().click();
      await page.locator('.cc-sheet').waitFor({ state: 'detached' });
      await quietWait(page, 150);
    }
    check(
      new Set(picks).size === 2,
      `player: the cards pick again on each open (${[...new Set(picks)]} over ${picks.length} opens)`,
    );
    check(!habit.id.includes('x'), 'seed');
    await ctx.close();
  }

  // ======================= FIX 3: home-card nicknames =======================
  {
    const pw = loadPlaywright();
    for (const env of nameEnvironments(pw)) {
      let browser: Awaited<ReturnType<typeof env.launch>>;
      try {
        browser = await env.launch();
      } catch {
        console.log(`${env.key}: browser not available here`);
        continue;
      }
      const ctx = await browser.newContext({ ...env.context, ignoreHTTPSErrors: true });
      const page: Page = await ctx.newPage();
      watch(page, env.key);
      await openNamedHome(page, f.origin);
      const facts: Array<NameFact & { box: { w: number; h: number }; adv: number; fits: boolean; why: string }> =
        await page.evaluate(() => {
          const MAX = 0.2;
          const canvas = document.createElement('canvas').getContext('2d')!;
          const out: never[] = [];
          for (const slot of document.querySelectorAll<HTMLElement>('.card-slot')) {
            const el = slot.querySelector<HTMLElement>('.card-face:not(.face-reserve) .face-name');
            const text = slot.querySelector<HTMLElement>('.face-name-text');
            if (!el || !text) continue;
            const cs = getComputedStyle(text);
            const fs = Number.parseFloat(cs.fontSize);
            canvas.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
            (canvas as unknown as { letterSpacing: string }).letterSpacing = cs.letterSpacing;
            const m = canvas.measureText(text.textContent ?? '');
            // all in the name's own layout space (no transform): the gradient paints only inside the inner box (padding included)
            const padL = Number.parseFloat(cs.paddingLeft),
              padT = Number.parseFloat(cs.paddingTop);
            const boxW = text.offsetWidth,
              boxH = text.offsetHeight;
            const line = Number.parseFloat(cs.lineHeight) || fs * 0.95;
            const baseline =
              padT + (line - (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent)) / 2 + m.fontBoundingBoxAscent;
            const right = cs.textAlign === 'right' || cs.textAlign === 'end';
            const x0 = right ? boxW - padL - m.width : padL;
            const inkL = x0 - m.actualBoundingBoxLeft,
              inkR = x0 + m.actualBoundingBoxRight;
            const inkT = baseline - m.actualBoundingBoxAscent,
              inkB = baseline + m.actualBoundingBoxDescent;
            const adv = text.offsetWidth - 2 * padL;
            out.push({
              text: text.textContent ?? '',
              size: fs / el.offsetWidth,
              fontPx: fs,
              cardW: el.offsetWidth,
              inkLeft: -inkL,
              inkRight: inkR - boxW,
              inkTop: -inkT,
              inkBottom: inkB - boxH,
              overflowX: Math.max(0, adv - el.offsetWidth),
              family: cs.fontFamily,
              lineHeight: cs.lineHeight,
              letterSpacing: cs.letterSpacing,
              clip: `${cs.backgroundClip}|${getComputedStyle(el).overflow}`,
              box: { w: boxW, h: boxH },
              adv,
              fits: adv <= el.offsetWidth,
              why: `${MAX}`,
            } as never);
          }
          return out;
        });
      check(facts.length >= TEST_NAMES.length, `${env.key}: every test name is on a card (${facts.length})`);
      const sizes = new Set<string>();
      for (const x of facts) {
        const at = `${env.key} 「${x.text}」`;
        check(
          x.inkLeft <= 0.5 && x.inkRight <= 0.5 && x.inkTop <= 0.5 && x.inkBottom <= 0.5,
          `${at}: a glyph is clipped (ink beyond its box L/R/T/B ${[x.inkLeft, x.inkRight, x.inkTop, x.inkBottom].map((v) => v.toFixed(1))})`,
        );
        check(x.overflowX <= 0.5, `${at}: the name overflows the card by ${x.overflowX.toFixed(1)}px`);
        check(
          x.size >= 0.065 - 0.002 && x.size <= 0.2 + 0.002,
          `${at}: size ${x.size.toFixed(3)} outside [0.065, 0.2]`,
        );
        // fixed size wherever the name fits: shrunk only when it would not fit at the maximum
        if (x.size < 0.2 - 0.002)
          check(
            x.adv >= x.cardW * 0.93,
            `${at}: shrunk to ${x.size.toFixed(3)} although it has room (${x.adv.toFixed(0)} of ${x.cardW})`,
          );
        else sizes.add(x.size.toFixed(2));
        check(
          !/(^| )(ui-)?serif\b/.test(x.family) && /Inter|Roboto|SF Pro|apple-system|Helvetica|Arial/.test(x.family),
          `${at}: the name font stack`,
        );
      }
      check(sizes.size <= 1, `${env.key}: names that fit share ONE size (${[...sizes]})`);
      const tooBig = facts.filter((x) => x.size > 0.2 + 0.002);
      check(tooBig.length === 0, `${env.key}: a name above the maximum (${tooBig.map((x) => x.text)})`);
      await browser.close();
    }
  }

  for (const e of errors.slice(0, 8)) problems.push(e);
} catch (error) {
  problems.push(`script error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
} finally {
  await f.close?.();
}
if (problems.length) {
  console.error(`part-44 browser check FAILED (${problems.length}):`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('part-44 browser check passed');
process.exit(0);
