import './player-build-guard.ts';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';

/**
 * Part 29 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts with its offline Fish stand-in, at 1440x900
 * and 1280x800. A fresh character the way a profile import leaves it: a recorded Fish id, NO voice binding in the draft.
 *   B  声音 shows ONE field (Fish 音色 ID) and 语速; no 绑定已有音色 / 音色档案 ID / 音色档案版本; nothing is 未保存;
 *   E, C, A  (the 素材版本 workflow) are superseded by Part 30: see check-web-clip-takes-30-browser.ts;
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

    // ============== E, C, A: moved to Part 30 (named exception) ==============
    // Part 30 removed 素材版本 / 准备新素材版本 from the screen (one slot per clip, several takes per slot), so the Part 29 steps that
    // drove them (准备 → 生成 → 试听 → 批准, 需重新准备, the carried clip) no longer exist. Their intent lives on in
    // scripts/check-web-clip-takes-30-browser.ts: generation per slot, approval per slot, a changed line affecting only its slot,
    // and 「未确认 · CODE」 for a provider failure that is never resent. B (one voice field) and F (安全) stay below.
    check(!/素材版本|准备新素材版本/.test(await text()), `${at}: a 素材版本 is still on the screen`);
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
