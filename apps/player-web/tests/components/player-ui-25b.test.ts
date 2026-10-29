/**
 * Part 25b: player UI round 2. The phone's stack of cards, the voice-only welcome pill, the guest line's place, the chat's own
 * background and the avatar frames (and where they are kept), night mode, the shared voice card, the sheets' motion and 我的信息
 * in its soft colours. Component tests with the in-memory DOM; the same behaviours run in a real browser in
 * scripts/check-web-browser.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { openMyInfo, quotaView, trialQuotaView, type MyInfoOptions } from '../../src/features/account/my-info.ts';
import {
  PLAYER_FRAMES,
  characterFrame,
  playerFrame,
  setFrameProperties,
} from '../../src/features/brand/avatar-frame.ts';
import { derivePalette, nightAura } from '../../src/features/brand/character-colour.ts';
import { PREFS_KEY, PlayerPrefs, parsePrefs } from '../../src/features/prefs/player-prefs.ts';
import { PAPER, resolveTheme, startTheme } from '../../src/features/prefs/theme.ts';
import { applyChatBackground, openLookSheet } from '../../src/features/prototype/chat-look.ts';
import { mountChatGuide, GUIDE_KEY } from '../../src/features/cocreation/chat-guide.ts';
import { openEarnSheet } from '../../src/features/cocreation/earn-sheet.ts';
import { openModelPicker } from '../../src/features/prototype/model-picker.ts';
import { orbitStyle, ringOffset } from '../../src/features/prototype/orbit.ts';
import { cardFace } from '../../src/features/prototype/card-face.ts';
import { providerPeople } from '../../src/features/prototype/provider-catalog-view.ts';
import { formatDuration, voicePill } from '../../src/features/prototype/voice-pill.ts';
import { stackCardWidth, swipeStep } from '../../src/features/prototype/mobile-layout.ts';
import { renderSharedCard, type SharedCardData } from '../../src/features/share/shared-card.ts';
import { syntheticProviderBootstrap } from '../../../../packages/contracts/web-provider.ts';
import { FakeElement, installFakeDom } from './fake-dom.ts';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
const part = css.slice(css.indexOf('/* ====', css.indexOf('Part 25b: player UI round 2') - 200));
const bare = part.replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(bare);
  assert.ok(found, `a rule for ${selector}`);
  return found![1]!;
};

/** A localStorage that remembers, and that can be switched off. */
function storage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}
const available = () => {
  const view = syntheticProviderBootstrap();
  for (const character of view.characters) character.availability = { state: 'available', personaVersion: 1 };
  return view;
};

// ---- 1. home: the phone stacks the cards like the desktop --------------------------------------------------------------------

test('a phone shows the front card with its neighbours peeking out on both sides, at every common width', () => {
  for (const width of [320, 360, 375, 390, 414, 430, 600]) {
    const card = stackCardWidth(width);
    assert.ok(card < width - 60, `${width}: the card leaves room on both sides (${card})`);
    const near = orbitStyle(1, 15);
    // The neighbour's far edge, measured from the middle of the screen, against the screen's own edge and the front card's.
    const neighbourEdge = near.x * card + (card * near.scale) / 2;
    const peek = Math.min(width / 2, neighbourEdge) - card / 2;
    assert.ok(peek >= 40, `${width}: ${Math.round(peek)} px of the neighbour show`);
  }
  // The desktop's own numbers are unchanged.
  assert.equal(stackCardWidth(1440), 376);
  assert.equal(stackCardWidth(800), 376);
  assert.equal(stackCardWidth(700), 376 - 0 > 700 - 108 ? 700 - 108 : 376);
});

