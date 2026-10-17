/**
 * Tables workerd creates in a SQLite-backed Durable Object for itself: `_cf_METADATA` (alarms) and `_cf_KV` (the key-value
 * API, which the owner alerts and the retention ledger use). Reading them, even PRAGMA table_info, is denied
 * ("not authorized: SQLITE_AUTH"), and the same authorizer refuses an application CREATE TABLE whose name starts with
 * `_cf_` in any letter case (checked in a workerd fixture), so no application table can hide behind the prefix.
 * Application tables are named cf_* (no leading underscore) and are not affected.
 */
export const isWorkerdReservedTable = (name: string) => /^_cf_/i.test(name);
