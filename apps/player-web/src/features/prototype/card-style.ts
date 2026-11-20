import { characterFrame, setFrameProperties } from '../brand/avatar-frame.ts';
import { mountPortrait } from '../brand/portrait.ts';
import { mountShapes, setSkinProperties } from '../brand/palette-render.ts';
import { watchCardName } from './card-name.ts';
import type { Person } from './provider-catalog-view.ts';

/**
 * A 小卡's colours on its `.card-slot`: the aura (day and night), the frame, the name size, the avatar picture, and (Part 24k-2) the
 * 主色 + 点缀 with the soft shapes behind the card (and behind the chat unless `chat: false`). Shared by the home card and Part 45's
 * shared card, so the two can never drift apart.
 */
export function styleCard(card: HTMLElement, person: Person, configured: boolean, options: { chat?: boolean } = {}) {
  const [aura1, aura2, aura3, accent] = person.card.aura;
  card.style.setProperty('--aura-1', aura1);
  card.style.setProperty('--aura-2', aura2);
  card.style.setProperty('--aura-3', aura3);
  card.style.setProperty('--accent', accent);
  // Part 25b: the same aura at night, and the avatar frame every avatar of this character wears (from its colour).
  const [night1, night2, night3, nightAccent] = person.card.night;
  card.style.setProperty('--n-aura-1', night1);
  card.style.setProperty('--n-aura-2', night2);
  card.style.setProperty('--n-aura-3', night3);
  card.style.setProperty('--n-accent', nightAccent);
  setFrameProperties(card, characterFrame(person.card.aura), 'frame');
  card.style.setProperty('--name-size', String(person.card.nameSize));
  card.style.setProperty('--avatar-bg', person.color);
  card.style.setProperty('--avatar-ink', person.ink);
  card.style.setProperty('--card-color', person.color);
  card.classList.toggle('is-reserve', !configured);
  // Part 31b: the picture over the initials in the welcome row and the card's face.
  if (person.portrait) {
    const welcomeAvatar = card.querySelector<HTMLElement>('.welcome-row .message-avatar');
    if (welcomeAvatar) mountPortrait(welcomeAvatar, person.portrait);
    const face = card.querySelector<HTMLElement>('.face-portrait');
    if (face) mountPortrait(face, person.portrait, { eager: true });
  }
  // Part 24k-2: 主色 + 点缀 — the colours, and the soft shapes behind the home card and behind the chat.
  if (person.skin && person.characterId && configured) {
    setSkinProperties(card, person.skin);
    // --accent / --n-accent feed the play button, the playing state and the status dot already; the main takes them over.
    card.style.setProperty('--accent', person.skin.day.main);
    card.style.setProperty('--n-accent', person.skin.night.main);
    // the avatar ring takes the accents (a segment each) and the glow
    setFrameProperties(
      card,
      {
        ring: [person.skin.day.accents[0], person.skin.day.accents[1], person.skin.day.glow],
        fill: [person.skin.day.accents[1], person.skin.day.glow],
      },
      'frame',
    );
    if (options.chat !== false)
      mountShapes(card.querySelector<HTMLElement>('.card-shell')!, person.characterId, 'chat');
    mountShapes(card.querySelector<HTMLElement>('.card-face')!, person.characterId, 'card');
  }
  // Part 44: the name is fitted to the card's width, on the home card and on Part 45's shared card alike.
  if (configured) watchCardName(card);
}
