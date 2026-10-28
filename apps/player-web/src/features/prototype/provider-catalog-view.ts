import type { WebProviderBootstrap } from '../../../../../packages/contracts/web-provider.ts';
import { derivePalette, nightAura } from '../brand/character-colour.ts';

export type Person = {
  id: string;
  name: string;
  mark: string;
  color: string;
  ink: string;
  transcript?: string;
  characterId?: string;
  /** Part 25a: the 小卡 — serial number, the hand-lettered Latin name and the aura (three cloud colours and the accent). */
  card: {
    no: string;
    latin: string | null;
    aura: readonly [string, string, string, string];
    /** Part 25b: the same aura at night. */
    night: readonly [string, string, string, string];
    nameSize: number;
  };
  /** Part 25b: the welcome voice's length on the card's play pill; null when it has no audio (the pill then shows no time). */
  welcomeMs?: number | null;
};
/** The aura of a slot nobody lives in (design/burbur-v2 Language/Main boards): a neutral cloud and a black accent. */
const NEUTRAL_AURA = ['#E9E2F2', '#F2EEE9', '#DCD6E6', '#141414'] as const;
/** Aura = [cloud 1, cloud 2, cloud 3, accent], from the design's Language board. */
const palettes: Record<
  string,
  {
    color: string;
    ink: string;
    mark: string;
    no: string;
    latin: string;
    aura: readonly [string, string, string, string];
    night: readonly [string, string, string, string];
  }
> = {
  'wei-guagua': {
    color: '#D7C8B9',
    ink: '#614C3C',
    mark: '瓜',
    no: '001',
    latin: 'guagua',
    aura: ['#FFD3B8', '#FFEBC9', '#FFB295', '#E8561E'],
    night: ['#FF6A3D', '#FFB547', '#C2366B', '#FF8A5C'],
  },
  jojo: {
    color: '#C7D1D3',
    ink: '#405C61',
    mark: 'J',
    no: '002',
    latin: 'jojo',
    aura: ['#C6E4FF', '#D5F6EE', '#97C8F5', '#2F7BEA'],
    night: ['#2F6BFF', '#23D5C4', '#6A3DFF', '#5AA2FF'],
  },
  'chen-jimi': {
    color: '#C8C6D7',
    ink: '#535271',
    mark: '吉',
    no: '003',
    latin: 'chen jimi',
    aura: ['#DCD2FF', '#FFD8EE', '#BBA4FF', '#7C4DEB'],
    night: ['#8B5CFF', '#FF4FB8', '#4B2BC9', '#B18CFF'],
  },
};
/**
 * The name's size as a fraction of the card's width: two Chinese characters are the biggest, a longer name shrinks so it stays on
 * one line (a Latin capital is about 0.68 of a Chinese character's width).
 */
function nameSize(name: string) {
  const ems = [...name].reduce((sum, char) => sum + (/[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.68), 0);
  return Math.min(0.36, 0.84 / Math.max(ems, 1));
}
export function providerPeople(view: Pick<WebProviderBootstrap, 'characters' | 'slots'>): Person[] {
  const byId = new Map(view.characters.map((character) => [character.characterId, character]));
  // Characters the palette table does not know are numbered after the three it does, in catalog order.
  let nextNo = 4;
  const slots = view.slots.map((slot, index): Person => {
    if (slot.kind === 'preview')
      return {
        id: slot.slotId,
        name: slot.label,
        mark: '',
        color: '#CFD7D2',
        ink: '#596962',
        card: {
          no: String(index + 1).padStart(3, '0'),
          latin: null,
          aura: NEUTRAL_AURA,
          night: nightAura(NEUTRAL_AURA),
          nameSize: 0,
        },
      };
    const character = byId.get(slot.characterId);
    if (!character) throw Error('WEB_PROVIDER_PROTOCOL_INVALID');
    const known = Object.hasOwn(palettes, character.characterId) ? palettes[character.characterId]! : null;
    const base = known ?? { color: '#CFD7D2', ink: '#344A43', mark: [...character.displayName][0] ?? '' };
    // A published main colour wins; without one the built-in palette (or the neutral one) stays exactly as it was.
    const derived = character.mainColor ? derivePalette(character.mainColor) : null;
    const palette = derived ? { ...base, color: derived.color, ink: derived.ink } : base;
    const latin = known
      ? known.latin
      : /^[A-Za-z][A-Za-z ]{0,23}$/.test(character.displayName)
        ? character.displayName
        : null;
    return {
      id: `character-${character.characterId}`,
      characterId: character.characterId,
      name: character.displayName,
      mark: palette.mark,
      color: palette.color,
      ink: palette.ink,
      card: {
        no: known ? known.no : String(nextNo++).padStart(3, '0'),
        latin,
        aura: derived ? derived.aura : known ? known.aura : NEUTRAL_AURA,
        // A published colour gets a night aura derived from it; otherwise the design's own night colours (or the neutral ones).
        night: derived ? nightAura(derived.aura) : known ? known.night : nightAura(NEUTRAL_AURA),
        nameSize: nameSize(character.displayName),
      },
      ...(character.availability.state === 'available'
        ? {
            transcript: character.welcome.text ?? '',
            welcomeMs: character.welcome.audio.state === 'available' ? character.welcome.audio.durationMs : null,
          }
        : {}),
    };
  });
  // Preserve the approved centred three-person orbit without baking identities into the shell.
  const padding = Math.floor((15 - view.characters.length) / 2);
  return padding ? [...slots.slice(-padding), ...slots.slice(0, -padding)] : slots;
}
export const escapeCardText = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
