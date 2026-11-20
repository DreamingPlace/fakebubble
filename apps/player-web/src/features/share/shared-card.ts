/**
 * Part 25b / Part 45: the page a person lands on when someone shares a character's voice message with them. It is the character's
 * latest 小卡 (the home card: avatar, name, Latin name, the number, the colours and the play bar) under a taped sticker
 * 收到一张语音小卡, with one way in: 也和{角色}聊聊.
 *
 * The sender is private. The data this page takes has no field for a nickname, a player number, an id or an email of the person who
 * shared, so there is nowhere for one to leak from; the only names on the page are the character's. There is no text line on the
 * card, only the voice. An unknown or expired link shows the same neutral card with 链接已过期 and 也来聊聊 (no name: the page cannot
 * say whose card it was without saying that it once existed).
 */
import type { WebProviderCharacter } from '../../../../../packages/contracts/web-provider.ts';
import { wordmarkSvg } from '../brand/wordmark.ts';
import { birthdayNo } from '../brand/palette-skin.ts';
import { cardFace } from '../prototype/card-face.ts';
import { styleCard } from '../prototype/card-style.ts';
import { providerPeople, type Person } from '../prototype/provider-catalog-view.ts';
import { nightAura } from '../brand/character-colour.ts';

export const sharedCopy = {
  received: '收到一张语音小卡',
  chat: (name: string) => `也和${name}聊聊`,
  hint: '来聊几句嘛～',
  expired: '链接已过期',
  chatAny: '也来聊聊',
  play: (name: string) => `播放${name}的语音`,
};

/** What the public share route answers: the character's published card fields and the voice. No field names the sharer. */
export interface PublicShareAnswer {
  characterId: string;
  displayName: string;
  portraitUrl: string | null;
  mainColor: string | null;
  palette: { hex: string; role: 'main' | 'accent' }[] | null;
  birthDate: string | null;
  noRank: number;
  durationMs: number | null;
  voiceUrl: string;
}

/** The card's data: the character's name, number, colours and picture, and the voice's length. Nothing about who shared it. */
export interface SharedCardData {
  person: Person;
  durationMs: number | null;
}
export interface SharedCardOptions {
  /** Plays the card's voice; without it the pill is shown but cannot be pressed. */
  play?: () => void;
  /** Where 也和…聊聊 goes: the site's own home. */
  chatHref?: string;
}

/** The player page's own rules turn the published fields into the card (colours, skin, number, picture). */
export function sharedCardData(answer: PublicShareAnswer): SharedCardData {
  const character: WebProviderCharacter = {
    characterId: answer.characterId as WebProviderCharacter['characterId'],
    displayName: answer.displayName,
    publicDescription: '',
    portraitUrl: answer.portraitUrl,
    theme: null,
    mainColor: answer.mainColor,
    palette: answer.palette,
    birthDate: answer.birthDate,
    availability: { state: 'available', personaVersion: 0 },
    welcome: {
      text: '',
      version: '',
      audio: {
        state: 'available',
        mediaId: '',
        url: '',
        version: '',
        sha256: '',
        durationMs: answer.durationMs ?? 1,
      },
    },
  };
  const [person] = providerPeople({
    characters: [character],
    slots: [{ kind: 'character', characterId: character.characterId }],
  });
  if (!person) throw new Error('SHARE_CARD_INVALID');
  // The number: the birthday's month + day, else the character's place among the catalog's characters (the server counted it).
  person.card = { ...person.card, no: birthdayNo(answer.birthDate) ?? String(answer.noRank).padStart(3, '0') };
  person.welcomeMs = answer.durationMs;
  // The card carries no text of the message (and no welcome words): only the voice.
  delete person.transcript;
  return { person, durationMs: answer.durationMs };
}

const NEUTRAL = ['#E9E2F2', '#F2EEE9', '#DCD6E6', '#141414'] as const;
const neutralPerson = (): Person => ({
  id: 'character-neutral',
  name: '',
  mark: '',
  color: '#CFD7D2',
  ink: '#596962',
  card: { no: '', latin: null, aura: NEUTRAL, night: nightAura(NEUTRAL), nameSize: 0 },
});

