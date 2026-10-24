/**
 * Part 25a: the Burbur skin. Component tests for the pieces the design boards changed that are not already pinned by the older
 * files: the hand-lettered wordmark, the 小卡 data, the login / signed-out pages, the model sheet in its states, the 共创 colours
 * and the stylesheet's own rules (player selectors only, data-URI images only, every animation switched off by reduced motion).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handElement, handPath, handSvg, wordmarkSvg } from '../../src/features/brand/wordmark.ts';
import { providerPeople } from '../../src/features/prototype/provider-catalog-view.ts';
import { modelCopy, openModelPicker } from '../../src/features/prototype/model-picker.ts';
import { openAccountSheet, type AccountApi } from '../../src/features/account/account-sheet.ts';
import { renderSignedOut, type SignedOutApi } from '../../src/features/account/signed-out-page.ts';
import { openCocreationSheet } from '../../src/features/cocreation/cocreation-sheet.ts';
import { ProviderApiError, type AccountInfo } from '../../src/services/provider-api.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { PLAYER_MODELS, type ModelChoiceInfo } from '../../../../packages/contracts/player-models.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
const skin = css.slice(css.indexOf('/* Part 25a: the Burbur skin'));
const bare = skin.replace(/\/\*[\s\S]*?\*\//g, '');
/** Splits a selector list at its top-level commas (not the ones inside :is(...)). */
const selectors = (list: string) => {
  const out: string[] = [];
  let depth = 0,
    current = '';
  for (const char of list) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim().replace(/\s+/g, ' '));
      current = '';
    } else current += char;
  }
  return [...out, current.trim().replace(/\s+/g, ' ')].filter(Boolean);
};

// ---- the wordmark --------------------------------------------------------------------------------------------------------

test('the wordmark is drawn as lines: lowercase, one path, a view box from the text, nothing to download', () => {
  const mark = handPath('Burbur');
  assert.equal(mark.text, 'burbur');
  assert.match(mark.d, /^M/);
  assert.match(mark.viewBox, /^-1\.5 -20 [\d.]+ 28\.5$/);
  // Characters the hand does not draw (Chinese, emoji) are skipped, never replaced by a font.
  assert.equal(handPath('瓜瓜').d, '');
  assert.equal(handPath('jo瓜jo').d, handPath('jojo').d);
  // The logo trail adds the open bubble and the lips after the text.
  const trail = handPath('burbur', true);
  assert.ok(trail.d.length > mark.d.length && trail.ratio > mark.ratio);
  // The letters bounce on the baseline: the same letter at two places is not at the same height.
  const ys = [...handPath('uuuu').d.matchAll(/M[\d.]+,(-?[\d.]+)/g)].map((m) => m[1]);
  assert.ok(new Set(ys).size > 1);
});

