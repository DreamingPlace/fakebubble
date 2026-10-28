/**
 * Part 25b: 外观 - the chat's background colour (a few soft presets, or any colour) and the frame of the player's own avatar.
 * The sheet opens from the chat's ⋯ menu and slides up like the model and 共创 sheets. A choice is applied as you tap it and kept
 * (PlayerPrefs): the background per character, the frame for the player. All styling goes through custom properties on the card.
 */
import { setFrameProperties, playerFrame, PLAYER_FRAMES } from '../brand/avatar-frame.ts';
import { contrastRatio, parseColour } from '../brand/character-colour.ts';
import { h } from '../cocreation/h.ts';
import { CHAT_BACKGROUNDS, type ChatBackground, type PlayerPrefs } from '../prefs/player-prefs.ts';

export const lookCopy = {
  title: '外观',
  background: '背景',
  frame: '头像框',
  none: '默认',
  custom: '自定义颜色',
  close: '关闭',
  me: '我',
};

/** A custom colour is dark when black text on it would read worse than white: the chat then wears its night bubbles. */
const isDark = (color: string) => contrastRatio(color, '#141414') < contrastRatio(color, '#FFFFFF');

/**
 * Paints the chat of one card with the player's colour, or (null) with the character's own aura. The card carries the colour as
 * --chat-tint-day / --chat-tint-night; a custom colour is the same in both and also says whether it is a dark one (data-tone), so
 * the bubbles and the words on it stay readable whatever the player picks.
 */
export function applyChatBackground(card: HTMLElement, background: ChatBackground | null) {
  const preset = background?.kind === 'preset' ? CHAT_BACKGROUNDS.find((p) => p.id === background.id) : undefined;
  const custom = background?.kind === 'custom' ? parseColour(background.color) : null;
  const day = preset?.day ?? custom ?? '';
  const night = preset?.night ?? custom ?? '';
  card.style.setProperty('--chat-tint-day', day);
  card.style.setProperty('--chat-tint-night', night);
  card.classList.toggle('has-chat-bg', day !== '');
  if (custom) card.setAttribute('data-tone', isDark(custom) ? 'dark' : 'light');
  else card.removeAttribute('data-tone');
}

export interface LookOptions {
  characterId: string;
  prefs: PlayerPrefs;
  /** The chat card: its background is what the first row changes. */
  card: HTMLElement;
  /** Where the player's own frame lives (custom properties): the page. */
  frameHost: HTMLElement;
  mount?: HTMLElement;
}

export function openLookSheet(options: LookOptions) {
  const { prefs, card, frameHost, characterId } = options;
  const opener = document.activeElement as HTMLElement | null;
  const title = h('strong', { class: 'acct-title mp-title', attrs: { id: 'look-title' }, text: lookCopy.title });
  const closeButton = h('button', {
    class: 'acct-close icon-button',
    attrs: { type: 'button', 'aria-label': lookCopy.close },
    text: '×',
  });

  const swatch = (label: string, day: string, night: string, extra = '') => {
    const button = h('button', {
      class: `look-swatch${extra}`,
      attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': label },
    });
    if (day) button.style.setProperty('--swatch-day', day);
    if (night) button.style.setProperty('--swatch-night', night);
    return button;
  };
  const backgrounds = [
    { key: 'default', button: swatch(lookCopy.none, '', '', ' look-default') },
    ...CHAT_BACKGROUNDS.map((p) => ({ key: p.id, button: swatch(p.label, p.day, p.night) })),
  ];
  const picker = h('input', {
    class: 'look-color',
    attrs: { type: 'color', 'aria-label': lookCopy.custom, value: '#FFE6DA' },
  });
  const customWrap = h('label', { class: 'look-swatch look-custom', attrs: { 'data-key': 'custom' } }, picker);
  const frames = PLAYER_FRAMES.map((frame) => {
    const button = h(
      'button',
      {
        class: 'look-frame',
        attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', 'aria-label': frame.label },
      },
      h('span', { class: 'avatar look-frame-demo', attrs: { 'aria-hidden': 'true' }, text: lookCopy.me }),
    );
    setFrameProperties(button, playerFrame(frame.id), 'own');
    return { id: frame.id, button };
  });

  const mark = () => {
    const bg = prefs.chatBackground(characterId);
    const key = bg === null ? 'default' : bg.kind === 'preset' ? bg.id : 'custom';
    for (const entry of backgrounds) {
      const on = entry.key === key;
      entry.button.setAttribute('aria-checked', String(on));
      entry.button.classList.toggle('is-on', on);
    }
    customWrap.classList.toggle('is-on', key === 'custom');
    if (bg?.kind === 'custom') {
      customWrap.style.setProperty('--swatch-day', bg.color);
      customWrap.style.setProperty('--swatch-night', bg.color);
    }
    for (const entry of frames) {
      const on = entry.id === prefs.frame;
      entry.button.setAttribute('aria-checked', String(on));
      entry.button.classList.toggle('is-on', on);
    }
  };
  const choose = (bg: ChatBackground | null) => {
    prefs.setChatBackground(characterId, bg);
    applyChatBackground(card, prefs.chatBackground(characterId));
    mark();
  };
  backgrounds.forEach((entry, i) =>
    entry.button.addEventListener('click', () =>
      choose(i === 0 ? null : { kind: 'preset', id: CHAT_BACKGROUNDS[i - 1]!.id }),
    ),
  );
  picker.addEventListener('input', () => {
    const color = parseColour(picker.value);
    if (color) choose({ kind: 'custom', color });
  });
  for (const entry of frames)
    entry.button.addEventListener('click', () => {
      prefs.setFrame(entry.id);
      setFrameProperties(frameHost, playerFrame(entry.id), 'own');
      mark();
    });

  const row = (label: string, group: string, ...items: HTMLElement[]) =>
    h(
      'section',
      { class: 'look-section' },
      h('h3', { class: 'look-label', text: label }),
      h('div', { class: 'look-row', attrs: { role: 'radiogroup', 'aria-label': group } }, ...items),
    );
  const sheet = h(
    'div',
    {
      class: 'acct-sheet mp-sheet look-sheet',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'look-title' },
    },
    h(
      'div',
      { class: 'mp-panel' },
      h('span', { class: 'mp-grip', attrs: { 'aria-hidden': 'true' } }),
      h('header', { class: 'acct-head' }, title, closeButton),
      row(lookCopy.background, lookCopy.background, ...backgrounds.map((e) => e.button), customWrap),
      row(lookCopy.frame, lookCopy.frame, ...frames.map((e) => e.button)),
    ),
  );
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    sheet.remove();
    document.removeEventListener?.('keydown', onKey, true);
    opener?.focus?.();
  };
  function onKey(event: Event) {
    if ((event as KeyboardEvent).key === 'Escape') {
      // Escape closes the sheet, not the chat behind it.
      event.stopPropagation?.();
      close();
    }
  }
  sheet.addEventListener('click', (event) => {
    if (event.target === sheet) close();
  });
  closeButton.addEventListener('click', close);
  document.addEventListener?.('keydown', onKey, true);
  mark();
  (options.mount ?? document.body).append(sheet);
  backgrounds.find((entry) => entry.button.classList.contains('is-on'))?.button.focus?.();
  return { close, element: sheet };
}
