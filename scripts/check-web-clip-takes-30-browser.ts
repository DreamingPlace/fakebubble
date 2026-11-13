import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 30 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts (offline Fish and text-model stand-ins), at
 * 1440x900 and 1280x800. A fresh character the way a profile import leaves it, the free tier OFF (so the footer is a slot):
 *   - no 素材版本 and no 准备新素材版本 on the screen; empty slots with 生成全部 (one paid confirm for all three);
 *   - every take has an inline player that is ready by itself (no 加载 button);
 *   - 重录 adds a take and keeps the others; a take is renamed in place; 选用 moves between takes;
 *   - 按反馈重录: feedback -> the marked-up line (editable) -> 生成 -> a new take;
 *   - approval: per-slot ticks side by side, 全选, one 批准; the 选用 take of an approved slot cannot be deleted;
 *   - 发布: the footer field shows the 选用 take's name (and is absent with the free tier on).
 * usage: node scripts/check-web-clip-takes-30-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
const shots = dir ? resolve(dir) : null;
if (shots) mkdirSync(shots, { recursive: true });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;

async function run(freeTier: boolean) {
  const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true, freeTier });
  try {
    const page = await f.context.newPage();
    page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
    const sent: string[] = [];
    page.on('request', (request: { method: () => string; url: () => string }) => {
      if (request.method() === 'POST') sent.push(request.url());
    });
    const calls = (pattern: RegExp) => sent.filter((url) => pattern.test(url)).length;
    const wait = (ms = 500) => page.waitForTimeout(ms);
    let at = '';
    const shot = async (name: string) => {
      if (!shots) return;
      await wait(400);
      await page.screenshot({ path: join(shots, `${name}-${at}.png`) });
    };
    const open = async (route: string) => {
      await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
      await page.reload();
      await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
      await wait(1200);
    };
    const tab = (label: string) => page.locator(`button.wb-tab:has(span:text-is("${label}"))`).first().click();
    const text = () => page.locator('.admin-content').first().innerText();
    const takes = (slot: string) => page.locator(`section.vc-slot[data-slot="${slot}"] .vc-take`);
    const pay = async (selector: string) => {
      const button = page.locator(selector).first();
      await page.waitForFunction(
        (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? '') && !(el as HTMLButtonElement).disabled,
        await button.elementHandle(),
        { timeout: 15_000 },
      );
      await button.click();
      check(
        (await button.getAttribute('data-state')) === 'confirm',
        `${at}: the first click on ${selector} did not ask`,
      );
      await button.click();
    };
    const line = (id: string, words: string, weight: number) => ({ id, text: words, weight });
    const makeCharacter = async (id: string, fish: string) => {
      const jojo = await (await f.post('characters/jojo/detail', {})).json();
      const profile = structuredClone(jojo.published.profile);
      profile.template.id = id;
      profile.template.version = 1;
      delete profile.template.voice;
      profile.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 60), line('b', '又见面了，我等你很久', 40)];
      await f.post(`characters/${id}/save`, { expectedRevision: null, profile });
      f.store.run(
        'INSERT INTO web_profile_codes(character_id,code,code_key,avatar_file,voice_reference_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        id,
        id.toUpperCase(),
        id,
        null,
        fish,
        1,
        1,
      );
    };
    const sideways = async (where: string) => {
      const gap = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(gap <= 0, `${where}: sideways scroll of ${gap}px`);
    };

    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      at = `${width}${freeTier ? '-free' : ''}`;
      await page.setViewportSize({ width, height });
      const id = `tk-${width}`;
      await makeCharacter(id, `fish-takes-${width}`);
      await open(`characters/${id}`);
      await tab('声音');
      const slots = freeTier ? 2 : 3;
      const body = await text();
      check(!/素材版本|准备新素材版本|加载.*试听/.test(body), `${at}: a 素材版本 / 加载 button is still on the screen`);
      check((await page.locator('section.vc-slot').count()) === slots, `${at}: expected ${slots} slots`);
      check(/将用 .* 朗读/.test(body), `${at}: the model that will speak is not shown`);
      const link = page.locator('a.vc-link').first();
      check(
        (await link.getAttribute('href')) === `https://fish.audio/m/fish-takes-${width}`,
        `${at}: the fish.audio link is wrong`,
      );
      check((await page.locator('[data-pw-send="generate-all"]').count()) === 1, `${at}: 生成全部 is missing`);

      if (freeTier) {
        // The 发布 tab of a character with no footer slot: no footer field at all.
        await tab('发布');
        await wait(800);
        check(
          (await page.locator('[data-used="footer"]').count()) === 0,
          `${at}: a footer field is shown with no footer slot`,
        );
        await shot('publish-no-footer');
        continue;
      }
      await shot('slots-empty');
      // 生成全部: one confirm, one call per slot
      const before = calls(/take-generate-all/);
      await pay('[data-pw-send="generate-all"]');
      await page.waitForFunction(() => document.querySelectorAll('.vc-take').length >= 3, null, { timeout: 30_000 });
      check(calls(/take-generate-all/) === before + 1, `${at}: 生成全部 was not exactly one request`);
      check(
        (await page.locator('[data-pw-send="generate-all"]').count()) === 0,
        `${at}: 生成全部 stays after every slot has a take`,
      );
      await wait(800);
      check(
        (await page.locator('audio.vc-player[src]').count()) === 3,
        `${at}: the players are not ready by themselves`,
      );
      // 重录 twice on slot a: three takes, the others kept; rename the second; 选用 it
      for (let n = 2; n <= 3; n++) {
        await pay('section.vc-slot[data-slot="line:a"] [data-pw-send="generate-line:a"]');
        await page.waitForFunction(
          (k: number) => document.querySelectorAll('section[data-slot="line:a"] .vc-take').length === k,
          n,
          { timeout: 20_000 },
        );
      }
      check(
        (await takes('line:b').count()) === 1 && (await takes('footer').count()) === 1,
        `${at}: another slot lost a take`,
      );
      const names = takes('line:a').locator('.vc-take-name');
      check((await names.nth(0).inputValue()) === '第 1 条', `${at}: the default name is not 第 1 条`);
      await names.nth(1).fill('更懒版');
      await names.nth(1).press('Enter');
      await names.nth(1).blur();
      await page.waitForFunction(
        () => [...document.querySelectorAll('.vc-take-name')].some((i) => (i as HTMLInputElement).value === '更懒版'),
        null,
        { timeout: 10_000 },
      );
      await takes('line:a').nth(1).locator('button:text-is("选用")').click();
      await page.waitForFunction(
        () =>
          document.querySelector('section[data-slot="line:a"] .vc-take[data-selected="true"] .vc-take-name') &&
          (
            document.querySelector(
              'section[data-slot="line:a"] .vc-take[data-selected="true"] .vc-take-name',
            ) as HTMLInputElement
          ).value === '更懒版',
        null,
        { timeout: 10_000 },
      );
      await shot('slot-three-takes');
      // 按反馈重录
      const slotA = page.locator('section.vc-slot[data-slot="line:a"]');
      await slotA.locator('button:text-is("按反馈重录")').click();
      await slotA.locator('textarea.vc-feedback-input').fill('开头更懒一点，最后一句带笑');
      await slotA.locator('button:text-is("改写这句")').click();
      const markup = slotA.locator('textarea.vc-markup-input');
      await markup.waitFor({ timeout: 15_000 });
      check(
        /^\[lazy, drawn out\].*\[small laugh\]/.test(await markup.inputValue()),
        `${at}: the marked-up line is not shown`,
      );
      await wait(800);
      await markup.evaluate((node: HTMLElement) => node.scrollIntoView({ block: 'center' }));
      await shot('feedback-markup');
      await pay('section.vc-slot[data-slot="line:a"] [data-pw-send="feedback-line:a"]');
      await page.waitForFunction(
        () => document.querySelectorAll('section[data-slot="line:a"] .vc-take').length === 4,
        null,
        { timeout: 20_000 },
      );
      check(
        (await takes('line:a').locator('.vc-meta:has-text("按反馈")').count()) === 1,
        `${at}: the feedback take is not marked 按反馈`,
      );
      // Round 2 layout: fixed columns, centred actions, one slot-bar height, 「已选用」 for the state and 「选用」 for the action.
      const geometry = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('section[data-slot="line:a"] .vc-take')];
        const box = (n: Element | null) => (n ? n.getBoundingClientRect() : null);
        return {
          playerX: rows.map((r) => Math.round(box(r.querySelector('.vc-player'))!.x)),
          actionsX: rows.map((r) => Math.round(box(r.querySelector('.vc-take-actions'))!.x)),
          centred: rows.map((r) => {
            // the first grid line (a feedback take has a note line under it)
            const first = box(r.querySelector('.vc-take-name'))!,
              mid = first.y + first.height / 2;
            return [...r.querySelectorAll('.vc-take-actions > *, .vc-take-name, .vc-meta, .vc-player')].map((n) => {
              const b = box(n)!;
              return `${n.className.split(' ')[0]}:${Math.round((b.y + b.height / 2 - mid) * 10) / 10}`;
            });
          }),
          bar: [
            ...document.querySelectorAll(
              'section[data-slot="line:a"] > .vc-actions .vc-gen button.pw-send, section[data-slot="line:a"] > .vc-actions > button, section[data-slot="line:a"] > .vc-actions .vc-pick .ad-file-button',
            ),
          ].map((n) => {
            const b = n.getBoundingClientRect();
            return [Math.round(b.height), getComputedStyle(n).borderRadius];
          }),
          tags: [...document.querySelectorAll('section[data-slot="line:a"] .vc-take-actions .admin-badge')].map(
            (n) => n.textContent,
          ),
        };
      });
      check(new Set(geometry.playerX).size === 1, `${at}: the players do not line up (${geometry.playerX.join(',')})`);
      check(
        new Set(geometry.actionsX).size === 1,
        `${at}: the actions do not line up (${geometry.actionsX.join(',')})`,
      );
      check(
        geometry.centred.every((row: string[]) => row.every((d) => Math.abs(Number(d.split(':')[1])) <= 2)),
        `${at}: something is not vertically centred in its row (${JSON.stringify(geometry.centred)})`,
      );
      check(
        geometry.bar.length === 3 && new Set(geometry.bar.map((b: (string | number)[]) => b.join('/'))).size === 1,
        `${at}: the slot bar buttons differ in height or radius (${JSON.stringify(geometry.bar)})`,
      );
      check(
        geometry.tags.length === 1 && geometry.tags[0] === '已选用',
        `${at}: the state tag is not 「已选用」 (${geometry.tags.join(',')})`,
      );
      // approval: every selected take heard to the end, 全选, one 批准
      check(
        (await page.locator('.vc-tick input:not(:disabled)').count()) === 0,
        `${at}: a slot can be ticked before it was heard`,
      );
      await page.evaluate(() =>
        document.querySelectorAll('audio.vc-player').forEach((a) => a.dispatchEvent(new Event('ended'))),
      );
      await wait(300);
      const order = await page
        .locator('.vc-approval')
        .evaluate((node: HTMLElement) =>
          [...node.querySelectorAll('label.admin-check, button')].map((n) => (n.textContent ?? '').trim()),
        );
      check(
        order[0] === '全选' && order.at(-1) === '批准' && /有权使用/.test(order.at(-2) ?? ''),
        `${at}: the approval row is not 全选, the ticks, the rights tick, 批准 (${order.join(' | ')})`,
      );
      await page.locator('.vc-approval label:has-text("我确认有权使用") input').check();
      await page.locator('.vc-approval label:has-text("全选") input').check();
      check(
        (await page.locator('.vc-tick input:checked').count()) === slots,
        `${at}: 全选 did not tick every heard slot`,
      );
      await page.locator('.vc-approval').evaluate((node: HTMLElement) => node.scrollIntoView({ block: 'center' }));
      await shot('approval-select-all');
      await page.locator('.vc-approval button:text-is("批准")').click();
      await page.waitForFunction(
        (n: number) => document.querySelectorAll('section.vc-slot[data-state="approved"]').length === n,
        slots,
        { timeout: 15_000 },
      );
      // the 选用 take of an approved slot cannot be deleted; another take can
      const approvedSelected = slotA.locator('.vc-take[data-selected="true"] button:text-is("删除")');
      check(await approvedSelected.isDisabled(), `${at}: the 选用 take of an approved slot can be deleted`);
      await slotA.locator('.vc-take[data-selected="false"]').first().locator('button:text-is("删除")').click();
      await page.waitForFunction(
        () => document.querySelectorAll('section[data-slot="line:a"] .vc-take').length === 3,
        null,
        { timeout: 10_000 },
      );
      check(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(await text()), `${at}: a raw id is shown`);
      await sideways(`声音 ${at}`);
      // 发布 tab: the footer field and each line's 选用 take name
      await tab('发布');
      await wait(1200);
      const footer = page.locator('[data-used="footer"]');
      check((await footer.count()) === 1, `${at}: the footer field is missing with a footer slot`);
      check((await footer.textContent()) === '第 1 条', `${at}: the footer field does not show the 选用 take's name`);
      const lineNames = await page
        .locator('[data-used="line"]')
        .evaluateAll((nodes: HTMLElement[]) => nodes.map((n) => n.textContent ?? ''));
      check(
        lineNames.length === 2 && lineNames[0] === '更懒版',
        `${at}: the lines do not show their 选用 take names (${lineNames.join(',')})`,
      );
      await shot('publish-with-footer');
      await sideways(`发布 ${at}`);
      // A changed line: only that slot needs a take (the others keep theirs and their approval); a provider failure keeps its code.
      const now = await (await f.post(`characters/${id}/detail`, {})).json();
      const changed = structuredClone(now.draft.profile);
      changed.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 60), line('b', '这一句会失败', 40)];
      await f.post(`characters/${id}/save`, { expectedRevision: now.draft.revision, profile: changed });
      await open(`characters/${id}`);
      await tab('声音');
      await wait(1500);
      check(
        (await page.locator('section.vc-slot[data-slot="line:a"][data-state="approved"]').count()) === 1,
        `${at}: changing line 2 took the approval of slot 1`,
      );
      check(
        (await page.locator('section.vc-slot[data-slot="footer"][data-state="approved"]').count()) === 1,
        `${at}: changing line 2 took the approval of the footer`,
      );
      check(
        (await page.locator('section.vc-slot[data-slot="line:b"][data-state="approved"]').count()) === 0,
        `${at}: slot 2 stays approved with a changed line`,
      );
      const failedBefore = calls(/take-generate$/);
      await pay('section.vc-slot[data-slot="line:b"] [data-pw-send="generate-line:b"]');
      await wait(2500);
      await open(`characters/${id}`);
      await tab('声音');
      await wait(1500);
      const unknown = page.locator('.vc-issue', { hasText: '未确认 · WEB_PROVIDER_WIRE_MISMATCH' });
      check((await unknown.count()) >= 1, `${at}: the slot does not show 「未确认 · WEB_PROVIDER_WIRE_MISMATCH」`);
      check(calls(/take-generate$/) === failedBefore + 1, `${at}: the failed call was sent more than once`);
      // Part 30b: 发布 with a slot that is not usable. The summary says so, the dropdown shows times (no ids), and 确认发布此版本
      // sends nothing: it names the slot.
      const draftNow = await (await f.post(`characters/${id}/detail`, {})).json();
      // three finished 预演 of this draft, so the dropdown has a list to show
      for (const relationship of ['new', 'friend', 'lover']) {
        await f.post(
          `characters/${id}/review-start`,
          {
            requestId: crypto.randomUUID(),
            draftRevision: draftNow.draft.revision,
            profileHash: draftNow.draft.contentHash,
            relationship,
            message: '你好',
          },
          false,
        );
        await wait(1800);
      }
      await wait(1500);
      await open(`characters/${id}`);
      await tab('发布');
      await wait(1500);
      const options = await page
        .locator('.wb-tab-panel select option, #admin-characters select option')
        .evaluateAll((nodes: HTMLOptionElement[]) => nodes.map((n) => n.textContent ?? ''));
      const previewOptions = options.filter((t: string) => /UTC/.test(t));
      check(previewOptions.length >= 1, `${at}: the 预演 dropdown has no time-labelled option (${options.join('|')})`);
      check(
        previewOptions.every((t: string) => /^\d{4}-\d\d-\d\d \d\d:\d\d UTC · 已通过$/.test(t)),
        `${at}: a 预演 option is not 「时间 · 结果」 (${previewOptions.join('|')})`,
      );
      check(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(options.join(' ')), `${at}: the 预演 dropdown shows an id`);
      const warn = page.locator('.vc-used-row[data-state="stale"], .vc-used-row[data-state="unapproved"]');
      check((await warn.count()) === 1, `${at}: the slot that is not usable is not marked`);
      check(
        /欢迎 2：.*未批准/.test((await warn.first().textContent()) ?? ''),
        `${at}: the mark does not read 「欢迎 2：… · 未批准」`,
      );
      check(
        (await page.locator('.vc-used-row[data-state="approved"]').count()) === 2,
        `${at}: the approved slots are not left unmarked`,
      );
      await shot('publish-unapproved-slot');
      if (shots) {
        await page
          .locator('#admin-characters select')
          .first()
          .evaluate((el: HTMLSelectElement) => {
            el.size = el.options.length;
            el.style.height = 'auto';
            el.style.borderRadius = '12px';
          });
        await shot('publish-preview-dropdown');
        await page
          .locator('#admin-characters select')
          .first()
          .evaluate(
            (el: HTMLSelectElement) => (
              el.removeAttribute('size'), el.style.removeProperty('height'), el.style.removeProperty('border-radius')
            ),
          );
      }
      const writes = calls(/\/publish$|take-bundle/);
      await page
        .locator('.wb-tick:has-text("确认将本版本发布给玩家") input, label:has-text("确认将本版本发布给玩家") input')
        .first()
        .check();
      await wait(300);
      await page.locator('button:text-is("确认发布此版本")').first().click();
      await wait(1200);
      check(calls(/\/publish$|take-bundle/) === writes, `${at}: 发布 sent a request with a slot that is not usable`);
      check(
        /欢迎 2 (还没批准|的选用版本已失效，请重录或另选)/.test(await page.locator('body').innerText()),
        `${at}: the refusal does not name 欢迎 2`,
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    await f.close();
  }
}
try {
  await run(false);
  await run(true);
} finally {
  if (problems.length) console.error(`Part 30 problems (${problems.length}):\n- ${problems.join('\n- ')}`);
  if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
  if (failure) console.error(failure);
  if (problems.length || errors.length || failure) process.exitCode = 1;
  else console.log('clip takes 30 browser check: PASS');
}