test('the wordmark SVG is inline, coloured by currentColor, named for screen readers and has no style attribute (strict CSP)', () => {
  const svg = wordmarkSvg({ size: 40 });
  assert.match(svg, /^<svg class="hand" role="img" aria-label="Burbur"/);
  assert.match(svg, /stroke="currentColor"/);
  assert.match(svg, /height="40"/);
  assert.doesNotMatch(svg, /style=|<image|<text|href=|url\(/);
  // A Latin name on a card is decoration: hidden from screen readers.
  assert.match(handSvg('guagua', { size: 44, label: null }), /aria-hidden="true"/);
  // The DOM builder draws the same lettering.
  const doc = installFakeDom({ after: () => {} });
  void doc;
});

test('handElement builds the same lettering through the DOM, so a page that never parses markup can show it', (t) => {
  installFakeDom(t);
  const svg = handElement('burbur', { size: 48, logo: true, label: 'Burbur' }) as unknown as FakeElement;
  assert.equal(svg.getAttribute('role'), 'img');
  assert.equal(svg.getAttribute('aria-label'), 'Burbur');
  assert.equal(svg.getAttribute('viewBox'), handPath('burbur', true).viewBox);
  assert.equal(svg.children.length, 1);
  assert.equal((svg.children[0] as FakeElement).getAttribute('d'), handPath('burbur', true).d);
});

// ---- the 小卡 data -------------------------------------------------------------------------------------------------------

test('every card has a serial number, an aura and (for a Latin-lettered name) the hand-lettered name', () => {
  const view = syntheticProviderBootstrap();
  for (const character of view.characters) character.availability = { state: 'available', personaVersion: 1 };
  const people = providerPeople(view);
  const byId = (id: string) => people.find((person) => person.characterId === id)!;
  assert.deepEqual(
    [byId('wei-guagua').card.no, byId('jojo').card.no, byId('chen-jimi').card.no],
    ['001', '002', '003'],
  );
  assert.equal(byId('wei-guagua').card.latin, 'guagua');
  assert.equal(byId('chen-jimi').card.latin, 'chen jimi');
  assert.deepEqual(byId('wei-guagua').card.aura, ['#FFD3B8', '#FFEBC9', '#FFB295', '#E8561E']);
  assert.deepEqual(byId('jojo').card.aura, ['#C6E4FF', '#D5F6EE', '#97C8F5', '#2F7BEA']);
  assert.deepEqual(byId('chen-jimi').card.aura, ['#DCD2FF', '#FFD8EE', '#BBA4FF', '#7C4DEB']);
  // A name of two Chinese characters is the biggest; a longer name shrinks so it stays on one line.
  assert.ok(byId('wei-guagua').card.nameSize > byId('chen-jimi').card.nameSize);
  assert.ok(byId('wei-guagua').card.nameSize <= 0.36);
  // An empty slot has a neutral aura and a number of its own; no text.
  const empty = people.find((person) => !person.characterId)!;
  assert.equal(empty.card.latin, null);
  assert.equal(empty.card.aura[3], '#141414');
});

test('a character the palette does not know gets the next serial number, a neutral aura and a Latin name only if it has one', () => {
  const view = syntheticProviderBootstrap();
  const template = view.characters[0]!;
  view.characters.push(
    { ...template, characterId: 'newcomer', displayName: 'Mimi' },
    { ...template, characterId: 'newcomer-2', displayName: '小米' },
  );
  view.slots.splice(
    3,
    2,
    { kind: 'character', characterId: 'newcomer' },
    { kind: 'character', characterId: 'newcomer-2' },
  );
  const people = providerPeople(view);
  const mimi = people.find((person) => person.characterId === 'newcomer')!;
  const xiaomi = people.find((person) => person.characterId === 'newcomer-2')!;
  assert.deepEqual([mimi.card.no, xiaomi.card.no], ['004', '005']);
  assert.equal(mimi.card.latin, 'Mimi');
  assert.equal(xiaomi.card.latin, null);
  assert.equal(mimi.card.aura[3], '#141414');
});

// ---- login and the signed-out page --------------------------------------------------------------------------------------

const noopApi = {
  login: async () => {
    throw new ProviderApiError(401, 'PLAYER_PASSWORD_WRONG');
  },
} as unknown as AccountApi;

function sheet(t: test.TestContext, mode: 'login' | 'signup' | 'nickname', api: AccountApi = noopApi) {
  const doc = installFakeDom(t);
  const handle = openAccountSheet({
    api,
    mode,
    mount: doc.body as unknown as HTMLElement,
    signupEnabled: true,
    doneMs: 0,
    timers: { now: () => 0, setInterval: () => 0, clearInterval: () => {} },
  });
  return { doc, root: handle.element as unknown as FakeElement };
}

test('login and signup carry the wordmark and an empty line under it - no tagline; other sheets do not', (t) => {
  for (const mode of ['login', 'signup'] as const) {
    const { root } = sheet(t, mode);
    const brand = root.querySelector('.acct-brand')!;
    assert.equal(brand.querySelector('svg')!.getAttribute('aria-label'), 'Burbur');
    const blank = brand.querySelector('.so-blank')!;
    assert.equal(blank.textContent, '');
    assert.equal(blank.getAttribute('aria-hidden'), 'true');
    assert.equal(brand.textContent, '', 'no tagline: the brand block holds the lettering and an empty line only');
  }
  assert.equal(sheet(t, 'nickname').root.querySelector('.acct-brand'), null);
});

test('a wrong password outlines the password field in the sheet; the message and any other error leave the field alone', async (t) => {
  let code = 'PLAYER_PASSWORD_WRONG';
  const api = {
    login: async () => {
      throw new ProviderApiError(401, code);
    },
  } as unknown as AccountApi;
  const { root } = sheet(t, 'login', api);
  const email = root.querySelector('input[name="email"]')!;
  const password = root.querySelector('input[name="password"]')!;
  email.value = 'a@example.com';
  password.value = 'whatever pass';
  const submit = () => root.querySelector('form')!.dispatch('submit');
  const field = () =>
    root.querySelectorAll('.acct-field').find((node) => node.querySelector('input[name="password"]'))!;
  submit();
  await flush();
  assert.equal(root.querySelector('.acct-status')!.textContent, '密码不正确');
  assert.ok(field().classList.contains('has-error'));
  // The next try clears the outline first; a different failure does not set it again.
  code = 'PLAYER_EMAIL_NOT_REGISTERED';
  submit();
  await flush();
  assert.equal(field().classList.contains('has-error'), false);
  assert.match(root.querySelector('.acct-status')!.textContent, /这个邮箱还没有注册/);
});

test('every password field keeps its 显示/隐藏 toggle (text and aria-pressed); the stylesheet draws it as the eye', (t) => {
  const { root } = sheet(t, 'login');
  const toggle = root.querySelector('.acct-reveal')!;
  assert.equal(toggle.textContent, '显示密码');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  toggle.click();
  assert.equal(toggle.textContent, '隐藏密码');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.match(skin, /\.acct-reveal\[aria-pressed="true"\]/);
});

test('the signed-out page: the wordmark with the logo trail, an empty line, the heading kept for screen readers, the three actions', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const api = {
    account: async () => ({ signupEnabled: true, signedIn: false }) as AccountInfo,
    bootstrap: async () => undefined,
  } as unknown as SignedOutApi;
  const page = renderSignedOut(root as unknown as HTMLElement, { api, reload: () => {} });
  await page.ready;
  const brand = root.querySelector('.so-brand')!;
  assert.equal(brand.querySelector('svg')!.getAttribute('aria-label'), 'Burbur');
  assert.equal(brand.querySelector('.so-blank')!.textContent, '');
  assert.equal(brand.textContent, '');
  assert.ok(root.querySelector('h1')!.classList.contains('sr-only'));
  assert.deepEqual(
    root.querySelectorAll('.signed-out-actions button').map((button) => button.textContent),
    ['登录', '注册', '以访客继续'],
  );
});

