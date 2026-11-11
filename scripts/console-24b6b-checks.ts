import { randomUUID } from 'node:crypto';
import type { startConsoleFixture } from './console-fixture-24b6.ts';
import { characterProfileHash } from '../apps/server/characters/web-character-catalog.ts';

/**
 * Part 24b-6b: what the console fixes of this part guard, in a REAL browser, on the synthetic site of console-fixture-24b6.ts, at the
 * three window sizes the owner looks at (1280×800, 1440×900, 1920×1080). `check()` collects a problem; nothing stops at the first.
 *   1. 共创收件箱 加入草稿 goes INTO the draft's text (mid-text caret, no new box, the note saved once);
 *   2. 角色工作台: every field of a kind measures the same on every tab; 经历 shows a text box for a character with none;
 *   3. 版本历史: the latest 5 of 7, the detail below the row, 恢复此版本 asks in the row (no dialog), a non-owner has no restore;
 *   4. 关系与故事 → 世界: the name cards and the dashed add boxes are one size;
 *   5. 关系与故事 → 整页版本: the same list, the same words, a restore publishes "恢复自 vN" from the inline confirm;
 *   6. no sideways scroll on any page or state;  7. the navigation (and the workbench rail) never move;
 *   8. 总览's cleanup warning opens 系统状态 on its cleanup section with the failure table in view.
 */
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
type Fixture = Awaited<ReturnType<typeof startConsoleFixture>>;
export type Ctx = {
  f: Fixture;
  page: Page;
  wait: (ms?: number) => Promise<void>;
  open: (route: string) => Promise<void>;
  shot: (name: string) => Promise<void>;
  check: (condition: unknown, message: string) => void;
  sizes: readonly (readonly [number, number])[];
};

const DAY = 86_400_000;
const PAGES = [
  'overview',
  'characters/jojo',
  'cast',
  'cocreation',
  'invites',
  'points',
  'costs',
  'models',
  'system',
  'members',
  'account',
];

