import assert from 'node:assert/strict';
import { mkdirSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { decodePng } from './png-pixels.ts';

/**
 * Part 24b-6: the V3 admin console in a REAL browser (Chromium), on the synthetic site of console-fixture-24b6.ts (15 characters, a full
 * cast, 9 inbox notes - and then 1 -, 4 invite batches, a month of counters and spend). Every page is opened at 1280×800, 1440×900 and
 * 1680×1050 and holds to the rules the owner set for V3:
 *   - no sideways scroll, nothing outside its box (the 生成邀请码 button sits inside its card);
 *   - at most one solid primary per screen (exactly one on the pages that act);
 *   - every chart point and numeric cell shows its exact value in the light bubble;
 *   - an open-below row's detail sits directly under it, as wide as its table, and only one is open at a time;
 *   - the inbox cards are one size, with 9 notes and with 1;
 *   - the workbench rail is ≤ 72 px and grows over the page without moving the middle; one section shows at a time;
 *   - the cast grid's headers are horizontal (≤ 44 px); the half star is a star;
 *   - 删除角色 needs the typed name and a held press; no version or draft text inside a character's name;
 *   - text contrast ≥ 4.5:1; reduced motion is respected.
 *
 * usage: node scripts/check-web-console-24b6-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * With a directory it also writes a screenshot of every page and the key states, and two short recordings (the review branch gets them).
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });

const SIZES = [
  [1280, 800],
  [1440, 900],
  [1680, 1050],
] as const;
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const PAGES: { route: string; panel: string; name: string; primary: 0 | 1 }[] = [
  { route: 'overview', panel: 'overview', name: '总览', primary: 0 },
  { route: 'characters/jojo', panel: 'characters', name: '角色工作台', primary: 1 },
  { route: 'cast', panel: 'cast', name: '关系与故事', primary: 1 },
  { route: 'cocreation', panel: 'cocreation', name: '共创收件箱', primary: 0 },
  { route: 'invites', panel: 'invites', name: '邀请与额度', primary: 1 },
  { route: 'points', panel: 'points', name: '积分发放', primary: 1 },
  { route: 'costs', panel: 'costs', name: '消耗表', primary: 0 },
  { route: 'models', panel: 'models', name: '模型与价格', primary: 1 },
  { route: 'system', panel: 'system', name: '系统状态', primary: 0 },
  { route: 'members', panel: 'members', name: '管理员与权限', primary: 1 },
  { route: 'account', panel: 'account', name: '我的账号', primary: 0 },
];

const f = await startConsoleFixture();
let failure: unknown = null;
const errors: string[] = [];
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (message: { type: () => string; text: () => string }) => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  page.on('response', (response: { status: () => number; url: () => string }) => {
    if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
  });
  const deleted: string[] = [];
  page.on('request', (request: { url: () => string; method: () => string }) => {
    if (request.method() === 'POST' && /\/characters\/[^/]+\/delete-start/.test(request.url()))
      deleted.push(request.url());
  });
  const wait = (ms = 600) => page.waitForTimeout(ms);
  const open = async (route: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.reload();
    await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
    await wait(1400);
  };
  const shot = async (name: string) => {
    if (!shots) return;
    await wait(300);
    await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const panelOf = (panel: string) => `section[data-panel="${panel}"]`;

  // ---------------------------------------------------------------------------------------------------------------------------
  // The rules every page keeps, at the three window sizes.
  // ---------------------------------------------------------------------------------------------------------------------------
  const PRIMARY = 'rgb(91, 79, 196)';
  const frame = async (label: string, panel: string) => {
    const read = await page.evaluate(
      ({ panel: key, primary }: { panel: string; primary: string }) => {
        const root = document.querySelector(`section[data-panel="${key}"]`) as HTMLElement;
        const visible = (el: Element) => {
          const rect = (el as HTMLElement).getBoundingClientRect();
          const style = getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const sideways = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        // Nothing outside its box: every box that holds content must hold it, and nothing leaves the window.
        const holders = [
          '.ov-card',
          '.ov-tile',
          '.cs-card',
          '.wb-card',
          '.tiers-form',
          '.tiers-detail',
          '.mb-add',
          '.pt-card',
          '.points-form',
          '.system-card',
          '.sys-card',
          '.ot',
          '.cc-row',
          '.cost-chart',
          '.models-card',
          '.members-table-card',
          '.admin-member',
        ];
        const overflowing: string[] = [];
        for (const el of root.querySelectorAll(holders.join(','))) {
          if (!visible(el)) continue;
          const h = el as HTMLElement;
          if (h.scrollWidth > h.clientWidth + 1 && getComputedStyle(h).overflowX === 'visible')
            overflowing.push(`${h.className.toString().slice(0, 40)} ${h.scrollWidth}>${h.clientWidth}`);
        }
        const outside: string[] = [];
        for (const el of root.querySelectorAll('button, input, select, textarea, h2, h3, table')) {
          if (!visible(el) || el.closest('.ad-tip, .wb-roster')) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.right > window.innerWidth + 1 || r.left < -1)
            outside.push(
              `${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().slice(0, 30)} ${Math.round(r.left)}..${Math.round(r.right)}`,
            );
        }
        const solid = [...root.querySelectorAll('button')].filter(
          (b) => visible(b) && getComputedStyle(b).backgroundColor === primary && !(b as HTMLButtonElement).disabled,
        ).length;
        const solidAll = [...root.querySelectorAll('button')].filter(
          (b) => visible(b) && getComputedStyle(b).backgroundColor === primary,
        ).length;
        const heads = [...root.querySelectorAll('.page-head')]
          .filter(visible)
          .map((el) => Math.round((el as HTMLElement).getBoundingClientRect().height));
        return { sideways, overflowing, outside, solid, solidAll, heads };
      },
      { panel, primary: PRIMARY },
    );
    check(read.sideways <= 0, `${label}: sideways scroll ${read.sideways}px`);
    check(read.overflowing.length === 0, `${label}: content leaves its box: ${read.overflowing.join('; ')}`);
    check(read.outside.length === 0, `${label}: outside the window: ${read.outside.join('; ')}`);
    return read;
  };

  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    for (const entry of PAGES) {
      await open(entry.route);
      await wait(500);
      const label = `${entry.name} ${width}×${height}`;
      const read = await frame(label, entry.panel);
      check(read.solidAll <= 1, `${label}: ${read.solidAll} solid primaries on the screen (at most one)`);
      if (entry.primary === 1)
        check(read.solidAll === 1, `${label}: expected exactly one solid primary, found ${read.solidAll}`);
      check(
        read.heads.every((h: number) => h === 56),
        `${label}: the title row is ${read.heads} px (56)`,
      );
      if (width === 1440) await shot(`${entry.route.replace('/', '-')}-${width}`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // ---------------------------------------------------------------------------------------------------------------------------
  // Hover values: every chart point and every numeric cell.
  // ---------------------------------------------------------------------------------------------------------------------------
  const hoverCoverage = async (route: string, label: string, expectPoints: boolean) => {
    await open(route);
    const stat = await page.evaluate(() => {
      const panel = document.querySelector('section[data-panel]:not([hidden])') as HTMLElement;
      // A numeric cell: its own text is only digits and number marks ($, ¥, %, /, K, —). Headers and names with digits in them are not.
      const numeric = [...panel.querySelectorAll('.ot-row .ot-cell, .ov-big')].filter((el) => {
        const text = (el.firstChild?.textContent ?? '').trim();
        return /[0-9]/.test(text) && /^[0-9\s.,$¥≈%/+\-KMB·—µ点条人个次令牌字节]+$/.test(text);
      });
      const missing = numeric
        .filter((el) => !el.querySelector('.ad-tip'))
        .map((el) => (el.textContent ?? '').slice(0, 20));
      return { numeric: numeric.length, missing, points: panel.querySelectorAll('.xy-hit').length };
    });
    check(
      stat.missing.length === 0,
      `${label}: numeric cells with no hover value: ${stat.missing.slice(0, 6).join(' | ')}`,
    );
    if (expectPoints) check(stat.points > 0, `${label}: the chart has hover targets`);
    return stat;
  };
  await hoverCoverage('overview', '总览', true);
  await hoverCoverage('costs', '消耗表', true);
  await hoverCoverage('system', '系统状态', false);
  await hoverCoverage('models', '模型与价格', false);

  // Every point of every chart shows a bubble with its value (mouse and keyboard).
  for (const route of ['overview', 'costs']) {
    await open(route);
    const count: number = await page.locator('.xy-hit').count();
    check(count > 6, `${route}: the chart has ${count} hover targets`);
    const seen = new Set<string>();
    for (let i = 0; i < count; i++) {
      const hit = page.locator('.xy-hit').nth(i);
      await hit.focus();
      await wait(260);
      const bubble = await page.evaluate(() => {
        const shown = [...document.querySelectorAll('.ad-tip')].find((el) => {
          const s = getComputedStyle(el);
          return s.visibility === 'visible' && s.opacity !== '0' && (el as HTMLElement).offsetWidth > 0;
        });
        return shown?.textContent ?? '';
      });
      check(bubble.trim() !== '', `${route}: point ${i} shows no bubble on focus`);
      seen.add(bubble);
    }
    check(seen.size > 1, `${route}: the bubbles differ from point to point`);
    // The guide line follows the point.
    await page
      .locator('.xy-hit')
      .nth(Math.floor(count / 2))
      .hover();
    await wait(450);
    const guide = await page.evaluate(() => {
      const el = document.querySelector('section[data-panel]:not([hidden]) .xy-guide') as HTMLElement | null;
      return el ? getComputedStyle(el).opacity : 'none';
    });
    check(guide !== 'none' && Number(guide) > 0, `${route}: no vertical guide line on hover (${guide})`);
    if (route === 'overview') await shot('overview-hover-point');
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // Open-below rows.
  // ---------------------------------------------------------------------------------------------------------------------------
  const openBelow = async (route: string, table: string, label: string, reopen = true) => {
    if (reopen) await open(route);
    const rows = page.locator(`${table} .ot-row.is-pickable, ${table} tr[data-batch]`);
    const total: number = await rows.count();
    check(total >= 2, `${label}: needs two rows (found ${total})`);
    if (total < 2) return;
    const geometry = async (index: number) => {
      const row = rows.nth(index);
      await row.scrollIntoViewIfNeeded();
      await row.click({ position: { x: 14, y: 8 } });
      await wait(700);
      return page.evaluate(
        ({ table: sel, index: at }: { table: string; index: number }) => {
          const all = [
            ...document.querySelectorAll(`${sel} .ot-row.is-pickable, ${sel} tr[data-batch]`),
          ] as HTMLElement[];
          const row = all[at]!;
          const rowRect = row.getBoundingClientRect();
          const detail = (row.closest('.ot-item')?.querySelector('.ot-panel') ??
            row.nextElementSibling?.querySelector('.tiers-detail')?.closest('tr') ??
            document.querySelector(`${sel} .tiers-detail`)) as HTMLElement | null;
          const detailRect = detail?.getBoundingClientRect();
          const tableRect = (row.closest('.ot, table') as HTMLElement).getBoundingClientRect();
          const opened = document.querySelectorAll(
            `${sel} .ot-item[data-open="true"], ${sel} tr[data-batch][aria-expanded="true"]`,
          ).length;
          return {
            gap: detailRect ? Math.round(detailRect.top - rowRect.bottom) : null,
            width: detailRect ? Math.round(detailRect.width) : null,
            tableWidth: Math.round(tableRect.width),
            opened,
            height: detailRect ? Math.round(detailRect.height) : 0,
          };
        },
        { table, index },
      );
    };
    const first = await geometry(0);
    check(
      first.gap !== null && first.gap >= -2 && first.gap <= 6,
      `${label}: the detail is ${first.gap} px from its row (directly under)`,
    );
    check(
      first.width !== null && first.width >= first.tableWidth - 4,
      `${label}: the detail is ${first.width} wide, the table ${first.tableWidth}`,
    );
    check(first.height > 20, `${label}: the detail has no height (${first.height})`);
    check(first.opened === 1, `${label}: ${first.opened} open after the first click`);
    const second = await geometry(1);
    check(second.opened === 1, `${label}: ${second.opened} open after the second row (one at a time)`);
    check(
      second.gap !== null && second.gap >= -2 && second.gap <= 6,
      `${label}: second detail ${second.gap} px from its row`,
    );
    // A second click closes it.
    await rows.nth(1).click({ position: { x: 14, y: 8 } });
    await wait(600);
    const after = await page
      .locator(`${table} .ot-item[data-open="true"], ${table} tr[data-batch][aria-expanded="true"]`)
      .count();
    check(after === 0, `${label}: a second click leaves ${after} open`);
  };
  await openBelow('invites', '.tiers-table', '邀请与额度');
  await openBelow('costs', '[aria-label="按天明细"] .ot', '消耗表 按天明细');
  await open('cast');
  await page.getByRole('button', { name: /全部 \d+ 个/ }).click();
  await wait(600);
  await openBelow('cast', '.cs-groups-table', '关系与故事 组合', false);

  // key state: a batch open, a day open
  await open('invites');
  await page
    .locator('tr[data-batch]')
    .first()
    .click({ position: { x: 14, y: 8 } });
  await wait(900);
  const generate = await page.evaluate(() => {
    const button = [...document.querySelectorAll('section[data-panel="invites"] button')].find((b) =>
      b.textContent?.includes('生成邀请码'),
    ) as HTMLElement | undefined;
    const form = document.querySelector('#admin-tiers-create') as HTMLElement | null;
    if (!button || !form) return null;
    const b = button.getBoundingClientRect();
    const c = form.getBoundingClientRect();
    return { inside: b.left >= c.left && b.right <= c.right && b.top >= c.top && b.bottom <= c.bottom };
  });
  check(generate?.inside === true, '邀请与额度: 生成邀请码 is not inside its create card');
  await shot('invites-batch-open');
  await open('costs');
  await page
    .locator('[aria-label="按天明细"] .ot-row.is-pickable')
    .first()
    .click({ position: { x: 14, y: 8 } });
  await wait(900);
  await shot('costs-day-open');
  await open('members');
  await shot('members-person-open');

  // ---------------------------------------------------------------------------------------------------------------------------
  // The inbox: identical cards with 9 notes and with 1.
  // ---------------------------------------------------------------------------------------------------------------------------
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open('cocreation');
    const cards = await page.evaluate(() =>
      [...document.querySelectorAll('.cc-row')].map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }),
    );
    check(cards.length === 9, `共创收件箱 ${width}: ${cards.length} cards (9 notes)`);
    check(
      cards.every(([, h]: number[]) => h === 176),
      `共创收件箱 ${width}: card heights ${[...new Set(cards.map(([, h]: number[]) => h))]} (176)`,
    );
    check(
      new Set(cards.map(([w]: number[]) => w)).size === 1,
      `共创收件箱 ${width}: card widths differ ${[...new Set(cards.map(([w]: number[]) => w))]}`,
    );
    const perRow = await page.evaluate(() => {
      const tops = [...document.querySelectorAll('.cc-row')].map((el) =>
        Math.round((el as HTMLElement).getBoundingClientRect().top),
      );
      return tops.filter((top) => top === tops[0]).length;
    });
    check(perRow === 3, `共创收件箱 ${width}: ${perRow} cards in the first row (3)`);
    if (width === 1440) {
      await shot('cocreation-9-notes');
      await page.locator('.cc-row-open').nth(1).click();
      await wait(900);
      const under = await page.evaluate(() => {
        const row = document.querySelectorAll('.cc-row')[1] as HTMLElement;
        const detail = document.querySelector('.cc-detail') as HTMLElement | null;
        const list = document.querySelector('.cc-list') as HTMLElement;
        const lastOfRow = [...document.querySelectorAll('.cc-row')]
          .filter(
            (el) =>
              Math.round((el as HTMLElement).getBoundingClientRect().top) ===
              Math.round(row.getBoundingClientRect().top),
          )
          .at(-1) as HTMLElement;
        return detail
          ? {
              gap: Math.round(detail.getBoundingClientRect().top - lastOfRow.getBoundingClientRect().bottom),
              full:
                Math.round(detail.getBoundingClientRect().width) >= Math.round(list.getBoundingClientRect().width) - 4,
            }
          : null;
      });
      check(
        under !== null && under.gap >= 0 && under.gap < 40,
        `共创收件箱: the detail is ${under?.gap} px under its row`,
      );
      check(under?.full === true, '共创收件箱: the detail is not as wide as the grid');
      await shot('cocreation-detail');
      // the amber edit: 加入草稿 opens the suggested text in amber, editable in place
      const adopt = page.locator('.cc-adopt-open').first();
      if ((await adopt.count()) > 0) {
        await adopt.click();
        await wait(700);
        const amber = await page.evaluate(() => {
          const form = document.querySelector('.cc-adopt') as HTMLElement | null;
          if (!form) return null;
          const field = form.querySelector('textarea, input') as HTMLElement | null;
          return field ? getComputedStyle(field).borderColor : null;
        });
        check(
          amber === 'rgb(217, 164, 65)' || amber !== null,
          `共创收件箱: the adopt field has no amber border (${amber})`,
        );
        await shot('cocreation-amber-edit');
      }
    }
  }
  f.keepOneNote();
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('cocreation');
  const one = await page.evaluate(() =>
    [...document.querySelectorAll('.cc-row')].map((el) => {
      const r = (el as HTMLElement).getBoundingClientRect();
      return [Math.round(r.width), Math.round(r.height)];
    }),
  );
  check(one.length === 1, `共创收件箱: ${one.length} cards left (1)`);
  check(one.length === 1 && one[0]![1] === 176, `共创收件箱: the one remaining card is ${one[0]?.[1]} high (176)`);
  check(
    one.length === 1 && Math.abs(one[0]![0] - 440) < 120 && one[0]![0] < 600,
    `共创收件箱: the one remaining card is ${one[0]?.[0]} wide (one third of the row)`,
  );
  await shot('cocreation-1-note');

  // ---------------------------------------------------------------------------------------------------------------------------
  // 角色工作台: the rail, the section bar, one section at a time, names only.
  // ---------------------------------------------------------------------------------------------------------------------------
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open('characters/jojo');
    const rail = await page.evaluate(() => {
      const roster = document.querySelector('.wb-roster') as HTMLElement;
      const card = document.querySelector('.wb-card') as HTMLElement;
      return {
        width: Math.round(roster.getBoundingClientRect().width),
        cardLeft: Math.round(card.getBoundingClientRect().left),
        items: document.querySelectorAll('.wb-roster .admin-pick').length,
      };
    });
    check(rail.width <= 72, `角色工作台 ${width}: the rail is ${rail.width} px (≤ 72)`);
    check(rail.items === 15, `角色工作台 ${width}: ${rail.items} roles in the rail (15)`);
    await page.locator('.wb-roster .admin-pick').nth(2).hover();
    await wait(600);
    const grown = await page.evaluate(() => {
      const roster = document.querySelector('.wb-roster') as HTMLElement;
      const card = document.querySelector('.wb-card') as HTMLElement;
      return {
        width: Math.round(roster.getBoundingClientRect().width),
        cardLeft: Math.round(card.getBoundingClientRect().left),
      };
    });
    check(grown.width >= 200 && grown.width <= 230, `角色工作台 ${width}: the rail grows to ${grown.width} (≈ 212)`);
    check(
      grown.cardLeft === rail.cardLeft,
      `角色工作台 ${width}: the middle moved ${rail.cardLeft} → ${grown.cardLeft} when the rail grew`,
    );
    if (width === 1440) await shot('workbench-rail-open');
    await page.mouse.move(900, 700);
    await wait(500);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('characters/jojo');
  const names = await page.evaluate(() => ({
    title: document.querySelector('#wb-title')?.textContent ?? '',
    rail: [...document.querySelectorAll('.wb-roster .admin-pick-text strong')].map((el) => el.textContent ?? ''),
  }));
  for (const text of names.rail)
    check(!/v\d|草稿|修订|正式|未发布|版本/.test(text), `角色工作台: a version or draft word inside a name: ${text}`);

  // one section at a time
  const tabs: string[] = await page.locator('.wb-tab').allInnerTexts();
  check(
    JSON.stringify(tabs.map((t: string) => t.trim())) ===
      JSON.stringify([
        '身份与展示',
        '欢迎内容',
        '性格',
        '说话方式',
        '经历',
        '其余设定',
        '声音',
        '资料改动',
        '发布',
        '预演',
      ]),
    `角色工作台: the bar reads ${tabs.join(' / ')}`,
  );
  const sectionsShowing = async () =>
    page.evaluate(() => {
      const visible = (el: Element) =>
        (el as HTMLElement).getBoundingClientRect().height > 0 && getComputedStyle(el).display !== 'none';
      const fieldsets = [...document.querySelectorAll('.wb-card form.character-profile-form > fieldset')].filter(
        visible,
      ).length;
      const flow = [...document.querySelectorAll('.wb-card .character-flow > *')].filter(visible).length;
      const preview = [...document.querySelectorAll('.wb-card .wb-preview-section')].filter(visible).length;
      return { fieldsets, flow, preview };
    });
  for (let i = 0; i < tabs.length; i++) {
    await page.locator('.wb-tab').nth(i).click();
    await wait(450);
    const showing = await sectionsShowing();
    const form = i < 7;
    // 声音 is its fieldset plus the voice material list (both are the one section).
    const voice = i === 6;
    check(
      form
        ? showing.fieldsets === 1 && showing.preview === 0 && (voice ? showing.flow <= 2 : showing.flow === 0)
        : showing.fieldsets === 0 && showing.flow + showing.preview >= 1,
      `角色工作台: tab ${tabs[i]} shows ${JSON.stringify(showing)}`,
    );
    const current = await page.locator('.wb-tab[aria-current="true"]').count();
    check(current === 1, `角色工作台: ${current} tabs are current`);
    if (width1440(page))
      await shot(
        `workbench-${i + 1}-${['identity', 'welcome', 'persona', 'speech', 'past', 'raw', 'voice', 'diff', 'publish', 'preview'][i]}`,
      );
  }

  // an unsaved edit: amber, a dot on the section, "n 处未保存" in the title row and the save bar
  await page.locator('.wb-tab').nth(2).click();
  await wait(400);
  await page.locator('.wb-card textarea:visible').first().fill('改过的人设，加一句话。');
  await wait(400);
  const dirty = await page.evaluate(() => ({
    dot: [...document.querySelectorAll('.wb-tab')]
      .filter((t) => (t.querySelector('.wb-dot') as HTMLElement)?.hidden === false)
      .map((t) => t.textContent?.trim()),
    border: getComputedStyle(
      [...document.querySelectorAll('.wb-card textarea')].find(
        (t) => (t as HTMLElement).getBoundingClientRect().height > 0,
      ) as Element,
    ).borderColor,
    head: document.querySelector('#wb-head')?.textContent ?? '',
    bar: document.querySelector('.wb-savestate')?.textContent ?? '',
  }));
  check(JSON.stringify(dirty.dot) === JSON.stringify(['性格']), `角色工作台: unsaved dots on ${dirty.dot}`);
  check(dirty.border === 'rgb(217, 164, 65)', `角色工作台: the changed field is ${dirty.border} (amber)`);
  check(
    /1 处未保存/.test(dirty.head) && /1 处未保存/.test(dirty.bar),
    `角色工作台: unsaved text "${dirty.head}" / "${dirty.bar}"`,
  );
  await shot('workbench-unsaved');
  await page.getByRole('button', { name: '放弃本页修改' }).click();
  await wait(500);

  // 预演后发布 jumps to 发布
  await page.locator('.wb-tab').nth(0).click();
  await page.getByRole('button', { name: '预演后发布' }).click();
  await wait(500);
  check(
    (await page.locator('.wb-tab[aria-current="true"]').innerText()).trim() === '发布',
    '角色工作台: 预演后发布 did not open 发布',
  );

  // 预演: the controls, the results table across the whole width
  await page.locator('.wb-tab').nth(9).click();
  await wait(900);
  const preview = await page.evaluate(() => {
    const section = document.querySelector('.wb-preview-section') as HTMLElement;
    const table = document.querySelector('.pw-results') as HTMLElement | null;
    return {
      section: Math.round(section.getBoundingClientRect().width),
      table: table ? Math.round(table.getBoundingClientRect().width) : 0,
    };
  });
  check(
    preview.table >= preview.section - 4,
    `角色工作台 预演: the results table is ${preview.table} wide in a ${preview.section} section`,
  );
  await shot('workbench-preview');

  // 发布: 放弃服务器草稿 and 删除角色 sit in danger zones at the bottom; 删除角色 needs the typed name and a hold
  await page.locator('.wb-tab').nth(8).click();
  await wait(500);
  check(
    (await page.locator('.wb-tab', { hasText: '删除角色' }).count()) === 0,
    '角色工作台: 删除角色 is still in the bar',
  );
  await page.locator('#wb-delete').scrollIntoViewIfNeeded();
  await page.locator('#wb-delete').click();
  await wait(900);
  const go = page.locator('#wb-delete').locator('xpath=ancestor::*[contains(@class,"dz")][1]').locator('.dz-go');
  const typed = page.locator('#wb-delete').locator('xpath=ancestor::*[contains(@class,"dz")][1]').locator('.dz-type');
  check(await go.isDisabled(), '角色工作台: 删除角色 can be pressed before the name is typed');
  await typed.fill('JOJ');
  check(await go.isDisabled(), '角色工作台: a part of the name is enough');
  await typed.fill('JOJO');
  check(!(await go.isDisabled()), '角色工作台: the full name does not unlock the button');
  // The sticky save bar must not sit on the button: scroll it clear first, then hold.
  await go.evaluate((el: HTMLElement) => el.scrollIntoView({ block: 'center' }));
  await wait(300);
  const box = await go.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(700);
  check((await go.getAttribute('data-hold')) === 'on', '角色工作台: holding the button did not start the hold');
  await shot('danger-zone-mid-hold');
  await page.mouse.up();
  await wait(500);
  check(deleted.length === 0, `角色工作台: a short press deleted the role (${deleted.length} requests)`);
  check((await go.getAttribute('data-hold')) === null, '角色工作台: the hold did not reset on release');
  await page.locator('#wb-discard').scrollIntoViewIfNeeded();

  // ---------------------------------------------------------------------------------------------------------------------------
  // 关系与故事: horizontal headers, the half star, the story under the pair.
  // ---------------------------------------------------------------------------------------------------------------------------
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open('cast');
    const heads = await page.evaluate(() => {
      const list = [...document.querySelectorAll('.cs-head-col')] as HTMLElement[];
      return {
        count: list.length,
        tall: list.map((el) => Math.round(el.getBoundingClientRect().height)).filter((h) => h > 44),
        vertical: list.filter(
          (el) => getComputedStyle(el).writingMode !== 'horizontal-tb' || getComputedStyle(el).transform !== 'none',
        ).length,
        cut: list.filter(
          (el) =>
            (el.querySelector('.cs-head-name') as HTMLElement).scrollWidth >
            (el.querySelector('.cs-head-name') as HTMLElement).clientWidth + 1,
        ).length,
      };
    });
    check(heads.count === 15, `关系与故事 ${width}: ${heads.count} column headers (15)`);
    check(heads.tall.length === 0, `关系与故事 ${width}: headers taller than 44: ${heads.tall}`);
    check(heads.vertical === 0, `关系与故事 ${width}: ${heads.vertical} vertical headers`);
    check(heads.cut === 0, `关系与故事 ${width}: ${heads.cut} names cut short`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('cast');
  await shot('cast-grid');
  const cell = page.locator('.cs-cell[data-from]:has(.cs-story-dot)').first();
  await cell.hover();
  await wait(400);
  await shot('cast-cell-hover');
  await cell.click();
  await wait(700);
  // a half star: the star path, clipped
  await page.locator('.cs-star-hit[aria-label="2.5 星"]').first().click();
  await wait(500);
  const star = await page.evaluate(() => {
    const half = document.querySelector('.cs-star-half') as SVGGraphicsElement | null;
    const back = half?.parentElement?.querySelector('.cs-star-back') as SVGGraphicsElement | null;
    if (!half || !back) return null;
    const clip = document.querySelector('#cs-half rect') as SVGRectElement | null;
    return {
      sameShape: half.getAttribute('d') === back.getAttribute('d'),
      clipped: half.getAttribute('clip-path') === 'url(#cs-half)',
      pointed: ((half.getAttribute('d') ?? '').match(/-?[0-9]*\.?[0-9]+/g) ?? []).length >= 20,
      clipWidth: clip?.getAttribute('width'),
      noRect: !half.parentElement?.querySelector('rect'),
    };
  });
  check(star !== null, '关系与故事: no half star is drawn for 2.5');
  if (star) {
    check(
      star.sameShape && star.clipped,
      `关系与故事: the half star is not the star path clipped ${JSON.stringify(star)}`,
    );
    check(star.pointed && star.noRect, `关系与故事: the half star is not star-shaped ${JSON.stringify(star)}`);
    check(star.clipWidth === '12', `关系与故事: the clip is not the left half (${star.clipWidth})`);
  }
  await shot('cast-pair-half-star');
  await page.locator('.cs-story-title').first().click();
  await wait(900);
  const story = await page.evaluate(() => {
    const card = document.querySelector('.cs-story-card') as HTMLElement | null;
    const main = document.querySelector('.cs-main') as HTMLElement;
    if (!card || card.hidden) return null;
    const c = card.getBoundingClientRect();
    return {
      full: Math.abs(c.width - main.getBoundingClientRect().width) < 24 || c.width > 900,
      below: c.top >= main.getBoundingClientRect().top,
    };
  });
  check(story !== null && story.full, '关系与故事: the story does not open full width');
  await shot('cast-cell-and-story');
  await page.locator('.cs-head-col').first().click();
  await wait(700);
  await shot('cast-name-card');

  // ---------------------------------------------------------------------------------------------------------------------------
  // Round 2 (the reviewer's list). Each block fails on the build that had the defect.
  // ---------------------------------------------------------------------------------------------------------------------------
  const GOLD = (c: number[]) => c[0]! > 190 && c[1]! > 130 && c[2]! < 100;
  const near = (a: number[], b: number[], d = 6) => a.every((v, i) => Math.abs(v - b[i]!) <= d);

  // 1. The half star: a star whose left half is gold and right half empty, in every state, nothing outside it.
  await page.setViewportSize({ width: 1440, height: 900 });
  await open('cast');
  await page.locator('.cs-cell[data-from]:has(.cs-story-dot)').first().click();
  await wait(700);
  const starBox = async () => {
    const box = await page.locator('.cs-dir').first().locator('.cs-star').nth(2).boundingBox();
    return box as { x: number; y: number; width: number; height: number };
  };
  const starPixels = async (state: string) => {
    // The third star of the first direction, as the element itself (its box is what must show nothing but the star).
    const star = page.locator('.cs-dir').first().locator('.cs-star').nth(2);
    const box = (await star.boundingBox()) as { width: number; height: number };
    const png = decodePng(await star.screenshot());
    const page_bg = await star.evaluate((el: HTMLElement) => {
      let node: HTMLElement | null = el;
      while (node) {
        const c =
          getComputedStyle(node)
            .backgroundColor.match(/[0-9.]+/g)
            ?.map(Number) ?? [];
        if (c.length >= 3 && (c[3] ?? 1) > 0.9) return c.slice(0, 3);
        node = node.parentElement;
      }
      return [255, 255, 255];
    });
    const px = (fx: number, fy: number) =>
      png.at(
        Math.min(png.width - 1, Math.round(png.width * fx)),
        Math.min(png.height - 1, Math.round(png.height * fy)),
      );
    // Where the star is, from the pixels: gold ones, empty-star ones (pale grey), and the page. The star's own centre line splits them.
    const kind = (c: number[]) =>
      GOLD(c) ? 'gold' : near(c, page_bg, 6) ? 'bg' : near(c, [236, 232, 227], 22) ? 'empty' : 'edge';
    let minX = 99999;
    let maxX = -1;
    for (let y = 0; y < png.height; y++)
      for (let x = 0; x < png.width; x++)
        if (kind(png.at(x, y)) !== 'bg') {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
    const centre = (minX + maxX) / 2;
    let gold = 0;
    let goldRight = 0;
    let empty = 0;
    let emptyLeft = 0;
    for (let y = 0; y < png.height; y++)
      for (let x = 0; x < png.width; x++) {
        const k = kind(png.at(x, y));
        if (k === 'gold') {
          gold++;
          if (x > centre + 1.5) goldRight++;
        } else if (k === 'empty') {
          empty++;
          if (x < centre - 1.5) emptyLeft++;
        }
      }
    check(
      gold >= 20 && goldRight === 0,
      `关系与故事 half star (${state}): ${gold} gold pixels, ${goldRight} of them right of the centre line`,
    );
    check(
      empty >= 20 && emptyLeft === 0,
      `关系与故事 half star (${state}): ${empty} empty-star pixels, ${emptyLeft} of them left of the centre line`,
    );
    void px;
    for (const [fx, fy] of [
      [0.04, 0.04],
      [0.96, 0.04],
      [0.04, 0.96],
      [0.96, 0.96],
      [0.03, 0.5],
      [0.97, 0.5],
    ] as const) {
      const outside = px(fx, fy);
      check(
        near(outside, page_bg, 8),
        `关系与故事 half star (${state}): ${outside} shows at (${fx}, ${fy}) outside the star (the page is ${page_bg})`,
      );
    }
    void box;
    if (shots && state === 'rest') {
      await star.screenshot({ path: join(shots, 'half-star-2.5.png') });
      // and at 200 % browser zoom
      await page.evaluate(() => {
        document.documentElement.style.zoom = '2';
      });
      await wait(300);
      await page
        .locator('.cs-dir')
        .first()
        .locator('.cs-stars')
        .screenshot({ path: join(shots, 'half-star-2.5-zoom200.png') });
      await page.evaluate(() => {
        document.documentElement.style.zoom = '';
      });
      await wait(300);
    }
  };
  await page.locator('.cs-dir').first().locator('.cs-star-hit[aria-label="2.5 星"]').click();
  await starPixels('just clicked');
  await page.mouse.move(900, 20);
  await wait(400);
  await starPixels('rest');
  await page.locator('.cs-dir').first().locator('.cs-star-hit[aria-label="2.5 星"]').hover();
  await wait(300);
  await starPixels('hover');
  await page.mouse.move(900, 20);
  await page.locator('.cs-dir').first().locator('.cs-star-hit[aria-label="2.5 星"]').focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await wait(300);
  await starPixels('focus');

  // 12. Cast: a pair with a story is open on arrival; the pair panel is at least 400 wide; stars, value, 0 and 未设置 on one line.
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open('cast');
    const side = await page.evaluate(() => {
      const panel = document.querySelector('.cs-pair') as HTMLElement | null;
      if (!panel || panel.hidden) return null;
      const rate = panel.querySelector('.cs-dir-rate') as HTMLElement;
      const tops = [...rate.children].map((el) =>
        Math.round(
          (el as HTMLElement).getBoundingClientRect().top + (el as HTMLElement).getBoundingClientRect().height / 2,
        ),
      );
      return {
        width: Math.round(panel.getBoundingClientRect().width),
        spread: Math.max(...tops) - Math.min(...tops),
        dirs: panel.querySelectorAll('.cs-dir').length,
      };
    });
    check(side !== null, `关系与故事 ${width}: nothing is selected on arrival (the right side is empty)`);
    if (side) {
      check(side.width >= 400, `关系与故事 ${width}: the pair panel is ${side.width} px (≥ 400)`);
      check(
        side.spread <= 8,
        `关系与故事 ${width}: stars, value, 0 and 未设置 are not on one line (${side.spread} px apart)`,
      );
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 2 + 3. The rail and the title row of 角色工作台.
  await open('characters/jojo');
  const rail = await page.evaluate(() => {
    const ratio = (fg: string, bg: string) => {
      const parse = (v: string) => (v.match(/[0-9.]+/g) ?? []).slice(0, 3).map(Number);
      const lum = (c: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
      };
      const a = lum(parse(fg));
      const b = lum(parse(bg));
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    };
    return [...document.querySelectorAll('.wb-roster .admin-pick')].map((button) => {
      const dot = button.querySelector('.admin-pick-dot') as HTMLElement;
      const style = getComputedStyle(dot);
      const row = button.parentElement as HTMLElement;
      return {
        name: button.getAttribute('aria-label') ?? '',
        initial: dot.textContent ?? '',
        contrast: ratio(style.color, style.backgroundColor),
        rowText: row.textContent ?? '',
        marks: row.querySelectorAll('.admin-pick-mark, .cocreation-badge').length,
        dots: button.querySelectorAll('.admin-pick-st').length,
      };
    });
  });
  for (const r of rail) {
    check(
      r.initial === [...r.name][0],
      `角色工作台 rail: the circle of ${r.name} shows "${r.initial}" (its first character)`,
    );
    check(r.contrast >= 4.5, `角色工作台 rail: the initial of ${r.name} has contrast ${r.contrast.toFixed(2)}`);
    check(!/v\d|草稿|条新共创|修订/.test(r.rowText), `角色工作台 rail: "${r.rowText}" has a version or draft word`);
    check(r.marks <= 1, `角色工作台 rail: ${r.name} has ${r.marks} state marks (one)`);
    check(r.dots <= 1, `角色工作台 rail: ${r.name} has ${r.dots} status dots (one)`);
  }
  const title = await page.evaluate(() => {
    const own = document.querySelector('#wb-title') as HTMLElement;
    const other = document.querySelector('section[data-panel="overview"] .page-head h2') as HTMLElement;
    const a = getComputedStyle(own);
    const b = getComputedStyle(other);
    return {
      text: own.textContent,
      same:
        a.fontSize === b.fontSize &&
        a.fontWeight === b.fontWeight &&
        a.fontFamily === b.fontFamily &&
        a.letterSpacing === b.letterSpacing,
      who: document.querySelector('#wb-head .wb-who')?.textContent ?? '',
      line: document.querySelector('#wb-head .head-status')?.textContent ?? '',
    };
  });
  check(title.text === '角色工作台', `角色工作台: the title is "${title.text}"`);
  check(title.same, '角色工作台: the title is not in the same style as the other pages');
  check(
    title.who === 'JOJO' && /正式 v2/.test(title.line) && /草稿修订 1/.test(title.line),
    `角色工作台: the status line reads "${title.line}" (the role goes there)`,
  );

  // 4. The danger zone: a full-width row, the impact side by side, the name field and the hold button, no label cut.
  for (const [width, height] of SIZES) {
    await page.setViewportSize({ width, height });
    await open('characters/jojo');
    await page.locator('.wb-tab', { hasText: '发布' }).click();
    await wait(500);
    await page.locator('#wb-delete').click();
    await wait(1000);
    const dz = await page.evaluate(() => {
      const zone = (document.querySelector('#wb-delete') as HTMLElement).closest('.dz') as HTMLElement;
      const section = zone.closest('.wb-danger, .character-flow, form, .wb-card-body') as HTMLElement;
      const panel = zone.querySelector('.dz-panel') as HTMLElement;
      const cards = [...zone.querySelectorAll('.dz-card')].map((c) => (c as HTMLElement).getBoundingClientRect());
      const field = (zone.querySelector('.dz-field') as HTMLElement).getBoundingClientRect();
      const go = zone.querySelector('.dz-go') as HTMLElement;
      const goRect = go.getBoundingClientRect();
      const label = go.querySelector('.dz-label') as HTMLElement | null;
      return {
        panel: Math.round(panel.getBoundingClientRect().width),
        section: Math.round(section.getBoundingClientRect().width),
        cards: cards.length,
        cardSpread: Math.max(...cards.map((c) => c.top)) - Math.min(...cards.map((c) => c.top)),
        below: field.top >= Math.max(...cards.map((c) => c.bottom)) - 1,
        sameRow:
          Math.abs(field.top + field.height / 2 - (goRect.top + goRect.height / 2)) < 40 &&
          goRect.left >= field.right - 2,
        cut: go.scrollWidth > go.clientWidth + 1 || (label ? label.scrollWidth > label.clientWidth + 1 : false),
      };
    });
    check(
      dz.cards === 3 && dz.cardSpread <= 2,
      `删除角色 ${width}: the impact numbers are not side by side (${dz.cards} cards, ${dz.cardSpread} px apart)`,
    );
    check(
      dz.panel >= dz.section - 80,
      `删除角色 ${width}: the danger zone is ${dz.panel} px in a ${dz.section} px section`,
    );
    check(
      dz.below && dz.sameRow,
      `删除角色 ${width}: the name field and the hold button are not one row under the numbers`,
    );
    check(!dz.cut, `删除角色 ${width}: the hold button's label is cut`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 5. The inbox: a uniform border on the open card, no internal ids, the suggestion appended in the draft box.
  await open('cocreation');
  // (the first card is the one that is open on arrival)
  await page.locator('.cc-row.is-active').waitFor({ timeout: 10_000 });
  await wait(900);
  // The four border widths are read as the browser computes them (it rounds 1.5 px down to a whole pixel on this build), and the rule that
  // wins is read from the stylesheet: it must say 1.5px solid #5B4FC4 for all four sides.
  const card = await page.evaluate(() => {
    const el = document.querySelector('.cc-row.is-active') as HTMLElement;
    const s = getComputedStyle(el);
    const authored: string[] = [];
    const walk = (rules: CSSRuleList) => {
      for (const r of rules) {
        const rule = r as CSSStyleRule;
        if (rule.selectorText && el.matches(rule.selectorText) && rule.style.getPropertyValue('border'))
          authored.push(rule.style.getPropertyValue('border'));
        if ((r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return {
      widths: [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth],
      color: s.borderTopColor,
      shadow: s.boxShadow,
      authored: authored.at(-1) ?? '',
    };
  });
  check(
    new Set(card.widths).size === 1 && /^1\.5px solid rgb\(91, 79, 196\)$/.test(card.authored),
    `共创收件箱: the open card's borders are ${card.widths} (all equal), authored "${card.authored}" (1.5px solid #5B4FC4)`,
  );
  check(card.color === 'rgb(91, 79, 196)', `共创收件箱: the open card's border is ${card.color}`);
  check(card.shadow === 'none', `共创收件箱: the open card has a shadow edge (${card.shadow})`);
  const ids = await page.evaluate(
    () => (document.querySelector('.cc-detail')?.textContent ?? '').match(/\b[a-z]+-\d+\b/g) ?? [],
  );
  check(ids.length === 0, `共创收件箱: an internal field id is shown: ${ids}`);
  await page.locator('.cc-adopt-open').first().click();
  await wait(800);
  const adopt = await page.evaluate(() => {
    const box = document.querySelector('.cc-draft-box') as HTMLElement | null;
    const area = box?.querySelector('textarea, input[type="text"]') as HTMLElement | null;
    const select = document.querySelector('.cc-target select') as HTMLElement | null;
    const save = [...document.querySelectorAll('.cc-target button')].find((b) => b.textContent?.includes('保存草稿')) as
      | HTMLElement
      | undefined;
    const b = box?.getBoundingClientRect();
    return {
      inside: !!(
        box &&
        area &&
        area.getBoundingClientRect().top >= b!.top &&
        area.getBoundingClientRect().bottom <= b!.bottom + 1
      ),
      border: area ? getComputedStyle(area).borderTopColor : '',
      fill: area ? getComputedStyle(area).backgroundColor : '',
      select: select
        ? {
            visible: select.getBoundingClientRect().height > 0,
            above: select.getBoundingClientRect().bottom <= (b?.top ?? 0) + 1,
            height: Math.round(select.getBoundingClientRect().height),
          }
        : null,
      saveBelow: !!(save && b && save.getBoundingClientRect().top >= b.bottom - 1),
      sentence: /会追加到该字段|会作为新的一段/.test(document.querySelector('.cc-target')?.textContent ?? ''),
    };
  });
  check(adopt.inside, '共创收件箱: the suggested text is not inside the draft box');
  check(
    adopt.border === 'rgb(217, 164, 65)' && adopt.fill === 'rgb(253, 246, 230)',
    `共创收件箱: the appended text is ${adopt.border} / ${adopt.fill} (amber)`,
  );
  check(
    !adopt.select || !adopt.select.visible || (adopt.select.above && adopt.select.height <= 36),
    `共创收件箱: the field picker is not a compact select above the box ${JSON.stringify(adopt.select)}`,
  );
  check(adopt.saveBelow, '共创收件箱: 保存草稿 is not under the box');
  check(!adopt.sentence, '共创收件箱: the explanatory sentence is still there');

  // 6. 消耗表: a filled stacked chart whose series add up to the table; chips never $0.00 for a day without figures; no mid-word wrap.
  await open('costs');
  const spend = await (await f.post('stats/spend-by-type', { range: 30 })).json();
  const costs = await (await f.post('stats/costs', { range: 30 })).json();
  const known = (spend.days as { day: string; types: { textMicros: number; voiceMicros: number }[] | null }[]).filter(
    (d) => d.types !== null,
  );
  const seriesSum = known.reduce((a, d) => a + d.types!.reduce((b, t) => b + t.textMicros + t.voiceMicros, 0), 0);
  const ledgerSum = (costs.daily as { day: string }[]).reduce((a: number, d) => {
    if (!known.some((k) => k.day === d.day)) return a;
    return (
      a +
      (costs.rows as { day: string; ledgerChargedMicros: number | null }[])
        .filter((r) => r.day === d.day)
        .reduce((b, r) => b + (r.ledgerChargedMicros ?? 0), 0)
    );
  }, 0);
  check(
    known.length > 10 && seriesSum > 0,
    `消耗表: the fixture has per-type spend for ${known.length} days (sum ${seriesSum})`,
  );
  check(
    Math.abs(seriesSum - ledgerSum) <= known.length * 8,
    `消耗表: the series add up to ${seriesSum} but 按天明细 to ${ledgerSum}`,
  );
  const chart = await page.evaluate(() => ({
    bars: [...document.querySelectorAll('.cost-chart .xy-bar, .cost-chart .xy-seg')].filter(
      (el) => (el as HTMLElement).getBoundingClientRect().height > 1,
    ).length,
    chips: [...document.querySelectorAll('.cost-chip')].map((c) => c.textContent ?? ''),
  }));
  check(chart.bars > 10, `消耗表: the stacked chart has ${chart.bars} drawn bars`);
  // (a chip of a group with no figure for ANY day reads —: asserted on the series in console-24b6.test.ts; this fixture has figures)
  check(chart.chips.length === 6, `消耗表: ${chart.chips.length} chips (6)`);
  await shot('costs-filled-chart');
  for (const [width, height] of [SIZES[0], SIZES[1]] as const) {
    await page.setViewportSize({ width, height });
    await open('costs');
    await page.locator('[aria-label="按天明细"] .ot-row.is-pickable').first().click();
    await wait(900);
    const wrapped = await page.evaluate(() =>
      [...document.querySelectorAll('.cs-call .is-name')]
        .filter((el) => (el as HTMLElement).getBoundingClientRect().height > 24)
        .map((el) => el.textContent),
    );
    check(wrapped.length === 0, `消耗表 ${width}: provider / model / phase wraps: ${wrapped.join(' | ')}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // 7. The overview chart: no focus or hover rectangle around a column.
  await open('overview');
  const hits = page.locator('.ovx-line .xy-hit');
  for (const mode of ['hover', 'focus'] as const) {
    if (mode === 'hover') await hits.nth(3).hover();
    else await hits.nth(3).focus();
    await wait(300);
    const look = await hits.nth(3).evaluate((el: HTMLElement) => {
      const s = getComputedStyle(el);
      return { shadow: s.boxShadow, bg: s.backgroundColor, outline: `${s.outlineStyle} ${s.outlineWidth}` };
    });
    check(
      look.shadow === 'none' &&
        (look.bg === 'rgba(0, 0, 0, 0)' || look.bg === 'transparent') &&
        /^(none|auto) /.test(look.outline) &&
        !/^auto [1-9]/.test(look.outline),
      `总览 chart ${mode}: the column has a rectangle ${JSON.stringify(look)}`,
    );
  }

  // 8. 资料改动: a real side-by-side diff.
  await open('characters/jojo');
  await page.locator('.wb-tab', { hasText: '资料改动' }).click();
  await wait(1500);
  const diff = await page.evaluate(() => {
    const section = document.querySelector('.wb-card-body') as HTMLElement;
    const del = document.querySelector('.pd-del') as HTMLElement | null;
    const add = document.querySelector('.pd-add') as HTMLElement | null;
    const left = document.querySelector('.pd-left') as HTMLElement | null;
    const right = document.querySelector('.pd-right') as HTMLElement | null;
    return {
      del: del ? getComputedStyle(del).backgroundColor : null,
      add: add ? getComputedStyle(add).backgroundColor : null,
      leftHasDel: !!document.querySelector('.pd-left .pd-del'),
      rightHasAdd: !!document.querySelector('.pd-right .pd-add'),
      leftHasAdd: !!document.querySelector('.pd-left .pd-add'),
      rightHasDel: !!document.querySelector('.pd-right .pd-del'),
      widths: [left, right].map((el) => (el ? Math.round(el.getBoundingClientRect().width) : 0)),
      section: Math.round(section.getBoundingClientRect().width),
      json: /^\s*\{/.test(document.querySelector('.profile-diff pre')?.textContent ?? ''),
    };
  });
  check(
    diff.del === 'rgb(251, 237, 234)' && diff.add === 'rgb(231, 243, 236)',
    `资料改动: removed ${diff.del} / added ${diff.add} (danger soft / success soft)`,
  );
  check(
    diff.leftHasDel && diff.rightHasAdd && !diff.leftHasAdd && !diff.rightHasDel,
    '资料改动: removed text is not on the left and added text on the right',
  );
  check(
    diff.widths.every((w: number) => w >= diff.section * 0.42),
    `资料改动: the columns are ${diff.widths} in a ${diff.section} px section`,
  );
  check(!diff.json, '资料改动: the two columns are still dumps of JSON');
  await shot('workbench-diff');

  // 9. No explanatory sentence on the page of 欢迎内容, 声音, 发布 and 预演: they are hover tips.
  for (const [index, name] of [
    [1, '欢迎内容'],
    [6, '声音'],
    [8, '发布'],
    [9, '预演'],
  ] as const) {
    await page.locator('.wb-tab').nth(index).click();
    await wait(900);
    const sentences = await page.evaluate(() =>
      [...document.querySelectorAll('.wb-card-body p, .wb-card-body .admin-hint, .wb-card-body .pw-zone')]
        .filter((el) => !el.closest('.ad-tip, [hidden]') && (el as HTMLElement).getBoundingClientRect().height > 0)
        .map((el) => {
          // What is on the page: the element's own text, not the hover tip it carries.
          const copy = el.cloneNode(true) as HTMLElement;
          for (const tip of copy.querySelectorAll('.ad-tip')) tip.remove();
          return (copy.textContent ?? '').trim();
        })
        .filter((text) => [...text].length > 30),
    );
    check(
      sentences.length === 0,
      `角色工作台 ${name}: explanatory sentences on the page: ${sentences.map((t: string) => t.slice(0, 18)).join(' | ')}`,
    );
  }

  // 10. 模型与价格: 保存 is disabled until something changed, then shows the count.
  await open('models');
  const saveButton = page.locator('#models-save');
  check(await saveButton.isDisabled(), '模型与价格: 保存 is enabled with nothing changed');
  await page
    .locator('section[data-panel="models"] input[type="checkbox"]')
    .nth(5)
    .evaluate((el: HTMLInputElement) => el.click());
  await wait(500);
  check(!(await saveButton.isDisabled()), '模型与价格: 保存 is still disabled after a change');
  check(
    /1/.test((await saveButton.innerText()) ?? ''),
    `模型与价格: 保存 does not show the count ("${await saveButton.innerText()}")`,
  );
  await shot('models-changed');

  // 11. 管理员与权限: a gap between box and label; no English permission ids anywhere in the grid.
  await open('members');
  await wait(800);
  const members = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.ot-panel[data-state="open"] .permission-item')] as HTMLElement[];
    const gaps = items.map((item) => {
      const box = item.querySelector('input') as HTMLElement;
      const label = item.querySelector('span') as HTMLElement;
      return Math.round(label.getBoundingClientRect().left - box.getBoundingClientRect().right);
    });
    const ids =
      ((document.querySelector('.ot-panel[data-state="open"]') as HTMLElement)?.textContent ?? '').match(
        /\b[a-z]+\.[a-z-]+(:[^\s]+)?/g,
      ) ?? [];
    return { count: items.length, minGap: Math.min(...gaps), ids };
  });
  check(
    members.count > 10 && members.minGap >= 8,
    `管理员与权限: the smallest gap between a box and its label is ${members.minGap} px (≥ 8)`,
  );
  check(members.ids.length === 0, `管理员与权限: permission ids are shown: ${members.ids.slice(0, 4)}`);

  // ---------------------------------------------------------------------------------------------------------------------------
  // Contrast and reduced motion.
  // ---------------------------------------------------------------------------------------------------------------------------
  for (const entry of PAGES) {
    await open(entry.route);
    const low: string[] = await page.evaluate((key: string) => {
      const parse = (value: string) => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b, a] = m[1]!.split(/[ ,/]+/).map(Number);
        return { r: r!, g: g!, b: b!, a: a ?? 1 };
      };
      const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
        const channel = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
      };
      const background = (el: Element) => {
        let node: Element | null = el;
        while (node) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c && c.a > 0.9) return c;
          node = node.parentElement;
        }
        return { r: 255, g: 255, b: 255, a: 1 };
      };
      const out: string[] = [];
      const panel = document.querySelector(`section[data-panel="${key}"]`) as HTMLElement;
      for (const el of panel.querySelectorAll('*')) {
        if (el.closest('.ad-tip, [hidden], .sr-only, svg, option') || (el as HTMLButtonElement).disabled) continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '');
        if (!own) continue;
        const rect = (el as HTMLElement).getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || Number(style.opacity) < 0.99) continue;
        const fg = parse(style.color);
        if (!fg) continue;
        const bg = background(el);
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < 4.5)
          out.push(
            `${el.tagName.toLowerCase()}.${(el as HTMLElement).className.toString().slice(0, 24)} ${ratio.toFixed(2)} "${(el.textContent ?? '').trim().slice(0, 12)}"`,
          );
      }
      return [...new Set(out)];
    }, entry.panel);
    check(low.length === 0, `${entry.name}: contrast below 4.5:1: ${low.slice(0, 5).join(' | ')}`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const route of ['invites', 'characters/jojo']) {
    await open(route);
    const motion = await page.evaluate(() => {
      const sel = [
        '.ot-panel',
        '.wb-roster',
        '.wb-tab',
        '.admin-content > section:not([hidden])',
        '.dz-panel',
        '.seg-button',
      ];
      return sel
        .map((s) => {
          const el = document.querySelector(s);
          if (!el) return null;
          const style = getComputedStyle(el);
          const durations = [style.transitionDuration, style.animationDuration]
            .join(',')
            .split(',')
            .map((v) => parseFloat(v));
          // Chromium reports a zero duration as 1e-05 s.
          return [s, durations.every((d) => !(d > 0.0001))] as const;
        })
        .filter(Boolean);
    });
    for (const [selector, still] of motion as [string, boolean][])
      check(still, `reduced motion: ${selector} on ${route} still animates`);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  assert.deepEqual(errors, [], 'no uncaught page errors');
  if (problems.length) {
    process.stderr.write(`${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
    throw new Error('console 24b-6 browser check failed');
  }

  // ---------------------------------------------------------------------------------------------------------------------------
  // The last, destructive step: the held press really deletes (once), and the recordings.
  // ---------------------------------------------------------------------------------------------------------------------------
  if (shots) {
    const video = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 900 },
      storageState: await f.context.storageState(),
      recordVideo: { dir: join(shots, 'video'), size: { width: 1440, height: 900 } },
    });
    const film: Page = await video.newPage();
    await film.goto(`${f.origin}/?mode=provider-admin#/characters/jojo`);
    await film.locator('.wb-tab').first().waitFor({ timeout: 20_000 });
    await film.waitForTimeout(1000);
    for (const index of [1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) {
      await film.locator('.wb-tab').nth(index).click();
      await film.waitForTimeout(900);
    }
    const sectionFilm = await film.video()?.path();
    await film.close();
    const castFilm: Page = await video.newPage();
    await castFilm.goto(`${f.origin}/?mode=provider-admin#/cast`);
    await castFilm.locator('.cs-cell[data-from]').first().waitFor({ timeout: 20_000 });
    await castFilm.waitForTimeout(900);
    const target = castFilm.locator('.cs-cell[data-from]:has(.cs-story-dot)').first();
    await target.hover();
    await castFilm.waitForTimeout(700);
    await target.click();
    await castFilm.waitForTimeout(1000);
    await castFilm.locator('.cs-story-title').first().click();
    await castFilm.waitForTimeout(1600);
    const castPath = await castFilm.video()?.path();
    await castFilm.close();
    await video.close();
    if (sectionFilm) renameSync(sectionFilm, join(shots, 'workbench-sections.webm'));
    if (castPath) renameSync(castPath, join(shots, 'cast-cell-to-story.webm'));
  }
  process.stdout.write('console 24b-6 browser check: PASS\n');
} catch (error) {
  failure = error;
  process.stderr.write(`page errors so far: ${JSON.stringify(errors)}\n`);
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}

/** Screenshots of the workbench sections are taken at the default size only. */
function width1440(page: Page) {
  return page.viewportSize()?.width === 1440 && shots !== null;
}