// ---- the model sheet ------------------------------------------------------------------------------------------------------

const models = [
  { id: 'deepseek', points: 10, voicePoints: 2 },
  { id: 'gemini', points: 20, voicePoints: 2 },
  { id: 'xai', points: 25, voicePoints: 2 },
] as ModelChoiceInfo['models'];
const metered: ModelChoiceInfo = {
  models,
  selected: 'deepseek',
  metered: true,
  balance: 470,
  repliesLeft: 39,
  version: 2,
};
const unmetered: ModelChoiceInfo = { ...metered, metered: false, balance: 0, repliesLeft: 0 };

function picker(
  t: test.TestContext,
  info: ModelChoiceInfo,
  extra: { onChanged?: (next: ModelChoiceInfo) => void } = {},
) {
  const doc = installFakeDom(t);
  const said: string[] = [];
  const handle = openModelPicker({
    info,
    characterName: '瓜瓜',
    accent: '#E8561E',
    api: { setModel: async (model) => ({ ...info, selected: model }) },
    onChanged: extra.onChanged ?? (() => {}),
    say: (message) => said.push(message),
    mount: doc.body as unknown as HTMLElement,
  });
  const root = handle.element as unknown as FakeElement;
  return { doc, root, said, handle, row: (id: string) => root.querySelector(`[data-model="${id}"]`)! };
}

