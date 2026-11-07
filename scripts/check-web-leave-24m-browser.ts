import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { templateFile } from '../tests/web/fixtures/profile-template.ts';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 24m addendum: leaving the character workbench with unsaved changes, in a REAL browser at 1440 and 1280. Each way of leaving
 * (the rail, another admin page, Back, the address, a reload) asks 保存 / 不保存 / 取消; 不保存 writes nothing; 保存 makes one
 * revision then leaves; a save that fails (DRAFT_CONFLICT) stays with its message; a clean page asks nothing; a reload with edits
 * shows the browser's own prompt. Synthetic site (console-fixture-24b6.ts).
 *
 * usage: node scripts/check-web-leave-24m-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
const f = await startConsoleFixture();
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  const page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  const wait = (ms = 500) => page.waitForTimeout(ms);
  const A = 'jojo',
    B = 'wei-guagua';
  const revision = async (id: string) =>
    (await (await f.post(`characters/${id}/detail`, {})).json()).draft?.revision ?? null;
  // Both characters start with a saved draft, so a revision count means something.
  for (const id of [A, B]) {
    const d = await (await f.post(`characters/${id}/detail`, {})).json();
    if (!d.draft) {
      const profile = structuredClone(d.published.profile);
      profile.template.version = d.published.version + 1;
      await f.post(`characters/${id}/save`, { expectedRevision: null, profile });
    }
  }
  // The synthetic cast already holds the 15 characters the cast allows; start from an empty cast draft so the import fits.
  const castNow = await (await f.post('cast/draft', {})).json();
  await f.post('cast/save', {
    requestId: crypto.randomUUID(),
    expectedRevision: castNow.revision,
    doc: {
      schema: 2,
      world: { background: '' },
      characters: [],
      people: [],
      ratings: {},
      directions: [],
      groups: [],
      stories: [],
      memes: [],
    },
  });
  const dialog = '.admin-leave-dialog';
  let prompted = '';
  page.on('dialog', async (d: { type: () => string; dismiss: () => Promise<void>; accept: () => Promise<void> }) => {
    prompted = d.type();
    await d.accept().catch(() => {});
  });
  const open = async (id: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/characters/${id}`);
    await page.reload();
    await page.locator('[data-wb-code], .wb-tab').first().waitFor({ timeout: 20_000 });
    await wait(900);
  };
  const persona = () => page.locator('label:has-text("基础人设") textarea').first();
  const edit = async (text: string) => {
    await page.locator('.wb-tab', { hasText: '性格' }).first().click();
    await wait(300);
    await persona().fill(text);
    await wait(300);
  };
  const rail = (id: string) => page.locator(`button.admin-pick[data-character="${id}"]`).first();
  const current = () => page.evaluate(() => location.hash);
  const hasDialog = async () => (await page.locator(dialog).count()) > 0;
  const choose = async (kind: 'save' | 'discard' | 'cancel') => {
    await page.locator(`${dialog} [data-leave="${kind}"]`).click();
    await wait(900);
  };
  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    const w = String(width);
    await page.setViewportSize({ width, height });
    const shot = async (name: string) => {
      if (shots) {
        await wait(300);
        await page.screenshot({ path: join(shots, `${name}-${w}.png`) });
      }
    };
    // ---- an imported character opened without edits is clean (nothing unsaved, nothing asked, a save writes nothing) ----------
    {
      const code = `IMP${w}`;
      const fields: Record<string, string> = {
        角色代码: code,
        人设名称: `导入${w}`,
        '网页展示名／昵称': `导入${w}`,
        欢迎词: '「你好」\n「第二条」',
        陌生时的相处方式: '客气，话少。',
        生日: '2001-03-04',
        是否为成长中角色: '是',
        自称: '「我」「咱」',
        '别名（含英文名）': '「A1」「A2」「A3」「A4」',
        黑称: '「黑1」',
        '音色模型 ID（Fish Audio）': `fish_ref_${w}`,
        角色主色: '「#2F4858 深墨蓝（主）」「#C9A227 旧金」「雾蓝」',
        不可改变的核心设定: '2001-03-04 生。',
        知道但不会说出口的事: '一件事',
      };
      const body = {
        files: [
          {
            name: 'imp.md',
            text: templateFile(fields, [
              {
                code: 'JOJ',
                cp: `搭档${w}`,
                addresses: '「小J」「J老师」「阿J」',
                attitude: '互相照应。',
                shared: '同教室。',
              },
            ]),
          },
        ],
      };
      await f.post('characters/jojo/code-save', { code: 'JOJ' }).catch(() => {});
      const preview = await (await f.post('profile-import/preview', body)).json();
      await f.post('profile-import/apply', { requestId: crypto.randomUUID(), files: body.files, basis: preview.basis });
      const list = await (await f.post('characters/list', {})).json();
      const made = list.characters.find((c: { displayName: string }) => c.displayName === `导入${w}`);
      check(!!made, `${w}: the import made its character`);
      if (made) {
        await open(made.characterId);
        check(
          (await page.locator('.wb-tab .wb-dot:visible').count()) === 0,
          `${w}: an imported draft opens with no unsaved dot`,
        );
        check(!(await page.locator('.wb-state[data-state="dirty"]').count()), `${w}: and no 未保存 mark`);
        const first = (await (await f.post(`characters/${made.characterId}/detail`, {})).json()).draft;
        await page
          .getByRole('button', { name: '保存草稿' })
          .first()
          .click({ force: true })
          .catch(() => {});
        await wait(800);
        const second = (await (await f.post(`characters/${made.characterId}/detail`, {})).json()).draft;
        check(
          second.revision === first.revision,
          `${w}: open -> save is no new revision (${first.revision} -> ${second.revision})`,
        );
        check(JSON.stringify(second.profile) === JSON.stringify(first.profile), `${w}: open -> save is deep-equal`);
        await rail(A).click({ force: true });
        await wait(900);
        check(!(await hasDialog()), `${w}: leaving an opened imported draft asks nothing`);
      }
    }
    // ---- a clean page asks nothing -------------------------------------------------------------------------------
    await open(A);
    await rail(B).click({ force: true });
    await wait(900);
    check(!(await hasDialog()), `${w}: a clean page asks nothing`);
    check((await current()).endsWith(B), `${w}: a clean page switches at once (${await current()})`);

    // ---- edit -> switch -> 不保存: nothing is written ---------------------------------------------------------------
    await open(A);
    const before = await revision(A);
    await edit(`改动不保存 ${w}`);
    await rail(B).click({ force: true });
    await page.locator(dialog).waitFor({ timeout: 5000 });
    await shot('leave-dialog');
    await choose('discard');
    check(!(await hasDialog()), `${w}: the dialog closes`);
    check((await current()).endsWith(B), `${w}: 不保存 leaves (${await current()})`);
    check((await revision(A)) === before, `${w}: 不保存 wrote no revision`);
    // Back at A: the old text, not the edit.
    await rail(A).click({ force: true });
    await wait(900);
    await page.locator('.wb-tab', { hasText: '性格' }).first().click();
    check(!(await persona().inputValue()).includes('改动不保存'), `${w}: the dropped edit is gone`);

    // ---- edit -> 取消: stay, edits kept ----------------------------------------------------------------------------
    await edit(`改动取消 ${w}`);
    await rail(B).click({ force: true });
    await page.locator(dialog).waitFor({ timeout: 5000 });
    await choose('cancel');
    check((await current()).endsWith(A), `${w}: 取消 stays on the page`);
    check((await persona().inputValue()).includes('改动取消'), `${w}: 取消 keeps the edits`);
    check((await revision(A)) === before, `${w}: 取消 wrote nothing`);

    // ---- another admin page, Back and the address ask too -------------------------------------------------------------
    await page.locator('.admin-nav [data-page="overview"]').first().click();
    await page.locator(dialog).waitFor({ timeout: 5000 });
    await choose('cancel');
    check((await current()).endsWith(A), `${w}: the sidebar asks, 取消 stays`);
    await page.evaluate((id: string) => {
      location.hash = `#/characters/${id}`;
    }, B);
    await page.locator(dialog).waitFor({ timeout: 5000 });
    check((await current()).endsWith(A), `${w}: the address is put back while the question shows`);
    await choose('cancel');
    await page.evaluate(() => history.back());
    await wait(600);
    if (await hasDialog()) await choose('cancel');
    check((await persona().inputValue()).includes('改动取消'), `${w}: Back with edits asks, 取消 keeps them`);

    // ---- edit -> 保存: one new revision, then the switch ----------------------------------------------------------------
    await rail(B).click({ force: true });
    await page.locator(dialog).waitFor({ timeout: 5000 });
    await choose('save');
    await wait(900);
    check(
      (await revision(A)) === before + 1,
      `${w}: 保存 made exactly one revision (${before} -> ${await revision(A)})`,
    );
    check((await current()).endsWith(B), `${w}: 保存 then leaves (${await current()})`);

    // ---- a save that fails (DRAFT_CONFLICT): stay, with the message --------------------------------------------------------
    await rail(A).click({ force: true });
    await wait(900);
    await edit(`改动冲突 ${w}`);
    const detail = await (await f.post(`characters/${A}/detail`, {})).json();
    const moved = structuredClone(detail.draft.profile);
    moved.template.persona = `别处改过 ${w} ${Date.now()}`;
    await f.post(`characters/${A}/save`, { expectedRevision: detail.draft.revision, profile: moved });
    const moved_ = await revision(A);
    await rail(B).click({ force: true });
    await page.locator(dialog).waitFor({ timeout: 5000 });
    await choose('save');
    await wait(900);
    check((await current()).endsWith(A), `${w}: a failed save stays (${await current()})`);
    check((await revision(A)) === moved_, `${w}: a failed save wrote nothing`);
    check((await persona().inputValue()).includes('改动冲突'), `${w}: a failed save keeps the edits`);
    const bar = await page.locator('.wb-conflict').innerText();
    check(
      bar.includes('草稿已在别处更新') && bar.includes('重新载入'),
      `${w}: DRAFT_CONFLICT says so with 重新载入 (${bar})`,
    );
    await shot('draft-conflict');
    await page.locator('.wb-conflict button').click();
    await wait(900);
    check((await persona().inputValue()).includes('别处改过'), `${w}: 重新载入 reads the newer draft`);

    // ---- reload with edits: the browser's own prompt --------------------------------------------------------------------
    await edit(`改动刷新 ${w}`);
    prompted = '';
    await page.reload({ timeout: 4000 }).catch(() => {});
    await wait(500);
    check(prompted === 'beforeunload', `${w}: a reload with edits shows the browser prompt (${prompted})`);
    // ...and a clean page reloads without one.
    await open(B);
    prompted = '';
    await page.reload();
    await wait(500);
    check(prompted === '', `${w}: a clean reload shows no prompt`);
  }
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) throw failure;
assert.deepEqual(
  errors.filter((e) => !/status of 409/.test(e)),
  [],
  `browser errors:\n${errors.join('\n')}`,
);
assert.deepEqual(problems, [], `problems:\n${problems.join('\n')}`);
console.log('check-web-leave-24m-browser: ok');
