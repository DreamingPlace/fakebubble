import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 40 in a REAL browser (the console fixture, its OFFLINE provider):
 *   - a 多轮预演 started with no other request progresses;
 *   - a column that cannot run fails at once and shows its code (on hover, and counted in 统计);
 *   - the replies appear turn by turn, each in its own cell;
 *   - scroll down mid-run, wait for two polls: the scroll position, the tab, an open 词表 and the focus are where they were;
 *   - both halves of the 预演 tab are as tall as the window leaves them, start on one line and scroll on their own, with no inner box cutting the table off;
 *   - the home cards (centre and sides, with and without a picture) have the avatar, the nickname and the voice bar at the same places.
 *
 * usage: node scripts/check-web-part-40-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const FIX = new URL('../tests/web/fixtures/avatars/', import.meta.url).pathname;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const f = await startConsoleFixture({ provider: { draftMs: 600, reviewMs: 600 } });
try {
  // ======== the home cards ========
  const okPost = async (path: string, data: unknown) => {
    const r = await f.post(path, data);
    assert.equal(r.status(), 200, `${path}: ${await r.text()}`);
    return r.json();
  };
  for (const [id, file] of [
    ['wei-guagua', 'sq-a.png'],
    ['jojo', 'sq-b-alpha.png'],
  ] as const) {
    const up = await okPost(`characters/${id}/avatar-upload`, {
      base64: readFileSync(join(FIX, file)).toString('base64'),
    });
    const detail = await okPost(`characters/${id}/detail`, {});
    const profile = structuredClone(detail.published.profile);
    profile.template.version = detail.published.version + 1;
    profile.presentation.avatar = { id: up.avatar.id };
    const draft = await okPost(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
    await okPost(`characters/${id}/publish`, {
      requestId: randomUUID(),
      draftRevision: draft.revision,
      profileHash: draft.contentHash,
      acknowledgeReview: true,
    });
  }
  const watch = (page: Page) => {
    page.on('pageerror', (e: unknown) => errors.push(String(e)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text()))
        errors.push(`console: ${m.text()}`);
    });
  };
  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const)
    for (const [who, label] of [
      ['wei-guagua', 'avatar'],
      ['chen-jimi', 'initials'],
    ] as const) {
      const ctx = await f.browser.newContext({
        ignoreHTTPSErrors: true,
        viewport: { width, height },
        deviceScaleFactor: 2,
      });
      const page: Page = await ctx.newPage();
      watch(page);
      await page.addInitScript(
        (id: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: id })),
        who,
      );
      await page.goto(`${f.origin}/?mode=provider`);
      await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
      if (who === 'wei-guagua')
        await page.locator('.card-slot.is-active .face-portrait[data-portrait="loaded"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      const at = `${width} ${label}`;
      const cards = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.card-slot')]
          .filter(
            (slot) => getComputedStyle(slot).visibility !== 'hidden' && !slot.classList.contains('is-hidden-slot'),
          )
          .map((slot) => {
            const face = slot.querySelector<HTMLElement>('.card-face:not(.face-reserve)');
            if (!face) return null;
            // layout boxes, not the screen's: a side card is tilted, its bounding box says nothing about its layout
            const H = face.offsetHeight,
              W = face.offsetWidth;
            const rel = (el: HTMLElement | null) => {
              if (!el) return null;
              const t = getComputedStyle(el).translate.split(' ');
              const dy = t[1] && t[1].endsWith('%') ? (parseFloat(t[1]) / 100) * el.offsetHeight : 0;
              const dx = t[0] && t[0].endsWith('%') ? (parseFloat(t[0]) / 100) * el.offsetWidth : 0;
              const top = el.offsetTop + dy,
                left = el.offsetLeft + dx;
              return {
                top: top / H,
                mid: (top + el.offsetHeight / 2) / H,
                bottom: (top + el.offsetHeight) / H,
                height: el.offsetHeight / H,
                width: el.offsetWidth / W,
                cx: (left + el.offsetWidth / 2) / W,
              };
            };
            const box = face.getBoundingClientRect();
            return {
              active: slot.classList.contains('is-active'),
              side: slot.dataset.side ?? null,
              onScreen: box.right > 0 && box.left < innerWidth,
              avatar: rel(slot.querySelector<HTMLElement>('.face-portrait')),
              name: rel(slot.querySelector<HTMLElement>('.face-name')),
              sizeOk: (() => {
                const n = slot.querySelector<HTMLElement>('.face-name')!;
                return (
                  Math.abs(
                    parseFloat(getComputedStyle(n).fontSize) / (W - 32) -
                      Number(getComputedStyle(slot).getPropertyValue('--name-size')),
                  ) < 0.002
                );
              })(),
              voice: rel(slot.querySelector<HTMLElement>('.face-voice')),
            };
          })
          .filter(Boolean),
      );
      const shown = cards.filter((c: any) => c.onScreen);
      check(shown.length >= 2, `${at}: a front card and at least one side card are on screen (${shown.length})`);
      check(
        shown.some((c: any) => c.active),
        `${at}: the front card is measured`,
      );
      const ref = shown.find((c: any) => c.active) ?? shown[0];
      for (const c of shown) {
        const who2 = c.active ? 'front' : `side ${c.side}`;
        check(c.avatar && c.name && c.voice, `${at} ${who2}: avatar, nickname and voice bar are all there`);
        if (!(c.avatar && c.name && c.voice)) continue;
        check(
          Math.abs(c.name.mid - 0.618) < 0.006,
          `${at} ${who2}: the nickname's centre is at 61.8% (${(c.name.mid * 100).toFixed(1)}%)`,
        );
        check(
          Math.abs(c.avatar.top - ref.avatar.top) < 0.004,
          `${at} ${who2}: the avatar sits where the front card's does`,
        );
        check(Math.abs(c.avatar.cx - 0.5) < 0.01, `${at} ${who2}: the avatar is centred`);
        check(c.sizeOk, `${at} ${who2}: the nickname has its own full size (not the small side size)`);
        check(
          c.voice.top >= c.name.bottom - 0.002 && c.voice.top - c.name.bottom < 0.05,
          `${at} ${who2}: the voice bar is directly below the nickname`,
        );
        check(
          c.avatar.bottom <= c.name.top + 0.01,
          `${at} ${who2}: the avatar does not touch the nickname (${c.avatar.bottom.toFixed(3)} / ${c.name.top.toFixed(3)})`,
        );
      }
      const front = await page.evaluate(() => ({
        circle: document.querySelectorAll('.card-slot.is-active .face-portrait').length,
        picture: document.querySelectorAll('.card-slot.is-active .face-portrait img.portrait').length,
        initials: document.querySelector('.card-slot.is-active .face-portrait')?.textContent?.trim() ?? '',
      }));
      check(front.circle === 1, `${at}: the front card has its circle`);
      if (label === 'avatar') check(front.picture === 1, `${at}: the circle holds the picture`);
      else
        check(
          front.picture === 0 && front.initials.length > 0,
          `${at}: the circle holds the initials (${front.initials})`,
        );
      if (shots) await page.screenshot({ path: join(shots, `cards-${width}-${label}.png`) });
      await ctx.close();
    }

  // ======== the 预演 tab ========
  const page: Page = await f.context.newPage();
  watch(page);
  const requests: string[] = [];
  page.on('request', (r: { method: () => string; url: () => string }) => {
    if (r.method() === 'POST') requests.push(r.url().replace(/^.*\/admin\//, ''));
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
  // the Gemini bound is spent when the run starts: that column cannot run and must say so at once
  await page.route('**/rehearsal/start', async (route: { continue: () => Promise<void> }) => {
    f.store.run("UPDATE web_provider_spending SET limit_micros=1 WHERE provider='gemini'");
    await route.continue();
  });
  const halves = '.pw-split > .pw-half';
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    const at = `${width}`;
    f.store.run("UPDATE web_provider_spending SET limit_micros=3000000 WHERE provider='gemini'");
    await page.setViewportSize({ width, height });
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/wei-guagua`);
    await page.reload();
    await page.getByText('预演', { exact: true }).first().click();
    await page.locator('.pw-split .pw-half-rehearsal .rh-rail .rh-pick').first().waitFor({ timeout: 20_000 });
    await wait(1200);

    // ---- both halves: one top line, the same height, filling what the window leaves, each scrolling on its own ----
    const geometry = async () =>
      page.evaluate((sel: string) => {
        const [a, b] = [...document.querySelectorAll<HTMLElement>(sel)];
        const box = (el: HTMLElement) => el.getBoundingClientRect();
        return {
          tops: [box(a!).top, box(b!).top],
          heights: [box(a!).height, box(b!).height],
          bottoms: [box(a!).bottom, box(b!).bottom],
          scrolls: [getComputedStyle(a!).overflowY, getComputedStyle(b!).overflowY],
          view: innerHeight,
        };
      }, halves);
    const g = await geometry();
    check(Math.abs(g.tops[0]! - g.tops[1]!) <= 1, `${at}: the halves start on one line (${g.tops})`);
    check(Math.abs(g.heights[0]! - g.heights[1]!) <= 1, `${at}: the halves are one height (${g.heights})`);
    check(
      g.view - Math.max(...g.bottoms) < 110 && g.view - Math.max(...g.bottoms) >= 0,
      `${at}: they fill the window down to the bar (${g.bottoms} / ${g.view})`,
    );
    check(
      g.scrolls.every((s: string) => s === 'auto'),
      `${at}: each half scrolls on its own (${g.scrolls})`,
    );
    await shot(`halves-${at}`);

    // ---- start a run on DeepSeek and Gemini; nothing else is sent to wake it ----
    await page.locator('.pw-half-rehearsal .rh-rail .rh-pick', { hasText: '日常闲聊' }).click();
    const gemini = page.locator('.pw-half-rehearsal .rh-toggle[data-model="gemini"]');
    if ((await gemini.getAttribute('aria-pressed')) !== 'true') await gemini.click();
    const send = page.locator('.pw-half-rehearsal [data-pw-send="rehearsal"]');
    await page.waitForFunction(
      () => /次调用/.test(document.querySelector('.pw-half-rehearsal [data-pw-send="rehearsal"]')?.textContent ?? ''),
      null,
      { timeout: 15_000 },
    );
    const runsBefore = await page.locator('.rh-run').count();
    await send.click();
    await send.click();
    const mark = requests.length;
    await page.locator('.rh-grid').waitFor({ timeout: 15_000 });
    // replies turn by turn: the number of finished cells passes through several values before the end
    const seen = new Set<number>();
    const sample = async () => {
      const n = await page.locator('.pw-half-rehearsal .rh-cell[data-state="done"]').count();
      seen.add(n);
      return n;
    };
    await page.waitForFunction(
      () => document.querySelectorAll('.pw-half-rehearsal .rh-cell[data-state="done"]').length >= 1,
      null,
      { timeout: 30_000 },
    );
    check(
      requests
        .slice(mark)
        .every((r: string) =>
          /^rehearsal\/(detail|list|items|library)$|previews-status|run-list|^characters\/wei-guagua\/(detail|previews-status|run-list)$/.test(
            r,
          ),
        ),
      `${at}: nothing but reads was sent for the run to progress (${[...new Set(requests.slice(mark))]})`,
    );
    // the failed column, at once, with its code
    await page.locator('.pw-half-rehearsal .rh-cell[data-state="failed"]').first().waitFor({ timeout: 15_000 });
    const failedChip = page.locator('.pw-half-rehearsal .rh-cell[data-state="failed"] .admin-badge').first();
    await failedChip.hover();
    await page.waitForFunction(() => /代码 WEB_PROVIDER_BUDGET_EXHAUSTED/.test(document.body.innerText), null, {
      timeout: 5000,
    });
    check(true, 'hover');
    await shot(`failed-hover-${at}`);
    await page.mouse.move(5, 5);
    await sample();

    // ---- mid-run: scroll, change tab, open 词表, wait for two polls ----
    const half = page.locator('.pw-half-rehearsal');
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('.pw-half-rehearsal')!;
      el.scrollTop = Math.min(300, el.scrollHeight - el.clientHeight);
    });
    await shot(`mid-run-${at}`);
    const before = await page.evaluate(() => ({
      top: document.querySelector<HTMLElement>('.pw-half-rehearsal')!.scrollTop,
      win: scrollY,
      tab:
        document.querySelector(
          '.pw-half-rehearsal .seg-button[aria-pressed="true"], .pw-half-rehearsal .seg-button[aria-selected="true"]',
        )?.textContent ?? '',
    }));
    check(before.top > 50, `${at}: the half is scrolled (${before.top})`);
    const polls0 = requests.filter((r: string) => r === 'rehearsal/detail').length;
    await page.waitForFunction((n: number) => (window as any).__polls === undefined || true, polls0);
    while (requests.filter((r: string) => r === 'rehearsal/detail').length < polls0 + 2) {
      await sample();
      await page.waitForTimeout(250);
    }
    const after = await page.evaluate(() => ({
      top: document.querySelector<HTMLElement>('.pw-half-rehearsal')!.scrollTop,
      win: scrollY,
      tab:
        document.querySelector(
          '.pw-half-rehearsal .seg-button[aria-pressed="true"], .pw-half-rehearsal .seg-button[aria-selected="true"]',
        )?.textContent ?? '',
    }));
    check(
      Math.abs(after.top - before.top) <= 1 && after.win === before.win,
      `${at}: two polls later the scroll position is the same (${before.top} -> ${after.top})`,
    );
    check(after.tab === before.tab, `${at}: the tab is the same (${before.tab} -> ${after.tab})`);
    // the 统计 tab with its 词表 open: the same, and the numbers keep coming
    await page.locator('.pw-half-rehearsal .seg-button', { hasText: '统计' }).click();
    await page.locator('.pw-half-rehearsal .rh-counts').waitFor();
    await page.locator('.pw-half-rehearsal .rh-words > summary').click();
    await page.locator('.pw-half-rehearsal .rh-words textarea').first().focus();
    const polls1 = requests.filter((r: string) => r === 'rehearsal/detail').length;
    let polled = false;
    while (requests.filter((r: string) => r === 'rehearsal/detail').length < polls1 + 2) {
      polled = true;
      await sample();
      await page.waitForTimeout(250);
      if (!(await page.locator('.pw-half-rehearsal .rh-run-wrap').count())) break;
      if (/完成|失败/.test((await page.locator('.pw-half-rehearsal .rh-runhead .admin-badge').textContent()) ?? ''))
        break;
    }
    const still = await page.evaluate(() => ({
      open: document.querySelector<HTMLDetailsElement>('.pw-half-rehearsal .rh-words')?.open ?? false,
      tab:
        document.querySelector(
          '.pw-half-rehearsal .seg-button[aria-pressed="true"], .pw-half-rehearsal .seg-button[aria-selected="true"]',
        )?.textContent ?? '',
      focus: document.activeElement?.tagName ?? '',
    }));
    check(
      still.open && still.tab === '统计' && still.focus === 'TEXTAREA',
      `${at}: 统计, the open 词表 and the focus stay through the polls (${JSON.stringify(still)}, polled ${polled})`,
    );
    // the run ends: the polling stops
    await page.waitForFunction(
      () => /完成|失败/.test(document.querySelector('.pw-half-rehearsal .rh-runhead .admin-badge')?.textContent ?? ''),
      null,
      { timeout: 120_000 },
    );
    await wait(600);
    const quiet = requests.filter((r: string) => r === 'rehearsal/detail').length;
    await page.waitForTimeout(6500);
    check(
      requests.filter((r: string) => r === 'rehearsal/detail').length === quiet,
      `${at}: a finished run is not polled again`,
    );
    check(
      seen.size >= 3,
      `${at}: the replies came turn by turn (finished cells seen: ${[...seen].sort((a, b) => a - b)})`,
    );
    check(
      (await page.locator('.pw-half-rehearsal .rh-counts [data-row="codes"]').innerText()).includes(
        'WEB_PROVIDER_BUDGET_EXHAUSTED × 1',
      ),
      `${at}: 统计 counts the code`,
    );
    await page.evaluate(() =>
      document
        .querySelector('.pw-half-rehearsal .rh-words > summary')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    await page.evaluate(() =>
      document.querySelector('.pw-half-rehearsal .rh-runhead')?.scrollIntoView({ block: 'start', behavior: 'instant' }),
    );
    await shot(`counts-${at}`);

    // ---- the table is not cut by an inner box: the last turn can be scrolled to inside the half ----
    await page.locator('.pw-half-rehearsal .seg-button', { hasText: '对话' }).click();
    await page.locator('.pw-half-rehearsal .rh-grid').waitFor();
    const cut = await page.evaluate(() => {
      const half = document.querySelector<HTMLElement>('.pw-half-rehearsal')!;
      const grid = document.querySelector<HTMLElement>('.pw-half-rehearsal .rh-grid')!;
      const boxes: string[] = [];
      for (let el: HTMLElement | null = grid.parentElement; el && el !== half; el = el.parentElement) {
        const cs = getComputedStyle(el);
        if (/(auto|scroll|hidden|clip)/.test(`${cs.overflowY} ${cs.overflowX}`)) boxes.push(el.className);
      }
      const rows = grid.querySelectorAll<HTMLElement>('.rh-row');
      const tail = rows[rows.length - 1]!.lastElementChild as HTMLElement; // a row lays out as `contents`: its last cell is the box
      tail.scrollIntoView({ block: 'end', behavior: 'instant' });
      const last = tail.getBoundingClientRect(),
        frame = half.getBoundingClientRect();
      return {
        boxes,
        rows: rows.length,
        last: [last.top, last.bottom],
        frame: [frame.top, frame.bottom],
        visible: last.bottom <= frame.bottom + 1 && last.top >= frame.top - 1,
      };
    });
    check(cut.boxes.length === 0, `${at}: no box inside the half scrolls or clips (${cut.boxes})`);
    check(
      cut.rows === 8 && cut.visible,
      `${at}: all 8 turns can be scrolled into view inside the half (${JSON.stringify(cut)})`,
    );
    await shot(`bottom-${at}`);
    check((await page.locator('.rh-run').count()) > runsBefore, `${at}: the run is in the list`);
  }
  check(errors.length === 0, `browser errors: ${errors.join(' | ')}`);
} finally {
  await f.close();
}
assert.deepEqual(problems, [], problems.join('\n'));
console.log('part 40 browser checks passed');
