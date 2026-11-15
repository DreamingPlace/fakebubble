/**
 * Part 31b: which card a visitor lands on. A returning visitor lands on the one last viewed (when it is still on the page); a first
 * visit lands on a RANDOM character - the order of the arc only decides who sits next to whom. Cards with no character behind them
 * (the placeholders that fill the ring) are never picked.
 */
export function landingIndex(
  people: readonly { characterId?: string | undefined }[],
  remembered: string | null | undefined,
  fallback: number,
  random: () => number = Math.random,
): { index: number; resumed: boolean } {
  const back = remembered ? people.findIndex((person) => person.characterId === remembered) : -1;
  if (back >= 0) return { index: back, resumed: true };
  const real = people.flatMap((person, index) => (person.characterId === undefined ? [] : [index]));
  if (real.length === 0) return { index: fallback, resumed: false };
  const pick = Math.min(real.length - 1, Math.max(0, Math.floor(random() * real.length)));
  return { index: real[pick]!, resumed: false };
}
