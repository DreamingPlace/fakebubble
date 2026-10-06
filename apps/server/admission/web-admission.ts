import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { WebRuntimeStore as WebStore } from '../platform/web-store-contract.ts';
import { requireWebContent, webDataLifecycleEnabled } from './web-retention.ts';
import { requirePublishedWebCharacter } from '../characters/web-character-catalog.ts';

interface PrincipalRow {
  id: string;
  player_id: string;
  world_id: string;
  kind: 'guest' | 'account' | 'invite';
  trial_character_id: string | null;
  trial_used: number;
  trial_reserved: number;
}
interface OperationRow {
  id: string;
  principal_id: string;
  request_id: string;
  payload_hash: string;
  world_id: string;
  conversation_id: string;
  character_id: string;
  input_message_id: string;
  ip_window_id: string | null;
  status: 'queued' | 'ready_to_publish' | 'published' | 'cancelled' | 'failed';
  quota_state: 'reserved' | 'used' | 'released';
  created_at: number;
  deadline_at: number;
}
type Terminal = 'cancelled' | 'failed';

/** Trusted internal service. HTTP must authenticate the principal and derive ipHash at a trusted boundary. */
export class WebAdmission {
  private readonly store: WebStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  private readonly ipKeyFingerprint: string | null;
  constructor(store: WebStore, clock: Clock, nextId: () => string) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
    this.ipKeyFingerprint = webDataLifecycleEnabled(store) ? store.webIpKeyFingerprint() : null;
  }

  registerGuest(input: { principalId: string; playerId: string; worldId: string }) {
    return this.store.transaction(() => {
      ensure(
        this.store.get<{ owner_id: string }>('SELECT owner_id FROM worlds WHERE id=?', input.worldId)?.owner_id ===
          input.playerId && this.store.get('SELECT 1 FROM api_players WHERE id=?', input.playerId),
        'WEB_WORLD_OWNER_MISMATCH',
      );
      this.store.run(
        "INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,'guest')",
        input.principalId,
        input.playerId,
        input.worldId,
      );
      if (webDataLifecycleEnabled(this.store))
        this.store.run(
          `INSERT INTO web_guest_retention
        (principal_id,world_id,state) VALUES (?,?,'unstarted')`,
          input.principalId,
          input.worldId,
        );
    });
  }

  admit(input: { principalId: string; requestId: string; characterId: string; text: string; ipHash: string }) {
    ensure(/^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId), 'INVALID_REQUEST_ID');
    ensure(typeof input.text === 'string' && typeof input.characterId === 'string', 'INVALID_TEXT');
    ensure(/^[a-f0-9]{64}$/.test(input.ipHash), 'WEB_TRUSTED_IP_REQUIRED');
    const payloadHash = createHash('sha256')
      .update(JSON.stringify([input.characterId, input.text, 'voice']))
      .digest('hex');
    return this.store.transaction(() => {
      const principal = this.store.get<PrincipalRow>('SELECT * FROM web_principals WHERE id=?', input.principalId);
      ensure(principal, 'WEB_PRINCIPAL_NOT_FOUND');
      const webSchema = this.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
      const lifecycle = webDataLifecycleEnabled(this.store);
      // The lifecycle gate precedes idempotent replay: expired content stays private.
      const retention = lifecycle ? requireWebContent(this.store, this.clock, principal.id, principal.world_id) : null;
      requirePublishedWebCharacter(this.store, input.characterId);
      const prior = this.store.get<OperationRow>(
        'SELECT * FROM web_operations WHERE principal_id=? AND request_id=?',
        input.principalId,
        input.requestId,
      );
      if (prior) {
        ensure(prior.payload_hash === payloadHash, 'IDEMPOTENCY_CONFLICT');
        return {
          operationId: prior.id,
          conversationId: prior.conversation_id,
          inputMessageId: prior.input_message_id,
          status: prior.status,
          duplicate: true as const,
        };
      }
      ensure(
        input.text.trim().length > 0 &&
          [...input.text].length <= WEB_LIMITS.maxInputCodePoints &&
          !/[\u0000-\u001f\u007f]/u.test(input.text),
        'INVALID_TEXT',
      );
      const trial = principal.kind === 'guest';
      ensure(
        trial ||
          ([108, 109, 110, 111, 112, 113].includes(webSchema) &&
            ((principal.kind === 'account' &&
              this.store.get(`SELECT 1 FROM web_accounts WHERE principal_id=? AND active=1`, principal.id)) ||
              (principal.kind === 'invite' && [111, 112, 113].includes(webSchema) && retention !== null))),
        'WEB_ADMISSION_ENTITLEMENT_REQUIRED',
      );
      ensure(
        this.store.get(
          'SELECT 1 FROM world_characters WHERE world_id=? AND character_id=?',
          principal.world_id,
          input.characterId,
        ),
        'WEB_CHARACTER_UNAVAILABLE',
      );
      if (trial) {
        ensure(
          principal.trial_character_id === null || principal.trial_character_id === input.characterId,
          'TRIAL_CHARACTER_LOCKED',
        );
        ensure(principal.trial_used + principal.trial_reserved < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
      }
      const pending = this.store.get<{ count: number }>(
        `SELECT count(*) count FROM web_operations
        WHERE principal_id=? AND status NOT IN ('published','cancelled','failed')`,
        principal.id,
      )!.count;
      ensure(pending < WEB_LIMITS.maxPrincipalPending, 'WEB_USER_QUEUE_FULL');
      const global = this.store.get<{ count: number }>(`SELECT count(*) count FROM web_operations
        WHERE status NOT IN ('published','cancelled','failed')`)!.count;
      ensure(global < webConcurrency(this.store).maxGlobalReservedOperations, 'QUEUE_FULL');

      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      if (lifecycle) ensure(now <= Number.MAX_SAFE_INTEGER - 2 * 60 * 60_000, 'INVALID_TIME');
      let window: { id: string; used: number; reserved: number } | undefined;
      if (trial) {
        if (lifecycle) {
          ensure(this.ipKeyFingerprint, 'WEB_IP_KEY_REQUIRED');
          this.store.run(
            `INSERT INTO web_ip_lifetime_quota(ip_hash,key_fingerprint,used_total,reserved_total)
            VALUES (?,?,0,0) ON CONFLICT(ip_hash) DO NOTHING`,
            input.ipHash,
            this.ipKeyFingerprint,
          );
          const quota = this.store.get<{ key_fingerprint: string; used_total: number; reserved_total: number }>(
            'SELECT * FROM web_ip_lifetime_quota WHERE ip_hash=?',
            input.ipHash,
          );
          ensure(quota?.key_fingerprint === this.ipKeyFingerprint, 'WEB_IP_KEY_MISMATCH');
          ensure(quota.used_total + quota.reserved_total < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
        }
        window = this.store.get<{ id: string; used: number; reserved: number }>(
          `SELECT id,used,reserved FROM web_ip_windows
          WHERE ip_hash=? ${lifecycle ? '' : 'AND starts_at<=? AND expires_at>?'}
          ORDER BY starts_at DESC,id DESC LIMIT 1`,
          ...(lifecycle ? [input.ipHash] : [input.ipHash, now, now]),
        );
        if (!window) {
          window = { id: this.nextId(), used: 0, reserved: 0 };
          this.store.run(
            'INSERT INTO web_ip_windows(id,ip_hash,starts_at,expires_at) VALUES (?,?,?,?)',
            window.id,
            input.ipHash,
            now,
            lifecycle ? Number.MAX_SAFE_INTEGER : now + WEB_LIMITS.ipWindowMs,
          );
        }
        ensure(window.used + window.reserved < WEB_LIMITS.trialReplies, 'TRIAL_EXHAUSTED');
      }

      let conversation = this.store.get<{ id: string }>(
        `SELECT id FROM conversations
        WHERE world_id=? AND private_character_id=? AND kind='private'`,
        principal.world_id,
        input.characterId,
      );
      if (!conversation) {
        conversation = { id: this.nextId() };
        this.store.run(
          "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?)",
          principal.world_id,
          conversation.id,
          input.characterId,
        );
        this.store.run(
          'INSERT INTO participants VALUES (?,?,?)',
          principal.world_id,
          conversation.id,
          input.characterId,
        );
        this.store.run(
          'INSERT INTO contacts VALUES (?,?,?,?)',
          principal.world_id,
          conversation.id,
          input.characterId,
          JSON.stringify(emptySession()),
        );
      }
      const messageId = this.nextId(),
        operationId = this.nextId();
      this.store.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,request_id,request_hash)
        VALUES (?,?,?,'player',?,?,?,'text',?,?)`,
        messageId,
        principal.world_id,
        conversation.id,
        principal.player_id,
        input.text,
        now,
        input.requestId,
        payloadHash,
      );
      this.store.run(
        'INSERT INTO outbox(world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)',
        principal.world_id,
        conversation.id,
        messageId,
        now,
      );
      if (trial) {
        if (lifecycle) {
          ensure(retention?.state === 'unstarted' || retention?.state === 'active', 'TRIAL_EXPIRED');
          if (retention.state === 'unstarted')
            ensure(
              this.store.run(
                `UPDATE web_guest_retention
            SET started_at=?,expires_at=?,state='active',revision=revision+1
            WHERE principal_id=? AND world_id=? AND state='unstarted' AND revision=?`,
                now,
                now + 2 * 60 * 60_000,
                principal.id,
                principal.world_id,
                retention.revision,
              ).changes === 1,
              'WEB_RETENTION_STALE',
            );
          ensure(
            this.store.run(
              `UPDATE web_ip_lifetime_quota SET reserved_total=reserved_total+1,
            revision=revision+1 WHERE ip_hash=? AND key_fingerprint=? AND used_total+reserved_total<?`,
              input.ipHash,
              this.ipKeyFingerprint!,
              WEB_LIMITS.trialReplies,
            ).changes === 1,
            'TRIAL_EXHAUSTED',
          );
        }
        ensure(
          this.store.run(
            'UPDATE web_ip_windows SET reserved=reserved+1 WHERE id=? AND used+reserved<?',
            window!.id,
            WEB_LIMITS.trialReplies,
          ).changes === 1,
          'TRIAL_EXHAUSTED',
        );
        ensure(
          this.store.run(
            `UPDATE web_principals SET trial_character_id=coalesce(trial_character_id,?),
          trial_reserved=trial_reserved+1,revision=revision+1 WHERE id=? AND trial_used+trial_reserved<?`,
            input.characterId,
            principal.id,
            WEB_LIMITS.trialReplies,
          ).changes === 1,
          'TRIAL_EXHAUSTED',
        );
      }
      const operationColumns = `id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
        input_message_id,ip_window_id,status,quota_state,created_at,deadline_at`;
      const operationValues = [
        operationId,
        principal.id,
        input.requestId,
        payloadHash,
        principal.world_id,
        conversation.id,
        input.characterId,
        messageId,
        window?.id ?? null,
        now,
        now + WEB_LIMITS.operationDeadlineMs,
      ];
      if (webSchema >= 102 && webSchema <= 113) {
        const sequence = this.store.get<{ last_seq: number }>(`UPDATE web_admission_counter
          SET last_seq=last_seq+1 WHERE singleton=1 RETURNING last_seq`)?.last_seq;
        ensure(sequence !== undefined, 'WEB_ADMISSION_ORDER_MISSING');
        this.store.run(
          `INSERT INTO web_operations(${operationColumns},text_queued_at,admission_seq${webSchema >= 108 ? ',metering_type' : ''})
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?,?,?${webSchema >= 108 ? ',?' : ''})`,
          ...operationValues,
          now,
          sequence,
          ...(webSchema >= 108 ? [trial ? 'trial' : 'entitled'] : []),
        );
      } else if (webSchema === 101) {
        this.store.run(
          `INSERT INTO web_operations(${operationColumns},text_queued_at)
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?,?)`,
          ...operationValues,
          now,
        );
      } else {
        this.store.run(
          `INSERT INTO web_operations(${operationColumns})
          VALUES (?,?,?,?,?,?,?,?,?,'queued','reserved',?,?)`,
          ...operationValues,
        );
      }
      return {
        operationId,
        conversationId: conversation.id,
        inputMessageId: messageId,
        status: 'queued' as const,
        duplicate: false as const,
      };
    });
  }

  /** Only confirmed termination is available until an atomic voice publisher is implemented. */
  finalize(operationId: string, terminal: Terminal) {
    return this.store.transaction(() => {
      ensure(
        ![104, 105, 106, 107, 108, 109, 110, 111, 112, 113].includes(
          this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? -1,
        ),
        'WEB_DISPATCH_FENCE_REQUIRED',
      );
      const operation = this.store.get<OperationRow>('SELECT * FROM web_operations WHERE id=?', operationId);
      ensure(operation, 'WEB_OPERATION_NOT_FOUND');
      // Runtime guard also rejects JavaScript callers bypassing the TypeScript Terminal type.
      if ((terminal as string) === 'published') {
        const now = this.clock.now();
        ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
        ensure(now < operation.deadline_at, 'OPERATION_EXPIRED');
        ensure(false, 'WEB_PUBLICATION_NOT_READY');
      }
      ensure(terminal === 'cancelled' || terminal === 'failed', 'WEB_PUBLICATION_NOT_READY');
      if (operation.quota_state !== 'reserved') {
        ensure(operation.status === terminal, 'WEB_OPERATION_TERMINAL_CONFLICT');
        return { status: operation.status, duplicate: true as const };
      }
      ensure(
        this.store.run(
          'UPDATE web_ip_windows SET reserved=reserved-1 WHERE id=? AND reserved>0',
          operation.ip_window_id,
        ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
      ensure(
        this.store.run(
          'UPDATE web_principals SET trial_reserved=trial_reserved-1,revision=revision+1 WHERE id=? AND trial_reserved>0',
          operation.principal_id,
        ).changes === 1,
        'WEB_QUOTA_STATE_INVALID',
      );
      ensure(
        this.store.run(
          'UPDATE web_operations SET status=?,quota_state=? WHERE id=? AND quota_state=?',
          terminal,
          'released',
          operationId,
          'reserved',
        ).changes === 1,
        'WEB_OPERATION_STATE_INVALID',
      );
      return { status: terminal, duplicate: false as const };
    });
  }
}
