import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RecoveryPoint } from '../../packages/contracts/player-api.ts';
import { ensure } from '../../packages/domain/errors.ts';

export const RECOVERY_FILE = 'recovery.json';
export const RESTORE_INCOMPLETE = '.restore-incomplete';
export { RECOVERY_HEADER, recoveryToken, parseRecoveryPoint, requireRecoveryPoint } from './recovery-protocol.ts';
import { parseRecoveryPoint } from './recovery-protocol.ts';

/** Immutable for a Store lifetime. Restoring a running instance in place is unsupported. */
export function loadRecoveryPoint(runtime: string): RecoveryPoint | null {
  try {
    lstatSync(join(runtime, RESTORE_INCOMPLETE));
    ensure(false, 'RESTORE_INCOMPLETE');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  let fd: number;
  try {
    fd = openSync(join(runtime, RECOVERY_FILE), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    ensure(
      stat.isFile() && stat.nlink === 1 && (stat.mode & 0o077) === 0 && stat.size <= 4096,
      'INVALID_RECOVERY_POINT',
    );
    return parseRecoveryPoint(JSON.parse(readFileSync(fd, 'utf8')));
  } finally {
    closeSync(fd);
  }
}
