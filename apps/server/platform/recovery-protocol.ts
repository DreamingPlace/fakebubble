import type { RecoveryPoint } from '../../../packages/contracts/player-api.ts';
import { ensure } from '../../../packages/domain/errors.ts';

export function parseRecoveryPoint(value: unknown): RecoveryPoint {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_RECOVERY_POINT');
  const p = value as RecoveryPoint;
  ensure(
    Object.keys(p).sort().join(',') === 'epoch,restoredAt,snapshotAt,version' &&
      p.version === 1 &&
      typeof p.epoch === 'string' &&
      /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.epoch) &&
      [p.snapshotAt, p.restoredAt].every((n) => Number.isSafeInteger(n) && n > 0 && n <= 8_640_000_000_000_000),
    'INVALID_RECOVERY_POINT',
  );
  return Object.freeze(p);
}
