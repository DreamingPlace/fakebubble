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
          await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
          await page.evaluate(
            "document.querySelector('.wb-card-body').lastElementChild?.scrollIntoView({ block: 'end' })",
          );
          await shot('xj-voice-3-lines-scrolled');
          await page.evaluate('window.scrollTo(0, 0)');
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

    // =================== round 2: 其余设定, the rail headings, 发布, the shared row controls, 声音 ===================
    {
      const settingsOf = async (id: string) => {
        const d = await (await f.post(`characters/${id}/detail`, {})).json();
        return (d.draft?.profile ?? d.published.profile).template.authorCanon?.settings as Record<string, any>;
      };
      // 其余设定 (filled): facts are rows, the four boundaries are boxes in order, no JSON box (no unknown key)
      await open(`characters/${people.lqy}`);
      await tab('其余设定').click();
      await wait();
      check((await page.locator('.cn-fact').count()) >= 10, `${w}: 个人资料 is one row per fact`);
      const names = await page.$$eval('.cn-boundary > span', (n: Element[]) => n.map((x) => x.textContent));
      check(
        names.join('|') === '知道但不会说出口的事|不可改变的核心设定|不应擅自补充的事实|不符合角色的行为·表达',
        `${w}: the four 边界 boxes in the template's order (${names.join('|')})`,
      );
      check(
        (await page.locator('textarea.admin-json:visible').count()) === 0,
        `${w}: no JSON box when no other key exists`,
      );
      const factLabels = await page.$$eval('.cn-fact .cn-fact-label', (n: HTMLInputElement[]) => n.map((x) => x.value));
      check(
        factLabels.includes('学校-年级') && factLabels.includes('兴趣·擅长的事'),
        `${w}: the 24j labels are kept as written`,
      );
      // edit one fact and one boundary, save, reload: only those change
      const before = await settingsOf(people.lqy);
      const heightNow = `18${w.slice(0, 2)}cm`;
      const factRow = page.locator('.cn-fact', { has: page.locator('.cn-fact-label') }).nth(1);
      await factRow.locator('textarea').fill(heightNow);
      const boundaryNow = `不擅自添加恋爱史（${w}）。`;
      await page.locator('.cn-boundary textarea').nth(2).fill(boundaryNow);
      await page.locator('.wb-savebar button', { hasText: '保存草稿' }).click();
      await wait(1500);
      const after = await settingsOf(people.lqy);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      check(Object.keys(after).join() === Object.keys(before).join(), `${w}: the key order is kept`);
      for (const key of Object.keys(before))
        if (key !== 'profileFacts' && key !== 'boundaries')
          check(same(before[key], after[key]), `${w}: ${key} changed though nobody touched it`);
      check(after.profileFacts['身高'] === heightNow, `${w}: the fact edit was saved`);
      check(after.boundaries['不应擅自补充的事实'] === boundaryNow, `${w}: the boundary edit was saved`);
      check(
        same({ ...after.profileFacts, 身高: 0 }, { ...before.profileFacts, 身高: 0 }) &&
          same({ ...after.boundaries, 不应擅自补充的事实: 0 }, { ...before.boundaries, 不应擅自补充的事实: 0 }),
        `${w}: only the edited fact and boundary differ`,
      );
      await open(`characters/${people.lqy}`);
      await tab('其余设定').click();
      await wait();
      check(
        (await page.locator('.cn-boundary textarea').nth(2).inputValue()) === boundaryNow,
        `${w}: the boundary is there after a reload`,
      );
      await tab('资料改动').click();
      await wait(900);
      const diffText = (await page.locator('.wb-card-body').innerText()) as string;
      check(
        /个人资料/.test(diffText) && /边界与隐藏设定/.test(diffText) && diffText.includes(heightNow),
        `${w}: 资料改动 shows the edit with the same labels`,
      );
      check(!/[{}]|"[A-Za-z]+"\s*:|profileFacts/.test(diffText), `${w}: 资料改动 shows no JSON or key names`);
      await shot('r2-other-settings-filled');
      // 其余设定 (empty facts, another key): a key no editor owns (here interests, once) stays under 其他（JSON）
      {
        const d = await (await f.post('characters/jojo/detail', {})).json();
        const profile = structuredClone((d.draft?.profile ?? d.published.profile) as any);
        if (!d.draft) profile.template.version = d.published.version + 1;
        const settings = (profile.template.authorCanon?.settings ?? {}) as Record<string, unknown>;
        if (!('interests' in settings)) {
          settings.interests = ['雨天', '旧书', '热茶'];
          profile.template.authorCanon = { kind: 'author_canon', settings };
          const saved = await f.post('characters/jojo/save', { expectedRevision: d.draft?.revision ?? null, profile });
          check(saved.status() === 200, `${w}: the fixture saved a draft with another key`);
        }
      }
      await open('characters/jojo');
      await tab('其余设定').click();
      await wait();
      check((await page.locator('.cn-fact').count()) === 1, `${w}: empty 个人资料 shows one empty row`);
      check((await page.locator('.cn-boundary textarea').count()) === 4, `${w}: empty 边界 shows four boxes`);
      const fold = page.locator('details > summary', { hasText: '其他（JSON）' });
      check((await fold.count()) === 1, `${w}: other keys wait under 其他（JSON）`);
      check((await fold.getAttribute('aria-expanded')) === 'false', `${w}: 其他（JSON） is folded`);
      await fold.click();
      await wait(400);
      const json = await page.locator('textarea.admin-json').inputValue();
      check(
        /selfIdentity|basicInfo|hobbies/.test(json) && !/profileFacts|boundaries/.test(json),
        `${w}: the JSON box holds the other keys only`,
      );
      await shot('r2-other-settings-empty-and-json');

      // the rail: headings readable, never under the open character's row
      await open(`characters/${people.lqy}`);
      const rail = (await page.evaluate(`(() => {
        const out = [];
        for (const g of document.querySelectorAll('.admin-pick-group')) {
          const h = g.querySelector('.admin-pick-head'); const list = g.querySelector('.admin-pick-list'); const label = h.querySelector('.dc-text span');
          const hr = h.getBoundingClientRect(), lr = list.getBoundingClientRect(), tr = label.getBoundingClientRect();
          const top = document.elementFromPoint(tr.left + tr.width / 2, tr.top + tr.height / 2);
          out.push({ group: g.dataset.group, text: label.textContent, gap: Math.round(lr.top - hr.bottom), covered: !(top && h.contains(top)), cut: label.scrollWidth > label.clientWidth + 1 || tr.right > hr.right + 1 || tr.left < hr.left - 1 });
        }
        return out; })()`)) as { group: string; text: string; gap: number; covered: boolean; cut: boolean }[];
      for (const g of rail.filter((x) => x.gap < 1000)) if (g.covered === false || g.cut === false) continue;
      const bad = rail.filter((g) => g.cut || (g.covered && g.gap > -999 && false));
      check(rail.length >= 1 && bad.length === 0, `${w}: a rail heading is cut off (${JSON.stringify(bad)})`);
      const covered = await page.evaluate(
        `(() => [...document.querySelectorAll('.admin-pick-group')].filter((g) => { const l = g.querySelector('.admin-pick-head .dc-text span').getBoundingClientRect(); const r = g.querySelector('.admin-pick-list').getBoundingClientRect(); const rail = document.querySelector('.wb-roles').getBoundingClientRect(); return l.bottom > r.top + 1 && l.top >= rail.top && l.bottom <= rail.bottom; }).map((g) => g.dataset.group))()`,
      );
      check((covered as string[]).length === 0, `${w}: the rail's list overlaps a heading (${covered})`);

      // 发布: one solid primary, the reason beside it
      await tab('发布').click();
      await wait();
      const primaries = await page.$$eval('#admin-characters .admin-primary', (n: HTMLElement[]) =>
        n.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent),
      );
      check(
        primaries.length === 1 && primaries[0] === '确认发布此版本',
        `${w}: 发布 has one solid button (${JSON.stringify(primaries)})`,
      );
      const row = (await page.evaluate(
        `(() => { const b = [...document.querySelectorAll('#admin-characters .admin-primary')].find((x) => x.getBoundingClientRect().width > 0).getBoundingClientRect(); const r = document.querySelector('.wb-reason').getBoundingClientRect(); return { sameRow: Math.abs((b.top + b.bottom) / 2 - (r.top + r.bottom) / 2) < 14, right: r.left >= b.right - 1, text: document.querySelector('.wb-reason').textContent }; })()`,
      )) as { sameRow: boolean; right: boolean; text: string };
      check(
        row.sameRow && row.right && row.text.length > 0,
        `${w}: while 发布 is disabled its reason sits beside it (${JSON.stringify(row)})`,
      );
      check(
        (await page
          .locator('#admin-characters .head-status ~ .admin-primary, .page-head .admin-primary:visible')
          .count()) === 0,
        `${w}: no second primary in the title row on 发布`,
      );
      await shot('r2-publish');

      // one set of row controls on every list, with Alt+↑/↓ and a live announcement
      await open(`characters/${people.lqy}`);
      const rowKinds: [string, string, string][] = [
        ['欢迎内容', '.wl-row', '欢迎内容'],
        ['说话方式', '.sl-row', '说话方式'],
        ['说话方式', '.cn-pair', '说话方式'],
        ['经历', '.cn-card', '经历'],
        ['其余设定', '.cn-fact', '其余设定'],
        ['身份与展示', '.pl-row', '身份与展示'],
      ];
      for (const [tabName, selector] of rowKinds.map(([a, b]) => [a, b] as const)) {
        await tab(tabName).click();
        await wait(350);
        const info = await page.$$eval(
          selector,
          (n: Element[], sel: string) =>
            n.map((r) => ({
              handles: r.querySelectorAll('.ad-handle').length,
              removes: r.querySelectorAll('.ad-remove').length,
              drag: r.hasAttribute('data-drag-row'),
            })),
          selector,
        );
        check(
          info.length > 0 &&
            info.every(
              (x: { handles: number; removes: number; drag: boolean }) => x.handles === 1 && x.removes === 1 && x.drag,
            ),
          `${w}: ${selector} rows have one handle and one × (${JSON.stringify(info.slice(0, 2))})`,
        );
      }
      await tab('说话方式').click();
      await wait(350);
      const firstBefore = await page.locator('.sl-row textarea').first().inputValue();
      await page.locator('.sl-row .ad-handle').first().focus();
      await page.keyboard.press('Alt+ArrowDown');
      await wait(400);
      check(
        (await page.locator('.sl-row textarea').nth(1).inputValue()) === firstBefore,
        `${w}: Alt+↓ on the handle moves the row`,
      );
      const said =
        (await page
          .locator('.sl-row')
          .first()
          .locator('xpath=ancestor::*[contains(@class,"sl")][1]')
          .locator('[role=status]')
          .first()
          .textContent()) ?? '';
      check(/移到第 2 位/.test(said), `${w}: the move is announced (${said})`);
      await page.keyboard.press('Alt+ArrowUp');
      await wait(300);
      // 声音: one Fish ID field and 语速 (Part 29)
      await tab('声音').click();
      await wait(400);
      const voiceLabels = await page.$$eval('.wb-card-body label > span:first-child', (n: Element[]) =>
        n.filter((x) => x.getBoundingClientRect().width > 0).map((x) => x.textContent),
      );
      check(
        voiceLabels.includes('Fish 音色 ID') && voiceLabels.includes('语速') && !voiceLabels.includes('音色档案 ID'),
        `${w}: 声音 has the one Fish 音色 ID field and 语速 (${voiceLabels.join('|')})`,
      );
      const fishWidth = await page
        .locator('label:has(> span:text-is("Fish 音色 ID")) input')
        .evaluate((n: HTMLElement) => Math.round(n.getBoundingClientRect().width));
      check(fishWidth < 560, `${w}: the Fish ID is a short field (${fishWidth}px)`);
      await shot('r2-voice');
    }

    // =================== D: 总览, one table ===================
    const today = await (await f.post('stats/players', { range: 7 })).json();
    await page.goto(`${f.origin}/?mode=provider-admin#/overview`);
    await page.reload();
    await page.locator('.ov-days .ot-row').first().waitFor({ timeout: 20_000 });
    await wait(1500);
    check(
      (await page.locator('#admin-overview [aria-label="按角色"], #admin-overview [aria-label="按模型"]').count()) ===
        0,
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
