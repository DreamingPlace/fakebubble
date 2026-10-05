import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { inspectPCM } from '../../workers/audio/wav.ts';
import type { WebStore } from './store.ts';
import { requireWebContent } from './web-retention.ts';
import type { WebCoordinatorLease } from './web-stage-queue.ts';
import { WebPrivateAudioFiles, type PrivateAudioExpectation } from './web-private-audio-files.ts';

export interface PrivateAudioScope {
  operationId: string; ordinal: number; principalId: string; playerId: string;
  worldId: string; conversationId: string; characterId: string; inputMessageId: string;
}
interface AssetRow {
  operation_id: string; ordinal: number; media_id: string; origin: 'synthetic_test';
  principal_id: string; player_id: string; world_id: string; conversation_id: string;
  character_id: string; input_message_id: string; text_digest: string; voice_version: string;
  format: 'wav_pcm16';
  byte_length: number; sha256: string; duration_ms: number;
  state: 'preparing' | 'synthetic_asset_verified';
  lease_epoch: number; lease_token: string; lease_until: number;
}
interface Preparation { mediaId: string; token: string; epoch: number; expected: PrivateAudioExpectation; verified: boolean }

/** Internal synthetic WAV staging, not a browser route, real TTS, or publication. */
export class WebSyntheticPrivateAudio {
  private readonly files: WebPrivateAudioFiles;
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  constructor(store: WebStore, clock: Clock,
    nextId: () => string = randomUUID, files?: WebPrivateAudioFiles) {
    this.store = store; this.clock = clock; this.nextId = nextId;
    this.files = files ?? new WebPrivateAudioFiles(store.root);
  }

  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  private coordinator(lease: WebCoordinatorLease, now: number) {
    ensure([107, 108, 109, 110, 112].includes(this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1),
      'WEB_PRIVATE_AUDIO_MIGRATION_REQUIRED');
    const row = this.store.get<{ epoch: number; coordinator_token: string | null; coordinator_expires_at: number }>(
      'SELECT epoch,coordinator_token,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1');
    ensure(row?.epoch === lease.epoch && row.coordinator_token === lease.token &&
      row.coordinator_expires_at > now, 'WEB_COORDINATOR_STALE');
  }

  private eligible(scope: PrivateAudioScope, now: number) {
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    const op = this.store.get<{ status: string; quota_state: string; deadline_at: number; text_digest: string;
      voice_version: string; narrative_json: string; asset_eligible: number }>(
      `SELECT o.status,o.quota_state,o.deadline_at,s.text_digest,s.voice_version,c.narrative_json,
        c.asset_eligible FROM web_operations o
        JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id AND p.player_id=?
        JOIN web_reviewed_candidates c ON c.operation_id=o.id AND c.input_message_id=o.input_message_id
        JOIN web_synthetic_voice_segments s ON s.operation_id=o.id AND s.ordinal=?
          AND s.state='synthetic_complete' AND s.asset_eligible=1
        JOIN web_external_attempts a ON a.operation_id=o.id AND a.stage='audio'
          AND a.phase='speech' AND a.ordinal=s.ordinal AND a.dispatch_state='known'
          AND a.outcome='succeeded' AND a.sent_at IS NOT NULL
        WHERE o.id=? AND o.principal_id=? AND o.world_id=? AND o.conversation_id=?
          AND o.character_id=? AND o.input_message_id=?`, scope.playerId, scope.ordinal,
      scope.operationId, scope.principalId, scope.worldId, scope.conversationId,
      scope.characterId, scope.inputMessageId);
    ensure(op && op.asset_eligible === 1 && op.quota_state === 'reserved' && op.deadline_at > now &&
      ['text_ready', 'audio_pending', 'audio_running'].includes(op.status), 'WEB_PRIVATE_AUDIO_NOT_ELIGIBLE');
    let narrative: unknown;
    try { narrative = JSON.parse(op.narrative_json); } catch { narrative = null; }
    ensure(Array.isArray(narrative) && typeof narrative[scope.ordinal] === 'string' &&
      createHash('sha256').update(narrative[scope.ordinal]).digest('hex') === op.text_digest &&
      this.store.get(`SELECT 1 FROM web_reviewed_candidates WHERE operation_id=? AND voice_version=?`,
        scope.operationId, op.voice_version), 'WEB_PRIVATE_AUDIO_NOT_ELIGIBLE');
    return { textDigest: op.text_digest, voiceVersion: op.voice_version, deadlineAt: op.deadline_at };
  }

