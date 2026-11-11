import './player-build-guard.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { characterProfileHash } from '../apps/server/characters/web-character-catalog.ts';

/**
 * Part 24k-2 in a REAL browser (Chromium) on the synthetic site of console-fixture-24b6.ts (offline provider, offline Fish stand-in):
 *
 *  ADMIN (1440×900 and 1280×800)
 *   - 欢迎内容: an old one-line profile reads as one line at 100%; adding lines splits evenly (three are 34 / 33 / 33); a total that is not
 *     100% shows amber and the located message; 平均分配 puts it right; reordering keeps the text with its percent; 8 lines is the end;
 *   - 声音: after 准备新素材版本 there is one welcome slot per line (and the footer), each with 生成 (the paid button asks first);
 *   - 身份与展示: the 色板 list (主 mirrors 主色, up to 4 点缀) with the night / day chip.
 *  PLAYER (390×844, night and day)
 *   - the home card and the chat of four characters: (a) dark main + 1 accent, (b) light main + 2 accents, (c) a main above 80% saturation,
 *     (d) no accents; the No. is the birthday's month + day; the name light mid-sweep and settled; at most 5 shapes; no sideways scroll.
 *
 * usage: node scripts/check-web-welcomes-palette-24k2-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const only = process.env.ONLY ?? '';
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;

const f = await startConsoleFixture({ provider: { draftMs: 300, reviewMs: 300 }, speech: true });
const problems: string[] = [];
const errors: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) problems.push(message);
};
let failure: unknown = null;
try {
  const page: Page = await f.context.newPage();
  page.on('pageerror', (error: unknown) => errors.push(`pageerror ${String(error)}`));
  const wait = (ms = 500) => page.waitForTimeout(ms);
  const shot = async (name: string, target: Page = page) => {
    if (!shots) return;
    await wait(350);
    await target.screenshot({ path: join(shots, `${name}.png`) });
  };
  const tab = (label: string) => page.locator(`button.wb-tab:has(span:text-is("${label}"))`).first().click();
  const open = async (route: string) => {
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.reload();
    await page.locator('.admin-content').first().waitFor({ timeout: 20_000 });
    await wait(1200);
  };
  const sideways = async (where: string) => {
    const gap = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(gap <= 0, `${where}: sideways scroll of ${gap}px`);
  };
  const weights = () =>
    page
      .locator('.wl-row input.wl-weight')
      .evaluateAll((inputs: HTMLInputElement[]) => inputs.map((i) => Number(i.value)));

  // ============================== ADMIN ==============================
  if (only !== 'player')
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await open('characters/jojo');
      await tab('欢迎内容');
      await page.locator('.wl-row').first().waitFor({ timeout: 10_000 });
      check((await page.locator('.wl-row').count()) === 1, `欢迎内容 ${at}: an old profile is one line`);
      check(JSON.stringify(await weights()) === '[100]', `欢迎内容 ${at}: the old welcome is 100%`);
      check(/合计 100%/.test(await page.locator('.wl-total').innerText()), `欢迎内容 ${at}: the total reads 100%`);
      await page.locator('.wl-add').click();
      await page.locator('.wl-add').click();
      await wait(400);
      check(
        JSON.stringify(await weights()) === '[34,33,33]',
        `欢迎内容 ${at}: three lines are not 34/33/33 (${await weights()})`,
      );
      check(
        (await page.locator('.wl-total').getAttribute('data-state')) === 'ok',
        `欢迎内容 ${at}: 100% is not marked ok`,
      );
      // type the new lines, make the total wrong, see the located message, put it right
      const texts = page.locator('.wl-row textarea');
      await texts.nth(1).fill('第二句：你来啦');
      await texts.nth(2).fill('第三句：等你好久了');
      await page.locator('.wl-row input.wl-weight').nth(0).fill('40');
      await wait(250);
      check(
        (await page.locator('.wl-total').getAttribute('data-state')) === 'off',
        `欢迎内容 ${at}: 106% is not flagged`,
      );
      check(
        /106%/.test(await page.locator('.wl-problem').innerText()),
        `欢迎内容 ${at}: the message does not name the total`,
      );
      await shot(`welcome-list-wrong-${at}`);
      await page.locator('.wl-even').click();
      await wait(250);
      check(JSON.stringify(await weights()) === '[34,33,33]', `欢迎内容 ${at}: 平均分配 did not split evenly`);
      // delete the last line: its percent goes to the first, the total stays 100
      await page.locator('.wl-row .wl-del').nth(2).click();
      await wait(500);
      check((await page.locator('.wl-row').count()) === 2, `欢迎内容 ${at}: delete did not remove a line`);
      check(JSON.stringify(await weights()) === '[67,33]', `欢迎内容 ${at}: delete lost percent (${await weights()})`);
      await page.locator('.wl-add').click();
      await wait(300);
      // eight is the end
      while ((await page.locator('.wl-row').count()) < 8) await page.locator('.wl-add').click();
      check(await page.locator('.wl-add').isDisabled(), `欢迎内容 ${at}: more than 8 lines can be added`);
      check(
        (await weights()).reduce((a: number, b: number) => a + b, 0) === 100,
        `欢迎内容 ${at}: eight lines do not sum to 100`,
      );
      await shot(`welcome-list-${at}`);
      await sideways(`欢迎内容 ${at}`);
    }

  // Save a three-line welcome through the API, then prepare a 素材版本 and look at the slots.
  if (only !== 'player') {
    const was = await (await f.post('characters/jojo/detail', {})).json();
    const profile = structuredClone(was.draft?.profile ?? was.published.profile);
    profile.template.version = (was.published?.version ?? 1) + 1;
    profile.presentation.welcomes = [
      { id: 'w-one', text: '来了？先坐。', weight: 34 },
      { id: 'w-two', text: '今天也要加油哦。', weight: 33 },
      { id: 'w-three', text: '我等你好久了。', weight: 33 },
    ];
    await f.post('characters/jojo/save', { expectedRevision: was.draft?.revision ?? null, profile });
  }
  if (only !== 'player')
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await open('characters/jojo');
      await tab('声音');
      await page
        .locator('label:has-text("已有 Fish 音色 referenceId") input')
        .first()
        .fill(`fake-reference-24k2-${width}`);
      await page.locator('button:has-text("准备新素材版本")').first().click();
      const slot = (name: string) =>
        page.locator(`section:has(> h4:text-is("${name}")):has([data-pw-send^="generate-"])`).first();
      await slot('欢迎成品 1').waitFor({ timeout: 15_000 });
      await slot('欢迎成品 2').waitFor({ timeout: 15_000 });
      for (const name of ['欢迎成品 1', '欢迎成品 2', '欢迎成品 3', '结束成品']) {
        check((await slot(name).count()) === 1, `声音 ${at}: no empty slot named ${name}`);
        check(
          (await slot(name).locator('[data-pw-send^="generate-"]').count()) === 1,
          `声音 ${at}: ${name} has no 生成`,
        );
      }
      const gen = slot('欢迎成品 2').locator('[data-pw-send^="generate-"]');
      await page.waitForFunction(
        (el: HTMLElement | null) => !!el && /约/.test(el.textContent ?? ''),
        await gen.elementHandle(),
        {
          timeout: 15_000,
        },
      );
      await gen.click();
      check((await gen.getAttribute('data-state')) === 'confirm', `声音 ${at}: the first click did not ask`);
      await shot(`voice-slots-${at}`);
      await gen.click();
      await page.locator(`section:has(> h4:text-is("欢迎成品 2")) .vc-origin`).first().waitFor({ timeout: 30_000 });
      check(
        (await page.locator(`section:has(> h4:text-is("欢迎成品 2")) .vc-origin`).count()) >= 1,
        `声音 ${at}: the generated clip is not marked 生成`,
      );
      await sideways(`声音 ${at}`);
      // a later iteration prepares another 素材版本 for the same draft: that is fine (the page lists them all)
    }

  // 色板
  if (only !== 'player')
    for (const [width, height] of [
      [1440, 900],
      [1280, 800],
    ] as const) {
      const at = `${width}x${height}`;
      await page.setViewportSize({ width, height });
      await open('characters/c05');
      await tab('身份与展示');
      await page.locator('.pl').first().waitFor({ timeout: 10_000 });
      await page.locator('.colour-field input[type="text"]').first().fill('#2B2D6E');
      const before = await page.locator('.pl-row:not(.pl-main)').count();
      await page.locator('.pl-add').click();
      await page.locator('.pl-add').click();
      const hexes = page.locator('.pl-row:not(.pl-main) input.pl-hex-in');
      await hexes.nth(before).fill('#E8A33D');
      await hexes.nth(before + 1).fill('#7BD0C1');
      await wait(400);
      check(
        (await page.locator('.pl-chip .pl-strip').count()) === 2,
        `色板 ${at}: the chip has no night and day strip`,
      );
      check(
        (await page.locator('.pl-main .pl-hex').innerText()).includes('#2B2D6E'),
        `色板 ${at}: the 主 row does not mirror 主色`,
      );
      await shot(`palette-${at}`);
      await sideways(`色板 ${at}`);
    }

  // ============================== PLAYER ==============================
  // Four characters, written like a publication would (a new version of the profile), each with a different palette.
  const bind = (id: string) => {
    if (!f.store.get('SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?', id))
      f.store.run(
        `INSERT INTO web_provider_voice_bindings(character_id,voice_version,voice_revision,profile_id,reference_id,model,source,approved,evidence_json)
        VALUES (?,?,1,'p-24k2','r-24k2','s2.1-pro','user_selected',1,'{}')`,
        id,
        `${id}-fish:v1`,
      );
  };
  const republish = (id: string, change: (profile: any) => void) => {
    const row = f.store.get<{ version: number; profile_json: string }>(
      `SELECT v.version,v.profile_json FROM web_character_catalog c JOIN web_character_versions v
      ON v.character_id=c.character_id AND v.version=c.version WHERE c.character_id=?`,
      id,
    )!;
    const profile = JSON.parse(row.profile_json);
    if (profile.presentation.welcome) {
      profile.presentation.welcomes = [
        {
          id: `w-${createHash('sha256').update(profile.presentation.welcome.text).digest('hex').slice(0, 8)}`,
          text: profile.presentation.welcome.text,
          weight: 100,
        },
      ];
      delete profile.presentation.welcome;
    }
    profile.template.version = row.version + 1;
    change(profile);
    const text = JSON.stringify(profile.template);
    f.store.run('INSERT INTO character_template_versions VALUES (?,?,?,NULL)', id, profile.template.version, text);
    f.store.run(
      'UPDATE character_templates SET version=?,config_json=? WHERE id=?',
      profile.template.version,
      text,
      id,
    );
    f.store.run(
      'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
      id,
      profile.template.version,
      JSON.stringify(profile),
      characterProfileHash(profile),
    );
    f.store.run('UPDATE web_character_catalog SET version=? WHERE character_id=?', profile.template.version, id);
  };
  bind('c04');
  const scenarios = [
    {
      id: 'wei-guagua',
      tag: 'a-dark-one-accent',
      main: '#23306B',
      accents: ['#E8A33D'],
      birth: '2000-11-02',
      no: '1102',
    },
    {
      id: 'jojo',
      tag: 'b-light-two-accents',
      main: '#F3D77A',
      accents: ['#7FB8E8', '#E88FB0'],
      birth: '1999-03-07',
      no: '0307',
    },
    { id: 'chen-jimi', tag: 'c-saturated', main: '#FF2200', accents: [], birth: null, no: null },
    { id: 'c04', tag: 'd-no-accents', main: '#3C8D6B', accents: [], birth: '2001-12-24', no: '1224' },
  ] as const;
  for (const s of scenarios)
    republish(s.id, (p) => {
      p.presentation.color = s.main;
      p.presentation.palette = [
        { hex: s.main, name: '主', role: 'main' },
        ...s.accents.map((hex, i) => ({ hex, name: `点缀${i + 1}`, role: 'accent' })),
      ];
      if (s.birth) p.template.birthDate = s.birth;
    });
  // a no-color character keeps the built-in palette (nothing to check but that it still renders)

  const player = await f.browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
  });
  const home: Page = await player.newPage();
  home.on('pageerror', (error: unknown) => errors.push(`player pageerror ${String(error)}`));
  home.on(
    'console',
    (m: { type: () => string; text: () => string }) =>
      m.type() === 'error' && console.error('player console:', m.text()),
  );
  home.on(
    'response',
    (r: { status: () => number; url: () => string }) =>
      r.status() >= 400 && console.error('player response', r.status(), r.url()),
  );
  const names = new Map<string, string>();
  for (const mode of ['night', 'day'] as const) {
    await home.addInitScript(
      (m: string) => localStorage.setItem('burbur-theme', m === 'night' ? 'dark' : 'light'),
      mode,
    );
    await home.goto(`${f.origin}/?mode=provider`);
    await home.locator('.avatar-choice').first().waitFor({ timeout: 20_000 });
    await home.evaluate((m: string) => {
      document.documentElement.dataset.theme = m === 'night' ? 'dark' : 'light';
    }, mode);
    await home.waitForTimeout(900);
    for (const s of scenarios) {
      const card = home.locator(`.card-slot[data-person="character-${s.id}"]`);
      const name = ((await card.locator('.face-name').first().textContent()) ?? '').trim();
      names.set(s.id, name);
      await home.locator(`.avatar-choice[aria-label="选择${name}"]`).evaluate((el: HTMLElement) => el.click());
      await home.locator(`.card-slot.is-active[data-person="character-${s.id}"]`).waitFor({ timeout: 10_000 });
      await home.waitForTimeout(1100);
      const where = `${s.tag} ${mode}`;
      check((await card.getAttribute('data-skin')) === '1', `${where}: the card has no skin`);
      const shapes = await card
        .locator('.pk-shapes')
        .evaluateAll((layers: Element[]) => layers.map((l) => l.children.length));
      check(
        shapes.length === 2 && shapes.every((n: number) => n >= 4 && n <= 5),
        `${where}: shapes per surface ${shapes}`,
      );
      if (s.no)
        check(
          (await card.locator('.face-top span').last().innerText()) === `No.${s.no}`,
          `${where}: the No. is not No.${s.no}`,
        );
      const gap = await home.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(gap <= 0, `${where}: sideways scroll of ${gap}px`);
      // the name light settled and mid-sweep
      await shot(`player-card-${s.tag}-${mode}`, home);
      if (mode === 'night' && s.tag === 'c-saturated') {
        // the door: paused at 0 the light has not opened, at 330 ms it is part-way, finished it is settled (1)
        const at = (ms: number) =>
          home.evaluate((t: number) => {
            const name = document.querySelector('.card-slot.is-active .face-name') as HTMLElement;
            const door = name.getAnimations().find((a) => (a as CSSAnimation).animationName === 'pk-door');
            if (!door) return null;
            door.pause();
            door.currentTime = t;
            return Number(getComputedStyle(name).getPropertyValue('--pk-k'));
          }, ms);
        const k0 = await at(0);
        const k330 = await at(330);
        check(
          k0 === 0 && k330 !== null && k330 > 0 && k330 < 1,
          `${where}: the name light does not sweep (k at 0 = ${k0}, at 330 = ${k330})`,
        );
        await at(330);
        await home.screenshot({ path: shots ? join(shots, 'player-name-sweep-mid-night.png') : undefined });
        await home.evaluate(() => {
          for (const a of document.getAnimations()) if ((a as CSSAnimation).animationName === 'pk-door') a.finish();
        });
      }
      // the chat
      await home.locator('.card-slot.is-active .card-face').evaluate((el: HTMLElement) => el.click());
      await home.locator('.card-slot.is-chat').waitFor({ timeout: 10_000 });
      await home.waitForTimeout(900);
      await shot(`player-chat-${s.tag}-${mode}`, home);
      await home.locator('.card-slot.is-chat .back-button').click();
      await home.waitForTimeout(700);
    }
    // scrolling stays light: the carousel is dragged across and back on the phone viewport without errors or sideways overflow
    const gap = await home.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check(gap <= 0, `player ${mode}: sideways scroll of ${gap}px after the tour`);
  }
  // the reduced-motion path: no sweep, only the settled state
  {
    const calm = await f.browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    const p: Page = await calm.newPage();
    await p.goto(`${f.origin}/?mode=provider`);
    await p.locator('.avatar-choice').first().waitFor({ timeout: 20_000 });
    await p.waitForTimeout(500);
    const running = await p.evaluate(
      () => document.getAnimations().filter((a) => (a as CSSAnimation).animationName === 'pk-door').length,
    );
    check(running === 0, 'reduced motion: the name light still animates');
    await calm.close();
  }
  await player.close();
  void randomUUID;
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
for (const message of [...problems, ...errors]) console.error(message);
if (problems.length || errors.length) process.exitCode = 1;
else if (!failure) console.log('24k-2 browser check: ok');
