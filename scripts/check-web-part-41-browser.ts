import './player-build-guard.ts';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WEB_HTTP_LIMITS } from '../config/web-v1.ts';
import { isReadOnlyAdminPost } from '../apps/server/cloudflare/web-admin-read.ts';
import { loadPlaywright, startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 41 in REAL browsers (the console fixture, its OFFLINE provider):
 *  1. typing 300 characters quickly into the fields of the character workbench (every tab, the clip-takes feedback and marked-up
 *     sentence, the 情境 field, the 预演 script) never gets 「请求太频繁」: every admin request is counted against the real limits
 *     (read-only POSTs against adminReadsPerIpPerMinute, the rest against writesPerIpPerMinute) and a request over its limit is answered
 *     with a 429 RATE_LIMITED, which would show on the page. The request that caused it before the fix was take-estimate, one per key.
 *  2. the home cards (owner spec 2026-11-18): avatar 10% smaller, centre at 38.2% of the card from the top; nickname at its size, centre
 *     at 61.8%; welcome voice bar 75% of the card, a gap of half the nickname's font size, play button under the nickname's left edge.
 *     390 and 1440, front and side cards, with and without a picture.
 *  3. Android (Pixel 7, Galaxy S23 Ultra, GPU on), WebKit (iPhone) and desktop: the home page and a chat; no filter / will-change on
 *     the card shapes; avatar, nickname and voice bar are on the card.
 *  4. 系统 → 模型与价格 → 回复写法 renders for the owner, and says so in the card when its read fails.
 *
 * usage: node scripts/check-web-part-41-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const FIX = new URL('../tests/web/fixtures/avatars/', import.meta.url).pathname;
const problems: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
const errors: string[] = [];
const watch = (page: Page, label: string) => {
  page.on('pageerror', (e: unknown) => errors.push(`${label}: ${String(e)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/Failed to load resource|status of 4\d\d|429/.test(m.text()))
      errors.push(`${label} console: ${m.text()} ${JSON.stringify((m as any).location?.())}`);
  });
};
/** Debug aid: P41_ONLY=3 runs one numbered section (the cards, section 2, always run first when 3 is asked: they upload the avatars). */
const want = (n: number) => !process.env.P41_ONLY || process.env.P41_ONLY.split(',').includes(String(n));
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true, freeTier: false });
try {
  const okPost = async (path: string, data: unknown) => {
    const r = await f.post(path, data);
    if (r.status() !== 200) throw new Error(`${path}: ${await r.text()}`);
    return r.json();
  };

  // ======== 1. typing never meets the limiter ========
  if (want(1)) {
    const page: Page = await f.context.newPage();
    watch(page, 'typing');
    await page.setViewportSize({ width: 1440, height: 900 });
    const jojo = await okPost('characters/jojo/detail', {});
    const profile = structuredClone(jojo.published.profile);
    profile.template.id = 'rl-41';
    profile.template.version = 1;
    delete profile.template.voice;
    profile.presentation.welcomes = [
      { id: 'a', text: '你好呀，今天过得怎么样', weight: 60 },
      { id: 'b', text: '又见面了，我等你很久', weight: 40 },
    ];
    await okPost('characters/rl-41/save', { expectedRevision: null, profile });
    f.store.run(
      'INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      'rl-41',
      'RL41',
      'rl41',
      null,
      'fish-rl-41',
      1,
      1,
    );
    // The limiter of the edge, applied here: a sliding minute per budget, and a 429 past it.
    const stamps = { read: [] as number[], write: [] as number[] };
    const tally: Record<string, number> = {};
    let refused = 0;
    let firstRefused = '';
    await page.route('**/api/web/provider/admin/**', async (route: any) => {
      const path = new URL(route.request().url()).pathname.replace(/^.*\/api\/web\/provider/, '');
      const now = Date.now();
      const kind = isReadOnlyAdminPost(path) ? 'read' : 'write';
      const limit = kind === 'read' ? WEB_HTTP_LIMITS.adminReadsPerIpPerMinute : WEB_HTTP_LIMITS.writesPerIpPerMinute;
      stamps[kind] = stamps[kind].filter((t) => now - t < 60_000);
      const shape = path.replace(/\/characters\/[^/]+\//, '/characters/:id/');
      tally[`${kind} ${shape}`] = (tally[`${kind} ${shape}`] ?? 0) + 1;
      if (stamps[kind].length >= limit) {
        refused++;
        firstRefused ||= `${kind} ${shape}`;
        return route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'RATE_LIMITED' }, code: 'RATE_LIMITED' }),
        });
      }
      stamps[kind].push(now);
      return route.continue();
    });
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/rl-41`);
    await page.reload();
    await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    const text300 = 'abcdefghij'.repeat(30);
    const typeInto = async (field: any) => {
      await field.focus();
      await field.pressSequentially(text300, { delay: 0 });
    };
    const tabs: string[] = await page.locator('button.wb-tab span').allInnerTexts();
    const typed: string[] = [];
    // the voice tab first: three takes, then the feedback box and the marked-up sentence (one estimate per KEY before the fix)
    await page.locator('button.wb-tab:has(span:text-is("声音"))').first().click();
    const gen = page.locator('[data-pw-send="generate-all"]').first();
    await page.waitForFunction(
      (el: HTMLButtonElement | null) => !!el && /约/.test(el.textContent ?? '') && !el.disabled,
      await gen.elementHandle(),
      { timeout: 15_000 },
    );
    await gen.click();
    await gen.click();
    await page.waitForFunction(() => document.querySelectorAll('.vc-take').length >= 3, null, { timeout: 30_000 });
    await page.waitForTimeout(1200);
    await page.locator('section.vc-slot').first().getByText('按反馈重录').click();
    await typeInto(page.locator('section.vc-slot textarea.vc-feedback-input').first());
    typed.push('feedback');
    await page.locator('section.vc-slot').first().getByText('改写这句').click();
    await page.locator('textarea.vc-markup-input').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const estimatesBefore = tally['read /characters/:id/take-estimate'] ?? 0;
    await typeInto(page.locator('textarea.vc-markup-input').first());
    typed.push('marked-up sentence');
    await page.waitForTimeout(1200);
    const duringTyping = (tally['read /characters/:id/take-estimate'] ?? 0) - estimatesBefore;
    check(
      duringTyping <= 2,
      `typing 300 characters into the marked-up sentence sent ${duringTyping} take-estimate requests`,
    );
    // every other tab: up to six fields each
    for (const tab of tabs) {
      await page.locator(`button.wb-tab:has(span:text-is("${tab}"))`).first().click();
      await page.waitForTimeout(500);
      const fields = page.locator(
        '.admin-content input[type=text]:visible:not([readonly]):not([disabled]), .admin-content textarea:visible:not([readonly]):not([disabled])',
      );
      const n = Math.min(await fields.count(), 6);
      for (let i = 0; i < n; i++) {
        const label = (await fields.nth(i).getAttribute('aria-label')) ?? '';
        if (/评测集/.test(label)) continue;
        await typeInto(fields.nth(i));
        typed.push(`${tab}:${label}`);
      }
    }
    await page.waitForTimeout(1500);
    const writes = stamps.write.length;
    check(refused === 0, `a request was refused as RATE_LIMITED: ${firstRefused}`);
    check(writes <= 40, `typing used ${writes} of the ${WEB_HTTP_LIMITS.writesPerIpPerMinute} writes a minute`);
    check(
      stamps.read.length <= 120,
      `typing used ${stamps.read.length} of the ${WEB_HTTP_LIMITS.adminReadsPerIpPerMinute} reads a minute`,
    );
    const body = await page.locator('body').innerText();
    check(!/请求太频繁|操作太频繁/.test(body), 'the page shows a too-frequent refusal');
    check(typed.length >= 12, `only ${typed.length} fields were typed into`);
    console.log(
      `typing: ${typed.length} fields x 300 characters; reads ${stamps.read.length}, writes ${writes}, refused ${refused}`,
    );
    await page.close();
  }

  // ======== 2. the home cards ========
  for (const [id, file] of [
    ['wei-guagua', 'sq-a.png'],
    ['jojo', 'sq-b-alpha.png'],
  ] as const) {
    const up = await okPost(`characters/${id}/avatar-upload`, {
      base64: readFileSync(join(FIX, file)).toString('base64'),
    });
    const detail = await okPost(`characters/${id}/detail`, {});
    const profile = structuredClone(detail.published.profile);
    profile.template.version = detail.published.version + 1;
    profile.presentation.avatar = { id: up.avatar.id };
    const draft = await okPost(`characters/${id}/save`, { expectedRevision: detail.draft?.revision ?? null, profile });
    await okPost(`characters/${id}/publish`, {
      requestId: randomUUID(),
      draftRevision: draft.revision,
      profileHash: draft.contentHash,
      acknowledgeReview: true,
    });
  }
  const measure = (page: Page) =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('.card-slot')]
        .filter((s) => getComputedStyle(s).visibility !== 'hidden' && !s.classList.contains('is-hidden-slot'))
        .map((slot) => {
          const face = slot.querySelector<HTMLElement>('.card-face:not(.face-reserve)');
          if (!face) return null;
          const H = face.offsetHeight,
            W = face.offsetWidth;
          const box = face.getBoundingClientRect();
          const at = (el: HTMLElement) => {
            const t = getComputedStyle(el).translate.split(' ');
            const dy = t[1]?.endsWith('%') ? (parseFloat(t[1]) / 100) * el.offsetHeight : 0;
            const dx = t[0]?.endsWith('%') ? (parseFloat(t[0]) / 100) * el.offsetWidth : 0;
            const top = el.offsetTop + dy,
              left = el.offsetLeft + dx;
            return { top, left, w: el.offsetWidth, h: el.offsetHeight };
          };
          const avatar = at(slot.querySelector<HTMLElement>('.face-portrait')!);
          const name = at(slot.querySelector<HTMLElement>('.face-name')!);
          const voiceEl = slot.querySelector<HTMLElement>('.face-voice')!;
          const voice = at(voiceEl);
          const play = at(slot.querySelector<HTMLElement>('.face-play')!);
          const fs = parseFloat(getComputedStyle(slot.querySelector<HTMLElement>('.face-name')!).fontSize);
          return {
            active: slot.classList.contains('is-active'),
            side: slot.dataset.side ?? 'c',
            onScreen: box.right > 0 && box.left < innerWidth,
            H,
            W,
            avatarMidFromTop: (avatar.top + avatar.h / 2) / H,
            avatarW: avatar.w,
            nameMid: (name.top + name.h / 2) / H,
            nameBottom: name.top + name.h,
            nameLeft: name.left,
            fs,
            voiceW: voice.w / W,
            voiceTop: voice.top,
            playLeft: voice.left + play.left,
          };
        })
        .filter(Boolean),
    );
  if (want(2))
    for (const [width, height] of [
      [390, 844],
      [1440, 900],
    ] as const)
      for (const [who, label] of [
        ['wei-guagua', 'avatar'],
        ['chen-jimi', 'initials'],
      ] as const) {
        const ctx = await f.browser.newContext({
          ignoreHTTPSErrors: true,
          viewport: { width, height },
          deviceScaleFactor: 2,
        });
        const page: Page = await ctx.newPage();
        watch(page, `cards ${width}`);
        await page.addInitScript(
          (id: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: id })),
          who,
        );
        await page.goto(`${f.origin}/?mode=provider`);
        await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
        if (who === 'wei-guagua')
          await page
            .locator('.card-slot.is-active .face-portrait[data-portrait="loaded"]')
            .waitFor({ timeout: 15_000 });
        await page.waitForTimeout(1500);
        const at = `${width} ${label}`;
        const cards = (await measure(page)).filter((c: any) => c.onScreen);
        check(
          cards.some((c: any) => c.active) && cards.length >= 2,
          `${at}: a front card and a side card are on screen`,
        );
        for (const c of cards) {
          const who2 = `${at} ${c.active ? 'front' : `side ${c.side}`}`;
          check(Math.abs(c.avatarW - 148 * 0.9) <= 0.6, `${who2}: the avatar is 90% of 148px (${c.avatarW})`);
          check(
            Math.abs(c.avatarMidFromTop - 0.382) < 0.004,
            `${who2}: the avatar centre is at 38.2% from the top (${(c.avatarMidFromTop * 100).toFixed(2)}%)`,
          );
          check(
            Math.abs(1 - c.avatarMidFromTop - 0.618) < 0.004,
            `${who2}: the avatar centre is at 61.8% from the bottom`,
          );
          check(
            Math.abs(c.nameMid - 0.618) < 0.006,
            `${who2}: the nickname centre is at 61.8% (${(c.nameMid * 100).toFixed(2)}%)`,
          );
          check(
            Math.abs(c.voiceW - 0.75) < 0.006,
            `${who2}: the voice bar is 75% of the card (${(c.voiceW * 100).toFixed(2)}%)`,
          );
          const gap = c.voiceTop - c.nameBottom;
          check(
            Math.abs(gap - c.fs / 2) <= 1.2,
            `${who2}: the gap is half the nickname size (${gap.toFixed(1)} vs ${(c.fs / 2).toFixed(1)})`,
          );
          // the play button lines up with the text's left edge on the cards whose text starts at the left; on the right-hand side the name
          // hugs the right edge (so its sliver shows), and the bar hugs it too
          if (c.side !== 'r')
            check(
              Math.abs(c.playLeft - c.nameLeft) <= 1,
              `${who2}: the play button starts under the nickname (${c.playLeft} / ${c.nameLeft})`,
            );
        }
        if (shots) await page.screenshot({ path: join(shots, `cards-${width}-${label}.png`) });
        await ctx.close();
      }

  // ======== 3. Android / WebKit / desktop: the home page and a chat ========
  if (want(3)) {
    const pw = loadPlaywright();
    const gpu = [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-gpu-rasterization',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
    ];
    const android = await pw.chromium.launch({ args: gpu });
    const ua =
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
    let webkit: any = null;
    try {
      webkit = await pw.webkit.launch();
    } catch (error) {
      console.log(`webkit unavailable here: ${String(error).split('\n')[0]}`);
    }
    const runs: Array<[string, any, any]> = [
      ['android-pixel7', android, pw.devices['Pixel 7']],
      [
        'android-s23ultra',
        android,
        { ...pw.devices['Pixel 7'], viewport: { width: 412, height: 915 }, deviceScaleFactor: 3.5, userAgent: ua },
      ],
      ['desktop', f.browser, { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }],
    ];
    if (webkit) runs.push(['ios-webkit', webkit, pw.devices['iPhone 15']]);
    for (const [name, browser, device] of runs) {
      const ctx = await browser.newContext({ ...device, ignoreHTTPSErrors: true });
      const page: Page = await ctx.newPage();
      watch(page, name);
      await page.addInitScript(() =>
        localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: 'wei-guagua' })),
      );
      await page.goto(`${f.origin}/?mode=provider`);
      await page.locator('.card-slot.is-active').waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2500);
      const facts = await page.evaluate(() => {
        const shape = document.querySelector<HTMLElement>('.card-slot.is-active .pk-shape');
        const sty = shape ? getComputedStyle(shape) : null;
        const vis = (sel: string) => {
          const el = document.querySelector<HTMLElement>(`.card-slot.is-active ${sel}`);
          const r = el?.getBoundingClientRect();
          return !!r && r.width > 4 && r.height > 4;
        };
        return {
          platform: document.documentElement.dataset.platform ?? '',
          shapes: document.querySelectorAll('.card-slot.is-active .pk-shape').length,
          filter: sty?.filter ?? 'none',
          willChange: sty?.willChange ?? 'auto',
          avatar: vis('.face-portrait'),
          name: vis('.face-name'),
          voice: vis('.face-voice'),
        };
      });
      check(facts.avatar && facts.name && facts.voice, `${name}: avatar, nickname and voice bar are on the card`);
      check(facts.shapes > 0, `${name}: the card has its colour shapes`);
      check(facts.filter === 'none', `${name}: a card shape carries a filter (${facts.filter})`);
      check(facts.willChange === 'auto', `${name}: a card shape promotes its own layer (${facts.willChange})`);
      check(
        (facts.platform === 'android') === name.startsWith('android'),
        `${name}: the page's platform mark is wrong (${facts.platform})`,
      );
      if (shots) await page.screenshot({ path: join(shots, `device-${name}-home.png`) });
      await page.locator('.card-slot.is-active').click({ force: true });
      await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1500);
      if (shots) await page.screenshot({ path: join(shots, `device-${name}-chat.png`) });
      await ctx.close();
    }
    await android.close();
    await webkit?.close();
  }

  // ======== 4. 回复写法 for the owner ========
  if (want(4)) {
    const page: Page = await f.context.newPage();
    watch(page, 'writer');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${f.origin}/?mode=provider-admin#/models`);
    await page.reload();
    await page.locator('.models-writer').waitFor({ timeout: 20_000 });
    check(!(await page.locator('.models-writer').isHidden()), 'the writer card is visible to the owner');
    check(/当前：/.test(await page.locator('.models-writer').innerText()), 'the writer card shows the current choice');
    if (shots) await page.screenshot({ path: join(shots, 'writer-ok.png') });
    // a failed read is said in the card
    await page.route('**/system/writer-read', (route: any) => route.fulfill({ status: 500, body: '{}' }));
    await page.reload();
    await page.locator('.models-writer').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    check(!(await page.locator('.models-writer').isHidden()), 'the writer card is hidden when its read fails');
    check(
      (await page.locator('.models-writer [role="alert"]').count()) === 1,
      'the failed read is not said in the card',
    );
    if (shots) await page.screenshot({ path: join(shots, 'writer-fault.png') });
    await page.close();
  }

  if (errors.length) problems.push(...errors.slice(0, 10));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exitCode = 1;
  } else console.log('part 41 browser checks passed');
} finally {
  await f.close();
}
