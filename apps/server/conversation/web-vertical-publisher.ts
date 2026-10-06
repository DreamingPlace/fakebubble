import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Clock, DialogueCandidate, MessageDTO } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { inspectPCM } from '../../../workers/audio/wav.ts';
import { recordDialogueMemories, validateDialogueMemoryEvidence } from '../memory/memory.ts';
import { memoryVersion } from '../memory/memory-review.ts';
import { playerContextKey } from './player-profile.ts';
import { recordRelationshipEvents, relationshipVersion } from './relationships.ts';
import { recordSceneBubble, sceneRevision, sceneState, touchScene } from './scenes.ts';
import { userStore, type UserStore } from '../platform/store-boundary.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { metricsEnabled, recordFallbackPublished } from '../admission/web-stage-metrics.ts';
import { requireCurrentInputSnapshot } from '../generation/web-input-snapshot.ts';
import type { WebPrivateAudioFiles, PrivateAudioExpectation } from '../audio/web-private-audio-files.ts';
import type { WebCoordinatorLease } from '../admission/web-stage-queue.ts';
import { checkWebV7SceneAtDispatch, readWebV7Request } from '../generation/web-v7-request.ts';
import { requireWebContent, settleWebLifetimeReservation } from '../admission/web-retention.ts';
import {
  fixedObjectScope,
  loadProviderAudio,
  providerAudioBytes,
  speechObjectScope,
  type ProviderAudioCache,
  type ProviderAudioRow,
} from '../audio/web-provider-media.ts';

const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const SYNTHETIC_TRIAL_FOOTER = '有空一定要来找我呀～';
interface Operation {
  id: string;
  principal_id: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  ip_window_id: string | null;
  metering_type: 'trial' | 'entitled';
  status: string;
  quota_state: string;
  stage_version: number;
  lease_epoch: number | null;
  lease_token: string | null;
  lease_owner: string | null;
  lease_expires_at: number | null;
  deadline_at: number;
  created_at: number;
  audio_wait_started_at: number | null;
}
interface Asset {
  ordinal: number;
  media_id: string;
  text_digest: string;
  voice_version: string;
  byte_length: number;
  sha256: string;
  duration_ms: number;
  state: string;
  segment_state: string;
  asset_eligible: number;
}
interface Footer {
  media_id: string;
  body: string;
  origin: string;
  format: string;
  byte_length: number;
  sha256: string;
  duration_ms: number;
}
type PublishedAudioScope = {
  principalId: string;
  playerId: string;
  worldId: string;
  conversationId: string;
  characterId: string;
};
export interface WebPublicationClaim {
  operationId: string;
  stageVersion: number;
  epoch: number;
  token: string;
  owner: string;
  principalId: string;
  playerId: string;
  worldId: string;
  conversationId: string;
  characterId: string;
  inputMessageId: string;
  deadlineAt: number;
}

