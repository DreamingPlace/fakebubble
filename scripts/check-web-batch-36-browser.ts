import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture, loadPlaywright } from './console-fixture-24b6.ts';

/**
 * Part 36 in REAL browsers (Android Chrome emulation and iOS WebKit with touch, and a desktop), on the console fixture:
 *   - three bubbles typed one after another are stored one by one and answered by ONE turn (one reply, one operation followed); the
 *     header stays the nickname while she collects and says 「正在讲话中」 only while she replies; her avatar and the player's sit on the top
 *     line of their bubble;
 *   - a long press on her voice message opens the ONE menu with 引用 · 分享为卡片 · 👍 · 👎; there is no 分享 icon beside any bubble;
 *   - 引用 puts the bubble in the composer (✕), the sent bubble shows the quote above it and the request names the quoted message, a tap on
 *     the quote scrolls to the original;
 *   - 👎 asks 语音 or 内容, the rated mark sits outside the bubble at its bottom-right corner with its bottom on the bubble's bottom
 *     edge, a second 👎 removes it; 分享为卡片 opens the share sheet;
 *   - a voice message that is PLAYING keeps playing through the long press, the menu, the quote, the rating and the sending.
 * What this script answers itself (the fixture's offline provider never publishes a reply, as in Part 38a): the operation's result, the
 * history page with her reply, the clip, the rating and the share link. The bubbles and the turn are the real server's.
 *
 * usage: node scripts/check-web-batch-36-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
let step = 'start';

/** A mono 8 kHz 16-bit WAV of a quiet tone, `seconds` long. */
function tone(seconds: number) {
  const rate = 8000;
  const samples = Math.round(rate * seconds);
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(Math.round(Math.sin(i / 9) * 1200), 44 + i * 2);
  return buffer;
}

const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const pw = loadPlaywright();
const webkit = await pw.webkit.launch();
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const ANDROID = {
  ...pw.devices['Pixel 7'],
  viewport: { width: 412, height: 915 },
  deviceScaleFactor: shots ? 3.5 : 2,
  userAgent: ANDROID_UA,
};
const IOS = { ...pw.devices['iPhone 14'] };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };
const configs = [
  ['android', ANDROID, false, true],
  ['ios', IOS, true, true],
  ['desktop', DESKTOP, false, false],
] as const;
/** A route handler that outlives its page (the context closes while a poll is in flight) must not end the run. */
const safe =
  // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
    (handler: (route: any) => Promise<unknown>) =>
    // biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
    async (route: any) => {
      try {
        await handler(route);
      } catch {
        /* the page is gone */
      }
    };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CLIP_SECONDS = 120; // long enough to outlast every step below
const results: string[] = [];

