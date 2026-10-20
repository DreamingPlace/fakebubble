type Store = {
  run(sql: string, ...params: unknown[]): unknown;
  get<T>(sql: string, ...params: unknown[]): T | undefined;
  all<T>(sql: string, ...params: any[]): T[];
};

/**
 * NAMED EXCEPTION (Part 22a follow-up). The old redemption path (a grant, kind 'invite', retention 'protected') exists only on a
 * database below schema 125, and workerd cannot start below the full migration list (WebDurableStore insists on it). A workerd
 * test of that legacy behaviour therefore calls this first: it removes the step-125 entitlement tables from the running database
 * and makes the store read `PRAGMA user_version` as 124, so every 125-aware check (entitlementTablesExist, schema >= 125)
 * answers "pre-125", as it would on a real 124 database. The nullable web_invite_codes.batch_id column and the
 * web_invite_batches table stay, as a pre-125 `issue` ignores them. The 125 behaviour is tested everywhere else
 * (web-invite-tiers-*, web-invite-cross-path-22a). A restarted fixture object calls `resumeLegacySchema` to read as 124 again.
 */
export function legacySchema(store: Store) {
  for (const table of [
    'web_entitlement_refills',
    'web_entitlement_redemptions',
    'web_invite_batch_changes',
    'web_entitlements',
    'web_player_numbers',
  ])
    store.run(`DROP TABLE IF EXISTS ${table}`);
  return resumeLegacySchema(store);
}

export function resumeLegacySchema(store: Store) {
  if (store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_entitlements'")) return { legacy: false };
  const all = store.all.bind(store);
  store.all = ((sql: string, ...params: unknown[]) =>
    sql === 'PRAGMA user_version' ? [{ user_version: 124 }] : all(sql, ...params)) as Store['all'];
  return { legacy: true };
}

/**
 * The same named exception for a Node (node:sqlite) database that `migrateProvider` took to 125: the step-125 tables go and
 * user_version reads 124, so the database is what a real 124 database is for every schema-aware check.
 */
export function downgradeToLegacy(store: Store) {
  for (const table of [
    'web_entitlement_refills',
    'web_entitlement_redemptions',
    'web_invite_batch_changes',
    'web_entitlements',
    'web_player_numbers',
  ])
    store.run(`DROP TABLE IF EXISTS ${table}`);
  store.run('PRAGMA user_version=124');
}