/** Trusted internal publisher. No HTTP, real provider, or production footer registration. */
export class WebVerticalPublisher {
  private readonly files: Pick<WebPrivateAudioFiles, 'read' | 'write'> | null;
  private readonly store: WebStore;
  private readonly user: UserStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  constructor(
    store: WebStore,
    clock: Clock,
    nextId: () => string = randomUUID,
    files?: Pick<WebPrivateAudioFiles, 'read' | 'write'>,
  ) {
    this.store = store;
    this.user = userStore(store);
    this.clock = clock;
    this.nextId = nextId;
    this.files =
      files ??
      (store.get<{ user_version: number }>('PRAGMA user_version')?.user_version === 113
        ? null
        : store.webPrivateAudioFiles());
  }
  private schema() {
    return this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private coordinator(lease: WebCoordinatorLease, now: number) {
    ensure(
      [108, 109, 110, 112].includes(this.schema()) ||
        (this.schema() === 113 &&
          (this.store.providerRuntime === true ||
            this.store.get<{ file: string }>('PRAGMA database_list')?.file === '') &&
          !!this.store.get("SELECT 1 FROM sqlite_master WHERE name='web_provider_attempts'")),
      'WEB_VERTICAL_MIGRATION_REQUIRED',
    );
    const row = this.store.get<{ epoch: number; coordinator_token: string | null; coordinator_expires_at: number }>(
      'SELECT epoch,coordinator_token,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
    );
    ensure(
      row?.epoch === lease.epoch && row.coordinator_token === lease.token && row.coordinator_expires_at > now,
      'WEB_COORDINATOR_STALE',
    );
  }
  private assets(operationId: string): Asset[] {
    if (this.schema() === 113)
      return this.store.all<Asset>(
        `SELECT a.ordinal,a.media_id,a.text_digest,
      a.voice_version,a.byte_length,a.sha256,a.duration_ms,'provider_verified' AS state,
      s.state AS segment_state,1 AS asset_eligible FROM web_provider_media_assets a
      JOIN web_provider_voice_segments s ON s.operation_id=a.operation_id AND s.ordinal=a.ordinal
      WHERE a.operation_id=? ORDER BY a.ordinal`,
        operationId,
      );
    return this.store.all<Asset>(
      `SELECT a.ordinal,a.media_id,a.text_digest,a.voice_version,
      a.byte_length,a.sha256,a.duration_ms,a.state,s.state segment_state,s.asset_eligible
      FROM web_private_audio_assets a JOIN web_synthetic_voice_segments s
        ON s.operation_id=a.operation_id AND s.ordinal=a.ordinal
      WHERE a.operation_id=? ORDER BY a.ordinal`,
      operationId,
    );
  }
  private completeAssets(operationId: string) {
    if (this.schema() === 113) {
      const row = this.store.get<{ total: number; complete: number }>(
        `SELECT count(*) AS total,
        coalesce(sum(CASE WHEN s.state='complete' AND a.origin='provider'
          AND a.text_digest=s.text_digest AND a.voice_version=s.voice_version
          AND ${
            this.store.providerAudio
              ? 'a.audio_bytes IS NULL AND a.audio_ref_json IS NOT NULL'
              : 'length(a.audio_bytes)=a.byte_length'
          } THEN 1 ELSE 0 END),0) AS complete
        FROM web_provider_voice_segments s LEFT JOIN web_provider_media_assets a
          ON a.operation_id=s.operation_id AND a.ordinal=s.ordinal WHERE s.operation_id=?`,
        operationId,
      )!;
      ensure(row.total > 0 && row.total === row.complete, 'WEB_PUBLICATION_AUDIO_INCOMPLETE');
      return;
    }
    const row = this.store.get<{ total: number; complete: number }>(
      `SELECT count(*) total,
      coalesce(sum(CASE WHEN s.state='synthetic_complete' AND s.asset_eligible=1
        AND a.state='synthetic_asset_verified' AND a.origin='synthetic_test'
        AND a.text_digest=s.text_digest AND a.voice_version=s.voice_version THEN 1 ELSE 0 END),0) complete
      FROM web_synthetic_voice_segments s LEFT JOIN web_private_audio_assets a
        ON a.operation_id=s.operation_id AND a.ordinal=s.ordinal WHERE s.operation_id=?`,
      operationId,
    )!;
    ensure(row.total > 0 && row.total === row.complete, 'WEB_PUBLICATION_AUDIO_INCOMPLETE');
  }
  /** A footer fixture is prebuilt and stored once; it is never a model/speech-provider output. */
  registerSyntheticFooter(characterId: string, wav: Uint8Array) {
    ensure([108, 109, 110, 112].includes(this.schema()), 'WEB_VERTICAL_MIGRATION_REQUIRED');
    const bytes = Buffer.from(wav),
      info = inspectPCM(bytes, 60_000);
    const expected = { byteLength: bytes.length, sha256: sha256(bytes), durationMs: Math.round(info.durationMs) };
    ensure(expected.durationMs > 0 && expected.byteLength <= 6_000_000, 'WEB_FOOTER_INVALID');
    const prior = this.store.get<Footer>('SELECT * FROM web_footer_assets WHERE character_id=?', characterId);
    if (prior) {
      ensure(
        prior.origin === 'synthetic_test' &&
          prior.body === SYNTHETIC_TRIAL_FOOTER &&
          prior.sha256 === expected.sha256 &&
          prior.byte_length === expected.byteLength &&
          prior.duration_ms === expected.durationMs,
        'WEB_FOOTER_CONFLICT',
      );
      this.files!.read(prior.media_id, expected);
      return prior.media_id;
    }
    const mediaId = this.nextId();
    this.files!.write(mediaId, bytes, expected);
    return this.store.transaction(() => {
      ensure(this.store.get('SELECT 1 FROM character_templates WHERE id=?', characterId), 'WEB_CHARACTER_UNAVAILABLE');
      this.store.run(
        `INSERT INTO web_footer_assets VALUES (?,?,'synthetic_test',?,'wav_pcm16',?,?,?,?)`,
        characterId,
        mediaId,
        SYNTHETIC_TRIAL_FOOTER,
        expected.byteLength,
        expected.sha256,
        expected.durationMs,
        this.now(),
      );
      return mediaId;
    });
  }
  claim(coordinator: WebCoordinatorLease, operationId: string, owner: string): WebPublicationClaim {
    ensure(owner.length > 0, 'WEB_STAGE_OWNER_REQUIRED');
    return this.store.transaction(() => {
      const now = this.now();
      this.coordinator(coordinator, now);
      const op = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', operationId);
      ensure(
        op &&
          op.status === 'audio_pending' &&
          op.quota_state === 'reserved' &&
          op.deadline_at > now &&
          op.audio_wait_started_at === null,
        'WEB_PUBLICATION_NOT_READY',
      );
      requireWebContent(this.store, this.clock, op.principal_id, op.world_id);
      this.completeAssets(operationId);
      const candidateTable = this.schema() === 113 ? 'web_provider_candidates' : 'web_v7_candidates';
      ensure(
        this.store.get(`SELECT 1 FROM ${candidateTable} WHERE operation_id=?`, operationId) &&
          !this.store.get(
            `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND
          (dispatch_state!='known' OR outcome!='succeeded')`,
            operationId,
          ),
        'WEB_PUBLICATION_NOT_READY',
      );
      const player = this.store.get<{ player_id: string }>(
        'SELECT player_id FROM web_principals WHERE id=? AND world_id=?',
        op.principal_id,
        op.world_id,
      );
      ensure(player, 'WEB_PUBLICATION_SCOPE_INVALID');
      const token = this.nextId(),
        until = Math.min(now + WEB_LIMITS.audioLeaseMs, op.deadline_at);
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='ready_to_publish',stage_version=stage_version+1,
        lease_epoch=?,lease_token=?,lease_owner=?,lease_expires_at=? WHERE id=?
        AND status='audio_pending' AND stage_version=? AND quota_state='reserved' AND deadline_at>?`,
          coordinator.epoch,
          token,
          owner,
          until,
          operationId,
          op.stage_version,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      return {
        operationId,
        stageVersion: op.stage_version + 1,
        epoch: coordinator.epoch,
        token,
        owner,
        principalId: op.principal_id,
        playerId: player.player_id,
        worldId: op.world_id,
        conversationId: op.conversation_id,
        characterId: op.character_id,
        inputMessageId: op.input_message_id,
        deadlineAt: op.deadline_at,
      };
    });
  }
  /**
   * Claim the reviewed text candidate for publication as text bubbles. Only for an operation whose voice stage
   * was given up (audio_wait or rate_limited, recorded durably) and that holds no open provider attempt.
   */
  claimTextFallback(coordinator: WebCoordinatorLease, operationId: string, owner: string): WebPublicationClaim {
    ensure(owner.length > 0 && metricsEnabled(this.store), 'WEB_STAGE_OWNER_REQUIRED');
    return this.store.transaction(() => {
      const now = this.now();
      this.coordinator(coordinator, now);
      const op = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', operationId);
      ensure(
        op &&
          (op.status === 'text_ready' || op.status === 'audio_pending') &&
          op.quota_state === 'reserved' &&
          op.deadline_at > now &&
          op.audio_wait_started_at === null &&
          this.store.get(
            `SELECT 1 FROM web_operation_metrics WHERE operation_id=? AND fallback_reason IS NOT NULL AND fallback_used=0`,
            operationId,
          ),
        'WEB_PUBLICATION_NOT_READY',
      );
      requireWebContent(this.store, this.clock, op.principal_id, op.world_id);
      ensure(
        this.store.get('SELECT 1 FROM web_provider_candidates WHERE operation_id=?', operationId) &&
          !this.store.get(
            `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND dispatch_state!='known'`,
            operationId,
          ),
        'WEB_PUBLICATION_NOT_READY',
      );
      const player = this.store.get<{ player_id: string }>(
        'SELECT player_id FROM web_principals WHERE id=? AND world_id=?',
        op.principal_id,
        op.world_id,
      );
      ensure(player, 'WEB_PUBLICATION_SCOPE_INVALID');
      const token = this.nextId(),
        until = Math.min(now + WEB_LIMITS.audioLeaseMs, op.deadline_at);
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='ready_to_publish',stage_version=stage_version+1,
        lease_epoch=?,lease_token=?,lease_owner=?,lease_expires_at=? WHERE id=?
        AND status IN ('text_ready','audio_pending') AND stage_version=? AND quota_state='reserved' AND deadline_at>?`,
          coordinator.epoch,
          token,
          owner,
          until,
          operationId,
          op.stage_version,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      return {
        operationId,
        stageVersion: op.stage_version + 1,
        epoch: coordinator.epoch,
        token,
        owner,
        principalId: op.principal_id,
        playerId: player.player_id,
        worldId: op.world_id,
        conversationId: op.conversation_id,
        characterId: op.character_id,
        inputMessageId: op.input_message_id,
        deadlineAt: op.deadline_at,
      };
    });
  }
  /** The reviewed text only, as text bubbles (no new generation, no audio). */
  publishTextFallback(claim: WebPublicationClaim) {
    return this.publish(claim, undefined, 'text_fallback');
  }
  /** Expired publish claims never imply an external resend; intact assets may be reclaimed. */
  recover(coordinator: WebCoordinatorLease, operationId: string) {
    return this.store.transaction(() => {
      const now = this.now();
      this.coordinator(coordinator, now);
      const op = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', operationId);
      ensure(
        op &&
          op.status === 'ready_to_publish' &&
          op.quota_state === 'reserved' &&
          (op.lease_expires_at === null || op.lease_expires_at <= now || op.lease_epoch !== coordinator.epoch),
        'WEB_STAGE_STALE',
      );
      requireWebContent(this.store, this.clock, op.principal_id, op.world_id);
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='audio_pending',stage_version=stage_version+1,
        lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='ready_to_publish' AND stage_version=?`,
          operationId,
          op.stage_version,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
    });
  }
  private publicationScope(claim: WebPublicationClaim, op: Operation) {
    ensure(
      op.id === claim.operationId &&
        op.principal_id === claim.principalId &&
        op.world_id === claim.worldId &&
        op.conversation_id === claim.conversationId &&
        op.character_id === claim.characterId &&
        op.input_message_id === claim.inputMessageId &&
        op.deadline_at === claim.deadlineAt,
      'WEB_PUBLICATION_SCOPE_INVALID',
    );
    return {
      playerId: claim.playerId,
      worldId: claim.worldId,
      conversationId: claim.conversationId,
      characterId: claim.characterId,
    };
  }
  private preflight(claim: WebPublicationClaim, audio?: ProviderAudioCache) {
    requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
    const assets = this.assets(claim.operationId);
    this.completeAssets(claim.operationId);
    for (const asset of assets) {
      if (this.schema() === 113) {
        const row = this.store.get<ProviderAudioRow>(
          `SELECT *
          FROM web_provider_media_assets WHERE operation_id=? AND ordinal=? AND media_id=?`,
          claim.operationId,
          asset.ordinal,
          asset.media_id,
        );
        const bytes = row ? providerAudioBytes(row, audio) : null;
        ensure(
          bytes &&
            sha256(bytes) === asset.sha256 &&
            bytes.length === asset.byte_length &&
            Math.round(inspectPCM(bytes, 60_000).durationMs) === asset.duration_ms,
          'WEB_PRIVATE_AUDIO_INTEGRITY',
        );
      } else
        this.files!.read(asset.media_id, {
          byteLength: asset.byte_length,
          sha256: asset.sha256,
          durationMs: asset.duration_ms,
        });
    }
    const principal = this.store.get<{ kind: string; trial_used: number; trial_reserved: number }>(
      'SELECT kind,trial_used,trial_reserved FROM web_principals WHERE id=?',
      claim.principalId,
    );
    ensure(principal, 'WEB_PUBLICATION_SCOPE_INVALID');
    const op = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', claim.operationId);
    ensure(op, 'WEB_OPERATION_NOT_FOUND');
    const footer =
      principal.kind === 'guest' && op.metering_type === 'trial' && principal.trial_used === 2
        ? this.schema() === 113
          ? this.store.get<Footer>(
              `SELECT media_id,body,origin,'wav_pcm16' AS format,
        byte_length,sha256,duration_ms FROM web_provider_footer_assets
        WHERE character_id=? AND voice_version=(SELECT voice_version FROM web_v7_requests WHERE operation_id=?)`,
              claim.characterId,
              claim.operationId,
            )
          : this.store.get<Footer>('SELECT * FROM web_footer_assets WHERE character_id=?', claim.characterId)
        : undefined;
    if (principal.kind === 'guest' && op.metering_type === 'trial' && principal.trial_used === 2)
      ensure(
        footer?.origin === (this.schema() === 113 ? 'operator_approved' : 'synthetic_test') &&
          footer.body === SYNTHETIC_TRIAL_FOOTER,
        'WEB_FOOTER_NOT_READY',
      );
    if (footer) {
      if (this.schema() === 113) {
        const row = this.store.get<ProviderAudioRow>(
          'SELECT * FROM web_provider_footer_assets WHERE media_id=?',
          footer.media_id,
        );
        const bytes = row ? providerAudioBytes(row, audio) : null;
        ensure(
          bytes &&
            sha256(bytes) === footer.sha256 &&
            bytes.length === footer.byte_length &&
            Math.round(inspectPCM(bytes, 60_000).durationMs) === footer.duration_ms,
          'WEB_FOOTER_INVALID',
        );
      } else
        this.files!.read(footer.media_id, {
          byteLength: footer.byte_length,
          sha256: footer.sha256,
          durationMs: footer.duration_ms,
        });
    }
    return { assets, footer };
  }
  async publishAsync(claim: WebPublicationClaim, audio: ProviderAudioCache = new Map()) {
    if (this.store.providerAudio) {
      const authorize = async () => {
        requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
      };
      for (const asset of this.assets(claim.operationId)) {
        const row = this.store.get<ProviderAudioRow>(
          `SELECT * FROM web_provider_media_assets
          WHERE operation_id=? AND ordinal=? AND media_id=?`,
          claim.operationId,
          asset.ordinal,
          asset.media_id,
        );
        ensure(row, 'WEB_PRIVATE_AUDIO_INTEGRITY');
        await loadProviderAudio(
          this.store,
          row,
          speechObjectScope(this.store, claim.operationId, asset.ordinal, claim),
          authorize,
          audio,
        );
      }
      const principal = this.store.get<{ kind: string; trial_used: number }>(
        'SELECT kind,trial_used FROM web_principals WHERE id=?',
        claim.principalId,
      );
      const operation = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', claim.operationId);
      if (principal?.kind === 'guest' && principal.trial_used === 2 && operation?.metering_type === 'trial') {
        const footer = this.store.get<ProviderAudioRow & { voice_version: string }>(
          `SELECT * FROM web_provider_footer_assets
          WHERE character_id=? AND voice_version=(SELECT voice_version FROM web_v7_requests WHERE operation_id=?)`,
          claim.characterId,
          claim.operationId,
        );
        ensure(footer, 'WEB_FOOTER_NOT_READY');
        await loadProviderAudio(
          this.store,
          footer,
          fixedObjectScope(this.store, 'footer', claim.characterId, footer.voice_version),
          authorize,
          audio,
        );
      }
    }
    return this.publish(claim, audio);
  }
  publish(claim: WebPublicationClaim, audio?: ProviderAudioCache, mode: 'voice' | 'text_fallback' = 'voice') {
    const fallback = mode === 'text_fallback';
    requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
    const published = this.store.get<{ receipt_json: string }>(
      `SELECT receipt_json FROM web_publications
      WHERE operation_id=? AND principal_id=? AND player_id=? AND world_id=? AND conversation_id=?
        AND character_id=? AND input_message_id=?`,
      claim.operationId,
      claim.principalId,
      claim.playerId,
      claim.worldId,
      claim.conversationId,
      claim.characterId,
      claim.inputMessageId,
    );
    if (published)
      return JSON.parse(published.receipt_json) as {
        operationId: string;
        messageIds: string[];
        footerMessageId: string | null;
      };
    // Filesystem work is outside the short publication transaction.
    const checked = fallback
      ? { assets: [] as ReturnType<WebVerticalPublisher['assets']>, footer: undefined }
      : this.preflight(claim, audio);
    return this.store.transaction(() => {
      const now = this.now();
      requireWebContent(this.store, this.clock, claim.principalId, claim.worldId);
      const prior = this.store.get<{ receipt_json: string }>(
        `SELECT receipt_json FROM web_publications
        WHERE operation_id=? AND principal_id=? AND player_id=? AND world_id=? AND conversation_id=?
          AND character_id=? AND input_message_id=?`,
        claim.operationId,
        claim.principalId,
        claim.playerId,
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.inputMessageId,
      );
      if (prior) {
        return JSON.parse(prior.receipt_json) as {
          operationId: string;
          messageIds: string[];
          footerMessageId: string | null;
        };
      }
      const scheduler = this.store.get<{ epoch: number; coordinator_expires_at: number }>(
        'SELECT epoch,coordinator_expires_at FROM web_scheduler_state WHERE singleton=1',
      );
      ensure(scheduler?.epoch === claim.epoch && scheduler.coordinator_expires_at > now, 'WEB_COORDINATOR_STALE');
      const op = this.store.get<Operation>('SELECT * FROM web_operations WHERE id=?', claim.operationId);
      ensure(
        op &&
          op.status === 'ready_to_publish' &&
          op.quota_state === 'reserved' &&
          op.stage_version === claim.stageVersion &&
          op.lease_epoch === claim.epoch &&
          op.lease_token === claim.token &&
          op.lease_owner === claim.owner &&
          op.lease_expires_at !== null &&
          op.lease_expires_at > now &&
          op.deadline_at > now,
        'WEB_STAGE_STALE',
      );
      const scope = this.publicationScope(claim, op);
      const principal = this.store.get<{ kind: string; player_id: string; trial_used: number; trial_reserved: number }>(
        'SELECT * FROM web_principals WHERE id=? AND world_id=?',
        claim.principalId,
        claim.worldId,
      );
      ensure(
        principal &&
          principal.player_id === claim.playerId &&
          (principal.kind === 'guest' ||
            (principal.kind === 'account' &&
              this.store.get('SELECT 1 FROM web_accounts WHERE principal_id=? AND active=1', claim.principalId)) ||
            (principal.kind === 'invite' &&
              [111, 112, 113].includes(
                this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
              ) &&
              requireWebContent(this.store, this.clock, claim.principalId, claim.worldId))),
        'WEB_PUBLICATION_ENTITLEMENT_CHANGED',
      );
      const snapshot = requireCurrentInputSnapshot(this.store, {
        operation_id: claim.operationId,
        principal_id: claim.principalId,
        world_id: claim.worldId,
        conversation_id: claim.conversationId,
        character_id: claim.characterId,
        input_message_id: claim.inputMessageId,
      });
      const { request, row } = readWebV7Request(this.store, claim.operationId);
      for (const message of request.messages) {
        const current = this.store.get<{
          body: string;
          author_kind: string;
          author_id: string;
          delivery: string;
          media_id: string | null;
        }>(
          `SELECT body,author_kind,author_id,delivery,media_id
          FROM messages WHERE id=? AND world_id=? AND conversation_id=?`,
          message.id,
          claim.worldId,
          claim.conversationId,
        );
        ensure(
          current &&
            current.body === message.text &&
            current.author_kind === message.authorKind &&
            current.author_id === message.authorId &&
            current.delivery === message.delivery &&
            current.media_id === message.mediaId,
          'WEB_PUBLICATION_CONTEXT_CHANGED',
        );
        if (message.id !== claim.inputMessageId)
          ensure(
            message.authorKind === 'character'
              ? this.store.get(
                  `SELECT 1 FROM web_publication_items i JOIN web_publications p
            ON p.operation_id=i.operation_id WHERE i.message_id=? AND i.origin='narrative'
            AND p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?
            AND p.character_id=?`,
                  message.id,
                  claim.principalId,
                  claim.playerId,
                  claim.worldId,
                  claim.conversationId,
                  claim.characterId,
                )
              : this.store.get(
                  `SELECT 1 FROM web_publications p
            WHERE p.input_message_id=? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
              AND p.conversation_id=? AND p.character_id=?`,
                  message.id,
                  claim.principalId,
                  claim.playerId,
                  claim.worldId,
                  claim.conversationId,
                  claim.characterId,
                ),
            'WEB_PUBLICATION_CONTEXT_SOURCE_CHANGED',
          );
      }
      ensure(
        row.principal_id === claim.principalId &&
          row.player_id === claim.playerId &&
          row.voice_version.length > 0 &&
          row.memory_version === memoryVersion(this.user, scope) &&
          row.player_context_key === playerContextKey(this.user, scope) &&
          row.relationship_version === relationshipVersion(this.user, scope) &&
          row.scene_revision === sceneRevision(this.user, scope) &&
          JSON.stringify(request.sceneContext) === JSON.stringify(sceneState(this.user, scope, now)),
        'WEB_PUBLICATION_MATERIAL_CHANGED',
      );
      const stored = this.store.get<{
        request_digest: string;
        candidate_json: string;
        candidate_digest: string;
        origin: string;
      }>(
        this.schema() === 113
          ? `SELECT *, 'provider' AS origin FROM web_provider_candidates
          WHERE operation_id=?`
          : 'SELECT * FROM web_v7_candidates WHERE operation_id=?',
        claim.operationId,
      );
      ensure(
        stored &&
          stored.origin === (this.schema() === 113 ? 'provider' : 'synthetic_test') &&
          stored.request_digest === row.request_digest &&
          sha256(stored.candidate_json) === stored.candidate_digest,
        'WEB_PUBLICATION_CANDIDATE_INVALID',
      );
      const candidate = JSON.parse(stored.candidate_json) as DialogueCandidate;
      checkWebV7SceneAtDispatch(this.store, claim.operationId, now);
      ensure(
        (fallback || candidate.bubbles.length === checked.assets.length) &&
          candidate.bubbles.length > 0 &&
          candidate.coveredMessageIds.every((id) => request.requiredMessageIds.includes(id)) &&
          candidate.deferredMessageIds.every((id) => request.requiredMessageIds.includes(id)) &&
          candidate.topics.every((topic) =>
            topic.evidenceMessageIds.every((id) => request.messages.some((message) => message.id === id)),
          ),
        'WEB_PUBLICATION_CANDIDATE_INVALID',
      );
      if (!fallback) this.completeAssets(claim.operationId);
      for (const [ordinal, asset] of checked.assets.entries()) {
        const current = this.assets(claim.operationId)[ordinal];
        ensure(
          current &&
            current.ordinal === ordinal &&
            current.media_id === asset.media_id &&
            current.sha256 === asset.sha256 &&
            current.byte_length === asset.byte_length &&
            current.duration_ms === asset.duration_ms &&
            current.state === (this.schema() === 113 ? 'provider_verified' : 'synthetic_asset_verified') &&
            current.segment_state === (this.schema() === 113 ? 'complete' : 'synthetic_complete') &&
            current.asset_eligible === 1 &&
            current.text_digest === sha256(candidate.bubbles[ordinal]!.text) &&
            current.voice_version === row.voice_version,
          'WEB_PUBLICATION_AUDIO_CHANGED',
        );
      }
      ensure(
        !this.store.get(
          fallback
            ? `SELECT 1 FROM web_external_attempts WHERE operation_id=? AND dispatch_state!='known'`
            : `SELECT 1 FROM web_external_attempts WHERE operation_id=?
        AND (dispatch_state!='known' OR outcome!='succeeded')`,
          claim.operationId,
        ) &&
          (fallback ||
            this.store.get<{ n: number }>(
              `SELECT count(*) n FROM ${
                this.schema() === 113 ? 'web_provider_attempts' : 'web_external_attempts'
              } WHERE operation_id=?
          AND ${this.schema() === 113 ? '' : "stage='audio' AND"} phase='speech' AND
          ${this.schema() === 113 ? "state='known'" : "dispatch_state='known'"} AND outcome='succeeded'`,
              claim.operationId,
            )?.n === checked.assets.length),
        'WEB_PUBLICATION_RECEIPTS_INCOMPLETE',
      );
      const speech = this.store.all<{ ordinal: number; receipt_json: string }>(
        `SELECT ordinal,receipt_json
        FROM ${this.schema() === 113 ? 'web_provider_attempts' : 'web_external_attempts'}
        WHERE operation_id=? AND ${this.schema() === 113 ? '' : "stage='audio' AND"} phase='speech'
        ORDER BY ordinal`,
        claim.operationId,
      );
      ensure(
        fallback ||
          speech.every((attempt, ordinal) => {
            if (attempt.ordinal !== ordinal) return false;
            try {
              return (
                this.schema() === 113 ||
                (JSON.parse(attempt.receipt_json) as { origin?: string }).origin === 'synthetic_test'
              );
            } catch {
              return false;
            }
          }),
        'WEB_PUBLICATION_RECEIPTS_INCOMPLETE',
      );
      // A text fallback has no voice at all this round, so the prerecorded voice footer is not sent either.
      const footerRequired =
        !fallback && principal.kind === 'guest' && op.metering_type === 'trial' && principal.trial_used === 2;
      const footer = footerRequired
        ? this.schema() === 113
          ? this.store.get<Footer>(
              `SELECT media_id,body,origin,'wav_pcm16' AS format,byte_length,sha256,
          duration_ms FROM web_provider_footer_assets WHERE character_id=? AND voice_version=?`,
              claim.characterId,
              row.voice_version,
            )
          : this.store.get<Footer>('SELECT * FROM web_footer_assets WHERE character_id=?', claim.characterId)
        : undefined;
      ensure(
        !footerRequired ||
          (footer &&
            checked.footer &&
            footer.media_id === checked.footer.media_id &&
            footer.sha256 === checked.footer.sha256 &&
            footer.body === SYNTHETIC_TRIAL_FOOTER),
        'WEB_FOOTER_NOT_READY',
      );
      // Compatibility record exists only at successful publication; old workers never lease it.
      this.store.run(
        `INSERT INTO jobs(id,world_id,conversation_id,character_id,kind,epoch,status,
        created_at,lease_until,covered_ids_json,requested_delivery,published_message_id,
        memory_version,player_context_key,relationship_version,scene_revision)
        VALUES (?,?,?,?,'reply',?,'published',?,?,?,'voice',NULL,?,?,?,?)`,
        claim.operationId,
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.epoch,
        op.created_at,
        now,
        JSON.stringify([claim.inputMessageId]),
        row.memory_version,
        row.player_context_key,
        row.relationship_version,
        row.scene_revision,
      );
      this.store.run(
        'INSERT INTO job_evidence_snapshots VALUES (?,?,?,?,?)',
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.operationId,
        JSON.stringify([]),
      );
      this.store.run(
        'INSERT INTO relationship_job_contexts VALUES (?,?,?,?,?)',
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.operationId,
        JSON.stringify(request.messages),
      );
      const context = request.sceneContext;
      this.store.run(
        'INSERT INTO scene_job_contexts VALUES (?,?,?,?,?,?)',
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.operationId,
        JSON.stringify(context),
        snapshot.input_seq,
      );
      validateDialogueMemoryEvidence(this.user, scope, claim.operationId, candidate);
      const published: MessageDTO[] = [],
        messageIds: string[] = [];
      for (const [ordinal, bubble] of candidate.bubbles.entries()) {
        const mediaId = fallback ? null : checked.assets[ordinal]!.media_id,
          messageId = this.nextId();
        // A fallback is stored as a text message flagged voice_fallback=1 (the existing column); no audio exists.
        this.store.run(
          `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,
          body,created_at,delivery,voice_fallback,media_id,proactive)
          VALUES (?,?,?,'character',?,? ,?,?,?,?,0)`,
          messageId,
          claim.worldId,
          claim.conversationId,
          claim.characterId,
          bubble.text,
          now,
          fallback ? 'text' : 'voice',
          fallback ? 1 : 0,
          mediaId,
        );
        this.store.run(
          'INSERT INTO dialogue_bubbles VALUES (?,?,?,?,?,?)',
          claim.worldId,
          claim.conversationId,
          claim.operationId,
          ordinal,
          messageId,
          bubble.expression,
        );
        this.store.run(
          'INSERT INTO outbox(world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)',
          claim.worldId,
          claim.conversationId,
          messageId,
          now,
        );
        messageIds.push(messageId);
        published.push({
          id: messageId,
          worldId: claim.worldId,
          conversationId: claim.conversationId,
          authorKind: 'character',
          authorId: claim.characterId,
          text: bubble.text,
          createdAt: now,
          delivery: fallback ? 'text' : 'voice',
          voiceFallback: fallback,
          mediaId,
          proactive: false,
        });
      }
      this.store.run('UPDATE jobs SET published_message_id=? WHERE id=?', messageIds[0]!, claim.operationId);
      recordSceneBubble(this.user, scope, claim.operationId, candidate, published, now);
      touchScene(this.user, scope, claim.operationId, now);
      recordDialogueMemories(this.user, scope, claim.operationId, candidate, published, [claim.inputMessageId], now);
      recordRelationshipEvents(this.user, scope, claim.operationId, candidate, published, now);
      let footerMessageId: string | null = null;
      if (footerRequired && footer) {
        footerMessageId = this.nextId();
        this.store.run(
          `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,
          body,created_at,delivery,voice_fallback,media_id,proactive)
          VALUES (?,?,?,'character',?,? ,?,'voice',0,?,0)`,
          footerMessageId,
          claim.worldId,
          claim.conversationId,
          claim.characterId,
          SYNTHETIC_TRIAL_FOOTER,
          now,
          footer.media_id,
        );
        this.store.run(
          'INSERT INTO outbox(world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)',
          claim.worldId,
          claim.conversationId,
          footerMessageId,
          now,
        );
      }
      if (op.metering_type === 'trial') {
        ensure(
          op.ip_window_id &&
            this.store.run(
              `UPDATE web_ip_windows SET reserved=reserved-1,used=used+1
          WHERE id=? AND reserved>0 AND used+reserved<=?`,
              op.ip_window_id,
              WEB_LIMITS.trialReplies,
            ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
        settleWebLifetimeReservation(this.store, op.ip_window_id!, 'used');
        ensure(
          this.store.run(
            `UPDATE web_principals SET trial_reserved=trial_reserved-1,
          trial_used=trial_used+1,revision=revision+1 WHERE id=? AND player_id=? AND world_id=?
          AND trial_reserved>0 AND trial_used+trial_reserved<=?`,
            claim.principalId,
            claim.playerId,
            claim.worldId,
            WEB_LIMITS.trialReplies,
          ).changes === 1,
          'WEB_QUOTA_STATE_INVALID',
        );
      }
      ensure(
        this.store.run(
          `UPDATE web_operations SET status='published',quota_state='used',
        stage_version=stage_version+1,lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL
        WHERE id=? AND status='ready_to_publish' AND stage_version=? AND lease_epoch=?
          AND lease_token=? AND deadline_at>? AND quota_state='reserved'`,
          claim.operationId,
          claim.stageVersion,
          claim.epoch,
          claim.token,
          now,
        ).changes === 1,
        'WEB_STAGE_STALE',
      );
      const receipt = { operationId: claim.operationId, messageIds, footerMessageId };
      this.store.run(
        `INSERT INTO web_publications VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        claim.operationId,
        claim.principalId,
        claim.playerId,
        claim.worldId,
        claim.conversationId,
        claim.characterId,
        claim.inputMessageId,
        claim.operationId,
        row.request_digest,
        stored.candidate_digest,
        now,
        JSON.stringify(receipt),
      );
      for (const [ordinal, messageId] of messageIds.entries())
        this.store.run(
          `INSERT INTO web_publication_items VALUES (?,?,?,?,?)`,
          claim.operationId,
          ordinal,
          messageId,
          fallback ? null : checked.assets[ordinal]!.media_id,
          fallback ? 'text_fallback' : 'narrative',
        );
      if (footerMessageId && footer)
        this.store.run(
          `INSERT INTO web_publication_items VALUES (?,?,?,?,'trial_footer')`,
          claim.operationId,
          messageIds.length,
          footerMessageId,
          footer.media_id,
        );
      this.store.run(
        `INSERT INTO web_user_events(principal_id,world_id,conversation_id,operation_id,
        kind,receipt_json,created_at) VALUES (?,?,?,?,'publication',?,?)`,
        claim.principalId,
        claim.worldId,
        claim.conversationId,
        claim.operationId,
        JSON.stringify(receipt),
        now,
      );
      if (fallback) recordFallbackPublished(this.store, claim.operationId);
      return receipt;
    });
  }
  /** Caller proves current identity; this method enforces the committed publication scope. */
  private providerAudioRow(scope: PublishedAudioScope, mediaId: string) {
    return this.store.get<
      ProviderAudioRow & {
        byte_length: number;
        sha256: string;
        duration_ms: number;
        origin: string;
        operation_id: string;
        ordinal: number;
        input_message_id: string;
        voice_version: string;
      }
    >(
      `SELECT coalesce(a.audio_bytes,f.audio_bytes) AS audio_bytes,
        ${this.store.providerAudio ? 'coalesce(a.audio_ref_json,f.audio_ref_json)' : 'NULL'} AS audio_ref_json,
        coalesce(a.byte_length,f.byte_length) AS byte_length,coalesce(a.sha256,f.sha256) AS sha256,
        coalesce(a.duration_ms,f.duration_ms) AS duration_ms,i.origin,p.operation_id,i.ordinal,
        p.input_message_id,r.voice_version
        FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        JOIN web_v7_requests r ON r.operation_id=p.operation_id
        LEFT JOIN web_provider_media_assets a ON a.media_id=i.media_id AND i.origin='narrative'
          AND a.principal_id=p.principal_id AND a.player_id=p.player_id AND a.world_id=p.world_id
          AND a.conversation_id=p.conversation_id AND a.character_id=p.character_id
        LEFT JOIN web_provider_footer_assets f ON f.media_id=i.media_id AND i.origin='trial_footer'
          AND f.character_id=p.character_id AND f.voice_version=r.voice_version
        WHERE i.media_id=? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
          AND p.conversation_id=? AND p.character_id=?`,
      mediaId,
      scope.principalId,
      scope.playerId,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    );
  }
  async readPublishedAudioAsync(scope: PublishedAudioScope, mediaId: string) {
    const cache: ProviderAudioCache = new Map();
    if (this.store.providerAudio) {
      const authorize = async () => {
        ensure(!webCharacterDeleted(this.store, scope.characterId), 'NOT_FOUND');
        requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
      };
      await authorize();
      const row = this.providerAudioRow(scope, mediaId);
      ensure(row, 'WEB_PUBLISHED_AUDIO_NOT_FOUND');
      const expected =
        row.origin === 'narrative'
          ? speechObjectScope(this.store, row.operation_id, row.ordinal, {
              ...scope,
              inputMessageId: row.input_message_id,
            })
          : fixedObjectScope(this.store, 'footer', scope.characterId, row.voice_version);
      await loadProviderAudio(this.store, row, expected, authorize, cache);
    }
    return this.readPublishedAudio(scope, mediaId, cache);
  }
  readPublishedAudio(scope: PublishedAudioScope, mediaId: string, audio?: ProviderAudioCache) {
    ensure(!webCharacterDeleted(this.store, scope.characterId), 'NOT_FOUND');
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    if (this.schema() === 113) {
      const row = this.providerAudioRow(scope, mediaId);
      const bytes = row ? providerAudioBytes(row, audio) : null;
      ensure(
        row &&
          bytes &&
          bytes.length === row.byte_length &&
          sha256(bytes) === row.sha256 &&
          Math.round(inspectPCM(bytes, 60_000).durationMs) === row.duration_ms,
        'WEB_PUBLISHED_AUDIO_NOT_FOUND',
      );
      ensure(!webCharacterDeleted(this.store, scope.characterId), 'NOT_FOUND');
      requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
      return bytes;
    }
    const row = this.store.get<{ byte_length: number; sha256: string; duration_ms: number }>(
      `SELECT coalesce(a.byte_length,f.byte_length) byte_length,
        coalesce(a.sha256,f.sha256) sha256,coalesce(a.duration_ms,f.duration_ms) duration_ms
        FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        LEFT JOIN web_private_audio_assets a ON a.media_id=i.media_id AND i.origin='narrative'
        LEFT JOIN web_footer_assets f ON f.media_id=i.media_id AND i.origin='trial_footer'
        WHERE i.media_id=? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
          AND p.conversation_id=? AND p.character_id=?`,
      mediaId,
      scope.principalId,
      scope.playerId,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
    );
    ensure(row && row.sha256, 'WEB_PUBLISHED_AUDIO_NOT_FOUND');
    const expected: PrivateAudioExpectation = {
      byteLength: row.byte_length,
      sha256: row.sha256,
      durationMs: row.duration_ms,
    };
    const bytes = this.files!.read(mediaId, expected);
    ensure(!webCharacterDeleted(this.store, scope.characterId), 'NOT_FOUND');
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    ensure(
      this.store.get(
        `SELECT 1 FROM web_publication_items i JOIN web_publications p
      ON p.operation_id=i.operation_id WHERE i.media_id=? AND p.principal_id=? AND p.player_id=?
      AND p.world_id=? AND p.conversation_id=? AND p.character_id=?`,
        mediaId,
        scope.principalId,
        scope.playerId,
        scope.worldId,
        scope.conversationId,
        scope.characterId,
      ),
      'WEB_PUBLISHED_AUDIO_NOT_FOUND',
    );
    return bytes;
  }

  /** Durable user cursor; the HTTP/SSE transport remains a separate task. */
  history(
    scope: { principalId: string; playerId: string; worldId: string; conversationId: string; characterId: string },
    afterSeq = 0,
    limit = 50,
  ) {
    ensure(!webCharacterDeleted(this.store, scope.characterId), 'NOT_FOUND');
    requireWebContent(this.store, this.clock, scope.principalId, scope.worldId);
    ensure(
      Number.isSafeInteger(afterSeq) && afterSeq >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'WEB_HISTORY_CURSOR_INVALID',
    );
    const events = this.store.all<{ seq: number; operation_id: string; published_at: number; receipt_json: string }>(
      `SELECT e.seq,e.operation_id,p.published_at,p.receipt_json FROM web_user_events e
      JOIN web_publications p ON p.operation_id=e.operation_id AND p.principal_id=e.principal_id
        AND p.world_id=e.world_id AND p.conversation_id=e.conversation_id
      WHERE e.seq>? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
        AND p.conversation_id=? AND p.character_id=? ORDER BY e.seq LIMIT ?`,
      afterSeq,
      scope.principalId,
      scope.playerId,
      scope.worldId,
      scope.conversationId,
      scope.characterId,
      limit,
    );
    return events.map((event) => ({
      seq: event.seq,
      operationId: event.operation_id,
      publishedAt: event.published_at,
      receipt: JSON.parse(event.receipt_json) as {
        operationId: string;
        messageIds: string[];
        footerMessageId: string | null;
      },
      input: this.store.get<{ id: string; body: string; created_at: number }>(
        `SELECT m.id,m.body,m.created_at
        FROM web_publications p JOIN messages m ON m.id=p.input_message_id
        WHERE p.operation_id=? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
          AND p.conversation_id=? AND p.character_id=?`,
        event.operation_id,
        scope.principalId,
        scope.playerId,
        scope.worldId,
        scope.conversationId,
        scope.characterId,
      ),
      items: this.store.all<{
        ordinal: number;
        message_id: string;
        // NULL only for origin 'text_fallback'; typed string so existing audio-only callers stay unchanged.
        media_id: string;
        origin: 'narrative' | 'trial_footer' | 'text_fallback';
        body: string;
        created_at: number;
      }>(
        `SELECT i.ordinal,i.message_id,i.media_id,i.origin,m.body,m.created_at
          FROM web_publication_items i JOIN messages m ON m.id=i.message_id
          JOIN web_publications p ON p.operation_id=i.operation_id
          WHERE i.operation_id=? AND p.principal_id=? AND p.player_id=? AND p.world_id=?
            AND p.conversation_id=? AND p.character_id=? ORDER BY i.ordinal`,
        event.operation_id,
        scope.principalId,
        scope.playerId,
        scope.worldId,
        scope.conversationId,
        scope.characterId,
      ),
    }));
  }
  userEvents(principalId: string, playerId: string, afterSeq = 0, limit = 100) {
    const worldId = this.store.get<{ world_id: string }>(
      'SELECT world_id FROM web_principals WHERE id=? AND player_id=?',
      principalId,
      playerId,
    )?.world_id;
    ensure(worldId, 'WEB_PUBLICATION_SCOPE_INVALID');
    requireWebContent(this.store, this.clock, principalId, worldId);
    ensure(
      Number.isSafeInteger(afterSeq) && afterSeq >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100,
      'WEB_HISTORY_CURSOR_INVALID',
    );
    return this.store
      .all<{
        seq: number;
        world_id: string;
        conversation_id: string;
        operation_id: string;
        receipt_json: string;
        created_at: number;
      }>(
        `SELECT e.* FROM web_user_events e JOIN web_publications p ON p.operation_id=e.operation_id
        AND p.principal_id=e.principal_id AND p.world_id=e.world_id
        AND p.conversation_id=e.conversation_id WHERE e.principal_id=? AND p.player_id=?
        AND e.seq>? ORDER BY e.seq LIMIT ?`,
        principalId,
        playerId,
        afterSeq,
        limit,
      )
      .map((row) => ({
        seq: row.seq,
        worldId: row.world_id,
        conversationId: row.conversation_id,
        operationId: row.operation_id,
        receipt: JSON.parse(row.receipt_json),
        createdAt: row.created_at,
      }));
  }
}
