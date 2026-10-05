import { randomUUID, createHash } from 'node:crypto';
import type { Clock, RelationshipPreset, TextGenerationRequest } from '../../packages/contracts/index.ts';
import { hasCharacterPermission } from '../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore } from './store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { identifier, keys, nonempty, record } from './template-validation.ts';
import { promptMessages } from './accepted-text-prompt.ts';
import { textPolicyHash } from './text-generation-policy.ts';
import { characterProfileHash, type WebCharacterProfile } from './web-character-catalog.ts';
import { installWebCharacterPreviews } from './web-character-preview-schema.ts';

export const previewDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const previewPolicy = textPolicyHash({ textProtocol: 'accepted-v7' });
export interface PreviewActor { memberId: string; sessionId: string }
export interface WebPreviewJob extends PreviewActor {
  id: string; character_id: string; revision: number; profile_hash: string; request_digest: string;
  request_json: string; prompt_hash: string; status: string; deadline_at: number; lease_until: number | null;
  lease_token: string | null; retry_at: number; result_json: string | null; error_code: string | null;
}
export function readWebPreview(store: BusinessStore, id: string) {
  const row = store.get<WebPreviewJob>(`SELECT p.*,j.revision,j.profile_hash,j.request_digest,j.deadline_at,j.lease_token,j.retry_at,
    j.member_id memberId,j.session_id sessionId FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
    WHERE p.id=?`, id);
  ensure(row, 'NOT_FOUND'); return row;
}
export function requirePreviewActor(store: BusinessStore, now: number, actor: PreviewActor, id: string) {
  const row = store.get<{ role: string; permissions_json: string }>(`SELECT m.role,m.permissions_json FROM web_admin_members m
    JOIN web_admin_session_members a ON a.member_id=m.id JOIN admin_sessions s ON s.id=a.session_id
    WHERE m.id=? AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`, actor.memberId, actor.sessionId, now);
  ensure(row, 'ADMIN_UNAUTHORIZED');
  ensure(row.role === 'owner' || hasCharacterPermission(JSON.parse(row.permissions_json), 'preview', id), 'ADMIN_PERMISSION_REQUIRED');
}
export function currentWebPreview(store: BusinessStore, now: number, row: WebPreviewJob) {
  requirePreviewActor(store, now, row, row.character_id);
  ensure(row.deadline_at > now, 'PREVIEW_EXPIRED');
  const revision = store.get<{ profile_json: string; content_hash: string }>(`SELECT r.* FROM web_character_revisions r
    JOIN web_character_drafts d ON d.character_id=r.character_id AND d.revision=r.revision
    WHERE r.character_id=? AND r.revision=?`, row.character_id, row.revision);
  ensure(revision?.content_hash === row.profile_hash &&
    characterProfileHash(JSON.parse(revision.profile_json)) === row.profile_hash, 'DRAFT_CONFLICT');
  ensure(previewDigest(row.request_json) === row.request_digest && row.prompt_hash === previewPolicy, 'PREVIEW_REQUEST_CHANGED');
  const request = JSON.parse(row.request_json) as TextGenerationRequest;
  ensure(request.jobId === row.id && request.scope.worldId === 'admin-preview-' + row.id &&
    request.scope.conversationId === row.id && request.scope.characterId === row.character_id &&
    contentHash(request.character) === contentHash((JSON.parse(revision.profile_json) as WebCharacterProfile).template), 'PREVIEW_REQUEST_CHANGED');
  return request;
}
export function webPreviewDTO(row: WebPreviewJob) {
  return { previewId: row.id, characterId: row.character_id, draftRevision: row.revision, profileHash: row.profile_hash,
    status: row.status, errorCode: row.error_code, result: row.result_json ? JSON.parse(row.result_json) : null };
}

