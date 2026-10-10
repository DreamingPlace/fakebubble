import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore as Store } from '../platform/store-contract.ts';
import { playerLoginRetainsGuest } from '../identity/web-player-purge.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';

export type WebRetentionRow = {
  principal_id: string;
  world_id: string;
  started_at: number | null;
  expires_at: number | null;
  state: 'unstarted' | 'active' | 'protected' | 'purging' | 'purged';
  revision: number;
};

/** Cloud113 receipt writers can settle money after expiry, but must not persist private output. */
export function webCloudContentExpired(store: Store, now: number, principalId: string, worldId: string) {
  if (!(store as WebStore).providerAudio) return false;
  const row = store.get<{ kind: string; state: string; expires_at: number | null }>(
    `SELECT p.kind,r.state,r.expires_at
    FROM web_principals p JOIN web_guest_retention r ON r.principal_id=p.id AND r.world_id=p.world_id
    WHERE p.id=? AND p.world_id=?`,
    principalId,
    worldId,
  );
  ensure(row, 'WEB_RETENTION_SCOPE_INVALID');
  return (
    row.kind === 'guest' &&
    (['purging', 'purged'].includes(row.state) ||
      (row.state === 'active' && row.expires_at !== null && row.expires_at <= now))
  );
}

export function webDataLifecycleEnabled(store: Store) {
  const schema = store.get<{ user_version: number }>('PRAGMA user_version')?.user_version;
  ensure(
    schema !== undefined &&
      Number.isInteger(schema) &&
      schema >= 100 &&
      (schema <= 112 ||
        (schema >= 113 &&
          ((store as WebStore).providerRuntime === true ||
            store.get<{ file: string }>('PRAGMA database_list')?.file === '') &&
          !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_provider_attempts'"))),
    'WEB_SCHEMA_UNSUPPORTED',
  );
  return schema === 110 || schema === 111 || schema === 112 || schema >= 113;
}

/** Keyed audit evidence cannot be reversed into private provider receipts after T2. */
export function webReceiptDigest(store: WebStore, kind: 'receipt' | 'usage', json: string) {
  return store.webReceiptDigest(kind, json);
}

/**
 * One server-side predicate for lifecycle private content. Legacy schemas keep their old contract.
 *
 * access 'live' (the default; admission, queues, publishers, provider calls, signup, redemption of the same kind of
 * work): a guest's content is available only inside the trial. access 'read' (history, events, an operation's status,
 * published audio): additionally a guest WITH an email login keeps reading after the trial ended, because the cleaner
 * keeps that guest's data (see web-player-purge.ts). The retention row is not changed: it stays 'active' and expired,
 * so every 'live' caller, and therefore admission, still answers TRIAL_EXPIRED and no new reply or provider call can
 * start. Only a caller that names 'read' can see the difference.
 */
export function requireWebContent(
  store: Store,
  clock: Clock,
  principalId: string,
  worldId: string,
  access: 'live' | 'read' = 'live',
) {
  if (!webDataLifecycleEnabled(store)) return null;
  const now = clock.now();
  ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
  const row = store.get<WebRetentionRow>(
    `SELECT * FROM web_guest_retention
    WHERE principal_id=? AND world_id=?`,
    principalId,
    worldId,
  );
  const principal = store.get<{ kind: string; player_id: string }>(
    `SELECT kind,player_id FROM web_principals
    WHERE id=? AND world_id=?`,
    principalId,
    worldId,
  );
  ensure(row && principal, 'WEB_RETENTION_SCOPE_INVALID');
  if (principal.kind === 'account' && row.state === 'protected') return row;
  if (
    principal.kind === 'guest' &&
    (row.state === 'unstarted' || (row.state === 'active' && row.expires_at !== null && now < row.expires_at))
  )
    return row;
  if (
    access === 'read' &&
    principal.kind === 'guest' &&
    row.state === 'active' &&
    playerLoginRetainsGuest(store, principalId)
  )
    return row;
  if (
    principal.kind === 'invite' &&
    row.state === 'protected' &&
    [111, 112, 113, 114, 115, 116, 117, 118].includes(
      store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
    )
  ) {
    const grant = store.get<{ id: string }>(
      `SELECT id FROM web_invite_grants
      WHERE principal_id=? AND player_id=? AND world_id=? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>?)`,
      principalId,
      principal.player_id,
      worldId,
      now,
    );
    ensure(grant, 'WEB_INVITE_ACCESS_REQUIRED');
    return row;
  }
  ensure(false, 'TRIAL_EXPIRED');
}

/** Caller owns the operation-state CAS and the same short business transaction. */
export function settleWebLifetimeReservation(store: WebStore, ipWindowId: string, outcome: 'used' | 'released') {
  if (!webDataLifecycleEnabled(store)) return;
  const window = store.get<{ ip_hash: string }>('SELECT ip_hash FROM web_ip_windows WHERE id=?', ipWindowId);
  ensure(window, 'WEB_QUOTA_STATE_INVALID');
  ensure(
    store.run(
      `UPDATE web_ip_lifetime_quota SET reserved_total=reserved_total-1,
    ${outcome === 'used' ? 'used_total=used_total+1,' : ''} revision=revision+1
    WHERE ip_hash=? AND reserved_total>0`,
      window.ip_hash,
    ).changes === 1,
    'WEB_QUOTA_STATE_INVALID',
  );
}
