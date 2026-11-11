import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { importLongContent } from './console-long-content-24b7b.ts';

/**
 * Part 24b-7b (offline provider only; nothing reaches a provider): the console on REAL-shaped content, in a real browser at 1280, 1440 and
 * 1920. Three characters filled through the 24j import (the repository's example and two long variants: 说话风格 items of 40–80 characters
 * with 「」, eight 欢迎词 lines some past 150 characters, long aliases, multi-paragraph 经历, empty 对话风格 / 对话样例).
 *   A  every field fits what it holds: nothing cut (scrollWidth ≤ clientWidth, scrollHeight ≤ clientHeight), one-sentence boxes one line
 *      high when their text fits a line, sentence lists are rows (no chips), the % column is aligned, 资料改动 shows no JSON.
 *   B  one page layout: the form column has the same left edge and width on every form tab, the save bar is at the bottom of the window
 *      after scrolling any tab, selected and hovered tabs differ, every mark on the rail has a hover tip.
 *   C  every collapsible shows a chevron, carries aria-expanded and toggles by Enter and Space.
 *   D  总览: one table, 按天 / 按角色 / 按模型, the totals are the numbers the old cards showed.
 *   E  声音 with three welcome lines is reached and looked at.
 *
 * usage: node scripts/check-web-admin-24b7b-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  await importLongContent(f);
  const list = await (await f.post('characters/list', {})).json();
  const idOf = (name: string) =>
    list.characters.find((c: { displayName: string }) => c.displayName === name)?.characterId as string;
  const people = { lqy: idOf('青野'), xj: idOf('小江'), syz: idOf('砚舟') };
  assert.ok(people.lqy && people.xj && people.syz, 'the three imported characters exist');
  const page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
      errors.push(`console: ${message.text()}`);
  });
  const wait = (ms = 450) => page.waitForTimeout(ms);
  const open = async (hash: string, ready = '.wb-tab') => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
    await page.reload();
    await page.locator(ready).first().waitFor({ timeout: 20_000 });
    await wait(900);
  };
  const tabNames = async () =>
    (await page.$$eval('.wb-tab', (n: Element[]) => n.map((x) => x.querySelector('span')!.textContent))) as string[];
  const tab = (name: string) => page.locator(`button.wb-tab:has(span:text-is("${name}"))`).first();

  /** Run in the page: what does not fit, what is not one line, where the form column and the save bar are. */
  const measure = () =>
    page.evaluate(`(() => {
      const vis = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const name = (n) => (n.getAttribute('aria-label') || n.closest('label')?.querySelector('span')?.textContent || n.className || n.tagName).toString().slice(0, 40);
      const body = document.querySelector('.wb-card-body');
      const cut = [];
      for (const n of body.querySelectorAll('input:not([type=checkbox]):not([type=radio]):not([type=color]):not([type=file]), textarea, .cs-chip, .cn-chip')) {
        if (!vis(n)) continue;
        if (n.scrollWidth - n.clientWidth > 1 || (n.tagName === 'TEXTAREA' && n.scrollHeight - n.clientHeight > 1))
          cut.push(name(n) + ' ' + n.scrollWidth + '/' + n.clientWidth + ' x ' + n.scrollHeight + '/' + n.clientHeight);
      }
      const tall = [];
      for (const n of body.querySelectorAll('textarea[data-grow="one"]')) {
        if (!vis(n)) continue;
        const s = getComputedStyle(n);
        const line = parseFloat(s.lineHeight) || parseFloat(s.fontSize) * 1.5;
        const pad = parseFloat(s.paddingTop) + parseFloat(s.paddingBottom) + parseFloat(s.borderTopWidth) + parseFloat(s.borderBottomWidth);
        const text = Math.round((n.scrollHeight - pad) / line), box = Math.round((n.getBoundingClientRect().height - pad) / line);
        if (box > text) tall.push(name(n) + ' box ' + box + ' lines for ' + text);
      }
      const first = [...body.querySelectorAll(':scope > :not([hidden]), :scope > form > :not([hidden])')].find((n) => vis(n) && n.tagName !== 'FORM');
      const r = first ? first.getBoundingClientRect() : null;
      const bar = document.querySelector('.wb-savebar').getBoundingClientRect();
      return {
        cut, tall,
        column: r ? { left: Math.round(r.left), width: Math.round(r.width) } : null,
        bar: { top: Math.round(bar.top), bottom: Math.round(bar.bottom) },
        vh: window.innerHeight,
        over: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chips: body.querySelectorAll('.cn-chip, .cn-chip-input').length,
        json: /[{}]|"[A-Za-z]+"\\s*:/.test(body.innerText),
      };
    })()`) as Promise<{
      cut: string[];
      tall: string[];
      column: { left: number; width: number } | null;
      bar: { top: number; bottom: number };
      vh: number;
      over: number;
      chips: number;
      json: boolean;
    }>;
  /** Every collapsible on the page: a chevron, aria-expanded, a pointer. */
  const collapsibles = () =>
    page.evaluate(`(() => { const out = []; const vis = (n) => { const r = n.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      let n = 0;
      for (const c of document.querySelectorAll('[aria-expanded], details > summary')) { if (!vis(c)) continue; n++;
        const chev = c.querySelector('.ot-chevron,.dc-chev,.pw-chev,svg'); const ae = c.hasAttribute('aria-expanded');
        if (!chev || !ae || getComputedStyle(c).cursor !== 'pointer') out.push((c.className || c.tagName).toString().slice(0, 40) + ' chevron=' + !!chev + ' aria-expanded=' + ae + ' cursor=' + getComputedStyle(c).cursor);
      }
      return { n, bad: out }; })()`) as Promise<{ n: number; bad: string[] }>;
  /** Enter closes or opens it, Space does the reverse. */
  const keyboardToggles = async (selector: string, label: string) => {
    const control = page.locator(selector).first();
    if (!(await control.count())) {
      check(false, `${label}: no such control (${selector})`);
      return;
    }
    const read = async () => await control.getAttribute('aria-expanded');
    const was = await read();
    await control.focus();
    await page.keyboard.press('Enter');
    await wait(350);
    const afterEnter = await read();
    await page.keyboard.press('Space');
    await wait(350);
    const afterSpace = await read();
    check(afterEnter !== was, `${label}: Enter toggles (${was} → ${afterEnter})`);
    check(afterSpace === was, `${label}: Space toggles back (${afterSpace})`);
  };

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    const w = String(width);
    await page.setViewportSize({ width, height });
    const shot = async (name: string, full = false) => {
      if (shots) {
        await wait(350);
        await page.screenshot({ path: join(shots, `${name}-${w}.png`), fullPage: full });
      }
    };

    // =================== A + B on every tab of the three imported characters ===================
    const columns: Record<string, { left: number; width: number }[]> = {};
    for (const [who, id] of Object.entries(people)) {
      await open(`characters/${id}`);
      const tabs = await tabNames();
      check(tabs.length >= 9, `${w} ${who}: the tabs are there (${tabs.join(',')})`);
      for (const name of tabs) {
        await tab(name).click();
        await wait();
        const label = `${w} ${who} ${name}`;
        const m = await measure();
        check(m.cut.length === 0, `${label}: text cut off: ${m.cut.slice(0, 3).join(' | ')}`);
        check(
          m.tall.length === 0,
          `${label}: a one-sentence box taller than its text: ${m.tall.slice(0, 2).join(' | ')}`,
        );
        check(m.over <= 0, `${label}: sideways scroll ${m.over}px`);
        check(m.chips === 0, `${label}: no chips for sentence lists`);
        if (name === '资料改动') check(!m.json, `${label}: JSON braces or quoted keys in 资料改动`);
        if (
          ['身份与展示', '欢迎内容', '性格', '说话方式', '经历', '其余设定', '声音', '发布'].includes(name) &&
          m.column
        )
          (columns[name] ??= []).push(m.column);
        // the save bar: at the bottom of the window on a short tab, and still there after scrolling a long one
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await wait(150);
        const after = await measure();
        check(
          after.bar.bottom <= after.vh + 1 && after.bar.bottom >= after.vh - 24,
          `${label}: the save bar is not at the bottom of the window after scrolling (${after.bar.top}-${after.bar.bottom} of ${after.vh})`,
        );
        await page.evaluate('window.scrollTo(0, 0)');
        if (who === 'lqy') await shot(`lqy-${tabs.indexOf(name)}-${name}`);
        if (who === 'xj' && name === '声音') {
          // E: 声音 with three welcome lines (xj has exactly three), the whole tab
          const lines = await (await f.post(`characters/${id}/detail`, {})).json();
          const n = (lines.draft?.profile ?? lines.published.profile).presentation.welcomes.length;
          check(n === 3, `${label}: xj has three welcome lines (${n})`);
          await shot('xj-voice-3-lines');
          await shot('xj-voice-3-lines-full', true);
        }
      }
      if (who === 'lqy') {
        // 欢迎内容: eight lines; the % is one aligned column, all lines are sentences that grow
        await tab('欢迎内容').click();
        await wait();
        const rows = await page.$$eval('.wl-row', (n: Element[]) => n.length);
        check(rows === 8, `${w}: eight welcome lines (${rows})`);
        const weightLefts = await page.$$eval('.wl-weight', (n: Element[]) => [
          ...new Set(n.map((x) => Math.round(x.getBoundingClientRect().left))),
        ]);
        check(weightLefts.length === 1, `${w}: the % column is aligned (${weightLefts.join(',')})`);
        const pctOnLine = await page.$$eval('.wl-row', (n: Element[]) =>
          n.every((r) => {
            const a = r.querySelector('.wl-weight')!.getBoundingClientRect(),
              b = r.querySelector('.wl-pct')!.getBoundingClientRect();
            return Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)) < 4;
          }),
        );
        check(pctOnLine, `${w}: the % unit is on the same line as its number`);
        const heights = await page.$$eval('.wl-text', (n: Element[]) =>
          n.map((x) => Math.round(x.getBoundingClientRect().height)),
        );
        check(Math.min(...heights) <= 44, `${w}: a short welcome line is one line high (${Math.min(...heights)}px)`);
        check(Math.max(...heights) > 44, `${w}: a 150+ character line grows (${Math.max(...heights)}px)`);
        await shot('lqy-welcome-8');
        // 说话方式: rows, and the empty 对话风格 shows one empty row
        await tab('说话方式').click();
        await wait();
        const sl = await page.$$eval('.cn-pane .sl-row textarea', (n: HTMLTextAreaElement[]) => n.map((x) => x.value));
        check(
          sl.filter((x: string) => x.length >= 40).length >= 8,
          `${w}: the 说话风格 items (40+ characters) are one row each`,
        );
        check(
          sl.some((x: string) => x === ''),
          `${w}: an empty 对话风格 shows one empty row to type into`,
        );
        check((await page.locator('.cn-pair').count()) === 1, `${w}: an empty 对话样例 shows one example to type into`);
        // keyboard-add a row
        await shot('lqy-speech-rows');
        // 经历: paragraphs
        await tab('经历').click();
        await wait();
        const paraHeights = await page.$$eval('.cn-card textarea', (n: Element[]) =>
          n.map((x) => Math.round(x.getBoundingClientRect().height)),
        );
        check(
          paraHeights.length >= 3 && Math.max(...paraHeights) > 112,
          `${w}: a multi-paragraph 经历 grows past four lines (${paraHeights.join(',')})`,
        );
        // 身份与展示: short values are not stretched across the column
        await tab('身份与展示').click();
        await wait();
        const widths = await page.$$eval('.wb-card-body label > input.si', (n: HTMLElement[]) =>
          n.map((x) => Math.round(x.getBoundingClientRect().width)),
        );
        check(
          widths.length >= 3 && Math.max(...widths) < 560,
          `${w}: names, ids and colours are sized to their limit (${widths.join(',')})`,
        );
      }
    }
    for (const [name, list] of Object.entries(columns)) {
      const left = new Set(list.map((c) => c.left)),
        wd = new Set(list.map((c) => c.width));
      check(
        left.size === 1 && wd.size === 1,
        `${w}: ${name}: the form column moves between characters (${[...left]} / ${[...wd]})`,
      );
    }
    const all = Object.values(columns).flat();
    check(
      new Set(all.map((c) => c.left)).size === 1 && new Set(all.map((c) => c.width)).size === 1,
      `${w}: the form column differs from tab to tab`,
    );
    check(
      // a reading measure of 880–960 px; where the card itself is narrower (1280) the column is the card's own width
      all.length > 0 && all[0]!.width <= 960 && (all[0]!.width >= 880 || width <= 1280),
      `${w}: the form column is a reading measure (${all[0]?.width})`,
    );

    // =================== B: tabs, rail ===================
    await open(`characters/${people.lqy}`);
    await tab('欢迎内容').click();
    await wait();
    const styleOf = async (name: string) =>
      page.evaluate((n: string) => {
        const el = [...document.querySelectorAll('button.wb-tab')].find(
          (b) => b.querySelector('span')!.textContent === n,
        )!;
        const s = getComputedStyle(el);
        return { bg: s.backgroundColor, weight: s.fontWeight };
      }, name) as Promise<{ bg: string; weight: string }>;
    const selected = await styleOf('欢迎内容');
    await tab('性格').hover();
    await wait(300);
    const hovered = await styleOf('性格');
    check(selected.bg !== hovered.bg, `${w}: a hovered tab and the selected tab have different backgrounds`);
    check(
      Number(selected.weight) > Number(hovered.weight),
      `${w}: the selected tab is bolder (${selected.weight} vs ${hovered.weight})`,
    );
    const rail = (await page.evaluate(`(() => {
      const marks = [...document.querySelectorAll('.admin-pick-st, .admin-pick-head b, .admin-pick[data-seed], .cocreation-badge')];
      const head = document.querySelector('.admin-pick-head .dc-text span');
      const open = document.querySelector('.admin-pick[aria-current="true"]');
      const roster = document.querySelector('.wb-roster').getBoundingClientRect();
      const o = open ? open.getBoundingClientRect() : null;
      return { total: marks.length, untitled: marks.filter((m) => !(m.getAttribute('title') || '').trim()).length,
        headVisible: !!head && getComputedStyle(head).opacity === '1' && head.getBoundingClientRect().width > 0,
        inView: !!o && o.top >= roster.top - 1 && o.bottom <= roster.bottom + 1 };
    })()`)) as { total: number; untitled: number; headVisible: boolean; inView: boolean };
    check(
      rail.total > 3 && rail.untitled === 0,
      `${w}: every mark on the rail has a hover tip (${rail.untitled} of ${rail.total} have none)`,
    );
    check(rail.headVisible, `${w}: the rail's group headings are readable`);
    check(rail.inView, `${w}: the open character is in view in the rail`);

    // =================== C: every collapsible ===================
    for (const hash of [
      'overview',
      'cast',
      'cocreation',
      'members',
      'invites',
      'points',
      'costs',
      'models',
      'system',
      'conversations',
    ]) {
      await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
      await page.reload();
      await wait(2000);
      const c = await collapsibles();
      check(
        c.bad.length === 0,
        `${w} ${hash}: collapsibles without a chevron / aria-expanded / pointer: ${c.bad.slice(0, 3).join(' | ')}`,
      );
    }
    await open(`characters/${people.lqy}`);
    for (const name of ['声音', '资料改动', '发布', '预演']) {
      await tab(name).click();
      await wait(600);
      const c = await collapsibles();
      check(
        c.bad.length === 0,
        `${w} ${name}: collapsibles without a chevron / aria-expanded / pointer: ${c.bad.slice(0, 3).join(' | ')}`,
      );
    }
    // by keyboard: the rail group, a <details>, the 预演 settings line, a table row
    await keyboardToggles('.admin-pick-head', `${w} rail group`);
    await tab('资料改动').click();
    await wait(500);
    await keyboardToggles('.wb-card-body details > summary.dc', `${w} <details> in 资料改动`);
    await tab('预演').click();
    await wait(500);
    await keyboardToggles('.pw-summary', `${w} 预演 settings line`);
    await keyboardToggles('details.pw-review-section > summary', `${w} 审核对比`);
    await page.goto(`${f.origin}/?mode=provider-admin#/members`);
    await page.reload();
    await page.locator('.ot-row.is-pickable').first().waitFor({ timeout: 20_000 });
    await wait(800);
    await keyboardToggles('.ot-row.is-pickable', `${w} members row`);
    await shot('members-rows');

    // =================== D: 总览, one table ===================
    const today = await (await f.post('stats/players', { range: 7 })).json();
    await page.goto(`${f.origin}/?mode=provider-admin#/overview`);
    await page.reload();
    await page.locator('.ov-days .ot-row').first().waitFor({ timeout: 20_000 });
    await wait(1500);
    check(
      (await page.locator('[aria-label="按角色"], [aria-label="按模型"]').count()) === 0,
      `${w}: no separate 按角色 / 按模型 cards`,
    );
    const seg = (label: string) => page.locator(`[aria-label="统计维度"] button:text-is("${label}")`);
    const rowsOf = async (selector: string) =>
      (await page.$$eval(`${selector} .ot-row`, (n: Element[]) =>
        n.map((r) => [...r.querySelectorAll('.ot-cell')].map((c) => (c.firstChild?.textContent ?? '').trim())),
      )) as string[][];
    const days = await rowsOf('.ov-days');
    check(days.length === 8 && days.at(-1)![0] === '合计', `${w}: 按天 shows the days and 合计 (${days.length})`);
    await shot('overview-by-day');
    await seg('按角色').click();
    await wait(300);
    const chars = await rowsOf('.ov-by:not([hidden])');
    const wantChars = today.byCharacter as { name: string; published: number }[];
    check(
      chars.length === wantChars.length + 1,
      `${w}: 按角色 has a row per character and 合计 (${chars.length} / ${wantChars.length})`,
    );
    check(
      wantChars.every((c) => chars.some((r) => r[0] === c.name && Number(r[1]) === c.published)),
      `${w}: 按角色 shows each character's 成功 as the old card did`,
    );
    check(
      Number(chars.at(-1)![1]) === wantChars.reduce((n, c) => n + c.published, 0),
      `${w}: 按角色 合计 is the sum of the old card's values`,
    );
    await shot('overview-by-character');
    await seg('按模型').click();
    await wait(300);
    const models = await rowsOf('.ov-by:not([hidden])');
    const wantModels = today.byModel as { model: string; published: number }[];
    check(
      models.length === wantModels.length + 1,
      `${w}: 按模型 has a row per model and 合计 (${models.length} / ${wantModels.length})`,
    );
    check(
      Number(models.at(-1)![1]) === wantModels.reduce((n, m) => n + m.published, 0),
      `${w}: 按模型 合计 is the sum of the old card's values`,
    );
    await shot('overview-by-model');
    // sortable: a click on 成功 orders the rows, 合计 stays last
    await page.locator('.ov-by:not([hidden]) button.ot-sort[data-sort="published"]').click();
    await wait(200);
    const sorted = await rowsOf('.ov-by:not([hidden])');
    check(sorted.at(-1)![0] === '合计', `${w}: a sorted table keeps 合计 last`);
    const values = sorted.slice(0, -1).map((r) => Number(r[1]));
    check(
      values.every((v, i) => i === 0 || values[i - 1]! <= v),
      `${w}: the 成功 column sorts`,
    );
    await seg('按天').click();
    await wait(300);
    check((await page.locator('.ov-days .ot-row').count()) === 8, `${w}: back to 按天`);
    await page.locator('.ov-days button.ot-sort[data-sort="signups"]').click();
    check(
      (await page.locator('.ov-days .ot-row').last().innerText()).includes('合计'),
      `${w}: 按天 sorted keeps 合计 last`,
    );

    // =================== 关系与故事, 共创收件箱, 管理员与权限: nothing scrolls sideways ===================
    for (const [hash, shotName] of [
      ['cast', 'cast'],
      ['cocreation', 'inbox'],
      ['members', 'members'],
    ] as const) {
      await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
      await page.reload();
      await wait(2200);
      const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
      check((over as number) <= 0, `${w} ${hash}: sideways scroll ${over}px`);
      await shot(shotName);
    }
  }
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (errors.length) problems.push(...errors);
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`${problems.length} problem(s)`);
  process.exitCode = 1;
} else if (!failure) console.log('check:web:admin-24b7b ok');
