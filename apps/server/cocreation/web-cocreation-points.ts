import { createHash } from 'node:crypto';
import {
  COCREATION_POINTS_DEFAULTS,
  cocreationPointsOk,
  type CocreationPointsSettings,
} from '../../../packages/contracts/cocreation-cards.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/** Migration 131's tables exist. An older database has no memo, no pair stories and no points for notes, whatever else is on. */
export const cocreationPointsTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cocreation_points'");

type Row = { note_points: number; daily_cap: number; adopt_points: number; revision: number };

/** The three live numbers and the revision they are saved under (the defaults, revision 0, on a database without migration 131). */
export function readCocreationPoints(
  store: Pick<BusinessStore, 'get'>,
): CocreationPointsSettings & { revision: number } {
  if (!cocreationPointsTablesExist(store)) return { ...COCREATION_POINTS_DEFAULTS, revision: 0 };
  const row = store.get<Row>(
    'SELECT note_points,daily_cap,adopt_points,revision FROM web_cocreation_points WHERE singleton=1',
  );
  ensure(row, 'COCREATION_POINTS_UNAVAILABLE');
  return {
    notePoints: row.note_points,
    dailyCap: row.daily_cap,
    adoptPoints: row.adopt_points,
    revision: row.revision,
  };
}

/**
 * Saves the three numbers (compare-and-swap on the revision). Validated ranges; the audit row carries the numbers only. The caller
 * has checked who may; it owns the transaction.
 */
export function saveCocreationPoints(
  store: Pick<BusinessStore, 'get' | 'run'>,
  now: number,
  adminId: string,
  input: unknown,
) {
  ensure(cocreationPointsTablesExist(store), 'COCREATION_UNAVAILABLE');
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input), 'INVALID_REQUEST');
  const { expectedRevision, ...numbers } = input as Record<string, unknown>;
  ensure(Number.isSafeInteger(expectedRevision) && (expectedRevision as number) > 0, 'INVALID_REQUEST');
  ensure(cocreationPointsOk(numbers), 'INVALID_REQUEST');
  const next = numbers as CocreationPointsSettings;
  const changed = store.run(
    `UPDATE web_cocreation_points SET note_points=?,daily_cap=?,adopt_points=?,revision=revision+1,updated_at=?,updated_by=?
    WHERE singleton=1 AND revision=?`,
    next.notePoints,
    next.dailyCap,
    next.adoptPoints,
    now,
    adminId,
    expectedRevision as number,
  );
  ensure(changed.changes === 1, 'COCREATION_POINTS_REVISION_CONFLICT');
  store.run(
    'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
    adminId,
    'cocreation-points-settings',
    `note=${next.notePoints};cap=${next.dailyCap};adopt=${next.adoptPoints}`,
    now,
  );
  return readCocreationPoints(store);
}

/**
 * The duplicate rule: the same words (ignoring spaces, punctuation-free case and width) by the same player about the same character
 * (or the same pair, in either order) are one note. The digest is of the normalized text under its scope.
 */
const normalized = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '');
export const noteHash = (scope: string, text: string) =>
  createHash('sha256')
    .update('web-cocreation-note-v1\0')
    .update(scope)
    .update('\0')
    .update(normalized(text))
    .digest('hex');
export const characterScope = (characterId: string) => `c:${characterId}`;
export const pairScope = (a: string, b: string) => `p:${[a, b].sort().join('|')}`;
