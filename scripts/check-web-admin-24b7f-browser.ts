import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { importLongContent } from './console-long-content-24b7b.ts';
import { COPY_AUDIT_SOURCE } from './admin-copy-audit-24b7d.ts';

/**
 * Part 24b-7f (offline provider only; nothing reaches a provider). Layout and wording of the admin console, measured in a real
 * browser at 1440×900 and 1280×800 on the long-content fixture of 24b-7b:
 *   A. the role rail: the collapse button, the group label and its count are ONE row in every group; 新建 / 导入 / 首页顺序 are three
 *      icon buttons in ONE row, one height (32), each with an aria-label and the console's hover / focus tip; every avatar is ≥ 32 px,
 *      none overlaps another and each is what a click at its centre hits; at 1440×900 all 15 avatars of 当前阵容 are inside the rail's
 *      visible box with the rail scrolled to the top; at 1280×800 the rail scrolls inside itself and keeps the open character in view.
 *   B. the top spacing: on every 角色工作台 tab (声音 included) the first content element starts the same distance under the tab bar
 *      (within 1 px), for a character that was never published and for one with versions (发布, 版本历史, 预演).
 *   C. 测试对话: the font size of a conversation's lines equals that of the list's cells.
 *   D. the standing no-explanation rule: the copy audit's `sentences` rule (scripts/admin-copy-audit-24b7d.ts) finds nothing on every
 *      page and tab it walks, and every sentence that moved is now the hover tip of the control it explains (the tips are read here).
 *   E. 总览: 聊天人数 × 全部 × 饼图 is off with its reason and a pie that was showing falls back to the line.
 *
 * usage: node scripts/check-web-admin-24b7f-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true, chatReview: true });
const problems: string[] = [];
const check = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};
let failure: unknown = null;
try {
  await importLongContent(f);
  // two archived conversations for 测试对话
  const T = Date.parse('2026-11-20T10:00:00Z');
  const archive = (label: string, code: string, characterId: string, lines: string[], at: number) =>
    lines.forEach((text, i) =>
      f.store.run(
        'INSERT INTO web_review_archive VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        label,
        code,
        characterId,
        i,
        `2026-11-18 21:0${i}`,
        i % 2 ? 'character' : 'player',
        text,
        'ok',
        null,
        0,
        at,
        at + 180 * 86_400_000,
      ),
    );
  archive(
    'JOJO-K7M2',
    'K7M2',
    'jojo',
    ['你好', '在的，今天怎么样？', '今天好吗', '还不错，刚忙完一件事。'],
    T - 2 * 86_400_000,
  );
  archive('JOJO-Q9ZH', 'Q9ZH', 'jojo', ['早安', '早'], T - 5 * 86_400_000);
  const list = await (await f.post('characters/list', {})).json();
  const lqy = list.characters.find((c: { displayName: string }) => c.displayName === '青野').characterId as string;
  const page = await f.context.newPage();
  const errors: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  const go = async (hash: string, ready = '.admin-shell') => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
    await page.reload();
    await page.locator(ready).first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1900);
  };

  for (const size of ['1440x900', '1280x800']) {
    const [w, h] = size.split('x').map(Number);
    await page.setViewportSize({ width: w!, height: h! });
    const at = size;

    // ---------------- A. the role rail ----------------
    await go('characters/jojo', '.wb-tab');
    const rail = await page.evaluate(() => {
      const box = (e: Element) => {
        const r = e.getBoundingClientRect();
        return { l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height, cy: (r.top + r.bottom) / 2 };
      };
      const roster = document.querySelector('.wb-roster') as HTMLElement;
      const roles = document.querySelector('#wb-roles') as HTMLElement;
      roles.scrollTop = 0;
      const heads = [...document.querySelectorAll('.admin-pick-head')].map((head) => {
        const chev = head.querySelector('.dc-chev');
        const label = head.querySelector('.dc-text');
        const count = head.querySelector('b');
        return chev && label && count
          ? {
              chev: box(chev),
              label: box(label),
              count: box(count),
              text: head.textContent,
              clipped: label.scrollWidth > label.clientWidth + 1,
            }
          : null;
      });
      const tools = ['#wb-new', '#wb-import', '#wb-arc'].map((s) => {
        const e = document.querySelector(s) as HTMLElement | null;
        return e
          ? {
              id: s,
              hidden: e.hidden,
              aria: e.getAttribute('aria-label'),
              tip: e.querySelector('.ad-tip')?.textContent ?? null,
              ...box(e),
            }
          : null;
      });
      const live = [...document.querySelectorAll('.admin-pick-group[data-group="live"] .admin-pick')] as HTMLElement[];
      const dots = [...document.querySelectorAll('.admin-pick .admin-pick-dot')].map((d) => box(d));
      // each avatar is what a click at its centre hits (only for those inside the scroller's visible box)
      const rr = roles.getBoundingClientRect();
      const unhit: string[] = [];
      for (const d of document.querySelectorAll('.admin-pick')) {
        const dot = d.querySelector('.admin-pick-dot')!.getBoundingClientRect();
        if (dot.top < rr.top || dot.bottom > rr.bottom) continue;
        const hit = document.elementFromPoint(dot.left + dot.width / 2, dot.top + dot.height / 2);
        if (!hit || hit.closest('.admin-pick') !== d) unhit.push(d.getAttribute('data-character') ?? '?');
      }
      const last = live[live.length - 1]!;
      return {
        roster: box(roster),
        roles: box(roles),
        client: roles.clientHeight,
        scroll: roles.scrollHeight,
        heads,
        tools,
        liveCount: live.length,
        lastDot: box(last.querySelector('.admin-pick-dot')!),
        dots,
        unhit,
      };
    });
    // one row per group heading: chevron | label | count, left to right, one centre line
    check(rail.heads.length >= 2, `${at} rail: ${rail.heads.length} group headings`);
    for (const head of rail.heads) {
      if (!head) {
        check(false, `${at} rail: a heading lacks its chevron, label or count`);
        continue;
      }
      const centres = [head.chev.cy, head.label.cy, head.count.cy];
      check(
        Math.max(...centres) - Math.min(...centres) <= 2,
        `${at} rail: heading 「${head.text}」 is not one row (centres ${centres.map(Math.round).join('/')})`,
      );
      check(
        head.chev.r <= head.label.l + 1 && head.label.r <= head.count.l + 1,
        `${at} rail: heading 「${head.text}」 is not chevron | label | count left to right`,
      );
      check(!head.clipped, `${at} rail: the group label 「${head.text}」 is cut off at rest`);
      check(head.label.w > 8, `${at} rail: the group label is not read at rest (${head.label.w}px)`);
    }
    // three icon buttons in ONE row, one height, named
    const tools = rail.tools.filter((t: { hidden: boolean } | null) => t && !t.hidden) as NonNullable<
      (typeof rail.tools)[number]
    >[];
    check(tools.length === 3, `${at} rail: ${tools.length} tool buttons (3)`);
    if (tools.length === 3) {
      check(
        tools.every((t) => Math.abs(t.t - tools[0]!.t) <= 1 && Math.abs(t.h - 32) <= 1 && Math.abs(t.w - 32) <= 1),
        `${at} rail: the tools are not one row of 32 px squares (${tools.map((t) => `${Math.round(t.t)}:${Math.round(t.w)}×${Math.round(t.h)}`).join(' ')})`,
      );
      check(tools[0]!.r <= tools[1]!.l && tools[1]!.r <= tools[2]!.l, `${at} rail: the tools overlap`);
      check(
        tools.every((t) => t.l >= rail.roster.l && t.r <= rail.roster.r && t.b <= rail.roster.b + 1),
        `${at} rail: a tool is outside the rail`,
      );
      check(
        tools.every((t) => (t.aria ?? '').length >= 2),
        `${at} rail: a tool has no aria-label (${tools.map((t) => t.aria).join('|')})`,
      );
      // hover and focus show the console's tip with the same name
      for (const id of ['#wb-new', '#wb-import', '#wb-arc']) {
        const button = page.locator(id);
        const name = (await button.getAttribute('aria-label')) ?? '';
        await page.mouse.move(900, 500);
        await button.hover();
        await page.waitForTimeout(250);
        const tipNode = button.locator('.ad-tip');
        if ((await tipNode.count()) === 0) {
          check(false, `${at} rail: ${id} has no hover tip`);
          continue;
        }
        const shown = await tipNode.evaluate((e: HTMLElement) => ({
          display: getComputedStyle(e).display,
          text: e.textContent,
          inside: (() => {
            const r = e.getBoundingClientRect();
            return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
          })(),
        }));
        check(
          shown.display !== 'none' && shown.text === name && shown.inside,
          `${at} rail: ${id} hover tip is ${JSON.stringify(shown)}`,
        );
        await page.mouse.move(900, 500);
        await button.focus();
        await page.waitForTimeout(250);
        const focused = await tipNode.evaluate((e: HTMLElement) => getComputedStyle(e).display);
        check(focused !== 'none', `${at} rail: ${id} focus shows no tip`);
        await page.mouse.move(900, 500);
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      }
    }
    // avatars: ≥ 32 px, none overlapping, each what a click hits
    check(
      rail.dots.every((d: { w: number; h: number }) => d.w >= 32 && d.h >= 32),
      `${at} rail: an avatar is smaller than 32 px`,
    );
    const sorted = [...rail.dots].sort((a, b) => a.t - b.t);
    check(
      sorted.every((d, i) => i === 0 || d.t >= sorted[i - 1]!.b - 0.5),
      `${at} rail: two avatars overlap`,
    );
    check(rail.unhit.length === 0, `${at} rail: a click at the centre of ${rail.unhit.join(', ')} hits something else`);
    check(rail.liveCount === 15, `${at} rail: ${rail.liveCount} characters in 当前阵容 (15)`);
    if (w === 1440) {
      // the 15th avatar is wholly inside the rail's visible box with the rail scrolled to the top
      check(
        rail.lastDot.t >= rail.roles.t - 0.5 && rail.lastDot.b <= rail.roles.b + 0.5 && rail.lastDot.b <= rail.roster.b,
        `${at} rail: the 15th avatar (${Math.round(rail.lastDot.t)}–${Math.round(rail.lastDot.b)}) is not inside the visible box (${Math.round(rail.roles.t)}–${Math.round(rail.roles.b)})`,
      );
      check(rail.roster.b <= h!, `${at} rail: the rail ends at ${Math.round(rail.roster.b)}, below the window`);
    } else {
      check(
        rail.scroll > rail.client,
        `${at} rail: the rail does not scroll inside itself (${rail.scroll} ≤ ${rail.client})`,
      );
      // the open character stays in view: open the last one of 当前阵容
      await go('characters/c15', '.wb-tab');
      const inView = await page.evaluate(() => {
        const open = document.querySelector('.admin-pick[aria-current="true"]');
        const roles = document.querySelector('#wb-roles')!.getBoundingClientRect();
        const o = open?.getBoundingClientRect();
        return !!o && o.top >= roles.top - 1 && o.bottom <= roles.bottom + 1;
      });
      check(inView, `${at} rail: the open character is not in view in the scrolled rail`);
    }
    if (shots) {
      await go('characters/jojo', '.wb-tab');
      await page.locator('#wb-roles').evaluate((e: HTMLElement) => (e.scrollTop = 0));
      await page.screenshot({ path: `${shots}/${size}-rail.png` });
    }

    // ---------------- B. the top spacing of every tab ----------------
    const offsets = async (id: string) => {
      await go(`characters/${id}`, '.wb-tab');
      const tabs = (await page.$$eval('.wb-tab', (n: Element[]) =>
        n.map((x) => x.querySelector('span')!.textContent),
      )) as string[];
      const out: Record<string, number | null> = {};
      for (const t of tabs) {
        await page.locator(`button.wb-tab:has(span:text-is("${t}"))`).first().click();
        await page.waitForTimeout(700);
        out[t as string] = await page.evaluate(() => {
          const barBottom = document.querySelector('.wb-bar')!.getBoundingClientRect().bottom;
          const body = document.querySelector('.wb-card-body')!;
          const shown = (e: Element) => {
            const r = e.getBoundingClientRect();
            return (
              r.height > 0 &&
              r.width > 0 &&
              !e.closest('[hidden], .ad-tip') &&
              getComputedStyle(e).visibility !== 'hidden'
            );
          };
          const first = (el: Element): Element | null => {
            for (const c of el.children) {
              if (c.tagName === 'LEGEND') continue;
              if (!shown(c)) {
                const deeper = first(c);
                if (deeper) return deeper;
                continue;
              }
              if (['FORM', 'SECTION', 'FIELDSET'].includes(c.tagName)) {
                const deeper = first(c);
                if (deeper) return deeper;
              }
              return c;
            }
            return null;
          };
          const node = first(body);
          return node ? Math.round((node.getBoundingClientRect().top - barBottom) * 10) / 10 : null;
        });
      }
      return out;
    };
    for (const [who, id] of [
      ['jojo (versions)', 'jojo'],
      ['青野 (never published)', lqy],
    ] as const) {
      const o = await offsets(id);
      // the wider rail does not push the tabs onto a second row
      const tabTops = (await page.$$eval('.wb-tab', (n: Element[]) =>
        n.map((x) => Math.round(x.getBoundingClientRect().top)),
      )) as number[];
      check(
        Math.max(...tabTops) - Math.min(...tabTops) <= 1,
        `${at} tabs ${who}: the ${tabTops.length} tabs wrap onto more than one row (${[...new Set(tabTops)].join('/')})`,
      );
      const values = Object.values(o);
      check(
        values.every((v) => v !== null),
        `${at} tabs ${who}: a tab has no content: ${JSON.stringify(o)}`,
      );
      const nums = values.filter((v): v is number => v !== null);
      check(
        Math.max(...nums) - Math.min(...nums) <= 1,
        `${at} tabs ${who}: the first content is not the same distance under the bar on every tab: ${JSON.stringify(o)}`,
      );
      for (const t of ['发布', '版本历史', '预演'])
        if (t in o)
          check(Math.abs((o[t] ?? 999) - 24) <= 1, `${at} tabs ${who}: ${t} starts ${o[t]} px under the bar (24)`);
      if (who.startsWith('jojo')) check('版本历史' in o, `${at} tabs ${who}: the fixture has no 版本历史 tab`);
    }
    if (shots) {
      await go('characters/jojo', '.wb-tab');
      for (const t of ['发布', '版本历史', '预演']) {
        await page.locator(`button.wb-tab:has(span:text-is("${t}"))`).first().click();
        await page.waitForTimeout(700);
        await page.screenshot({ path: `${shots}/${size}-tab-${t}.png` });
      }
    }

    // ---------------- C. 测试对话 ----------------
    await go('conversations', '.review-list');
    await page.locator('.review-list .admin-table tbody tr').first().waitFor({ timeout: 15_000 });
    const listSize = await page.evaluate(
      () => getComputedStyle(document.querySelector('.review-list .admin-table tbody td')!).fontSize,
    );
    await page.locator('.review-list .admin-table tbody tr').first().click();
    await page.locator('.review-detail .review-lines').waitFor({ timeout: 10_000 });
    await page.waitForTimeout(400);
    const lines = await page.$$eval('.review-detail .review-text', (n: Element[]) =>
      n.map((e) => getComputedStyle(e).fontSize),
    );
    check(lines.length >= 2, `${at} 测试对话: ${lines.length} message lines`);
    check(
      lines.every((s: string) => s === listSize),
      `${at} 测试对话: the message text is ${[...new Set(lines)].join('/')} and the list is ${listSize}`,
    );
    if (shots) await page.screenshot({ path: `${shots}/${size}-conversations-open.png` });

    // ---------------- D. what moved is now a hover tip ----------------
    const tipOf = async (selector: string) =>
      page.evaluate((s: string) => {
        const e = document.querySelector(s);
        const tip = e?.querySelector(':scope > .ad-tip, .ad-tip');
        return tip ? (tip.textContent ?? '') : null;
      }, selector);
    await go('conversations', '.review-list');
    check(
      ((await tipOf('.review-list .admin-bar-title')) ?? '').includes('只显示匿名编号'),
      `${at}: 测试对话's privacy sentence is not the title's tip`,
    );
    check(
      (await page.locator('.review-list > p.admin-hint').count()) === 0,
      `${at}: 测试对话 still has its explanatory line`,
    );
    await go('models');
    check(
      ((await tipOf('.models-review-head h3')) ?? '').includes('只影响此后发送的消息'),
      `${at}: 审核模型's sentence is not the heading's tip`,
    );
    await go('points');
    const pointsTips = await page.$$eval('.pt-head h3, .pt-cc > h3', (n: Element[]) =>
      n.map((e) => `${e.firstChild?.textContent}|${e.querySelector('.ad-tip')?.textContent ?? ''}`),
    );
    check(
      pointsTips.some((x: string) => x.startsWith('重置全部额度|') && x.includes('不超过上限')) &&
        pointsTips.some((x: string) => x.startsWith('共创积分|') && x.includes('写给制作组的留言不算')),
      `${at}: 积分发放's sentences are not the headings' tips: ${pointsTips.join(' ; ')}`,
    );
    await go('characters/jojo', '.wb-tab');
    const avatarTip = await page.evaluate(() => {
      const button = document.querySelector('.av-pick');
      const tip = button?.closest('.av-pick-wrap')?.querySelector('.ad-tip');
      return {
        text: tip?.textContent ?? null,
        described: !!button?.getAttribute('aria-describedby'),
        line: document.querySelectorAll('.av-note, .av-hint').length,
      };
    });
    check(
      (avatarTip.text ?? '').includes('不超过 2 MB') && avatarTip.described && avatarTip.line === 0,
      `${at}: the avatar limits are not the button's tip: ${JSON.stringify(avatarTip)}`,
    );
    await go('cast');
    await page
      .locator('.cs-card-open')
      .first()
      .click({ timeout: 5000 })
      .catch(() => {});
    await page.waitForTimeout(800);
    const castTips = await page.$$eval('.cs-items-label.has-tip .ad-tip, .cs-card-head h2 .ad-tip', (n: Element[]) =>
      n.map((e) => e.textContent ?? ''),
    );
    check(
      castTips.some((x: string) => x.includes('别的角色只知道这些') || x.includes('怎么叫')),
      `${at}: 关系与故事's hints are not hover tips: ${castTips.join(' ; ')}`,
    );

    // ---------------- E. 总览: no pie for 聊天人数 ----------------
    await go('overview');
    const press = async (group: string, label: string) => {
      await page
        .locator(`#admin-overview [aria-label="${group}"] button`, { hasText: new RegExp(`^${label}$`) })
        .first()
        .click();
      await page.waitForTimeout(450);
    };
    const pie = page.locator('#admin-overview [aria-label="图表类型"] button', { hasText: /^饼图$/ }).first();
    await press('时间范围', '30天');
    await press('指标', '回复');
    await press('分组', '全部');
    await press('图表类型', '饼图');
    check(!(await pie.isDisabled()), `${at} 总览: the 回复 × 全部 pie is off`);
    await press('指标', '聊天人数');
    check(
      (await pie.isDisabled()) && ((await pie.getAttribute('title')) ?? '').includes('不能相加成占比'),
      `${at} 总览: 聊天人数 × 全部 × 饼图 is not off with its reason`,
    );
    check(
      (await page
        .locator('#admin-overview [aria-label="图表类型"] button', { hasText: /^折线$/ })
        .first()
        .getAttribute('aria-pressed')) === 'true',
      `${at} 总览: the pie did not fall back to 折线`,
    );
    await press('指标', '活跃');
    check(!(await pie.isDisabled()), `${at} 总览: 活跃 lost its pie`);

    // ---------------- D'. the copy audit's `sentences` rule, on the pages this check has open ----------------
    for (const [name, hash] of [
      ['测试对话', 'conversations'],
      ['模型与价格', 'models'],
      ['积分发放', 'points'],
      ['系统状态', 'system'],
      ['我的账号', 'account'],
      ['关系与故事', 'cast'],
      ['角色工作台', 'characters/jojo'],
    ] as const) {
      await go(hash, hash.startsWith('characters') ? '.wb-tab' : '.admin-shell');
      const found = (await page.evaluate(COPY_AUDIT_SOURCE)) as { out: { sentences: string[] } };
      check(
        found.out.sentences.length === 0,
        `${at} ${name}: explanatory text: ${found.out.sentences.slice(0, 3).join(' | ')}`,
      );
    }
  }
  if (errors.length) problems.push(...errors);
} catch (error) {
  failure = error;
} finally {
  for (const p of problems.slice(0, 200)) console.log(' -', p);
  await f.close?.();
}
if (failure) throw failure;
if (problems.length) {
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log('admin 24b-7f rail, tab spacing, 测试对话 size, hover tips, 总览 pie: ok');
process.exit(0);
