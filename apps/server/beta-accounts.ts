import { createHash, randomBytes, randomUUID } from 'node:crypto';
import release from '../../config/beta-release.json' with { type: 'json' };
import type { Clock } from '../../packages/contracts/index.ts';
import type { AccountStatusInput, AdminPlayerAccount, BetaPairInput, BetaRelease } from '../../packages/contracts/beta.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { betaAccessTransaction } from './beta-access-transactions.ts';

const hash = (kind: string, value: string) => createHash('sha256').update(kind + '\0' + value).digest('hex');
const isSecret = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n)), 'INVALID_REQUEST');
}
function text(value: unknown, max: number): asserts value is string {
  ensure(typeof value === 'string' && value === value.trim() && value.length > 0 && [...value].length <= max && !/[\u0000-\u001f\u007f]/u.test(value), 'INVALID_REQUEST');
}
function identifier(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'INVALID_REQUEST');
}
export function playerSuspended(store: Store, playerId: string): boolean {
  return store.beta && !!store.get("SELECT 1 FROM beta_accounts WHERE player_id=? AND status='suspended'", playerId);
}

/** Trusted operator service. Player routes expose only pair and the current player's nickname. */
export class BetaAccounts {
  readonly store: Store;
  readonly clock: Clock;
  constructor(store: Store, clock: Clock) { ensure(store.beta, 'BETA_DISABLED'); this.store = store; this.clock = clock; }
  get release(): BetaRelease {
    const row = this.store.get<{ instance_id: string }>('SELECT instance_id FROM beta_instance WHERE singleton=1');
    ensure(row, 'BETA_IDENTITY_MISSING');
    return { channel: 'beta', version: release.version, label: release.label, instanceId: row.instance_id };
  }
  issueInvite(label: string, targetPlayerId: string | null = null, ttlMs = 30 * 60_000) {
    text(label, 80);
    ensure(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= 86_400_000, 'INVALID_INVITE_TTL');
    return betaAccessTransaction(this.store, this.clock, () => {
      if (targetPlayerId !== null) ensure(this.account(targetPlayerId).status === 'active', 'ACCOUNT_SUSPENDED');
      const inviteToken = randomBytes(32).toString('base64url'), id = randomUUID(), now = this.clock.now();
      this.store.run('INSERT INTO pairing_invites(token_hash,created_at,expires_at,target_player_id) VALUES (?,?,?,?)', hash('invite', inviteToken), now, now + ttlMs, targetPlayerId);
      this.store.run('INSERT INTO beta_invites VALUES (?,?,?,NULL)', hash('invite', inviteToken), id, label);
      return { id, inviteToken, expiresAt: now + ttlMs, release: this.release };
    });
  }
  revokeInvite(id: string) {
    return betaAccessTransaction(this.store, this.clock, () => {
      ensure(this.store.get('SELECT 1 FROM beta_invites WHERE id=?', id), 'NOT_FOUND');
      this.store.run('UPDATE beta_invites SET revoked_at=? WHERE id=? AND revoked_at IS NULL', this.clock.now(), id);
      return { id, revoked: true as const };
    });
  }
  invites() {
    return this.store.all<{ id: string; label: string; expiresAt: number; revokedAt: number | null; consumed: number; targetPlayerId: string | null }>(
      `SELECT b.id,b.label,p.expires_at expiresAt,b.revoked_at revokedAt,p.consumed_device_id IS NOT NULL consumed,p.target_player_id targetPlayerId
       FROM beta_invites b JOIN pairing_invites p ON p.token_hash=b.token_hash ORDER BY p.created_at DESC,b.id DESC LIMIT 100`)
      .map(row => ({ ...row, consumed: !!row.consumed }));
  }
  pair(value: unknown) {
    fields(value, ['inviteToken', 'deviceSecret', 'deviceName', 'channel', 'instanceId', 'nickname']);
    ensure(value.channel === 'beta' && value.instanceId === this.release.instanceId, 'CHANNEL_MISMATCH');
    ensure(isSecret(value.inviteToken) && isSecret(value.deviceSecret), 'INVALID_INVITE');
    text(value.deviceName, 80); text(value.nickname, 40);
    const input = value as unknown as BetaPairInput;
    return betaAccessTransaction(this.store, this.clock, () => {
      const invite = this.store.get<{ expires_at: number; target_player_id: string | null; consumed_device_id: string | null; claim_hash: string | null; revoked_at: number | null }>(
        'SELECT p.*,b.revoked_at FROM pairing_invites p JOIN beta_invites b ON b.token_hash=p.token_hash WHERE p.token_hash=?', hash('invite', input.inviteToken));
      ensure(invite, 'INVALID_INVITE'); ensure(invite.revoked_at === null, 'INVITE_REVOKED');
      const secretHash = hash('device', input.deviceSecret);
      const claimHash = hash('beta-claim', JSON.stringify([secretHash, input.deviceName, input.nickname, input.instanceId]));
      if (invite.consumed_device_id) {
        ensure(invite.claim_hash === claimHash, 'INVITE_ALREADY_USED');
        const device = this.store.get<{ player_id: string }>('SELECT player_id FROM api_devices WHERE id=? AND secret_hash=? AND revoked_at IS NULL', invite.consumed_device_id, secretHash);
        ensure(device, 'INVITE_ALREADY_USED'); ensure(this.account(device.player_id).status === 'active', 'ACCOUNT_SUSPENDED');
        return { deviceId: invite.consumed_device_id, release: this.release };
      }
      ensure(invite.expires_at > this.clock.now(), 'INVITE_EXPIRED');
      ensure(!this.store.get('SELECT 1 FROM api_devices WHERE secret_hash=?', secretHash), 'DEVICE_SECRET_ALREADY_USED');
      const now = this.clock.now(), playerId = invite.target_player_id ?? randomUUID(), deviceId = randomUUID();
      if (invite.target_player_id) ensure(this.account(playerId).status === 'active', 'ACCOUNT_SUSPENDED');
      else {
        this.store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
        this.store.run("INSERT INTO beta_accounts VALUES (?,?,?,?, 'active',1,NULL)", playerId, randomUUID(), input.nickname, now);
      }
      // Recovery adds a device to the original account; it never renames it or creates another ledger/world.
      this.store.run('INSERT INTO api_devices VALUES (?,?,?,?,?,NULL)', deviceId, playerId, secretHash, input.deviceName, now);
      this.store.run('UPDATE pairing_invites SET consumed_device_id=?,claim_hash=? WHERE token_hash=?', deviceId, claimHash, hash('invite', input.inviteToken));
      return { deviceId, release: this.release };
    });
  }
  account(playerId: string): AdminPlayerAccount {
    const row = this.store.get<AdminPlayerAccount>(`SELECT player_id playerId,metering_id meteringId,nickname,status,revision,created_at createdAt,suspended_at suspendedAt
      FROM beta_accounts WHERE player_id=?`, playerId);
    ensure(row, 'UNKNOWN_PLAYER'); return row;
  }
  list() {
    return this.store.all<AdminPlayerAccount>(`SELECT player_id playerId,metering_id meteringId,nickname,status,revision,created_at createdAt,suspended_at suspendedAt
      FROM beta_accounts ORDER BY created_at,player_id LIMIT 100`);
  }
  devices(playerId: string, afterDevice: string | null = null) {
    identifier(playerId); if (afterDevice !== null) identifier(afterDevice); this.account(playerId);
    const rows = this.store.all<{ deviceId: string; deviceName: string; createdAt: number; revokedAt: number | null }>(
      `SELECT id deviceId,name deviceName,created_at createdAt,revoked_at revokedAt FROM api_devices
       WHERE player_id=? AND (? IS NULL OR id>?) ORDER BY id LIMIT 101`, playerId, afterDevice, afterDevice);
    const devices = rows.slice(0, 100);
    return { playerId, devices, nextAfter: rows.length > 100 ? devices.at(-1)!.deviceId : null };
  }
  revokeDevice(playerId: string, deviceId: string) {
    identifier(playerId); identifier(deviceId);
    return betaAccessTransaction(this.store, this.clock, () => {
      this.account(playerId);
      const device = this.store.get<{ revokedAt: number | null }>('SELECT revoked_at revokedAt FROM api_devices WHERE player_id=? AND id=?', playerId, deviceId);
      ensure(device, 'NOT_FOUND');
      const revokedAt = device.revokedAt ?? this.clock.now();
      this.store.run('UPDATE api_devices SET revoked_at=? WHERE player_id=? AND id=? AND revoked_at IS NULL', revokedAt, playerId, deviceId);
      return { playerId, deviceId, revoked: true as const, revokedAt };
    });
  }
  setStatus(playerId: string, value: unknown) {
    fields(value, ['requestId', 'expectedRevision', 'status']);
    ensure(typeof value.requestId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value.requestId), 'INVALID_REQUEST');
    ensure(Number.isSafeInteger(value.expectedRevision) && Number(value.expectedRevision) > 0 && typeof value.status === 'string' && ['active', 'suspended'].includes(value.status), 'INVALID_REQUEST');
    const input = value as unknown as AccountStatusInput, request = JSON.stringify([input.expectedRevision, input.status]);
    return betaAccessTransaction(this.store, this.clock, () => {
      const receipt = this.store.get<{ request_json: string; result_json: string }>('SELECT request_json,result_json FROM beta_account_receipts WHERE player_id=? AND request_id=?', playerId, input.requestId);
      if (receipt) { ensure(receipt.request_json === request, 'IDEMPOTENCY_CONFLICT'); return { account: JSON.parse(receipt.result_json) as AdminPlayerAccount, duplicate: true }; }
      const current = this.account(playerId); ensure(current.revision === input.expectedRevision, 'ACCOUNT_REVISION_CONFLICT');
      if (current.status !== input.status) this.store.run('UPDATE beta_accounts SET status=?,revision=revision+1,suspended_at=? WHERE player_id=?', input.status, input.status === 'suspended' ? this.clock.now() : null, playerId);
      const account = this.account(playerId);
      this.store.run('INSERT INTO beta_account_receipts VALUES (?,?,?,?,?)', playerId, input.requestId, request, JSON.stringify(account), this.clock.now());
      return { account, duplicate: false };
    });
  }
}
