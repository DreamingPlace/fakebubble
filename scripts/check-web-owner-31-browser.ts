import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 31 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts: 首页顺序 (drag by keyboard, saved for the home page),
 * the avatar upload (circle, 保存草稿, 发布 with no 预演, the public picture's headers), 整理预演 (select, one confirm naming the count,
 * the bills stay), 测试对话 deletion and 已关闭账号 (policy, list, delete one) - and what a non-owner does NOT see. At 1440×900 and 1280×800.
 *
 * usage: node scripts/check-web-owner-31-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const SIZES = [
  [1440, 900],
  [1280, 800],
] as const;
const FIXTURES = new URL('../tests/web/fixtures/avatars/', import.meta.url);

const f = await startConsoleFixture({ provider: { draftMs: 80, reviewMs: 80 }, chatReview: true });
const errors: string[] = [];
let failure: unknown = null;
try {
  const okPost = async (path: string, data: unknown) => {
    const response = await f.post(path, data);
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response.json();
  };
  const T = Date.parse('2026-11-20T10:00:00Z');
  // ---- 已关闭账号 and 测试对话: archived copies (no foreign keys), as the transaction that closes an account writes them ----
  const archive = (label: string, code: string, characterId: string, lines: string[], at: number) =>
    lines.forEach((text, i) =>
      f.store.run(
        'INSERT INTO web_review_archive VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        label,
        code,
        characterId,
        i,
        '2026-11-18 21:0' + i,
        i % 2 ? 'character' : 'player',
        text,
        'ok',
        null,
        0,
        at,
        at + 180 * 86_400_000,
      ),
    );
  const closed = (code: string, number: string, daysAgo: number) =>
    f.store.run(
      'INSERT INTO web_closed_accounts VALUES (?,?,?,?)',
      code,
      number,
      T - daysAgo * 86_400_000,
      T + (180 - daysAgo) * 86_400_000,
    );
  const seed = () => {
    f.store.run('DELETE FROM web_review_archive');
    f.store.run('DELETE FROM web_closed_accounts');
    archive('JOJO-K7M2', 'K7M2', 'jojo', ['你好', '在的', '今天好吗', '还不错'], T - 2 * 86_400_000);
    archive('JOJO-Q9ZH', 'Q9ZH', 'jojo', ['早安', '早'], T - 5 * 86_400_000);
    archive('JOJO-W3X4', 'W3X4', 'jojo', ['晚安', '晚安'], T - 9 * 86_400_000);
    closed('K7M2', '0123ABCD', 2);
    closed('Q9ZH', '4567EFGH', 5);
  };

  // ---- a second administrator: 角色 category but not the owner ----
  const grant = await okPost('members/issue', {
    requestId: randomUUID(),
    label: '角色管理员',
    memberId: null,
    permissions: ['category.characters', 'characters.read:*', 'conversations.read'],
  });
  const helper = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  assert.equal(
    (
      await helper.request.post(`${f.API}/admin/login`, {
        data: { token: grant.token },
        headers: { origin: f.config.origin },
      })
    ).status(),
    200,
  );

  const watch = (page: Page) => {
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
    });
    page.on('response', (r: { status: () => number; url: () => string }) => {
      if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`);
    });
  };
  const open = async (context: typeof f.context, route: string, width = 1440, height = 900) => {
    const page: Page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width, height });
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.locator('.admin-content').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(900);
    return page;
  };
  const snap = async (page: Page, name: string) => {
    await page.waitForTimeout(450);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const catalog = () =>
    f.store
      .all<{ character_id: string }>('SELECT character_id FROM web_character_catalog ORDER BY position')
      .map((r) => r.character_id);

  // =============== 1. 首页顺序 ===============
  for (const [width, height] of SIZES) {
    const page = await open(f.context, 'characters/jojo', width, height);
    await page.locator('#wb-arc').waitFor({ timeout: 15_000 });
    const before = catalog();
    await page.locator('#wb-arc').click();
    await page.locator('.arc-row').first().waitFor();
    assert.equal(await page.locator('.arc-row').count(), before.length, 'one row per card on the arc');
    assert.equal((await page.locator('.arc-row .arc-pos').first().textContent())?.trim(), '1');
    await snap(page, `arc-open-${width}`);
    // keyboard: the first row moves one place down (Alt+↓), the numbers follow, and the home page's own order is saved
    await page.locator('.arc-row').first().focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForTimeout(900);
    const after = catalog();
    assert.deepEqual(after.slice(0, 2), [before[1], before[0]], `saved for everyone at ${width}`);
    assert.equal((await page.locator('.arc-row .arc-name').first().textContent())?.trim() !== '', true);
    await snap(page, `arc-moved-${width}`);
    // put it back (so the second size starts from the same order)
    await page.locator('.arc-row').nth(1).focus();
    await page.keyboard.press('Alt+ArrowUp');
    await page.waitForTimeout(900);
    assert.deepEqual(catalog(), before);
    await page.close();
  }
  {
    // another administrator with the 角色 category may order the arc; one without it never sees the button
    const page = await open(helper, 'characters/jojo');
    await page.locator('#wb-arc').waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('#wb-arc').isVisible(), true);
    await page.close();
  }

  // =============== 2. the avatar ===============
  const png = join(FIXTURES.pathname, 'a.png');
  for (const [width, height] of SIZES) {
    const page = await open(f.context, 'characters/jojo', width, height);
    await page.locator('.wb-card').first().waitFor();
    // 身份与网页展示 is the first tab
    await page.locator('.av-field').scrollIntoViewIfNeeded();
    if (width === 1440) {
      assert.equal(await page.locator('.av-circle').getAttribute('data-empty'), 'true');
      assert.ok((await page.locator('.av-circle').textContent())?.trim(), 'the initials are the fallback');
      await snap(page, 'avatar-empty-1440');
      await page.locator('.av-field input[type=file]').setInputFiles(join(FIXTURES.pathname, 'icon.svg'));
      await page.waitForTimeout(400);
      assert.match(
        (await page.locator('.av-line').textContent()) ?? '',
        /PNG、JPEG 或 WebP/,
        'an SVG is refused with its reason',
      );
      await page.locator('.av-field input[type=file]').setInputFiles(png);
      await page.locator('.av-circle[data-empty="false"]').waitFor({ timeout: 15_000 });
      assert.match((await page.locator('.av-line').textContent()) ?? '', /保存草稿后发布生效/);
      await snap(page, 'avatar-uploaded-1440');
      await page.locator('button:has-text("保存草稿")').first().click();
      await page.waitForTimeout(1200);
      const detail = await okPost('characters/jojo/detail', {});
      assert.ok(detail.draft.profile.presentation.avatar.id, 'the draft names the picture');
      assert.equal(detail.avatar.current.source, 'png');
      // 发布 needs no 预演: the same call the 发布 tab makes for a colour-only change
      const published = await okPost('characters/jojo/publish', {
        requestId: randomUUID(),
        draftRevision: detail.draft.revision,
        profileHash: detail.draft.contentHash,
        acknowledgeReview: true,
      }).catch(async () => null);
      // (jojo's draft carries other changes too, so it still needs its 预演: the picture alone is tested on another character below)
      void published;
    } else {
      assert.equal(
        await page.locator('.av-circle').getAttribute('data-empty'),
        'false',
        'the saved picture is there after a reload',
      );
      await snap(page, 'avatar-saved-1280');
    }
    await page.close();
  }
  {
    // a picture on its own is published with no 预演, then served publicly
    const upload = await okPost('characters/wei-guagua/avatar-upload', {
      base64: readFileSync(png).toString('base64'),
    });
    const detail = await okPost('characters/wei-guagua/detail', {});
    const profile = structuredClone(detail.published.profile);
    profile.template.version = detail.published.version + 1;
    profile.presentation.avatar = { id: upload.avatar.id };
    const draft = await okPost('characters/wei-guagua/save', {
      expectedRevision: detail.draft?.revision ?? null,
      profile,
    });
    const live = await okPost('characters/wei-guagua/publish', {
      requestId: randomUUID(),
      draftRevision: draft.revision,
      profileHash: draft.contentHash,
      acknowledgeReview: true,
    });
    assert.equal(live.previewId, null);
    const anonymous = await f.browser.newContext({ ignoreHTTPSErrors: true });
    const image = await anonymous.request.get(`${f.API}/public-image/${upload.avatar.id}`, {
      headers: { cookie: 'x=1' },
    });
    assert.equal(image.status(), 200);
    const headers = image.headers();
    assert.equal(headers['content-type'], 'image/png');
    assert.equal(headers['x-content-type-options'], 'nosniff');
    assert.match(headers['cache-control'] ?? '', /public, max-age=31536000, immutable/);
    assert.equal(headers['set-cookie'], undefined);
    assert.equal((await image.body()).subarray(1, 4).toString(), 'PNG');
    assert.equal((await anonymous.request.get(`${f.API}/public-image/${'0'.repeat(64)}`)).status(), 404);
    await anonymous.close();
  }

  // =============== 3. 整理预演 ===============
  {
    const page = await open(f.context, 'characters/chen-jimi');
    const detail = await okPost('characters/chen-jimi/detail', {});
    const draftRevision = detail.draft?.revision ?? null;
    void draftRevision;
    // two single previews and one run, run through the offline provider
    const profile = structuredClone(detail.published.profile);
    profile.template.version = detail.published.version + 1;
    profile.template.persona += '（预演用）';
    const draft = await okPost('characters/chen-jimi/save', {
      expectedRevision: detail.draft?.revision ?? null,
      profile,
    });
    const started = await f.post(
      'characters/chen-jimi/run-start',
      {
        requestId: randomUUID(),
        draftRevision: draft.revision,
        profileHash: draft.contentHash,
        relationship: 'friend',
        inputs: [{ text: '今天好吗' }, { text: '晚上吃什么' }],
      },
      false,
    );
    assert.equal(started.status(), 202);
    for (let i = 0; i < 80; i++) {
      const busy = f.store.get("SELECT 1 FROM admin_previews WHERE status IN ('queued','generating')");
      if (!busy) break;
      await page.waitForTimeout(250);
    }
    await page.reload();
    await page.locator('.wb-card .wb-tab', { hasText: /^预演/ }).click();
    await page.locator('.pw-feed .pw-run-head').first().waitFor({ timeout: 20_000 });
    const ledger = () =>
      JSON.stringify(
        f.store.all(
          'SELECT preview_id,phase,state,charged_micros,receipt_json FROM web_character_preview_attempts ORDER BY preview_id,phase',
        ),
      );
    const before = ledger();
    await page.locator('.pw-manage button:has-text("整理预演")').click();
    await page.locator('.pw-feed .pm-tick input').first().check();
    assert.match((await page.locator('.pm-count').textContent()) ?? '', /已选 1 项/);
    await snap(page, 'previews-selected-1440');
    await page.locator('.pm-bar button:has-text("删除所选…")').click();
    await page.locator('.review-confirm, .pm-confirm').locator('.ic-text').first().waitFor();
    const message = (await page.locator('.pm-confirm .ic-text').textContent()) ?? '';
    assert.match(message, /1 个运行.*共 2 条/, 'the question names how many');
    await snap(page, 'previews-confirm-1440');
    await page.locator('.pm-confirm .ic-go').click();
    await page.waitForTimeout(1500);
    assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_preview_runs')!.n, 0);
    assert.equal(ledger(), before, 'the bills are exactly as they were');
    await page.close();
  }

  // =============== 4. 测试对话 deletion and 已关闭账号 (owner) ===============
  for (const [width, height] of SIZES) {
    seed();
    const page = await open(f.context, 'conversations', width, height);
    await page.locator('.review-list .admin-table tbody tr').first().waitFor({ timeout: 15_000 });
    const owner = page.locator('.review-list .admin-table-region:not([hidden])');
    assert.equal(await owner.locator('tbody tr').count(), 3, 'the three archived transcripts');
    await snap(page, `conversations-${width}`);
    if (width === 1440) {
      await owner.locator('tbody tr').nth(0).locator('input[type=checkbox]').check();
      await page.locator('.admin-bulk-bar button:has-text("删除所选…")').click();
      assert.match((await page.locator('.review-confirm .ic-text').textContent()) ?? '', /永久删除 1 条测试对话/);
      await page.locator('.review-confirm .ic-go').click();
      await page.waitForTimeout(1200);
      assert.equal(await owner.locator('tbody tr').count(), 2);
    }
    // 已关闭账号: 玩家编号 and the closing day only
    const panel = page.locator('.closed-panel');
    await panel.waitFor();
    const cells = await panel.locator('tbody td').allTextContents();
    assert.ok(
      cells.some((c) => /^[0-9A-Z]{8}$/.test(c)),
      'a 玩家编号',
    );
    assert.ok(!/@|昵称|principal|world/i.test((await panel.textContent()) ?? ''), 'no email, nickname or id');
    await snap(page, `closed-${width}`);
    if (width === 1440) {
      assert.equal(await panel.locator('.seg-button[aria-pressed="true"]').textContent(), '按保留期');
      await panel.locator('.seg-button:has-text("立即")').click();
      await page.waitForTimeout(800);
      assert.equal(
        f.store.get<{ value: string }>("SELECT value FROM web_owner_settings WHERE key='closed_chats'")!.value,
        'immediate',
      );
      await panel.locator('.seg-button:has-text("按保留期")').click();
      await page.waitForTimeout(800);
      await panel.locator('tbody tr').first().locator('button').click();
      await page.locator('.review-confirm .ic-go').waitFor();
      await page.locator('.review-confirm .ic-go').click();
      await page.waitForTimeout(1200);
      // the first transcript's deletion took its list row with it (nothing was left under that code); this deletion took the other
      assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_closed_accounts')!.n, 0);
      assert.equal(
        f.store.get<{ n: number }>("SELECT count(*) n FROM web_review_archive WHERE review_code IN ('K7M2','Q9ZH')")!.n,
        0,
      );
    }
    await page.close();
  }
  {
    // a non-owner reader: no checkboxes, no delete, no 已关闭账号, no 整理预演
    const page = await open(helper, 'conversations');
    await page.locator('.review-list .admin-table tbody tr').first().waitFor({ timeout: 15_000 });
    assert.equal(await page.locator('.admin-bulk-bar:visible').count(), 0);
    assert.equal(await page.locator('.review-list input[type=checkbox]').count(), 0);
    assert.equal(await page.locator('.closed-panel:visible').count(), 0);
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('part 31 browser: ok');
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
