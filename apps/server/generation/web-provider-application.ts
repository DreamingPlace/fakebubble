import { installWebCharacterDeletion } from '../characters/web-character-deletion-schema.ts';
import { WebCharacterDeletion } from '../characters/web-character-deletion.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  WEB_PROVIDER_CONTRACT,
  isWebProviderCharacterId,
  type WebProviderAccess,
  type WebProviderBootstrap,
  type WebProviderCharacterId,
  type WebProviderMessage,
  type WebProviderOperation,
} from '../../../packages/contracts/web-provider.ts';
import { installWebCharacterCatalog, publishedWebCharacters } from '../characters/web-character-catalog.ts';
import { installWebCharacterMaterials } from '../characters/web-character-material-schema.ts';
import { WebCharacterMaterials } from '../characters/web-character-materials.ts';
import { WebCharacterAdmin } from '../characters/web-character-admin.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { WebIdentity } from '../identity/web-identity.ts';
import { WebAdmission } from '../admission/web-admission.ts';
import { WebVerticalPublisher } from '../conversation/web-vertical-publisher.ts';
import { WebAccountAdmin, type AdminMailer } from '../admin/web-account-admin.ts';
import { WebInvites } from '../invites/web-invites.ts';
import { WebInviteActions } from '../invites/web-invite-actions.ts';
import { requireWebContent, type WebRetentionRow } from '../admission/web-retention.ts';

export const WEB_PROVIDER_API = '/api/web/provider';
const API = WEB_PROVIDER_API;
export type WebProviderPrincipal = ReturnType<WebIdentity['authenticate']>;
type Principal = WebProviderPrincipal;
export const providerCharacterId = isWebProviderCharacterId;
const characterId = providerCharacterId;
export interface WebProviderApplicationConfig {
  mode: 'provider-local' | 'provider-cloud';
  origin: string;
  cookieName: string;
  instanceId: string;
  recoveryEpoch: string;
  ipKey: string;
  sealKey: string;
  requestKey: string;
  cursorKey: string;
}

/** Shared schema113 application/projections. Transports alone own headers, trusted peer and streams. */
export interface ProviderHistoryRow {
  id: string;
  body: string;
  created_at: number;
  operation_id: string;
  origin: 'input' | 'narrative' | 'trial_footer' | 'text_fallback';
  ordinal: number | null;
  media_id: string | null;
  duration_ms: number | null;
}
/** One history row as the player sees it. A text fallback is an ordinary narrative text bubble; no error is shown. */
export function providerHistoryMessage(
  row: ProviderHistoryRow,
  conversationId: string,
  character: WebProviderCharacterId,
): WebProviderMessage {
  return {
    messageId: row.id,
    conversationId,
    characterId: character,
    operationId: row.operation_id,
    replyOrdinal: row.origin === 'narrative' || row.origin === 'text_fallback' ? row.ordinal : null,
    author: row.origin === 'input' ? 'player' : 'character',
    origin: row.origin === 'text_fallback' ? 'narrative' : row.origin,
    ...(row.origin === 'text_fallback' ? { deliveryFallback: 'text' as const } : {}),
    text: row.body,
    createdAt: row.created_at,
    audio: row.media_id
      ? { revision: 1, status: 'ready', mediaId: row.media_id, durationMs: row.duration_ms, errorCode: null }
      : null,
  };
}