/** Isolated operation scope, never a player world/conversation or a source of player memory. */
export class WebCharacterPreviews {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly id: () => string;
  constructor(store: BusinessStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store; this.clock = clock; this.id = nextId; installWebCharacterPreviews(store);
  }
  start(actor: PreviewActor, characterId: string, input: unknown) {
    identifier(characterId); record(input); keys(input, ['requestId','draftRevision','profileHash','relationship','message']);
    identifier(input.requestId); nonempty(input.message, 4000);
    ensure(Number.isSafeInteger(input.draftRevision) && Number(input.draftRevision) > 0 &&
      typeof input.profileHash === 'string' && /^[a-f0-9]{64}$/.test(input.profileHash), 'INVALID_DRAFT_REVISION');
    ensure(['new','friend','close_friend','lover'].includes(String(input.relationship)), 'INVALID_RELATIONSHIP');
    const requestId = input.requestId, revision = Number(input.draftRevision), profileHash = input.profileHash;
    const digest = contentHash([actor.memberId,characterId,input]);
    return this.store.transaction(() => {
      const now = this.clock.now(); ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      requirePreviewActor(this.store, now, actor, characterId);
      const prior = this.store.get<{ id: string; request_hash: string }>('SELECT id,request_hash FROM admin_previews WHERE request_id=?', requestId);
      if (prior) { ensure(prior.request_hash === digest, 'IDEMPOTENCY_CONFLICT'); return webPreviewDTO(readWebPreview(this.store, prior.id)); }
      const draft = this.store.get<{ profile_json: string; content_hash: string; base_version: number | null }>(`SELECT r.*
        FROM web_character_revisions r JOIN web_character_drafts d ON d.character_id=r.character_id AND d.revision=r.revision
        WHERE r.character_id=? AND r.revision=?`, characterId, revision);
      ensure(draft?.content_hash === profileHash, 'DRAFT_CONFLICT');
      const profile = JSON.parse(draft.profile_json) as WebCharacterProfile;
      ensure(characterProfileHash(profile) === profileHash, 'DRAFT_CONFLICT');
      ensure(this.store.get<{ n: number }>(`SELECT count(*) n FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status IN ('queued','generating')`)!.n < 8, 'PREVIEW_QUEUE_FULL');
      const id = this.id(), messageId = this.id(); identifier(id); identifier(messageId);
      const scope = { worldId: 'admin-preview-' + id, conversationId: id, characterId };
      const request: TextGenerationRequest = { jobId: id, scope, now, character: profile.template,
        relationship: input.relationship as RelationshipPreset, requiredMessageIds: [messageId], mustClose: false, evidence: [],
        deliveryMode: profile.template.voice ? 'voice' : 'text',
        messages: [{ id: messageId, worldId: scope.worldId, conversationId: id, authorKind: 'player', authorId: 'admin-preview',
          text: input.message as string, createdAt: now, delivery: 'text', voiceFallback: false, mediaId: null, proactive: false }] };
      promptMessages(request);
      const legacyRevision = this.store.get<{ n: number }>('SELECT coalesce(max(revision),0)+1 n FROM character_draft_revisions WHERE character_id=?', characterId)!.n;
      this.store.run('INSERT INTO character_draft_revisions VALUES (?,?,?,?,?,?,?)', characterId, legacyRevision, draft.base_version,
        JSON.stringify(profile.template), contentHash(profile.template), now, actor.sessionId);
      const json = JSON.stringify(request);
      this.store.run(`INSERT INTO admin_previews(id,character_id,draft_revision,content_hash,prompt_hash,request_id,request_hash,
        status,evidence_kind,request_json,created_at) VALUES (?,?,?,?,?,?,?,'queued','deepseek',?,?)`, id, characterId,
        legacyRevision, contentHash(profile.template), previewPolicy, requestId, digest, json, now);
      this.store.run('INSERT INTO web_character_preview_jobs VALUES (?,?,?,?,?,?,?,?,NULL,?)', id, characterId, revision,
        profileHash, previewDigest(json), actor.memberId, actor.sessionId, now + 600_000, now);
      this.store.run('INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        actor.memberId, 'character-preview-queued', id, now);
      return webPreviewDTO(readWebPreview(this.store, id));
    });
  }
}