try {
  for (const [name, device, isWebkit, touch] of configs) {
    const ctx = await (isWebkit ? webkit : f.browser).newContext({ ...device, ignoreHTTPSErrors: true });
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(`${name}: ${String(e)}`));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      // WebKit: Playwright's own screenshot injects a stylesheet that the page's CSP refuses (one message per picture, seen only with a
      // screenshot directory); it is the tool's, not the page's.
      const screenshotStylesheet = shots && /Refused to apply a stylesheet/.test(m.text());
      if (m.type() === 'error' && !screenshotStylesheet && !/Failed to load resource|status of 4\d\d/.test(m.text()))
        errors.push(`${name} console after ${step}: ${m.text()}`);
    });
    await page.addInitScript(() =>
      localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua', theme: 'light' })),
    );

    // ---- what the server really receives ----
    const bubblePosts: { requestId: string; text: string; quoteMessageId?: string }[] = [];
    const operationReads = new Set<string>();
    const ratingPosts: Record<string, unknown>[] = [];
    let conversationId = '';
    let realOperation = '';
    let replyFromMs = 0;
    page.on('request', (r: any) => {
      const url = r.url();
      if (r.method() === 'POST' && /\/characters\/[^/]+\/bubbles$/.test(url))
        bubblePosts.push(JSON.parse(r.postData() ?? '{}'));
      if (r.method() === 'POST' && /\/ratings$/.test(url)) ratingPosts.push(JSON.parse(r.postData() ?? '{}'));
    });
    page.on('response', async (r: any) => {
      if (r.request().method() === 'POST' && /\/bubbles$/.test(r.url()) && r.ok()) {
        try {
          conversationId = (await r.json()).conversationId;
        } catch {}
      }
    });
    // the operation the turn made never finishes in this fixture: it is answered here once she has "replied" for a moment
    await page.route(
      '**/api/web/provider/operations/*',
      safe(async (route: any) => {
        const id = decodeURIComponent(route.request().url().split('/').pop()!);
        if (id.includes('by-request')) return route.fallback();
        const real = await route.fetch();
        const body = await real.json();
        operationReads.add(id);
        realOperation = id;
        if (!replyFromMs) replyFromMs = Date.now();
        const done = Date.now() - replyFromMs > 1500;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(
            done ? { ...body, status: 'published', canCancel: false, publication: null, errorCode: null } : body,
          ),
        });
      }),
    );
    const replies = () => {
      const base = {
        conversationId,
        characterId: 'wei-guagua',
        operationId: realOperation,
        createdAt: Date.now(),
        author: 'character',
        origin: 'narrative',
      };
      return [
        {
          ...base,
          messageId: `reply-voice-${name}`,
          replyOrdinal: 0,
          text: '先把鞋脱了，坐下来，慢慢说。',
          audio: {
            revision: 1,
            status: 'ready',
            mediaId: `media-${name}`,
            durationMs: CLIP_SECONDS * 1000,
            errorCode: null,
          },
        },
        {
          ...base,
          messageId: `reply-text-${name}`,
          replyOrdinal: 1,
          deliveryFallback: 'text',
          text: '我在听。',
          audio: null,
        },
      ];
    };
    const ratingsState = new Map<string, unknown>();
    await page.route(
      '**/api/web/provider/conversations/*/history*',
      safe(async (route: any) => {
        const real = await route.fetch();
        const body = await real.json();
        if (realOperation && Date.now() - replyFromMs > 1500)
          body.messages.push(
            ...replies().map((m) =>
              ratingsState.has(m.messageId) ? { ...m, rating: ratingsState.get(m.messageId) } : m,
            ),
          );
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      }),
    );
    await page.route('**/api/web/provider/conversations/*/messages/*/audio/*', (route: any) =>
      route.fulfill({ status: 200, contentType: 'audio/wav', body: tone(CLIP_SECONDS) }),
    );
    // A quote of a message this script made up cannot be stored by the real server (it only quotes its own conversation: unit-tested);
    // the bubble that quotes it is answered here.
    let fakeBubbles = 0;
    await page.route('**/api/web/provider/characters/*/bubbles', async (route: any) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (!String(body.quoteMessageId ?? '').startsWith('reply-')) return route.fallback();
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          messageId: `quoting-${name}-${++fakeBubbles}`,
          conversationId,
          duplicate: false,
          turn: { state: 'collecting', dueAt: Date.now() + 4000, pending: 1, operationId: null, errorCode: null },
        }),
      });
    });
    await page.route('**/api/web/provider/ratings', async (route: any) => {
      const body = JSON.parse(route.request().postData() ?? '{}');
      if (body.rating === 'none') ratingsState.delete(body.messageId);
      else ratingsState.set(body.messageId, { value: body.rating, target: body.target ?? null });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ rating: body.rating === 'none' ? null : body.rating, target: body.target ?? null }),
      });
    });
    await page.route('**/api/web/provider/shares', (route: any) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'A'.repeat(32), expiresAt: Date.now() + 86_400_000 }),
      }),
    );

    await page.goto(`${f.origin}/?mode=provider`);
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await wait(1200);
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await wait(1200);
    const title = card.locator('.chat-head strong');
    const nickname = (await title.textContent())!;
    const snap = async (label: string) => {
      step = label;
      await wait(500);
      if (shots) await page.screenshot({ path: join(shots, `${name}-${label}.png`) });
    };
    const send = async (text: string) => {
      await card.locator('textarea').fill(text);
      await card.locator('.send-button').click();
    };
    const tap = async (locator: any) => (touch ? locator.tap() : locator.click());
    /** A long press on a row's bubble: a held mouse on the desktop, held pointer events on the phones (neither engine can hold a finger). */
    const longPress = async (row: any, bubbleSelector: string) => {
      await row.scrollIntoViewIfNeeded();
      await wait(200);
      const bubble = row.locator(bubbleSelector).first();
      const box = await bubble.boundingBox();
      const x = box.x + box.width / 2,
        y = box.y + box.height / 2;
      if (!touch) {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await wait(650);
        await page.mouse.up();
      } else {
        await bubble.evaluate(
          (el: HTMLElement, p: { x: number; y: number }) => {
            const init = {
              bubbles: true,
              cancelable: true,
              pointerId: 7,
              pointerType: 'touch',
              isPrimary: true,
              clientX: p.x,
              clientY: p.y,
              button: 0,
            };
            el.dispatchEvent(new PointerEvent('pointerdown', init));
          },
          { x, y },
        );
        await wait(650);
        await bubble.evaluate(
          (el: HTMLElement, p: { x: number; y: number }) => {
            el.dispatchEvent(
              new PointerEvent('pointerup', {
                bubbles: true,
                cancelable: true,
                pointerId: 7,
                pointerType: 'touch',
                isPrimary: true,
                clientX: p.x,
                clientY: p.y,
                button: 0,
              }),
            );
          },
          { x, y },
        );
      }
      await page.locator('.msg-menu').waitFor({ timeout: 3000 });
    };

    // ================= three bubbles, one reply =================
    const started = Date.now();
    for (const text of ['在吗', '我刚下班', '今天好累']) {
      await send(text);
      await wait(250);
    }
    check(bubblePosts.length === 3, `${name}: three bubbles were stored one by one (${bubblePosts.length})`);
    check((await title.textContent()) === nickname, `${name}: while she collects, the header stays the nickname`);
    await snap('1-batch');
    await page.waitForFunction(
      () => document.querySelector('.card-slot.is-active .chat-head strong')?.textContent === '正在讲话中',
      null,
      { timeout: 15_000 },
    );
    const quiet = Date.now() - started;
    check(quiet >= 4000, `${name}: she did not start before the 4 s of quiet had passed (${quiet} ms)`);
    await snap('2-replying');
    await card.locator('.message-row.incoming:not(.welcome-row) .voice-bubble').first().waitFor({ timeout: 20_000 });
    await page.waitForFunction(
      () => document.querySelector('.card-slot.is-active .chat-head strong')?.textContent !== '正在讲话中',
      null,
      { timeout: 20_000 },
    );
    check(
      operationReads.size === 1,
      `${name}: ONE operation was followed for the three bubbles (${operationReads.size})`,
    );
    check(
      (await card.locator('.message-row.outgoing').count()) === 3,
      `${name}: the three bubbles are on the page once each`,
    );
    check((await card.locator('.share-btn').count()) === 0, `${name}: no 分享 icon beside any bubble`);

    // ---- avatars sit on the top line of their bubble ----
    const lines = await page.evaluate(() => {
      const top = (el: Element | null) => el?.getBoundingClientRect().top ?? NaN;
      const hers = document.querySelector('.card-slot.is-active .message-row.incoming:not(.welcome-row)');
      const mine = document.querySelector('.card-slot.is-active .message-row.outgoing');
      const after = mine ? getComputedStyle(mine, '::after') : null;
      return {
        her: [top(hers?.querySelector('.message-avatar') ?? null), top(hers?.querySelector('.voice-bubble') ?? null)],
        mineAlign: getComputedStyle(mine!).alignItems,
        mineAfter: after?.alignSelf,
      };
    });
    check(
      Math.abs(lines.her[0]! - lines.her[1]!) <= 1.5,
      `${name}: her avatar and her bubble share a top line (${lines.her})`,
    );
    check(
      /^(flex|flow)-start$|^start$/.test(lines.mineAlign) && /^(flex|flow)-start$|^start$/.test(lines.mineAfter ?? ''),
      `${name}: the player's avatar is top-aligned (${lines.mineAlign}/${lines.mineAfter})`,
    );
    await snap('3-replied');

    // ================= a voice message plays through everything below =================
    const voiceRow = card.locator(`[data-message-id="reply-voice-${name}"]`);
    const textRow = card.locator(`[data-message-id="reply-text-${name}"]`);
    await tap(voiceRow.locator('.play-button'));
    await page.waitForFunction(
      (id: string) =>
        document.querySelector(`[data-message-id="${id}"] .play-button`)?.getAttribute('data-playing') === 'true',
      `reply-voice-${name}`,
      { timeout: 10_000 },
    );
    const playing = () => voiceRow.locator('.play-button').getAttribute('data-playing');

    // ---- the menu on her voice message ----
    await longPress(voiceRow, '.voice-bubble');
    const keys = await page
      .locator('.msg-menu .msg-menu-item')
      .evaluateAll((els: HTMLElement[]) => els.map((e) => e.dataset.key));
    check(
      JSON.stringify(keys) === JSON.stringify(['quote', 'share', 'up', 'down']),
      `${name}: her voice message offers 引用 · 分享为卡片 · 👍 · 👎 (${keys})`,
    );
    check((await playing()) === 'true', `${name}: the voice keeps playing while the menu is open`);
    await snap('4-menu-voice');
    // 分享为卡片 opens the share sheet
    await tap(page.locator('.msg-menu [data-key="share"]'));
    await page.locator(touch ? '.share-sheet' : '.share-pop').waitFor({ timeout: 5000 });
    check((await playing()) === 'true', `${name}: the voice keeps playing while the share sheet opens`);
    await snap('5-share');
    await page.keyboard.press('Escape').catch(() => undefined);
    await page
      .locator(touch ? '.share-sheet' : '.share-pop')
      .waitFor({ state: 'detached', timeout: 3000 })
      .catch(async () => {
        await page
          .locator('.share-scrim')
          .click({ force: true })
          .catch(() => undefined);
      });
    await wait(400);

    // ---- the menu on the player's own bubble and on her text reply ----
    await longPress(card.locator('.message-row.outgoing').first(), '.text-bubble');
    check(
      JSON.stringify(
        await page
          .locator('.msg-menu .msg-menu-item')
          .evaluateAll((els: HTMLElement[]) => els.map((e) => e.dataset.key)),
      ) === '["quote"]',
      `${name}: the player's own bubble offers 引用 only`,
    );
    await snap('6-menu-mine');
    await page.keyboard.press('Escape');
    await page.locator('.msg-menu').waitFor({ state: 'detached', timeout: 3000 });
    await longPress(textRow, '.text-bubble');
    check(
      JSON.stringify(
        await page
          .locator('.msg-menu .msg-menu-item')
          .evaluateAll((els: HTMLElement[]) => els.map((e) => e.dataset.key)),
      ) === '["quote","up","down"]',
      `${name}: a text-fallback reply offers 引用 · 👍 · 👎`,
    );
    await page.keyboard.press('Escape');
    await page.locator('.msg-menu').waitFor({ state: 'detached', timeout: 3000 });

    // ================= 引用: composer -> sent bubble -> the request -> a tap scrolls back =================
    await longPress(voiceRow, '.voice-bubble');
    await tap(page.locator('.msg-menu [data-key="quote"]'));
    await card.locator('.quote-strip').waitFor({ timeout: 3000 });
    check(
      (await card.locator('.quote-strip .quote-strip-x').count()) === 1,
      `${name}: the composer shows the quoted bubble with ✕`,
    );
    await snap('7-composer-quote');
    await card.locator('textarea').fill('好～');
    await card.locator('.send-button').click();
    await card.locator('.message-row.outgoing .quote-ref').first().waitFor({ timeout: 5000 });
    check(
      bubblePosts.at(-1)?.quoteMessageId === `reply-voice-${name}`,
      `${name}: the request names the quoted message (${bubblePosts.at(-1)?.quoteMessageId})`,
    );
    await card
      .locator('.quote-strip')
      .waitFor({ state: 'detached', timeout: 2000 })
      .catch(() => undefined); // it leaves with a 160 ms motion
    check((await card.locator('.quote-strip').count()) === 0, `${name}: the composer's quote is gone once sent`);
    check((await playing()) === 'true', `${name}: the voice keeps playing through the quote and the sending`);
    await snap('8-sent-quote');
    await card.locator('.chat-body').evaluate((el: HTMLElement) => (el.scrollTop = 0));
    await wait(300);
    await tap(card.locator('.message-row.outgoing .quote-ref').first());
    await page.waitForFunction(
      (id: string) => document.querySelector(`[data-message-id="${id}"]`)?.classList.contains('is-flash'),
      `reply-voice-${name}`,
      { timeout: 4000 },
    );
    await wait(1200); // the smooth scroll has ended

    // ================= 👎 asks what; the mark sits outside the bubble; 👎 again removes it =================
    await longPress(voiceRow, '.voice-bubble');
    await tap(page.locator('.msg-menu [data-key="down"]'));
    const choice = await page
      .locator('.msg-menu .msg-menu-item')
      .evaluateAll((els: HTMLElement[]) => els.map((e) => e.dataset.key));
    check(
      JSON.stringify(choice) === '["down","voice","content"]',
      `${name}: 👎 on a voice message asks 语音 or 内容 (${choice})`,
    );
    await snap('9-thumbs-down-choice');
    await tap(page.locator('.msg-menu [data-key="content"]'));
    await voiceRow.locator('.rating-mark[data-rating="down"]').waitFor({ timeout: 3000 });
    check(
      ratingPosts.at(-1)?.rating === 'down' && ratingPosts.at(-1)?.target === 'content',
      `${name}: the request says 👎 on the content (${JSON.stringify(ratingPosts.at(-1))})`,
    );
    await wait(600); // the mark pops in over 320 ms
    const geometry = await voiceRow.evaluate((row: HTMLElement) => {
      const bubble = row.querySelector('.voice-bubble')!.getBoundingClientRect();
      const mark = row.querySelector('.rating-mark')!.getBoundingClientRect();
      return { dBottom: Math.abs(mark.bottom - bubble.bottom), gap: mark.left - bubble.right };
    });
    check(
      geometry.dBottom <= 1.5 && geometry.gap >= 0,
      `${name}: the mark is outside the bubble, its bottom on the bubble's bottom edge (${JSON.stringify(geometry)})`,
    );
    await snap('10-rated');
    await longPress(voiceRow, '.voice-bubble');
    check(
      (await page.locator('.msg-menu [data-key="down"]').getAttribute('data-on')) === 'true',
      `${name}: the menu shows the 👎 as on`,
    );
    await tap(page.locator('.msg-menu [data-key="down"]'));
    await page.waitForFunction(
      (id: string) => !document.querySelector(`[data-message-id="${id}"] .rating-mark`),
      `reply-voice-${name}`,
      { timeout: 3000 },
    );
    check(ratingPosts.at(-1)?.rating === 'none', `${name}: a second 👎 removes the rating`);
    // a 👍 on the text reply, then a switch to 👎 (content, with no question: it has no voice)
    await longPress(textRow, '.text-bubble');
    await tap(page.locator('.msg-menu [data-key="up"]'));
    await textRow.locator('.rating-mark[data-rating="up"]').waitFor({ timeout: 3000 });
    await longPress(textRow, '.text-bubble');
    await tap(page.locator('.msg-menu [data-key="down"]'));
    await textRow.locator('.rating-mark[data-rating="down"]').waitFor({ timeout: 3000 });
    check(
      ratingPosts.at(-1)?.rating === 'down' && ratingPosts.at(-1)?.target === 'content',
      `${name}: a text reply is rated down as content without a question`,
    );
    check((await playing()) === 'true', `${name}: the voice was still playing at the end`);
    await snap('11-end');
    results.push(name);
    await ctx.close();
  }
  assert.deepEqual(errors, [], 'no page error');
  assert.deepEqual(problems, [], problems.join('\n'));
  console.log(`check-web-batch-36: ${results.join(', ')} passed`);
} finally {
  await webkit.close().catch(() => undefined);
}
process.exit(0);