export class WebProviderApplication {
  readonly store: WebRuntimeStore;
  readonly clock: Clock;
  readonly config: WebProviderApplicationConfig;
  readonly identity: WebIdentity;
  readonly admission: WebAdmission;
  readonly publisher: WebVerticalPublisher;
  readonly inviteAdmin: WebAccountAdmin;
  readonly characterDeletion: WebCharacterDeletion;
  readonly characterAdmin: WebCharacterAdmin;
  readonly inviteActions: WebInviteActions;
  constructor(store: WebRuntimeStore, clock: Clock, config: WebProviderApplicationConfig, mailer?: AdminMailer) {
    store.requireProviderRuntime();
    ensure(
      store.instanceId === config.instanceId &&
        store.get<{ recovery_epoch: string }>('SELECT recovery_epoch FROM web_instance WHERE singleton=1')
          ?.recovery_epoch === config.recoveryEpoch,
      'WEB_LOCAL_INSTANCE_MISMATCH',
    );
    ensure(
      ['provider-local', 'provider-cloud'].includes(config.mode) &&
        [config.ipKey, config.sealKey, config.requestKey, config.cursorKey].every(
          (key) => /^[A-Za-z0-9_-]{43}$/.test(key) && Buffer.from(key, 'base64url').length === 32,
        ),
      'WEB_IDENTITY_KEYS_REQUIRED',
    );
    this.store = store;
    this.clock = clock;
    this.config = { ...config };
    this.identity = new WebIdentity(store, {
      origin: config.origin,
      cookieName: config.cookieName,
      keys: {
        keyId: config.mode === 'provider-local' ? 'local-v1' : 'cloud-v1',
        sealKey: Buffer.from(config.sealKey, 'base64url'),
        requestKey: Buffer.from(config.requestKey, 'base64url'),
      },
      clock,
    });
    this.admission = new WebAdmission(store, clock, () => globalThis.crypto.randomUUID());
    this.publisher = new WebVerticalPublisher(store, clock);
    this.inviteAdmin = new WebAccountAdmin(store, clock, config.origin, mailer ? { mailer } : {});
    installWebCharacterCatalog(store);
    installWebCharacterMaterials(store);
    installWebCharacterDeletion(store);
    this.characterDeletion = new WebCharacterDeletion(store, clock);
    this.characterAdmin = new WebCharacterAdmin(store, clock, this.inviteAdmin);
    this.characterAdmin.enableMaterials(new WebCharacterMaterials(store, clock));
    this.characterAdmin.enableDeletion(this.characterDeletion);
    const invites = new WebInvites(store, {
      clock,
      codeKey: createHmac('sha256', Buffer.from(config.requestKey, 'base64url'))
        .update('web-local-invite-code-v1')
        .digest(),
      authorize: this.identity.authorizeInviteAction.bind(this.identity),
      identity: this.identity,
    });
    this.inviteActions = new WebInviteActions(store, clock, config.origin, invites, this.identity);
  }

  bootstrap(token: string | undefined, ipHash: string) {
    let issued: string | null = null;
    const body = this.store.transaction((): WebProviderBootstrap => {
      if (!token) {
        const start = Math.floor(this.clock.now() / 86_400_000) * 86_400_000;
        this.store.run(
          `INSERT INTO web_local_guest_budget(ip_hash,window_start,created)
          VALUES (?,?,0) ON CONFLICT DO NOTHING`,
          ipHash,
          start,
        );
        ensure(
          this.store.run(
            `UPDATE web_local_guest_budget SET created=created+1
          WHERE ip_hash=? AND window_start=? AND created<32`,
            ipHash,
            start,
          ).changes === 1,
          'WEB_GUEST_RATE_LIMITED',
        );
      }
      let boot: ReturnType<WebIdentity['bootstrap']>;
      try {
        boot = this.identity.bootstrap(token);
      } catch (error) {
        if (
          token &&
          error instanceof DomainError &&
          error.code === 'SESSION_EXPIRED' &&
          this.identity.expiredGuest(token)
        )
          throw new DomainError('GUEST_SESSION_EXPIRED');
        throw error;
      }
      issued = boot.issuedToken;
      const principal = this.identity.authenticate(token ?? boot.issuedToken!);
      const { inaccessible, ...access } = this.access(principal, ipHash);
      const characters = this.characters(),
        ids = new Set(characters.map((entry) => entry.characterId));
      if (!inaccessible)
        for (const entry of characters)
          this.store.run(
            `INSERT OR IGNORE INTO world_characters(world_id,character_id,relationship)
          VALUES (?,?,'new')`,
            principal.world_id,
            entry.characterId,
          );
      const high = this.eventHighWater();
      const conversations = inaccessible
        ? []
        : this.store
            .all<{ id: string; character_id: string; last: string | null }>(
              `SELECT c.id,c.private_character_id character_id,
        (SELECT m.id FROM messages m WHERE m.world_id=c.world_id AND m.conversation_id=c.id ORDER BY m.seq DESC LIMIT 1) last
        FROM conversations c WHERE c.world_id=? AND c.kind='private' ORDER BY c.id`,
              principal.world_id,
            )
            .filter((row) => ids.has(row.character_id))
            .map((row) => ({
              conversationId: row.id,
              characterId: row.character_id as WebProviderCharacterId,
              lastMessageId: row.last,
              unreadCount: 0,
            }));
      return {
        contractVersion: WEB_PROVIDER_CONTRACT,
        ...(this.config.mode === 'provider-local'
          ? { mode: 'provider-local' as const, region: 'local-test' as const }
          : { mode: 'provider-cloud' as const, region: 'public' as const }),
        fixture: false,
        instanceId: this.config.instanceId,
        recoveryEpoch: this.config.recoveryEpoch,
        csrf: boot.csrf,
        access,
        characters,
        slots: [
          ...characters.map((entry) => ({ kind: 'character' as const, characterId: entry.characterId })),
          ...Array.from({ length: 15 - characters.length }, (_, index) => ({
            kind: 'preview' as const,
            slotId: `preview-${index + 1}`,
            label: '敬请期待',
          })),
        ],
        conversations,
        syncCursor: this.cursor(principal.principalId, high),
      };
    });
    return { body, issuedToken: issued };
  }

