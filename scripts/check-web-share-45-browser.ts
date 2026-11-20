import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { startConsoleFixture, loadPlaywright } from './console-fixture-24b6.ts';
import { syntheticTone } from '../apps/server/platform/web-local-fake.ts';

/**
 * Part 45 in REAL browsers (the console fixture, its OFFLINE provider; no provider call is made by anything here):
 *   share from chat -> open the link in a fresh, signed-out context -> the card renders and the voice plays -> advance the server's clock
 *   past one day -> the expired page.
 *   - the 分享 icon is on every character voice message that has audio (a broadcast's voice here) and on nothing else (not the welcome
 *     clip, not a player's own message); tapping opens a sheet (phone) or a card beside the icon (desktop); the link is made, 复制链接
 *     copies it (the real clipboard) and says 已复制; a voice message that is PLAYING keeps playing while the sheet opens, is used and
 *     closes;
 *   - the link opens with no session and no cookie (the page asks only the public share routes: no bootstrap), shows the character's card
 *     (avatar circle, name, number, play bar) with the sticker and 也和瓜瓜聊聊, plays the voice, and shows NO text line and NOTHING of the
 *     sender (their nickname is set and searched for in the page, the URL, the data and the audio address);
 *   - a link opened late, an unknown token and a voice that runs out while the page is open all show the same page: 链接已过期 and 也来聊聊.
 *
 * usage: node scripts/check-web-share-45-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 * With a screenshot directory it also takes the review pictures: Android (412x915 @3.5) and desktop, day and night.
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
const DAY = 86_400_000;
const NICKNAME = '小林飞飞';
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
// The server's clock can be moved on (the app reads `clock.now()` on every call).
const realNow = f.clock.now.bind(f.clock);
let offset = 0;
f.clock.now = () => realNow() + offset;
const pw = loadPlaywright();
const webkit = await pw.webkit.launch();
try {
  const watch = (page: Page, label: string) => {
    page.on('pageerror', (e: unknown) => errors.push(`${label}: ${String(e)}`));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d/.test(m.text()))
        errors.push(`${label} console: ${m.text()}`);
    });
  };
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
  const ANDROID = {
    ...pw.devices['Pixel 7'],
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 3.5,
    userAgent: ANDROID_UA,
  };
  const IOS = { ...pw.devices['iPhone 14'] };
  // Part 46: the phones are always driven by real TOUCH (isMobile + hasTouch; a tap, never a mouse click), on Android Chrome emulation
  // and on iOS WebKit. The review pictures (a screenshot directory) add the night mode and the desktop pair.
  const configs = (
    shots
      ? [
          ['android-light', 'light', ANDROID],
          ['android-dark', 'dark', ANDROID],
          ['ios-light', 'light', IOS],
          ['desktop-light', 'light', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
          ['desktop-dark', 'dark', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
        ]
      : [
          ['android', 'light', ANDROID],
          ['ios', 'light', IOS],
          ['desktop', 'dark', { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
        ]
  ) as [string, string, Record<string, unknown>][];
  const isIos = (name: string) => name.startsWith('ios');
  const engine = (name: string) => (isIos(name) ? webkit : f.browser);

  // two characters with a saved draft (the voice speaks from a revision), as the workbench leaves them
  for (const id of ['wei-guagua', 'jojo']) {
    const detail = await (await f.post(`characters/${id}/detail`, {})).json();
    const profile = structuredClone(detail.published.profile);
    profile.template.version += 1;
    await f.post(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
  }
  const players: { name: string; theme: string; ctx: Page; page: Page }[] = [];
  for (const [name, theme, device] of configs) {
    const ctx = await engine(name).newContext({ ...device, ignoreHTTPSErrors: true });
    await ctx
      .grantPermissions(isIos(name) ? [] : ['clipboard-read', 'clipboard-write'], { origin: f.origin })
      .catch(() => undefined);
    const page: Page = await ctx.newPage();
    watch(page, name);
    await page.addInitScript(
      (t: string) =>
        localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua', theme: t })),
      theme,
    );
    // the system share sheet, where a phone offers one: recorded with whether the tap's user activation was still alive at the call
    if (device.hasTouch)
      await page.addInitScript(() => {
        (window as any).__shared = [];
        (window as any).__shareMode = 'ok';
        Object.defineProperty(navigator, 'share', {
          configurable: true,
          value: (data: { url: string }) => {
            (window as any).__shared.push({ url: data.url, active: navigator.userActivation?.isActive ?? true });
            return (window as any).__shareMode === 'ok'
              ? Promise.resolve()
              : Promise.reject(Object.assign(new Error('x'), { name: (window as any).__shareMode }));
          },
        });
      });
    await page.addInitScript(() => {
      const board = navigator.clipboard;
      const write = board?.writeText?.bind(board);
      if (write)
        board.writeText = async (text: string) => {
          (window as any).__copied = text;
          return write(text);
        };
    });
    await page.goto(`${f.origin}/?mode=provider`);
    await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    players.push({ name, theme, ctx, page });
  }
  // every one of them is a registered player (an unlimited entitlement, as a redeemed code gives) so the broadcast reaches it
  const now = f.clock.now();
  const principals: string[] = [];
  for (const p of players)
    principals.push(
      await p.page.evaluate(
        async () =>
          (await (await fetch('/api/web/provider/bootstrap', { credentials: 'same-origin' })).json()).access
            .principalId,
      ),
    );
  for (const id of principals) {
    f.store.run(
      'INSERT OR IGNORE INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
      id,
      `${id}@example.com`,
      'x',
      now,
      now,
      now,
    );
    f.store.run(
      "INSERT INTO web_entitlements(id,principal_id,source,kind,starts_at,expires_at,created_at) VALUES (?,?,'admin','unlimited',?,NULL,?)",
      `fixture:${id}`,
      id,
      now - 1,
      now,
    );
  }
  await wait(1500);
  // a long clip (8 s) so a voice message is still playing while the share sheet is used
  const take = await (
    await f.post('broadcast/upload', {
      characterId: 'wei-guagua',
      base64: Buffer.from(syntheticTone(8000)).toString('base64'),
    })
  ).json();
  const options = await (await f.post('broadcast/options', {})).json();
  check(
    options.recipients === players.length,
    `the broadcast reaches the ${players.length} registered players (${options.recipients})`,
  );
  await f.post('broadcast/send', {
    requestId: `share45-${Date.now()}`,
    bubbles: ['小林，你听我说'],
    characterIds: ['wei-guagua'],
    voices: { 'wei-guagua': take.takeId },
    sendAt: null,
    acknowledge: { characters: 1, recipients: options.recipients },
  });
  await wait(3000);

  // ---- the sender's nickname: set through the real account route when this fixture's login allows it (it is searched for below) ----
  let nicknameSet = false;
  {
    const sender = players[0]!;
    await sender.page.reload();
    await sender.page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    nicknameSet = await sender.page.evaluate(async (nickname: string) => {
      const boot = await (await fetch('/api/web/provider/bootstrap', { credentials: 'same-origin' })).json();
      const r = await fetch('/api/web/provider/account/nickname', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': boot.csrf },
        body: JSON.stringify({ nickname }),
      });
      return r.ok;
    }, NICKNAME);
  }
  console.log(`sender nickname set: ${nicknameSet}`);

  const names = ['瓜瓜'];
  const ALLOWED = new Set(['收到一张语音小卡', '也和瓜瓜聊聊', '来聊几句嘛～', 'burbur', '瓜瓜', 'guagua', '瓜']);
  const visibleLines = (page: Page) =>
    page.evaluate(() =>
      (document.body.innerText || '')
        .split('\n')
        .map((l: string) => l.trim())
        .filter(Boolean),
    );
  for (const [index, { name, theme, ctx, page }] of players.entries()) {
    // ================= the chat =================
    await page.reload();
    const card = page.locator('.card-slot.is-active');
    await card.waitFor({ timeout: 20_000 });
    await wait(1200);
    await card.click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await wait(1500);
    const rows = await page.evaluate(() => ({
      welcomeShare: document.querySelectorAll('.card-slot.is-active .welcome-row .share-btn').length,
      ownShare: document.querySelectorAll('.card-slot.is-active .message-row.outgoing .share-btn').length,
      voice: document.querySelectorAll('.card-slot.is-active .message-row.incoming:not(.welcome-row) .play-button')
        .length,
      shareIcons: document.querySelectorAll('.card-slot.is-active .message-row.incoming:not(.welcome-row) .share-btn')
        .length,
    }));
    check(rows.voice >= 1, `${name}: the broadcast voice message is in the chat`);
    check(
      rows.shareIcons === rows.voice,
      `${name}: every character voice message has a 分享 icon (${rows.shareIcons}/${rows.voice})`,
    );
    check(rows.welcomeShare === 0, `${name}: the welcome clip has none`);
    check(rows.ownShare === 0, `${name}: the player's own messages have none`);
    if (shots) await page.screenshot({ path: `${shots}/${name}-1-chat.png` });
    const icon = page.locator('.card-slot.is-active .message-row.incoming:not(.welcome-row) .share-btn').first();
    const mobileView = (await page.viewportSize()).width < 600;
    const bar = page.locator('.card-slot.is-active .message-row.incoming:not(.welcome-row) .play-button').first();
    const size = await icon.boundingBox();
    check(size && size.width >= 44 && size.height >= 44, `${name}: the icon is a 44px target`);
    // play the voice, then share while it plays: it must keep playing (a clip is 8 s)
    await bar.click();
    await page.waitForFunction(
      () =>
        document
          .querySelector('.card-slot.is-active .message-row.incoming:not(.welcome-row) .play-button')
          ?.getAttribute('data-playing') === 'true',
      null,
      { timeout: 10_000 },
    );
    // a real touch on the phones (CDP touchstart, 60 ms, touchend on Chromium; WebKit's own tap), a mouse click on the desktop
    const tap = async (target: Page) => {
      if (isIos(name)) return target.tap();
      if (!mobileView) return target.click();
      // like a click, wait for the target to stand still (the sheet slides in) before the finger lands on it
      let box = await target.boundingBox();
      for (let i = 0; i < 20; i++) {
        await wait(80);
        const next = await target.boundingBox();
        const still = next && box && next.x === box.x && next.y === box.y;
        box = next;
        if (still) break;
      }
      const cdp = await ctx.newCDPSession(page);
      const pt = [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt });
      await wait(60);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const tapped = Date.now();
    await tap(icon);
    const mobile = mobileView;
    const sheet = page.locator(mobile ? '.share-sheet' : '.share-pop');
    await sheet.waitFor({ timeout: 5_000 });
    check(Date.now() - tapped < 1000, `${name}: the sheet opened within 1 s of the tap (${Date.now() - tapped} ms)`);
    check((await sheet.getAttribute('role')) === 'dialog', `${name}: the share UI is a dialog`);
    if (shots) await page.screenshot({ path: `${shots}/${name}-2-sheet-making.png` });
    await page.locator('.share-link[data-state="ready"]').waitFor({ timeout: 10_000 });
    await wait(500); // the sheet has slid in
    check(
      await sheet.evaluate((el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 20);
        return r.bottom <= innerHeight + 1 && r.top >= 0 && !!hit && el.contains(hit);
      }),
      `${name}: the sheet is on screen and on top (not clipped, not under anything)`,
    );
    const shown = (await page.locator('.share-link span').textContent()) ?? '';
    check(/\/s\/[A-Za-z0-9_-]{4}…[A-Za-z0-9_-]{4}$/.test(shown), `${name}: the link is shown shortened: ${shown}`);
    check(
      (await sheet.locator('.share-name').textContent()) === '瓜瓜' && (await sheet.locator('.share-av').count()) === 1,
      `${name}: the small card shows the character's avatar and name`,
    );
    if (shots) await page.screenshot({ path: `${shots}/${name}-3-sheet-ready.png` });
    await tap(sheet.locator('.share-act').first());
    await page.waitForFunction(
      () => document.querySelector('.share-act[data-state="done"]')?.textContent?.includes('已复制'),
      null,
      { timeout: 5_000 },
    );
    // what the page handed to the clipboard (WebKit does not let a page read it back); Chromium's real clipboard is read too
    const copied: string = await page.evaluate(
      async (ios: boolean) => (ios ? (window as any).__copied : await navigator.clipboard.readText()),
      isIos(name),
    );
    check(
      new RegExp(`^${f.origin}/s/[A-Za-z0-9_-]{32}$`).test(copied),
      `${name}: the copied link is the origin and a token only: ${copied}`,
    );
    if (shots) await page.screenshot({ path: `${shots}/${name}-4-sheet-copied.png` });
    if (mobileView) {
      // the system share: called directly inside its own tap (the activation alive), with the link; a failure shows, a dismissal does not
      const main = sheet.locator('.share-act-main');
      check((await main.count()) === 1, `${name}: the sheet offers the system share`);
      await tap(main);
      await page.waitForFunction(() => (window as any).__shared.length === 1, null, { timeout: 3_000 });
      const shared = await page.evaluate(() => (window as any).__shared);
      check(shared[0].active === true, `${name}: navigator.share was called inside the tap (user activation alive)`);
      check(shared[0].url === copied, `${name}: the system share got the link and nothing else`);
      await page.evaluate(() => ((window as any).__shareMode = 'AbortError'));
      await tap(main);
      await wait(400);
      check((await main.getAttribute('data-state')) !== 'failed', `${name}: closing the system sheet is not a failure`);
      await page.evaluate(() => ((window as any).__shareMode = 'NotAllowedError'));
      await tap(main);
      await page.waitForFunction(
        () => document.querySelector('.share-act-main')?.getAttribute('data-state') === 'failed',
        null,
        {
          timeout: 3_000,
        },
      );
      check(
        (await main.textContent())?.trim() === '暂时无法分享',
        `${name}: a refused system share says so, in a few words: ${await main.textContent()}`,
      );
    }
    const stillPlaying = await bar.getAttribute('data-playing');
    check(
      stillPlaying === 'true',
      `${name}: the voice message kept playing while the share UI was used (${stillPlaying})`,
    );
    // close: Escape, and the sheet leaves (and still the voice plays)
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'detached', timeout: 2_000 });
    check((await bar.getAttribute('data-playing')) === 'true', `${name}: and after it closed`);
    // opening again from the same icon: a new request id, a new link; and an unused sheet is closed by a tap away
    const token = copied.split('/s/')[1]!;
    const sentRequests: string[] = [];
    page.on('request', (r: { method: () => string; url: () => string }) => {
      if (r.method() === 'POST' && r.url().includes('/shares')) sentRequests.push(r.url());
    });

    // ================= the link, in a fresh signed-out context =================
    const visitor = await engine(name).newContext({ ...(configs[index]![2] as object), ignoreHTTPSErrors: true });
    await visitor.addInitScript(
      (t: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ theme: t })),
      theme,
    );
    const seen: string[] = [];
    const bodies: string[] = [];
    const vpage: Page = await visitor.newPage();
    watch(vpage, `${name} visitor`);
    vpage.on('request', (r: { url: () => string }) => seen.push(new URL(r.url()).pathname));
    vpage.on(
      'response',
      async (r: { url: () => string; text: () => Promise<string>; headers: () => Record<string, string> }) => {
        if (new URL(r.url()).pathname.startsWith('/api/')) {
          bodies.push(JSON.stringify(r.headers()));
          if (!new URL(r.url()).pathname.endsWith('/audio')) bodies.push(await r.text().catch(() => ''));
        }
      },
    );
    await vpage.goto(copied);
    await vpage.locator('.share-page.is-card .face-voice').waitFor({ timeout: 15_000 });
    await vpage.locator('.share-page .face-portrait').waitFor();
    await wait(1200);
    check(
      new URL(vpage.url()).pathname === `/s/${token}` && !vpage.url().includes('?'),
      `${name}: the address stays /s/<token>`,
    );
    check((await visitor.cookies()).length === 0, `${name}: no cookie, no session for a visitor`);
    check(
      !seen.some((p) => /\/bootstrap$|\/account/.test(p)),
      `${name}: the page asked no bootstrap and no account route: ${seen.filter((p) => p.startsWith('/api')).join(',')}`,
    );
    check(
      seen.some((p) => p === `/api/web/provider/shares/${token}`),
      `${name}: it asked the public share route`,
    );
    // Part 46 (named exception, iOS WebKit only): WebKit's innerText runs the avatar's initial into the name's line ('瓜' + '瓜瓜'), where
    // Chromium has two lines; a line of nothing but 瓜 is the name.
    const lines: string[] = (await visibleLines(vpage)).map((l: string) => (/^瓜{2,3}$/.test(l) ? '瓜瓜' : l));
    check(
      lines.every((l: string) => ALLOWED.has(l) || /^No\.\d{3,4}$/.test(l) || /^\d+:\d\d$/.test(l)),
      `${name}: only the card's own words are on the page: ${lines.join(' | ')}`,
    );
    check(
      lines.includes('收到一张语音小卡') && lines.includes('也和瓜瓜聊聊') && lines.includes('瓜瓜'),
      `${name}: sticker, name and 也和瓜瓜聊聊 are there: ${lines.join(' | ')}`,
    );
    check(!(await vpage.locator('.share-quote, .shared-quote').count()), `${name}: no text line on the card`);
    check((await vpage.locator('.face-voice .face-dur').count()) === 1, `${name}: the play bar shows the length`);
    check((await vpage.locator('.share-cta').getAttribute('href')) === '/', `${name}: 也和…聊聊 goes to the site`);
    check(
      (await vpage.locator('.face-portrait').count()) === 1 && (await vpage.locator('.face-name').count()) === 1,
      `${name}: the avatar circle and the name are on the card`,
    );
    if (shots) await vpage.screenshot({ path: `${shots}/${name}-5-link.png` });
    // Part 44's fit-to-width reaches the shared card: a name that is too long for the card shrinks and stays whole inside it
    const normalSize = Number(
      await vpage
        .locator('.share-page .card-slot')
        .evaluate((el: HTMLElement) => el.style.getPropertyValue('--name-size')),
    );
    await vpage.locator('.face-name-text').evaluate((el: HTMLElement) => {
      el.textContent = 'Maximilian Bartholomew';
    });
    await wait(600);
    const fit = await vpage.evaluate(() => {
      const card = document.querySelector<HTMLElement>('.share-page .card-face')!.getBoundingClientRect();
      const text = document.querySelector<HTMLElement>('.share-page .face-name-text')!.getBoundingClientRect();
      const box = document.querySelector<HTMLElement>('.share-page .face-name')!;
      return {
        size: Number(
          document.querySelector<HTMLElement>('.share-page .card-slot')!.style.getPropertyValue('--name-size'),
        ),
        inside: text.left >= card.left - 0.5 && text.right <= card.right + 0.5,
        clipped: box.scrollWidth > box.clientWidth + 1,
      };
    });
    check(
      fit.size > 0 && fit.size < normalSize,
      `${name}: a long name shrinks on the shared card (${normalSize} -> ${fit.size})`,
    );
    check(
      fit.inside && !fit.clipped,
      `${name}: the long name stays inside the shared card, nothing clipped (${JSON.stringify(fit)})`,
    );
    // the voice plays
    await vpage.locator('.face-voice').click({ force: true });
    await vpage.waitForFunction(
      () => document.querySelector('.face-voice')?.getAttribute('data-playing') === 'true',
      null,
      { timeout: 10_000 },
    );
    await wait(1800);
    const progress = Number(
      await vpage
        .locator('.face-voice')
        .evaluate((el: HTMLElement) => el.style.getPropertyValue('--pk-progress') || '0'),
    );
    check(progress > 0, `${name}: the voice plays and its bar moves (${progress})`);
    if (shots) await vpage.screenshot({ path: `${shots}/${name}-6-link-playing.png` });
    // nothing of the sender anywhere a visitor can see
    const html: string = await vpage.content();
    const sender = f.store.get<{ pid: string; wid: string }>(
      'SELECT player_id pid, world_id wid FROM web_principals WHERE id=?',
      principals[index]!,
    )!;
    const everything = html + vpage.url() + bodies.join('') + seen.join('');
    for (const secret of [NICKNAME, principals[index]!, sender.pid, sender.wid, '@example.com'])
      check(
        !everything.includes(secret),
        `${name}: the sender's ${secret.slice(0, 6)}… is nowhere in the page, address, data or audio address`,
      );
    check(!/nickname|playerNumber|senderId/i.test(everything), `${name}: no sender field in the data`);

    // ================= expired in place: the voice runs out while the page is open =================
    await vpage.locator('.face-voice').click({ force: true }); // stop
    await wait(300);
    offset = DAY + 1_000;
    // (the voice was read once, so the page keeps it for this visit; a second page opened now is the late open)
    const late = await visitor.newPage();
    watch(late, `${name} late`);
    await late.goto(copied);
    await late.locator('.share-page.is-expired').waitFor({ timeout: 15_000 });
    await wait(900);
    const expiredLines: string[] = await visibleLines(late);
    check(
      expiredLines.join('|') === '链接已过期|也来聊聊',
      `${name}: the expired page has exactly 链接已过期 and 也来聊聊: ${expiredLines.join(' | ')}`,
    );
    check(!expiredLines.some((l: string) => names.some((n) => l.includes(n))), `${name}: and names nobody`);
    if (shots) await late.screenshot({ path: `${shots}/${name}-7-expired.png` });
    // an unknown token looks exactly the same
    const unknown = await visitor.newPage();
    await unknown.goto(`${f.origin}/s/${'A'.repeat(32)}`);
    await unknown.locator('.share-page.is-expired').waitFor({ timeout: 15_000 });
    await wait(900);
    check(
      (await visibleLines(unknown)).join('|') === expiredLines.join('|') &&
        (await unknown.locator('.share-page').innerHTML()) === (await late.locator('.share-page').innerHTML()),
      `${name}: an unknown token's page is the same as an expired one's`,
    );
    const apiShape = async (token2: string) => {
      const r = await late.request.get(`${f.origin}/api/web/provider/shares/${token2}`);
      const a = await late.request.get(`${f.origin}/api/web/provider/shares/${token2}/audio`);
      return JSON.stringify([r.status(), await r.text(), a.status(), await a.text()]);
    };
    check(
      (await apiShape(token)) === (await apiShape('A'.repeat(32))),
      `${name}: expired and unknown answer the same on the card and the voice routes`,
    );
    // the page that was already open when the day ran out: a fresh press of play finds the link gone and turns expired in place
    offset = 0;
    const open = await visitor.newPage();
    watch(open, `${name} open`);
    await open.goto(copied);
    await open.locator('.share-page.is-card .face-voice').waitFor({ timeout: 15_000 });
    await wait(800);
    offset = DAY + 1_000;
    await open.locator('.face-voice').click({ force: true });
    await open.locator('.share-page.is-expired').waitFor({ timeout: 10_000 });
    await wait(900);
    // (named exception, WebKit: its fade can still be running under load, so ask for the settled state rather than a fixed time)
    await open
      .waitForFunction(() => Number(getComputedStyle(document.querySelector('.face-main')!).opacity) === 0, null, {
        timeout: 8_000,
      })
      .catch(() => undefined);
    // (the card's own words fade to nothing in place, so they are asked by what shows, not by what is in the page)
    const inPlace = await open.evaluate(() => ({
      sticker: document.querySelector('.share-sticker')?.textContent,
      cta: document.querySelector('.share-cta')?.textContent,
      hint: !!document.querySelector('.share-hint'),
      nameShown: Number(getComputedStyle(document.querySelector('.face-main')!).opacity),
    }));
    check(
      inPlace.sticker === '链接已过期' && inPlace.cta === '也来聊聊' && !inPlace.hint && inPlace.nameShown === 0,
      `${name}: a link that runs out under an open page turns into the expired page in place: ${JSON.stringify(inPlace)}`,
    );
    offset = 0;
    await visitor.close();
  }
} finally {
  await webkit.close().catch(() => undefined);
  await f.close();
}
check(errors.length === 0, `page errors: ${errors.join(' ; ')}`);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('check-web-share-45-browser: all checks passed');
process.exit(0);
