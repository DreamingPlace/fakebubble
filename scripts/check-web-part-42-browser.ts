import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';

/**
 * Part 42 in a REAL browser (the console fixture, its OFFLINE provider and offline Fish):
 *   - 广播 compose: characters in console order, 1–3 bubbles with counters, a generated voice (cost on the button, confirmed by a second
 *     click, a take to listen to) and an uploaded WAV, 发送 asks in place with the numbers of characters and recipients;
 *   - the list moves (定时 / 发送中 / 已发送) and carries no player and no text; a scheduled one is edited and cancelled in the page;
 *   - a registered player's chat shows the received broadcast like any character message (a voice bubble with 转文字); a guest has none.
 *
 * usage: node scripts/check-web-part-42-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
try {
  const watch = (page: Page) => {
    page.on('pageerror', (e: unknown) => errors.push(String(e)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text()))
        errors.push(`console: ${m.text()}`);
    });
  };
  /** A registered player (an unlimited entitlement, as a redeemed code gives) in its own browser context. */
  const registered = async (width: number, height: number, who: string) => {
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page: Page = await ctx.newPage();
    watch(page);
    await page.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
    );
    await page.goto(`${f.origin}/?mode=provider`);
    await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    return { ctx, page, who };
  };
  const principalOf = (n: number) =>
    f.store.all<{ id: string }>("SELECT id FROM web_principals WHERE kind='guest' ORDER BY rowid DESC").at(n)
      ?.id as string;
  const entitle = (principalId: string) => {
    const now = f.clock.now();
    f.store.run(
      'INSERT OR IGNORE INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      principalId,
      `${principalId}@example.com`,
      'x',
      now,
      now,
      now,
    );
    f.store.run(
      "INSERT INTO web_entitlements(id,principal_id,source,kind,starts_at,expires_at,created_at) VALUES (?,?,'admin','unlimited',?,NULL,?)",
      `fixture:${principalId}`,
      principalId,
      now - 1,
      now,
    );
  };
  // two characters with a saved draft (the voice speaks from a revision), as the workbench leaves them
  for (const id of ['wei-guagua', 'jojo']) {
    const detail = await (await f.post(`characters/${id}/detail`, {})).json();
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await f.post(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
  }
  const G = await registered(1440, 900, 'g');
  const B = await registered(1440, 900, 'b');
  const A = await registered(390, 844, 'a');
  entitle(principalOf(0));
  entitle(principalOf(1));
  await wait(1500);
  const incomingNow = (p: { page: Page }) =>
    p.page.evaluate(() => document.querySelectorAll('.message-row.incoming').length);
  const baseline = { a: await incomingNow(A), b: await incomingNow(B), g: await incomingNow(G) };
  // the admin console
  const admin: Page = await f.context.newPage();
  watch(admin);
  const requests: string[] = [];
  admin.on('request', (r: { method: () => string; url: () => string }) => {
    if (r.method() === 'POST' && r.url().includes('/admin/broadcast/'))
      requests.push(r.url().replace(/^.*\/admin\//, ''));
  });
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    await admin.setViewportSize({ width, height });
    await admin.goto(`${f.origin}/?mode=provider-admin#/broadcast`);
    await admin.reload();
    await admin.locator('.bc-compose').waitFor({ timeout: 20_000 });
    check(await admin.locator('.admin-nav [data-page="broadcast"]').isVisible(), 'the nav has 广播');
    const order = await admin.locator('.bc-char span').allTextContents();
    check(order.length >= 3, `characters listed (${order.length})`);
    const recipientsText = (await admin.locator('.bc-recipients').textContent()) ?? '';
    check(/注册玩家 2 位/.test(recipientsText), `two registered players: ${recipientsText}`);
    check(
      (await admin.locator('#bc-send').isDisabled()) === true,
      'nothing to send yet: the button is off and says why',
    );
    if (width === 1440) {
      // ---- compose
      for (const id of ['wei-guagua', 'jojo', 'chen-jimi']) await admin.locator(`.bc-char[data-id="${id}"]`).click();
      await admin.locator('.bc-bubble').first().fill('大家好呀');
      await admin.getByText('再加一条').click();
      await admin.locator('.bc-bubble').nth(1).fill('今晚八点有个小活动');
      check((await admin.locator('.bc-count').textContent())?.includes('合计 13'), 'the counter counts');
      await admin.locator('.bc-voice[data-char="wei-guagua"]').waitFor();
      // 生成: the cost is on the button; the first click arms, the second sends
      const gen = admin.locator('.bc-voice[data-char="wei-guagua"]').locator('button.pw-send');
      await admin.waitForFunction(
        () => /\$/.test(document.querySelector('.bc-voice[data-char="wei-guagua"] button.pw-send')?.textContent ?? ''),
        null,
        { timeout: 15_000 },
      );
      // the confirm window is 6 s and a headless click can take longer: arm (a real click), check, and confirm inside one page turn
      const armed = await admin.evaluate(() => {
        const b = document.querySelector('.bc-voice[data-char="wei-guagua"] .pw-send') as HTMLButtonElement;
        b.click();
        const state = b.dataset.state;
        b.click();
        return state;
      });
      check(armed === 'confirm', 'the paid button arms on the first click');
      await admin.locator('.bc-voice[data-char="wei-guagua"]').getByText('已生成').waitFor({ timeout: 30_000 });
      await admin.locator('.bc-voice[data-char="wei-guagua"]').getByText(/试听/).click();
      // 上传 for the second character
      await wait(2000);
      await admin
        .locator('.bc-voice')
        .nth(1)
        .locator('input[type=file]')
        .setInputFiles({
          name: 'clip.wav',
          mimeType: 'audio/wav',
          buffer: Buffer.from(syntheticTone(800)),
        });
      await admin.locator('.bc-voice[data-char="jojo"]').getByText('已上传').waitFor({ timeout: 15_000 });
      if (shots) await admin.screenshot({ path: `${shots}/admin-compose-1440.png`, fullPage: true });
      // ---- 发送 asks in place and names the numbers
      await admin.locator('#bc-send').click();
      const bar = admin.locator('.bc-confirm .ic[data-state="open"]');
      await bar.waitFor({ timeout: 5_000 });
      const ask = (await bar.textContent()) ?? '';
      check(
        /3 个角色/.test(ask) && /2 位注册玩家/.test(ask) && /不能撤回/.test(ask),
        `the confirm names the numbers: ${ask}`,
      );
      if (shots) await admin.screenshot({ path: `${shots}/admin-confirm-1440.png`, fullPage: true });
      await bar.getByRole('button', { name: /确认发送/ }).click();
      await admin.locator('.bc-row[data-state="sent"]').waitFor({ timeout: 30_000 });
      const listText = (await admin.locator('.bc-list').textContent()) ?? '';
      check(!/大家好|今晚八点/.test(listText), 'the list carries no message content');
      check(!/@|principal|player-/.test(listText), 'the list carries no identity');
      // ---- schedule, edit, cancel
      const at = new Date(f.clock.now() + 3 * 3_600_000).toISOString();
      await admin.locator('.bc-bubble').first().fill('明天见');
      await admin.locator('.bc-char[data-on="false"]').count();
      await admin.locator('.bc-char').first().click();
      await admin.locator('[data-seg="later"]').click();
      await admin.locator('#bc-day').fill(at.slice(0, 10));
      await admin.locator('#bc-time').fill(at.slice(11, 16));
      await admin.locator('#bc-send').click();
      await admin
        .locator('.bc-confirm .ic[data-state="open"]')
        .getByRole('button', { name: /确认定时/ })
        .click();
      await admin.locator('.bc-row[data-state="scheduled"]').waitFor({ timeout: 15_000 });
      await admin.locator('.bc-row[data-state="scheduled"]').getByText('修改').click();
      await admin.locator('.bc-editbar[data-open="true"]').waitFor();
      await admin.locator('.bc-bubble').first().fill('后天见');
      await admin.locator('#bc-send').click();
      await admin
        .locator('.bc-confirm .ic[data-state="open"]')
        .getByRole('button', { name: /保存修改/ })
        .click();
      await admin
        .locator('.bc-editbar[data-open="true"]')
        .waitFor({ state: 'detached', timeout: 1 })
        .catch(() => undefined);
      await wait(600);
      if (shots) await admin.screenshot({ path: `${shots}/admin-list-1440.png`, fullPage: true });
      await admin.locator('.bc-row[data-state="scheduled"]').getByText('取消').click();
      await admin.locator('.bc-confirm .ic[data-state="open"]').getByRole('button', { name: '取消广播' }).click();
      await admin.locator('.bc-row[data-state="cancelled"]').waitFor({ timeout: 15_000 });
      check(
        ['send', 'update', 'cancel'].every((name) => requests.some((r) => r.endsWith(`/${name}`))),
        `routes used: ${requests.join(',')}`,
      );
    } else if (shots) await admin.screenshot({ path: `${shots}/admin-list-1280.png`, fullPage: true });
  }
  // ---- the players: the registered ones got a voice bubble (its words behind 转文字); the guest got nothing
  await wait(1500);
  const incoming = (p: { page: Page }) =>
    p.page.evaluate(() => document.querySelectorAll('.message-row.incoming').length);
  const reopen = async (p: { page: Page }) => {
    await p.page.reload();
    await p.page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    await wait(1500);
  };
  const openChat = async (p: { page: Page }) => {
    await p.page.reload();
    const card = p.page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await wait(1200);
    await card.click({ force: true });
    await p.page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await wait(1200);
    // the words of every incoming bubble, the voice ones through 转文字
    for (const toggle of await p.page.locator('.card-slot.is-active .transcript-toggle').all()) await toggle.click();
    return p.page.evaluate(() =>
      [...document.querySelectorAll('.card-slot.is-active .message-row.incoming')].map((r) => r.textContent ?? ''),
    );
  };
  const rowsA = await openChat(A);
  check(
    rowsA.some((t: string) => t.includes('大家好呀')),
    `the registered player (390) received the broadcast: ${rowsA.join(' / ')}`,
  );
  if (shots) await A.page.screenshot({ path: `${shots}/player-390.png` });
  const rowsB = await openChat(B);
  check(
    rowsB.some((t: string) => t.includes('大家好呀')),
    'the registered player (1440) received the broadcast',
  );
  if (shots) await B.page.screenshot({ path: `${shots}/player-1440.png` });
  const rowsG = await openChat(G);
  check(!rowsG.some((t: string) => t.includes('大家好呀')), 'the guest received nothing');
  void reopen;
  void incoming;
  void baseline;
  check(errors.length === 0, `page errors: ${errors.join(' | ')}`);
} finally {
  await f.close();
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('part 42 browser check passed');
assert.ok(true);
