import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * A per-IP-hash counter per UTC day, kept in the existing per-IP daily counter table (schema 109), in its own key space
 * (`<purpose>:<ipHash>`, never a bare 64-hex hash, so it cannot collide with the guest-creation counter). Takes one unit and
 * returns false when `cap` for the day is reached. Call it inside the caller's transaction: a refusal later rolls it back.
 */
export function takeIpDaily(
  store: Pick<BusinessStore, 'run'>,
  purpose: string,
  ipHash: string,
  dayStart: number,
  cap: number,
) {
  ensure(/^[a-f0-9]{64}$/.test(ipHash), 'WEB_TRUSTED_IP_REQUIRED');
  const key = `${purpose}:${ipHash}`;
  store.run(
    'INSERT INTO web_local_guest_budget(ip_hash,window_start,created) VALUES (?,?,0) ON CONFLICT DO NOTHING',
    key,
    dayStart,
  );
  return (
    store.run(
      'UPDATE web_local_guest_budget SET created=created+1 WHERE ip_hash=? AND window_start=? AND created<?',
      key,
      dayStart,
      cap,
    ).changes === 1
  );
}
