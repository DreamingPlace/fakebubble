import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 31. NO numbered migration: installed idempotently and digest-checked at start, like the 24j / 24l / 30 steps.
 * STOP code: WEB_OWNER_OPS_SCHEMA_MISMATCH (a table of this step exists with other contents, a guarded trigger is in an
 * unknown form, or the stored digest differs).
 *
 *   web_owner_requests   one row per owner request (arc order, deletions, the closed-account setting): the idempotency record
 *                        (request id + hash of the body) and the COUNTS it produced. Never an id of a player, a world, a
 *                        conversation or a preview, and never content.
 *   web_owner_settings   owner settings. The only key is `closed_chats`: what happens to a closed account's chat text.
 *   web_closed_accounts  one row per closed account whose chat text sits in the anonymous review archive: the 玩家编号, the
 *                        review code the archive copy carries, the closure time and the time the archive drops it. Written in the
 *                        transaction that makes the archive copy; deleted with that copy (owner deletion or the 180-day sweep).
 *   web_preview_erased   a 预演 whose content the owner deleted. Its ledger shells stay (money rows are immutable); the content
 *                        columns are blanked and every reader skips a marked preview. Two guard triggers are rebuilt so that the
 *                        ONE change they now allow for a marked preview is blanking the content columns.
 */
const requests = `CREATE TABLE web_owner_requests(request_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('arc-order','preview-delete','conversation-delete','closed-delete','closed-setting')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),member_id TEXT NOT NULL REFERENCES web_admin_members(id),
  count_a INTEGER NOT NULL CHECK(count_a>=0),count_b INTEGER NOT NULL CHECK(count_b>=0),created_at INTEGER NOT NULL) STRICT`;
const settings = `CREATE TABLE web_owner_settings(key TEXT PRIMARY KEY CHECK(key='closed_chats'),
  value TEXT NOT NULL CHECK(value IN ('retention','immediate')),member_id TEXT NOT NULL,updated_at INTEGER NOT NULL) STRICT`;
const closed = `CREATE TABLE web_closed_accounts(review_code TEXT PRIMARY KEY CHECK(length(review_code)=4),
  player_number TEXT NOT NULL CHECK(length(player_number)=8),closed_at INTEGER NOT NULL,expires_at INTEGER NOT NULL) STRICT`;
const erased = `CREATE TABLE web_preview_erased(preview_id TEXT PRIMARY KEY,erased_at INTEGER NOT NULL) STRICT`;

const same = (column: string) => `NEW.${column} IS OLD.${column}`;
/** admin_previews: the request text may be replaced by '{}' for a marked preview; nothing else changes. */
const requestTrigger = `CREATE TRIGGER web_character_preview_request BEFORE UPDATE OF character_id,draft_revision,content_hash,prompt_hash,
    request_id,request_hash,evidence_kind,request_json,created_at ON admin_previews
    WHEN EXISTS(SELECT 1 FROM web_character_preview_jobs WHERE preview_id=OLD.id)
      AND NOT (EXISTS(SELECT 1 FROM web_preview_erased WHERE preview_id=OLD.id) AND NEW.request_json='{}'
        AND ${['character_id', 'draft_revision', 'content_hash', 'prompt_hash', 'request_id', 'request_hash', 'evidence_kind', 'created_at'].map(same).join(' AND ')})
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`;
/** The attempt ledger: for a marked preview only output_json and metadata_json may become NULL; every money column is as it was. */
const knownTrigger = `CREATE TRIGGER web_character_preview_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,
    output_json,output_hash,metadata_json,settled_at ON web_character_preview_attempts WHEN OLD.state='known'
      AND NOT (EXISTS(SELECT 1 FROM web_preview_erased WHERE preview_id=OLD.preview_id) AND NEW.output_json IS NULL AND NEW.metadata_json IS NULL
        AND ${['state', 'outcome', 'charged_micros', 'receipt_json', 'output_hash', 'settled_at'].map(same).join(' AND ')})
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`;
const triggers = [
  ['web_character_preview_request', requestTrigger],
  ['web_character_preview_known', knownTrigger],
] as const;
const tables = [requests, settings, closed, erased];
const digest = createHash('sha256')
  .update([...tables, ...triggers.map((t) => t[1])].join(';\n'))
  .digest('hex');
const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');
const TABLE_NAMES = ['web_owner_requests', 'web_owner_settings', 'web_closed_accounts', 'web_preview_erased'];
const previewsInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_character_preview_schema'");

/** The pre-Part-31 form of the two guard triggers (as installWebCharacterPreviews creates them). */
const originalTriggers: Record<string, string> = {
  web_character_preview_request: `CREATE TRIGGER web_character_preview_request BEFORE UPDATE OF character_id,draft_revision,content_hash,prompt_hash,
    request_id,request_hash,evidence_kind,request_json,created_at ON admin_previews
    WHEN EXISTS(SELECT 1 FROM web_character_preview_jobs WHERE preview_id=OLD.id)
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
  web_character_preview_known: `CREATE TRIGGER web_character_preview_known BEFORE UPDATE OF state,outcome,charged_micros,receipt_json,
    output_json,output_hash,metadata_json,settled_at ON web_character_preview_attempts WHEN OLD.state='known'
    BEGIN SELECT RAISE(ABORT,'WEB_PREVIEW_IMMUTABLE'); END`,
};

/** Call after installWebCharacterPreviews (when that exists): the guard triggers are rebuilt only if they are there. */
export function installWebOwnerOps(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_owner_ops_schema'")) {
      ensure(
        !store.get(
          `SELECT 1 FROM sqlite_master WHERE name IN (${TABLE_NAMES.map(() => '?').join(',')})`,
          ...TABLE_NAMES,
        ),
        'WEB_OWNER_OPS_SCHEMA_MISMATCH',
      );
      for (const sql of tables) store.run(sql);
      store.run(
        'CREATE TABLE web_owner_ops_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_owner_ops_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_owner_ops_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_OWNER_OPS_SCHEMA_MISMATCH');
    // The guard triggers exist once the preview ledger is installed. Only the exact original or the exact new form is accepted.
    if (!previewsInstalled(store)) return;
    for (const [name, sql] of triggers) {
      const current = store.get<{ sql: string }>(
        'SELECT sql FROM sqlite_master WHERE type=? AND name=?',
        'trigger',
        name,
      )?.sql;
      ensure(current, 'WEB_OWNER_OPS_SCHEMA_MISMATCH');
      if (normalize(current) === normalize(sql)) continue;
      ensure(normalize(current) === normalize(originalTriggers[name]!), 'WEB_OWNER_OPS_SCHEMA_MISMATCH');
      store.run(`DROP TRIGGER ${name}`);
      store.run(sql);
    }
  });
}
export const ownerOpsInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_owner_ops_schema'");

/** 'retention' (today's behaviour: the chat text stays in the anonymous archive for 180 days) or 'immediate'. */
export function closedChatPolicy(store: Pick<BusinessStore, 'get'>): 'retention' | 'immediate' {
  if (!ownerOpsInstalled(store)) return 'retention';
  return store.get<{ value: string }>("SELECT value FROM web_owner_settings WHERE key='closed_chats'")?.value ===
    'immediate'
    ? 'immediate'
    : 'retention';
}
/** SQL that keeps a preview list free of previews the owner deleted; '' on a database without the marker table. */
export const notErasedSql = (store: Pick<BusinessStore, 'get'>, alias = 'p') =>
  store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_preview_erased'")
    ? ` AND NOT EXISTS(SELECT 1 FROM web_preview_erased x WHERE x.preview_id=${alias}.id)`
    : '';
