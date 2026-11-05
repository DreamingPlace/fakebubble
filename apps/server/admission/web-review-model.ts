import { createHash } from 'node:crypto';
import {
  DEFAULT_REVIEW_MODEL,
  isReviewModelId,
  REVIEW_MODELS,
  type ReviewModelChangeView,
  type ReviewModelId,
  type ReviewModelSaveInput,
  type ReviewModelView,
} from '../../../packages/contracts/review-model.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Part 26b: the review model (审核模型) switch. Stored as a setting the business object alone writes; NO numbered migration:
 * the four small tables are installed by `installReviewModelSchema` (idempotent, digest-checked, like the preview queue), at
 * business-object start, and every reader below tolerates their absence (= the default, V4 Pro).
 *
 *  - web_review_model_setting      the live choice (one row)
 *  - web_review_model_changes      who changed it and when (append-only; ids of administrators only, no player data)
 *  - web_operation_review_models   the choice FROZEN at admission, one row per operation (a switch never touches it)
 *  - web_preview_review_models     the choice frozen when a 预演 is queued (which reviewer produced the proof)
 *
 * The page revision is `web_model_voice.revision` (the revision of the whole 模型与价格 page): a switch quotes it and bumps it, so
 * it conflicts with, and is ordered against, every other save of that page. Idempotent per requestId through
 * `web_model_save_requests`, like those saves.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'>;
type Writer = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'>;

const models = `(${REVIEW_MODELS.map((id) => `'${id}'`).join(',')})`;
const statements = [
  `CREATE TABLE IF NOT EXISTS web_review_model_setting(singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    review_model TEXT NOT NULL CHECK(review_model IN ${models}),updated_at INTEGER NOT NULL,updated_by_admin TEXT) STRICT`,
  `CREATE TABLE IF NOT EXISTS web_review_model_changes(id INTEGER PRIMARY KEY AUTOINCREMENT,save_id TEXT NOT NULL,
    admin_id TEXT NOT NULL,old_model TEXT NOT NULL CHECK(old_model IN ${models}),
    new_model TEXT NOT NULL CHECK(new_model IN ${models} AND new_model<>old_model),created_at INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS web_review_model_changes_no_update BEFORE UPDATE ON web_review_model_changes
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_MODEL_CHANGE_IMMUTABLE'); END`,
  `CREATE TRIGGER IF NOT EXISTS web_review_model_changes_no_delete BEFORE DELETE ON web_review_model_changes
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_MODEL_CHANGE_IMMUTABLE'); END`,
  `CREATE TABLE IF NOT EXISTS web_operation_review_models(operation_id TEXT PRIMARY KEY REFERENCES web_operations(id),
    review_model TEXT NOT NULL CHECK(review_model IN ${models}),created_at INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS web_operation_review_models_no_update BEFORE UPDATE ON web_operation_review_models
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_MODEL_FROZEN'); END`,
  `CREATE TABLE IF NOT EXISTS web_preview_review_models(preview_id TEXT PRIMARY KEY,
    review_model TEXT NOT NULL CHECK(review_model IN ${models}),created_at INTEGER NOT NULL) STRICT`,
  `CREATE TRIGGER IF NOT EXISTS web_preview_review_models_no_update BEFORE UPDATE ON web_preview_review_models
    BEGIN SELECT RAISE(ABORT,'WEB_REVIEW_MODEL_FROZEN'); END`,
];
const SCHEMA_DIGEST = createHash('sha256').update(statements.join(';\n')).digest('hex');