  cursor(principalId: string, seq: number, conversationId?: string) {
    const payload = Buffer.from(
      JSON.stringify([1, this.config.instanceId, this.config.recoveryEpoch, principalId, conversationId ?? null, seq]),
    ).toString('base64url');
    const mac = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url'))
      .update(payload)
      .digest('base64url');
    return `${payload}.${mac}`;
  }

  parseCursor(raw: string | null, principalId: string, conversationId?: string) {
    if (raw === null) return 0;
    ensure(raw.length <= 512 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(raw), 'INVALID_CURSOR');
    const [payload, supplied] = raw.split('.');
    const actual = createHmac('sha256', Buffer.from(this.config.cursorKey, 'base64url')).update(payload!).digest();
    const proposed = Buffer.from(supplied!, 'base64url');
    ensure(proposed.length === actual.length && timingSafeEqual(proposed, actual), 'INVALID_CURSOR');
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    } catch {
      ensure(false, 'INVALID_CURSOR');
    }
    ensure(
      Array.isArray(decoded) &&
        decoded.length === 6 &&
        decoded[0] === 1 &&
        decoded[1] === this.config.instanceId &&
        decoded[2] === this.config.recoveryEpoch &&
        decoded[3] === principalId &&
        decoded[4] === (conversationId ?? null) &&
        Number.isSafeInteger(decoded[5]) &&
        decoded[5] >= 0,
      'INVALID_CURSOR',
    );
    return decoded[5] as number;
  }

  eventHighWater() {
    const seq = this.store.get<{ seq: number }>(`SELECT coalesce(
      (SELECT seq FROM sqlite_sequence WHERE name='web_local_events'),0) seq`)!.seq;
    ensure(Number.isSafeInteger(seq) && seq >= 0, 'WEB_EVENT_SEQUENCE_INVALID');
    return seq;
  }

  access(principal: Principal, ipHash: string): WebProviderAccess & { inaccessible: boolean } {
    const now = this.clock.now();
    const row = this.store.get<{
      kind: string;
      trial_used: number;
      trial_reserved: number;
      trial_character_id: string | null;
      revision: number;
    }>('SELECT * FROM web_principals WHERE id=? AND world_id=?', principal.principalId, principal.world_id)!;
    const base = {
      principalId: principal.principalId,
      playerId: principal.player_id,
      worldId: principal.world_id,
      revision: row.revision,
    };
    if (row.kind === 'invite') {
      const grant = this.store.get<{ id: string; expires_at: number | null; revoked_at: number | null }>(
        `SELECT id,expires_at,revoked_at FROM web_invite_grants WHERE principal_id=?
          AND player_id=? AND world_id=?`,
        principal.principalId,
        principal.player_id,
        principal.world_id,
      );
      ensure(grant, 'WEB_INVITE_ACCESS_REQUIRED');
      const status =
        grant.revoked_at !== null
          ? ('revoked' as const)
          : grant.expires_at !== null && now >= grant.expires_at
            ? ('expired' as const)
            : ('active' as const);
      return {
        kind: 'invite',
        ...base,
        grantId: grant.id,
        status,
        lockedCharacterId: null,
        remainingReplies: null,
        reservedReplies: null,
        trialExpiresAt: null,
        canSend: status === 'active',
        inaccessible: status !== 'active',
      };
    }
    ensure(row.kind === 'guest', 'WEB_PROVIDER_ACCESS_UNSUPPORTED');
    const retention = this.store.get<WebRetentionRow>(
      `SELECT * FROM web_guest_retention
      WHERE principal_id=? AND world_id=?`,
      principal.principalId,
      principal.world_id,
    );
    ensure(retention, 'WEB_RETENTION_SCOPE_INVALID');
    const quota = this.store.get<{ used_total: number; reserved_total: number }>(
      'SELECT used_total,reserved_total FROM web_ip_lifetime_quota WHERE ip_hash=?',
      ipHash,
    );
    const expired =
      retention.state !== 'unstarted' &&
      (retention.state !== 'active' || retention.expires_at === null || now >= retention.expires_at);
    const remaining = Math.max(
      0,
      Math.min(3 - row.trial_used - row.trial_reserved, 3 - (quota?.used_total ?? 0) - (quota?.reserved_total ?? 0)),
    );
    const locked = row.trial_character_id;
    ensure(locked === null || characterId(locked), 'WEB_PROVIDER_CATALOG_INVALID');
    return {
      kind: 'guest',
      ...base,
      lockedCharacterId: locked,
      remainingReplies: remaining,
      reservedReplies: row.trial_reserved,
      trialExpiresAt: retention.expires_at ?? null,
      canSend: !expired && remaining > 0 && (locked === null || !webCharacterDeleted(this.store, locked)),
      inaccessible: expired,
    };
  }

  characters() {
    return publishedWebCharacters(this.store).map((entry) => {
      const line = entry.presentation.welcome;
      const approved = this.store.get(
        `SELECT 1 FROM web_provider_voice_bindings WHERE character_id=?
        AND approved=1 AND source='user_selected'`,
        entry.characterId,
      );
      const clip = this.store.get<{ media_id: string; text_version: string; sha256: string; duration_ms: number }>(
        `SELECT w.media_id,w.text_version,w.sha256,w.duration_ms
        FROM web_provider_welcome_assets w JOIN web_provider_voice_bindings v
          ON v.character_id=w.character_id AND v.voice_version=w.voice_version
        WHERE w.character_id=? AND w.body=? AND w.text_version=? AND v.approved=1 AND v.source='user_selected'`,
        entry.characterId,
        line.text,
        line.version,
      );
      return {
        characterId: entry.characterId,
        displayName: entry.presentation.displayName,
        publicDescription: entry.presentation.publicDescription,
        portraitUrl: null,
        theme: null,
        availability: approved
          ? { state: 'available' as const, personaVersion: entry.version }
          : { state: 'unavailable' as const, reason: 'voice_unverified' as const },
        welcome: !approved
          ? { text: null, version: null, audio: { state: 'unavailable' as const, reason: 'voice_unverified' as const } }
          : {
              text: line.text,
              version: line.version,
              audio: clip
                ? {
                    state: 'available' as const,
                    mediaId: clip.media_id,
                    url: `${API}/public-audio/${clip.media_id}`,
                    version: clip.text_version,
                    sha256: clip.sha256,
                    durationMs: clip.duration_ms,
                  }
                : { state: 'unavailable' as const, reason: 'audio_missing' as const },
            },
      };
    });
  }

  operation(principal: Principal, operationId: string): WebProviderOperation {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const row = this.store.get<{
      id: string;
      request_id: string;
      conversation_id: string;
      character_id: string;
      status: WebProviderOperation['status'];
      stage_version: number;
      created_at: number;
      deadline_at: number;
      failure_code: WebProviderOperation['errorCode'];
    }>(
      'SELECT * FROM web_operations WHERE id=? AND principal_id=? AND world_id=?',
      operationId,
      principal.principalId,
      principal.world_id,
    );
    ensure(row && characterId(row.character_id) && !webCharacterDeleted(this.store, row.character_id), 'NOT_FOUND');
    const publication = this.store.get<{ receipt_json: string }>(
      'SELECT receipt_json FROM web_publications WHERE operation_id=? AND principal_id=?',
      operationId,
      principal.principalId,
    );
    const receipt = publication
      ? (JSON.parse(publication.receipt_json) as { messageIds: string[]; footerMessageId: string | null })
      : null;
    return {
      operationId: row.id,
      requestId: row.request_id,
      characterId: row.character_id,
      conversationId: row.conversation_id,
      status: row.status,
      revision: row.stage_version + 1,
      acceptedAt: row.created_at,
      deadlineAt: row.deadline_at,
      errorCode: row.failure_code,
      canCancel: !['published', 'cancelled', 'failed'].includes(row.status),
      canRetry: false,
      publication: receipt
        ? { narrativeMessageIds: receipt.messageIds, footerMessageId: receipt.footerMessageId }
        : null,
    };
  }

  events(principal: Principal, after: number, limit = 100) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const high = this.eventHighWater();
    ensure(after <= high && limit >= 1 && limit <= 100, 'INVALID_CURSOR');
    const rows = this.store.all<{
      seq: number;
      conversation_id: string | null;
      character_id: string | null;
      kind: 'operation' | 'publication' | 'access';
      revision: number;
      payload_json: string;
    }>(
      `SELECT e.seq,e.conversation_id,c.private_character_id character_id,e.kind,e.revision,e.payload_json
        FROM web_local_events e LEFT JOIN conversations c
          ON c.world_id=e.world_id AND c.id=e.conversation_id AND c.kind='private'
        WHERE e.principal_id=? AND e.world_id=? AND e.seq>? AND NOT EXISTS
          (SELECT 1 FROM web_character_deletions d WHERE d.character_id=c.private_character_id) ORDER BY e.seq LIMIT ?`,
      principal.principalId,
      principal.world_id,
      after,
      limit + 1,
    );
    const page = rows.slice(0, limit);
    const last = page.at(-1)?.seq ?? after;
    return {
      events: page.map((row) => ({
        eventId: this.cursor(principal.principalId, row.seq),
        conversationId: row.conversation_id,
        characterId: row.character_id && characterId(row.character_id) ? row.character_id : null,
        kind: row.kind,
        revision: row.revision,
        payload: JSON.parse(row.payload_json),
      })),
      cursor: this.cursor(principal.principalId, last),
      hasMore: rows.length > limit,
    };
  }

  history(principal: Principal, conversationId: string, before: number | null) {
    requireWebContent(this.store, this.clock, principal.principalId, principal.world_id);
    const conversation = this.store.get<{ private_character_id: string }>(
      `SELECT private_character_id
      FROM conversations WHERE world_id=? AND id=? AND kind='private'`,
      principal.world_id,
      conversationId,
    );
    ensure(
      conversation &&
        characterId(conversation.private_character_id) &&
        !webCharacterDeleted(this.store, conversation.private_character_id),
      'NOT_FOUND',
    );
    const rows = this.store.all<{
      seq: number;
      id: string;
      body: string;
      created_at: number;
      operation_id: string;
      origin: 'input' | 'narrative' | 'trial_footer' | 'text_fallback';
      ordinal: number | null;
      media_id: string | null;
      duration_ms: number | null;
    }>(
      `
      SELECT m.seq,m.id,m.body,m.created_at,o.id operation_id,'input' origin,NULL ordinal,
          NULL media_id,NULL duration_ms
        FROM web_operations o JOIN messages m ON m.id=o.input_message_id
        WHERE o.principal_id=? AND o.world_id=? AND o.conversation_id=? AND m.seq<?
      UNION ALL
      SELECT m.seq,m.id,m.body,m.created_at,p.operation_id,i.origin,i.ordinal,i.media_id,
          coalesce(a.duration_ms,f.duration_ms) duration_ms
        FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        JOIN messages m ON m.id=i.message_id
        LEFT JOIN web_provider_media_assets a ON a.media_id=i.media_id AND i.origin='narrative'
        LEFT JOIN web_provider_footer_assets f ON f.media_id=i.media_id AND i.origin='trial_footer'
        WHERE p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=? AND m.seq<?
      ORDER BY seq DESC LIMIT 51`,
      principal.principalId,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
      principal.principalId,
      principal.player_id,
      principal.world_id,
      conversationId,
      before ?? Number.MAX_SAFE_INTEGER,
    );
    const page = rows.slice(0, 50).reverse();
    const character = conversation.private_character_id as WebProviderCharacterId;
    return {
      characterId: character,
      conversationId,
      messages: page.map((row) => providerHistoryMessage(row, conversationId, character)),
      before: page.length ? this.cursor(principal.principalId, page[0]!.seq, conversationId) : null,
      hasMore: rows.length > 50,
    };
  }
}
