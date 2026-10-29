/**
 * Part 25b: the page a person lands on when someone shares a voice 小卡 with them (design/burbur-v2 Shared board): a taped
 * sticker 收到一张语音小卡, the photocard with one line and its play pill, and one way in - 也和{角色}聊聊.
 *
 * The sender is private. The data this page takes has no field for a nickname, a player number or any id of the person who shared,
 * so there is nowhere for one to leak from; the only names on the page are the character's. The host (the share link, Part 23) decides
 * where the data comes from and what playing does; this file only lays it out.
 */
import type { Aura } from '../brand/character-colour.ts';
import { handElement } from '../brand/wordmark.ts';
import { h } from '../cocreation/h.ts';
import { formatDuration } from '../prototype/voice-pill.ts';

export const sharedCopy = {
  received: '收到一张语音小卡',
  what: '这是什么？',
  chat: (name: string) => `也和${name}聊聊`,
  hint: '来聊几句嘛～',
  play: (name: string) => `播放${name}的语音`,
};

export interface SharedCardData {
  /** The character's name and (when it has one) the hand-lettered Latin name. */
  name: string;
  latin: string | null;
  /** The serial number printed on the card, like 0412. */
  no: string;
  /** The one line on the card. */
  quote: string;
  durationMs: number | null;
  /** 'UTC+8 22:41' and '2026.10.12'. */
  time: string;
  date: string;
  aura: Aura;
  night: Aura;
}
export interface SharedCardOptions {
  /** Plays the card's voice; without it the pill is shown but cannot be pressed. */
  play?: () => void;
  /** Where 也和…聊聊 goes: the site's own home. */
  chatHref?: string;
}

const BARS = [8, 12, 18, 22, 14, 10, 20, 22, 16, 12, 20, 14, 8, 18, 22, 16, 10, 14, 22, 18, 12, 16, 8, 20, 12, 18];

export function renderSharedCard(root: HTMLElement, data: SharedCardData, options: SharedCardOptions = {}) {
  const wave = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  wave.setAttribute('class', 'shared-wave');
  wave.setAttribute('viewBox', '0 0 106 24');
  wave.setAttribute('preserveAspectRatio', 'none');
  wave.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', BARS.map((bar, i) => `M${2 + i * 4} ${12 - bar / 2}v${bar}`).join(''));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('vector-effect', 'non-scaling-stroke');
  wave.append(path);

  const triangle = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  triangle.setAttribute('viewBox', '0 0 24 24');
  triangle.setAttribute('fill', 'currentColor');
  const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  arrow.setAttribute('d', 'M8 5v14l11-7z');
  triangle.append(arrow);
  const play = h(
    'button',
    { class: 'shared-play', attrs: { type: 'button', 'aria-label': sharedCopy.play(data.name) } },
    h('span', { class: 'shared-play-dot', attrs: { 'aria-hidden': 'true' } }, triangle),
    wave,
    data.durationMs ? h('span', { class: 'shared-dur', text: formatDuration(data.durationMs) }) : null,
  );
  if (options.play) play.addEventListener('click', options.play);
  else play.disabled = true;

  const page = h(
    'div',
    { class: 'shared-page' },
    h(
      'header',
      { class: 'shared-head' },
      handElement('burbur', { size: 34, weight: 2, label: 'Burbur', className: 'hand shared-hand' }),
      h('a', { class: 'shared-what', text: sharedCopy.what, attrs: { href: '/' } }),
    ),
    h(
      'main',
      { class: 'shared-main' },
      h('p', { class: 'shared-sticker', text: sharedCopy.received }),
      h(
        'article',
        { class: 'shared-card', attrs: { 'aria-label': data.name } },
        h(
          'div',
          { class: 'shared-face' },
          h('div', { class: 'shared-top' }, h('span', { text: 'VOICE CARD' }), h('span', { text: `No.${data.no}` })),
          h(
            'div',
            { class: 'shared-who' },
            h('span', { class: 'shared-name', text: data.name }),
            data.latin
              ? handElement(data.latin, { size: 44, weight: 1.9, label: null, className: 'hand shared-latin' })
              : null,
          ),
          h('p', { class: 'shared-quote', text: `“${data.quote}”` }),
          play,
          h('div', { class: 'shared-foot' }, h('span', { text: data.time }), h('span', { text: data.date })),
        ),
      ),
    ),
    h(
      'footer',
      { class: 'shared-actions' },
      h('a', { class: 'shared-cta', text: sharedCopy.chat(data.name), attrs: { href: options.chatHref ?? '/' } }),
      h('span', { class: 'shared-hint', text: sharedCopy.hint }),
    ),
  );
  data.aura.forEach((colour, i) => page.style.setProperty(i === 3 ? '--accent' : `--aura-${i + 1}`, colour));
  data.night.forEach((colour, i) => page.style.setProperty(i === 3 ? '--n-accent' : `--n-aura-${i + 1}`, colour));
  root.replaceChildren(page);
  return page;
}
