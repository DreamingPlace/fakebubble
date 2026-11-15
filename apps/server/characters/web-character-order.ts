import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 39: THE console order of characters (首页顺序): the live characters in `web_character_catalog.position`, then every other
 * character (offline, draft only) by id. One function for every list that is not an administrator's personal sidebar order: the
 * co-creation inbox, 玩家眼中的关系 and the player's co-creation sheet all read it, so the order never differs between them.
 */
export function consoleCharacterOrder(
  store: Pick<BusinessStore, 'all' | 'get'>,
  others: Iterable<string> = [],
): string[] {
  const live = store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_character_catalog'")
    ? store
        .all<{ character_id: string }>('SELECT character_id FROM web_character_catalog ORDER BY position')
        .map((r) => r.character_id)
    : [];
  const seen = new Set(live);
  const rest = [...new Set(others)].filter((id) => !seen.has(id)).sort();
  return [...live, ...rest];
}

/** Sorts ids by the console order (ids unknown to it go last, by id). */
export function sortByConsoleOrder(order: readonly string[], ids: readonly string[]): string[] {
  const rank = new Map(order.map((id, at) => [id, at] as const));
  return [...ids].sort((a, b) => (rank.get(a) ?? 1e9) - (rank.get(b) ?? 1e9) || (a < b ? -1 : a > b ? 1 : 0));
}