function shell(person: Person, className: string) {
  const page = document.createElement('div');
  page.className = `page-shell share-page ${className}`;
  page.dataset.phase = 'browse';
  page.innerHTML = `<div class="aura-stack" aria-hidden="true"><div class="aura-set aura-day"></div><div class="aura-set aura-night"></div></div>
    <header class="site-head"><div class="brand">${wordmarkSvg({ size: 34, weight: 2, className: 'hand brand-hand' })}</div></header>
    <main class="main-area"><div class="carousel"><div class="card-deck"></div></div></main>`;
  // the page's colours are set through the CSSOM (the page's content-security policy forbids style attributes)
  for (const [selector, colours] of [
    ['.aura-day', person.card.aura],
    ['.aura-night', person.card.night],
  ] as const) {
    const layer = document.createElement('div');
    layer.className = 'aura';
    layer.style.setProperty('--aura-1', colours[0]);
    layer.style.setProperty('--aura-2', colours[1]);
    layer.style.setProperty('--aura-3', colours[2]);
    layer.style.setProperty('opacity', '1');
    page.querySelector(selector)!.append(layer);
  }
  return page;
}

function slot(person: Person, face: string) {
  const card = document.createElement('article');
  card.className = 'card-slot is-active';
  card.dataset.side = 'c';
  card.innerHTML = `<div class="card-shell">${face}</div>`;
  return card;
}

function actions(label: string, hint: string | null, href: string) {
  const bar = document.createElement('footer');
  bar.className = 'share-actions';
  const cta = document.createElement('a');
  cta.className = 'share-cta';
  cta.href = href;
  cta.textContent = label;
  bar.append(cta);
  if (hint) {
    const note = document.createElement('span');
    note.className = 'share-hint';
    note.textContent = hint;
    bar.append(note);
  }
  return bar;
}

function sticker(text: string) {
  const tape = document.createElement('p');
  tape.className = 'share-sticker';
  tape.textContent = text;
  return tape;
}

export function renderSharedCard(root: HTMLElement, data: SharedCardData, options: SharedCardOptions = {}) {
  const { person } = data;
  const page = shell(person, 'is-card');
  const card = slot(person, cardFace(person, true));
  card.setAttribute('aria-label', person.name);
  styleCard(card, person, true, { chat: false });
  page.querySelector('.card-deck')!.append(card);
  const play = card.querySelector<HTMLButtonElement>('.face-voice')!;
  play.setAttribute('aria-label', sharedCopy.play(person.name));
  if (options.play) play.addEventListener('click', options.play);
  else play.disabled = true;
  card.append(sticker(sharedCopy.received));
  page.append(actions(sharedCopy.chat(person.name), sharedCopy.hint, options.chatHref ?? '/'));
  root.replaceChildren(page);
  return page;
}

/**
 * The page of a link that does not open (unknown, expired, or its message is gone: nothing says which). A neutral card that fades
 * in dull, 链接已过期 where the sticker was, and 也来聊聊. `animate: false` draws it already settled.
 */
export function renderSharedExpired(root: HTMLElement, options: { chatHref?: string } = {}) {
  const person = neutralPerson();
  const page = shell(person, 'is-expired');
  const card = slot(person, '<div class="card-face share-blank"><i class="face-sheen" aria-hidden="true"></i></div>');
  card.setAttribute('aria-label', sharedCopy.expired);
  page.querySelector('.card-deck')!.append(card);
  const tape = sticker(sharedCopy.expired);
  tape.setAttribute('role', 'status');
  card.append(tape);
  page.append(actions(sharedCopy.chatAny, null, options.chatHref ?? '/'));
  root.replaceChildren(page);
  return page;
}

/** A page that is showing a card turns into the expired page in place: the card dulls, its words fade, the sticker changes. */
export function expireSharedCard(page: HTMLElement) {
  page.classList.add('is-expired');
  const tape = page.querySelector('.share-sticker');
  if (tape) {
    tape.textContent = sharedCopy.expired;
    tape.setAttribute('role', 'status');
  }
  const cta = page.querySelector('.share-cta');
  if (cta) cta.textContent = sharedCopy.chatAny;
  page.querySelector('.share-hint')?.remove();
}
