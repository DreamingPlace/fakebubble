import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24l in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts (15 characters): the workbench rail in three
 * groups with counts, a drag reorder that survives a reload and differs between two administrators, 下线 with its confirm and then
 * 重新上线, and the 发布 tab as a non-owner sees it (the state, no buttons). At 1440×900 and 1280×800.
 *
 * usage: node scripts/check-web-offline-24l-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const SIZES = [
  [1440, 900],
  [1280, 800],
] as const;

const f = await startConsoleFixture();
const errors: string[] = [];
let failure: unknown = null;
try {
  const okPost = async (path: string, data: unknown) => {
    const response = await f.post(path, data);
    assert.equal(response.status(), 200, `${path}: ${await response.text()}`);
    return response.json();
  };
  // ---- the three groups: 14 live, one never-published draft, one offline ----
  const jojo = (await okPost('characters/jojo/detail', {})).published.profile;
  const fresh = structuredClone(jojo);
  Object.assign(fresh.template, {
    id: 'new-draft-one',
    name: '新角色·小满',
    version: 1,
    persona: '（示例）还没发布的新角色。',
  });
  delete fresh.template.voice;
  fresh.presentation = {
    displayName: '新角色·小满',
    publicDescription: '',
    welcome: { text: '你好呀', version: 'w1' },
  };
  await okPost('characters/new-draft-one/save', { expectedRevision: null, profile: fresh });
  const liveOf = async (id: string) => (await okPost(`characters/${id}/detail`, {})).published.version as number;
  await okPost('characters/c09/offline', { requestId: randomUUID(), liveVersion: await liveOf('c09') });

  // ---- a second administrator who reads every character (no owner buttons) ----
  const grant = await okPost('members/issue', {
    requestId: randomUUID(),
    label: '共创写手',
    memberId: null,
    permissions: ['category.characters', 'category.publication', 'characters.read:*'],
  });
  const helperContext = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  {
    const response = await helperContext.request.post(`${f.API}/admin/login`, {
      data: { token: grant.token },
      headers: { origin: f.config.origin },
    });
    assert.equal(response.status(), 200);
  }

  const watch = (page: Page) => {
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (message: { type: () => string; text: () => string }) => {
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource'))
        errors.push(`console: ${message.text()}`);
    });
    page.on('response', (response: { status: () => number; url: () => string }) => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
  };
  const open = async (context: typeof f.context, route: string, width = 1440, height = 900) => {
    const page: Page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width, height });
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.locator('.wb-roster .admin-pick-row').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(700);
    return page;
  };
  const snap = async (page: Page, name: string) => {
    await page.waitForTimeout(450);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const idsIn = (page: Page, group: string): Promise<string[]> =>
    page
      .locator(`.wb-roster .admin-pick-list[data-group="${group}"] .admin-pick`)
      .evaluateAll((nodes: Element[]) => nodes.map((n) => n.getAttribute('data-character') ?? ''));
  const heads = (page: Page): Promise<string[]> =>
    page
      .locator('.wb-roster .admin-pick-head')
      .evaluateAll((nodes: Element[]) => nodes.map((n) => (n.textContent ?? '').trim()));
  const expand = async (page: Page) => {
    await page.locator('.wb-roster').hover();
    await page.waitForTimeout(500);
  };
  const tab = (page: Page, label: string) => page.locator('.wb-card .wb-tab', { hasText: new RegExp(`^${label}`) });

  // =============== 1. three groups with counts, at both sizes ===============
  for (const [width, height] of SIZES) {
    const page = await open(f.context, 'characters/jojo', width, height);
    const text = await heads(page);
    assert.deepEqual(text, ['当前阵容14', '未发布草稿1', '已下线1'], `the three groups at ${width}×${height}`);
    assert.equal((await idsIn(page, 'live')).length, 14);
    assert.deepEqual(await idsIn(page, 'draft'), ['new-draft-one']);
    assert.deepEqual(await idsIn(page, 'offline'), ['c09']);
    // never from the cast: the rail holds no id of a group it was not given
    assert.ok(!(await idsIn(page, 'live')).includes('c09'));
    // Collapsed (no hover): the group boundaries show without hovering - a thin divider and each group's count.
    await page.mouse.move(700, 400);
    await page.waitForTimeout(500);
    const dividers = await page
      .locator('.wb-roster .admin-pick-group + .admin-pick-group')
      .evaluateAll((nodes: Element[]) => nodes.map((n) => getComputedStyle(n, '::before').height));
    assert.deepEqual(dividers, ['1px', '1px'], 'a thin divider before 未发布草稿 and 已下线');
    assert.deepEqual(await heads(page), ['当前阵容14', '未发布草稿1', '已下线1']);
    const counts = await page
      .locator('.wb-roster .admin-pick-head b')
      .evaluateAll((nodes: Element[]) => nodes.map((n) => (n as HTMLElement).getBoundingClientRect().width > 0));
    assert.deepEqual(counts, [true, true, true], 'the counts show while collapsed');
    await page.locator('.wb-roster').evaluate((n: HTMLElement) => {
      n.scrollTop = n.scrollHeight;
    });
    await snap(page, `01c-collapsed-rail-${width}`);
    await page.locator('.wb-roster').evaluate((n: HTMLElement) => {
      n.scrollTop = 0;
    });
    await snap(page, `01d-collapsed-rail-top-${width}`);
    await expand(page);
    // the rail stays inside the window and shows every character
    const box = await page.locator('.wb-roster').boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= height + 1, `the rail fits the window at ${width}×${height}`);
    await snap(page, `01-groups-${width}`);
    // 15 characters are taller than the window: the rail scrolls inside itself (as since 24b-6); the lower groups are below.
    await page.locator('.wb-roster').evaluate((n: HTMLElement) => {
      n.scrollTop = n.scrollHeight;
    });
    await snap(page, `01b-groups-scrolled-${width}`);
    await page.close();
  }

  // =============== 2. drag reorder: motion, saved, survives a reload, differs between two admins ===============
  const owner = await open(f.context, 'characters/jojo');
  const before = await idsIn(owner, 'live');
  await expand(owner);
  const row = (id: string) => owner.locator(`.wb-roster .admin-pick-row:has([data-character="${id}"])`);
  const first = before[0]!;
  const at = await row(first).boundingBox();
  const step = at.height + 2;
  await owner.mouse.move(at.x + 30, at.y + at.height / 2);
  await owner.mouse.down();
  // The row follows the pointer (never a jump): sample its offset while it moves.
  const offsets: number[] = [];
  for (let i = 1; i <= 12; i++) {
    await owner.mouse.move(at.x + 30, at.y + at.height / 2 + (step * 3 * i) / 12);
    await owner.waitForTimeout(25);
    offsets.push(await row(first).evaluate((n: HTMLElement) => n.getBoundingClientRect().top));
  }
  assert.ok(
    offsets.every((v, i) => i === 0 || v >= offsets[i - 1]!),
    'the dragged row moves smoothly with the pointer',
  );
  assert.ok(
    offsets.at(-1)! - at.y > step * 2.5 && offsets.at(-1)! - at.y < step * 3.5,
    'and ends about three rows down',
  );
  assert.ok(
    await row(first).evaluate((n: HTMLElement) => n.classList.contains('is-dragging')),
    'it is lifted while dragged',
  );
  // The neighbours slide aside with a transform (a transition), they do not jump.
  const slid = await owner
    .locator('.wb-roster .admin-pick-list[data-group="live"] .admin-pick-row')
    .evaluateAll((nodes: HTMLElement[]) => nodes.filter((n) => n.style.transform && n.style.transition).length);
  assert.ok(slid >= 3, 'the rows it passed slide out of the way');
  await snap(owner, '02-drag-in-motion');
  const saved = owner.waitForResponse((r: { url: () => string }) => r.url().endsWith('/characters/order'));
  await owner.mouse.up();
  assert.equal((await saved).status(), 200);
  await owner.waitForTimeout(500);
  const after = await idsIn(owner, 'live');
  assert.deepEqual(
    after,
    [...before.slice(1, 4), first, ...before.slice(4)],
    'the row took its new place, the others kept theirs',
  );
  assert.equal(owner.url().includes(first), false, 'a drag does not open the row');
  await owner.reload();
  await owner.locator('.wb-roster .admin-pick-row').first().waitFor();
  assert.deepEqual(await idsIn(owner, 'live'), after, 'the order survives a reload');
  await expand(owner);
  await snap(owner, '03-order-after-reload');

  // the other administrator never sees it
  const other = await open(helperContext, 'characters/jojo');
  assert.deepEqual(await idsIn(other, 'live'), before, 'the other admin still has the default order');
  const otherFirst = before[1]!;
  await expand(other);
  const orow = other.locator(`.wb-roster .admin-pick-row:has([data-character="${otherFirst}"])`);
  const ob = await orow.boundingBox();
  await other.mouse.move(ob.x + 30, ob.y + ob.height / 2);
  await other.mouse.down();
  for (let i = 1; i <= 8; i++) {
    await other.mouse.move(ob.x + 30, ob.y + ob.height / 2 - ((ob.height + 2) * 1 * i) / 8);
    await other.waitForTimeout(20);
  }
  const savedOther = other.waitForResponse((r: { url: () => string }) => r.url().endsWith('/characters/order'));
  await other.mouse.up();
  assert.equal((await savedOther).status(), 200);
  await other.waitForTimeout(400);
  const otherAfter = await idsIn(other, 'live');
  assert.deepEqual(otherAfter.slice(0, 2), [otherFirst, before[0]], 'the second admin ordered differently');
  await other.reload();
  await other.locator('.wb-roster .admin-pick-row').first().waitFor();
  assert.deepEqual(await idsIn(other, 'live'), otherAfter);
  await owner.reload();
  await owner.locator('.wb-roster .admin-pick-row').first().waitFor();
  assert.deepEqual(await idsIn(owner, 'live'), after, 'and the owner’s order is untouched by it');
  assert.notDeepEqual(otherAfter, after);
  await expand(other);
  await snap(other, '04-other-admin-order');
  await other.close();

  // =============== 3. 下线 with its confirm, then 重新上线 ===============
  for (const [width, height] of SIZES) {
    await owner.setViewportSize({ width, height });
    await owner.goto(`${f.origin}/?mode=provider-admin#/characters/jojo`);
    await owner.reload();
    await tab(owner, '发布').first().waitFor({ timeout: 20_000 });
    await tab(owner, '发布').click();
    await owner.waitForTimeout(500);
    const avail = owner.locator('.wb-avail');
    assert.match(((await avail.innerText()) as string).replace(/\s+/g, ' '), /现行 v\d+ 在线 下线/);
    await snap(owner, `05-publish-tab-owner-${width}`);
    await avail.getByRole('button', { name: '下线' }).click();
    const confirm = owner.locator('.wb-avail-confirm .ic');
    await confirm.waitFor();
    await owner.waitForTimeout(450);
    assert.equal(
      await owner.locator('.wb-avail-go').isVisible(),
      false,
      'the original button steps aside: one 下线 only',
    );
    // Named exception (Part 24b-7b): the rail's group headings are buttons now (a fold, with a chevron), so the one called 已下线 contains
    // the text 下线; the match is exact, which is what the sentence always meant (the confirm's own button).
    assert.equal(
      await owner.getByRole('button', { name: '下线', exact: true }).count(),
      1,
      'only the confirm’s 下线 is on the tab',
    );
    assert.equal(await owner.locator('.admin-dialog, dialog[open]').count(), 0, 'the question is inline, not a dialog');
    await snap(owner, `06-offline-confirm-${width}`);
    await confirm.getByRole('button', { name: '取消' }).click();
    await owner.waitForTimeout(350);
    assert.equal(await owner.locator('.wb-avail-confirm .ic').count(), 0);
    assert.ok((await idsIn(owner, 'live')).includes('jojo'), 'cancel changed nothing');
    await avail.getByRole('button', { name: '下线' }).click();
    await confirm.waitFor();
    await owner.waitForTimeout(350);
    const done = owner.waitForResponse((r: { url: () => string }) => r.url().endsWith('/characters/jojo/offline'));
    await confirm.getByRole('button', { name: '下线' }).click();
    assert.equal((await done).status(), 200);
    await owner.waitForTimeout(700);
    assert.ok((await idsIn(owner, 'offline')).includes('jojo'), 'jojo is in 已下线 now');
    assert.ok(!(await idsIn(owner, 'live')).includes('jojo'));
    assert.deepEqual(await heads(owner), ['当前阵容13', '未发布草稿1', '已下线2']);
    assert.match(((await owner.locator('.wb-avail').innerText()) as string).replace(/\s+/g, ' '), /已下线 重新上线/);
    await expand(owner);
    await snap(owner, `07-offline-${width}`);
    await owner.locator('.wb-avail').getByRole('button', { name: '重新上线' }).click();
    await owner.locator('.wb-avail-confirm .ic').waitFor();
    await owner.waitForTimeout(450);
    await snap(owner, `08-online-confirm-${width}`);
    const back = owner.waitForResponse((r: { url: () => string }) => r.url().endsWith('/characters/jojo/online'));
    await owner.locator('.wb-avail-confirm .ic').getByRole('button', { name: '重新上线' }).click();
    assert.equal((await back).status(), 200);
    await owner.waitForTimeout(700);
    assert.ok((await idsIn(owner, 'live')).includes('jojo'), 'jojo is back in 当前阵容');
    assert.deepEqual(await heads(owner), ['当前阵容14', '未发布草稿1', '已下线1']);
  }
  // A draft of an offline character: 先重新上线, no publish button.
  await okPost('characters/jojo/offline', { requestId: randomUUID(), liveVersion: await liveOf('jojo') });
  const draftOf = structuredClone(jojo);
  draftOf.template.version += 1;
  draftOf.template.persona += ' （示例）下线期间的草稿。';
  const detail = await okPost('characters/jojo/detail', {});
  await okPost('characters/jojo/save', { expectedRevision: detail.draft?.revision ?? null, profile: draftOf });
  await owner.goto(`${f.origin}/?mode=provider-admin#/characters/jojo`);
  await owner.reload();
  await tab(owner, '发布').first().waitFor({ timeout: 20_000 });
  await tab(owner, '发布').click();
  await owner.waitForTimeout(500);
  assert.match(await owner.locator('.character-flow').innerText(), /先重新上线/);
  assert.equal(await owner.getByRole('button', { name: '确认发布此版本' }).count(), 0);
  await snap(owner, '09-offline-draft-publish-tab');
  await okPost('characters/jojo/online', { requestId: randomUUID(), liveVersion: await liveOf('jojo') });
  await owner.close();

  // =============== 4. a non-owner's 发布 tab: the state, no buttons ===============
  for (const [width, height] of SIZES) {
    const page = await open(helperContext, 'characters/jojo', width, height);
    await tab(page, '发布').first().waitFor({ timeout: 20_000 });
    await tab(page, '发布').click();
    await page.waitForTimeout(500);
    const text = ((await page.locator('.wb-avail').innerText()) as string).replace(/\s+/g, ' ').trim();
    assert.match(text, /^现行 v\d+ 在线$/);
    assert.equal(await page.getByRole('button', { name: /^(下线|重新上线)$/ }).count(), 0, 'no 下线 / 重新上线 button');
    await snap(page, `10-publish-tab-non-owner-${width}`);
    // the server refuses it too
    const refused = await helperContext.request.post(`${f.API}/admin/characters/jojo/offline`, {
      data: { requestId: randomUUID(), liveVersion: 1 },
      headers: { origin: f.config.origin, 'x-csrf-token': 'x' },
    });
    assert.ok([401, 403].includes(refused.status()));
    await page.close();
  }
  // an offline character is shown to a non-owner as 已下线 (state, no button)
  const offlinePage = await open(helperContext, 'characters/c09');
  await tab(offlinePage, '发布').first().waitFor({ timeout: 20_000 });
  await tab(offlinePage, '发布').click();
  await offlinePage.waitForTimeout(500);
  assert.match(
    ((await offlinePage.locator('.wb-avail').innerText()) as string).replace(/\s+/g, ' '),
    /^现行 v\d+ 已下线$/,
  );
  await snap(offlinePage, '11-publish-tab-non-owner-offline');
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (errors.length) {
  console.error(errors.join('\n'));
  failure ??= new Error(`${errors.length} browser errors`);
}
if (failure) {
  console.error(failure);
  process.exit(1);
}
console.log('Part 24l browser check passed');
