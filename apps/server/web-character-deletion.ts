import { randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { emptySession } from '../../packages/domain/schedule.ts';
import type { WebRuntimeStore } from './web-store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { identifier, keys, record } from './template-validation.ts';
import { publishedWebCharacters, characterProfileHash } from './web-character-catalog.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import {
  auditCharacterDeletionScope,
  operationContent,
  conversationContent,
  worldCharacterContent,
  operationScope,
  scopeArgs,
  type DeletionScope,
} from './web-character-deletion-audit.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { settleWebLifetimeReservation, webReceiptDigest } from './web-retention.ts';
import { checkAudioReference, speechObjectScope } from './web-provider-media.ts';
import type { MediaObjectReference } from './cloudflare/media-objects.ts';

type Actor = { memberId: string; sessionId: string };
type Deletion = {
  id: string;
  character_id: string;
  request_hash: string;
  state: string;
  created_at: number;
  completed_at: number | null;
  error_code: string | null;
};
export class WebCharacterDeletion {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  constructor(store: WebRuntimeStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private scopes(id: string) {
    return this.store.all<DeletionScope>(
      `SELECT p.id principal_id,c.world_id,c.id conversation_id,c.private_character_id character_id
      FROM conversations c JOIN web_principals p ON p.world_id=c.world_id
      WHERE c.kind='private' AND c.private_character_id=? ORDER BY c.world_id,c.id`,
      id,
    );
  }
  preview(id: string) {
    identifier(id);
    ensure(!webCharacterDeleted(this.store, id), 'CHARACTER_DELETED');
    const role = publishedWebCharacters(this.store).find((c) => c.characterId === id);
    ensure(role, 'NOT_FOUND');
    const scopes = this.scopes(id),
      counts = scopes.map((s) => {
        auditCharacterDeletionScope(this.store, s);
        const messages = this.store.get<{ n: number; last: number }>(
          `SELECT count(*) n,coalesce(max(seq),0) last FROM messages WHERE world_id=? AND conversation_id=?`,
          s.world_id,
          s.conversation_id,
        )!;
        const operations = this.store.get<{ n: number; pending: number }>(
          `SELECT count(*) n,coalesce(sum(status NOT IN ('published','failed','cancelled')),0) pending
        FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?`,
          ...scopeArgs(s),
        )!;
        return {
          ...s,
          messages: messages.n,
          last: messages.last,
          operations: operations.n,
          pending: operations.pending,
        };
      });
    const profileHash = characterProfileHash({ template: role.template, presentation: role.presentation });
    return {
      characterId: id,
      version: role.version,
      profileHash,
      conversations: scopes.length,
      messages: counts.reduce((n, r) => n + r.messages, 0),
      pendingOperations: counts.reduce((n, r) => n + r.pending, 0),
      previewHash: contentHash([id, role.version, profileHash, counts]),
      removes: 'all-character-chats' as const,
      retains: [
        'accounts',
        'other-characters',
        'quota-history',
        'financial-receipts',
        'unknown-calls',
        'publication-audit',
      ],
    };
  }
  start(actor: Actor, id: string, input: unknown) {
    record(input);
    keys(input, ['requestId', 'previewHash', 'acknowledgeDeleteAllChats']);
    identifier(input.requestId);
    ensure(
      input.acknowledgeDeleteAllChats === true &&
        typeof input.previewHash === 'string' &&
        /^[a-f0-9]{64}$/.test(input.previewHash),
      'CHARACTER_DELETION_ACK_REQUIRED',
    );
    const requestId = input.requestId,
      requestHash = contentHash([actor.memberId, id, input]);
    return this.store.transaction(() => {
      const prior = this.store.get<Deletion>('SELECT * FROM web_character_deletions WHERE request_id=?', requestId);
      if (prior) {
        ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
        return this.status(id);
      }
      const preview = this.preview(id);
      ensure(preview.previewHash === input.previewHash, 'DELETION_PREVIEW_CHANGED');
      const deletionId = this.nextId();
      this.store.run(
        `INSERT INTO web_character_deletions VALUES (?,?,?,?,?,?,?,?,?,'purging',NULL,NULL)`,
        deletionId,
        id,
        requestId,
        requestHash,
        preview.version,
        preview.profileHash,
        actor.memberId,
        actor.sessionId,
        this.now(),
      );
      for (const s of this.scopes(id))
        this.store.run(
          'INSERT INTO web_character_deletion_scopes VALUES (?,?,?,?,NULL,NULL)',
          deletionId,
          s.principal_id,
          s.world_id,
          s.conversation_id,
        );
      this.store.run('DELETE FROM web_character_catalog WHERE character_id=?', id);
      this.store.run('DELETE FROM web_character_drafts WHERE character_id=?', id);
      this.store.run(
        'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        actor.memberId,
        'character-delete-started',
        id,
        this.now(),
      );
      return this.status(id);
    });
  }
  status(id: string) {
    const row = this.store.get<Deletion>('SELECT * FROM web_character_deletions WHERE character_id=?', id);
    ensure(row, 'NOT_FOUND');
    const scopes = this.store.get<{ total: number; databaseCleared: number; audioCleared: number }>(
      `SELECT count(*) total,
      coalesce(sum(db_cleared_at IS NOT NULL),0) databaseCleared,coalesce(sum(audio_cleared_at IS NOT NULL),0) audioCleared
      FROM web_character_deletion_scopes WHERE deletion_id=?`,
      row.id,
    )!;
    return {
      deletionId: row.id,
      characterId: id,
      state: row.state,
      createdAt: row.created_at,
      completedAt: row.completed_at,
      errorCode: row.error_code,
      ...scopes,
    };
  }
  nextDue() {
    return this.store.get("SELECT 1 FROM web_character_deletions WHERE state='purging'") ? this.now() + 1000 : null;
  }
  async sweep(limit = 8) {
    ensure(Number.isSafeInteger(limit) && limit > 0 && limit <= 16, 'INVALID_DELETE_BATCH');
    const jobs = this.store.all<Deletion>(
      "SELECT * FROM web_character_deletions WHERE state='purging' ORDER BY created_at,id LIMIT ?",
      limit,
    );
    let left = limit;
    for (const job of jobs) {
      try {
        const scopes = this.store.all<DeletionScope>(
          `SELECT s.*,d.character_id FROM web_character_deletion_scopes s JOIN web_character_deletions d ON d.id=s.deletion_id
          WHERE s.deletion_id=? AND s.audio_cleared_at IS NULL ORDER BY s.world_id,s.conversation_id LIMIT ?`,
          job.id,
          left,
        );
        for (const s of scopes) {
          this.clear(s);
          await this.erase(s);
          left--;
        }
        this.store.run(
          `UPDATE web_character_deletions SET error_code=NULL,state=CASE WHEN NOT EXISTS
          (SELECT 1 FROM web_character_deletion_scopes WHERE deletion_id=? AND audio_cleared_at IS NULL) THEN 'deleted' ELSE state END,
          completed_at=CASE WHEN NOT EXISTS(SELECT 1 FROM web_character_deletion_scopes WHERE deletion_id=? AND audio_cleared_at IS NULL) THEN ? ELSE NULL END
          WHERE id=?`,
          job.id,
          job.id,
          this.now(),
          job.id,
        );
      } catch (error) {
        this.store.run(
          'UPDATE web_character_deletions SET error_code=? WHERE id=?',
          error instanceof DomainError ? error.code : 'CHARACTER_DELETION_FAILED',
          job.id,
        );
      }
      if (left === 0) break;
    }
  }
  private clear(s: DeletionScope) {
    this.store.transaction(() => {
      const current = this.store.get<{ db_cleared_at: number | null }>(
        `SELECT db_cleared_at FROM web_character_deletion_scopes
        WHERE deletion_id=? AND world_id=? AND conversation_id=?`,
        s.deletion_id,
        s.world_id,
        s.conversation_id,
      )!;
      if (current.db_cleared_at !== null) return;
      auditCharacterDeletionScope(this.store, s);
      ensure(
        this.store.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys === 1 &&
          !this.store.get('SELECT 1 FROM web_character_purge_gate'),
        'CHARACTER_DELETION_SCOPE_UNSAFE',
      );
      this.store.run(
        'INSERT INTO web_character_purge_gate VALUES (?,?,?)',
        s.deletion_id,
        s.world_id,
        s.conversation_id,
      );
      const ledger = new WebProviderOffline(this.store, this.clock);
      for (const o of this.store.all<{ id: string; metering_type: string; ip_window_id: string | null }>(
        `SELECT * FROM web_operations
        WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=? AND quota_state='reserved'`,
        ...scopeArgs(s),
      )) {
        if (o.metering_type === 'trial') {
          ensure(
            o.ip_window_id &&
              this.store.run('UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0', o.ip_window_id)
                .changes === 1,
            'WEB_QUOTA_STATE_INVALID',
          );
          settleWebLifetimeReservation(this.store, o.ip_window_id, 'released');
          ensure(
            this.store.run(
              'UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1 WHERE id=? AND trial_reserved>0',
              s.principal_id,
            ).changes === 1,
            'WEB_QUOTA_STATE_INVALID',
          );
        } else ensure(o.metering_type === 'entitled' && o.ip_window_id === null, 'CHARACTER_DELETION_SCOPE_UNSAFE');
        this.store.run(
          `UPDATE web_operations SET status='failed',quota_state='released',failure_code='CHARACTER_DELETED',stage_version=stage_version+1,
          lease_epoch=NULL,lease_token=NULL,lease_owner=NULL,lease_expires_at=NULL WHERE id=?`,
          o.id,
        );
      }
      for (const a of this.store.all<{
        operation_id: string;
        phase: 'draft' | 'review' | 'speech';
        ordinal: number;
        state: string;
        player_id: string;
        input_message_id: string;
      }>(
        `SELECT * FROM web_provider_attempts WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=? AND state IN ('not_sent','sent')`,
        ...scopeArgs(s),
      )) {
        const key = { operationId: a.operation_id, phase: a.phase, ordinal: a.ordinal };
        const scope = {
          principalId: s.principal_id,
          worldId: s.world_id,
          conversationId: s.conversation_id,
          characterId: s.character_id,
          playerId: a.player_id,
          inputMessageId: a.input_message_id,
        };
        if (a.state === 'not_sent')
          ledger.releaseUnsent(key, scope); // Never releases unknown shared reservations.
        else {
          ledger.markUnknown(key, scope);
          this.store.run(
            `UPDATE web_external_attempts SET dispatch_state='unknown' WHERE operation_id=? AND phase=? AND ordinal=? AND dispatch_state='sent'`,
            a.operation_id,
            a.phase,
            a.ordinal,
          );
        }
      }
      if (this.store.providerAudio)
        for (const table of ['web_provider_outputs', 'web_provider_media_assets'])
          ensure(
            !this.store.get(
              `SELECT 1 FROM ${table} m
        WHERE m.operation_id IN (${operationScope}) AND m.audio_ref_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM cf_web_audio_objects c
          WHERE c.operation_id=m.operation_id AND c.ordinal=m.ordinal AND c.reference_json=m.audio_ref_json AND c.principal_id=? AND c.world_id=?) LIMIT 1`,
              ...scopeArgs(s),
              s.principal_id,
              s.world_id,
            ),
            'CHARACTER_DELETION_AUDIO_INTENT_REQUIRED',
          );
      for (const table of ['web_local_events', 'web_user_events'])
        this.store.run(
          `DELETE FROM ${table} WHERE principal_id=? AND world_id=? AND conversation_id=?`,
          s.principal_id,
          s.world_id,
          s.conversation_id,
        );
      for (const table of operationContent)
        this.store.run(`DELETE FROM ${table} WHERE operation_id IN (${operationScope})`, ...scopeArgs(s));
      for (const table of conversationContent)
        this.store.run(`DELETE FROM ${table} WHERE world_id=? AND conversation_id=?`, s.world_id, s.conversation_id);
      for (const table of worldCharacterContent)
        this.store.run(`DELETE FROM ${table} WHERE world_id=? AND character_id=?`, s.world_id, s.character_id);
      this.store.run(
        'UPDATE jobs SET published_message_id=NULL WHERE world_id=? AND conversation_id=?',
        s.world_id,
        s.conversation_id,
      );
      this.store.run('DELETE FROM jobs WHERE world_id=? AND conversation_id=?', s.world_id, s.conversation_id);
      for (const o of this.store.all<{ id: string; payload_hash: string }>(
        `SELECT id,payload_hash FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND character_id=?`,
        ...scopeArgs(s),
      ))
        this.store.run(
          'UPDATE web_operations SET input_message_id=NULL,payload_hash=? WHERE id=?',
          webReceiptDigest(this.store, 'receipt', 'deleted-character\0' + o.payload_hash),
          o.id,
        );
      for (const a of this.store.all<{
        operation_id: string;
        stage: string;
        phase: string;
        ordinal: number;
        receipt_json: string | null;
        usage_json: string | null;
      }>(
        `SELECT * FROM web_external_attempts WHERE operation_id IN (${operationScope}) AND dispatch_state='known'`,
        ...scopeArgs(s),
      ))
        this.store.run(
          `UPDATE web_external_attempts SET receipt_json=NULL,usage_json=NULL,receipt_digest=coalesce(receipt_digest,?),usage_digest=coalesce(usage_digest,?)
          WHERE operation_id=? AND stage=? AND phase=? AND ordinal=?`,
          a.receipt_json === null ? null : webReceiptDigest(this.store, 'receipt', a.receipt_json),
          a.usage_json === null ? null : webReceiptDigest(this.store, 'usage', a.usage_json),
          a.operation_id,
          a.stage,
          a.phase,
          a.ordinal,
        );
      this.store.run('DELETE FROM messages WHERE world_id=? AND conversation_id=?', s.world_id, s.conversation_id);
      this.store.run(
        'UPDATE contacts SET state_json=? WHERE world_id=? AND conversation_id=? AND character_id=?',
        JSON.stringify(emptySession()),
        s.world_id,
        s.conversation_id,
        s.character_id,
      );
      this.store.run(
        "UPDATE world_characters SET relationship='new' WHERE world_id=? AND character_id=?",
        s.world_id,
        s.character_id,
      );
      this.store.run(
        'DELETE FROM web_character_purge_gate WHERE deletion_id=? AND world_id=? AND conversation_id=?',
        s.deletion_id,
        s.world_id,
        s.conversation_id,
      );
      auditCharacterDeletionScope(this.store, s, true);
      ensure(!this.store.get('PRAGMA foreign_key_check'), 'CHARACTER_DELETION_INCOMPLETE');
      this.store.run(
        'UPDATE web_character_deletion_scopes SET db_cleared_at=? WHERE deletion_id=? AND world_id=? AND conversation_id=?',
        this.now(),
        s.deletion_id,
        s.world_id,
        s.conversation_id,
      );
    });
  }
  private async erase(s: DeletionScope) {
    if (this.store.providerAudio)
      for (const intent of this.store.all<{ operation_id: string; ordinal: number; reference_json: string }>(
        `SELECT * FROM cf_web_audio_objects WHERE principal_id=? AND world_id=? AND operation_id IN (${operationScope}) AND erased_at IS NULL`,
        s.principal_id,
        s.world_id,
        ...scopeArgs(s),
      )) {
        const reference = JSON.parse(intent.reference_json) as MediaObjectReference;
        const authorize = async () => {
          ensure(
            this.store.get(
              `SELECT 1 FROM web_character_deletion_scopes WHERE deletion_id=? AND principal_id=? AND world_id=? AND conversation_id=? AND db_cleared_at IS NOT NULL`,
              s.deletion_id,
              s.principal_id,
              s.world_id,
              s.conversation_id,
            ),
            'CHARACTER_DELETION_SCOPE_UNSAFE',
          );
          const a = this.store.get<{ player_id: string; input_message_id: string }>(
            `SELECT * FROM web_provider_attempts WHERE operation_id=? AND phase='speech' AND ordinal=?
          AND principal_id=? AND world_id=? AND conversation_id=? AND character_id=?`,
            intent.operation_id,
            intent.ordinal,
            ...scopeArgs(s),
          );
          ensure(a, 'CHARACTER_DELETION_SCOPE_UNSAFE');
          checkAudioReference(
            reference,
            speechObjectScope(this.store, intent.operation_id, intent.ordinal, {
              principalId: s.principal_id,
              worldId: s.world_id,
              conversationId: s.conversation_id,
              characterId: s.character_id,
              playerId: a.player_id,
              inputMessageId: a.input_message_id,
            }),
          );
        };
        await this.store.providerAudio.erase(reference, authorize);
        this.store.run(
          'UPDATE cf_web_audio_objects SET erased_at=? WHERE operation_id=? AND ordinal=? AND reference_json=?',
          this.now(),
          intent.operation_id,
          intent.ordinal,
          intent.reference_json,
        );
      }
    this.store.run(
      'UPDATE web_character_deletion_scopes SET audio_cleared_at=? WHERE deletion_id=? AND world_id=? AND conversation_id=? AND db_cleared_at IS NOT NULL',
      this.now(),
      s.deletion_id,
      s.world_id,
      s.conversation_id,
    );
  }
}
