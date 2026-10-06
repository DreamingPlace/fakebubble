import type { WebProviderBootstrap } from '../../../../../packages/contracts/web-provider.ts';

export type Person = {
  id: string;
  name: string;
  mark: string;
  color: string;
  ink: string;
  transcript?: string;
  characterId?: string;
};
const palettes: Record<string, { color: string; ink: string; mark: string }> = {
  'wei-guagua': { color: '#D7C8B9', ink: '#614C3C', mark: '瓜' },
  jojo: { color: '#C7D1D3', ink: '#405C61', mark: 'J' },
  'chen-jimi': { color: '#C8C6D7', ink: '#535271', mark: '吉' },
};
export function providerPeople(view: Pick<WebProviderBootstrap, 'characters' | 'slots'>): Person[] {
  const byId = new Map(view.characters.map((character) => [character.characterId, character]));
  const slots = view.slots.map((slot, index): Person => {
    if (slot.kind === 'preview')
      return { id: slot.slotId, name: slot.label, mark: '', color: '#CFD7D2', ink: '#596962' };
    const character = byId.get(slot.characterId);
    if (!character) throw Error('WEB_PROVIDER_PROTOCOL_INVALID');
    const palette = Object.hasOwn(palettes, character.characterId)
      ? palettes[character.characterId]!
      : { color: '#CFD7D2', ink: '#344A43', mark: [...character.displayName][0] ?? '' };
    return {
      id: `character-${character.characterId}`,
      characterId: character.characterId,
      name: character.displayName,
      mark: palette.mark,
      color: palette.color,
      ink: palette.ink,
      ...(character.availability.state === 'available' ? { transcript: character.welcome.text ?? '' } : {}),
    };
  });
  // Preserve the approved centred three-person orbit without baking identities into the shell.
  const padding = Math.floor((15 - view.characters.length) / 2);
  return padding ? [...slots.slice(-padding), ...slots.slice(0, -padding)] : slots;
}
export const escapeCardText = (text: string) =>
  text.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
