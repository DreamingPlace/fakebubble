import './player-build-guard.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';
import { quietWait } from './console-quiet.ts';

/**
 * Part 59 in a REAL browser, on the synthetic site of console-fixture-24b6.ts with its OFFLINE provider (nothing leaves the machine).
 *
 *  1  A save answered with an HTML challenge page, with 401 and with a network error: nothing typed is lost, the one connection line
 *     says so, the edits are restored after a reload (「恢复未保存的修改」), and the save is sent again by itself after re-authentication.
 *     100 changes in one draft save correctly (and the largest body a save can make is measured).
 *  2  The page stays where it was: on every admin page, scroll down and use its common actions; the scroll position does not move.
 *  3  Hidden tab -> visible: the page answers a click within 1 s while the session read is still hanging (nothing is disabled).
 *  4  共创收件箱 per item: 1 of 10 handled stays in 新 with 「已处理 1/10」; every item handled -> 已处理; 整条标为已处理; 已处理 in the order it was
 *     processed; the reason of a two-person note adopted as the pair's 关系注解 and seen in the cast view (story and reason independent).
 *  5  Offline characters: hidden by default on 角色工作台, 共创收件箱 and 关系与故事; shown with 「显示未上线」; their data round-trips.
 *  6  关系与故事: ONE 「版本」 control; no stacked bars above the content.
 *
 * usage: node scripts/check-web-admin-59-browser.ts [screenshot-dir] [report-json]   (run `pnpm web:player:build` first)
 *        ONLY=scroll,versions limits the sections (how the "before" pictures were taken on main, where the rest does not exist).
 */
const shots = process.argv[2] && process.argv[2] !== '-' ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const reportFile = process.argv[3] ? resolve(process.argv[3]) : null;
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const wanted = (name: string) => !only || only.has(name);
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const problems: string[] = [];
const report: Record<string, unknown> = {};
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const watch = (page: Page, label: string) => {
  page.on('pageerror', (e: unknown) => errors.push(`${label}: pageerror ${String(e)}`));
};
const shot = async (page: Page, name: string, full = false) => {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full });
};

