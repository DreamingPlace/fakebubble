import './player-build-guard.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture, NOW as FIXTURE_NOW } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';
import { sampleCastRaw } from '../tests/web/fixtures/cast-sample.ts';

/**
 * Part 39 (admin side) in a REAL browser, on the synthetic site of console-fixture-24b6.ts (nothing leaves the machine), at 1440×900 and
 * 1280×800: the co-creation inbox shows a relation note with its members in the console's order (首页顺序), a pair's two ratings and
 * reason, 「新建组合」 with a name field, then 「加入：<name>」 once the group exists; 整理 (one paid call) only fills the box; 采纳 writes the
 * STORY into the cast 草稿 (ratings grid untouched, nothing published); 不计入 drops ratings from 玩家眼中的关系; no id / email / nickname on
 * screen; no sideways scroll; no browser error; no word of ADMIN_COPY's forbidden list.
 *
 * usage: node scripts/check-web-cocreation-39-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const f = await startConsoleFixture({ provider: { draftMs: 250, reviewMs: 250 } });
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  watchRequests(page);
  const wait = (ms = 600) => quietWait(page, ms);
  const json = async (path: string, body: unknown) => (await f.post(path, body)).json();

  // ---- the cast draft holds the three characters (a story can only name characters the draft has) ----
  const raw = sampleCastRaw();
  const ids = ['wei-guagua', 'jojo', 'chen-jimi'];
  const doc = {
    ...raw,
    characters: raw.characters.slice(1, 4).map((c, i) => ({ ...c, characterId: ids[i]! })),
    people: [],
    ratings: {},
    directions: [],
    groups: [],
    stories: [],
    memes: [],
  };
  const draft0 = await json('cast/draft', {});
  await json('cast/save', { requestId: randomUUID(), expectedRevision: draft0.revision, doc });

  // ---- three relation notes straight into the tables (what a player's submit writes) ----
  // the fixture's own clock (a fixed NOW, then moving on): real time would date the notes after the server's "now" once it has passed
  const NOW = FIXTURE_NOW;
  const note = (
    id: string,
    members: string[],
    ratings: [string, string, number][],
    reason: string | null,
    text: string,
  ) => {
    f.store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,kind,partner_id)
      VALUES (?,?,?,?,?,?,'pair',?)`,
      id,
      members[0]!,
      f.store.get<{ id: string }>('SELECT id FROM web_principals ORDER BY rowid LIMIT 1')!.id,
      `req-${id}`,
      'b'.repeat(64),
      NOW - 60_000,
      members[1]!,
    );
    f.store.run(
      "INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,0,'pair-story','free','text',?)",
      id,
      JSON.stringify(text),
    );
    f.store.run(
      'INSERT INTO web_cocreation_relations(submission_id,member_count,set_key,reason) VALUES (?,?,?,?)',
      id,
      members.length,
      [...members].sort().join('|'),
      reason,
    );
    members.forEach((m, i) => f.store.run('INSERT INTO web_cocreation_members VALUES (?,?,?)', id, i, m));
    for (const [from, to, stars] of ratings)
      f.store.run('INSERT INTO web_cocreation_ratings VALUES (?,?,?,?)', id, from, to, stars);
  };
  // members are stored in console order by the server; the fixture's console order is wei-guagua, jojo, chen-jimi, ...
  note(
    'rel-pair-a',
    ['wei-guagua', 'jojo'],
    [
      ['wei-guagua', 'jojo', 4],
      ['jojo', 'wei-guagua', 1],
    ],
    '一个爱闹一个嫌吵。',
    '她们小学同桌三年。',
  );
  note(
    'rel-pair-b',
    ['wei-guagua', 'jojo'],
    [
      ['wei-guagua', 'jojo', 0],
      ['jojo', 'wei-guagua', 0],
    ],
    '随便写的',
    '灌水灌水灌水',
  );
  note('rel-group', ['wei-guagua', 'jojo', 'chen-jimi'], [], null, '三个人一起在天台吃过泡面。');

  const listed = await json('characters/list', {});
  const homeIds: string[] = (await json('characters/home-order', {})).order;
  const nameOf = new Map<string, string>(
    listed.characters.map((c: { characterId: string; displayName: string }) => [c.characterId, c.displayName]),
  );
  const expectedOrder: string[] = homeIds.filter((id) => nameOf.has(id)).map((id) => nameOf.get(id)!);
  const gridBefore = JSON.stringify((await json('cast/draft', {})).doc.ratings);

  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    const at = `${width}`;
    const shot = async (name: string) => {
      if (shots) {
        await wait(300);
        await page.screenshot({ path: join(shots, `cocreation-39-${name}-${at}.png`), fullPage: true });
      }
    };
    await page.goto(`${f.origin}/?mode=provider-admin#/cocreation`);
    await page.reload();
    await page.locator('.cc-row-open').first().waitFor({ timeout: 20_000 });
    await wait(900);

    // B: the character chips follow the console's order
    const chips: string[] = await page.locator('.cc-chip-row').first().locator('.cc-filter-chip').allInnerTexts();
    const names = chips.slice(1).map((t) => t.replace(/\s+\d+$/, '').trim());
    check(
      expectedOrder.length > 3 && names.slice(0, expectedOrder.length).join('|') === expectedOrder.join('|'),
      `${at}: the filter chips follow 首页顺序 (${names.join('|')} vs ${expectedOrder.join('|')})`,
    );

    // the pair note: members in console order, two ratings with their words, the reason, a new group with a name field
    await page.locator('.cc-row', { hasText: '灌水' }).first().locator('.cc-row-open').waitFor();
    await page.locator('.cc-row', { hasText: '同桌三年' }).first().locator('.cc-row-open').click();
    await page.locator('.cr-panel').waitFor({ timeout: 15_000 });
    await wait(600);
    const members: string[] = await page.locator('.cr-panel .cr-member').allInnerTexts();
    check(
      members.length === 2 && members.join('|') === expectedOrder.slice(0, 2).join('|'),
      `${at}: members in console order (${members.join('|')})`,
    );
    const ratings: string[] = await page.locator('.cr-panel .cr-rating').allInnerTexts();
    check(
      ratings.length === 2 && /形影不离/.test(ratings[0]!) && /话不投机/.test(ratings[1]!),
      `${at}: two ratings with their words (${ratings.join(' / ')})`,
    );
    check(
      /一个爱闹一个嫌吵/.test(await page.locator('.cr-panel .cr-reason').innerText()),
      `${at}: the reason is shown`,
    );
    if (at === '1440') {
      check((await page.locator('.cr-panel [data-match="new"]').count()) === 1, `${at}: 新建组合 is offered`);
      check(
        (await page.locator('.cr-panel [data-group-name]').inputValue()).includes('与'),
        `${at}: the name field holds the A与B name`,
      );
    } else
      check((await page.locator('.cr-panel [data-match="join"]').count()) === 1, `${at}: the adopted group is joined`);
    await shot('relation-pair');

    // 整理: one paid call, the first click only asks; the answer only fills the box (nothing adopted)
    const tidy = page.locator('.cr-panel [data-pw-send="cocreation-tidy"]');
    await tidy.click();
    check(/确认付费/.test(await tidy.innerText()), `${at}: 整理 asks before it pays`);
    await tidy.click();
    await page.waitForFunction(
      () =>
        /（整理）/.test((document.querySelector('.cr-panel [data-story]') as HTMLTextAreaElement | null)?.value ?? ''),
      null,
      { timeout: 15_000 },
    );
    check(/像是玩家自己的经历/.test(await page.locator('.cr-panel .cr-flags').innerText()), `${at}: the flag is shown`);
    check(
      (await json('cast/draft', {})).doc.groups.length === (at === '1440' ? 0 : 1),
      `${at}: 整理 changed nothing in the cast`,
    );
    await shot('relation-tidied');

    if (at === '1440') {
      // 采纳: the story goes into the 草稿; the grid is untouched and nothing is published
      await page.locator('.cr-panel [data-story]').fill('她们小学同桌三年，一直在一起。');
      await page.locator('.cr-panel .cr-adopt').click();
      await page.locator('.cr-panel .cr-decided', { hasText: '已采纳' }).waitFor({ timeout: 15_000 });
      const after = await json('cast/draft', {});
      check(
        after.doc.groups.length === 1 && after.doc.groups[0].stories[0]?.summary === '她们小学同桌三年，一直在一起。',
        `${at}: the story is in a new group of the 草稿`,
      );
      check(JSON.stringify(after.doc.ratings) === gridBefore, `${at}: the ratings grid is untouched`);
      check((await json('cast/versions', {})).versions.length === 0, `${at}: nothing was published`);
      await shot('relation-adopted');
    }

    // the second note about the same two now says 加入：<group>
    await page.reload();
    await page.locator('.cc-row-open').first().waitFor({ timeout: 20_000 });
    // the newest note (this one, now that the notes are dated from the fixture's clock) opens by itself; a click would close it
    await page.waitForTimeout(1500);
    if ((await page.locator('.cr-panel').count()) === 0)
      await page.locator('.cc-row', { hasText: '灌水' }).first().locator('.cc-row-open').click();
    await page.locator('.cr-panel').waitFor({ timeout: 15_000 });
    if (at === '1440')
      check(
        /加入：/.test(await page.locator('.cr-panel .cr-match').innerText()),
        `${at}: the same two now JOIN the group`,
      );

    // the group note: three members, no ratings, no reason
    await page.locator('.cc-row', { hasText: '天台' }).first().locator('.cc-row-open').click();
    await page.locator('.cr-panel .cr-member').nth(2).waitFor({ timeout: 15_000 });
    check((await page.locator('.cr-panel .cr-rating').count()) === 0, `${at}: a group has no ratings`);
    await shot('relation-group');

    // 不计入 on the spam note, then 玩家眼中的关系
    await page.locator('.cc-row', { hasText: '灌水' }).first().locator('.cc-row-open').click();
    await page.locator('.cr-panel .cr-exclude').waitFor({ timeout: 15_000 });
    if ((await page.locator('.cr-panel .cr-exclude').innerText()).trim() === '不计入')
      await page.locator('.cr-panel .cr-exclude').click();
    await page.locator('.cr-panel .cr-exclude', { hasText: '计入' }).waitFor();
    await page.locator('.seg-button[data-seg="relations"]').click();
    await page.locator('.cr-view .admin-table tbody tr').first().waitFor({ timeout: 15_000 });
    await wait(700);
    const rows: string[] = await page.locator('.cr-view .admin-table tbody tr').allInnerTexts();
    check(rows.length === 2, `${at}: two directed pairs are listed (${rows.length})`);
    check(/形影不离|4/.test(rows[0] ?? '') || rows.every((r) => /\d/.test(r)), `${at}: the rows carry numbers`);
    const forward = (rows[0] ?? '').replace(/\s+/g, ' ');
    check(/\b1\b/.test(forward), `${at}: the spam rating is not counted (${forward})`);
    await shot('relations-view');

    // hygiene
    const body: string = await page.locator('body').innerText();
    check(!/rel-pair|玩家#|@/.test(body), `${at}: no id, email or nickname on the page`);
    check(!/现行|服务器草稿|修订/.test(body), `${at}: no forbidden wording`);
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `${at}: no sideways scroll`,
    );
  }

  // ================= the PLAYER sheet (Part 39: A, C, D, E) =================
  const catalogNames: string[] = homeIds.filter((id) => nameOf.has(id)).map((id) => nameOf.get(id)!);
  const playerCtx = await f.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const view: Page = await playerCtx.newPage();
  view.on('pageerror', (error: unknown) => errors.push(`player pageerror ${String(error)}`));
  const pshot = async (name: string) => {
    if (shots) {
      await view.waitForTimeout(400);
      await view.screenshot({ path: join(shots, `cocreation-39-player-${name}.png`) });
    }
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    await view.goto(`${f.origin}/?mode=provider`);
    await view.waitForTimeout(2500);
    if (await view.locator('.avatar-choice[aria-label^="选择"]:not([inert])').count()) break;
  }
  await view.locator('.avatar-choice[aria-label^="选择"]:not([inert])').first().click();
  await view.waitForTimeout(900);
  await view.mouse.click(195, 380);
  await view.waitForSelector('.page-shell[data-phase="chat"]');
  await view.waitForTimeout(900);
  await view
    .locator('.chat-guide')
    .click({ timeout: 4000 })
    .catch(() => {});
  await view.locator('.card-slot.is-chat .chat-more').click();
  await view.getByRole('menuitem', { name: /一起共创角色/ }).click();
  await view.locator('.cc-sheet').waitFor();
  await view.locator('.cc-face').first().waitFor();
  await view.waitForTimeout(700);

  // A: the world background, plain text, read only
  check(/./.test(await view.locator('.cc-world').innerText()), 'player: the world background is shown');
  check(
    (await view.locator('.cc-world textarea, .cc-world input').count()) === 0,
    'player: the world background has no editor',
  );
  check(
    JSON.stringify(await json('cast/draft', {})).includes(
      ((await view.locator('.cc-world').innerText()) || '~').slice(0, 8),
    ),
    'player: the text is the saved draft background',
  );
  await pshot('sheet-390');

  // C: the dice, then the chips in the console order, the ＋ menu opens to the right only
  await view.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
  await view.locator('.cc-rel-dice').click();
  await view.locator('.cc-rel:not([hidden])').waitFor();
  await view.waitForTimeout(500);
  const chipNames = async (): Promise<string[]> =>
    (await view.locator('.cc-rel-chips .cc-rel-chip').allInnerTexts()).map((t: string) => t.replace(/[✕\s]/g, ''));
  const inCatalogOrder = (list: string[]) => list.join('|') === catalogNames.filter((n) => list.includes(n)).join('|');
  check(
    (await chipNames()).length === 2 && inCatalogOrder(await chipNames()),
    `player: the dice chose two, in console order (${(await chipNames()).join('|')})`,
  );
  await pshot('choose-390');
  await view.locator('.cc-rel-plus').click();
  await view.locator('.cc-rel-menu').waitFor();
  await view.waitForTimeout(350);
  const plusBox = await view.locator('.cc-rel-plus').boundingBox();
  const menuBox = await view.locator('.cc-rel-menu').boundingBox();
  check(
    menuBox && plusBox && menuBox.x >= plusBox.x + plusBox.width - 1,
    'player: the ＋ menu opens to the right only',
  );
  const options: string[] = await view.locator('.cc-rel-option').allInnerTexts();
  check(
    options.join('|') === catalogNames.join('|'),
    `player: the menu lists the console order (${options.slice(0, 4).join('|')})`,
  );
  await pshot('plus-menu-390');
  // a group of three: choose a third, write the story, the name inserts at the cursor
  await view.locator('.cc-rel-option:not(.is-taken)').first().click();
  check((await view.locator('.cc-rel').getAttribute('data-mode')) === 'group', 'player: three characters make a group');
  check(
    (await view.locator('.cc-rel-area').count()) === 1 &&
      (await view.locator('.cc-rel-stars, .cc-stars').count()) === 0,
    'player: a group has the story only',
  );
  const groupNames = await chipNames();
  const area = view.locator('.cc-rel-area');
  await area.fill('一起吃泡面。');
  await area.evaluate((el: HTMLTextAreaElement) => {
    el.focus();
    el.setSelectionRange(0, 0);
  });
  await view.locator('.cc-rel-chips .cc-rel-name').nth(1).click();
  check(
    (await area.inputValue()) === `${groupNames[1]}一起吃泡面。`,
    `player: a name inserts at the cursor (${await area.inputValue()})`,
  );
  await pshot('group-390');
  await view.locator('.cc-rel-next').click();
  await view.getByText(/收到了你的小纸条/).waitFor({ timeout: 15_000 });
  const groupRow = f.store.get<{ n: number }>(
    "SELECT count(*) n FROM web_cocreation_members m JOIN web_cocreation_relations r ON r.submission_id=m.submission_id WHERE r.member_count=3 AND r.submission_id NOT LIKE 'rel-%'",
  )!;
  check(
    groupRow.n === 3,
    `player: the group was stored with three members (${groupRow.n}; ${JSON.stringify(f.store.all('SELECT submission_id,member_count FROM web_cocreation_relations'))})`,
  );
  check(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_ratings')!.n >= 0,
    'player: ratings table readable',
  );

  // D: a pair, four steps in order
  await view.waitForTimeout(2200);
  await view
    .locator('.cc-sheet')
    .waitFor({ state: 'detached', timeout: 8000 })
    .catch(() => {});
  await view.locator('.card-slot.is-chat .chat-more').click();
  await view.getByRole('menuitem', { name: /一起共创角色/ }).click();
  await view.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
  await view.locator('.cc-rel-dice').click();
  await view.locator('.cc-rel:not([hidden])').waitFor();
  const pairNames = await chipNames();
  check(pairNames.length === 2, 'player: a pair has two chips');
  check((await view.locator('.cc-rel-next').innerText()).includes('下一步'), 'player: step 1 → 下一步');
  await view.locator('.cc-rel-next').click();
  await view.locator('.cc-rate').first().waitFor();
  check((await view.locator('.cc-rel-bars i.on').count()) === 2, 'player: step 2 of 4');
  check(await view.locator('.cc-rel-next').isDisabled(), 'player: both ratings are needed before 下一步');
  const words = ['水火不容', '话不投机', '点头之交', '结伴同行', '形影不离', '暗生情愫'];
  const rows = view.locator('.cc-rate');
  await rows.nth(0).locator('[data-stars="4"]').click();
  await rows.nth(1).locator('[data-stars="0"]').click();
  await view.waitForTimeout(400);
  check((await rows.nth(0).locator('.cc-word .is-shown').innerText()) === words[4], 'player: 4 → 形影不离');
  check((await rows.nth(1).locator('.cc-word .is-shown').innerText()) === words[0], 'player: 0 → 水火不容');
  const sizes = await view
    .locator('.cc-word span')
    .evaluateAll((els: HTMLElement[]) =>
      els.map((e) => `${getComputedStyle(e).fontSize}|${e.getBoundingClientRect().height}`),
    );
  check(
    new Set(sizes).size === 1,
    `player: the six words share one size and one line (${[...new Set(sizes)].join(',')})`,
  );
  await pshot('rate-390');
  await view.locator('.cc-rel-next').click();
  await view.locator('.cc-rel-area').waitFor();
  await view.locator('.cc-rel-area').fill('玩家写的理由。');
  await view.locator('.cc-rel-next').click();
  await view.locator('.cc-rel-area').waitFor();
  check((await view.locator('.cc-rel-bars i.on').count()) === 4, 'player: step 4 of 4');
  await view.locator('.cc-rel-area').fill('她们小学同桌三年。');
  await pshot('story-390');
  await view.locator('.cc-rel-next').click();
  await view.getByText(/收到了你的小纸条/).waitFor({ timeout: 15_000 });
  const pairRow = f.store.all<{ from_id: string; to_id: string; stars: number }>(
    "SELECT from_id,to_id,stars FROM web_cocreation_ratings r JOIN web_cocreation_relations x ON x.submission_id=r.submission_id WHERE x.member_count=2 AND x.reason='玩家写的理由。' ORDER BY r.rowid",
  );
  check(
    pairRow.length === 2 &&
      pairRow
        .map((r) => r.stars)
        .sort()
        .join() === '0,4',
    'player: the pair stored both whole-star ratings',
  );
  await view.waitForTimeout(2200);

  // 1440: the two columns, tight (the right column leaves no big empty area below it)
  await view
    .locator('.cc-sheet')
    .waitFor({ state: 'detached', timeout: 8000 })
    .catch(() => {});
  await view.locator('.card-slot.is-chat .chat-more').click();
  await view.getByRole('menuitem', { name: /一起共创角色/ }).click();
  await view.locator('.cc-rel-dice').scrollIntoViewIfNeeded();
  await view.locator('.cc-rel-dice').click();
  await view.locator('.cc-rel-next').click();
  await view.locator('.cc-rate').first().waitFor();
  await view.setViewportSize({ width: 1440, height: 900 });
  await view.waitForTimeout(600);
  if (await view.locator('.cc-sheet').count()) {
    const left = await view.locator('.cc-rel-left').boundingBox();
    const right = await view.locator('.cc-rel-right').boundingBox();
    check(left && right && right.x > left.x + left.width - 1, 'player 1440: two columns side by side');
    const grid = await view.locator('.cc-rel-grid').boundingBox();
    check(
      grid && grid.y + grid.height <= 900 && grid.height < 700,
      `player 1440: the columns are tight (${grid?.height})`,
    );
    check(
      await view.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      'player 1440: no sideways scroll',
    );
    await pshot('rate-1440');
  } else check(false, 'player 1440: the sheet did not open');
  await playerCtx.close();
} finally {
  await f.close();
}
if (errors.length) problems.push(...errors);
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log('check-web-cocreation-39-browser: ok');
