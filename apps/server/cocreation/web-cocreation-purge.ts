import type { BusinessStore } from '../platform/store-contract.ts';
export const cocreationTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_submissions'");

/** Part 39's relation tables exist (a runtime step, not a migration). */
const relationsExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_relation_schema'");

/**
 * Part 39: a purged submission takes its members, ratings and relation row with it (so a purged player's ratings leave the statistics),
 * and the text of its 整理 result goes; the 整理 ledger row itself stays (money is never forgotten) and holds no player content.
 */
function purgeRelations(store: Pick<BusinessStore, 'run' | 'get'>, condition: string, args: string[]) {
  if (!relationsExist(store)) return;
  const ids = `SELECT id FROM web_cocreation_submissions WHERE ${condition}`;
  store.run(`UPDATE web_cocreation_tidy_calls SET result_json=NULL WHERE submission_id IN (${ids})`, ...args);
  for (const table of ['web_cocreation_ratings', 'web_cocreation_members', 'web_cocreation_relations'])
    store.run(`DELETE FROM ${table} WHERE submission_id IN (${ids})`, ...args);
}

/** Part 39b's wording tables exist (a runtime step, not a migration). */
const wordingsExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_wording_schema'");

/** Migration 131's pair column exists. */
const pairsExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM pragma_table_info('web_cocreation_submissions') WHERE name='partner_id'");

/**
 * Deletes co-creation submissions (answers first) of one character, of one player, or of one player's idea for one
 * character. Players' ideas are user data: they go with a deleted character and with a purged player.
 */
export function purgeCocreation(
  store: Pick<BusinessStore, 'get' | 'run'>,
  scope: { characterId?: string; principalId?: string },
) {
  if (!cocreationTablesExist(store)) return;
  const where: string[] = [],
    args: string[] = [];
  if (scope.characterId !== undefined) {
    // Part 24c: a pair story is about both of its characters, so it goes with either of them.
    if (pairsExist(store)) {
      where.push(
        relationsExist(store)
          ? '(character_id=? OR partner_id=? OR id IN (SELECT submission_id FROM web_cocreation_members WHERE character_id=?))'
          : '(character_id=? OR partner_id=?)',
      );
      args.push(scope.characterId, scope.characterId);
      if (relationsExist(store)) args.push(scope.characterId);
    } else {
      where.push('character_id=?');
      args.push(scope.characterId);
    }
  }
  if (scope.principalId !== undefined) {
    where.push('principal_id=?');
    args.push(scope.principalId);
  }
  if (where.length === 0) throw new Error('COCREATION_PURGE_SCOPE_REQUIRED');
  const condition = where.join(' AND ');
  purgeRelations(store, condition, args);
  // Part 39b: the wording a player was shown goes with the answer; a deleted character's pool goes with it (the generation ledger holds no text).
  if (wordingsExist(store)) {
    store.run(
      `DELETE FROM web_cocreation_answer_wordings WHERE submission_id IN (SELECT id FROM web_cocreation_submissions WHERE ${condition})`,
      ...args,
    );
    if (scope.characterId !== undefined && scope.principalId === undefined)
      store.run('DELETE FROM web_cocreation_wordings WHERE character_id=?', scope.characterId);
  }
  store.run(
    `DELETE FROM web_cocreation_answers WHERE submission_id IN (SELECT id FROM web_cocreation_submissions WHERE ${condition})`,
    ...args,
  );
  store.run(`DELETE FROM web_cocreation_submissions WHERE ${condition}`, ...args);
}

/** True while any submission of the scope remains: the audits fail closed on it. */
export function cocreationRemains(
  store: Pick<BusinessStore, 'get'>,
  scope: { characterId?: string; principalIds?: string[] },
) {
  if (!cocreationTablesExist(store)) return false;
  if (scope.characterId !== undefined)
    return !!store.get(
      pairsExist(store)
        ? relationsExist(store)
          ? 'SELECT 1 FROM web_cocreation_submissions WHERE character_id=? OR partner_id=? OR id IN (SELECT submission_id FROM web_cocreation_members WHERE character_id=?) LIMIT 1'
          : 'SELECT 1 FROM web_cocreation_submissions WHERE character_id=? OR partner_id=? LIMIT 1'
        : 'SELECT 1 FROM web_cocreation_submissions WHERE character_id=? LIMIT 1',
      ...(pairsExist(store)
        ? relationsExist(store)
          ? [scope.characterId, scope.characterId, scope.characterId]
          : [scope.characterId, scope.characterId]
        : [scope.characterId]),
    );
  const ids = scope.principalIds ?? [];
  if (ids.length === 0) return false;
  return !!store.get(
    `SELECT 1 FROM web_cocreation_submissions WHERE principal_id IN (${ids.map(() => '?').join(',')}) LIMIT 1`,
    ...ids,
  );
}
