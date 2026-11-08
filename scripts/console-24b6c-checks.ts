import { randomUUID } from 'node:crypto';
import type { startConsoleFixture } from './console-fixture-24b6.ts';
import {
  ADMIN_PERMISSION_PRESETS,
  itemPermission,
  requiredItems,
  type AdminPermissionItem,
} from '../packages/contracts/web-admin-permissions.ts';

/**
 * Part 24b-6c: what the permission options of 管理员与权限 and the one-column 预演 guard, in a REAL browser, on the synthetic site of
 * console-fixture-24b6.ts started WITH its offline provider (nothing leaves the machine; a call is a scripted answer after a short wait), at the
 * three window sizes the owner looks at. `check()` collects a problem; nothing stops at the first.
 *   A. adding an administrator: the same grouped grid an open administrator has, under the name; the presets only TICK it (a click replaces the
 *      ticks); dependencies behave as in the open grid; the issue button names the count and is the page's one solid primary; with 0 items or no
 *      name it is off and the reason sits beside it; the request carries exactly the ticked set (+ required items); the table row shows the granted
 *      items by their Chinese names on hover; a grant for one role stays "· 指定角色";
 *   B. 预演: one column. The send button and its confirmation are within 300 px of the box; a first click never calls the API; the second click
 *      shows the row with a state within 1 s and it moves to 完成; a run shows N / M and a bar; the toast and the tab-title marker; the result row
 *      is in the window after sending; every reason a send is impossible is on screen; 编辑评测集 opens under its control; a result opens below
 *      its row; 审核对比 asks on its button; nothing opens a drawer or a dialog; no sideways scroll; nothing moves under reduced motion.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
type Fixture = Awaited<ReturnType<typeof startConsoleFixture>>;
export type Ctx = {
  f: Fixture;
  page: Page;
  wait: (ms?: number) => Promise<void>;
  open: (route: string) => Promise<void>;
  shot: (name: string) => Promise<void>;
  check: (condition: unknown, message: string) => void;
  sizes: readonly (readonly [number, number])[];
};
const PRIMARY = 'rgb(91, 79, 196)';
const AMBER_SOFT = 'rgb(253, 246, 230)';

export async function run24b6cChecks(ctx: Ctx) {
  const { f, page, wait, open, shot, check, sizes } = ctx;
  const sent: { url: string; body: string }[] = [];
  page.on('request', (request: { method: () => string; url: () => string; postData: () => string | null }) => {
    if (request.method() === 'POST') sent.push({ url: request.url(), body: request.postData() ?? '' });
  });
  const calls = (pattern: RegExp) => sent.filter((s) => pattern.test(s.url));
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
  const rect = (selector: string, nth = 0) =>
    page.evaluate(
      ({ selector: s, nth: n }: { selector: string; nth: number }) => {
        const el = document.querySelectorAll(s)[n] as HTMLElement | undefined;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      },
      { selector, nth },
    );
  type Box = NonNullable<Awaited<ReturnType<typeof rect>>>;
  /** The gap between two boxes (0 when they touch or overlap). */
  const gap = (a: Box, b: Box) =>
    Math.max(0, Math.max(a.x, b.x) - Math.min(a.right, b.right), Math.max(a.y, b.y) - Math.min(a.bottom, b.bottom));
  const solid = (panel: string) =>
    page.evaluate(
      ({ panel: p, primary }: { panel: string; primary: string }) =>
        [...document.querySelectorAll(`section[data-panel="${p}"] button`)].filter((b) => {
          const r = (b as HTMLElement).getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).backgroundColor === primary;
        }).length,
      { panel, primary: PRIMARY },
    );
  const ticked = (): Promise<string[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll('#admin-new-grid input[data-permission]')]
        .filter((i) => (i as HTMLInputElement).checked)
        .map((i) => (i as HTMLInputElement).dataset.permission!)
        .sort(),
    );
  const closure = (items: readonly AdminPermissionItem[]) =>
    [...new Set(items.flatMap((i) => [i, ...requiredItems(i)]))].sort();
  const stored = async (label: string) => {
    const r = await f.post('members/list', {});
    const list = (await r.json()).members as { label: string; permissions: string[] }[];
    return list.find((m) => m.label === label)?.permissions ?? null;
  };

  for (const [width, height] of sizes) {
    const at = `${width}×${height}`;
    await page.setViewportSize({ width, height });

    // ============================== A. 管理员与权限: the options when adding ==============================
    await open('members');
    await sideways(`管理员与权限 ${at}`);
    const grid = await page.locator('#admin-new-grid input[data-permission]').count();
    check(grid >= 15, `管理员与权限 ${at}: the add bar's grid shows ${grid} items`);
    // The presets sit above the grid, and the grid is directly under the name field.
    const nameBox = (await rect('#admin-member-label')) as Box;
    const presetBox = (await rect('#admin-new-permissions')) as Box;
    const gridBox = (await rect('#admin-new-grid')) as Box;
    const buttonBox = (await rect('#admin-member-issue button[type="submit"]')) as Box;
    check(
      presetBox.bottom <= gridBox.y + 1 && nameBox.bottom <= gridBox.y + 1,
      `管理员与权限 ${at}: the grid is not under the name and presets`,
    );
    check(buttonBox.y >= gridBox.bottom - 1, `管理员与权限 ${at}: the issue button is not below the grid`);
    // The starting point: the first preset, ticked (its required items with it); the button names the count.
    const first = ADMIN_PERMISSION_PRESETS[0]!;
    check(
      JSON.stringify(await ticked()) === JSON.stringify(closure(first.items)),
      `管理员与权限 ${at}: the starting ticks are not ${first.label}`,
    );
    const label = async () =>
      (await page.locator('#admin-member-issue button[type="submit"]').innerText()).replace(/\s+/g, ' ');
    check(
      (await label()) === `签发凭据 · ${(await ticked()).length} 项`,
      `管理员与权限 ${at}: the button does not name the count: ${await label()}`,
    );
    // No name: off, with the reason beside it.
    const disabled = () => page.locator('#admin-member-issue button[type="submit"]').isDisabled();
    check(await disabled(), `管理员与权限 ${at}: the button is on without a name`);
    const why = (await page.locator('#admin-issue-reason').innerText()).trim();
    check(why === '先填写备注', `管理员与权限 ${at}: the reason without a name is "${why}"`);
    const reasonBox = (await rect('#admin-issue-reason')) as Box;
    check(
      gap(buttonBox, reasonBox) <= 40,
      `管理员与权限 ${at}: the reason is ${Math.round(gap(buttonBox, reasonBox))}px from the button`,
    );
    check(
      (await solid('members')) === 1,
      `管理员与权限 ${at}: ${await solid('members')} solid primary buttons (one wanted)`,
    );

    // 运营, then untick one item, tick one outside the preset.
    const adminName = `运营测试 ${width}`;
    await page.locator('#admin-member-label').fill(adminName);
    await page.locator('#admin-member-issue [data-preset="operations"]').click();
    const ops = ADMIN_PERMISSION_PRESETS.find((p) => p.id === 'operations')!;
    check(
      JSON.stringify(await ticked()) === JSON.stringify(closure(ops.items)),
      `管理员与权限 ${at}: 运营 ticked ${JSON.stringify(await ticked())}`,
    );
    check(
      (await page.locator('#admin-member-issue [data-preset="operations"]').getAttribute('aria-pressed')) === 'true',
      `管理员与权限 ${at}: 运营 is not marked as chosen`,
    );
    // Ticking is the real checkbox: the label wraps it.
    const tick = (item: string) => page.locator(`#admin-new-grid input[data-permission="${item}"]`);
    await tick('invites.revoke-access').uncheck();
    await tick('cast.read').check();
    check(
      (await page.locator('#admin-member-issue [data-preset="operations"]').getAttribute('aria-pressed')) === 'false',
      `管理员与权限 ${at}: 运营 still looks chosen after the ticks changed`,
    );
    const now = await ticked();
    check(
      !now.includes('invites.revoke-access') && now.includes('cast.read'),
      `管理员与权限 ${at}: the ticks did not follow the clicks`,
    );
    check(
      (await label()) === `签发凭据 · ${now.length} 项`,
      `管理员与权限 ${at}: the count does not match the ticks (${now.length}): ${await label()}`,
    );
    // Dependencies as in the open grid: 发布 needs 预演测试 (and 查看角色); unticking 预演测试 unticks 发布.
    await tick('characters.publish').check();
    const withPublish = await ticked();
    check(
      ['characters.preview', 'characters.read', 'characters.publish'].every((i) => withPublish.includes(i)),
      `管理员与权限 ${at}: ticking 发布 did not tick what it needs`,
    );
    await tick('characters.preview').uncheck();
    check(!(await ticked()).includes('characters.publish'), `管理员与权限 ${at}: unticking 预演测试 left 发布 ticked`);
    await tick('characters.preview')
      .uncheck()
      .catch(() => undefined);
    await shot(`members-add-${width}`);
    const expectNow = await ticked();
    check(
      (await solid('members')) === 1,
      `管理员与权限 ${at}: ${await solid('members')} solid primary buttons with a name`,
    );
    check(!(await disabled()), `管理员与权限 ${at}: the button is off with a name and ${expectNow.length} items`);
    const before = calls(/members\/issue$/).length;
    await page.locator('#admin-member-issue button[type="submit"]').click();
    await wait(1200);
    const issued = calls(/members\/issue$/).slice(before);
    check(issued.length === 1, `管理员与权限 ${at}: ${issued.length} issue requests`);
    const body = issued[0] ? JSON.parse(issued[0].body) : { permissions: [] };
    const wanted = expectNow.map((i) => itemPermission(i as AdminPermissionItem)).sort();
    check(
      JSON.stringify([...body.permissions].sort()) === JSON.stringify(wanted),
      `管理员与权限 ${at}: the request carries ${JSON.stringify(body.permissions)}, the ticks were ${JSON.stringify(wanted)}`,
    );
    check(
      body.permissions.includes('cast.read') &&
        !body.permissions.includes('invites.revoke-access:*') &&
        !body.permissions.includes('invites.revoke-access'),
      `管理员与权限 ${at}: the request does not hold the owner's edits (运营, minus 撤销体验授权, plus 关系与故事·查看)`,
    );
    const heldAfter = await stored(adminName);
    check(
      !!heldAfter && JSON.stringify([...heldAfter].sort()) === JSON.stringify(wanted),
      `管理员与权限 ${at}: the new administrator holds ${JSON.stringify(heldAfter)}, expected ${JSON.stringify(wanted)}`,
    );
    // The secret is shown once; close it before going on.
    await page
      .locator('#admin-secret-close')
      .click()
      .catch(() => undefined);
    await wait(300);

    // A preset click replaces earlier ticks.
    await page.locator('#admin-member-label').fill(`预设 ${width}`);
    await tick('models.manage').check();
    await tick('cast.read').check();
    await page.locator('#admin-member-issue [data-preset="co-writer"]').click();
    check(
      JSON.stringify(await ticked()) === JSON.stringify(closure(first.items)),
      `管理员与权限 ${at}: a preset click kept earlier ticks: ${JSON.stringify(await ticked())}`,
    );
    // 0 items: off, with the reason.
    for (const item of await ticked())
      await tick(item)
        .uncheck()
        .catch(() => undefined);
    check((await ticked()).length === 0, `管理员与权限 ${at}: the grid could not be emptied`);
    check(await disabled(), `管理员与权限 ${at}: the button is on with 0 items`);
    check((await label()) === '签发凭据 · 0 项', `管理员与权限 ${at}: the button reads ${await label()} with 0 items`);
    check(
      (await page.locator('#admin-issue-reason').innerText()).trim() === '没有勾选任何权限',
      `管理员与权限 ${at}: no reason for 0 items`,
    );
    await page.locator('#admin-member-label').fill('');

    // The table row shows the granted items on hover; a grant for one role stays "· 指定角色".
    const rows = page.locator('#admin-members-table .ot-row');
    const perm = async (name: string) => {
      const row = rows.filter({ hasText: name });
      const cell = row.locator('.ot-cell').nth(3);
      await cell.hover();
      await wait(250);
      return (await cell.locator('.ad-tip').textContent()) ?? '';
    };
    const tipOps = await perm(adminName);
    check(
      /查看邀请记录/.test(tipOps) && /生成邀请码/.test(tipOps) && !/撤销体验授权/.test(tipOps),
      `管理员与权限 ${at}: the hover of ${adminName} is "${tipOps}"`,
    );
    const tipScoped = await perm('指定角色 · 小林');
    check(
      /查看角色 · 指定角色/.test(tipScoped),
      `管理员与权限 ${at}: the hover of a role-scoped admin is "${tipScoped}"`,
    );
    const tipOther = await perm('运营 · 阿杰');
    check(
      /积分发放/.test(tipOther) && /查看消耗表与统计/.test(tipOther),
      `管理员与权限 ${at}: the hover of the stats/points grants is "${tipOther}"`,
    );
    await shot(`members-hover-${width}`);
    await sideways(`管理员与权限 ${at} (after)`);
    await noLayers(`管理员与权限 ${at}`);

    // ============================== B. 预演: one column ==============================
    await open('characters/jojo');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(700);
    const input = page.locator('textarea[aria-label="预演输入"]');
    const send = page.locator('[data-pw-send="preview"]');
    const cancel = page.locator('[data-pw-cancel="preview"]');
    const reason = async () => ((await page.locator('[data-pw-reason="preview"]').innerText()) as string).trim();
    const near = async (where: string, selector: string) => {
      const a = (await rect('textarea[aria-label="预演输入"]')) as Box;
      const b = (await rect(selector)) as Box | null;
      check(
        !!b && gap(a, b) <= 300,
        `预演 ${at}: ${where} is ${b ? Math.round(gap(a, b)) : '—'}px from the box (300 wanted)`,
      );
      check(!!b && b.right <= width && b.x >= 0, `预演 ${at}: ${where} is outside the window`);
    };
    await sideways(`预演 ${at} (empty)`);
    // The settings are one summary line.
    const summary = ((await page.locator('.pw-summary').innerText()) as string).replace(/\s+/g, ' ');
    check(/关系 .*真实时间/.test(summary), `预演 ${at}: the settings line says "${summary}"`);
    check(
      (await page.locator('.pw-summary').getAttribute('aria-expanded')) === 'false',
      `预演 ${at}: the settings are not folded`,
    );
    check(
      (await reason()) === '没有输入' && (await send.isDisabled()),
      `预演 ${at}: the empty state says "${await reason()}"`,
    );
    await near('the send button', '[data-pw-send="preview"]');
    await shot(`preview-empty-${width}`);

    // A single line: the first click only asks.
    const text1 = `单条 ${width} 你好`;
    await input.fill(text1);
    const idle = ((await send.innerText()) as string).replace(/\s+/g, ' ');
    check(idle === '预演 1 条 · 2 次付费调用', `预演 ${at}: the idle button reads "${idle}"`);
    const startedBefore = calls(/review-start/).length;
    await send.click();
    await wait(400);
    check(calls(/review-start/).length === startedBefore, `预演 ${at}: a first click called the API`);
    check((await send.getAttribute('data-state')) === 'confirm', `预演 ${at}: the first click did not ask again`);
    check(
      ((await send.innerText()) as string).replace(/\s+/g, ' ') === '确认付费 · 2 次',
      `预演 ${at}: the confirm reads "${await send.innerText()}"`,
    );
    const amber = await send.evaluate((n: Element) => getComputedStyle(n).backgroundColor);
    check(amber === AMBER_SOFT, `预演 ${at}: the confirm is ${amber}, not the unsaved amber`);
    check(await cancel.isVisible(), `预演 ${at}: no 取消 beside the confirm`);
    await near('the confirm button', '[data-pw-send="preview"]');
    await near('取消', '[data-pw-cancel="preview"]');
    check(
      (await solid('characters')) === 1,
      `预演 ${at}: ${await solid('characters')} solid primary buttons (one wanted)`,
    );
    await shot(`preview-confirm-${width}`);
    // 取消 goes back; the box is kept.
    await cancel.click();
    check(
      (await send.getAttribute('data-state')) === 'idle' && (await input.inputValue()) === text1,
      `预演 ${at}: 取消 did not go back`,
    );
    // The confirmation lapses by itself after 6 seconds.
    await send.click();
    await wait(6600);
    check((await send.getAttribute('data-state')) === 'idle', `预演 ${at}: the confirmation did not lapse after 6 s`);
    check(calls(/review-start/).length === startedBefore, `预演 ${at}: nothing was to be sent yet`);

    // The second click: the row within 1 s, then the states to 完成; the toast and the title.
    await send.click();
    const clicked = Date.now();
    await send.click();
    await page
      .waitForFunction(
        (needle: string) =>
          [...document.querySelectorAll('.pw-line')].some(
            (l) =>
              (l.textContent ?? '').includes(needle) &&
              /排队中|生成草稿|审核中|完成/.test(l.querySelector('.pw-state')?.textContent ?? ''),
          ),
        text1,
        { timeout: 1000 },
      )
      .catch(() => check(false, `预演 ${at}: no row with a state within 1 s of the second click`));
    check(Date.now() - clicked < 1500, `预演 ${at}: the row took ${Date.now() - clicked} ms`);
    check(calls(/review-start/).length === startedBefore + 1, `预演 ${at}: the second click did not send once`);
    const rowState = () =>
      page.evaluate(
        (needle: string) =>
          [...document.querySelectorAll('.pw-line')]
            .find((l) => (l.textContent ?? '').includes(needle))
            ?.querySelector('.pw-state')?.textContent ?? '',
        text1,
      );
    const title = () => page.evaluate(() => document.title);
    check((await title()).startsWith('(进行中) '), `预演 ${at}: the tab title says "${await title()}" while it runs`);
    // Inside the window, above the sticky save bar.
    const rowBox = (await rect(`.pw-line[data-key] `)) as Box;
    const rowTop = await page.evaluate((needle: string) => {
      const l = [...document.querySelectorAll('.pw-line')].find((x) => (x.textContent ?? '').includes(needle)) as
        | HTMLElement
        | undefined;
      const r = l?.getBoundingClientRect();
      const bar = document.querySelector('.wb-savebar') as HTMLElement | null;
      return r ? { top: r.top, bottom: r.bottom, bar: bar ? bar.getBoundingClientRect().top : innerHeight } : null;
    }, text1);
    check(
      !!rowTop && rowTop.top >= 0 && rowTop.bottom <= Math.min(height, rowTop.bar + 1),
      `预演 ${at}: the result row is not inside the window after sending: ${JSON.stringify(rowTop)} (${JSON.stringify(rowBox)})`,
    );
    await shot(`preview-running-${width}`);
    const seen = new Set<string>();
    for (let i = 0; i < 90; i++) {
      const state = await rowState();
      seen.add(state);
      if (state === '完成' || state === '失败') break;
      await wait(150);
    }
    check(
      (await rowState()) === '完成',
      `预演 ${at}: the single preview ended as "${await rowState()}"; states seen: ${[...seen].join(' → ')}`,
    );
    check(
      seen.has('排队中') || seen.has('生成草稿') || seen.has('审核中'),
      `预演 ${at}: no state before 完成 was shown`,
    );
    await wait(300);
    const toast = (
      (await page
        .locator('.admin-toast')
        .first()
        .innerText()
        .catch(() => '')) as string
    ).replace(/\s+/g, ' ');
    check(/JOJO 预演完成/.test(toast) && /查看/.test(toast), `预演 ${at}: the toast says "${toast}"`);
    check((await title()).startsWith('(完成) '), `预演 ${at}: the title says "${await title()}" when it is done`);
    await shot(`preview-single-done-${width}`);
    // 查看 jumps to the row; the title marker goes when the tab is next focused.
    await page.locator('.admin-toast .admin-toast-action').first().click();
    await wait(500);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await wait(200);
    check(
      !/^\((进行中|完成)\) /.test(await title()),
      `预演 ${at}: the title marker stays after the tab is focused: "${await title()}"`,
    );
    // A result opens below its row.
    await page.locator('.pw-line', { hasText: text1 }).locator('.pw-row').click();
    await wait(900);
    const opened = await page.evaluate((needle: string) => {
      const l = [...document.querySelectorAll('.pw-line')].find((x) =>
        (x.textContent ?? '').includes(needle),
      ) as HTMLElement;
      const row = l.querySelector('.pw-row')!.getBoundingClientRect();
      const panel = l.querySelector('.pw-panel')!.getBoundingClientRect();
      return {
        gap: panel.top - row.bottom,
        text: l.querySelector('.pw-panel')!.textContent ?? '',
        pw: l.getBoundingClientRect().width,
      };
    }, text1);
    check(opened.gap >= -1 && opened.gap < 12, `预演 ${at}: the result opens ${Math.round(opened.gap)}px from its row`);
    check(/草稿与最终气泡/.test(opened.text), `预演 ${at}: the opened result has no 草稿与最终气泡`);
    await noLayers(`预演 ${at} (result open)`);
    await shot(`preview-result-${width}`);
    await page.locator('.pw-line', { hasText: text1 }).locator('.pw-row').click();

    // A run of 5 lines (one fails): N / M, the bar, the toast with the failure.
    const tag = `批 ${width}`;
    await input.fill([`${tag} 一`, `${tag} 二`, `${tag} 失败`, `${tag} 四`, `${tag} 五`].join('\n'));
    await page.locator('input[aria-label="运行备注"]').fill(`备注 ${width}`);
    check(
      ((await send.innerText()) as string).replace(/\s+/g, ' ') === '运行 5 条 · 10 次付费调用',
      `预演 ${at}: the run button reads "${await send.innerText()}"`,
    );
    await send.click();
    await near('the run confirm', '[data-pw-send="preview"]');
    check(
      ((await send.innerText()) as string).replace(/\s+/g, ' ') === '确认付费 · 10 次',
      `预演 ${at}: the run confirm reads "${await send.innerText()}"`,
    );
    await send.click();
    await page.waitForSelector('.pw-batch', { timeout: 2000 }).catch(() => undefined);
    const count = () =>
      page
        .locator('.pw-batch')
        .first()
        .locator('.pw-count')
        .innerText()
        .catch(() => '');
    const bar = () =>
      page
        .locator('.pw-batch')
        .first()
        .locator('.pw-progress')
        .evaluate((n: Element) => ({
          now: Number(n.getAttribute('aria-valuenow')),
          max: Number(n.getAttribute('aria-valuemax')),
          h: n.getBoundingClientRect().height,
          fill: n.firstElementChild!.getBoundingClientRect().width,
          total: n.getBoundingClientRect().width,
        }));
    check(/^\d+ \/ 5 完成/.test(await count()), `预演 ${at}: the run count reads "${await count()}"`);
    const lineCount = await page.locator('.pw-batch').first().locator('.pw-line').count();
    check(lineCount === 5, `预演 ${at}: the run shows ${lineCount} lines at once (5 wanted)`);
    const progress = new Set<string>();
    let barSeen = await bar();
    for (let i = 0; i < 160; i++) {
      progress.add(await count());
      barSeen = await bar();
      if (/^5 \/ 5 完成/.test(await count())) break;
      await wait(250);
    }
    check(
      /^5 \/ 5 完成 · 1 失败/.test(await count()),
      `预演 ${at}: the run ended as "${await count()}"; counts seen: ${[...progress].join(' | ')}`,
    );
    await wait(500);
    barSeen = await bar();
    check(
      barSeen.max === 5 && barSeen.now === 5 && barSeen.h <= 4 && barSeen.fill >= barSeen.total - 1,
      `预演 ${at}: the bar is ${JSON.stringify(barSeen)}`,
    );
    const states = await page.locator('.pw-batch').first().locator('.pw-line .pw-state').allInnerTexts();
    check(
      states.filter((s: string) => s.trim() === '完成').length === 4 &&
        states.filter((s: string) => s.trim() === '失败').length === 1,
      `预演 ${at}: the lines ended as ${JSON.stringify(states)}`,
    );
    await wait(300);
    const toast2 = (
      (await page
        .locator('.admin-toast')
        .first()
        .innerText()
        .catch(() => '')) as string
    ).replace(/\s+/g, ' ');
    check(/JOJO 预演完成 · 5 条，1 条失败/.test(toast2), `预演 ${at}: the run toast says "${toast2}"`);
    check((await title()).startsWith('(完成) '), `预演 ${at}: the title says "${await title()}" after the run`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await shot(`preview-run-done-${width}`);
    // A line of the run opens below its row.
    await page.locator('.pw-batch').first().locator('.pw-line').first().locator('.pw-row').click();
    await wait(900);
    const lineOpen = await page
      .locator('.pw-batch')
      .first()
      .locator('.pw-line')
      .first()
      .evaluate((l: Element) => {
        const row = l.querySelector('.pw-row')!.getBoundingClientRect();
        const panel = l.querySelector('.pw-panel')!.getBoundingClientRect();
        return { gap: panel.top - row.bottom, text: l.querySelector('.pw-panel')!.textContent ?? '' };
      });
    check(
      lineOpen.gap >= -1 && lineOpen.gap < 12 && /草稿与最终气泡/.test(lineOpen.text),
      `预演 ${at}: a line of the run did not open below its row`,
    );
    await noLayers(`预演 ${at} (run line open)`);
    await page.locator('.pw-batch').first().locator('.pw-line').first().locator('.pw-row').click();
    await sideways(`预演 ${at} (run)`);

    // An eval set: made through the API, chosen in the settings line, run from the same button.
    const setName = `评测 ${width}`;
    const made = await f.post('eval-sets/save', {
      id: null,
      expectedVersion: null,
      name: setName,
      items: [
        { text: `${setName} a`, note: null },
        { text: `${setName} b`, note: null },
        { text: `${setName} c`, note: null },
      ],
    });
    const saved = await made.json();
    await open('characters/jojo');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(700);
    // 编辑评测集 opens inline under its control; no drawer, no dialog.
    await page.locator('.pw-summary').click();
    await wait(500);
    const pickerBox = (await rect('select[aria-label="评测集"]')) as Box;
    await page.getByRole('button', { name: '编辑评测集' }).click();
    await wait(700);
    const editorBox = (await rect('.pw-eval-panel textarea')) as Box | null;
    check(
      !!editorBox && editorBox.y >= pickerBox.bottom - 1,
      `预演 ${at}: the eval-set editor is not under the 评测集 control`,
    );
    check(!!editorBox && editorBox.right <= width, `预演 ${at}: the eval-set editor reaches outside the window`);
    await noLayers(`预演 ${at} (评测集 editor)`);
    await shot(`preview-evalset-${width}`);
    await page.locator('[data-eval-set]').first().click();
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await wait(500);
    check((await page.locator('.pw-eval-confirm .ic').count()) >= 1, `预演 ${at}: deleting a set did not ask in place`);
    await noLayers(`预演 ${at} (评测集 delete)`);
    await page.locator('.pw-eval-confirm .ic button', { hasText: '取消' }).last().click();
    await page.getByRole('button', { name: '收起', exact: true }).click();
    await wait(400);
    await page.locator('select[aria-label="评测集"]').selectOption(saved.id);
    await input.fill('');
    await wait(200);
    const setLabel = ((await send.innerText()) as string).replace(/\s+/g, ' ');
    check(
      setLabel === `运行评测集「${setName}」v1 · 6 次付费调用`,
      `预演 ${at}: the eval-set button reads "${setLabel}"`,
    );
    await near('the eval-set button', '[data-pw-send="preview"]');
    await send.click();
    check(
      ((await send.innerText()) as string).replace(/\s+/g, ' ') === '确认付费 · 6 次',
      `预演 ${at}: the eval-set confirm reads "${await send.innerText()}"`,
    );
    await shot(`preview-evalset-confirm-${width}`);
    await send.click();
    await page
      .waitForFunction(
        () => /^\d+ \/ 3 完成/.test(document.querySelector('.pw-batch .pw-count')?.textContent ?? ''),
        null,
        { timeout: 2000 },
      )
      .catch(() => check(false, `预演 ${at}: the eval-set run shows no N / 3`));
    await page
      .waitForFunction(
        () => /^3 \/ 3 完成/.test(document.querySelector('.pw-batch .pw-count')?.textContent ?? ''),
        null,
        { timeout: 40_000 },
      )
      .catch(() => check(false, `预演 ${at}: the eval-set run did not finish`));
    await wait(300);
    const toast3 = (
      (await page
        .locator('.admin-toast')
        .first()
        .innerText()
        .catch(() => '')) as string
    ).replace(/\s+/g, ' ');
    check(/JOJO 预演完成 · 3 条/.test(toast3), `预演 ${at}: the eval-set toast says "${toast3}"`);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await shot(`preview-evalset-done-${width}`);

    // Every reason a send is impossible is on screen next to the button.
    await input.fill('第一行\n' + '长'.repeat(4001));
    check(
      (await reason()) === '第 2 行过长' && (await send.isDisabled()),
      `预演 ${at}: a long line says "${await reason()}"`,
    );
    await shot(`preview-reason-long-${width}`);
    await input.fill(Array.from({ length: 51 }, (_, i) => `第${i}条`).join('\n'));
    check(
      (await reason()) === '超过 50 条' && (await send.isDisabled()),
      `预演 ${at}: 51 lines say "${await reason()}"`,
    );
    await shot(`preview-reason-many-${width}`);
    await input.fill('');
    await page.locator('select[aria-label="评测集"]').selectOption('');
    check(
      (await reason()) === '没有输入' && (await send.isDisabled()),
      `预演 ${at}: nothing typed says "${await reason()}"`,
    );
    await shot(`preview-reason-${width}`);
    // 草稿未保存, with 保存草稿 as a link that saves.
    await page.locator('.wb-tab', { hasText: '身份与展示' }).click();
    await wait(400);
    await page
      .locator('input[aria-label="人设名称"], label:has-text("人设名称") input')
      .first()
      .fill(`合成jojo ${width}`);
    await wait(300);
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(500);
    await input.fill('你好');
    const unsavedReason = await reason();
    check(
      /草稿未保存/.test(unsavedReason) && (await send.isDisabled()),
      `预演 ${at}: unsaved edits say "${unsavedReason}"`,
    );
    check(
      (await page.locator('[data-pw-reason="preview"] .pw-link').count()) === 1,
      `预演 ${at}: 保存草稿 is not a link in the reason`,
    );
    await shot(`preview-unsaved-${width}`);
    await page.locator('[data-pw-reason="preview"] .pw-link').click();
    await wait(1500);
    check(
      (await reason()) === '' && !(await send.isDisabled()),
      `预演 ${at}: after 保存草稿 the reason is "${await reason()}"`,
    );
    // 没有草稿: a role that has none.
    await open('characters/c04');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(1200);
    await page.locator('textarea[aria-label="预演输入"]').fill('你好');
    check(
      (await reason()) === '没有草稿' && (await send.isDisabled()),
      `预演 ${at}: a role without a draft says "${await reason()}"`,
    );
    await shot(`preview-reason-nodraft-${width}`);
    // 预演暂不可用 (the server says the preview is off): shown from the answer of the page itself.
    await page.route(
      '**/characters/jojo/detail',
      async (route: {
        fetch: () => Promise<{ json: () => Promise<Record<string, unknown>>; status: () => number }>;
        fulfill: (o: unknown) => Promise<void>;
      }) => {
        const response = await route.fetch();
        const json = await response.json();
        await route.fulfill({
          status: response.status(),
          contentType: 'application/json',
          body: JSON.stringify({ ...json, previewAvailable: false }),
        });
      },
    );
    await open('characters/jojo');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(700);
    await page.locator('textarea[aria-label="预演输入"]').fill('你好');
    check(
      (await reason()) === '预演暂不可用' && (await send.isDisabled()),
      `预演 ${at}: an unavailable preview says "${await reason()}"`,
    );
    await shot(`preview-reason-unavailable-${width}`);
    await page.unroute('**/characters/jojo/detail');

    // 预演后发布 goes to the column with the box focused.
    await open('characters/jojo');
    await page.getByRole('button', { name: '预演后发布' }).click();
    await wait(700);
    check(
      ((await page.locator('.wb-tab[aria-current="true"]').innerText()) as string).trim() === '预演',
      `预演 ${at}: 预演后发布 did not open 预演`,
    );
    check(
      await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '预演输入'),
      `预演 ${at}: 预演后发布 did not focus the box`,
    );

    // 审核对比 asks on its own button (and starts nothing on the first click).
    await page.locator('.pw-review-section summary').click();
    await page
      .waitForFunction(
        () => /次付费调用/.test(document.querySelector('[data-pw-send="review-compare"]')?.textContent ?? ''),
        null,
        { timeout: 10_000 },
      )
      .catch(() => check(false, `预演 ${at}: 审核对比 shows no cost on its button`));
    const rc = page.locator('[data-pw-send="review-compare"]');
    const rcBefore = calls(/review-compare\/start/).length;
    await rc.click();
    check(
      (await rc.getAttribute('data-state')) === 'confirm' && calls(/review-compare\/start/).length === rcBefore,
      `预演 ${at}: 审核对比's first click started something or did not ask`,
    );
    check(
      (await solid('characters')) === 1,
      `预演 ${at}: ${await solid('characters')} solid primary buttons with 审核对比 open`,
    );
    await shot(`preview-review-${width}`);
    await page.locator('[data-pw-cancel="review-compare"]').click();
    await noLayers(`预演 ${at} (审核对比)`);
    await sideways(`预演 ${at} (end)`);

    // Nothing moves under reduced motion.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open('characters/jojo');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await wait(600);
    const motion = await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'pw-item';
      probe.dataset.enter = 'true';
      const fill = document.createElement('div');
      fill.className = 'pw-progress';
      const i = document.createElement('i');
      fill.append(i);
      const host = document.querySelector('.pw-feed') ?? document.querySelector('.pw')!;
      host.append(probe, fill);
      const a = getComputedStyle(probe).animationDuration;
      const t = getComputedStyle(i).transitionDuration;
      const p = getComputedStyle(document.querySelector('.ot-panel')!).transitionDuration;
      probe.remove();
      fill.remove();
      return { a, t, p };
    });
    // (the console's reduced-motion rule leaves a 10 µs duration, not a literal 0: nothing visibly moves)
    const still = (value: string) => value.split(',').every((part) => Number.parseFloat(part) <= 0.001);
    check(
      still(motion.a) && still(motion.t) && still(motion.p),
      `预演 ${at}: something still moves under reduced motion: ${JSON.stringify(motion)}`,
    );
    await page.emulateMedia({ reducedMotion: 'no-preference' });
  }
  void randomUUID;
}
