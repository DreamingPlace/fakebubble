import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { importLongContent } from './console-long-content-24b7b.ts';
import { COPY_AUDIT_SOURCE } from './admin-copy-audit-24b7d.ts';

/**
 * Part 24b-7d (+ 24b-7e). Offline provider only; nothing reaches a provider. At 1280×800 and 1440×900 on the long-content fixture:
 *   A. the COPY audit (scripts/admin-copy-audit-24b7d.ts) on every admin page, every open state of its rows, every 角色工作台 tab
 *      (声音 too: wording only), 系统状态 with a cleanup failure and with the budget source unavailable, and a failed 预演 row:
 *      no visible error-code text, no English word outside the allowlist, no native date/datetime input, no µ$, and every price
 *      cell with its exact value on hover.
 *   B. 总览's one split (全部 / 按角色 / 按模型 × 回复 / 聊天人数 / 活跃 × 折线 / 柱状 / 饼图 × 24H / 7天 / 30天 / 90天): every enabled
 *      combination renders, a disabled one shows its reason, a legend entry hides and shows its series, hover shows every value and
 *      the total, no sideways scroll; the table follows the switch (no switch of its own) and its totals equal the chart's.
 *
 * usage: node scripts/check-web-admin-24b7d-browser.ts [screenshot-dir] [report-json]   (run `pnpm web:player:build` first)
 *        AUDIT_REPORT_ONLY=1 prints the counts and exits 0; COPY_ONLY=1 runs section A only (how the "before" numbers of the PR
 *        were taken on main, where B's switch does not exist).
 */
