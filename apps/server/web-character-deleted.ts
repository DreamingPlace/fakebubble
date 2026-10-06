import type { BusinessStore } from './store-contract.ts';
/** Catalog tombstone metadata only; never a role-wide private content query. */
export function webCharacterDeleted(store: BusinessStore, characterId: string) {
  return (
    !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletions'") &&
    !!store.get('SELECT 1 FROM web_character_deletions WHERE character_id=?', characterId)
  );
}
export function webOperationDeleted(store: BusinessStore, operationId: string) {
  return (
    !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_deletions'") &&
    !!store.get(
      `SELECT 1 FROM web_operations o JOIN web_character_deletions d ON d.character_id=o.character_id WHERE o.id=?`,
      operationId,
    )
  );
}
