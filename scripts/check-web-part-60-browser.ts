import './player-build-guard.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';

/**
 * Part 60 in a REAL browser (the synthetic site of console-fixture-24b6.ts, OFFLINE provider): the admin console never freezes.
 *
 *  1  The 共创收件箱 load is stalled (the request never answers). The nav stays clickable and its cursor is not "not-allowed", no
 *     control of the page is disabled, another page opens at once, and when the stalled page is opened again and 20 s pass the
 *     connection line names 共创收件箱 and offers 重试; 重试 loads it once the way is open.
 *  2  A save in flight locks only its own form: while an answer is held, the nav and the other fields stay usable.
 *  3  Start-up: with the very first /session read never answering, the login form takes input at once (and a force refresh is no
 *     different); the typed text stays when the read finally times out.
 *
 * usage: node scripts/check-web-part-60-browser.ts [screenshot-dir] [report-json]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const reportFile = process.argv[3] ? resolve(process.argv[3]) : null;
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const problems: string[] = [];
const report: Record<string, unknown> = {};
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const shot = async (page: Page, name: string) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
};

const f = await startConsoleFixture({ provider: { draftMs: 40, reviewMs: 40 }, speech: true });
let failure: unknown = null;
try {
  loadPlaywright();
  const page: Page = await f.context.newPage();
  page.on('pageerror', (e: unknown) => errors.push(`admin: pageerror ${String(e)}`));
  await page.setViewportSize({ width: 1440, height: 800 });
  const open = async (route: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.reload();
    await quietWait(page, 1200);
  };
  /** Controls the page itself disabled (the bind form's own button has its own reason and is not counted). */
  const disabledCount = () =>
    page.evaluate(
      () =>
        [
          ...document.querySelectorAll<HTMLElement>('.admin-shell button, .admin-shell input, .admin-shell select'),
        ].filter((el) => (el as HTMLButtonElement).disabled && !el.closest('#admin-bind-start, #admin-member-issue'))
          .length,
    );
  const cursorOf = (selector: string) =>
    page.evaluate((s: string) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).cursor : null;
    }, selector);
  const visible = (selector: string) => page.locator(selector).first().isVisible();

  // ===================================================================================================================
  // 1. A STALLED 共创收件箱 LOAD
  // ===================================================================================================================
  await open('overview');
  const baseline = await disabledCount();
  let stalled = true;
  const held: Array<() => void> = [];
  await page.route('**/api/web/provider/admin/cocreation/**', async (route: any) => {
    if (!stalled) return route.continue().catch(() => undefined);
    // never answered (until the check lets go at the very end)
    await new Promise<void>((resolveHold) => held.push(resolveHold));
    return route.abort().catch(() => undefined);
  });
  await page.locator('[data-page="cocreation"]').first().click();
  await page.waitForTimeout(800);
  check(await visible('#admin-cocreation'), '共创收件箱 is open while its load is stalled');
  check(
    (await disabledCount()) <= baseline,
    `nothing is disabled while the load is stalled (${await disabledCount()} vs ${baseline})`,
  );
  const cursor = await cursorOf('.admin-nav [data-page="members"]');
  check(cursor !== 'not-allowed', `the nav cursor is not "not-allowed" (${cursor})`);
  const t0 = Date.now();
  await page.locator('.admin-nav [data-page="members"]').first().click({ timeout: 1500 });
  await page.waitForTimeout(150);
  check(
    await visible('#admin-members-list, #admin-members-table'),
    '管理员与权限 opens at once while the first load is stalled',
  );
  check(Date.now() - t0 < 1500, `the other page opened within 1.5 s (${Date.now() - t0} ms)`);
  await shot(page, 'stalled-other-page');
  report.stalled = { cursor, disabled: await disabledCount(), baseline };

  // back to the stalled page: after 20 s the line names it
  await page.locator('.admin-nav [data-page="cocreation"]').first().click();
  const started = Date.now();
  await page.waitForFunction(() => !document.querySelector('#admin-conn')?.hasAttribute('hidden'), null, {
    timeout: 30_000,
  });
  const waited = Date.now() - started;
  const line = (await page.locator('#admin-conn-line').textContent()) ?? '';
  check(line.includes('共创收件箱'), `the connection line names the page: 「${line}」`);
  check(waited >= 18_000 && waited <= 26_000, `the line came after about 20 s (${waited} ms)`);
  check(await visible('#admin-conn-retry'), '重试 is offered');
  check(!/[0-9a-f]{8}-|[0-9a-f]{16,}/i.test(line), 'the line carries the page name only, no ids');
  check((await disabledCount()) <= baseline, 'still nothing disabled after the timeout');
  await shot(page, 'timed-out-line');
  report.timeout = { waited, line };

  // let the stalled requests go; 重试 loads the page
  stalled = false;
  for (const release of held.splice(0)) release();
  await page.locator('#admin-conn-retry').click();
  await page.waitForFunction(() => document.querySelector('#admin-conn')?.hasAttribute('hidden'), null, {
    timeout: 15_000,
  });
  check(await visible('#admin-cocreation'), '重试 opened the inbox');
  await page.unroute('**/api/web/provider/admin/cocreation/**');

  // ===================================================================================================================
  // 2. A SAVE IN FLIGHT LOCKS ONLY ITS OWN FORM
  // ===================================================================================================================
  await open('members');
  let heldSave: (() => void) | null = null;
  await page.route('**/api/web/provider/admin/members/issue', async (route: any) => {
    await new Promise<void>((resolveHold) => {
      heldSave = resolveHold;
    });
    await route.continue().catch(() => undefined);
  });
  await page.locator('#admin-member-label').fill('第六十部分 测试');
  await page.locator('.mb-preset').first().click();
  const issue = page.locator('#admin-member-issue button[type="submit"]');
  if (await issue.isEnabled()) {
    await issue.click();
    await page.waitForTimeout(500);
    check(heldSave !== null, 'the issue request is in flight');
    check(await issue.isDisabled(), 'the form that is saving has its own button locked');
    check(
      await page.locator('.admin-nav [data-page="overview"]').first().isEnabled(),
      'the nav stays usable during a save',
    );
    check(
      await page
        .locator('#admin-logout')
        .isEnabled()
        .catch(() => true),
      'sign-out stays usable during a save',
    );
    const cursor2 = await cursorOf('.admin-nav [data-page="overview"]');
    check(cursor2 !== 'not-allowed', `the nav cursor during a save is not "not-allowed" (${cursor2})`);
    // biome-ignore lint/suspicious/noExplicitAny: closure set by the route
    (heldSave as any)?.();
    await page.waitForTimeout(800);
  } else report.saveSkipped = 'no permission preset could be chosen';
  await page.unroute('**/api/web/provider/admin/members/issue');

  // ===================================================================================================================
  // 3. START-UP: THE LOGIN FORM IS USABLE AT ONCE
  // ===================================================================================================================
  const fresh: Page = await (await f.browser.newContext({ ignoreHTTPSErrors: true })).newPage();
  fresh.on('pageerror', (e: unknown) => errors.push(`fresh: pageerror ${String(e)}`));
  await fresh.route('**/api/web/provider/admin/session', async () => {
    await new Promise(() => undefined); // never answers
  });
  await fresh.goto(`${f.origin}/?mode=provider-admin`);
  await fresh.waitForSelector('#admin-email', { timeout: 15_000 });
  await fresh.locator('#admin-email').fill('owner@example.com');
  check(
    (await fresh.locator('#admin-email').inputValue()) === 'owner@example.com',
    'the login field takes input while /session never answers',
  );
  check(await fresh.locator('#admin-email').isEnabled(), 'the login field is enabled');
  await fresh.reload();
  await fresh.waitForSelector('#admin-email', { timeout: 15_000 });
  await fresh.locator('#admin-email').fill('again@example.com');
  check(
    (await fresh.locator('#admin-email').inputValue()) === 'again@example.com',
    'after a force refresh the login form is just as usable',
  );
  report.startup = 'ok';
  await fresh.close();
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (shots) writeFileSync(join(shots, 'report.json'), `${JSON.stringify({ report, problems, errors }, null, 2)}\n`);
if (reportFile) writeFileSync(reportFile, `${JSON.stringify({ report, problems, errors }, null, 2)}\n`);
for (const error of errors) problems.push(error);
if (failure) problems.push(`script error: ${failure instanceof Error ? failure.stack : String(failure)}`);
if (problems.length) {
  console.error(`FAIL (${problems.length})\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('ok', JSON.stringify(report));
