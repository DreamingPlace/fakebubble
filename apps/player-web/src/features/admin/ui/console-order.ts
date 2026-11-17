/**
 * Part 39: THE console order of characters (首页顺序) for every list of the console that is not an administrator's personal sidebar:
 * the ids the server names (`characters/home-order`: live characters by their place on the home page, then the rest) first, then any
 * character it does not name in the order it came. One function, so the inbox, 玩家眼中的关系 and the cast grid cannot disagree.
 */
export function consoleOrder<T extends { characterId: string }>(list: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((id, at) => [id, at] as const));
  const named = list
    .filter((item) => rank.has(item.characterId))
    .sort((a, b) => rank.get(a.characterId)! - rank.get(b.characterId)!);
  return [...named, ...list.filter((item) => !rank.has(item.characterId))];
}
