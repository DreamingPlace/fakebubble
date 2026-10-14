import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { PREVIEW_NOTE_MAX, PREVIEW_INPUT_MAX, PREVIEW_RUN_MAX } from './web-character-preview.ts';
import { identifier, keys, nonempty, record } from './template-validation.ts';
import { randomUUID } from 'node:crypto';

/**
 * Read side of the 预演测试 workbench (Part 13b). Everything here is derived from the preview rows and the attempt
 * ledger the preview runner already writes; nothing here writes a preview, a bill or a reservation. Admin-only: the
 * caller (WebCharacterAdmin) has already checked the member's permission for the character.
 */

/** How a preview's money ended. Derived from the ledger, never stored, never inferred from the error code. */
export type PreviewSettlement = 'settled_known' | 'held_unknown' | 'released_unsent';
interface AttemptRow {
  phase: 'draft' | 'review';
  model: string;
  state: string;
  outcome: string | null;
  held_micros: number;
  charged_micros: number | null;
  created_at: number;
  settled_at: number | null;
  output_json: string | null;
  budget_id: string;
  receipt_json: string | null;
}
const attemptsOf = (store: BusinessStore, id: string) =>
  store.all<AttemptRow>('SELECT * FROM web_character_preview_attempts WHERE preview_id=? ORDER BY phase', id);

/**
 * - any attempt that is not a settled bill (intent/sent/unknown): its reservation is kept forever by design -> held_unknown;
 * - every attempt a known bill (a success, or a failure that returned usage): charged at the actual usage -> settled_known;
 * - no attempt at all on a finished preview: nothing was reserved or sent -> released_unsent;
 * - a preview that is still queued or generating has no final label yet (null).
 */
export function settlementOf(status: string, unsettled: number, attempts: number): PreviewSettlement | null {
  const open = status === 'queued' || status === 'generating';
  if (unsettled > 0) return open ? null : 'held_unknown';
  if (open) return null;
  return attempts > 0 ? 'settled_known' : 'released_unsent';
}
export const previewSettlement = (status: string, attempts: readonly Pick<AttemptRow, 'state'>[]) =>
  settlementOf(status, attempts.filter((a) => a.state !== 'known').length, attempts.length);
function stageCost(attempt: AttemptRow | undefined) {
  if (!attempt) return null;
  return {
    state: attempt.state,
    outcome: attempt.outcome,
    model: attempt.model,
    reservedMicros: attempt.held_micros,
    chargedMicros: attempt.charged_micros,
    // A reservation that is not a settled bill stays held: an unknown call's money is never released.
    heldMicros: attempt.state === 'known' ? 0 : attempt.held_micros,
    wallMs: attempt.settled_at === null ? null : Math.max(0, attempt.settled_at - attempt.created_at),
  };
}
const hhmm = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

interface PreviewRow {
  id: string;
  character_id: string;
  status: string;
  error_code: string | null;
  request_json: string;
  result_json: string | null;
  created_at: number;
  finished_at: number | null;
  revision: number;
  profile_hash: string;
  run_id: string | null;
  ordinal: number | null;
  note: string | null;
  sim_minute: number | null;
  sim_zone: string | null;
}
const previewSelect = `SELECT p.id,p.character_id,p.status,p.error_code,p.request_json,p.result_json,p.created_at,p.finished_at,
  j.revision,j.profile_hash,i.run_id,i.ordinal,i.note,m.simulated_minute sim_minute,m.time_zone sim_zone
  FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
  LEFT JOIN web_preview_run_items i ON i.preview_id=p.id LEFT JOIN web_preview_marks m ON m.preview_id=p.id`;
