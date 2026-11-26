import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 38a in a REAL browser: the chat header and the voice playback queue, at 390 and 1440.
 *   header   no avatar and no halo, ever; the nickname normally, 「正在讲话中」 alone while the character replies (a crossfade
 *            between them, none under reduced motion); the name is back afterwards.
 *   queue    (a) a voice message arriving mid-playback waits (data-queued) and plays when the current clip ends, the rest of the
 *            playing reply first; (b) sending mid-playback never stops the clip; (c) a tap on a bubble plays that one at once and
 *            the queue continues from there; leaving the chat empties the queue and stops the clip.
 * The player and the bootstrap are the real ones (console-fixture-24b6.ts); the reply, the history page and the clips are
 * answered by this script (the offline provider of the fixture does not publish voice replies), so the clips are as long as
 * the steps need them to be. usage: node scripts/check-web-player-38a-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;

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

const f = await startConsoleFixture({});
const errors: string[] = [];
let failure: unknown = null;
const CLIP_SECONDS = 8;
try {
  for (const [width, height, tag] of [
    [390, 844, 'm'],
    [1440, 900, 'd'],
  ] as const) {
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      deviceScaleFactor: 2,
    });
    const page: Page = await ctx.newPage();
    page.on('pageerror', (e: unknown) => errors.push(String(e)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
    });
    await page.addInitScript(() => {
      Math.random = () => 0;
    });

    // ---- the answers this script gives: every message is a voice clip of its own reply ----
    type Msg = Record<string, unknown>;
    const history: Msg[] = [];
    let conversationId = '';
    let replies = 0;
    let submitDelay = 0;
    const audioRequests: string[] = [];
    const reply = (count: number) => {
      const operationId = `op-38a-${tag}-${++replies}`;
      for (let i = 0; i < count; i++)
        history.push({
          conversationId,
          characterId: 'wei-guagua',
          operationId,
          createdAt: Date.now() + history.length,
          messageId: `${operationId}-m${i}`,
          replyOrdinal: i,
          author: 'character',
          origin: 'narrative',
          text: `回复${replies}-${i}`,
          audio: {
            revision: 1,
            status: 'ready',
            mediaId: `media-${operationId}-${i}`,
            durationMs: CLIP_SECONDS * 1000,
            errorCode: null,
          },
        });
      return operationId;
    };
    const operationOf = (operationId: string, base: Msg) => ({
      ...base,
      operationId,
      conversationId,
      status: 'published',
      canCancel: false,
      canRetry: false,
      errorCode: null,
      publication: null,
    });
    let nextReplySize = 2;
    let lastBase: Msg = {};
    // Part 36 NAMED EXCEPTION: a message is a BUBBLE now (POST .../bubbles) and its reply is the turn it makes (GET .../turn, then the
    // operation). The script answers both the way it answered the old operations route: only the first send reaches the real server
    // (for the conversation id); every bubble is one turn with a reply of `nextReplySize` voice messages.
    let openTurn: string | null = null;
    await page.route('**/api/web/provider/characters/*/bubbles', async (route: any) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!conversationId) {
        const real = await route.fetch();
        const body = await real.json();
        conversationId = body.conversationId;
        lastBase = {
          ...lastBase,
          conversationId,
          requestId: 'r',
          characterId: 'wei-guagua',
          acceptedAt: 1,
          deadlineAt: 9e12,
          revision: 1,
        };
      }
      if (submitDelay) await new Promise((r) => setTimeout(r, submitDelay));
      const operationId = reply(nextReplySize);
      openTurn = operationId;
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          messageId: `bubble-${operationId}`,
          conversationId,
          duplicate: false,
          turn: { state: 'replying', dueAt: null, pending: 1, operationId, errorCode: null },
        }),
      });
    });
    await page.route('**/api/web/provider/characters/*/turn', async (route: any) => {
      const operationId = openTurn;
      openTurn = null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(
          operationId
            ? { state: 'replying', dueAt: null, pending: 0, operationId, errorCode: null }
            : { state: 'idle', dueAt: null, pending: 0, operationId: null, errorCode: null },
        ),
      });
    });
    await page.route('**/api/web/provider/operations/*', async (route: any) => {
      const id = decodeURIComponent(route.request().url().split('/').pop()!);
      if (!id.startsWith('op-38a-')) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(operationOf(id, lastBase)),
      });
    });
    await page.route('**/api/web/provider/conversations/*/history*', async (route: any) => {
      if (!history.length) return route.fallback();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ characterId: 'wei-guagua', messages: history, hasMore: false, cursor: null }),
      });
    });
    await page.route('**/api/web/provider/conversations/*/messages/*/audio/*', async (route: any) => {
      audioRequests.push(route.request().url().split('/messages/')[1]!.split('/')[0]!);
      await route.fulfill({ status: 200, contentType: 'audio/wav', body: tone(CLIP_SECONDS) });
    });

    await page.goto(`${f.origin}/?mode=provider`);
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    const snap = async (name: string) => {
      await page.waitForTimeout(500);
      if (shots) await page.screenshot({ path: join(shots, `${name}-${tag}.png`) });
    };
    const title = card.locator('.chat-head strong');
    const bubble = (op: number, i: number) =>
      card.locator(`[data-message-id="op-38a-${tag}-${op}-m${i}"] .play-button`);
    const state = async (op: number, i: number, attribute: 'data-playing' | 'data-queued') =>
      bubble(op, i).getAttribute(attribute);
    const dump = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('.card-slot.is-active .message-row[data-message-id]')].map(
          (row) =>
            `${(row as HTMLElement).dataset.messageId}:${row.querySelector('.play-button')?.getAttribute('data-playing')}:${row.querySelector('.play-button')?.getAttribute('data-queued')}`,
        ),
      );
    const until = async (op: number, i: number, attribute: 'data-playing' | 'data-queued', value: string | null) => {
      await page
        .waitForFunction(
          ([selector, name, want]: [string, string, string | null]) =>
            document.querySelector(selector)?.getAttribute(name) === want,
          [`.card-slot.is-active [data-message-id="op-38a-${tag}-${op}-m${i}"] .play-button`, attribute, value],
          { timeout: 20_000 },
        )
        .catch(async (error: Error) => {
          error.message += ` | waiting ${op}-${i} ${attribute}=${value}; rows ${JSON.stringify(await dump())}`;
          throw error;
        });
    };
    const send = async (text: string) => {
      await card.locator('textarea').fill(text);
      await card.locator('.send-button').click();
    };
    const nickname = (await title.textContent())!;

    // ============== header: no avatar, ever; the nickname, then 「正在讲话中」 alone, then the nickname ==============
    const noAvatar = async (where: string) =>
      assert.equal(
        await card.locator('.chat-head .avatar, .chat-head img, .chat-head .chat-mark').count(),
        0,
        `${tag} ${where}: the header has no avatar`,
      );
    assert.ok(nickname.length > 0 && nickname !== '正在讲话中');
    await noAvatar('nickname');
    await snap('header-nickname');
    submitDelay = 2500;
    await send('第一条');
    await page.waitForFunction(
      () => document.querySelector('.card-slot.is-active .chat-head strong')?.textContent === '正在讲话中',
      null,
      { timeout: 10_000 },
    );
    await noAvatar('speaking');
    // the crossfade: a ghost of the old text is on the page for a moment, then gone
    await page.waitForTimeout(450);
    assert.equal(await card.locator('.chat-head .title-ghost').count(), 0, `${tag}: the crossfade ghost is removed`);
    assert.equal((await title.textContent())!.trim(), '正在讲话中');
    assert.ok(
      !(await card.locator('.chat-head .chat-title').innerText()).includes(nickname),
      `${tag}: no nickname while replying`,
    );
    await snap('header-speaking');
    submitDelay = 0;

    // ============== queue (a): the first reply's clips; the second clip waits for the first ==============
    await until(1, 0, 'data-playing', 'true');
    assert.equal((await title.textContent())!.trim(), nickname, `${tag}: the nickname is back`);
    assert.equal(await state(1, 1, 'data-queued'), 'true', `${tag}: the rest of the reply waits`);
    assert.notEqual(await state(1, 1, 'data-playing'), 'true');

    // ============== queue (b): sending mid-playback does not stop the clip; the new reply waits ==============
    nextReplySize = 1;
    await send('第二条');
    await until(2, 0, 'data-queued', 'true');
    assert.equal(await state(1, 0, 'data-playing'), 'true', `${tag}: sending did not stop the clip`);
    // every character message carries its 30 px avatar (Part 38a), also several in a row
    assert.equal(
      await card
        .locator('.message-row.incoming .message-avatar')
        .evaluateAll(
          (nodes: HTMLElement[]) =>
            nodes.filter((n) => getComputedStyle(n).visibility === 'visible' && n.offsetWidth === 30).length ===
            nodes.length,
        ),
      true,
      `${tag}: every incoming row shows a 30 px avatar`,
    );
    await snap('queued');
    // ...and plays in order: 1-0 ends, 1-1, then 2-0
    await until(1, 1, 'data-playing', 'true');
    assert.equal(await state(2, 0, 'data-queued'), 'true', `${tag}: the new reply is still waiting`);
    await until(2, 0, 'data-playing', 'true');
    assert.equal(await state(2, 0, 'data-queued'), null);

    // ============== queue (c): a tap on purpose plays that one; the queue continues from there ==============
    nextReplySize = 2;
    await send('第三条');
    await until(3, 0, 'data-queued', 'true');
    await until(3, 1, 'data-queued', 'true');
    await bubble(3, 1).click();
    await until(3, 1, 'data-playing', 'true');
    assert.equal(await state(2, 0, 'data-playing'), 'false', `${tag}: the tap interrupted the clip that was playing`);
    assert.equal(await state(3, 1, 'data-queued'), null);
    await until(3, 0, 'data-playing', 'true'); // the queue continues: the waiting 3-0 plays after the tapped one

    // ============== leaving the chat empties the queue ==============
    nextReplySize = 2;
    await send('第四条');
    await until(4, 1, 'data-queued', 'true');
    await card.locator('.back-button').click();
    await page.locator('.page-shell:not([data-phase="chat"])').waitFor({ timeout: 10_000 });
    assert.equal(await page.locator('[data-queued]').count(), 0, `${tag}: nothing waits after leaving`);
    assert.equal(await page.locator('[data-playing="true"]').count(), 0, `${tag}: nothing plays after leaving`);
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('[data-playing="true"]').count(), 0);

    // ============== reduced motion: the header swaps with no crossfade ==============
    if (tag === 'm') {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await card.click({ force: true });
      await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
      submitDelay = 1500;
      await send('第五条');
      await page.waitForFunction(
        () => document.querySelector('.card-slot.is-active .chat-head strong')?.textContent === '正在讲话中',
        null,
        { timeout: 10_000 },
      );
      assert.equal(await card.locator('.chat-head .title-ghost').count(), 0, 'no crossfade under reduced motion');
    }
    assert.ok(audioRequests.length >= 5, `${tag}: clips were fetched (${audioRequests.length})`);
    await ctx.close();
  }
} catch (error) {
  failure = error;
  if (shots)
    for (const page of f.context.pages()) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
} finally {
  await f.close();
}
if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
if (failure) console.error(failure, (failure as Error).message);
if (errors.length || failure) process.exitCode = 1;
else console.log('player 38a browser check: PASS');
