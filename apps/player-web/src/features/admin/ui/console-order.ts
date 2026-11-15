/**
 * Part 39: THE console order of characters (首页顺序) for every list of the console that is not an administrator's personal sidebar:
 * the live characters by their place on the home page, then every other character in the order it came. One function, so the
 * co-creation inbox, 玩家眼中的关系, the cast grid and the pickers can never disagree. A list without `homePosition` (an older
 * server) keeps its order.
 */
export function consoleOrder<T extends { homePosition?: number | null }>(list: readonly T[]): T[] {
  const live = list.filter((item) => typeof item.homePosition === 'number');
  const rest = list.filter((item) => typeof item.homePosition !== 'number');
  return [...live.sort((a, b) => a.homePosition! - b.homePosition!), ...rest];
}
