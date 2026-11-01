/**
 * One colour per character, the same on every console page (Part 24b-4): the character's main colour or a stable mapping of its id (never its place in the roster), so
 * 角色工作台, 共创收件箱 and 关系与故事 show the same dot for the same person. Fifteen colours, because a roster is at most fifteen.
 */
export const ROSTER_COLOURS = [
  '#E8561E',
  '#2F7BEA',
  '#7C4DEB',
  '#1E8E4E',
  '#D98A00',
  '#C2410C',
  '#0E7490',
  '#9D174D',
  '#4D7C0F',
  '#BE185D',
  '#1D4ED8',
  '#A16207',
  '#047857',
  '#6D28D9',
  '#B45309',
] as const;
/** Someone who is not a chat character (a 人物 of the cast): one quiet grey. */
export const PERSON_COLOUR = '#8C8697';

const MAIN = new Map<string, string>();
/** A character's 主色 (presentation.color), once its profile has been read; '' or an invalid value clears it. */
export const setMainColour = (characterId: string, color: string | undefined | null) => {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) MAIN.set(characterId, color);
  else MAIN.delete(characterId);
};
const NAMES = new Map<string, string>();
/** The overview's pie and bars know a character by display name only; this maps it back to the colour of its id. */
export const rememberName = (characterId: string, displayName: string) => void NAMES.set(displayName, characterId);
export const colourOfName = (displayName: string): string | null => {
  const id = NAMES.get(displayName);
  return id === undefined ? null : characterColour(id);
};
const hashOf = (text: string) => {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619) >>> 0;
  return hash;
};
/**
 * Part 24b-6, round 3: a character's colour never depends on who else is in the roster. Its 主色 when it has one, otherwise a stable
 * mapping of its id into the palette, so deleting or adding a character leaves every other dot where it was, on every page.
 */
export const characterColour = (characterId: string): string =>
  MAIN.get(characterId) ?? ROSTER_COLOURS[hashOf(characterId) % ROSTER_COLOURS.length]!;

export const rosterColours = (ids: Iterable<string>): ((id: string) => string) => {
  const known = new Set(ids);
  return (id) => (known.has(id) ? characterColour(id) : PERSON_COLOUR);
};
/** Reads each role's profile once, quietly, so every page can show the 主色 (a convenience: a failed read keeps the id colour). */
export async function warmMainColours(
  detail: (id: string) => Promise<{
    published: { profile: { presentation: { color?: string } } } | null;
    draft: { profile: { presentation: { color?: string } } } | null;
  }>,
  ids: readonly string[],
): Promise<boolean> {
  let changed = false;
  await Promise.all(
    ids.map(async (id) => {
      try {
        const d = await detail(id);
        const before = MAIN.get(id);
        setMainColour(id, (d.published ?? d.draft)?.profile.presentation.color);
        changed ||= before !== MAIN.get(id);
      } catch {
        /* keep the id colour */
      }
    }),
  );
  return changed;
}
