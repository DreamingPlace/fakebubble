import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

export interface GuardAccount {
  id: string;
  meteringId: string;
  status: 'active' | 'suspended';
  revision: number;
}
export interface GuardDevice {
  id: string;
  playerId: string;
  revoked: boolean;
}
export interface GuardInvite {
  id: string;
  playerId: string | null;
  revoked: boolean;
  consumed: boolean;
}
export interface GuardAccessState {
  accounts: GuardAccount[];
  devices: GuardDevice[];
  invites: GuardInvite[];
  tombstones: string[];
}
export const emptyGuardAccessState = (): GuardAccessState => ({
  accounts: [],
  devices: [],
  invites: [],
  tombstones: [],
});
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  ensure(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === names.length &&
      names.every((n) => Object.hasOwn(value, n)),
    'GUARD_STATE_INVALID',
  );
}
export function guardId(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'GUARD_ID_INVALID');
}
const order = <T extends { id: string }>(rows: T[]) => rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
function rows<T extends { id: string }>(value: unknown, parse: (row: unknown) => T): T[] {
  ensure(Array.isArray(value) && value.length <= 4096, 'GUARD_STATE_INVALID');
  const result = value.map(parse);
  ensure(new Set(result.map((r) => r.id)).size === result.length, 'GUARD_STATE_INVALID');
  return order(result);
}
/** Permission metadata only. No names, tokens, private message content, media, or monetary totals. */
export function parseGuardAccessState(value: unknown): GuardAccessState {
  fields(value, ['accounts', 'devices', 'invites', 'tombstones']);
  const accounts = rows<GuardAccount>(value.accounts, (raw) => {
    fields(raw, ['id', 'meteringId', 'status', 'revision']);
    guardId(raw.id);
    guardId(raw.meteringId);
    ensure(
      (raw.status === 'active' || raw.status === 'suspended') &&
        Number.isSafeInteger(raw.revision) &&
        Number(raw.revision) > 0,
      'GUARD_STATE_INVALID',
    );
    return { id: raw.id, meteringId: raw.meteringId, status: raw.status, revision: raw.revision as number };
  });
  ensure(new Set(accounts.map((a) => a.meteringId)).size === accounts.length, 'GUARD_STATE_INVALID');
  const players = new Set(accounts.map((a) => a.id));
  const devices = rows(value.devices, (raw) => {
    fields(raw, ['id', 'playerId', 'revoked']);
    guardId(raw.id);
    guardId(raw.playerId);
    ensure(players.has(raw.playerId) && typeof raw.revoked === 'boolean', 'GUARD_STATE_INVALID');
    return { id: raw.id, playerId: raw.playerId, revoked: raw.revoked };
  });
  const invites = rows(value.invites, (raw) => {
    fields(raw, ['id', 'playerId', 'revoked', 'consumed']);
    guardId(raw.id);
    if (raw.playerId !== null) guardId(raw.playerId);
    ensure(
      (raw.playerId === null || players.has(raw.playerId)) &&
        typeof raw.revoked === 'boolean' &&
        typeof raw.consumed === 'boolean',
      'GUARD_STATE_INVALID',
    );
    return { id: raw.id, playerId: raw.playerId, revoked: raw.revoked, consumed: raw.consumed };
  });
  ensure(Array.isArray(value.tombstones) && value.tombstones.length <= 4096, 'GUARD_STATE_INVALID');
  const tombstones = value.tombstones
    .map((v) => {
      guardId(v);
      ensure(players.has(v), 'GUARD_STATE_INVALID');
      return v;
    })
    .sort();
  ensure(new Set(tombstones).size === tombstones.length, 'GUARD_STATE_INVALID');
  const result = { accounts, devices, invites, tombstones };
  // One DO SQLite row is limited to 2 MB. Bound the canonical record below that before any write.
  ensure(Buffer.byteLength(JSON.stringify(result)) <= 1_048_576, 'GUARD_STATE_TOO_LARGE');
  return result;
}
export const guardStateHash = (state: GuardAccessState) =>
  createHash('sha256')
    .update(JSON.stringify(parseGuardAccessState(state)))
    .digest('hex');

/** Normal permission mutations retain all identifiers; deletion tombstones are permanent until a separately approved retention tool exists. */
export function guardAccessTransition(before: GuardAccessState, after: GuardAccessState) {
  const accounts = new Map(after.accounts.map((a) => [a.id, a])),
    devices = new Map(after.devices.map((d) => [d.id, d])),
    invites = new Map(after.invites.map((i) => [i.id, i]));
  for (const old of before.accounts) {
    const next = accounts.get(old.id);
    ensure(
      next &&
        next.meteringId === old.meteringId &&
        next.revision === old.revision + (next.status === old.status ? 0 : 1),
      'GUARD_STATE_REGRESSION',
    );
  }
  const existing = new Set(before.accounts.map((a) => a.id));
  ensure(
    after.accounts.every((a) => existing.has(a.id) || a.revision === 1),
    'GUARD_STATE_REGRESSION',
  );
  for (const old of before.devices) {
    const next = devices.get(old.id);
    ensure(next && next.playerId === old.playerId && (!old.revoked || next.revoked), 'GUARD_STATE_REGRESSION');
  }
  for (const old of before.invites) {
    const next = invites.get(old.id);
    ensure(
      next && next.playerId === old.playerId && (!old.revoked || next.revoked) && (!old.consumed || next.consumed),
      'GUARD_STATE_REGRESSION',
    );
  }
  ensure(
    before.tombstones.every((id) => after.tombstones.includes(id)),
    'GUARD_STATE_REGRESSION',
  );
  for (const id of after.tombstones) {
    ensure(
      accounts.get(id)?.status === 'suspended' &&
        after.devices.every((d) => d.playerId !== id || d.revoked) &&
        after.invites.every((i) => i.playerId !== id || i.revoked),
      'GUARD_TOMBSTONE_CONFLICT',
    );
  }
}

/** Snapshot the current business permissions, not a filesystem/backup snapshot. Tombstones come from the independent guard, never caller JSON. */
export function snapshotGuardAccess(store: BusinessStore, tombstones: readonly string[]): GuardAccessState {
  return parseGuardAccessState({
    accounts: store.all(
      'SELECT player_id id,metering_id meteringId,status,revision FROM beta_accounts ORDER BY player_id LIMIT 4097',
    ),
    devices: store
      .all<{ id: string; playerId: string; revoked: number }>(
        'SELECT id,player_id playerId,revoked_at IS NOT NULL revoked FROM api_devices ORDER BY id LIMIT 4097',
      )
      .map((d) => ({ ...d, revoked: Boolean(d.revoked) })),
    invites: store
      .all<{
        id: string;
        playerId: string | null;
        revoked: number;
        consumed: number;
      }>(`SELECT b.id,p.target_player_id playerId,b.revoked_at IS NOT NULL revoked,p.consumed_device_id IS NOT NULL consumed
      FROM beta_invites b JOIN pairing_invites p ON p.token_hash=b.token_hash ORDER BY b.id LIMIT 4097`)
      .map((i) => ({ ...i, revoked: Boolean(i.revoked), consumed: Boolean(i.consumed) })),
    tombstones: [...tombstones],
  });
}
