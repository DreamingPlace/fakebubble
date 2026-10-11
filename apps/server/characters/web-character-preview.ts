import { randomUUID, createHash } from 'node:crypto';
import type { Clock, RelationshipPreset, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { hasCharacterPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { identifier, keys, nonempty, record } from './template-validation.ts';
import { promptMessages } from '../generation/accepted-text-prompt.ts';
import { textPolicyHash } from '../generation/text-generation-policy.ts';
import { instantAtLocalMinute } from '../../../packages/domain/schedule.ts';
import { characterProfileHash, type WebCharacterProfile } from './web-character-catalog.ts';
import { installWebCharacterPreviews } from './web-character-preview-schema.ts';

export const previewDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const previewPolicy = textPolicyHash();
export interface PreviewActor {
  memberId: string;
  sessionId: string;
}
export interface WebPreviewJob extends PreviewActor {
  id: string;
  character_id: string;
  revision: number;
  profile_hash: string;
  request_digest: string;
  request_json: string;
  prompt_hash: string;
  status: string;
  deadline_at: number;
  lease_until: number | null;
  lease_token: string | null;
  retry_at: number;
  result_json: string | null;
  error_code: string | null;
  created_at: number;
}
export function readWebPreview(store: BusinessStore, id: string) {
  const row = store.get<WebPreviewJob>(
    `SELECT p.*,j.revision,j.profile_hash,j.request_digest,j.deadline_at,j.lease_token,j.retry_at,
    j.member_id memberId,j.session_id sessionId FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
    WHERE p.id=?`,
    id,
  );
  ensure(row, 'NOT_FOUND');
  return row;
}
export function requirePreviewActor(store: BusinessStore, now: number, actor: PreviewActor, id: string) {
  const row = store.get<{ role: string; permissions_json: string }>(
    `SELECT m.role,m.permissions_json FROM web_admin_members m
    JOIN web_admin_session_members a ON a.member_id=m.id JOIN admin_sessions s ON s.id=a.session_id
    WHERE m.id=? AND s.id=? AND s.revoked_at IS NULL AND s.expires_at>?`,
    actor.memberId,
    actor.sessionId,
    now,
  );
  ensure(row, 'ADMIN_UNAUTHORIZED');
  ensure(
    row.role === 'owner' || hasCharacterPermission(JSON.parse(row.permissions_json), 'preview', id),
    'ADMIN_PERMISSION_REQUIRED',
  );
}
export function currentWebPreview(store: BusinessStore, now: number, row: WebPreviewJob) {
  requirePreviewActor(store, now, row, row.character_id);
  ensure(row.deadline_at > now, 'PREVIEW_EXPIRED');
  const revision = store.get<{ profile_json: string; content_hash: string }>(
    `SELECT r.* FROM web_character_revisions r
    JOIN web_character_drafts d ON d.character_id=r.character_id AND d.revision=r.revision
    WHERE r.character_id=? AND r.revision=?`,
    row.character_id,
    row.revision,
  );
  ensure(
    revision?.content_hash === row.profile_hash &&
      characterProfileHash(JSON.parse(revision.profile_json)) === row.profile_hash,
    'DRAFT_CONFLICT',
  );
  ensure(
    previewDigest(row.request_json) === row.request_digest && row.prompt_hash === previewPolicy,
    'PREVIEW_REQUEST_CHANGED',
  );
  const request = JSON.parse(row.request_json) as TextGenerationRequest;
  ensure(
    request.jobId === row.id &&
      request.scope.worldId === 'admin-preview-' + row.id &&
      request.scope.conversationId === row.id &&
      request.scope.characterId === row.character_id &&
      contentHash(request.character) ===
        contentHash((JSON.parse(revision.profile_json) as WebCharacterProfile).template),
    'PREVIEW_REQUEST_CHANGED',
  );
  return request;
}
/** The admin's own synthetic input, read back from the immutable stored request; admin-only routes. */
function previewInput(requestJson: string): string | null {
  try {
    const text = (JSON.parse(requestJson) as { messages?: Array<{ text?: unknown }> }).messages?.[0]?.text;
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}
export function webPreviewDTO(row: WebPreviewJob) {
  return {
    previewId: row.id,
    characterId: row.character_id,
    draftRevision: row.revision,
    profileHash: row.profile_hash,
    status: row.status,
    errorCode: row.error_code,
    input: previewInput(row.request_json),
    createdAt: row.created_at,
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

export const PREVIEW_INPUT_MAX = 4000;
export const PREVIEW_RUN_MAX = 50;
export const PREVIEW_NOTE_MAX = 300;
const RELATIONSHIPS = ['new', 'friend', 'close_friend', 'lover'];
/** "HH:MM" -> minutes after midnight; the only accepted spelling of a simulated time. */
export function parseSimulatedTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value) : null;
  ensure(match, 'INVALID_SIMULATED_TIME');
  return Number(match[1]) * 60 + Number(match[2]);
}
/**
 * PREVIEW ONLY. The request clock of an admin preview: the real clock, or the UTC instant at which the character's OWN
 * schedule zone reads the chosen wall-clock time on today's date there. The zone is read from the template, never
 * supplied; the scope must be an isolated admin-preview scope, so no live (player) request can pass through here.
 */
export function previewInstant(
  scope: Pick<TextGenerationRequest['scope'], 'worldId'>,
  realNow: number,
  timeZone: string,
  simulatedMinute: number | null,
) {
  ensure(scope.worldId.startsWith('admin-preview-'), 'SIMULATED_TIME_PREVIEW_ONLY');
  return simulatedMinute === null ? realNow : instantAtLocalMinute(realNow, timeZone, simulatedMinute);
}
interface QueuedInput {
  requestId: string;
  draftRevision: number;
  profileHash: string;
  relationship: string;
  message: string;
  simulatedMinute: number | null;
  deadlineAt: (now: number) => number;
}
function startFields(input: Record<string, unknown>) {
  identifier(input.requestId);
  ensure(
    Number.isSafeInteger(input.draftRevision) &&
      Number(input.draftRevision) > 0 &&
      typeof input.profileHash === 'string' &&
      /^[a-f0-9]{64}$/.test(input.profileHash),
    'INVALID_DRAFT_REVISION',
  );
  ensure(RELATIONSHIPS.includes(String(input.relationship)), 'INVALID_RELATIONSHIP');
  return {
    requestId: input.requestId as string,
    draftRevision: Number(input.draftRevision),
    profileHash: input.profileHash as string,
    relationship: input.relationship as string,
    simulatedMinute: parseSimulatedTime(input.simulatedTime),
  };
}

/** Isolated operation scope, never a player world/conversation or a source of player memory. */
export class WebCharacterPreviews {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly id: () => string;
  constructor(store: BusinessStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.id = nextId;
    installWebCharacterPreviews(store);
  }
  start(actor: PreviewActor, characterId: string, input: unknown) {
    identifier(characterId);
    record(input);
    keys(input, ['requestId', 'draftRevision', 'profileHash', 'relationship', 'message', 'simulatedTime']);
    nonempty(input.message, PREVIEW_INPUT_MAX);
    const fields = startFields(input);
    const digest = contentHash([actor.memberId, characterId, input]);
    return this.store.transaction(() => {
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      requirePreviewActor(this.store, now, actor, characterId);
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM admin_previews WHERE request_id=?',
        fields.requestId,
      );
      if (prior) {
        ensure(prior.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
        return webPreviewDTO(readWebPreview(this.store, prior.id));
      }
      ensure(
        this.store.get<{
          n: number;
        }>(`SELECT count(*) n FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status IN ('queued','generating')`)!.n < 8,
        'PREVIEW_QUEUE_FULL',
      );
      const id = this.enqueue(actor, characterId, now, digest, {
        ...fields,
        message: input.message as string,
        deadlineAt: (at) => at + 600_000,
      });
      return webPreviewDTO(readWebPreview(this.store, id));
    });
  }
  /**
   * One batch submission = one run: the run row and all its previews are written in ONE transaction, so a lost reply
   * is replayed by requestId and can never leave half a run behind. The previews are queued exactly like single ones
   * (same lease, ledger, reservation-before-send); the runner takes them one at a time, in ordinal order.
   */
  startRun(actor: PreviewActor, characterId: string, input: unknown) {
    identifier(characterId);
    record(input);
    keys(input, [
      'requestId',
      'draftRevision',
      'profileHash',
      'relationship',
      'label',
      'simulatedTime',
      'inputs',
      'evalSetId',
    ]);
    const fields = startFields(input);
    ensure(input.label === undefined || input.label === null || typeof input.label === 'string', 'INVALID_RUN_LABEL');
    const label = typeof input.label === 'string' && input.label.trim() ? input.label.trim() : null;
    ensure(label === null || [...label].length <= 60, 'INVALID_RUN_LABEL');
    ensure((input.inputs === undefined) !== (input.evalSetId === undefined), 'INVALID_RUN_INPUTS');
    if (input.evalSetId !== undefined) identifier(input.evalSetId);
    const digest = contentHash([actor.memberId, characterId, 'run', input]);
    return this.store.transaction(() => {
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      requirePreviewActor(this.store, now, actor, characterId);
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_preview_runs WHERE request_id=?',
        fields.requestId,
      );
      if (prior) {
        ensure(prior.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
        return { runId: prior.id, replayed: true };
      }
      let lines: Array<{ text: string; note: string | null }>,
        evalSet: { id: string; version: number } | null = null;
      if (typeof input.evalSetId === 'string') {
        const set = this.store.get<{ id: string; version: number; items_json: string }>(
          'SELECT id,version,items_json FROM web_eval_sets WHERE id=?',
          input.evalSetId,
        );
        ensure(set, 'EVAL_SET_NOT_FOUND');
        evalSet = { id: set.id, version: set.version };
        lines = (JSON.parse(set.items_json) as Array<{ text: string; note?: string | null }>).map((item) => ({
          text: item.text,
          note: item.note ?? null,
        }));
      } else {
        ensure(Array.isArray(input.inputs), 'INVALID_RUN_INPUTS');
        lines = input.inputs.map((item: unknown) => {
          record(item);
          keys(item, ['text', 'note']);
          nonempty(item.text, PREVIEW_INPUT_MAX);
          ensure(
            item.note === undefined ||
              item.note === null ||
              (typeof item.note === 'string' && [...item.note].length <= PREVIEW_NOTE_MAX),
            'INVALID_RUN_INPUTS',
          );
          return {
            text: item.text as string,
            note: typeof item.note === 'string' && item.note.trim() ? item.note : null,
          };
        });
      }
      ensure(lines.length >= 1 && lines.length <= PREVIEW_RUN_MAX, 'INVALID_RUN_INPUTS');
      ensure(
        this.store.get<{
          n: number;
        }>(`SELECT count(*) n FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
        WHERE p.status IN ('queued','generating')`)!.n +
          lines.length <=
          64,
        'PREVIEW_QUEUE_FULL',
      );
      const runId = this.id();
      identifier(runId);
      // The zone is read from the saved draft inside enqueue(); the run records what was actually used.
      const first = this.draftProfile(characterId, fields.draftRevision, fields.profileHash).profile;
      this.store.run(
        `INSERT INTO web_preview_runs(id,request_id,request_hash,character_id,label,draft_revision,profile_hash,
        relationship,simulated_minute,time_zone,eval_set_id,eval_set_version,item_count,created_by,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId,
        fields.requestId,
        digest,
        characterId,
        label,
        fields.draftRevision,
        fields.profileHash,
        fields.relationship,
        fields.simulatedMinute,
        first.template.schedule.timeZone,
        evalSet?.id ?? null,
        evalSet?.version ?? null,
        lines.length,
        actor.memberId,
        now,
      );
      lines.forEach((line, index) => {
        const id = this.enqueue(actor, characterId, now, digest, {
          ...fields,
          requestId: `${fields.requestId}-${index + 1}`,
          message: line.text,
          deadlineAt: (at) => at + 600_000 + index * 120_000,
        });
        this.store.run(
          'INSERT INTO web_preview_run_items(run_id,ordinal,preview_id,note) VALUES (?,?,?,?)',
          runId,
          index + 1,
          id,
          line.note,
        );
      });
      this.store.run(
        'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        actor.memberId,
        'character-preview-run-queued',
        runId,
        now,
      );
      return { runId, replayed: false };
    });
  }
  private draftProfile(characterId: string, revision: number, profileHash: string) {
    const draft = this.store.get<{ profile_json: string; content_hash: string; base_version: number | null }>(
      `SELECT r.*
      FROM web_character_revisions r JOIN web_character_drafts d ON d.character_id=r.character_id AND d.revision=r.revision
      WHERE r.character_id=? AND r.revision=?`,
      characterId,
      revision,
    );
    ensure(draft?.content_hash === profileHash, 'DRAFT_CONFLICT');
    const profile = JSON.parse(draft.profile_json) as WebCharacterProfile;
    ensure(characterProfileHash(profile) === profileHash, 'DRAFT_CONFLICT');
    return { profile, baseVersion: draft.base_version };
  }
  /** Inside the caller's transaction. Returns the new preview id. */
  private enqueue(actor: PreviewActor, characterId: string, now: number, digest: string, q: QueuedInput) {
    const { profile, baseVersion } = this.draftProfile(characterId, q.draftRevision, q.profileHash);
    const id = this.id(),
      messageId = this.id();
    identifier(id);
    identifier(messageId);
    const scope = { worldId: 'admin-preview-' + id, conversationId: id, characterId };
    const zone = profile.template.schedule.timeZone;
    const at = previewInstant(scope, now, zone, q.simulatedMinute);
    const request: TextGenerationRequest = {
      jobId: id,
      scope,
      now: at,
      character: profile.template,
      relationship: q.relationship as RelationshipPreset,
      requiredMessageIds: [messageId],
      mustClose: false,
      evidence: [],
      deliveryMode: profile.template.voice ? 'voice' : 'text',
      messages: [
        {
          id: messageId,
          worldId: scope.worldId,
          conversationId: id,
          authorKind: 'player',
          authorId: 'admin-preview',
          text: q.message,
          createdAt: at,
          delivery: 'text',
          voiceFallback: false,
          mediaId: null,
          proactive: false,
        },
      ],
    };
    promptMessages(request);
    const legacyRevision = this.store.get<{ n: number }>(
      'SELECT coalesce(max(revision),0)+1 n FROM character_draft_revisions WHERE character_id=?',
      characterId,
    )!.n;
    this.store.run(
      'INSERT INTO character_draft_revisions VALUES (?,?,?,?,?,?,?)',
      characterId,
      legacyRevision,
      baseVersion,
      JSON.stringify(profile.template),
      contentHash(profile.template),
      now,
      actor.sessionId,
    );
    const json = JSON.stringify(request);
    this.store.run(
      `INSERT INTO admin_previews(id,character_id,draft_revision,content_hash,prompt_hash,request_id,request_hash,
      status,evidence_kind,request_json,created_at) VALUES (?,?,?,?,?,?,?,'queued','deepseek',?,?)`,
      id,
      characterId,
      legacyRevision,
      contentHash(profile.template),
      previewPolicy,
      q.requestId,
      digest,
      json,
      now,
    );
    this.store.run(
      'INSERT INTO web_character_preview_jobs VALUES (?,?,?,?,?,?,?,?,NULL,?)',
      id,
      characterId,
      q.draftRevision,
      q.profileHash,
      previewDigest(json),
      actor.memberId,
      actor.sessionId,
      q.deadlineAt(now),
      now,
    );
    if (q.simulatedMinute !== null)
      this.store.run('INSERT INTO web_preview_marks VALUES (?,?,?)', id, q.simulatedMinute, zone);
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor.memberId,
      'character-preview-queued',
      id,
      now,
    );
    return id;
  }
}