test('model sheet, metered: "给瓜瓜换个" with the brain, rows with "{n} 点/条" and "语音 +N", the current one marked 当前', (t) => {
  const f = picker(t, metered);
  assert.equal(f.root.querySelector('.mp-title')!.textContent, '给瓜瓜换个');
  const brain = f.root.querySelector('.mp-brain')!;
  assert.equal(brain.getAttribute('role'), 'img');
  assert.equal(brain.getAttribute('aria-label'), '脑子');
  assert.equal(
    f.root.querySelector('.mp-balance')!.textContent,
    '剩余 470 点 · 约可聊 39 条',
    'the model sheet keeps the 约可聊 line',
  );
  assert.deepEqual(
    f.root.querySelectorAll('.mp-card').map((row) => row.querySelector('.mp-prices')!.textContent),
    ['10 点/条语音 +2', '20 点/条语音 +2', '25 点/条语音 +2'],
  );
  assert.equal(f.row('deepseek').querySelector('.mp-tag')!.textContent, '当前');
  assert.equal(f.row('gemini').querySelector('.mp-tag'), null);
  assert.equal(f.row('deepseek').getAttribute('aria-pressed'), 'true');
  assert.equal(
    f.root.style.getPropertyValue('--accent'),
    '#E8561E',
    'the picked row is outlined in the character’s accent',
  );
  for (const id of ['deepseek', 'gemini', 'xai'] as const)
    assert.match(f.row(id).textContent, new RegExp(PLAYER_MODELS[id].label));
  assert.equal(modelCopy.title('JOJO'), '给JOJO换个');
});

test('model sheet, unmetered: no prices and no balance; the confirm sentence has no price', (t) => {
  const f = picker(t, unmetered);
  assert.equal(f.root.querySelectorAll('.mp-prices').length, 0);
  assert.equal(f.root.querySelector('.mp-balance')!.textContent, '');
  assert.ok(f.root.querySelector('.mp-balance')!.hidden);
  f.row('gemini').click();
  assert.equal(f.root.querySelector('.mp-confirm')!.textContent, '之后用 Gemini 3.8 Flash。记忆不变。');
});

test('picking a row lifts it and opens the confirm box under the rows; 取消 puts it back; 换 switches once and says 已换成', async (t) => {
  const changed: ModelChoiceInfo[] = [];
  const f = picker(t, metered, { onChanged: (next) => changed.push(next) });
  assert.equal(f.root.querySelector('.mp-confirm'), null);
  f.row('xai').click();
  assert.ok(f.row('xai').classList.contains('is-picked'));
  assert.equal(f.row('xai').getAttribute('aria-pressed'), 'true');
  assert.equal(f.row('gemini').classList.contains('is-picked'), false);
  assert.equal(f.root.querySelector('.mp-confirm')!.textContent, '之后用 Grok 4.7 · 25 点/条（语音 +2）。记忆不变。');
  const buttons = f.root.querySelector('.mp-confirm-box')!.querySelectorAll('button');
  assert.deepEqual(
    buttons.map((b) => b.textContent),
    ['取消', '换'],
  );
  buttons[0]!.click();
  assert.equal(f.row('xai').classList.contains('is-picked'), false);
  assert.equal(f.root.querySelector('.mp-confirm'), null);
  f.row('xai').click();
  f.root.querySelector('.mp-sure')!.click();
  await flush();
  assert.equal(changed.length, 1);
  assert.equal(changed[0]!.selected, 'xai');
  assert.deepEqual(f.said, ['已换成 Grok 4.7']);
  assert.equal(f.doc.body.querySelector('.mp-sheet'), null);
});

test('tapping the dim (the sheet itself) closes the model sheet; tapping the panel does not', (t) => {
  const f = picker(t, metered);
  const panel = f.root.querySelector('.mp-panel')! as FakeElement;
  panel.dispatch('click', { target: panel });
  assert.ok(f.doc.body.querySelector('.mp-sheet'));
  f.root.dispatch('click', { target: f.root });
  assert.equal(f.doc.body.querySelector('.mp-sheet'), null);
});

// ---- 共创 -------------------------------------------------------------------------------------------------------------------

