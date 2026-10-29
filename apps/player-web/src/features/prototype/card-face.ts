import { handSvg } from '../brand/wordmark.ts';
import { escapeCardText, type Person } from './provider-catalog-view.ts';
import { voicePill } from './voice-pill.ts';

/**
 * Part 25a: the front of the 小卡 — shown while the card is a card, faded out when it becomes the chat.
 * Part 25b: the welcome is a play pill (waveform and length) and a real button; there is no transcript anywhere on the face.
 */
export function cardFace(person: Person, configured: boolean) {
  if (!configured)
    return `<div class="card-face face-reserve" aria-hidden="true">
      <div class="face-top"><span>burbur</span><span>No.${person.card.no}</span></div>
      <div class="face-main face-empty">${handSvg('?', { size: 120, weight: 1.6, label: null, className: 'hand face-question' })}<span class="face-empty-text">新朋友还未到来</span></div>
    </div>`;
  return `<div class="card-face">
      <div class="face-top" aria-hidden="true"><span>burbur</span><span>No.${person.card.no}</span></div>
      <div class="face-main" aria-hidden="true"><span class="face-name">${escapeCardText(person.name)}</span>${
        person.card.latin
          ? handSvg(person.card.latin, { size: 44, weight: 1.9, label: null, className: 'hand face-latin' })
          : ''
      }</div>
      ${voicePill(person.name, person.welcomeMs)}
      <i class="face-sheen" aria-hidden="true"></i>
    </div>`;
}
