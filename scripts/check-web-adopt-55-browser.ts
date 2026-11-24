import './player-build-guard.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture, NOW as FIXTURE_NOW } from './console-fixture-24b6.ts';
import { quietWait, watchRequests } from './console-quiet.ts';

/**
 * Part 55 in a REAL browser, on the synthetic site of console-fixture-24b6.ts (nothing leaves the machine), at 1440×900 and 1280×800:
 * 共创收件箱 opens on 新; every answer has 采纳; adopting writes into the character's 草稿 on the SERVER at its current revision (no
 * revision is sent), the card leaves 新 with a short motion and the next one opens; adopting several in a row, then 采纳所选 for the
 * rest (three characters and relation notes, a publish in between) gives no conflict and every answer is in a 草稿; a full 说话风格
 * card names its refusal; a save against a published version that moved on (the old 「草稿的版本号接不上当前正式版本」) is merged;
 * no id, email or nickname on screen, no raw code, no sideways scroll, no browser error.
 *
 * usage: node scripts/check-web-adopt-55-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
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
const IDS = ['wei-guagua', 'jojo', 'chen-jimi'] as const;

const f = await startConsoleFixture({ provider: { draftMs: 250, reviewMs: 250 } });
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  page.on('console', (m: { type: () => string; text: () => string }) => {
    if (m.type() === 'error' && !/status of 4\d\d/.test(m.text())) errors.push(`console: ${m.text()}`);
  });
  watchRequests(page);
  const sent: string[] = [];
  page.on('request', (request: { url: () => string; postData: () => string | null }) => {
    if (/\/admin\/cocreation\/(adopt-answers|relation\/adopt|cast-story)/.test(request.url()))
      sent.push(request.postData() ?? '');
  });
  const wait = (ms = 600) => quietWait(page, ms);
  const json = async (path: string, body: unknown) => (await f.post(path, body)).json();

  // ---- synthetic notes straight into the tables (what a player's submit writes) ----
  const principal = f.store.get<{ id: string }>('SELECT id FROM web_principals ORDER BY rowid LIMIT 1')!.id;
  const NOW = FIXTURE_NOW;
  let seq = 0;
  const submission = (
    id: string,
    characterId: string,
    answers: { card: string; field: string; kind?: 'text' | 'dialogue'; value: unknown }[],
    over: { kind?: string; partner?: string } = {},
  ) => {
    f.store.run(
      `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,kind,partner_id)
      VALUES (?,?,?,?,?,?,?,?)`,
      id,
      characterId,
      principal,
      `req-${id}`,
      'c'.repeat(64),
      NOW - 600_000 + ++seq * 1000,
      over.kind ?? 'character',
      over.partner ?? null,
    );
    answers.forEach((answer, ordinal) =>
      f.store.run(
        'INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES (?,?,?,?,?,?)',
        id,
        ordinal,
        answer.card,
        answer.field,
        answer.kind ?? 'text',
        JSON.stringify(answer.value),
      ),
    );
  };
  const texts: { id: string; character: string; text: string }[] = [];
  // two relation notes and one memo
  const relation = (id: string, members: string[], text: string) => {
    submission(id, members[0]!, [{ card: 'pair-story', field: 'free', value: text }], {
      kind: 'pair',
      partner: members[1]!,
    });
    f.store.run(
      'INSERT INTO web_cocreation_relations(submission_id,member_count,set_key,reason) VALUES (?,?,?,?)',
      id,
      members.length,
      [...members].sort().join('|'),
      null,
    );
    members.forEach((m, i) => f.store.run('INSERT INTO web_cocreation_members VALUES (?,?,?)', id, i, m));
    texts.push({ id, character: members[0]!, text });
  };
  relation('n-rel-a', ['wei-guagua', 'jojo'], '她们是邻居，住同一栋楼。');
  relation('n-rel-b', ['jojo', 'chen-jimi'], '他们在旧书店认识。');
  submission('n-memo', '_memo', [{ card: 'memo', field: 'free', value: '给制作组的话' }], { kind: 'memo' });
  // the character notes are newer, so they come first in the list
  for (const [index, character] of IDS.entries()) {
    const k = (kind: string) => `${kind}${character}${index}`;
    const make = (
      n: string,
      card: string,
      field: string,
      value: unknown,
      text: string,
      kind: 'text' | 'dialogue' = 'text',
    ) => {
      const id = `n-${character}-${n}`;
      submission(id, character, [{ card, field, kind, value }]);
      texts.push({ id, character, text });
    };
    make('theme', 'theme-catchphrase', 'speechStyle', k('口头禅'), k('口头禅'));
    make('know', 'theme-know', 'persona', k('性格'), k('性格'));
    make('day', 'day-morning', 'free', k('早起'), k('早起'));
    make('habit', 'theme-habit', 'interests', k('习惯'), k('习惯'));
    make('talk', 'dialogue', 'dialogueExamples', { player: k('玩家说'), replies: [k('回答')] }, k('回答'), 'dialogue');
  }
  const characterTexts = texts.filter((entry) => !entry.id.startsWith('n-rel'));
  const total = texts.length;

  const draftOf = async (id: string) => (await json(`characters/${id}/detail`, {})).draft;
  const contains = async (id: string, text: string) => {
    const detail = await json(`characters/${id}/detail`, {});
    return (
      JSON.stringify(detail.draft?.profile ?? {}).includes(text) ||
      JSON.stringify(detail.published?.profile ?? {}).includes(text)
    );
  };

  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    await page.setViewportSize({ width, height });
    const at = `${width}`;
    const shot = async (name: string) => {
      if (shots) {
        await wait(300);
        await page.screenshot({ path: join(shots, `adopt-55-${name}-${at}.png`), fullPage: true });
      }
    };
    await page.goto(`${f.origin}/?mode=provider-admin#/cocreation`);
    await page.reload();
    await page.locator('.cc-row-open').first().waitFor({ timeout: 20_000 });
    await wait(900);

    if (at === '1440') {
      // opens on 新
      const pressed = await page.locator('.cc-chip-row [aria-pressed="true"]').allInnerTexts();
      check(
        pressed.some((text: string) => text.trim() === '新'),
        `${at}: the list opens on 新 (${pressed.join('|')})`,
      );
      const before = await page.locator('.cc-row').count();
      check(before >= total - 0 && before >= 15, `${at}: ${before} cards are listed`);
      await shot('new-list');

      // 1. a single 采纳; no revision is sent; the card leaves; the next one opens
      const firstWho: string = await page.locator('.cc-detail-head h3').innerText();
      check((await page.locator('.cc-adopt-now').count()) >= 1, `${at}: the open card has 采纳`);
      await page.locator('.cc-adopt-now').first().click();
      await page.waitForFunction((n: number) => document.querySelectorAll('.cc-row').length === n, before - 1, {
        timeout: 10_000,
      });
      await wait(600);
      const nextWho: string = await page.locator('.cc-detail-head h3').innerText();
      check(nextWho !== firstWho, `${at}: the next card opened by itself (${firstWho} → ${nextWho})`);
      check(!/expectedRevision/.test(sent.join('\n')), `${at}: no revision is sent with an adoption`);
      await shot('after-one');

      // 2. several in a row, quickly: no conflict, one card leaves each time
      const rowsNow = async () => page.locator('.cc-row').count();
      for (let i = 0; i < 6; i++) {
        const n = await rowsNow();
        const button = page.locator('.cc-adopt-now:not([disabled])').first();
        await button.waitFor({ timeout: 10_000 });
        await button.click();
        await page.waitForFunction((count: number) => document.querySelectorAll('.cc-row').length === count - 1, n, {
          timeout: 10_000,
        });
        await page.waitForTimeout(150);
      }
      check(
        (await page.locator('.cc-adopt-report:not([hidden])').count()) === 0,
        `${at}: seven adoptions in a row: nothing refused`,
      );

      // 3. a publish in between (a colour-only one: a draft that differs from the live version only in its colour)
      const was = await json('characters/wei-guagua/detail', {});
      const profile = structuredClone(was.draft?.profile ?? was.published.profile);
      profile.template.version = was.published.version + 1;
      profile.presentation.color = was.published.profile.presentation.color === '#336699' ? '#339966' : '#336699';
      // only when there is no adopted draft on top of it: this character's drafts are saved after, below
      if (!was.draft) {
        const saved = await json('characters/wei-guagua/save', { expectedRevision: null, profile });
        const published = await f.post(
          'characters/wei-guagua/publish',
          {
            requestId: randomUUID(),
            draftRevision: saved.revision,
            profileHash: saved.contentHash,
            acknowledgeReview: true,
          },
          false,
        );
        check(
          [200, 201].includes(published.status()),
          `${at}: a colour-only publish in between (${published.status()})`,
        );
      }

      // 4. the old error: a page that read the character before the draft moved on saves after it
      const jojo = await json('characters/jojo/detail', {});
      const stale = structuredClone(jojo.draft?.profile ?? jojo.published.profile);
      const staleRevision = jojo.draft?.revision ?? null;
      if (!jojo.draft) stale.template.version = jojo.published.version + 1;
      // ... an adoption writes into the draft after the page was read ...
      const late = await json('cocreation/adopt-answers', { items: [{ id: 'n-jojo-know', ordinal: 0 }] });
      check(
        late.results[0]?.ok === true,
        `${at}: an adoption through the route works (${JSON.stringify(late.results)})`,
      );
      stale.presentation.publicDescription = `${stale.presentation.publicDescription ?? ''}（页面上改的）`;
      const merged = await f.post('characters/jojo/save', { expectedRevision: staleRevision, profile: stale }, false);
      check(
        [200, 201].includes(merged.status()),
        `${at}: a save after the draft moved on is merged, not refused (${merged.status()})`,
      );

      // 5. 采纳所选: everything left, in one action
      await page.reload();
      await page.locator('.cc-row-open').first().waitFor({ timeout: 20_000 });
      await wait(800);
      await page.locator('.cc-select-all').click();
      check((await page.locator('.cc-adopt-selected').count()) === 1, `${at}: 采纳所选 appears with the ticks`);
      await shot('ticked');
      await page.locator('.cc-adopt-selected').click();
      await page.locator('.cc-adopt-report:not([hidden])').waitFor({ timeout: 15_000 });
      await wait(900);
      const report: string = await page.locator('.cc-adopt-report').innerText();
      check(/留言条没有采纳/.test(report), `${at}: the memo is named in the report (${report.slice(0, 80)})`);
      check(!/[A-Z]{3,}_[A-Z_]{3,}/.test(report), `${at}: the report shows no raw code`);
      check(
        (await page.locator('.cc-row').count()) <= 1,
        `${at}: every adopted card left 新 (${await page.locator('.cc-row').count()} left)`,
      );
      await shot('bulk-done');

      // every answer is in a draft (or the published version after the colour-only publish), each once
      for (const entry of characterTexts) {
        const owner = entry.character;
        check(await contains(owner, entry.text), `${at}: "${entry.text}" is in ${owner}'s draft`);
      }
      const castDraft = await json('cast/draft', {});
      const groups = JSON.stringify(castDraft.doc.groups);
      check(
        groups.includes('她们是邻居') && groups.includes('他们在旧书店认识'),
        `${at}: both relation notes are stories of the cast draft`,
      );
      check((await json('cast/versions', {})).versions.length === 0, `${at}: the cast was never published`);
      const adoptedAnswers = f.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_cocreation_answers WHERE adopted_at IS NOT NULL',
      )!.n;
      const paidAnswers = f.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_cocreation_answers WHERE adopt_paid=1',
      )!.n;
      check(adoptedAnswers === total, `${at}: ${adoptedAnswers} of ${total} answers adopted`);
      check(paidAnswers === total, `${at}: each answer's reward is settled once (${paidAnswers})`);
      // doing it all again changes nothing (idempotent per answer)
      const again = await json('cocreation/adopt-answers', {
        items: texts.map((entry) => ({ id: entry.id, ordinal: 0 })),
      });
      check(
        again.results.every((r: { ok: boolean; duplicate?: boolean }) => r.ok && r.duplicate === true),
        `${at}: a second adoption of everything is all duplicates`,
      );
      check(
        f.store.get<{ n: number }>('SELECT count(*) n FROM web_cocreation_answers WHERE adopt_paid=1')!.n ===
          paidAnswers,
        `${at}: and pays nothing again`,
      );

      // 6. they stay findable under their filters
      await page.locator('.cc-filter-chip', { hasText: '已处理' }).click();
      await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
      await wait(700);
      check(
        (await page.locator('.cc-row').count()) >= total - 1,
        `${at}: 已处理 lists them (${await page.locator('.cc-row').count()})`,
      );
      await shot('processed');

      // 7. a full 说话风格 card names its refusal (the second of two long ones)
      const long = '长'.repeat(290);
      submission('n-long-1', 'jojo', [{ card: 'catchphrase', field: 'speechStyle', value: long }]);
      submission('n-long-2', 'jojo', [
        { card: 'catchphrase', field: 'speechStyle', value: '又一句口头禅，加起来超过三百字' },
      ]);
      // the card already holds the earlier catchphrase, so make room: the first long one cannot fit either
      await page.reload();
      await page.locator('.cc-filter-chip', { hasText: '新' }).first().click();
      await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
      await wait(600);
      await page.locator('.cc-select-all').click();
      await page.locator('.cc-adopt-selected').click();
      await page.locator('.cc-adopt-report:not([hidden])').waitFor({ timeout: 15_000 });
      const refusal: string = await page.locator('.cc-adopt-report').innerText();
      check(/这一栏最多 300 字/.test(refusal), `${at}: a full 说话风格 is named (${refusal.slice(0, 120)})`);
      check(!/n-long|@/.test(refusal), `${at}: the refusal shows no id`);
      await shot('refused');
      // leave the list as it was for the second width
      f.store.run("DELETE FROM web_cocreation_answers WHERE submission_id IN ('n-long-1','n-long-2')");
      f.store.run("DELETE FROM web_cocreation_submissions WHERE id IN ('n-long-1','n-long-2')");
    } else {
      // the second width: the same page, no sideways scroll, nothing cut off
      await page.locator('.cc-filter-chip', { hasText: '已处理' }).click();
      await page.locator('.cc-row-open').first().waitFor({ timeout: 15_000 });
      await wait(600);
      await shot('processed');
    }

    // hygiene
    const body: string = await page.locator('body').innerText();
    check(!/n-(rel|memo|long)|n-wei|n-jojo|n-chen|@/.test(body), `${at}: no id, email or nickname on the page`);
    check(!/现行|服务器草稿|修订/.test(body), `${at}: no forbidden wording`);
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      `${at}: no sideways scroll`,
    );
    check(
      await page.evaluate(() =>
        [...document.querySelectorAll('.cc-adopt-now, .cc-adopt-all, .cc-adopt-selected')].every(
          (node) => (node as HTMLElement).offsetHeight >= 28,
        ),
      ),
      `${at}: 采纳 buttons are a normal tap size`,
    );
    void draftOf;
  }
} finally {
  await f.close();
}
check(errors.length === 0, `browser errors: ${errors.slice(0, 3).join(' | ')}`);
if (problems.length) {
  console.error(`check-web-adopt-55-browser: ${problems.length} problem(s)\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('check-web-adopt-55-browser: ok');
