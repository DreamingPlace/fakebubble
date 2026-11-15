import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { rehearsalInstalled } from './web-rehearsal-schema.ts';

/**
 * Part 31b: deleting 多轮预演 runs (the owner's 整理预演, and a character's deletion). NO numbered migration: a digest-checked runtime
 * step installed right after the Part 35 tables. STOP code: WEB_REHEARSAL_ERASE_SCHEMA_MISMATCH.
 *
 * The money rows of `web_rehearsal_calls` stay as they are and their `web_rehearsal_call_retain` / `_known` / `_identity` triggers are
 * NOT touched: only content columns of a call (output_json, metadata_json) are blanked, and no trigger covers those. What the Part 35
 * guards DID cover and a deletion must reach is rebuilt here: a run's frozen request (`frozen_json`) and a unit's frozen request
 * (`request_json`). For a run in `web_rehearsal_erased` the ONE change each trigger now allows is blanking that column; everything else
 * (ids, digests, model, turn, status, error code, money) is compared and still refused.
 */
const same = (cols: string[]) => cols.map((c) => `NEW.${c} IS OLD.${c}`).join(' AND ');
const RUN_COLS = [
  'id',
  'request_id',
  'request_hash',
  'character_id',
  'draft_revision',
  'profile_hash',
  'script_name',
  'source_kind',
  'models_json',
  'with_cast',
  'frozen_digest',
  'reviewer',
  'estimated_micros',
  'member_id',
  'session_id',
  'created_at',
];
const UNIT_COLS = [
  'run_id',
  'seq',
  'kind',
  'model_key',
  'turn',
  'item_key',
  'status',
  'lease_token',
  'lease_until',
  'deadline_at',
  'retry_at',
  'error_code',
  'request_digest',
  'result_json',
  'finished_at',
];
const triggers = [
  [
    'web_rehearsal_run_immutable',
    `CREATE TRIGGER web_rehearsal_run_immutable BEFORE UPDATE ON web_rehearsal_runs
      WHEN NOT (EXISTS(SELECT 1 FROM web_rehearsal_erased WHERE run_id=OLD.id) AND NEW.frozen_json='{}' AND ${same(RUN_COLS)})
      BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
    `CREATE TRIGGER web_rehearsal_run_immutable BEFORE UPDATE ON web_rehearsal_runs
    BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  ],
  [
    'web_rehearsal_unit_frozen',
    `CREATE TRIGGER web_rehearsal_unit_frozen BEFORE UPDATE OF request_json,request_digest ON web_rehearsal_units
      WHEN (OLD.request_json IS NOT NULL OR EXISTS(SELECT 1 FROM web_rehearsal_erased WHERE run_id=OLD.run_id))
        AND NOT (EXISTS(SELECT 1 FROM web_rehearsal_erased WHERE run_id=OLD.run_id)
        AND NEW.request_json IS NULL AND ${same(UNIT_COLS)})
      BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
    `CREATE TRIGGER web_rehearsal_unit_frozen BEFORE UPDATE OF request_json,request_digest ON web_rehearsal_units
    WHEN OLD.request_json IS NOT NULL BEGIN SELECT RAISE(ABORT,'WEB_REHEARSAL_IMMUTABLE'); END`,
  ],
] as const;
const table = `CREATE TABLE web_rehearsal_erased(run_id TEXT PRIMARY KEY,erased_at INTEGER NOT NULL) STRICT`;
const digest = createHash('sha256')
  .update([table, ...triggers.map((t) => t[1])].join(';\n'))
  .digest('hex');
const normalize = (sql: string) => sql.replace(/\s+/g, '').replace(/;$/, '');

export function installRehearsalErase(store: BusinessStore) {
  if (!rehearsalInstalled(store)) return;
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_rehearsal_erase_schema'")) {
      ensure(
        !store.get("SELECT 1 FROM sqlite_master WHERE name='web_rehearsal_erased'"),
        'WEB_REHEARSAL_ERASE_SCHEMA_MISMATCH',
      );
      store.run(table);
      store.run(
        'CREATE TABLE web_rehearsal_erase_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_rehearsal_erase_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ sha256: string }>('SELECT * FROM web_rehearsal_erase_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === digest, 'WEB_REHEARSAL_ERASE_SCHEMA_MISMATCH');
    for (const [name, widened, original] of triggers) {
      const current = store.get<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?",
        name,
      )?.sql;
      ensure(current, 'WEB_REHEARSAL_ERASE_SCHEMA_MISMATCH');
      if (normalize(current) === normalize(widened)) continue;
      ensure(normalize(current) === normalize(original), 'WEB_REHEARSAL_ERASE_SCHEMA_MISMATCH');
      store.run(`DROP TRIGGER ${name}`);
      store.run(widened);
    }
  });
}
export const rehearsalEraseInstalled = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE name='web_rehearsal_erase_schema'");
/** SQL that keeps a list free of runs the owner deleted; '' on a database without the marker table. */
export const rehearsalNotErased = (store: Pick<BusinessStore, 'get'>, alias = 'r') =>
  rehearsalEraseInstalled(store)
    ? ` AND NOT EXISTS(SELECT 1 FROM web_rehearsal_erased x WHERE x.run_id=${alias}.id)`
    : '';

/** True while any unit of the run is queued or generating. */
export const rehearsalRunBusy = (store: Pick<BusinessStore, 'get'>, runId: string) =>
  !!store.get("SELECT 1 FROM web_rehearsal_units WHERE run_id=? AND status IN ('queued','generating') LIMIT 1", runId);

/**
 * Blanks everything a run holds that is content (the player lines, the hint phrasings, the replies, the judge text, the frozen requests)
 * and marks it; the shells (run, units, calls with every money column) stay. Runs in the caller's transaction. Returns whether it erased.
 */
export function eraseRehearsalRun(store: BusinessStore, runId: string, now: number) {
  if (!rehearsalEraseInstalled(store)) return false;
  if (store.get('SELECT 1 FROM web_rehearsal_erased WHERE run_id=?', runId)) return false;
  store.run('INSERT INTO web_rehearsal_erased(run_id,erased_at) VALUES (?,?)', runId, now);
  store.run('DELETE FROM web_rehearsal_turns WHERE run_id=?', runId);
  store.run('DELETE FROM web_rehearsal_items WHERE run_id=?', runId);
  // (two statements: the frozen-request trigger fires on any update that names request_json, and compares every other column)
  store.run('UPDATE web_rehearsal_units SET result_json=NULL WHERE run_id=?', runId);
  store.run('UPDATE web_rehearsal_units SET request_json=NULL WHERE run_id=?', runId);
  store.run('UPDATE web_rehearsal_calls SET output_json=NULL,metadata_json=NULL WHERE run_id=?', runId);
  store.run("UPDATE web_rehearsal_runs SET frozen_json='{}' WHERE id=?", runId);
  return true;
}
/** Character deletion: every run of the character (running ones too; the runner fails their units with CHARACTER_DELETED). */
export function eraseRehearsalRunsOf(store: BusinessStore, characterId: string, now: number) {
  if (!rehearsalEraseInstalled(store)) return;
  for (const run of store.all<{ id: string }>('SELECT id FROM web_rehearsal_runs WHERE character_id=?', characterId))
    eraseRehearsalRun(store, run.id, now);
}