  private existing(scope: PrivateAudioScope) {
    return this.store.get<AssetRow>(`SELECT * FROM web_private_audio_assets WHERE operation_id=? AND ordinal=?
      AND principal_id=? AND player_id=? AND world_id=? AND conversation_id=?
      AND character_id=? AND input_message_id=?`, scope.operationId, scope.ordinal,
    scope.principalId, scope.playerId, scope.worldId, scope.conversationId,
    scope.characterId, scope.inputMessageId);
  }

  private prepare(scope: PrivateAudioScope, lease: WebCoordinatorLease,
    expected?: PrivateAudioExpectation): Preparation {
    return this.store.transaction(() => {
      const now = this.now(); this.coordinator(lease, now);
      const current = this.eligible(scope, now), row = this.existing(scope);
      if (!row) {
        ensure(expected, 'WEB_PRIVATE_AUDIO_EXPECTATION_REQUIRED');
        const mediaId = this.nextId(), token = this.nextId();
        ensure(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mediaId) &&
          token.length > 0, 'WEB_PRIVATE_AUDIO_ID_INVALID');
        const leaseUntil = Math.min(now + 30_000, current.deadlineAt, lease.expiresAt);
        this.store.run(`INSERT INTO web_private_audio_assets(operation_id,ordinal,media_id,origin,
          principal_id,player_id,world_id,conversation_id,character_id,input_message_id,
          text_digest,voice_version,format,byte_length,sha256,duration_ms,state,lease_epoch,lease_token,
          lease_until,created_at) VALUES (?,?,?,'synthetic_test',?,?,?,?,?,?,?,?,'wav_pcm16',?,?,?,'preparing',?,?,?,?)`,
        scope.operationId, scope.ordinal, mediaId, scope.principalId, scope.playerId,
        scope.worldId, scope.conversationId, scope.characterId, scope.inputMessageId,
        current.textDigest, current.voiceVersion, expected.byteLength, expected.sha256,
        expected.durationMs, lease.epoch, token, leaseUntil, now);
        return { mediaId, token, epoch: lease.epoch, expected, verified: false };
      }
      ensure(row.text_digest === current.textDigest && row.voice_version === current.voiceVersion &&
        row.format === 'wav_pcm16' &&
        (!expected || (row.byte_length === expected.byteLength && row.sha256 === expected.sha256 &&
          row.duration_ms === expected.durationMs)), 'WEB_PRIVATE_AUDIO_INTENT_CONFLICT');
      const fixed = { byteLength: row.byte_length, sha256: row.sha256, durationMs: row.duration_ms };
      if (row.state === 'synthetic_asset_verified')
        return { mediaId: row.media_id, token: row.lease_token, epoch: row.lease_epoch,
          expected: fixed, verified: true };
      ensure(row.lease_until <= now || row.lease_epoch !== lease.epoch,
        'WEB_PRIVATE_AUDIO_PREPARATION_BUSY');
      const token = this.nextId(), leaseUntil = Math.min(now + 30_000, current.deadlineAt, lease.expiresAt);
      ensure(this.store.run(`UPDATE web_private_audio_assets SET lease_epoch=?,lease_token=?,lease_until=?
        WHERE operation_id=? AND ordinal=? AND state='preparing' AND lease_epoch=? AND lease_token=?`,
      lease.epoch, token, leaseUntil, scope.operationId, scope.ordinal,
      row.lease_epoch, row.lease_token).changes === 1, 'WEB_PRIVATE_AUDIO_STALE');
      return { mediaId: row.media_id, token, epoch: lease.epoch, expected: fixed, verified: false };
    });
  }

  private attach(scope: PrivateAudioScope, lease: WebCoordinatorLease, prep: Preparation) {
    return this.store.transaction(() => {
      const now = this.now(); this.coordinator(lease, now);
      ensure(prep.epoch === lease.epoch, 'WEB_PRIVATE_AUDIO_STALE');
      this.eligible(scope, now);
      const row = this.existing(scope);
      ensure(row && row.format === 'wav_pcm16' && row.state === 'preparing' && row.media_id === prep.mediaId &&
        row.lease_epoch === prep.epoch && row.lease_token === prep.token && row.lease_until > now &&
        row.byte_length === prep.expected.byteLength && row.sha256 === prep.expected.sha256 &&
        row.duration_ms === prep.expected.durationMs, 'WEB_PRIVATE_AUDIO_STALE');
      ensure(this.store.run(`UPDATE web_private_audio_assets SET state='synthetic_asset_verified',verified_at=?
        WHERE operation_id=? AND ordinal=? AND state='preparing' AND lease_epoch=? AND lease_token=?
          AND lease_until>?`, now, scope.operationId, scope.ordinal, prep.epoch, prep.token, now).changes === 1,
      'WEB_PRIVATE_AUDIO_STALE');
      return { mediaId: prep.mediaId, state: 'synthetic_asset_verified' as const };
    });
  }

  /** Byte expectation is committed before filesystem IO; failure leaves provider ledger untouched. */
  stage(scope: PrivateAudioScope, lease: WebCoordinatorLease, syntheticWav: Uint8Array) {
    ensure(syntheticWav.byteLength <= 6_000_000, 'WEB_PRIVATE_AUDIO_TOO_LARGE');
    const bytes = Buffer.from(syntheticWav);
    const info = inspectPCM(bytes, 60_000);
    const expected = { byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      durationMs: Math.round(info.durationMs) };
    ensure(expected.durationMs > 0, 'WEB_PRIVATE_AUDIO_DURATION_INVALID');
    const prep = this.prepare(scope, lease, expected);
    if (prep.verified) {
      this.files.read(prep.mediaId, prep.expected);
      return { mediaId: prep.mediaId, state: 'synthetic_asset_verified' as const };
    }
    this.files.write(prep.mediaId, bytes, prep.expected);
    return this.attach(scope, lease, prep);
  }

  /** Reconciles only a preexisting file with an unchanged intent; never regenerates audio. */
  recover(scope: PrivateAudioScope, lease: WebCoordinatorLease) {
    const prep = this.prepare(scope, lease);
    if (prep.verified) {
      this.files.read(prep.mediaId, prep.expected);
      return { mediaId: prep.mediaId, state: 'synthetic_asset_verified' as const };
    }
    this.files.durableRead(prep.mediaId, prep.expected);
    return this.attach(scope, lease, prep);
  }

  /** Caller must have established identity. This scope check is not browser authentication. */
  read(scope: PrivateAudioScope, mediaId: string) {
    const now = this.now();
    ensure([107, 108, 109, 110, 112].includes(this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1),
      'WEB_PRIVATE_AUDIO_MIGRATION_REQUIRED');
    this.eligible(scope, now);
    const row = this.existing(scope);
    ensure(row?.media_id === mediaId && row.format === 'wav_pcm16' && row.state === 'synthetic_asset_verified',
      'WEB_PRIVATE_AUDIO_NOT_FOUND');
    const bytes = this.files.read(mediaId, { byteLength: row.byte_length, sha256: row.sha256,
      durationMs: row.duration_ms });
    this.eligible(scope, this.now());
    ensure(this.existing(scope)?.media_id === mediaId, 'WEB_PRIVATE_AUDIO_NOT_FOUND');
    return bytes;
  }
}