test('the phone stylesheet keeps the neighbours visible and tappable, sizes every card from one number and no longer hides all but the front', () => {
  const phone = bare.slice(bare.indexOf('@media (max-width: 600px)'));
  assert.match(phone, /\.page-shell\[data-phase\] \.card-slot:not\(\.is-chat\) \{[^}]*width: var\(--card-w, 294px\)/);
  assert.match(
    phone,
    /\.page-shell\[data-phase="browse"\] \.card-slot:not\(\.is-active\):not\(\.is-hidden-slot\),[^{]*\{[^}]*visibility: visible;[^}]*pointer-events: auto/,
  );
  const source = readFileSync(new URL('../../src/features/prototype/preview.ts', import.meta.url), 'utf8');
  assert.match(source, /page\.style\.setProperty\('--card-w'/);
  // The inert rule of the single-card phone layout is gone: only a chat makes the other cards inert.
  assert.doesNotMatch(source, /window\.innerWidth <= 600\) && index !== active/);
  // A tap on a neighbour only turns to it on a phone.
  assert.match(source, /if \(window\.innerWidth > 600\) openChat\(/);
});

test('swiping a phone: a sideways drag turns to the next or the previous card; a vertical or short one never does', () => {
  assert.equal(swipeStep(-120, 6), 1, 'finger left: the next card');
  assert.equal(swipeStep(120, 6), -1, 'finger right: the previous card');
  for (const [dx, dy] of [
    [30, 0],
    [120, 160],
    [0, 200],
  ] as const)
    assert.equal(swipeStep(dx, dy), 0);
  // Fifteen positions wrap: the last card's right neighbour is the first.
  assert.equal(ringOffset(0, 14, 15), 1);
  const source = readFileSync(new URL('../../src/features/prototype/preview.ts', import.meta.url), 'utf8');
  assert.match(source, /const step = swipeStep\(dx, dy/);
  assert.match(source, /if \(dragged && step\) switchTo\(active \+ step\)/);
});

test('the avatar row is an oval: the chosen avatar lowest, the others rising as they turn away, left and right alike', () => {
  const y = (offset: number) => orbitStyle(offset, 15).avatarY;
  assert.equal(y(0), 0);
  assert.ok(y(1) < 0 && y(2) < y(1) && y(3) < y(2), 'each step round the oval is higher than the last');
  assert.equal(y(-2), y(2));
  assert.ok(orbitStyle(1, 15).avatarX > 0 && orbitStyle(-1, 15).avatarX < 0);
});

// ---- 1b. the welcome is a voice pill, not words -----------------------------------------------------------------------------

test('the welcome pill is a play button with a waveform and the length, and has no transcript anywhere on the card', () => {
  const people = providerPeople(available());
  const guagua = people.find((person) => person.characterId === 'wei-guagua')!;
  guagua.transcript = '秘密的欢迎词：这一句不该出现在小卡上';
  guagua.welcomeMs = 6400;
  const face = cardFace(guagua, true);
  assert.match(face, /<button class="face-voice" type="button" aria-label="播放瓜瓜的语音">/);
  assert.match(face, /<svg class="face-wave"[^>]*aria-hidden="true"><path d="M2 8v8M6 6v12/);
  assert.match(face, /<span class="face-dur">0:06<\/span>/);
  assert.doesNotMatch(face, /秘密的欢迎词|face-line|transcript/, 'no welcome text on the card');
  // The pill carries no text but its length; its name is the label.
  const text = face.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');
  assert.match(text, /No\.001/);
  assert.doesNotMatch(text, /欢迎|秘密/);
  // An empty slot has no pill; a welcome with no audio shows the pill without a length.
  assert.doesNotMatch(cardFace(people.find((p) => !p.characterId)!, false), /face-voice/);
  assert.doesNotMatch(voicePill('瓜瓜', null), /face-dur/);
  assert.equal(formatDuration(6400), '0:06');
  assert.equal(formatDuration(95_000), '1:35');
  assert.equal(formatDuration(100), '0:01', 'at least a second');
  // The pill is a real control: the card's own tap (open the chat) is not what it does.
  const source = readFileSync(new URL('../../src/features/prototype/preview.ts', import.meta.url), 'utf8');
  assert.match(source, /for \(const selector of \['\.play-button', '\.face-voice'\]\)/);
});

// ---- 2. chat: the guest's line, the background, the frames -------------------------------------------------------------------

test('the guest line is centred in the chat area, out of the flow, and only its link takes taps', () => {
  const note = rule('.page-shell .card-slot.is-chat .card-shell > .guest-note:not([hidden])');
  assert.match(note, /position: absolute/);
  assert.match(note, /top: calc\(76px \+ env\(safe-area-inset-top\)\)/, 'below the header');
  assert.match(note, /bottom: calc\(80px \+ env\(safe-area-inset-bottom\)\)/, 'above the input, not on it');
  assert.match(note, /place-content: center/);
  assert.match(note, /pointer-events: none/);
  assert.match(rule('.page-shell .card-slot.is-chat .guest-note-link'), /pointer-events: auto/);
  // Part 26a's words are unchanged.
  const source = readFileSync(new URL('../../src/features/prototype/provider-binding.ts', import.meta.url), 'utf8');
  assert.match(source, /first: '新客人，就决定是这位小四四了吗？'/);
  assert.match(source, /lockedAfter: '就能解锁全部小四四～'/);
});

test('the chat background: soft presets, any colour, one choice per character, remembered by the device', (t) => {
  const store = storage();
  const prefs = new PlayerPrefs(store);
  assert.equal(prefs.chatBackground('jojo'), null, 'no choice: the character’s own aura');
  prefs.setChatBackground('jojo', { kind: 'preset', id: 'mint' });
  prefs.setChatBackground('wei-guagua', { kind: 'custom', color: '#7fd6c2' });
  assert.deepEqual(prefs.chatBackground('jojo'), { kind: 'preset', id: 'mint' });
  assert.deepEqual(prefs.chatBackground('wei-guagua'), { kind: 'custom', color: '#7FD6C2' });
  assert.equal(prefs.chatBackground('chen-jimi'), null, 'another character is not touched');
  // A new page on the same device reads them back.
  const later = new PlayerPrefs(store);
  assert.deepEqual(later.chatBackground('jojo'), { kind: 'preset', id: 'mint' });
  assert.deepEqual(later.chatBackground('wei-guagua'), { kind: 'custom', color: '#7FD6C2' });
  // What is stored is untrusted: an unknown preset, a colour that is not one and a made-up key are dropped, never repaired.
  const bad = parsePrefs(
    JSON.stringify({
      theme: 'sepia',
      frame: 'gold',
      chatBg: {
        jojo: { kind: 'preset', id: 'neon' },
        a: { kind: 'custom', color: 'red' },
        'Not An Id!': { kind: 'preset', id: 'mint' },
        ok: { kind: 'custom', color: '#112233' },
      },
    }),
  );
  assert.deepEqual(bad, { theme: 'system', frame: 'soft', chatBg: { ok: { kind: 'custom', color: '#112233' } } });
  assert.deepEqual(parsePrefs('not json'), { theme: 'system', frame: 'soft', chatBg: {} });
  prefs.setChatBackground('jojo', { kind: 'custom', color: 'javascript:1' } as never);
  assert.deepEqual(prefs.chatBackground('jojo'), { kind: 'preset', id: 'mint' }, 'a bad colour changes nothing');
  prefs.setChatBackground('jojo', null);
  assert.equal(prefs.chatBackground('jojo'), null, 'default puts the aura back');
  // A storage that is off or full leaves the page working for this visit.
  const broken = new PlayerPrefs({
    getItem: () => {
      throw new Error('off');
    },
    setItem: () => {
      throw new Error('full');
    },
    removeItem: () => {
      throw new Error('off');
    },
  });
  broken.setChatBackground('jojo', { kind: 'preset', id: 'sky' });
  assert.deepEqual(broken.chatBackground('jojo'), { kind: 'preset', id: 'sky' });
  broken.clear();
  assert.equal(broken.chatBackground('jojo'), null);
  // 清除本设备的体验数据 clears what was chosen.
  prefs.setTheme('dark');
  prefs.clear();
  assert.equal(store.data.has(PREFS_KEY), false);
  assert.equal(prefs.theme, 'system');
  // No identity is kept: a character id and a colour, nothing else.
  const saved = new PlayerPrefs(storage());
  saved.setChatBackground('jojo', { kind: 'preset', id: 'sky' });
  void t;
});

test('a preset or a custom colour paints the card through custom properties only; a dark custom colour says so', (t) => {
  const doc = installFakeDom(t);
  const card = doc.createElement('article') as unknown as HTMLElement;
  const el = card as unknown as FakeElement;
  applyChatBackground(card, { kind: 'preset', id: 'peach' });
  assert.equal(el.style.getPropertyValue('--chat-tint-day'), '#FFE6DA');
  assert.equal(el.style.getPropertyValue('--chat-tint-night'), '#3A2420', 'a preset has a night tone of its own');
  assert.ok(el.classList.contains('has-chat-bg'));
  assert.equal(el.getAttribute('data-tone'), null, 'a preset follows the theme');
  applyChatBackground(card, { kind: 'custom', color: '#102040' });
  assert.equal(el.style.getPropertyValue('--chat-tint-day'), '#102040');
  assert.equal(el.style.getPropertyValue('--chat-tint-night'), '#102040', 'a custom colour is the same in both themes');
  assert.equal(el.getAttribute('data-tone'), 'dark', 'dark colour: the bubbles turn light');
  applyChatBackground(card, { kind: 'custom', color: '#FFF3C9' });
  assert.equal(el.getAttribute('data-tone'), 'light');
  applyChatBackground(card, null);
  assert.equal(el.style.getPropertyValue('--chat-tint-day'), '');
  assert.equal(el.classList.contains('has-chat-bg'), false);
  assert.equal(el.getAttribute('data-tone'), null);
  const source = readFileSync(new URL('../../src/features/prototype/chat-look.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /style\.(?:background|color|cssText)|setAttribute\('style'|innerHTML/);
  // The stylesheet: the player's colour is the card's background, the aura stays the default, night has its own.
  assert.match(rule('.page-shell .card-slot.is-chat.has-chat-bg .card-shell'), /var\(--chat-tint-day\)/);
  assert.match(
    rule(':root[data-theme="dark"] .page-shell .card-slot.is-chat.has-chat-bg .card-shell'),
    /var\(--chat-tint-night\)/,
  );
});

test('外观 opens from the ⋯ menu, slides up, applies each choice at once, keeps it for the character and the frame for the player', (t) => {
  const doc = installFakeDom(t);
  const store = storage();
  const prefs = new PlayerPrefs(store);
  const card = doc.createElement('article') as unknown as HTMLElement;
  const page = doc.createElement('div') as unknown as HTMLElement;
  const handle = openLookSheet({ characterId: 'jojo', prefs, card, frameHost: page, mount: doc.body as never });
  const sheet = handle.element as unknown as FakeElement;
  assert.ok(sheet.classList.contains('mp-sheet') && sheet.classList.contains('acct-sheet'), 'the model sheet’s frame');
  assert.equal(sheet.getAttribute('aria-modal'), 'true');
  const swatches = sheet.querySelectorAll('.look-swatch');
  assert.equal(swatches.length, 1 + 7 + 1, '默认, seven soft presets and a custom colour');
  assert.equal(swatches[0]!.getAttribute('aria-checked'), 'true', 'nothing chosen yet: 默认');
  // A preset.
  sheet.querySelector('button[aria-label="薄荷"]')!.click();
  assert.deepEqual(prefs.chatBackground('jojo'), { kind: 'preset', id: 'mint' });
  assert.equal((card as unknown as FakeElement).style.getPropertyValue('--chat-tint-day'), '#DDF4EA');
  assert.equal(sheet.querySelector('button[aria-label="薄荷"]')!.getAttribute('aria-checked'), 'true');
  assert.equal(swatches[0]!.getAttribute('aria-checked'), 'false');
  // A custom colour, live.
  const picker = sheet.querySelector('input[type="color"]')!;
  picker.value = '#7fd6c2';
  picker.dispatch('input');
  assert.deepEqual(prefs.chatBackground('jojo'), { kind: 'custom', color: '#7FD6C2' });
  assert.equal((card as unknown as FakeElement).style.getPropertyValue('--chat-tint-night'), '#7FD6C2');
  // 默认 puts the character's aura back.
  swatches[0]!.click();
  assert.equal(prefs.chatBackground('jojo'), null);
  // The player's own frame: applied to the page, kept for the device.
  assert.equal(sheet.querySelectorAll('.look-frame').length, PLAYER_FRAMES.length);
  sheet.querySelector('button[aria-label="葡萄"]')!.click();
  assert.equal(prefs.frame, 'grape');
  assert.equal((page as unknown as FakeElement).style.getPropertyValue('--own-a'), '#7C4DEB');
  assert.equal(new PlayerPrefs(store).frame, 'grape');
  // Escape closes the sheet and goes no further (the chat stays open).
  let stopped = false;
  doc.fire('keydown', { key: 'Escape', stopPropagation: () => void (stopped = true) });
  assert.equal(stopped, true);
  assert.equal(doc.body.querySelector('.look-sheet'), null);
});

test('a character’s frame comes from its colour (published main colour, else today’s palette, else the neutral one); the player’s from their pick', (t) => {
  const view = available();
  view.characters.find((c) => c.characterId === 'jojo')!.mainColor = '#7C4DEB';
  const people = providerPeople(view);
  const frameOf = (id: string) => characterFrame(people.find((p) => p.characterId === id)!.card.aura);
  // Published colour: the accent of the palette derived from it.
  const derived = derivePalette('#7C4DEB').aura;
  assert.deepEqual(frameOf('jojo').ring, [derived[3], derived[2], derived[1]]);
  assert.deepEqual(frameOf('jojo').fill, [derived[2], derived[1]]);
  // No colour: today's palette (瓜瓜's orange).
  assert.deepEqual(frameOf('wei-guagua').ring, ['#E8561E', '#FFB295', '#FFEBC9']);
  // A character nobody gave a colour or a palette: the neutral one.
  const extra = available();
  extra.characters.push({ ...extra.characters[0]!, characterId: 'newcomer', displayName: '小米' });
  extra.slots.splice(3, 1, { kind: 'character', characterId: 'newcomer' });
  const neutral = characterFrame(providerPeople(extra).find((p) => p.characterId === 'newcomer')!.card.aura);
  assert.equal(neutral.ring[0], '#141414');
  // The frame is custom properties on the card (the CSSOM), nothing inline.
  const doc = installFakeDom(t);
  const element = doc.createElement('article') as unknown as HTMLElement;
  setFrameProperties(element, frameOf('wei-guagua'), 'frame');
  const style = (element as unknown as FakeElement).style;
  assert.equal(style.getPropertyValue('--frame-a'), '#E8561E');
  assert.equal(style.getPropertyValue('--frame-f1'), '#FFB295');
  // The player's frames: a small set, each a ring of three colours.
  assert.ok(PLAYER_FRAMES.length >= 4 && PLAYER_FRAMES.length <= 8);
  for (const entry of PLAYER_FRAMES) {
    assert.equal(playerFrame(entry.id).ring.length, 3);
    assert.ok(entry.ring.every((c) => /^#[0-9A-F]{6}$/.test(c)));
  }
  // The CSS: ring, then a thin gap of the page's colour, then the fill - for characters and for the player.
  for (const selector of [
    '.page-shell .message-avatar,\n.page-shell .chat-mark',
    '.page-shell .message-row.outgoing::after',
  ])
    assert.match(rule(selector), /box-shadow: inset 0 0 0 1\.5px var\(--bb-paper\)/, selector);
  assert.match(rule('.page-shell .message-row.outgoing::after'), /var\(--own-a, #ffb295\)/);
  assert.match(rule('.page-shell .message-avatar,\n.page-shell .chat-mark'), /var\(--frame-a\)/);
});

test('the chat header is centred - back, avatar over name, ⋯ - and a phone’s top bar leaves with a fade and a lift, not at once', () => {
  assert.match(rule('.page-shell .card-slot .chat-head'), /grid-template-columns: 56px minmax\(0, 1fr\) 56px/);
  assert.match(rule('.chat-title'), /align-items: center/);
  assert.match(
    rule('.page-shell .card-slot .chat-head .chat-more,\n.page-shell .card-slot .chat-head .chat-head-gap'),
    /justify-self: end/,
  );
  const phone = bare.slice(bare.indexOf('@media (max-width: 600px)', bare.indexOf('opening a chat') > 0 ? 0 : 0));
  const bar =
    /\.page-shell\[data-phase="chat"\] \.site-head,\s*\.page-shell\[data-phase="expanding"\] \.site-head \{([^}]*)\}/.exec(
      bare,
    )![1]!;
  assert.doesNotMatch(bar, /display: none/);
  assert.match(bar, /opacity: 0/);
  assert.match(bar, /transform: translateY\(-12px\)/);
  assert.match(bar, /visibility 0s 360ms/, 'hidden only after it has faded and lifted');
  assert.match(phone, /transition:\s*opacity 240ms ease,\s*transform 360ms var\(--bb-ease\)/);
  // The avatar row and the footer note drop away the same way; the chat grows to fill the screen.
  assert.match(
    bare,
    /\.page-shell\[data-phase="chat"\] \.avatar-nav,[^{]*\{[^}]*opacity: 0;[^}]*transform: translateY\(24px\)/,
  );
  assert.match(
    bare,
    /\.page-shell\[data-phase="chat"\] \.card-slot\.is-chat,[^{]*\{[^}]*position: fixed;[^}]*width: var\(--chat-width, 100vw\)/,
  );
});

// ---- 3. 我的信息 -------------------------------------------------------------------------------------------------------------

function myInfo(t: test.TestContext, over: Partial<MyInfoOptions> = {}) {
  const doc = installFakeDom(t);
  const prefs = new PlayerPrefs(storage());
  const handle = openMyInfo({
    mode: 'player',
    nickname: '阿泡',
    playerNumber: 'ABCD2345',
    emailMasked: 'p***@example.com',
    quota: quotaView({ tier: undefined, modelChoice: undefined }),
    trialLine: null,
    signupOpen: true,
    deleteEnabled: false,
    saveNickname: async () => {},
    actions: {
      password() {},
      logoutOthers: async () => {},
      logout: async () => {},
      deleteAccount() {},
      clearDevice() {},
      signup() {},
      login() {},
    },
    mount: doc.body as unknown as HTMLElement,
    prefs,
    ...over,
  });
  return { doc, prefs, root: handle.element as unknown as FakeElement };
}
const planOf = (kind: 'daily_refill' | 'unlimited') =>
  kind === 'daily_refill'
    ? ({ kind, dailyAmount: 50, cap: 1000, expiresAt: Date.UTC(2027, 0, 20) } as const)
    : ({ kind, expiresAt: Date.UTC(2027, 0, 20) } as const);
const choice = (kind: 'daily_refill' | 'unlimited') => ({
  models: [{ id: 'deepseek' as const, points: 10, voicePoints: 2 }],
  selected: 'deepseek' as const,
  metered: kind === 'daily_refill',
  balance: 470,
  repliesLeft: 47,
  version: 1,
  plan: planOf(kind),
});

test('我的信息 in its four states keeps its content: 470 点 / 每天 +50 with the bar, 不限量, a guest’s trial, a plain registered player', (t) => {
  const refillTier = { kind: 'daily_refill' as const, unlimited: false, plan: planOf('daily_refill') };
  const refill = myInfo(t, { quota: quotaView({ tier: refillTier, modelChoice: choice('daily_refill') }) });
  const card = refill.root.querySelector('.mi-quota-card')!;
  assert.equal(card.querySelector('.mi-big')!.textContent, '470');
  assert.equal(card.querySelector('.mi-unit')!.textContent, '点');
  assert.equal(card.querySelector('.mi-daily')!.textContent, '/ 每天 +50');
  assert.equal(card.querySelector('.mi-meter')!.getAttribute('aria-valuenow'), '47');
  assert.equal(card.querySelector('.mi-pill')!.textContent, '邀请');
  assert.equal(card.querySelector('.mi-chip')!.textContent, '2027-01-20');
  assert.equal(
    card.querySelectorAll('button').filter((b) => b.textContent === '获得点数').length,
    0,
    '获得点数 comes with 24c',
  );
  const unlimitedTier = { kind: 'unlimited' as const, unlimited: true, plan: planOf('unlimited') };
  const unlimited = myInfo(t, { quota: quotaView({ tier: unlimitedTier, modelChoice: choice('unlimited') }) });
  assert.equal(unlimited.root.querySelector('.mi-big')!.textContent, '不限量');
  assert.equal(unlimited.root.querySelector('.mi-meter'), null, 'no bar for an unlimited player');
  const guest = myInfo(t, {
    mode: 'guest',
    nickname: null,
    quota: trialQuotaView({ remaining: 2, offered: 3, endsAt: Date.UTC(2026, 9, 30) }),
  });
  assert.equal(guest.root.querySelector('.mi-big')!.textContent, '2');
  assert.equal(guest.root.querySelector('.mi-unit')!.textContent, '次');
  assert.ok(guest.root.querySelector('.mi-quota-card')!.classList.contains('is-guest'));
  const registered = myInfo(t);
  assert.equal(registered.root.querySelector('.mi-pill')!.textContent, '注册玩家');
  assert.equal(registered.root.querySelector('.mi-meter'), null);
});

test('我的信息 is painted in soft colours: a tinted points card and soft accent buttons, no black pills or black buttons', () => {
  assert.match(rule('.mi-quota-card'), /background: linear-gradient\(160deg, #cfe3ff 0%, #d4f3e6 100%\)/);
  for (const selector of ['.mi-pill', '.mi-pillbtn.is-main', '.mi-small.acct-primary', '.mi-theme-pill.is-on'])
    assert.doesNotMatch(rule(selector), /var\(--bb-ink\)|#141414|#000|background: #fff/, selector);
  assert.match(rule('.mi-pill'), /rgba\(47, 123, 234, 0\.14\)/);
  assert.match(rule('.mi-pillbtn.is-main'), /background: #a9cdfb/);
  // Night: the same card in dark glass, the main button a light blue.
  assert.match(rule(':root[data-theme="dark"] .mi-quota-card'), /linear-gradient\(160deg, rgba\(47, 107, 255, 0\.28\)/);
  assert.match(rule(':root[data-theme="dark"] .mi-quota-card'), /rgba\(255, 255, 255, 0\.12\)/);
});

// ---- 4. night mode -----------------------------------------------------------------------------------------------------------

test('night mode follows the system until the player picks, and the pick wins over the system either way', () => {
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('light', true), 'light');
});

test('startTheme: <html> follows the system setting live, a pick overrides it, and the cross-fade lasts 600 ms', (t) => {
  const doc = installFakeDom(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listeners = new Set<() => void>();
  const query = {
    matches: false,
    addEventListener: (_: 'change', fn: () => void) => void listeners.add(fn),
    removeEventListener: (_: 'change', fn: () => void) => void listeners.delete(fn),
  };
  const prefs = new PlayerPrefs(storage());
  const root = doc.documentElement;
  const theme = startTheme(prefs, query);
  assert.equal(root.getAttribute('data-theme'), 'light');
  assert.equal(root.style.getPropertyValue('background-color'), PAPER.light);
  assert.equal(root.classList.contains('theme-fade'), false, 'no fade on the first paint');
  // The system goes dark while the page is open: it follows and cross-fades.
  query.matches = true;
  for (const fn of listeners) fn();
  assert.equal(root.getAttribute('data-theme'), 'dark');
  assert.equal(root.style.getPropertyValue('background-color'), PAPER.dark);
  assert.equal(root.style.getPropertyValue('color-scheme'), 'dark');
  assert.ok(root.classList.contains('theme-fade'));
  t.mock.timers.tick(700);
  assert.equal(root.classList.contains('theme-fade'), false, 'the fade class does not stay');
  // The player picks 日间: the system no longer decides.
  prefs.setTheme('light');
  assert.equal(root.getAttribute('data-theme'), 'light');
  query.matches = false;
  prefs.setTheme('dark');
  assert.equal(root.getAttribute('data-theme'), 'dark');
  prefs.setTheme('system');
  assert.equal(root.getAttribute('data-theme'), 'light');
  theme.stop();
  assert.equal(listeners.size, 0);
  prefs.setTheme('dark');
  assert.equal(root.getAttribute('data-theme'), 'light', 'stopped');
});

test('the manual toggle in 我的信息 is three radio choices, 跟随系统 first; picking one applies and keeps it', (t) => {
  const doc = installFakeDom(t);
  const prefs = new PlayerPrefs(storage());
  const query = { matches: false, addEventListener() {}, removeEventListener() {} };
  startTheme(prefs, query);
  const { root } = myInfo(t, { prefs });
  const group = root.querySelector('.mi-theme')!;
  assert.equal(group.getAttribute('role'), 'radiogroup');
  const pills = group.querySelectorAll('label');
  assert.deepEqual(
    pills.map((pill) => pill.textContent),
    ['跟随系统', '日间', '夜间'],
  );
  assert.equal(pills[0]!.querySelector('input')!.checked, true);
  assert.ok(pills[0]!.classList.contains('is-on'));
  const night = pills[2]!.querySelector('input')!;
  night.dispatch('change');
  assert.equal(prefs.theme, 'dark');
  assert.equal(doc.documentElement.getAttribute('data-theme'), 'dark');
  assert.ok(pills[2]!.classList.contains('is-on') && !pills[0]!.classList.contains('is-on'));
  // The pills are inputs, not buttons: the buttons of the page are the ones it had before.
  assert.equal(root.querySelectorAll('.mi-theme button').length, 0);
});

test('night mode covers home, chat, sheets and 我的信息 and touches nothing else: one attribute, player selectors only', () => {
  const dark = bare.match(/:root\[data-theme="dark"\][^{]*\{/g) ?? [];
  assert.ok(dark.length > 60, 'night has its own rules');
  for (const surface of [
    '.card-face',
    '.page-shell .avatar-choice-mark',
    '.page-shell .message-avatar',
    '.chat-menu-item',
    '.mi-quota-card',
    '.acct-sheet:not(.mp-sheet)',
    '.mp-panel',
    '.cc-sheet',
    '.invite-dialog',
    '.bl-tables',
    '.shared-face',
  ])
    assert.ok(
      dark.some((selector) => selector.includes(surface)),
      `${surface} has a night rule`,
    );
  assert.doesNotMatch(part, /\.admin|\.account-admin|#admin-/);
  // The page's paper and ink flip through tokens, so every rule that reads them follows.
  assert.match(rule(':root[data-theme="dark"],\n.card-slot.is-chat[data-tone="dark"]'), /--bb-paper: #0c0b10/);
  assert.match(rule(':root[data-theme="dark"],\n.card-slot.is-chat[data-tone="dark"]'), /--bb-ink: #f5f3f7/);
  // Only the player's page ever starts it (the console is another entry).
  const main = readFileSync(new URL('../../src/app/main.ts', import.meta.url), 'utf8');
  const player = main.slice(main.indexOf("mode === 'provider') {"));
  assert.match(player, /startTheme\(playerPrefs\(\)\)/);
  assert.equal(main.match(/startTheme\(/g)?.length, 1, 'started once');
  assert.ok(main.indexOf('startTheme(') > main.indexOf("mode === 'provider') {"), 'in the player branch only');
  // The cross-fade is switched off for people who asked for less motion.
  assert.match(css, /html\.theme-fade \*,[\s\S]*?transition:[\s\S]*?600ms/);
});

test('night colours: a character without a built-in night palette gets one from its colour; neutral stays neutral', () => {
  const night = nightAura(derivePalette('#2F7BEA').aura);
  assert.equal(night.length, 4);
  assert.deepEqual(night, nightAura(derivePalette('#2F7BEA').aura), 'deterministic');
  assert.notDeepEqual(night, derivePalette('#2F7BEA').aura);
  assert.deepEqual(nightAura(['#E9E2F2', '#F2EEE9', '#DCD6E6', '#141414']), [
    '#3A3450',
    '#2A2638',
    '#4A4060',
    '#F5F3F7',
  ]);
  const people = providerPeople(available());
  assert.deepEqual(people.find((p) => p.characterId === 'jojo')!.card.night, [
    '#2F6BFF',
    '#23D5C4',
    '#6A3DFF',
    '#5AA2FF',
  ]);
});

// ---- 5. the shared voice card ------------------------------------------------------------------------------------------------

const shared: SharedCardData = {
  name: '陈吉米',
  latin: 'chen jimi',
  no: '0412',
  quote: '别熬了，游戏明天还在。',
  durationMs: 11_000,
  time: 'UTC+8 22:41',
  date: '2026.10.12',
  aura: ['#DCD2FF', '#FFD8EE', '#BBA4FF', '#7C4DEB'],
  night: ['#8B5CFF', '#FF4FB8', '#4B2BC9', '#B18CFF'],
};

test('the shared card says 收到一张语音小卡 and 来聊几句嘛～, names only the character, and has no nickname or id of the sender', (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  // Even if a host handed over more than the type allows, nothing but the known fields is ever drawn.
  const leaky = { ...shared, nickname: '小林', playerNumber: 'FT7S1112', senderId: 'player-123', email: 'l@x.com' };
  const page = renderSharedCard(root, leaky as SharedCardData, { play: () => {} }) as unknown as FakeElement;
  const text = page.textContent;
  assert.match(text, /收到一张语音小卡/);
  assert.match(text, /来聊几句嘛～/);
  assert.match(text, /也和陈吉米聊聊/);
  assert.match(text, /VOICE CARD/);
  assert.match(text, /No\.0412/);
  assert.match(text, /0:11/);
  for (const secret of ['小林', 'FT7S1112', 'player-123', 'l@x.com', 'nickname'])
    assert.equal(text.includes(secret), false, `no ${secret}`);
  assert.equal(page.querySelector('.shared-sticker')!.textContent, '收到一张语音小卡');
  assert.equal(page.querySelector('.shared-hint')!.textContent, '来聊几句嘛～');
  assert.equal(page.querySelector('.shared-cta')!.getAttribute('href'), '/');
  assert.equal(page.querySelector('.shared-play')!.getAttribute('aria-label'), '播放陈吉米的语音');
  // Colours arrive as custom properties of the page, day and night.
  assert.equal(page.style.getPropertyValue('--aura-3'), '#BBA4FF');
  assert.equal(page.style.getPropertyValue('--n-accent'), '#B18CFF');
  // Without a way to play, the pill is shown but cannot be pressed.
  const quiet = renderSharedCard(root, shared) as unknown as FakeElement;
  assert.equal(quiet.querySelector('.shared-play')!.disabled, true);
});

// ---- 6. sheets: motion -------------------------------------------------------------------------------------------------------

test('the account sheets and 我的信息 slide up like the model and 共创 sheets, with one small settle, and stand still when motion is reduced', () => {
  const keyframes =
    /@keyframes bb-sheet \{\s*from \{\s*transform: translateY\(100%\) rotate\(1deg\);\s*\}[\s\S]*?to \{\s*transform: none;/.exec(
      bare,
    );
  assert.ok(keyframes, 'a slide from the bottom with a 1° settle');
  const motion = rule('.acct-sheet:not(.mp-sheet),\n.mi-sheet');
  assert.match(motion, /animation: bb-sheet 360ms var\(--bb-ease\) backwards/);
  assert.match(motion, /transform-origin: 50% 100%/);
  // Not the old fade-and-rise, and (backwards, never both) no stacking context left over the ⋯ menu.
  assert.doesNotMatch(motion, /bb-rise|both/);
  // The model sheet's panel and the 共创 sheet already slide up; the account sheets now match them.
  assert.match(css, /\.mp-panel \{[^}]*animation: bb-up 420ms/);
  assert.match(css, /\.cc-sheet \{[^}]*animation: bb-up 420ms/);
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reduced, /\.acct-sheet:not\(\.mp-sheet\),/);
  assert.match(reduced, /animation: none/);
  // The 外观 sheet uses the model sheet's frame, so it slides up too.
  assert.match(css, /\.mp-sheet \{[^}]*animation: bb-fade 300ms/);
});

// ---- 25b fix round ---------------------------------------------------------------------------------------------------------------

test('Escape in the model sheet closes the sheet only: the keydown stops there and never reaches the chat behind it', (t) => {
  const doc = installFakeDom(t);
  const handle = openModelPicker({
    info: {
      models: [{ id: 'deepseek', points: 10, voicePoints: 2 }],
      selected: 'deepseek',
      metered: true,
      balance: 100,
      repliesLeft: 10,
      version: 1,
    },
    characterName: '瓜瓜',
    api: {
      setModel: async () => {
        throw new Error('not used');
      },
    },
    onChanged() {},
    mount: doc.body as never,
  });
  assert.ok(doc.body.querySelector('.mp-sheet'));
  let stopped = false;
  doc.fire('keydown', { key: 'Escape', stopPropagation: () => void (stopped = true) });
  assert.equal(stopped, true, 'the chat’s own Escape handler is never reached');
  assert.equal(doc.body.querySelector('.mp-sheet'), null);
  void handle;
});

test('the one-time ⋯ guide hangs under the header while the chat’s first line waits below it, and gives the room back when dismissed', (t) => {
  const doc = installFakeDom(t);
  t.after(() => void 0);
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) },
  });
  t.after(() => Reflect.deleteProperty(globalThis, 'localStorage'));
  const head = doc.createElement('div');
  const more = doc.createElement('button');
  head.append(more);
  const guide = mountChatGuide(more as never, head as never, () => '点这里可以和角色一起共创');
  guide.show();
  assert.ok(guide.isShown());
  assert.ok(head.classList.contains('has-guide'));
  guide.dismiss();
  assert.equal(head.classList.contains('has-guide'), false);
  assert.equal(store.get(GUIDE_KEY), '1');
  assert.match(rule('.page-shell .card-slot.is-chat .chat-head.has-guide ~ .chat-body'), /padding-top: 84px/);
});

// ---- 25b + 24c ---------------------------------------------------------------------------------------------------------------

test('共创奖励 rows read as income: the green + icon and the green amount of 每日补充 and 管理员发放, in day and night', () => {
  for (const kind of ['cocreation_note', 'cocreation_adopted']) {
    assert.ok(css.includes(`.bl-row.is-${kind}::before`), `${kind}: icon`);
    assert.ok(css.includes(`.bl-row.is-${kind} .bl-points`), `${kind}: amount`);
    assert.ok(css.includes(`:root[data-theme="dark"] .bl-row.is-${kind}::before`), `${kind}: night icon`);
    assert.ok(css.includes(`:root[data-theme="dark"] .bl-row.is-${kind} .bl-points`), `${kind}: night amount`);
  }
});

test('获得点数 is a small bottom sheet in the model sheet’s frame, sized to its content, in the soft colours; Escape closes only it', (t) => {
  const doc = installFakeDom(t);
  const sheet = openEarnSheet({
    api: { cocreationRewards: async () => ({ notePoints: 5, dailyCap: 15, adoptPoints: 20 }) },
    openCocreation() {},
    mount: doc.body as never,
  }).element as unknown as FakeElement;
  assert.ok(sheet.classList.contains('mp-sheet') && sheet.classList.contains('earn-sheet'));
  assert.ok(
    sheet.querySelector('.mp-panel .earn-line') && sheet.querySelector('.mp-panel .earn-go'),
    'the panel holds the one line and the button',
  );
  assert.match(rule('.mi-small.mi-earn'), /background: #a9cdfb/);
  assert.match(
    rule(':root[data-theme="dark"] .mi-small.mi-earn,\n:root[data-theme="dark"] .earn-sheet .earn-go'),
    /background: #5aa2ff/,
  );
  // Not full screen: the model sheet's panel is as tall as its content, never a full-height form.
  assert.match(css, /\.mp-panel \{[^}]*max-height: 100%/);
  assert.doesNotMatch(rule('.earn-sheet .mp-panel'), /height/);
  let stopped = false;
  doc.fire('keydown', { key: 'Escape', stopPropagation: () => void (stopped = true) });
  assert.equal(stopped, true);
  assert.equal(doc.body.querySelector('.earn-sheet'), null);
});
