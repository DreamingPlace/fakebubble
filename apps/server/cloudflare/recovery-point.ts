import { createHash } from 'node:crypto';
import type { DurableStore } from './store.ts';
import type { GuardRecoveryReceipt } from './guard-recovery.ts';
import { parseRecoveryPoint } from '../platform/recovery-protocol.ts';
import { ensure } from '../../../packages/domain/errors.ts';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function cloudRecoveryPoint(store: Pick<DurableStore, 'get'>) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cf_recovery_point'")) return null;
  const row = store.get<{ point_json: string; target_json: string; sha256: string }>(
    'SELECT * FROM cf_recovery_point WHERE singleton=1',
  );
  ensure(row && row.sha256 === hash(row.point_json + '\n' + row.target_json), 'RESTORE_POINT_INVALID');
  const point = parseRecoveryPoint(JSON.parse(row.point_json));
  const target = JSON.parse(row.target_json) as GuardRecoveryReceipt['target'];
  ensure(
    target.epoch === point.epoch &&
      target.instanceId ===
        store.get<{ instance_id: string }>('SELECT instance_id FROM beta_instance WHERE singleton=1')?.instance_id &&
      point.restoredAt >= point.snapshotAt,
    'RESTORE_POINT_INVALID',
  );
  return point;
}

/** Persist client confirmation identity while STILL quarantined. Does not adopt the guard epoch, unlock or enable spending. */
export async function prepareCloudRecoveryPoint(
  store: DurableStore,
  guard: { verifyRecovery(receipt: GuardRecoveryReceipt): Promise<GuardRecoveryReceipt> },
  receipt: GuardRecoveryReceipt,
  now: number,
) {
  ensure(!store.betaExternalCalls, 'RESTORE_POINT_INVALID');
  const lock = store.get<{ state: string; snapshot_at: number }>(
    'SELECT state,snapshot_at FROM cf_restore_lock WHERE singleton=1',
  );
  ensure(lock?.state === 'costs-observed', 'RESTORE_COSTS_REQUIRED');
  const json = JSON.stringify(receipt),
    target = JSON.stringify(receipt.target);
  ensure(
    store.get<{ receipt_json: string }>('SELECT receipt_json FROM cf_restore_reservation WHERE singleton=1')
      ?.receipt_json === json,
    'RESTORE_RESERVATION_INVALID',
  );
  ensure(
    receipt.target.instanceId ===
      store.get<{ instance_id: string }>('SELECT instance_id FROM beta_instance WHERE singleton=1')?.instance_id,
    'RESTORE_POINT_INVALID',
  );
  const existing = cloudRecoveryPoint(store);
  const point = parseRecoveryPoint({
    version: 1,
    epoch: receipt.target.epoch,
    snapshotAt: lock.snapshot_at,
    restoredAt: existing?.restoredAt ?? now,
  });
  ensure(
    Number.isSafeInteger(now) &&
      now >= point.restoredAt &&
      point.restoredAt >= point.snapshotAt &&
      (!existing || JSON.stringify(existing) === JSON.stringify(point)),
    'RESTORE_POINT_INVALID',
  );
  if (existing)
    ensure(
      store.get<{ target_json: string }>('SELECT target_json FROM cf_recovery_point WHERE singleton=1')?.target_json ===
        target,
      'RESTORE_POINT_INVALID',
    );
  const before = JSON.stringify(store.get('SELECT total_changes() n'));
  ensure(JSON.stringify(await guard.verifyRecovery(receipt)) === json, 'RESTORE_RESERVATION_INVALID');
  ensure(JSON.stringify(store.get('SELECT total_changes() n')) === before, 'RESTORE_TARGET_CHANGED');
  if (!existing)
    store.transaction(() => {
      store.exec(
        'CREATE TABLE cf_recovery_point(singleton INTEGER PRIMARY KEY CHECK(singleton=1),point_json TEXT NOT NULL,target_json TEXT NOT NULL,sha256 TEXT NOT NULL) STRICT',
      );
      const pointJSON = JSON.stringify(point);
      store.run('INSERT INTO cf_recovery_point VALUES(1,?,?,?)', pointJSON, target, hash(pointJSON + '\n' + target));
    });
  return { point, quarantined: true as const };
}