const tableExists = (store: Reader, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** The switch's tables are installed (they are not on a store that never started a business object). */
export const reviewModelTablesExist = (store: Reader) =>
  tableExists(store, 'web_review_model_setting') &&
  tableExists(store, 'web_operation_review_models') &&
  tableExists(store, 'web_preview_review_models');

/**
 * Idempotent. Needs the operation and admin-preview tables (any real business store has them); a store without them (a
 * minimal fixture) is left alone and every reader answers the default.
 */
export function installReviewModelSchema(store: Writer, now: number) {
  if (!tableExists(store, 'web_operations') || !tableExists(store, 'web_instance')) return false;
  store.transaction(() => {
    if (!tableExists(store, 'web_review_model_schema')) {
      for (const sql of statements) store.run(sql);
      store.run(
        'CREATE TABLE web_review_model_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
      );
      store.run('INSERT INTO web_review_model_schema VALUES (1,?)', SCHEMA_DIGEST);
      store.run(
        'INSERT INTO web_review_model_setting(singleton,review_model,updated_at,updated_by_admin) VALUES (1,?,?,NULL)',
        DEFAULT_REVIEW_MODEL,
        now,
      );
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_review_model_schema');
    ensure(rows.length === 1 && rows[0]!.sha256 === SCHEMA_DIGEST, 'WEB_REVIEW_MODEL_SCHEMA_MISMATCH');
  });
  return true;
}

/** The live choice. Anything unreadable is the default: the switch can only ever make behaviour differ from today by being set. */
export function currentReviewModel(store: Reader): ReviewModelId {
  if (!tableExists(store, 'web_review_model_setting')) return DEFAULT_REVIEW_MODEL;
  const row = store.get<{ review_model: string }>(
    'SELECT review_model FROM web_review_model_setting WHERE singleton=1',
  );
  return isReviewModelId(row?.review_model) ? row.review_model : DEFAULT_REVIEW_MODEL;
}
/** The model an operation was admitted with. An operation admitted before the switch existed has no row: V4 Pro. */
export function frozenReviewModel(store: Reader, operationId: string): ReviewModelId {
  if (!tableExists(store, 'web_operation_review_models')) return DEFAULT_REVIEW_MODEL;
  const row = store.get<{ review_model: string }>(
    'SELECT review_model FROM web_operation_review_models WHERE operation_id=?',
    operationId,
  );
  return isReviewModelId(row?.review_model) ? row.review_model : DEFAULT_REVIEW_MODEL;
}
/** Inside the admission transaction: freezes the live choice next to the operation. First write wins; a replay changes nothing. */
export function freezeReviewModel(store: Writer, operationId: string, now: number) {
  if (!tableExists(store, 'web_operation_review_models')) return;
  store.run(
    'INSERT INTO web_operation_review_models(operation_id,review_model,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    operationId,
    currentReviewModel(store),
    now,
  );
}
/** Inside the 预演 queueing transaction: which reviewer will produce this proof. */
export function freezePreviewReviewModel(store: Writer, previewId: string, now: number) {
  if (!tableExists(store, 'web_preview_review_models')) return;
  store.run(
    'INSERT INTO web_preview_review_models(preview_id,review_model,created_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    previewId,
    currentReviewModel(store),
    now,
  );
}
/** The reviewer a 预演 was frozen with. A 预演 queued before the switch existed was reviewed by V4 Pro. */
export function previewReviewModel(store: Reader, previewId: string): ReviewModelId {
  if (!tableExists(store, 'web_preview_review_models')) return DEFAULT_REVIEW_MODEL;
  const row = store.get<{ review_model: string }>(
    'SELECT review_model FROM web_preview_review_models WHERE preview_id=?',
    previewId,
  );
  return isReviewModelId(row?.review_model) ? row.review_model : DEFAULT_REVIEW_MODEL;
}

/** A price row for (deepseek, model, review) is in force at `now`. */
export const reviewPriceInForce = (store: Reader, model: ReviewModelId, now: number) =>
  !!store.get(
    `SELECT 1 FROM web_provider_prices WHERE provider='deepseek' AND model=? AND phase='review' AND currency='USD'
    AND unit='token' AND valid_from<=? AND valid_until>?`,
    model,
    now,
    now,
  );

export function readReviewModelView(store: Reader, canManage: boolean): ReviewModelView | null {
  if (!tableExists(store, 'web_model_voice')) return null;
  const hasMembers = tableExists(store, 'web_admin_members');
  const recent: ReviewModelChangeView[] = tableExists(store, 'web_review_model_changes')
    ? store
        .all<{ created_at: number; label: string | null; old_model: string; new_model: string }>(
          `SELECT c.created_at,${hasMembers ? 'm.label' : 'NULL'} label,c.old_model,c.new_model
          FROM web_review_model_changes c ${hasMembers ? 'LEFT JOIN web_admin_members m ON m.id=c.admin_id' : ''}
          ORDER BY c.id DESC LIMIT 10`,
        )
        .flatMap((row) =>
          isReviewModelId(row.old_model) && isReviewModelId(row.new_model)
            ? [{ at: row.created_at, admin: row.label ?? '已移除的管理员', from: row.old_model, to: row.new_model }]
            : [],
        )
    : [];
  return {
    current: currentReviewModel(store),
    revision: store.get<{ revision: number }>('SELECT revision FROM web_model_voice WHERE singleton=1')!.revision,
    canManage,
    recent,
  };
}

export interface ReviewModelSaveResult {
  revision: number;
  reviewModel: ReviewModelId;
  changed: boolean;
  duplicate: boolean;
}
/**
 * The only writer. One transaction: idempotent per requestId (a replay answers what the first call did; the same id with other
 * content is IDEMPOTENCY_CONFLICT), optimistic on the page revision (MODEL_SETTINGS_CONFLICT), refused while the target's price
 * row is not in force (REVIEW_MODEL_PRICE_MISSING, so a switch can never make a review fail with WEB_PROVIDER_PRICE_REQUIRED).
 * Choosing the model already in force changes nothing. A change bumps the page revision and is logged.
 */
export function saveReviewModel(
  store: Writer,
  now: number,
  adminId: string,
  input: ReviewModelSaveInput,
): ReviewModelSaveResult {
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const hash = createHash('sha256')
    .update(JSON.stringify(['review-model', input.expectedRevision, input.reviewModel]))
    .digest('hex');
  return store.transaction(() => {
    ensure(
      reviewModelTablesExist(store) &&
        tableExists(store, 'web_model_voice') &&
        tableExists(store, 'web_model_save_requests'),
      'MODEL_SETTINGS_UNAVAILABLE',
    );
    const prior = store.get<{ request_hash: string; revision: number }>(
      'SELECT request_hash,revision FROM web_model_save_requests WHERE request_id=?',
      input.requestId,
    );
    if (prior) {
      ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
      return { revision: prior.revision, reviewModel: currentReviewModel(store), changed: false, duplicate: true };
    }
    const voice = store.get<{ revision: number }>('SELECT revision FROM web_model_voice WHERE singleton=1')!;
    ensure(voice.revision === input.expectedRevision, 'MODEL_SETTINGS_CONFLICT');
    const before = currentReviewModel(store);
    const saveId = createHash('sha256')
      .update(`web-review-model-save-v1\0${input.requestId}`)
      .digest('hex')
      .slice(0, 32);
    if (before === input.reviewModel) {
      store.run(
        'INSERT INTO web_model_save_requests(request_id,request_hash,save_id,revision,created_at) VALUES (?,?,?,?,?)',
        input.requestId,
        hash,
        saveId,
        voice.revision,
        now,
      );
      return { revision: voice.revision, reviewModel: before, changed: false, duplicate: false };
    }
    ensure(reviewPriceInForce(store, input.reviewModel, now), 'REVIEW_MODEL_PRICE_MISSING');
    store.run(
      'UPDATE web_review_model_setting SET review_model=?,updated_at=?,updated_by_admin=? WHERE singleton=1',
      input.reviewModel,
      now,
      adminId,
    );
    const revision = voice.revision + 1;
    store.run(
      'UPDATE web_model_voice SET revision=?,updated_at=?,updated_by_admin=? WHERE singleton=1',
      revision,
      now,
      adminId,
    );
    store.run(
      'INSERT INTO web_review_model_changes(save_id,admin_id,old_model,new_model,created_at) VALUES (?,?,?,?,?)',
      saveId,
      adminId,
      before,
      input.reviewModel,
      now,
    );
    store.run(
      'INSERT INTO web_model_save_requests(request_id,request_hash,save_id,revision,created_at) VALUES (?,?,?,?,?)',
      input.requestId,
      hash,
      saveId,
      revision,
      now,
    );
    return { revision, reviewModel: input.reviewModel, changed: true, duplicate: false };
  });
}
