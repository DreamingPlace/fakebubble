import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 29 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts with its offline Fish stand-in, at 1440x900
 * and 1280x800. A fresh character the way a profile import leaves it: a recorded Fish id, NO voice binding in the draft.
 *   B  声音 shows ONE field (Fish 音色 ID) and 语速; no 绑定已有音色 / 音色档案 ID / 音色档案版本; nothing is 未保存;
 *   E  准备新素材版本 (saves nothing) → per slot one 生成 (paid, two clicks) with 或上传自己的 WAV folded under it → 试听 → 批准;
 *      the material is 「素材版本 N」, never an id;
 *   C  a weight change keeps the approved version valid; a changed line makes it 需重新准备 with the button, and the new version
 *      carries the unchanged clip, so only the changed slot is empty;
 *   A  a provider failure leaves the slot 「未确认 · CODE」 (the code kept on the row), never resent;
 *   F  系统状态 → 安全 shows the rate-limiter overflow count.
 * usage: node scripts/check-web-voice-29-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
const shots = dir ? resolve(dir) : null;
if (shots) mkdirSync(shots, { recursive: true });

// The free tier is ON, as in production: no 结束成品 exists or is required.
const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
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
  const sideways = async (where: string) => {
    const gap = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(gap <= 0, `${where}: sideways scroll of ${gap}px`);
  };
  const text = () => page.locator('.admin-content').first().innerText();

  const line = (id: string, words: string, weight: number) => ({ id, text: words, weight });
  /** A new character as an import leaves it: a recorded Fish id, no binding. */
  const makeCharacter = async (id: string, fish: string) => {
    const jojo = await (await f.post('characters/jojo/detail', {})).json();
    const profile = structuredClone(jojo.published.profile);
    profile.template.id = id;
    profile.template.version = 1;
    delete profile.template.voice;
    profile.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 60), line('b', '又见面了，我等你很久', 40)];
    const draft = await (await f.post(`characters/${id}/save`, { expectedRevision: null, profile })).json();
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
    return { profile, draft };
  };
  /** Saves the draft again with a change (the way the page's 保存草稿 would). */
  const edit = async (id: string, change: (profile: any) => void) => {
    const now = await (await f.post(`characters/${id}/detail`, {})).json();
    const profile = structuredClone(now.draft.profile);
    change(profile);
    await f.post(`characters/${id}/save`, { expectedRevision: now.draft.revision, profile });
  };
  const generate = async (slotName: string) => {
    const slot = page
      .locator(`section.vc-slot:has(> h4:text-is("${slotName}")):has([data-pw-send^="generate-"])`)
      .first();
    const gen = slot.locator('[data-pw-send^="generate-"]');
    await page.waitForFunction(
      (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? ''),
      await gen.elementHandle(),
      { timeout: 15_000 },
    );
    await gen.click();
    check((await gen.getAttribute('data-state')) === 'confirm', `${at} ${slotName}: the first click did not ask`);
    await gen.click();
  };

  for (const [width, height] of [
    [1440, 900],
    [1280, 800],
  ] as const) {
    at = `${width}`;
    await page.setViewportSize({ width, height });
    const id = `imp-${width}`;
    await makeCharacter(id, `fish-imported-${width}`);

    // ============== B: one voice field, nothing to save ==============
    await open(`characters/${id}`);
    await tab('声音');
    const body = await text();
    check(!/绑定已有音色|音色档案 ID|音色档案版本/.test(body), `${at}: a manual binding field is still shown`);
    const fish = page.locator('label:has-text("Fish 音色 ID") input').first();
    check((await fish.inputValue()) === `fish-imported-${width}`, `${at}: the imported Fish id is not in the field`);
    check((await page.locator('label:has-text("语速") input').count()) === 1, `${at}: 语速 is missing`);
    check(
      (await page.locator('text=有未保存修改').count()) === 0,
      `${at}: the page says 未保存 for an untouched import`,
    );
    check(/将用 .* 朗读/.test(body), `${at}: the model that will speak is not shown`);
    await shot('voice-fresh');

    // ============== E: 准备 → 生成 → 试听 → 批准 ==============
    const prepares = calls(/material-prepare/);
    await page.locator('button:has-text("准备新素材版本")').first().click();
    await page.locator('summary:has-text("素材版本 1")').waitFor({ timeout: 15_000 });
    check(calls(/material-prepare/) === prepares + 1, `${at}: 准备 was not exactly one call`);
    check(
      calls(/\/save$/) >= 0 && (await page.locator('text=有未保存修改').count()) === 0,
      `${at}: preparing wrote a draft change`,
    );
    check(!/[0-9a-f]{8}-[0-9a-f]{4}-/.test(await text()), `${at}: a raw id is shown`);
    check(
      (await page.locator('details.vc-upload:not([open])').count()) === 2,
      `${at}: the upload is not folded under each 生成`,
    );
    check(
      (await page.locator('summary:has-text("或上传自己的 WAV")').count()) === 2,
      `${at}: 或上传自己的 WAV is missing`,
    );
    check(!/结束成品/.test(await text()), `${at}: a 结束成品 is shown with the free tier on`);
    await shot('voice-prepared');
    for (const name of ['欢迎成品 1', '欢迎成品 2']) {
      const before = calls(/material-generate/);
      await generate(name);
      await page
        .waitForFunction(
          (n: string) => [...document.querySelectorAll('button')].some((b) => b.textContent === `加载${n}试听`),
          name,
          {
            timeout: 20_000,
          },
        )
        .catch(() => check(false, `${at} ${name}: no clip appeared`));
      check(calls(/material-generate/) === before + 1, `${at} ${name}: not exactly one generate call`);
    }
    await shot('voice-generated');
    for (const name of ['欢迎成品 1', '欢迎成品 2'])
      await page.locator(`button:has-text("加载${name}试听")`).first().click();
    await page.locator('label:has-text("我确认有权使用这个音色和成品") input').first().check();
    await page.locator('label:has-text("第 1 条欢迎成品与欢迎词一致") input').first().check();
    await page.locator('label:has-text("第 2 条欢迎成品与欢迎词一致") input').first().check();
    await page
      .locator('label:has-text("批准说明") input, label:has-text("批准说明") textarea')
      .first()
      .fill('离线检查');
    await page.locator('button:has-text("批准此素材版本")').first().click();
    await page.locator('summary:has-text("素材版本 1 · 已批准")').waitFor({ timeout: 15_000 });
    await shot('voice-approved');

    // ============== C: a weight keeps it valid; a changed line makes it 需重新准备 ==============
    await edit(id, (p) => {
      p.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 70), line('b', '又见面了，我等你很久', 30)];
    });
    await open(`characters/${id}`);
    await tab('声音');
    check(/素材版本 1 · 已批准/.test(await text()), `${at}: a weight change made the version stale`);
    await edit(id, (p) => {
      p.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 70), line('b', '换成新的一句话', 30)];
    });
    await open(`characters/${id}`);
    await tab('声音');
    check(/素材版本 1 · 需重新准备/.test(await text()), `${at}: a changed line did not say 需重新准备`);
    check(
      (await page.locator('summary:has-text("需重新准备") ~ button:has-text("准备新素材版本")').count()) >= 1,
      `${at}: 需重新准备 has no button`,
    );
    await shot('voice-stale');
    await page.locator('details[data-state="stale"] button:has-text("准备新素材版本")').first().click();
    await page.locator('summary:has-text("素材版本 2")').waitFor({ timeout: 15_000 });
    await wait(800);
    const second = page.locator('details[data-vc="material"]:has(> summary:has-text("素材版本 2"))');
    check(
      (await second.locator('button:has-text("加载欢迎成品 1试听")').count()) === 1,
      `${at}: the unchanged clip was not carried over`,
    );
    check(
      (await second.locator('[data-pw-send^="generate-"]').count()) === 1,
      `${at}: only the changed slot should need a clip`,
    );

    // ============== A: a provider failure keeps its code on the slot ==============
    await edit(id, (p) => {
      p.presentation.welcomes = [line('a', '你好呀，今天过得怎么样', 70), line('b', '这一句会失败', 30)];
    });
    await open(`characters/${id}`);
    await tab('声音');
    await page.locator('details[data-state="stale"] button:has-text("准备新素材版本")').first().click();
    await page.locator('summary:has-text("素材版本 3")').waitFor({ timeout: 15_000 });
    await wait(800);
    const before = calls(/material-generate/);
    await generate('欢迎成品 2');
    await wait(2500);
    await open(`characters/${id}`);
    await tab('声音');
    const unknown = page.locator('.vc-issue', { hasText: '未确认 · WEB_PROVIDER_WIRE_MISMATCH' });
    check((await unknown.count()) >= 1, `${at}: the slot does not show 「未确认 · WEB_PROVIDER_WIRE_MISMATCH」`);
    check(calls(/material-generate/) === before + 1, `${at}: the failed call was sent more than once`);
    await unknown.first().evaluate((node: HTMLElement) => node.scrollIntoView({ block: 'center' }));
    await shot('voice-unknown');
    await sideways(`声音 ${at}`);
  }

  // ============== F: 系统状态 → 安全 ==============
  await page.setViewportSize({ width: 1440, height: 900 });
  at = '1440';
  await open('system');
  const system = await text();
  check(/今天限流表已满、逐 IP 检查被放行/.test(system), '系统状态 → 安全 does not show the overflow count');
  await page
    .locator('text=安全')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await shot('system-security');
  await page.setViewportSize({ width: 1280, height: 800 });
  at = '1280';
  await page
    .locator('text=安全')
    .first()
    .scrollIntoViewIfNeeded()
    .catch(() => {});
  await shot('system-security');
} catch (error) {
  failure = error;
  if (shots)
    for (const page of f.context.pages()) await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {});
} finally {
  await f.close();
}
if (problems.length) console.error(`Part 29 problems (${problems.length}):\n- ${problems.join('\n- ')}`);
if (errors.length) console.error(`page errors:\n${errors.join('\n')}`);
if (failure) console.error(failure);
if (problems.length || errors.length || failure) process.exitCode = 1;
else console.log('voice 29 browser check: PASS');