test('the 共创 sheet is painted in the character’s aura through custom properties, never an inline style attribute', (t) => {
  const doc = installFakeDom(t);
  const handle = openCocreationSheet({
    api: { submitCocreation: async () => ({ submissionId: 's', answered: 1, duplicate: false }) },
    characterId: 'wei-guagua',
    name: '瓜瓜',
    color: '#D7C8B9',
    ink: '#614C3C',
    aura: ['#FFD3B8', '#FFEBC9', '#FFB295', '#E8561E'],
    mount: doc.body as unknown as HTMLElement,
    thanksMs: 0,
  });
  const root = handle.element as unknown as FakeElement;
  assert.equal(root.getAttribute('style'), null);
  assert.equal(root.style.getPropertyValue('--aura-1'), '#FFD3B8');
  assert.equal(root.style.getPropertyValue('--aura-3'), '#FFB295');
  assert.equal(root.style.getPropertyValue('--accent'), '#E8561E');
  assert.equal(root.style.getPropertyValue('--cc-color'), '#D7C8B9');
  assert.equal(root.querySelector('.cc-title')!.textContent, '让瓜瓜更像瓜瓜');
  handle.close();
});

// ---- the stylesheet ---------------------------------------------------------------------------------------------------------

test('the skin block is player-only: it names no admin selector, so mobile-layout keeps passing', () => {
  assert.ok(skin.length > 2000, 'the Part 25a block exists');
  assert.doesNotMatch(skin, /\.admin|\.account-admin|#admin-/);
});

test('the skin loads nothing: every url() is a data URI, there is no @import and no @font-face', () => {
  assert.doesNotMatch(skin, /@import|@font-face/);
  const urls = [...skin.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/g)].map((m) => m[2]!);
  assert.ok(urls.length >= 6, 'the icons are drawn as data URIs');
  for (const url of urls) assert.match(url, /^data:image\/svg\+xml,/, url.slice(0, 40));
});

test('every animation of the skin is switched off by prefers-reduced-motion', () => {
  const used = new Set([...bare.matchAll(/animation:\s*(bb-[a-z]+)/g)].map((m) => m[1]!));
  assert.ok(used.size >= 8, 'the motion set exists');
  const reduced = skin.slice(skin.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /animation:\s*none/);
  // Every selector that starts one of the skin's animations is listed in the reduced-motion block.
  const starters = [...bare.matchAll(/([^{}]+)\{[^{}]*animation:\s*bb-[a-z]+[^{}]*\}/g)].map((m) => m[1]!.trim());
  const last = /([^{}]+)\{\s*animation: none;\s*\}\s*\}\s*$/.exec(bare.trim());
  assert.ok(last, 'the reduced-motion block ends with the rule that cancels the animations');
  const listed = selectors(last[1]!);
  assert.ok(starters.length >= 14);
  for (const selector of starters)
    for (const one of selectors(selector)) assert.ok(listed.includes(one), `reduced motion covers ${one}`);
  // And the older blanket rule that cuts any remaining animation to ~0 is still there.
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*\*,\s*\*:before,\s*\*:after \{[^}]*animation-duration: 0\.01ms !important/,
  );
});

test('the design’s one curve is used for every move, and the 小卡 sheen plays once per arrival, never in a loop', () => {
  assert.match(skin, /--bb-ease: cubic-bezier\(0\.2, 0\.82, 0\.24, 1\)/);
  assert.doesNotMatch(bare, /animation:[^;}]*infinite/);
  assert.match(skin, /\.card-slot\.is-active:not\(\.is-chat\) \.face-sheen \{\s*animation: bb-sheen 900ms/);
});

test('the chat parts under the 小卡 face are hidden from sight and focus until the card opens, and the face leaves with the chat', () => {
  assert.match(
    skin,
    /\.card-slot:not\(\.is-chat\) :is\(\.chat-head, \.chat-body, \.composer\) \{\s*visibility: hidden/,
  );
  assert.match(skin, /\.card-slot\.is-chat \.card-face \{[^}]*opacity: 0;[^}]*pointer-events: none/);
});

test('animations that end must not leave a stacking context over the ⋯ menu (fill-mode backwards, not both)', () => {
  assert.match(
    skin,
    /\.card-slot\.is-chat :is\(\.chat-head, \.chat-body, \.composer\) \{\s*animation: bb-fade 320ms ease 120ms backwards/,
  );
});
