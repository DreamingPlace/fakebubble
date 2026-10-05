import type { ProviderCallObserver, ProviderObservation, ProviderReservation } from '../contracts/provider-calls.ts';
import { DomainError } from './errors.ts';

/** Accounting completion must settle before the caller advances. Never retry a failed observation implicitly. */
export async function finishProviderCall(observer: ProviderCallObserver | undefined, value: ProviderObservation) {
  try {
    await observer?.finish(value);
  } catch {
    throw new DomainError('COST_RECORDING_FAILED');
  }
}
export async function closeProviderReservation(reservation: ProviderReservation | undefined) {
  try {
    await reservation?.close();
  } catch {
    throw new DomainError('COST_RECORDING_FAILED');
  }
}