const inputOf = (requestJson: string) => {
  try {
    const text = (JSON.parse(requestJson) as { messages?: Array<{ text?: unknown }> }).messages?.[0]?.text;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
};
type Json = Record<string, unknown>;
const bubblesOf = (value: unknown) =>
  Array.isArray(value)
    ? value.flatMap((b) =>
        b && typeof b === 'object' && typeof (b as Json).text === 'string'
          ? [
              {
                text: (b as Json).text as string,
                expression: typeof (b as Json).expression === 'string' ? ((b as Json).expression as string) : null,
              },
            ]
          : [],
      )
    : [];
function finalOf(resultJson: string | null) {
  if (!resultJson) return null;
  const reply = (JSON.parse(resultJson) as { reply?: Json }).reply;
  if (!reply) return null;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  const covered = strings(reply.coveredMessageIds),
    later = strings(reply.deferredMessageIds),
    waiting = strings(reply.awaitingPlayerMessageIds);
  return {
    bubbles: bubblesOf(reply.bubbles),
    mode: reply.mode ?? null,
    endsSession: reply.endsSession === true,
    reviewChanged: reply.reviewChanged === true,
    reviewDecisionNormalized: reply.reviewDecisionNormalized === true,
    coverage: [
      ...covered.map((messageId) => ({ messageId, status: 'answered' })),
      ...later.map((messageId) => ({ messageId, status: 'later' })),
      ...waiting.map((messageId) => ({ messageId, status: 'needs_player' })),
    ],
    topics: Array.isArray(reply.topics) ? reply.topics : [],
    factOps: Array.isArray(reply.factOps) ? reply.factOps : [],
  };
}
export function previewRowDTO(store: BusinessStore, row: PreviewRow) {
  const attempts = attemptsOf(store, row.id);
  const draft = attempts.find((a) => a.phase === 'draft'),
    review = attempts.find((a) => a.phase === 'review');
  const charged = attempts.reduce((sum, a) => sum + (a.charged_micros ?? 0), 0);
  const held = attempts.reduce((sum, a) => sum + (a.state === 'known' ? 0 : a.held_micros), 0);
  const draftCost = stageCost(draft),
    reviewCost = stageCost(review);
  return {
    previewId: row.id,
    characterId: row.character_id,
    draftRevision: row.revision,
    profileHash: row.profile_hash,
    status: row.status,
    errorCode: row.error_code,
    input: inputOf(row.request_json),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    runId: row.run_id,
    ordinal: row.ordinal,
    note: row.note,
    simulatedTime: row.sim_minute === null ? null : { time: hhmm(row.sim_minute), timeZone: row.sim_zone },
    settlement: previewSettlement(row.status, attempts),
    cost: {
      draft: draftCost,
      review: reviewCost,
      chargedMicros: charged,
      heldMicros: held,
    },
    latency: { draftMs: draftCost?.wallMs ?? null, reviewMs: reviewCost?.wallMs ?? null },
    final: finalOf(row.result_json),
  };
}
const must = <T>(value: T | undefined | null): T => {
  ensure(value !== undefined && value !== null, 'NOT_FOUND');
  return value;
};

/** The full record behind one table row: draft vs final, the review's coverage and quotes, rejected output, ids. */
export function previewDetail(store: BusinessStore, characterId: string, previewId: string) {
  const row = must(store.get<PreviewRow>(`${previewSelect} WHERE p.id=?`, previewId));
  ensure(row.character_id === characterId, 'NOT_FOUND');
  const base = previewRowDTO(store, row);
  const attempts = attemptsOf(store, previewId);
  const parse = (phase: 'draft' | 'review') => {
    const text = attempts.find(
      (a) => a.phase === phase && a.state === 'known' && a.outcome === 'succeeded',
    )?.output_json;
    return text ? (JSON.parse(text) as Json) : null;
  };
  const draftPayload = parse('draft'),
    reviewPayload = parse('review');
  const draftBubbles = draftPayload
    ? bubblesOf(draftPayload.bubbles ?? [draftPayload.utterance, ...((draftPayload.afterthoughts as unknown[]) ?? [])])
    : null;
  const review = reviewPayload && {
    decision: reviewPayload.decision ?? null,
    replacementBubbles: bubblesOf(reviewPayload.replacementBubbles),
    coverage: reviewPayload.coverage ?? null,
    topics: Array.isArray(reviewPayload.topics) ? reviewPayload.topics : [],
    factOps: Array.isArray(reviewPayload.factOps) ? reviewPayload.factOps : [],
  };
  const rejected = store
    .all<{
      phase: string;
      error_code: string;
      raw_output: string;
      raw_bytes: number;
      truncated: number;
      created_at: number;
    }>('SELECT * FROM web_preview_rejected WHERE preview_id=? ORDER BY phase', previewId)
    .map((r) => ({
      phase: r.phase,
      errorCode: r.error_code,
      rawOutput: r.raw_output,
      rawBytes: r.raw_bytes,
      truncated: r.truncated === 1,
      createdAt: r.created_at,
    }));
  return {
    ...base,
    draft: draftPayload ? { mode: draftPayload.mode ?? null, bubbles: draftBubbles } : null,
    review,
    rejected,
    ids: {
      previewId,
      runId: row.run_id,
      budgetIds: attempts.map((a) => ({ phase: a.phase, budgetId: a.budget_id })),
      providerRequestIds: attempts.flatMap((a) => {
        try {
          const id = a.receipt_json ? (JSON.parse(a.receipt_json) as Json).providerRequestId : null;
          return typeof id === 'string' ? [{ phase: a.phase, requestId: id }] : [];
        } catch {
          return [];
        }
      }),
    },
  };
}

interface RunRow {
  id: string;
  character_id: string;
  label: string | null;
  draft_revision: number;
  profile_hash: string;
  relationship: string;
  simulated_minute: number | null;
  time_zone: string;
  eval_set_id: string | null;
  eval_set_version: number | null;
  item_count: number;
  created_by: string;
  created_at: number;
}
const runDTO = (r: RunRow) => ({
  runId: r.id,
  characterId: r.character_id,
  label: r.label,
  draftRevision: r.draft_revision,
  profileHash: r.profile_hash,
  relationship: r.relationship,
  simulatedTime: r.simulated_minute === null ? null : { time: hhmm(r.simulated_minute), timeZone: r.time_zone },
  timeZone: r.time_zone,
  evalSet: r.eval_set_id ? { id: r.eval_set_id, version: r.eval_set_version } : null,
  itemCount: r.item_count,
  createdBy: r.created_by,
  createdAt: r.created_at,
});
const runSummary = (store: BusinessStore, r: RunRow) => {
  const counts = store.all<{ status: string; n: number }>(
    `SELECT p.status,count(*) n FROM web_preview_run_items i JOIN admin_previews p ON p.id=i.preview_id
    WHERE i.run_id=? GROUP BY p.status`,
    r.id,
  );
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  return { ...runDTO(r), counts: { queued: 0, generating: 0, succeeded: 0, failed: 0, ...byStatus } };
};
export function runList(store: BusinessStore, characterId: string) {
  const runs = store.all<RunRow>(
    'SELECT * FROM web_preview_runs WHERE character_id=? ORDER BY created_at DESC,id DESC LIMIT 30',
    characterId,
  );
  const singles = store
    .all<PreviewRow>(
      `${previewSelect} WHERE p.character_id=? AND i.run_id IS NULL ORDER BY p.created_at DESC,p.id DESC LIMIT 30`,
      characterId,
    )
    .map((row) => previewRowDTO(store, row));
  return { runs: runs.map((r) => runSummary(store, r)), singles };
}
export function runDetail(store: BusinessStore, characterId: string, runId: string) {
  const run = must(store.get<RunRow>('SELECT * FROM web_preview_runs WHERE id=?', runId));
  ensure(run.character_id === characterId, 'NOT_FOUND');
  const rows = store
    .all<PreviewRow>(`${previewSelect} WHERE i.run_id=? ORDER BY i.ordinal`, runId)
    .map((row) => previewRowDTO(store, row));
  return { run: runSummary(store, run), previews: rows };
}
/**
 * One cheap read for the page's poller: the status of all of a run's previews (or the character's recent previews),
 * no results, no bubbles. The client refetches the heavy run only when something finished.
 */
export function previewsStatus(store: BusinessStore, characterId: string, runId: string | null) {
  if (runId !== null) {
    const run = must(
      store.get<{ character_id: string }>('SELECT character_id FROM web_preview_runs WHERE id=?', runId),
    );
    ensure(run.character_id === characterId, 'NOT_FOUND');
  }
  const rows = store.all<{
    id: string;
    status: string;
    error_code: string | null;
    run_id: string | null;
    ordinal: number | null;
    finished_at: number | null;
    unsettled: number;
    attempts: number;
  }>(
    `SELECT p.id,p.status,p.error_code,i.run_id,i.ordinal,p.finished_at,
    (SELECT count(*) FROM web_character_preview_attempts a WHERE a.preview_id=p.id AND a.state!='known') unsettled,
    (SELECT count(*) FROM web_character_preview_attempts a WHERE a.preview_id=p.id) attempts
    FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
    LEFT JOIN web_preview_run_items i ON i.preview_id=p.id
    WHERE p.character_id=? AND (? IS NULL OR i.run_id=?)
    ORDER BY ${runId === null ? 'p.created_at DESC,p.id DESC LIMIT 60' : 'i.ordinal'}`,
    characterId,
    runId,
    runId,
  );
  const previews = rows.map((r) => ({
    previewId: r.id,
    status: r.status,
    errorCode: r.error_code,
    runId: r.run_id,
    ordinal: r.ordinal,
    finishedAt: r.finished_at,
    settlement: settlementOf(r.status, r.unsettled, r.attempts),
  }));
  return { previews, active: previews.filter((p) => p.status === 'queued' || p.status === 'generating').length };
}

/** Eval sets: named lists of inputs, versioned on every save. Global (not per character); see WebCharacterAdmin for who may write. */
export const EVAL_SET_NAME_MAX = 60;
interface EvalRow {
  id: string;
  name: string;
  version: number;
  items_json: string;
  created_by: string;
  created_at: number;
  updated_by: string;
  updated_at: number;
}
const evalDTO = (row: EvalRow) => ({
  id: row.id,
  name: row.name,
  version: row.version,
  items: JSON.parse(row.items_json) as Array<{ text: string; note: string | null }>,
  updatedBy: row.updated_by,
  updatedAt: row.updated_at,
});
export function evalSetList(store: BusinessStore) {
  return store.all<EvalRow>('SELECT * FROM web_eval_sets ORDER BY name').map(evalDTO);
}
function evalItems(value: unknown) {
  ensure(Array.isArray(value) && value.length >= 1 && value.length <= PREVIEW_RUN_MAX, 'INVALID_EVAL_SET');
  return value.map((item: unknown) => {
    record(item);
    keys(item, ['text', 'note']);
    nonempty(item.text, PREVIEW_INPUT_MAX);
    ensure(
      item.note === undefined ||
        item.note === null ||
        (typeof item.note === 'string' && [...item.note].length <= PREVIEW_NOTE_MAX),
      'INVALID_EVAL_SET',
    );
    return { text: item.text as string, note: typeof item.note === 'string' && item.note.trim() ? item.note : null };
  });
}
/** Create (id null) or update (expectedVersion must match) a set. Every save appends a version row. */
export function evalSetSave(
  store: BusinessStore,
  now: number,
  memberId: string,
  input: Record<string, unknown>,
  nextId: () => string = randomUUID,
) {
  keys(input, ['id', 'expectedVersion', 'name', 'items']);
  nonempty(input.name, EVAL_SET_NAME_MAX);
  const name = input.name.trim();
  ensure(name.length > 0, 'INVALID_EVAL_SET');
  const items = evalItems(input.items),
    json = JSON.stringify(items);
  ensure(
    (input.id === null && input.expectedVersion === null) ||
      (typeof input.id === 'string' &&
        Number.isSafeInteger(input.expectedVersion) &&
        Number(input.expectedVersion) > 0),
    'INVALID_EVAL_SET',
  );
  return store.transaction(() => {
    const same = store.get<EvalRow>('SELECT * FROM web_eval_sets WHERE name=?', name);
    if (input.id === null) {
      ensure(!same, 'EVAL_SET_NAME_TAKEN');
      ensure(store.get<{ n: number }>('SELECT count(*) n FROM web_eval_sets')!.n < 100, 'EVAL_SET_LIMIT');
      const id = nextId();
      identifier(id);
      store.run('INSERT INTO web_eval_sets VALUES (?,?,1,?,?,?,?,?)', id, name, json, memberId, now, memberId, now);
      store.run('INSERT INTO web_eval_set_versions VALUES (?,1,?,?,?,?)', id, name, json, memberId, now);
      return evalDTO(store.get<EvalRow>('SELECT * FROM web_eval_sets WHERE id=?', id)!);
    }
    identifier(input.id);
    const current = must(store.get<EvalRow>('SELECT * FROM web_eval_sets WHERE id=?', input.id));
    ensure(!same || same.id === current.id, 'EVAL_SET_NAME_TAKEN');
    // A lost reply is replayable: the same content at the next version is the answer the first save already gave.
    if (current.version === Number(input.expectedVersion) + 1 && current.items_json === json && current.name === name)
      return evalDTO(current);
    ensure(current.version === input.expectedVersion, 'EVAL_SET_CONFLICT');
    const version = current.version + 1;
    store.run(
      'UPDATE web_eval_sets SET name=?,version=?,items_json=?,updated_by=?,updated_at=? WHERE id=?',
      name,
      version,
      json,
      memberId,
      now,
      current.id,
    );
    store.run('INSERT INTO web_eval_set_versions VALUES (?,?,?,?,?,?)', current.id, version, name, json, memberId, now);
    return evalDTO(store.get<EvalRow>('SELECT * FROM web_eval_sets WHERE id=?', current.id)!);
  });
}
export function evalSetDelete(store: BusinessStore, id: unknown, expectedVersion: unknown) {
  identifier(id);
  return store.transaction(() => {
    const current = must(store.get<EvalRow>('SELECT * FROM web_eval_sets WHERE id=?', id));
    ensure(current.version === expectedVersion, 'EVAL_SET_CONFLICT');
    store.run('DELETE FROM web_eval_set_versions WHERE set_id=?', id);
    store.run('DELETE FROM web_eval_sets WHERE id=?', id);
    return { deleted: true };
  });
}
