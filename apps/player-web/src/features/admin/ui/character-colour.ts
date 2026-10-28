/**
 * One colour per character, the same on every console page (Part 24b-4): the character's place among the roster sorted by id, so
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

export const rosterColours = (ids: Iterable<string>): ((id: string) => string) => {
  const order = [...new Set(ids)].sort();
  return (id) => {
    const at = order.indexOf(id);
    return at < 0 ? PERSON_COLOUR : ROSTER_COLOURS[at % ROSTER_COLOURS.length]!;
  };
};