export async function run24b6bChecks(ctx: Ctx) {
  const { f, page, wait, open, shot, check, sizes } = ctx;
  const sideways = () =>
    page.evaluate(() => ({
      scroll: document.scrollingElement!.scrollWidth,
      inner: window.innerWidth,
      worst: (() => {
        // The element that reaches furthest to the right, for the report.
        let far: { name: string; right: number } = { name: '', right: 0 };
        for (const el of document.querySelectorAll('.admin-shell *')) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.right > far.right && getComputedStyle(el).position !== 'fixed')
            far = {
              name: `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 40)}`,
              right: Math.round(r.right),
            };
        }
        return far;
      })(),
    }));
  const noSideways = async (label: string) => {
    const s = await sideways();
    check(
      s.scroll <= s.inner,
      `${label}: the page scrolls sideways (${s.scroll} > ${s.inner}; furthest: ${s.worst.name} → ${s.worst.right})`,
    );
  };
  const navRect = () =>
    page.evaluate(() => {
      const nav = document.querySelector('.admin-sidebar') as HTMLElement;
      const r = nav.getBoundingClientRect();
      const rail = document.querySelector('.wb-roster') as HTMLElement | null;
      const rr = rail?.getBoundingClientRect();
      return {
        nav: `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.height)}`,
        rail: rr && rr.width > 0 ? `${Math.round(rr.left)},${Math.round(rr.top)}` : null,
      };
    });
  const scrollToEnd = async () => {
    await page.evaluate(() => {
      window.scrollTo(0, document.scrollingElement!.scrollHeight);
      const c = document.querySelector('.admin-content') as HTMLElement;
      c.scrollTop = c.scrollHeight;
    });
    await wait(250);
  };
  const scrollToTop = () => page.evaluate(() => window.scrollTo(0, 0));
  const tabs = async () => (await page.locator('.wb-tab').allInnerTexts()).map((t: string) => t.trim());
  const tab = async (name: string) => {
    await page.locator('.wb-tab', { hasText: name }).click();
    await wait(450);
  };

  // ------------------------------------------------------------------------------------------------------------------------
  // Fixtures this part needs: wei-guagua gets 7 published versions (written the way a publication writes them), the cast gets 7.
  // ------------------------------------------------------------------------------------------------------------------------
  const { store } = f;
  const ID = 'wei-guagua';
  const ownerId = store.get<{ id: string }>("SELECT id FROM web_admin_members WHERE role='owner'")!.id;
  const liveRow = () =>
    JSON.parse(
      store.get<{ profile_json: string }>(
        'SELECT profile_json FROM web_character_versions WHERE character_id=? ORDER BY version DESC LIMIT 1',
        ID,
      )!.profile_json,
    );
  const maxV = () =>
    store.get<{ v: number }>('SELECT max(version) v FROM web_character_versions WHERE character_id=?', ID)!.v;
  const versionsOf = () =>
    store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions WHERE character_id=?', ID)!.n;
  const publishRow = (at: number, change: (profile: any) => void) => {
    const live = liveRow();
    const profile = structuredClone(live);
    profile.template.version = live.template.version + 1;
    change(profile);
    const configJson = JSON.stringify(profile.template);
    store.run('INSERT INTO character_template_versions VALUES (?,?,?,?)', ID, profile.template.version, configJson, at);
    store.run(
      'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
      profile.template.version,
      configJson,
      ID,
    );
    store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,?)',
      ID,
      profile.template.version,
      JSON.stringify(profile),
      characterProfileHash(profile),
      at,
    );
    store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', profile.template.version, ID);
    store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      ownerId,
      `character-published:${profile.template.version}`,
      ID,
      at,
    );
  };
  let guard = 0;
  while (versionsOf() < 7 && guard++ < 10) {
    const n = versionsOf();
    publishRow(f.clock.now() - (8 - n) * DAY, (p) => {
      p.template.persona += `\n（示例）第 ${n + 1} 版加的一句。`;
    });
  }
  check(versionsOf() === 7, `fixture: wei-guagua has ${versionsOf()} versions (7 wanted)`);
  const OLD_ROWS = store.get<{ n: number }>(
    'SELECT count(*) n FROM web_character_versions WHERE character_id=?',
    ID,
  )!.n;

  // The cast: 7 published versions (a small change of the world text before each publish).
  const castApi = async (path: string, data: unknown) => {
    const response = await f.post(`cast/${path}`, data);
    const body = await response.json().catch(() => ({}));
    return { status: response.status(), body };
  };
  for (let i = 0; i < 7; i++) {
    const draft = (await castApi('draft', {})).body;
    const doc = structuredClone(draft.doc);
    doc.world.background = `${String(doc.world.background).replace(/（第 \d+ 次）$/, '')}（第 ${i + 1} 次）`;
    const saved = (await castApi('save', { requestId: randomUUID(), expectedRevision: draft.revision, doc })).body;
    const published = await castApi('publish', { requestId: randomUUID(), expectedRevision: saved.revision });
    check(
      published.status === 200,
      `fixture: cast publish ${i + 1} answered ${published.status} ${JSON.stringify(published.body).slice(0, 120)}`,
    );
  }

  // ------------------------------------------------------------------------------------------------------------------------
  for (const [width, height] of sizes) {
    await page.setViewportSize({ width, height });
    const at = `${width}×${height}`;

    // ---- 6 + 7: every page: no sideways scroll; the navigation stays put while the page scrolls ----
    for (const route of PAGES) {
      await open(route);
      await noSideways(`${route} ${at}`);
      await scrollToTop();
      const before = await navRect();
      await scrollToEnd();
      const after = await navRect();
      check(
        before.nav === after.nav,
        `${route} ${at}: the navigation moved while scrolling (${before.nav} → ${after.nav})`,
      );
      if (route.startsWith('characters'))
        check(before.rail === after.rail, `${route} ${at}: the rail moved (${before.rail} → ${after.rail})`);
      await scrollToTop();
    }

    // ---- 2: 角色工作台: fields of one kind measure the same on every tab ----
    await open('characters/jojo');
    const names = await tabs();
    for (let i = 0; i < names.length; i++) {
      await page.locator('.wb-tab').nth(i).click();
      await wait(450);
      const m = await page.evaluate(() => {
        const card = document.querySelector('.wb-card')!;
        const vis = (el: Element) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const singles = [
          ...card.querySelectorAll(
            'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=color]):not([type=file]):not([type=range]):not(.cn-chip-input):not(.si), select',
          ),
        ].filter(vis);
        // Named exception (Part 24b-7b): a one-sentence box (data-grow="one": 欢迎词, 一句话描述, a list item, 情境 / 玩家说 / 他回) starts at ONE
        // line and grows with its text, by the owner's rule; the four-line minimum below is the rule for paragraph boxes (data-grow="para").
        const areas = [...card.querySelectorAll('textarea:not([data-grow="one"])')].filter(vis);
        return {
          singleHeights: singles.map((e) => Math.round(e.getBoundingClientRect().height)),
          singles: singles.map((e) => ({
            left: Math.round(e.getBoundingClientRect().left),
            width: Math.round(e.getBoundingClientRect().width),
            name: e.getAttribute('aria-label') ?? '',
          })),
          areaMins: areas.map((e) => getComputedStyle(e).minHeight),
          areaHeights: areas.map((e) => Math.round(e.getBoundingClientRect().height)),
          areaLine: areas.map((e) => parseFloat(getComputedStyle(e).lineHeight)),
          labelSizes: [...card.querySelectorAll('label > span:first-child, .cn-label')]
            .filter(vis)
            .map((e) => getComputedStyle(e).fontSize),
        };
      });
      check(
        new Set(m.singleHeights).size <= 1,
        `角色工作台 ${names[i]} ${at}: single-line fields differ in height ${JSON.stringify([...new Set(m.singleHeights)])}`,
      );
      check(
        m.singleHeights.every((h: number) => h === 40),
        `角色工作台 ${names[i]} ${at}: single-line fields are not 40 px: ${JSON.stringify([...new Set(m.singleHeights)])}`,
      );
      check(
        new Set(m.areaMins).size <= 1,
        `角色工作台 ${names[i]} ${at}: text boxes differ in min-height ${JSON.stringify([...new Set(m.areaMins)])}`,
      );
      check(
        m.areaMins.every((v: string, k: number) => parseFloat(v) >= 4 * m.areaLine[k]),
        `角色工作台 ${names[i]} ${at}: a text box is shorter than four lines (${JSON.stringify(m.areaMins)})`,
      );
      check(
        m.areaHeights.every((h: number, k: number) => h >= parseFloat(m.areaMins[k]) - 1),
        `角色工作台 ${names[i]} ${at}: a text box is under its min-height`,
      );
      const byLeft = new Map<number, Set<number>>();
      for (const s of m.singles) byLeft.set(s.left, (byLeft.get(s.left) ?? new Set()).add(s.width));
      // One width rule per grid column: a column holds the column's width or the whole row's, never a third size
      // (a field with its own button beside it, 单条预演输入, is the one thing that shares its cell).
      const widths = m.singles.filter((s: { name: string }) => !/单条预演输入|运行备注|确认删除|^输入 /.test(s.name));
      const perLeft = new Map<number, Set<number>>();
      for (const s of widths) perLeft.set(s.left, (perLeft.get(s.left) ?? new Set()).add(s.width));
      for (const [left, set] of perLeft)
        check(
          set.size <= 2,
          `角色工作台 ${names[i]} ${at}: ${set.size} different widths in the column at ${left}: ${JSON.stringify([...set])}`,
        );
      void byLeft;
      check(
        new Set(m.labelSizes).size <= 1,
        `角色工作台 ${names[i]} ${at}: labels differ in size ${JSON.stringify([...new Set(m.labelSizes)])}`,
      );
      await noSideways(`角色工作台 ${names[i]} ${at}`);
    }

    // 经历 of a character with none shows a card with a text box (jojo has two; wei-guagua none)
    await open('characters/wei-guagua');
    await tab('经历');
    const emptyPast = await page.evaluate(() => ({
      cards: document.querySelectorAll('.cn-card').length,
      areas: [...document.querySelectorAll('.cn-card textarea')].filter((e) => e.getBoundingClientRect().height > 0)
        .length,
      add: !!document.querySelector('button.cn-add-card'),
    }));
    check(
      emptyPast.cards >= 1 && emptyPast.areas >= 1,
      `经历 ${at}: a character with none shows ${emptyPast.cards} cards, ${emptyPast.areas} text boxes`,
    );
    check(emptyPast.add, `经历 ${at}: no "+ 经历"`);
    await shot(`24b6b-past-empty-${width}`);

    // ---- 3: 版本历史: the latest 5 of 7, detail below the row, the inline confirm, no dialog ----
    await tab('版本历史');
    await page.locator('.vh .ot-row').first().waitFor({ timeout: 10_000 });
    const rows = await page.locator('.vh .ot-row').count();
    const top = maxV();
    const total = versionsOf();
    check(rows === 5, `版本历史 ${at}: ${rows} rows for ${total} versions (5 wanted)`);
    // Named exception (Part 24b-6c): the explanatory line under the list is gone. The count (共 N 个) is the visible text and the
    // "only the latest 5, the older ones are kept" sentence is its hover tip.
    check(
      (await page.locator('.vh .vh-more').innerText()).replace(/\s+/g, '') === `共${total}个`,
      `版本历史 ${at}: the count under the list is missing`,
    );
    check(
      new RegExp(`只列出最近 5 个版本，共 ${total} 个`).test((await page.locator('.vh .vh-more').textContent()) ?? ''),
      `版本历史 ${at}: the hover tip of the count is missing`,
    );
    const firstText = (await page.locator('.vh .ot-row').first().innerText()).replace(/\s+/g, ' ');
    check(
      new RegExp(`^v${top} 现行`).test(firstText),
      `版本历史 ${at}: the first row is not the live v${top}: ${firstText}`,
    );
    await noSideways(`版本历史 ${at}`);
    await shot(`24b6b-history-${width}`);
    await page.locator('.vh .ot-row').nth(2).click();
    await wait(600);
    const below = await page.evaluate(() => {
      const row = document.querySelectorAll('.vh .ot-row')[2] as HTMLElement;
      const panel = row.parentElement!.querySelector('.ot-panel') as HTMLElement;
      const r = row.getBoundingClientRect();
      const p = panel.getBoundingClientRect();
      return {
        gap: Math.round(p.top - r.bottom),
        open: panel.dataset.state,
        drawers: document.querySelectorAll('.admin-drawer:not([hidden]), .admin-dialog, dialog[open]').length,
        tw: Math.round(row.parentElement!.getBoundingClientRect().width),
        pw: Math.round(p.width),
      };
    });
    check(
      below.open === 'open' && below.gap >= -2 && below.gap <= 8,
      `版本历史 ${at}: the detail is not directly below its row (${JSON.stringify(below)})`,
    );
    check(below.drawers === 0, `版本历史 ${at}: a drawer or dialog is open`);
    await noSideways(`版本历史 (a row open) ${at}`);
    await shot(`24b6b-history-open-${width}`);
    await page.locator('.vh .ot-row').nth(2).click();
    await wait(400);
    const restoreButton = page.locator('.vh .ot-row').nth(1).locator('[data-restore]');
    check((await restoreButton.count()) === 1, `版本历史 ${at}: no 恢复此版本 on a restorable row`);
    await restoreButton.click();
    await wait(300);
    const asked = await page.evaluate(() => {
      const row = document.querySelectorAll('.vh .ot-row')[1] as HTMLElement;
      const box = row.querySelector('.vh-confirm') as HTMLElement | null;
      const go = box?.querySelector('[data-restore-go]') as HTMLElement | null;
      return {
        text: box?.querySelector('.vh-confirm-text')?.textContent ?? '',
        goClass: go?.className ?? '',
        goBg: go ? getComputedStyle(go).backgroundColor : '',
        dialogs: document.querySelectorAll('.admin-dialog, dialog[open], [role="dialog"]:not([hidden])').length,
        inRow: !!box,
      };
    });
    check(asked.inRow, `版本历史 ${at}: the confirm is not inside the row`);
    check(
      asked.text === `以 v${top + 1} 重新发布 v${top - 1} 的内容`,
      `版本历史 ${at}: the confirm text is "${asked.text}" (wanted 以 v${top + 1} 重新发布 v${top - 1} 的内容)`,
    );
    check(asked.goBg === 'rgb(91, 79, 196)', `版本历史 ${at}: 确认恢复 is not the row's solid button (${asked.goBg})`);
    check(asked.dialogs === 0, `版本历史 ${at}: a dialog opened`);
    await noSideways(`版本历史 (confirm open) ${at}`);
    await shot(`24b6b-history-confirm-${width}`);
    // cancel, then confirm for real (once per size: each restore adds a version, so the count stays 7+)
    await page.locator('.vh [data-restore-cancel]').click();
    check((await page.locator('.vh .vh-confirm').count()) === 0, `版本历史 ${at}: 取消 left the question open`);
    const before = versionsOf();
    await restoreButton.click();
    await wait(200);
    await page.locator('.vh [data-restore-go]').click();
    await page
      .waitForFunction(() => document.querySelectorAll('.vh .ot-row')[0]?.textContent?.includes('恢复自'), null, {
        timeout: 15_000,
      })
      .catch(() => {});
    await wait(600);
    check(
      versionsOf() === before + 1,
      `版本历史 ${at}: a restore did not publish exactly one new version (${before} → ${versionsOf()})`,
    );
    const live = (await page.locator('.vh .ot-row').first().innerText()).replace(/\s+/g, ' ');
    check(
      new RegExp(`^v${maxV()} 现行.*恢复自 v${top - 1}`).test(live),
      `版本历史 ${at}: the live row after a restore reads "${live}"`,
    );
    check(
      (await page.locator('.vh .ot-row').count()) === 5,
      `版本历史 ${at}: ${await page.locator('.vh .ot-row').count()} rows after the restore (5 wanted)`,
    );
    await shot(`24b6b-history-restored-${width}`);
    // Put the fixture back to what the next size expects: seven versions listed as v(N-4)..vN. (Each size adds one version; the
    // list still shows five and the "共 N 个" line moves; the old rows stay.)

    // a non-owner sees no restore button (a second login with a read-only role)
    if (width === sizes[0]![0]) {
      const grant = await (
        await f.post('members/issue', {
          requestId: randomUUID(),
          label: `只读 ${width}`,
          memberId: null,
          permissions: ['characters.read:*'],
        })
      ).json();
      const viewer = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height } });
      const login = await viewer.request.post(`${f.API}/admin/login`, {
        data: { token: grant.token },
        headers: { origin: f.config.origin },
      });
      check(login.status() === 200, `non-owner login answered ${login.status()}`);
      const p2 = await viewer.newPage();
      await p2.goto(`${f.origin}/?mode=provider-admin#/characters/${ID}`);
      await p2.locator('.wb-tab').first().waitFor({ timeout: 20_000 });
      await p2.locator('.wb-tab', { hasText: '版本历史' }).click();
      await p2.locator('.vh .ot-row').first().waitFor({ timeout: 10_000 });
      check((await p2.locator('.vh [data-restore]').count()) === 0, `版本历史 ${at}: a non-owner sees 恢复此版本`);
      await p2.locator('.vh .ot-row').nth(1).click();
      await p2.waitForTimeout(500);
      check(
        (await p2.locator('.vh [data-restore]').count()) === 0,
        `版本历史 ${at}: a non-owner sees 恢复此版本 inside a row's detail`,
      );
      await viewer.close();
    }
    void OLD_ROWS;

    // ---- 4 + 5: 关系与故事 ----
    await open('cast');
    await noSideways(`关系与故事 ${at}`);
    const world = await page.evaluate(() => {
      const row = document.querySelector('.cs-world-card .cs-people-row') as HTMLElement;
      const boxes = [...row.querySelectorAll('button.cs-chip, button.cs-dashed')].map((b) => {
        const r = b.getBoundingClientRect();
        return {
          w: Math.round(r.width * 10) / 10,
          h: Math.round(r.height * 10) / 10,
          cls: (b as HTMLElement).className.includes('dashed') ? 'dashed' : 'card',
          left: Math.round(r.left),
        };
      });
      return { boxes, tracks: getComputedStyle(row).gridTemplateColumns };
    });
    check(
      world.boxes.length >= 2 &&
        world.boxes.some((b: { cls: string }) => b.cls === 'dashed') &&
        world.boxes.some((b: { cls: string }) => b.cls === 'card'),
      `世界 ${at}: expected name cards and a dashed add box, got ${JSON.stringify(world.boxes)}`,
    );
    check(
      new Set(world.boxes.map((b: { w: number; h: number }) => `${b.w}x${b.h}`)).size === 1,
      `世界 ${at}: the cards and the dashed box differ in size ${JSON.stringify([...new Set(world.boxes.map((b: { w: number; h: number }) => `${b.w}x${b.h}`))])}`,
    );
    await page.locator('.cs-world-card').scrollIntoViewIfNeeded();
    await shot(`24b6b-world-${width}`);
    // a person with a long name: the card stays one size
    await page.locator('.cs-world-card button.cs-dashed').click();
    await wait(400);
    const nameField = page.locator('.cs-world-card .cs-person-row input').first();
    await nameField.fill('这是一个特别特别特别长的名字用来检验卡片不会撑开');
    await wait(400);
    const worldLong = await page.evaluate(() => {
      const row = document.querySelector('.cs-world-card .cs-people-row') as HTMLElement;
      return [...row.querySelectorAll('button.cs-chip, button.cs-dashed')].map((b) => {
        const r = b.getBoundingClientRect();
        return `${Math.round(r.width * 10) / 10}x${Math.round(r.height * 10) / 10}`;
      });
    });
    check(
      new Set(worldLong).size === 1,
      `世界 (long name) ${at}: sizes differ ${JSON.stringify([...new Set(worldLong)])}`,
    );
    await noSideways(`世界 (long name) ${at}`);
    // the pair panel and a group open
    await open('cast');

    // 整页版本: the same list
    const castRows = await page.locator('.cs-versions .ot-row').count();
    check(castRows === 5, `整页版本 ${at}: ${castRows} rows (5 wanted of the published versions)`);
    const castFirst = (await page.locator('.cs-versions .ot-row').first().innerText()).replace(/\s+/g, ' ');
    check(/现行/.test(castFirst), `整页版本 ${at}: the live version is not marked: ${castFirst}`);
    check(!/回滚/.test(await page.locator('body').innerText()), `关系与故事 ${at}: the word 回滚 is still on the page`);
    await page.locator('.cs-versions').scrollIntoViewIfNeeded();
    await page.locator('.cs-versions .ot-row').nth(2).click();
    await wait(600);
    await noSideways(`整页版本 (a row open) ${at}`);
    await shot(`24b6b-cast-versions-${width}`);
    await page.locator('.cs-versions .ot-row').nth(2).click();
    await wait(300);
    const castBefore = (await castApi('versions', {})).body.latest as number;
    const btn = page.locator('.cs-versions .ot-row').nth(1).locator('[data-restore]');
    check((await btn.count()) === 1, `整页版本 ${at}: no 恢复此版本 on a row`);
    const target = Number(await btn.getAttribute('data-restore'));
    await btn.click();
    await wait(300);
    const castAsk = await page.evaluate(() => ({
      text: document.querySelector('.cs-versions .vh-confirm-text')?.textContent ?? '',
      dialogs: document.querySelectorAll('.admin-dialog, dialog[open], [role="dialog"]:not([hidden])').length,
    }));
    check(
      castAsk.text === `以 v${castBefore + 1} 重新发布 v${target} 的内容`,
      `整页版本 ${at}: the confirm text is "${castAsk.text}"`,
    );
    check(castAsk.dialogs === 0, `整页版本 ${at}: a dialog opened`);
    await shot(`24b6b-cast-confirm-${width}`);
    await page.locator('.cs-versions [data-restore-go]').click();
    await wait(1500);
    const castAfter = (await castApi('versions', {})).body;
    check(
      castAfter.latest === castBefore + 1,
      `整页版本 ${at}: latest is v${castAfter.latest} after a restore (v${castBefore + 1} wanted)`,
    );
    const entry = (castAfter.versions as { version: number; kind: string; fromVersion: number }[]).find(
      (v) => v.version === castAfter.latest,
    );
    check(
      entry?.kind === 'rollback' && entry.fromVersion === target,
      `整页版本 ${at}: the new version is ${JSON.stringify(entry)}`,
    );
    const castLive = (await page.locator('.cs-versions .ot-row').first().innerText()).replace(/\s+/g, ' ');
    check(
      new RegExp(`^v${castBefore + 1} 现行.*恢复自 v${target}`).test(castLive),
      `整页版本 ${at}: the live row reads "${castLive}"`,
    );
    await shot(`24b6b-cast-restored-${width}`);

    // ---- 1: 共创收件箱: 加入草稿 goes into the text ----
    // (mid-text caret in JOJO's 性格 box; checked at the first size only, since a saved note is locked afterwards)
    await open('cocreation');
    await page.locator('.cc-row.is-active').waitFor({ timeout: 10_000 });
    const noteArea = page.locator('.cc-draft-field textarea').first();
    await noteArea.waitFor({ timeout: 10_000 });
    check((await page.locator('.cc-adopt').count()) === 0, `共创收件箱 ${at}: an editor form is open before 加入草稿`);
    await noSideways(`共创收件箱 ${at}`);
    if (width === sizes[0]![0]) {
      const text = await noteArea.inputValue();
      const textareasBefore = await page.locator('.cc-detail-grid textarea').count();
      // click in the middle of the box
      const box = await noteArea.boundingBox();
      await noteArea.click({ position: { x: Math.min(box.width - 10, 90), y: 14 } });
      const caret = await noteArea.evaluate((el: HTMLTextAreaElement) => el.selectionStart);
      check(
        caret > 0 && caret < text.length,
        `共创收件箱: the click did not land mid-text (caret ${caret} of ${text.length})`,
      );
      const answerText = (await page.locator('.cc-answer .cc-answer-text').first().innerText()).trim();
      await page.locator('.cc-answer .cc-adopt-open:not([disabled])').first().click();
      await wait(250);
      const after = await noteArea.inputValue();
      check(
        after === text.slice(0, caret) + answerText + text.slice(caret),
        `共创收件箱: the note is not exactly at the caret: before ${JSON.stringify(text)} after ${JSON.stringify(after)}`,
      );
      check(
        after.startsWith(text.slice(0, caret)) && after.endsWith(text.slice(caret)),
        '共创收件箱: the text around the note changed',
      );
      check(
        (await page.locator('.cc-detail-grid textarea').count()) === textareasBefore,
        '共创收件箱: a new text box appeared',
      );
      const lit = await page.evaluate(() => {
        const hit = document.querySelector('.cc-mirror mark.cc-hit') as HTMLElement | null;
        return hit
          ? {
              text: hit.textContent,
              on: hit.classList.contains('is-on'),
              bg: getComputedStyle(hit).backgroundColor,
              tr: getComputedStyle(hit).transitionDuration,
            }
          : null;
      });
      check(
        !!lit && lit.text === answerText,
        `共创收件箱: the inserted passage is not highlighted (${JSON.stringify(lit)})`,
      );
      await shot(`24b6b-inbox-added-${width}`);
      // move it: cut the passage and put it at the end, then save
      const moved = text + answerText;
      await noteArea.fill(moved);
      await page.locator('.cc-adopt-save').click();
      await wait(1200);
      const draft = (await (await f.post('characters/jojo/detail', {})).json()).draft;
      const persona: string = draft.profile.template.persona;
      check(
        persona.split(answerText).length - 1 === 1,
        `共创收件箱: the saved draft has the note ${persona.split(answerText).length - 1} times`,
      );
      check(persona === moved, `共创收件箱: the saved persona is not what the box held`);
      await shot(`24b6b-inbox-saved-${width}`);
    } else {
      await shot(`24b6b-inbox-${width}`);
    }

    // ---- 8: 总览 warning → 系统状态 cleanup ----
    const retention = {
      failing: 2,
      oldestAgeBucket: '1-7d',
      lastSuccessAt: f.clock.now() - 3_600_000,
      purging: 1,
      oldestPurgingMinutes: 5,
      failures: [
        {
          code: 'WEB_RETENTION_FAILED',
          phase: 'clearDatabase',
          sub: 'audit_source',
          errorName: 'Error',
          messageShape: 'not <tok>: <tok>',
          count: 3,
        },
        {
          code: 'WEB_RETENTION_FAILED',
          phase: 'clearBlobs',
          sub: 'private_audio',
          errorName: 'TypeError',
          messageShape: '<tok> is not a function',
          count: 1,
        },
      ],
    };
    const patch = async (route: any) => {
      const response = await route.fetch();
      const json = await response.json();
      const target = json.warnings ? json : (json.view ?? json);
      if (target.warnings) target.warnings.retentionFailing = 2;
      if ('retention' in target) target.retention = retention;
      await route.fulfill({ response, json });
    };
    await page.route('**/system/status', patch);
    await page.route('**/overview/read', patch);
    await open('overview');
    const link = page.locator('a.ov-warn');
    check((await link.count()) === 1, `总览 ${at}: no warning link`);
    if ((await link.count()) === 1) {
      const where = { text: (await link.innerText()).replace(/\s+/g, ' '), href: await link.getAttribute('href') };
      check(
        /2 位玩家的清理失败/.test(where.text) && where.href === '#/system/cleanup',
        `总览 ${at}: the warning is ${JSON.stringify(where)}`,
      );
      await shot(`24b6b-overview-warning-${width}`);
      await link.click();
      await page.locator('.system-section[data-section="cleanup"]').waitFor({ timeout: 10_000 });
      await wait(900);
      const landed = await page.evaluate(() => {
        const section = document.querySelector('.system-section[data-section="cleanup"]') as HTMLElement;
        const table = section.querySelector('table, .ot') as HTMLElement | null;
        const note = section.querySelector('.sys-cleanup-note') as HTMLElement | null;
        const sr = section.getBoundingClientRect();
        const tr = table?.getBoundingClientRect();
        return {
          route: location.hash,
          top: Math.round(sr.top),
          tableVisible: !!tr && tr.top >= 0 && tr.bottom <= innerHeight,
          note: note?.textContent ?? '',
          text: section.textContent ?? '',
          rows: table ? table.querySelectorAll('tbody tr, .ot-row').length : 0,
        };
      });
      check(landed.route === '#/system/cleanup', `总览 → 系统状态 ${at}: the address is ${landed.route}`);
      check(
        landed.top >= 0 && landed.top < height / 2,
        `总览 → 系统状态 ${at}: the cleanup section is at ${landed.top}, not at the top`,
      );
      check(landed.tableVisible, `总览 → 系统状态 ${at}: the failure table is not fully in view`);
      check(landed.rows === 2, `总览 → 系统状态 ${at}: the failure table has ${landed.rows} rows`);
      check(
        landed.note === '系统每天会自动重试。连续失败说明需要修代码：把这张表交给开发。',
        `总览 → 系统状态 ${at}: the note under the table is "${landed.note}"`,
      );
      check(
        !/重试\s*按钮/.test(landed.text) &&
          (await page.locator('.system-section[data-section="cleanup"] button').count()) === 0,
        `总览 → 系统状态 ${at}: the cleanup section has a button (no retry action exists)`,
      );
      check(
        !/[0-9a-f]{8}-[0-9a-f]{4}|@|玩家#/.test(landed.text),
        `总览 → 系统状态 ${at}: the table shows an id or a name`,
      );
      await noSideways(`系统状态 (cleanup) ${at}`);
      await shot(`24b6b-system-cleanup-${width}`);
    }
    await page.unroute('**/system/status', patch);
    await page.unroute('**/overview/read', patch);

    // ---- 6: more states: the open rail, an invite batch with 10 codes ----
    await open('characters/jojo');
    await page.locator('.wb-roster').hover();
    await wait(500);
    await noSideways(`角色工作台 (open rail) ${at}`);
    await page.mouse.move(700, 500);
    await open('invites');
    const batch = page.locator('tr[data-batch], .ot-row').filter({ hasText: '测试组' }).first();
    if ((await batch.count()) > 0) {
      await batch.click({ position: { x: 14, y: 8 } });
      await wait(900);
      await noSideways(`邀请与额度 (10-code batch open) ${at}`);
      await shot(`24b6b-invites-open-${width}`);
    } else check(false, `邀请与额度 ${at}: the 10-code batch row was not found`);
  }
}