const shots = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const reportFile = process.argv[3] ? resolve(process.argv[3]) : null;
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const report: Record<string, unknown> = {};
const totals: Record<string, number> = {};
const check = (ok: boolean, message: string) => {
  if (!ok) problems.push(message);
};
let failure: unknown = null;
try {
  await importLongContent(f);
  const list = await (await f.post('characters/list', {})).json();
  const lqy = list.characters.find((c: { displayName: string }) => c.displayName === '青野').characterId as string;
  const page = await f.context.newPage();
  const errors: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  // 系统状态 states the offline fixture cannot produce by itself: a cleanup failure, and the budget source unavailable.
  let systemMode: 'real' | 'cleanup' | 'budget' = 'real';
  await page.route('**/admin/system/status', async (route: any) => {
    const response = await route.fetch();
    if (systemMode === 'real') return route.fulfill({ response });
    const body = await response.json();
    if (systemMode === 'cleanup')
      body.retention = {
        failing: 2,
        oldestAgeBucket: '1-7d',
        lastSuccessAt: Date.UTC(2026, 10, 19, 3, 0),
        purging: 1,
        oldestPurgingMinutes: 20,
        failures: [
          {
            code: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA',
            phase: 'purge',
            sub: 'chat',
            errorName: 'TypeError',
            messageShape: 'Cannot read properties of undefined',
            table: 'web_messages',
            count: 3,
          },
          {
            code: 'WEB_RETENTION_FAILED',
            phase: 'sweep',
            sub: 'audio',
            errorName: 'Error',
            messageShape: 'database is locked',
            count: 1,
          },
        ],
      };
    else body.budget = { available: false, error: 'WEB_SYSTEM_SOURCES_UNAVAILABLE' };
    return route.fulfill({ response, json: body });
  });

  for (const size of ['1440x900', '1280x800']) {
    const [w, h] = size.split('x').map(Number);
    await page.setViewportSize({ width: w!, height: h! });
    const measure = async (name: string) => {
      await page.waitForTimeout(500);
      const result = (await page.evaluate(COPY_AUDIT_SOURCE)) as {
        counts: Record<string, number>;
        out: Record<string, string[]>;
      };
      report[`${size} ${name}`] = result.out;
      for (const [rule, n] of Object.entries(result.counts)) {
        totals[rule] = (totals[rule] ?? 0) + n;
        if (n) problems.push(`${size} ${name} · ${rule} · ${n}: ${result.out[rule]!.slice(0, 3).join(' | ')}`);
      }
      // Screenshots are kept for the states the brief names (the rest are measured, not photographed).
      if (shots && /^(system|预演 failed|invites|models|角色工作台 (资料|身份|声音))/.test(name))
        await page.screenshot({ path: `${shots}/${size}-${name.replace(/[ /]/g, '_')}.png`, fullPage: true });
    };
    const go = async (hash: string, ready = '.admin-shell') => {
      await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
      await page.reload();
      await page.locator(ready).first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1900);
    };
    const openRows = async (name: string) => {
      const rows = page.locator(
        '.ot-row.is-pickable, .cc-row-open, .cs-card-open, button.tiers-new[aria-expanded="false"], button.dz-open[aria-expanded="false"]',
      );
      const n = Math.min(await rows.count(), 3);
      for (let i = 0; i < n; i++) {
        await rows
          .nth(i)
          .click()
          .catch(() => {});
        await page.waitForTimeout(500);
      }
      if (n) {
        await page.waitForTimeout(900);
        await measure(`${name} open`);
      }
    };

    // ---------------- A. the copy audit ----------------
    for (const p of [
      'overview',
      'cast',
      'cocreation',
      'invites',
      'points',
      'conversations',
      'costs',
      'models',
      'members',
      'account',
    ]) {
      await go(p);
      await measure(p);
      await openRows(p);
    }
    for (const mode of ['real', 'cleanup', 'budget'] as const) {
      systemMode = mode;
      await go('system');
      await measure(`system ${mode}`);
    }
    systemMode = 'real';
    // 兑换截止 and 设定生日: no native date input anywhere on the page that holds them.
    await go('invites');
    const redeem = page.locator('#tiers-redeem-by');
    check(
      (await redeem.count()) === 1 && (await redeem.getAttribute('type')) === 'text',
      `${size}: 兑换截止 is not the one text date field`,
    );
    await go(`characters/${lqy}`, '.wb-tab');
    const tabs = (await page.$$eval('.wb-tab', (n: Element[]) =>
      n.map((x) => x.querySelector('span')!.textContent),
    )) as string[];
    for (const t of tabs) {
      await page.locator(`button.wb-tab:has(span:text-is("${t}"))`).first().click();
      await page.waitForTimeout(700);
      await measure(`角色工作台 ${t}`);
      if (t === '发布' || t === '预演') await openRows(`角色工作台 ${t}`);
    }
    // A failed 预演 row (the offline provider answers 500 to a message with 失败): its sentence, never its code.
    await go('characters/jojo', '.wb-tab');
    await page.locator('button.wb-tab:has(span:text-is("预演"))').first().click();
    await page.waitForTimeout(700);
    await page.locator('textarea[aria-label="预演输入"]').fill(`失败 ${size}`);
    const send = page.locator('[data-pw-send="preview"]');
    await send.click();
    await send.click();
    await page
      .waitForSelector('.pw-fail', { timeout: 20_000 })
      .catch(() => check(false, `${size}: no failed 预演 row appeared`));
    await measure('预演 failed row');
    await page
      .locator('.pw-line')
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(700);
    await measure('预演 failed row open');
    await go('characters');
    await measure('角色工作台 目录');

    if (process.env.COPY_ONLY) continue; // section A only (the "before" run on main, where B's switch does not exist)
    // ---------------- B. 总览's one split ----------------
    await go('overview');
    const press = async (group: string, label: string) => {
      await page
        .locator(`#admin-overview [aria-label="${group}"] button`, { hasText: new RegExp(`^${label}$`) })
        .first()
        .click();
      await page.waitForTimeout(450);
    };
    const sideways = async (what: string) =>
      check(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
        `${size} ${what}: sideways scroll`,
      );
    check(
      (await page.locator('#admin-overview [aria-label="统计维度"]').count()) === 0,
      `${size}: the 统计表 still has its own switch`,
    );
    for (const span of ['7天', '30天', '90天', '24H']) {
      await press('时间范围', span);
      for (const metric of ['回复', '聊天人数', '活跃']) {
        await press('指标', metric);
        for (const split of ['全部', '按角色', '按模型']) {
          const tab = page
            .locator('#admin-overview [aria-label="分组"] button', { hasText: new RegExp(`^${split}$`) })
            .first();
          const disabled = await tab.isDisabled();
          const expectOff =
            split !== '全部' &&
            (metric === '活跃' || (split === '按模型' && (metric === '聊天人数' || span === '24H')));
          check(
            disabled === expectOff,
            `${size} ${span} ${metric} ${split}: disabled=${disabled}, expected ${expectOff}`,
          );
          if (disabled) {
            check(
              ((await tab.getAttribute('title')) ?? '').length > 4,
              `${size} ${span} ${metric} ${split}: a disabled split has no reason on hover`,
            );
            continue;
          }
          await press('分组', split);
          for (const kind of ['折线', '柱状', '饼图']) {
            await press('图表类型', kind);
            const name = `总览 ${span} ${metric} ${split} ${kind}`;
            await sideways(name);
            const drawn =
              kind === '饼图'
                ? await page.locator('#admin-overview .ovx-pie-pane').isVisible()
                : await page.locator('#admin-overview .ovx-line .xy').isVisible();
            check(
              drawn || (await page.locator('#admin-overview .ovx-empty:not([hidden])').count()) > 0,
              `${size} ${name}: nothing drawn`,
            );
            if (split !== '全部' && kind !== '饼图' && span === '30天' && metric === '回复') {
              const chips = page.locator('#admin-overview .ovx-legend button');
              const n = await chips.count();
              check(n >= 2 && n <= 7, `${size} ${name}: legend has ${n} entries`);
              await chips.first().click();
              check(
                (await chips.first().getAttribute('aria-pressed')) === 'false',
                `${size} ${name}: legend click did not hide`,
              );
              await chips.first().click();
              check(
                (await chips.first().getAttribute('aria-pressed')) === 'true',
                `${size} ${name}: legend click did not show`,
              );
              const hits = page.locator('#admin-overview .ovx-line .xy-hit');
              if (await hits.count()) {
                await hits.nth(Math.floor((await hits.count()) / 2)).hover();
                await page.waitForTimeout(250);
                const tip = (await page.locator('#admin-overview .ovx-line .xy-tip').innerText()).replace(/\s+/g, ' ');
                check(
                  /合计/.test(tip) && (tip.match(/ 条/g) ?? []).length >= n,
                  `${size} ${name}: the hover shows "${tip.slice(0, 80)}"`,
                );
              }
              if (shots)
                await page.screenshot({ path: `${shots}/${size}-${name.replace(/[ /]/g, '_')}.png`, fullPage: false });
            }
            if (
              shots &&
              span === '7天' &&
              ['回复', '聊天人数'].includes(metric) &&
              !(metric === '聊天人数' && split === '按模型')
            )
              await page.screenshot({ path: `${shots}/${size}-${name.replace(/[ /]/g, '_')}.png`, fullPage: false });
          }
          // the 统计表 follows the split; its rows add up to the chart's total of the same range
          if (metric === '回复' && span !== '24H') {
            const label =
              split === '全部' ? '玩家统计（按天）' : split === '按角色' ? '玩家统计（按角色）' : '玩家统计（按模型）';
            check(
              await page.locator(`#admin-overview [aria-label="${label}"]`).isVisible(),
              `${size} ${span} ${split}: the table is not ${label}`,
            );
            if (split !== '全部') {
              // every position: the chart's total (the legend's exact figures, from their hover) = the table's 合计 成功
              const chart = await page.evaluate(() =>
                [...document.querySelectorAll('#admin-overview .ovx-legend button .ad-tip')].reduce(
                  (a, t) => a + Number(((t.textContent ?? '').match(/ ([\d,]+) 条/)?.[1] ?? '0').replace(/,/g, '')),
                  0,
                ),
              );
              const table = await page.evaluate((aria: string) => {
                const row = document.querySelector(`#admin-overview [aria-label="${aria}"] .is-total`);
                const cells = row ? [...row.querySelectorAll('.ot-cell')] : [];
                return Number(
                  ((cells[1]?.firstChild?.textContent ?? cells[1]?.textContent ?? '') as string).replace(
                    /[^0-9]/g,
                    '',
                  ) || -1,
                );
              }, label);
              check(chart === table, `${size} ${span} ${split}: chart total ${chart} != table 合计 成功 ${table}`);
            }
          }
        }
      }
    }
  }
  if (errors.length) problems.push(...errors);
} catch (error) {
  failure = error;
} finally {
  if (reportFile) writeFileSync(reportFile, JSON.stringify({ totals, report }, null, 1));
  console.log('copy audit totals:', JSON.stringify(totals));
  for (const p of problems.slice(0, 400)) console.log(' -', p);
  await f.close?.();
}
if (failure) throw failure;
if (problems.length && !process.env.AUDIT_REPORT_ONLY) {
  console.error(`${problems.length} problem(s)`);
  process.exit(1);
}
console.log('admin 24b-7d copy audit + 24b-7e split: ok');
process.exit(0);