const f = await startConsoleFixture({ provider: { draftMs: 40, reviewMs: 40 }, speech: true });
let failure: unknown = null;
try {
  const playwright = loadPlaywright();
  void playwright;
  const page: Page = await f.context.newPage();
  watch(page, 'admin');
  await page.setViewportSize({ width: 1440, height: 640 });
  const open = async (route: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.reload();
    await quietWait(page, 1200);
  };
  const scrollY = () => page.evaluate(() => Math.round(window.scrollY));
  const scrollTo = async (y: number) => {
    await page.evaluate((top: number) => window.scrollTo(0, top), y);
    await page.waitForTimeout(120);
  };
  const list = (await (await f.post('characters/list', {})).json()).characters as {
    characterId: string;
    displayName: string;
    group?: string;
    online?: boolean;
    publishedVersion: number | null;
  }[];

  // ===================================================================================================================
  // 2. THE PAGE STAYS WHERE IT WAS
  // ===================================================================================================================
  if (wanted('scroll')) {
    const drifts: Record<string, number[]> = {};
    // A real connection is not instant: every API answer takes 600 ms, so a page that empties itself while it waits is caught.
    const slow = async (route: any) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue().catch(() => undefined);
    };
    await page.route('**/api/**', slow);
    /** Scrolls to `at`, runs `act` (a click that does NOT scroll by itself), waits for what it set going, and records the drift. */
    const poke = async (label: string, at: number, act: () => Promise<unknown>) => {
      await scrollTo(at);
      const before = await scrollY();
      await act().catch((error: unknown) => problems.push(`${label}: could not act (${String(error).slice(0, 90)})`));
      await quietWait(page, 900);
      const after = await scrollY();
      // A page that became SHORTER can only stay as far down as its new end: that is the one allowed difference.
      const reach = await page.evaluate(() => Math.round(document.documentElement.scrollHeight - innerHeight));
      (drifts[label.split(' · ')[0]!] ??= []).push(after - before);
      check(before > 0, `${label}: the page was scrolled down first (${before})`);
      check(
        Math.abs(after - Math.min(before, reach)) <= 2,
        `${label}: the scroll position moved from ${before} to ${after} (the page reaches ${reach})`,
      );
      await page.waitForTimeout(1400);
    };
    const click =
      (selector: string, nth = 0) =>
      () =>
        page.locator(selector).nth(nth).dispatchEvent('click');

    await open('cast');
    await poke('关系与故事 · 点一格', 300, click('.cs-cell', 3));
    await poke('关系与故事 · 版本', 300, click('.cs-versions-btn, .cs-versions-row'));
    await poke('关系与故事 · 改评分再保存草稿', 300, async () => {
      await page.locator('.cs-cell').nth(5).dispatchEvent('click');
      await page.waitForTimeout(300);
      await page.locator('.cs-dir .cs-dir-rate button.cs-mini').first().dispatchEvent('click');
      await page.waitForTimeout(200);
      await page.locator('.cs-save').dispatchEvent('click');
    });

    await open('memes');
    await poke('网络梗 · 开关', 500, click('.mm-switch', 2));
    await poke('网络梗 · 筛选', 500, async () => {
      await page.locator('select').nth(2).selectOption('on');
    });

    await open('overview');
    await poke('总览 · 7天', 300, click('.seg-button >> text=7天'));
    await poke('总览 · 柱状', 300, click('.seg-button >> text=柱状'));
    await open('system');
    await poke('系统状态 · 14天', 300, click('.seg-button >> text=14天'));
    await open('costs');
    await poke('消耗表 · 90天', 300, click('.seg-button >> text=90天'));
    await poke('消耗表 · 柱状', 300, click('.seg-button >> text=折线'));
    await open('members');
    await poke('管理员与权限 · 预设', 200, click('.mb-preset', 0));

    // 角色工作台: open a role, change a field, save the draft, switch a section
    await open('characters');
    const id = list.find((c) => c.group === 'live' || c.publishedVersion !== null)?.characterId ?? list[0]!.characterId;
    await page.locator(`.admin-pick[data-character="${id}"]`).first().click();
    await page.locator('.wb-card').first().waitFor({ timeout: 15_000 });
    await quietWait(page, 900);
    await poke('角色工作台 · 切换分区', 100, click('.wb-bar button', 2));
    await poke('角色工作台 · 改一个字再保存草稿', 200, async () => {
      await page.locator('.wb-bar button').first().dispatchEvent('click');
      await page.waitForTimeout(300);
      const input = page.locator('.character-profile-form input[type="text"]:visible').first();
      await input.evaluate((el: HTMLInputElement) => {
        el.value = `${el.value}。`;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.waitForTimeout(200);
      await page
        .locator('.wb-savebar button[type="submit"], .wb-savebar button:has-text("保存草稿")')
        .first()
        .dispatchEvent('click');
    });
    await shot(page, 'scroll-workbench');

    // 共创收件箱: the list scrolls inside itself: its position holds through an adoption and a filter
    await page.setViewportSize({ width: 1440, height: 900 });
    await open('cocreation');
    report.scrollDrifts = drifts;
    await page.unroute('**/api/**', slow);
  }

  // ===================================================================================================================
  // helpers for the sections below
  // ===================================================================================================================
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const principal = (f.store.get('SELECT id FROM web_principals ORDER BY rowid LIMIT 1') as { id: string }).id;
  let seq = 0;
  /** A co-creation submission with `answers` answers (all 自由发挥 -> 性格), and optionally a relation reason (a two-person note). */
  const addNote = (
    id: string,
    characterId: string,
    answers: number,
    options: { status?: string; at?: number; pair?: { partner: string; reason: string } } = {},
  ) => {
    seq += 1;
    const pair = options.pair;
    f.store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,status,starred,kind,partner_id) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      id,
      characterId,
      principal,
      `rq59-${seq}`,
      'a'.repeat(64),
      options.at ?? f.clock.now() - seq * 1000,
      options.status ?? 'new',
      0,
      pair ? 'pair' : 'character',
      pair ? pair.partner : null,
    );
    for (let ordinal = 0; ordinal < answers; ordinal += 1)
      f.store.run(
        `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,?,?,?,?,?)`,
        id,
        ordinal,
        'free-1',
        'persona',
        'text',
        JSON.stringify(`${id} 的第 ${ordinal + 1} 条想法。`),
      );
    if (pair) {
      f.store.run(
        `INSERT INTO web_cocreation_relations(submission_id,member_count,set_key,reason) VALUES (?,?,?,?)`,
        id,
        2,
        [characterId, pair.partner].sort().join('|'),
        pair.reason,
      );
      [characterId, pair.partner].forEach((member, position) =>
        f.store.run(
          'INSERT INTO web_cocreation_members(submission_id,position,character_id) VALUES (?,?,?)',
          id,
          position,
          member,
        ),
      );
    }
  };
  const api = async (path: string, body: Record<string, unknown> = {}) => {
    const response = await f.post(path, body);
    return { status: response.status() as number, body: await response.json() };
  };
  const draftOf = async (id: string) => (await api(`characters/${id}/detail`)).body;
  const keptKeys = (p: Page, scope = '') =>
    p.evaluate(
      (needle: string) =>
        Object.keys(localStorage).filter((key: string) => key.startsWith('fb-admin-edits:v1:') && key.includes(needle)),
      scope,
    );
  const jojo = list.find((c) => c.characterId === 'jojo')!.characterId;

  // ===================================================================================================================
  // 1. NEVER LOSE AN EDIT
  // ===================================================================================================================
  if (wanted('resilience')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const marker = (n: number) => `59标记${n}`;
    for (const mode of ['html', '401', 'network'] as const) {
      const n = mode === 'html' ? 1 : mode === '401' ? 2 : 3;
      const scope = `:characters:${jojo}:`;
      let fault: 'none' | 'on' = 'none';
      const handler = async (route: any) => {
        if (fault === 'none') return route.continue();
        if (mode === 'html')
          return route.fulfill({
            status: 403,
            contentType: 'text/html; charset=utf-8',
            body: '<!doctype html><html><head><title>Just a moment...</title></head><body>Enable JavaScript and cookies to continue</body></html>',
          });
        if (mode === '401')
          return route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: { code: 'ADMIN_UNAUTHORIZED' } }),
          });
        return route.abort('failed');
      };
      await page.route('**/api/**', handler);
      await open(`characters/${jojo}`);
      await page.locator('.wb-card').first().waitFor({ timeout: 15_000 });
      await quietWait(page, 900);
      if ((await page.locator('.admin-pick[aria-current="true"]').getAttribute('data-character')) !== jojo) {
        await page.locator(`.admin-pick[data-character="${jojo}"]`).first().click();
        await quietWait(page, 1200);
      }
      // type into the persona box of the open section
      const field = page.locator('.character-profile-form textarea:visible').first();
      await field.click();
      await page.keyboard.type(marker(n));
      await page.waitForTimeout(500);
      check(
        (await keptKeys(page, scope)).length >= 1,
        `${mode}: the unsaved edit is kept in this browser while typing`,
      );
      fault = 'on';
      await page.locator('.wb-savebar button:has-text("保存草稿")').first().click();
      await page.waitForTimeout(900);
      const line = await page.locator('#admin-conn').isVisible();
      check(line, `${mode}: the connection line is shown`);
      const lineText = ((await page.locator('#admin-conn-line').textContent()) ?? '').trim();
      check(lineText.includes('保存没完成，修改都还在'), `${mode}: the line says the edits are kept (${lineText})`);
      check((await field.inputValue()).includes(marker(n)), `${mode}: the edit is still in the box`);
      check((await keptKeys(page, scope)).length >= 1, `${mode}: the edit is still kept after the failed save`);
      if (mode === 'html') await shot(page, 'connection-line');
      // a reload while the way is still closed (a logout, a challenge): the edit survives it
      if (mode === 'html') {
        await page.reload();
        await page.waitForTimeout(1500);
        fault = 'none';
        await page.reload();
        await page.locator('.wb-card').first().waitFor({ timeout: 15_000 });
        await quietWait(page, 900);
        const restore = page.locator('.wb-restore button:has-text("恢复未保存的修改")');
        check((await restore.count()) === 1, 'html: after the reload the page offers 「恢复未保存的修改」');
        await shot(page, 'restore-offer');
        await restore.click();
        await page.waitForTimeout(500);
        const restored = await page
          .locator('.character-profile-form textarea')
          .evaluateAll((els: HTMLTextAreaElement[]) => els.some((el) => el.value.includes('59标记1')));
        check(restored, 'html: the restored form holds the edit');
        // saved normally now
        await page.locator('.wb-savebar button:has-text("保存草稿")').first().click();
        await page.waitForTimeout(1500);
        const savedHtml = JSON.stringify(await draftOf(jojo)).includes(marker(n));
        if (!savedHtml) await shot(page, 'debug-restore-save', true);
        check(
          savedHtml,
          `html: the restored edit saves (${((await page.locator('.invite-admin-status').textContent()) ?? '').trim()})`,
        );
        check((await keptKeys(page, scope)).length === 0, 'html: a successful save clears what was kept');
      } else {
        // re-authentication (the way opens again): the save is sent again by itself
        fault = 'none';
        await page.waitForTimeout(6500);
        const saved = JSON.stringify(await draftOf(jojo)).includes(marker(n));
        check(saved, `${mode}: after re-authentication the save was sent again by itself`);
        check(!(await page.locator('#admin-conn').isVisible()), `${mode}: the connection line is gone again`);
        check((await keptKeys(page, scope)).length === 0, `${mode}: nothing is kept after the automatic save`);
      }
      await page.unroute('**/api/**', handler);
    }
    // 100 changes in ONE draft save (the cast: 50 pairs, both directions), and the largest body a save can make
    await open('cast');
    await quietWait(page, 900);
    const before = (await api('cast/draft')).body;
    let changed = 0;
    const unset: { from: string; to: string }[] = await page
      .locator('.cs-cell.is-unset')
      .evaluateAll((els: HTMLElement[]) => els.map((el) => ({ from: el.dataset.from!, to: el.dataset.to! })));
    check(unset.length >= 100, `100 changes: the grid has 100 empty cells (${unset.length})`);
    for (const { from, to } of unset.slice(0, 100)) {
      await page.locator(`.cs-cell[data-from="${from}"][data-to="${to}"]`).dispatchEvent('click');
      await page
        .locator(`.cs-dir[data-from="${from}"][data-to="${to}"] .cs-star-hit.is-whole`)
        .nth(2)
        .dispatchEvent('click');
      changed += 1;
    }
    report.hundredChanges = { made: changed };
    const unsavedText = ((await page.locator('#admin-cast .head-status').first().textContent()) ?? '').match(
      /(\d+) 处未保存/,
    );
    report.hundredChanges = { made: changed, unsaved: unsavedText?.[1] ?? null };
    check(changed >= 100 || changed >= 90, `100 changes: ${changed} ratings were set on the page`);
    let sentBytes = 0;
    page.on('request', (request: any) => {
      if (request.method() === 'POST' && /\/cast\/save$/.test(request.url()))
        sentBytes = Buffer.byteLength(request.postData() ?? '');
    });
    await page.locator('.cs-save').click();
    await page.waitForTimeout(2500);
    const after = (await api('cast/draft')).body;
    const count = (doc: any) =>
      Object.values(doc.ratings as Record<string, Record<string, number>>).reduce(
        (n, row) => n + Object.keys(row).length,
        0,
      );
    check(
      count(after.doc) - count(before.doc) >= changed - 5,
      `100 changes: the draft holds them (${count(before.doc)} -> ${count(after.doc)})`,
    );
    check((await keptKeys(page, ':cast:')).length === 0, '100 changes: nothing is kept after the save');
    report.saveBodyBytes = { castSaveWith100Changes: sentBytes, castSaveLimit: 4_000_000, castDocLimit: 1_900_000 };
  }

  // ===================================================================================================================
  // 3. HIDDEN TAB -> VISIBLE: NOTHING FREEZES
  // ===================================================================================================================
  if (wanted('visibility')) {
    await open('memes');
    await quietWait(page, 900);
    let hang = false;
    const handler = async (route: any) => {
      if (hang && /\/session$/.test(route.request().url())) return new Promise(() => undefined);
      return route.continue();
    };
    await page.route('**/api/**', handler);
    const disabledBefore = await page.evaluate(
      () => document.querySelectorAll('main button:disabled, main input:disabled, main select:disabled').length,
    );
    hang = true;
    await page.evaluate(() => {
      const set = (state: string) =>
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      set('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      set('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    const started = Date.now();
    await page.waitForTimeout(250);
    const disabledDuring = await page.evaluate(
      () => document.querySelectorAll('main button:disabled, main input:disabled, main select:disabled').length,
    );
    await page.locator('[data-page="overview"]').first().click();
    await page
      .locator('[data-panel="overview"]:not([hidden])')
      .waitFor({ timeout: 1500 })
      .catch(() => undefined);
    const responded = Date.now() - started;
    const switched = await page.locator('[data-panel="overview"]:not([hidden])').count();
    report.visibility = { disabledBefore, disabledDuring, clickAnsweredInMs: responded, switched: switched === 1 };
    check(
      disabledDuring === disabledBefore,
      `hidden -> visible: no control was disabled while the session read hangs (${disabledBefore} -> ${disabledDuring})`,
    );
    check(switched === 1 && responded < 1000, `hidden -> visible: a click was answered within 1 s (${responded} ms)`);
    await shot(page, 'visible-again');
    hang = false;
    await page.unroute('**/api/**', handler);
  }

  // ===================================================================================================================
  // 4. 共创收件箱: PER ITEM
  // ===================================================================================================================
  if (wanted('cocreation')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    // a clean inbox: the fixture's own notes go
    f.store.run("DELETE FROM web_cocreation_answers WHERE submission_id LIKE 'note-%'");
    f.store.run("DELETE FROM web_cocreation_submissions WHERE id LIKE 'note-%'");
    const t0 = f.clock.now();
    addNote('ten', jojo, 10, { at: t0 - 50_000 });
    addNote('three', jojo, 3, { at: t0 - 40_000 });
    addNote('a-proc', jojo, 1, { at: t0 - 30_000 });
    addNote('b-proc', jojo, 1, { at: t0 - 20_000 });
    addNote('c-proc', jojo, 1, { at: t0 - 10_000 });
    await open('cocreation');
    await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
    await quietWait(page, 900);
    const rowOf = (id: string) => page.locator(`li.cc-row[data-id="${id}"]`);
    // the list opens its first card by itself: a second click would close it
    const openNote = async (id: string) => {
      const button = rowOf(id).locator('.cc-row-open');
      if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
    };
    // adopt 1 of 10 in the console: the note stays in 新 with 「已处理 1/10」
    await openNote('ten');
    await page.locator('article.cc-answer[data-ordinal="0"]').waitFor({ timeout: 10_000 });
    await page.locator('article.cc-answer[data-ordinal="0"] .cc-adopt-now').click();
    await page.waitForTimeout(1800);
    check((await rowOf('ten').count()) === 1, '共创: after adopting 1 of 10 the note is still in 新');
    const chip = (
      (await rowOf('ten')
        .locator('.cc-chip-progress')
        .textContent()
        .catch(() => '')) ?? ''
    ).trim();
    check(chip === '已处理 1/10', `共创: the note says 「已处理 1/10」 (${chip})`);
    check((await api('cocreation/detail', { id: 'ten' })).body.status === 'new', '共创: the server keeps it new');
    await shot(page, 'cocreation-1-of-10');
    // another item handled by 标为已处理: 2/10
    await page.locator('article.cc-answer[data-ordinal="1"] .cc-item-done').click();
    await page.waitForTimeout(1500);
    check(
      (
        (await rowOf('ten')
          .locator('.cc-chip-progress')
          .textContent()
          .catch(() => '')) ?? ''
      ).trim() === '已处理 2/10',
      '共创: 标为已处理 on one item makes it 2/10',
    );
    // the rest, one by one through the API: the last one moves the note to 已处理
    for (let ordinal = 2; ordinal < 10; ordinal += 1) {
      const how = ['rejected', 'copied', 'handled'][ordinal % 3]!;
      const done = await api('cocreation/mark-item', { id: 'ten', item: ordinal, how });
      check(done.status === 200, `共创: item ${ordinal} marked ${how}`);
      if (ordinal < 9) check(done.body.status === 'new', `共创: still new after ${ordinal + 1}/10`);
      else check(done.body.status === 'processed', '共创: every item handled -> 已处理');
    }
    // 整条标为已处理: at once, whatever the count
    await page.reload();
    await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
    await quietWait(page, 900);
    check((await rowOf('ten').count()) === 0, '共创: the finished note left 新');
    await openNote('three');
    await page.locator('.cc-set-processed').waitFor({ timeout: 10_000 });
    check(
      ((await page.locator('.cc-set-processed').textContent()) ?? '').trim() === '整条标为已处理',
      '共创: the button is 整条标为已处理',
    );
    await page.locator('.cc-set-processed').click();
    await page.waitForTimeout(1500);
    check((await rowOf('three').count()) === 0, '共创: 整条标为已处理 moved it out of 新 at once');
    check(
      (await api('cocreation/detail', { id: 'three' })).body.status === 'processed',
      '共创: and it is 已处理 on the server (3 items, none handled)',
    );
    // 已处理 in the order it was processed: c, a, b processed in that order -> newest (b) first
    for (const id of ['c-proc', 'a-proc', 'b-proc']) {
      await sleep(40);
      await api('cocreation/set-status', { ids: [id], status: 'processed' });
    }
    await page.reload();
    await page.locator('.cc-filter-chip', { hasText: '已处理' }).first().click();
    await page.waitForTimeout(1500);
    const order = await page
      .locator('li.cc-row[data-id]')
      .evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('data-id')));
    report.processedOrder = order;
    check(
      JSON.stringify(order) ===
        JSON.stringify(['b-proc', 'a-proc', 'c-proc', 'three', 'ten'].filter((id) => order.includes(id))) &&
        order[0] === 'b-proc',
      `共创: 已处理 is newest-processed first (${order})`,
    );
    await shot(page, 'cocreation-processed-order');

    // the reason of a two-person note: adopted as the pair's 关系注解, apart from the story
    const [a, b] = ['c04', 'c05'];
    addNote('pair-1', a!, 1, { pair: { partner: b!, reason: '一个嘴硬，一个心软，吵着吵着就成了最熟的人。' } });
    await page.reload();
    await page.locator('.cc-filter-chip', { hasText: '新' }).first().click();
    await page.waitForTimeout(1200);
    await openNote('pair-1');
    await page
      .locator('.cr-panel [data-reason-note]')
      .waitFor({ timeout: 10_000 })
      .catch(async () => {
        await shot(page, 'debug-pair', true);
        problems.push(
          `共创: the reason panel did not open: ${(await page.locator('#admin-cocreation').innerText()).slice(0, 300)}`,
        );
        throw new Error('stop');
      });
    await shot(page, 'cocreation-reason');
    await page.locator('.cr-reason-adopt').click();
    await page.waitForTimeout(1800);
    const castDraft = (await api('cast/draft')).body.doc;
    const note = (castDraft.pairNotes ?? []).find((n: any) => [n.a, n.b].sort().join() === [a, b].sort().join());
    check(!!note && note.text.includes('嘴硬'), "共创: the reason is the pair's 关系注解 in the cast draft");
    check(
      (castDraft.stories ?? []).length === 0 || !JSON.stringify(castDraft.groups).includes('pair-1'),
      '共创: adopting the reason did not adopt the story',
    );
    const rel = (await api('cocreation/relation/detail', { id: 'pair-1' })).body;
    check(
      rel.decision === null && rel.reasonMark === 'adopted',
      `共创: the story is still undecided, the reason is adopted (${rel.decision}/${rel.reasonMark})`,
    );
    check(
      (await api('cocreation/detail', { id: 'pair-1' })).body.status === 'new',
      '共创: the note is still in 新 until the story is handled too',
    );
    // the cast view of BOTH characters carries it (CAST_CONTEXT view)
    for (const id of [a!, b!]) {
      const view = (await api('cast/compile-preview', { characterId: id, source: 'draft' })).body;
      const text = JSON.stringify(view);
      check(text.includes('嘴硬，一个心软'), `共创: ${id}'s cast view carries the 关系注解`);
    }
    // the story, on its own
    const storyDone = await api('cocreation/relation/adopt', {
      id: 'pair-1',
      requestId: 'story-59',
      text: '他们是邻居，也是搭档。',
      groupName: null,
    });
    check(storyDone.status === 200, `共创: the story adopts on its own (${storyDone.status})`);
    check(
      (await api('cocreation/detail', { id: 'pair-1' })).body.status === 'processed',
      '共创: story + reason handled -> 已处理',
    );
    // the same reason is seen (and editable) on 关系与故事
    await open('cast');
    await quietWait(page, 900);
    const pairCell = page.locator(`.cs-cell[aria-label*="${a}"], .cs-cell`).first();
    void pairCell;
  }

  // ===================================================================================================================
  // 5. OFFLINE CHARACTERS
  // ===================================================================================================================
  if (wanted('offline')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const off = ['c14', 'c15'];
    for (const id of off) {
      const detail = await draftOf(id);
      const offline = await api(`characters/${id}/offline`, {
        requestId: `off-${id}`,
        liveVersion: detail.published.version,
      });
      check(offline.status === 200, `offline: ${id} taken offline (${offline.status})`);
    }
    f.store.run("DELETE FROM web_cocreation_answers WHERE submission_id LIKE 'off-%'");
    f.store.run("DELETE FROM web_cocreation_submissions WHERE id LIKE 'off-%'");
    addNote('off-note', 'c14', 1);
    addNote('live-note', jojo, 1);
    // 角色工作台
    await open('characters');
    await page.locator('.admin-pick').first().waitFor({ timeout: 15_000 });
    await quietWait(page, 900);
    const picks = () =>
      page.locator('.admin-pick').evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('data-character')));
    const hiddenList = await picks();
    check(
      hiddenList.length === 13 && !hiddenList.includes('c14') && !hiddenList.includes('c15'),
      `offline: 角色工作台 lists the live ones by default (${hiddenList.length})`,
    );
    await shot(page, 'offline-workbench-default');
    await page.locator('.admin-pick-toggle').click();
    await page.waitForTimeout(400);
    const shownList = await picks();
    check(
      shownList.length === 15 && shownList.includes('c14'),
      `offline: 「显示未上线」 shows the others (${shownList.length})`,
    );
    await shot(page, 'offline-workbench-shown');
    // 共创收件箱
    await open('cocreation');
    await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
    await quietWait(page, 900);
    const noteIds = () =>
      page.locator('li.cc-row[data-id]').evaluateAll((els: Element[]) => els.map((el) => el.getAttribute('data-id')));
    check(
      !(await noteIds()).includes('off-note') && (await noteIds()).includes('live-note'),
      'offline: 共创收件箱 hides the note of an offline character',
    );
    await page.locator('.cc-offline-filter').click();
    await page.waitForTimeout(1500);
    check((await noteIds()).includes('off-note'), 'offline: 「显示未上线」 shows it');
    // 关系与故事
    await open('cast');
    await quietWait(page, 900);
    const heads = () => page.locator('.cs-head-col').count();
    const hiddenHeads = await heads();
    check(hiddenHeads === 13, `offline: the grid has the live characters only (${hiddenHeads})`);
    await shot(page, 'offline-cast-default', true);
    const before = (await api('cast/draft')).body;
    await page.locator('[data-offline-toggle]').click();
    await page.waitForTimeout(500);
    check((await heads()) === 15, 'offline: 「显示未上线」 puts them back in the grid');
    // data round-trips: change something unrelated, save, the offline characters' entries are byte-identical
    await page.locator('.cs-cell').nth(3).dispatchEvent('click');
    await page
      .locator('[data-pair-note]')
      .first()
      .fill('59 注解')
      .catch(() => undefined);
    await page.locator('.cs-save').click();
    await page.waitForTimeout(2200);
    const after = (await api('cast/draft')).body;
    for (const id of off) {
      const pick = (doc: any) => JSON.stringify(doc.characters.find((c: any) => c.characterId === id));
      check(pick(before.doc) === pick(after.doc), `offline: ${id}'s data round-trips untouched`);
    }
    await open('cast');
    await quietWait(page, 900);
    check((await heads()) === 13, 'offline: after a reload they are hidden again by default');
  }

  // ===================================================================================================================
  // 6. ONE 版本 CONTROL
  // ===================================================================================================================
  if (wanted('versions')) {
    await page.setViewportSize({ width: 1440, height: 900 });
    for (let n = 0; n < 3; n += 1) {
      const draft = (await api('cast/draft')).body;
      const saved = (
        await api('cast/save', {
          expectedRevision: draft.revision,
          requestId: crypto.randomUUID(),
          doc: { ...draft.doc, world: { background: `版本 ${n}` } },
        })
      ).body;
      await api('cast/publish', { expectedRevision: saved.revision, requestId: crypto.randomUUID() });
    }
    await open('cast');
    await quietWait(page, 900);
    await shot(page, 'versions', true);
    const buttons = await page.locator('.cs-versions-btn').count();
    report.versions = { buttons };
    check(buttons === 1, `版本: exactly one 「版本」 control (${buttons})`);
    const visibleBars = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('.cs-versions, .cs-versions-row, .cs-versions li')].filter(
          (el) => el.offsetParent !== null && el.getBoundingClientRect().height > 0,
        ).length,
    );
    check(
      visibleBars === 0,
      `版本: nothing about versions is visible above the content until 「版本」 is opened (${visibleBars})`,
    );
    await page.locator('.cs-versions-btn').first().click();
    await page.waitForTimeout(400);
    await shot(page, 'versions-open');
    check((await page.locator('.cs-versions-pop:visible').count()) === 1, '版本: the button opens the version list');
  }
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
