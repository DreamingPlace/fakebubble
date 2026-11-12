import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { importLongContent } from './console-long-content-24b7b.ts';
import { AUDIT_SOURCE } from './admin-layout-audit-24b7c.ts';

/**
 * Part 24b-7c (offline provider only; nothing reaches a provider): the one layout system of the admin console, measured in a real
 * browser at 1280×800 and 1440×900 on the long-content fixture of 24b-7b. Every admin page, every 角色工作台 tab except 声音 (Part 30
 * rebuilds it; it is never measured) and the open state of the rows that open. Rules: docs/ADMIN_LAYOUT.md.
 *   buttons of one height scale and one group height · single-line fields within their width class · a field and its action on one row
 *   and one baseline · vertical gaps from the spacing scale, none above the section step · no heading without content · related
 *   checkboxes close together · no sideways scroll, no cut text · no avatar half hidden under the rail's group count.
 *
 * usage: node scripts/check-web-admin-24b7c-browser.ts [screenshot-dir] [report-json]   (run `pnpm web:player:build` first)
 *        AUDIT_REPORT_ONLY=1 prints the counts and exits 0 (how the "before" numbers of the PR were taken).
 */
const shots = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const reportFile = process.argv[3] ? resolve(process.argv[3]) : null;
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const report: Record<string, unknown> = {};
const totals: Record<string, number> = {};
let failure: unknown = null;
try {
  await importLongContent(f);
  const list = await (await f.post('characters/list', {})).json();
  const lqy = list.characters.find((c: { displayName: string }) => c.displayName === '青野').characterId as string;
  const page = await f.context.newPage();
  const errors: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' }); // no fade-in while measuring (the screenshots are of the settled page)
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  for (const size of ['1440x900', '1280x800']) {
    const [w, h] = size.split('x').map(Number);
    await page.setViewportSize({ width: w!, height: h! });
    const measure = async (name: string) => {
      await page.waitForTimeout(500);
      const result = (await page.evaluate(AUDIT_SOURCE)) as {
        counts: Record<string, number>;
        total: number;
        out: Record<string, string[]>;
      };
      report[`${size} ${name}`] = result.out;
      for (const [rule, n] of Object.entries(result.counts)) {
        totals[rule] = (totals[rule] ?? 0) + n;
        if (n) problems.push(`${size} ${name} · ${rule} · ${n}: ${result.out[rule]!.slice(0, 3).join(' | ')}`);
      }
      if (shots) await page.screenshot({ path: `${shots}/${size}-${name.replace(/[ /]/g, '_')}.png`, fullPage: true });
    };
    const go = async (hash: string, ready = '.admin-shell') => {
      await page.goto(`${f.origin}/?mode=provider-admin#/${hash}`);
      await page.reload();
      await page.locator(ready).first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(1900);
    };
    /** Opens (one at a time, then all together) the rows that open on a page: the "open state" of its rows. */
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
    for (const p of [
      'overview',
      'cast',
      'cocreation',
      'invites',
      'points',
      'conversations',
      'costs',
      'models',
      'system',
      'members',
      'account',
    ]) {
      await go(p);
      await measure(p);
      await openRows(p);
    }
    await go(`characters/${lqy}`, '.wb-tab');
    const tabs = (await page.$$eval('.wb-tab', (n: Element[]) =>
      n.map((x) => x.querySelector('span')!.textContent),
    )) as string[];
    for (const t of tabs) {
      if (t === '声音') continue; // Part 30 rebuilds it: not measured, not changed here
      await page.locator(`button.wb-tab:has(span:text-is("${t}"))`).first().click();
      await page.waitForTimeout(700);
      await measure(`角色工作台 ${t}`);
      if (t === '发布' || t === '预演') await openRows(`角色工作台 ${t}`);
    }
    await go('characters');
    await measure('角色工作台 目录');
  }
  if (errors.length) problems.push(...errors);
} catch (error) {
  failure = error;
} finally {
  if (reportFile) writeFileSync(reportFile, JSON.stringify({ totals, report }, null, 1));
  console.log('layout audit totals:', JSON.stringify(totals));
  for (const p of problems.slice(0, 400)) console.log(' -', p);
  await f.close?.();
}
if (failure) throw failure;
if (problems.length && !process.env.AUDIT_REPORT_ONLY) {
  console.error(`${problems.length} layout problem(s)`);
  process.exit(1);
}
console.log('admin 24b-7c layout audit: ok');
process.exit(0);
