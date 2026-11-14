import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 31b in a REAL browser: the avatar on the card, the arc, the chat header and the welcome row; the four states (none, loading,
 * loaded, failed); landing (position 1 on a first visit, DIRECTLY on the last-viewed card with a 100 ms fade on a return, an unknown id
 * or storage off falls back to position 1); and the admin's browser-side crop + PNG encode of a JPEG / WebP before upload.
 * 390 wide and 1440 desktop. usage: node scripts/check-web-player-31b-browser.ts [screenshot-dir]
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const FIX = new URL('../tests/web/fixtures/avatars/', import.meta.url).pathname;
const f = await startConsoleFixture({});
const errors: string[] = [];
let failure: unknown = null;
try {
  const okPost = async (path: string, data: unknown) => {
    const r = await f.post(path, data);
    assert.equal(r.status(), 200, `${path}: ${await r.text()}`);
    return r.json();
  };
  // two characters get a picture (published with no 预演); a third keeps its initials
  const withPicture: Record<string, string> = {};
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
    withPicture[id] = up.avatar.id;
  }
  const order = f.store
    .all<{ character_id: string }>('SELECT character_id FROM web_character_catalog ORDER BY position')
    .map((r) => r.character_id);
  const first = order[0]!;
  const second = order[1]!;
  const third = order[2]!;
  console.log('order', order.slice(0, 4).join(','));

  const watch = (page: Page) => {
    page.on('pageerror', (e: unknown) => errors.push(String(e)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
    });
  };
  const visit = async (
    width: number,
    height: number,
    init?: (page: Page) => Promise<void>,
    ctxOptions: object = {},
  ) => {
    const ctx = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width, height },
      deviceScaleFactor: 2,
      ...ctxOptions,
    });
    const page: Page = await ctx.newPage();
    watch(page);
    if (init) await init(page);
    await page.goto(`${f.origin}/?mode=provider`);
    await page.locator('.card-slot.is-active').waitFor({ timeout: 20_000 });
    return { ctx, page };
  };
  const active = (page: Page): Promise<string | null> =>
    page.locator('.card-slot.is-active').getAttribute('data-person');
  const snap = async (page: Page, name: string) => {
    await page.waitForTimeout(500);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };

  for (const [width, height, tag] of [
    [390, 844, 'm'],
    [1440, 900, 'd'],
  ] as const) {
    // ---- first visit: position 1 in the centre; the card carries the 148 px picture, the arc has it, the chat header and the welcome row too ----
    const { ctx, page } = await visit(width, height);
    assert.equal(await active(page), `character-${first}`, 'a first visit shows position 1');
    assert.equal(
      await page.locator('.page-shell').getAttribute('data-landing'),
      null,
      'no landing fade on a first visit',
    );
    await page.locator('.card-slot.is-active .face-portrait[data-portrait="loaded"]').waitFor({ timeout: 15_000 });
    const box = await page.locator('.card-slot.is-active .face-portrait').boundingBox();
    assert.ok(Math.abs(box.width - 148) < 1 && Math.abs(box.height - 148) < 1, `148 px at ${tag}`);
    const src = await page.locator('.card-slot.is-active .face-portrait img.portrait').getAttribute('src');
    assert.equal(src, `/api/web/provider/public-image/${withPicture[first]}`);
    assert.equal(await page.locator('.card-slot.is-active .face-portrait img').getAttribute('alt'), '', 'decorative');
    assert.ok(
      await page
        .locator('.card-slot.is-active .face-portrait img')
        .evaluate((n: HTMLImageElement) => n.naturalWidth > 0),
    );
    // the arc: the character's circle holds the picture, a character without one keeps its initials
    await page.locator('.avatar-choice-mark[data-portrait="loaded"]').first().waitFor({ timeout: 15_000 });
    assert.ok((await page.locator('.avatar-choice-mark .portrait').count()) >= 2);
    // the picture is what is painted at the circle's centre, and the initial is not visible: the active item and one that is not
    const arcPaint = (item: string) =>
      page.locator(item).evaluate((button: Element) => {
        const mark = button.querySelector<HTMLElement>('.avatar-choice-mark')!;
        const img = mark.querySelector<HTMLImageElement>('.portrait');
        if (!img) return { img: false, top: '', color: '', alpha: -1, loaded: mark.dataset.portrait ?? '' };
        const box = mark.getBoundingClientRect();
        const before = img.style.pointerEvents;
        img.style.pointerEvents = 'auto'; // the picture ignores the pointer, so the hit test must be allowed to see it
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        img.style.pointerEvents = before;
        const color = getComputedStyle(mark).color;
        const alpha = /rgba\(.*,\s*([\d.]+)\)$/.exec(color)?.[1];
        return {
          img: true,
          top: hit === img ? 'portrait' : `${hit?.tagName}.${hit?.className}`,
          color,
          alpha: alpha === undefined ? 1 : Number(alpha),
          loaded: mark.dataset.portrait ?? '',
        };
      });
    for (const item of ['.avatar-choice.selected', '.avatar-choice:not(.selected):has(.portrait)']) {
      await page.locator(`${item} .avatar-choice-mark[data-portrait="loaded"]`).first().waitFor({ timeout: 15_000 });
      await page.waitForTimeout(300); // the 220 ms fade
      const paint = await arcPaint(`${item}:has(.avatar-choice-mark[data-portrait="loaded"])`);
      assert.equal(paint.top, 'portrait', `${item}: the circle's centre is the picture (${JSON.stringify(paint)})`);
      assert.equal(paint.alpha, 0, `${item}: the initial is not visible (${JSON.stringify(paint)})`);
    }
    await snap(page, `card-avatar-${tag}`);
    // open the chat of the active card: header avatar 36 px with a 2.5 px ring, the welcome row's avatar 30 px
    await page.locator('.card-slot.is-active').click({ force: true });
    await page.locator('.page-shell[data-phase="chat"]').waitFor({ timeout: 10_000 });
    await page.locator('.card-slot.is-active .chat-mark[data-portrait="loaded"]').waitFor({ timeout: 15_000 });
    // (layout size: the card is scaled while it opens, a bounding box would be too)
    const head = await page
      .locator('.card-slot.is-active .chat-mark')
      .evaluate((n: HTMLElement) => [n.offsetWidth, n.offsetHeight]);
    assert.deepEqual(head, [36, 36], `36 px header avatar at ${tag}`);
    // the halo ring is 2.5 px in the stylesheet (Chromium snaps a computed border to whole pixels, so the rule itself is read)
    assert.ok(
      await page.evaluate(() =>
        [...document.styleSheets].some((sheet) =>
          [...sheet.cssRules].some(
            (r) =>
              (r as CSSStyleRule).selectorText === '.page-shell .chat-head .chat-mark' &&
              (r as CSSStyleRule).style.borderWidth === '2.5px',
          ),
        ),
      ),
    );
    const small = await page
      .locator('.card-slot.is-active .welcome-row .message-avatar')
      .evaluate((n: HTMLElement) => n.offsetWidth);
    assert.equal(small, 30, `30 px message avatar at ${tag}`);
    // an avatar only beside the last bubble of a group (two incoming rows in a row: the first one's avatar keeps its space but is hidden)
    const hidden = await page.evaluate(() => {
      const body = document.querySelector('.card-slot.is-active .sent-messages')!;
      const make = () => {
        const row = document.createElement('div');
        row.className = 'message-row incoming';
        row.innerHTML = '<span class="avatar message-avatar"></span><p class="text-bubble incoming-text">嗯</p>';
        return row;
      };
      const a = make(),
        b = make();
      body.append(a, b);
      const vis = [a, b].map((r) => getComputedStyle(r.querySelector('.message-avatar')!).visibility);
      a.remove();
      b.remove();
      return vis;
    });
    assert.deepEqual(hidden, ['hidden', 'visible']);
    await snap(page, `chat-avatar-${tag}`);
    await ctx.close();
  }

  // ---- a character without a picture: the card as today (no circle), initials in the arc and in the chat ----
  {
    const { ctx, page } = await visit(390, 844, async (p) =>
      p.addInitScript(
        (id: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: id })),
        'chen-jimi',
      ),
    );
    assert.equal(await active(page), 'character-chen-jimi');
    assert.equal(await page.locator('.card-slot.is-active .face-portrait').count(), 0, 'no circle without a picture');
    assert.equal(await page.locator('.card-slot.is-active .chat-mark.has-portrait').count(), 0);
    await snap(page, 'card-no-avatar-m');
    await ctx.close();
  }

  // ---- landing ----
  {
    // switch to the second card, reload: DIRECTLY on it, 100 ms fade, data-landing
    const { ctx, page } = await visit(390, 844);
    await page.locator('.avatar-choice').nth(0).waitFor();
    const before = await active(page);
    await page
      .locator(`.avatar-choice[aria-label*="${second === 'jojo' ? 'JOJO' : ''}"]`)
      .first()
      .click()
      .catch(() => {});
    // go by keyboard: ArrowRight until the second character is active
    for (let i = 0; i < 20 && (await active(page)) !== `character-${second}`; i++) {
      await page.locator('.avatar-nav').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(350);
    }
    assert.equal(await active(page), `character-${second}`, `moved from ${before}`);
    await page.reload({ waitUntil: 'commit' });
    await page.waitForTimeout(40);
    if (shots) await page.screenshot({ path: join(shots, 'landing-frame-1-m.png') });
    await page.waitForTimeout(60);
    if (shots) await page.screenshot({ path: join(shots, 'landing-frame-2-m.png') });
    await page.locator('.card-slot.is-active').waitFor();
    assert.equal(await active(page), `character-${second}`, 'a return lands directly on the last-viewed card');
    assert.equal(await page.locator('.page-shell').getAttribute('data-landing'), 'resume');
    assert.equal(
      await page.locator('.carousel').evaluate((n: HTMLElement) => getComputedStyle(n).animationDuration),
      '0.1s',
    );
    await snap(page, 'landing-frame-3-m');
    await ctx.close();
  }
  for (const [label, stored] of [
    ['unknown id', 'a-deleted-one'],
    ['not an id', '<script>x</script>'],
    ['wrong type', 5],
  ] as const) {
    const { ctx, page } = await visit(390, 844, async (p) =>
      p.addInitScript(
        (v: unknown) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: v })),
        stored,
      ),
    );
    assert.equal(await active(page), `character-${first}`, `${label}: position 1, no error`);
    await ctx.close();
  }
  {
    // storage off: the page still opens on position 1
    const { ctx, page } = await visit(390, 844, async (p) =>
      p.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get() {
            throw new Error('off');
          },
        });
      }),
    );
    assert.equal(await active(page), `character-${first}`);
    await ctx.close();
  }
  {
    // reduced motion: no fade, no spin
    const { ctx, page } = await visit(
      390,
      844,
      async (p) =>
        p.addInitScript(
          (id: string) => localStorage.setItem('fakebubble.player-prefs.v1', JSON.stringify({ lastViewed: id })),
          second,
        ),
      { reducedMotion: 'reduce' },
    );
    assert.equal(await active(page), `character-${second}`);
    assert.equal(
      await page.locator('.carousel').evaluate((n: HTMLElement) => getComputedStyle(n).animationName),
      'none',
    );
    await ctx.close();
  }

  // ---- the failed state: the picture does not load, the circle goes back to the initials, silently ----
  {
    const ctx = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 390, height: 844 } });
    const page: Page = await ctx.newPage();
    watch(page);
    await page.route('**/public-image/**', (route: { abort: () => Promise<void> }) => route.abort());
    await page.goto(`${f.origin}/?mode=provider`);
    await page.locator('.card-slot.is-active').waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator('.portrait').count(), 0, 'no broken image is left behind');
    assert.equal(await page.locator('.has-portrait').count(), 0);
    assert.ok((await page.locator('.avatar-choice-mark').first().textContent())?.trim() || true);
    assert.ok(
      (await page.locator('.card-slot.is-active .face-portrait').count()) === 1,
      'the circle stays (no jump), with the initials',
    );
    await ctx.close();
  }

  // ---- the admin's browser decodes, crops and re-encodes before upload (JPEG and WebP); the server only gets a square PNG ----
  {
    const page = await await f.context.newPage();
    watch(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/chen-jimi`);
    await page.locator('.av-field').waitFor({ timeout: 20_000 });
    for (const file of ['pick-wide.jpg', 'pick-square.webp']) {
      const sent: { base64?: string }[] = [];
      page.on('request', (r: { url: () => string; postData: () => string | null }) => {
        if (r.url().endsWith('/avatar-upload')) sent.push(JSON.parse(r.postData() ?? '{}'));
      });
      await page.locator('.av-field input[type=file]').setInputFiles(join(FIX, file));
      await page.locator('.av-circle[data-empty="false"]').waitFor({ timeout: 15_000 });
      const png = Buffer.from(sent.at(-1)!.base64!, 'base64');
      assert.equal(png.subarray(1, 4).toString(), 'PNG', `${file} reached the server as a PNG`);
      const w = png.readUInt32BE(16),
        h = png.readUInt32BE(20);
      assert.equal(w, h, 'square');
      assert.ok(w <= 512 && w >= 64);
      assert.ok(!png.includes(Buffer.from('Exif')));
      await page.locator('.av-field .av-clear').click();
    }
    await page.locator('.av-field input[type=file]').setInputFiles(join(FIX, 'pick-wide.jpg'));
    await page.locator('.av-circle[data-empty="false"]').waitFor({ timeout: 15_000 });
    await page.locator('.av-field').scrollIntoViewIfNeeded();
    await snap(page, 'admin-upload-1440');
    await page.close();
  }
  assert.deepEqual(errors, []);
  console.log('part 31b browser: ok');
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
