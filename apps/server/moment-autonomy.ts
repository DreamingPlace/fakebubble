import { createHash } from 'node:crypto';
import { playerSuspended } from './beta-accounts.ts';
import { playerGenerationError } from './player-generation-error.ts';
import type { AutonomyPolicy, CharacterScope, CharacterTemplate, PlayerContext, TextGenerationRequest, WeeklySchedule } from '../../packages/contracts/index.ts';
import { MOMENT_POST_DEFAULTS, MOMENT_POST_LIMITS } from '../../packages/contracts/moment-autonomy.ts';
import type { MomentActivity, MomentSettings, MomentSettingsReceipt, SaveMomentSettingsInput } from '../../packages/contracts/moment-autonomy.ts';
import { planDailyOpportunity, validateAutonomy } from '../../packages/domain/autonomy.ts';
import { MINUTE } from '../../packages/domain/defaults.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { localTime } from '../../packages/domain/schedule.ts';
import type { Engine } from './engine.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { textQueueSQL } from './text-queue.ts';

const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
export const MOMENT_POST_DEFERRALS = new Set(['MOMENT_POST_COOLDOWN', 'MOMENT_POST_WORLD_BUSY', 'MOMENT_POST_QUOTA', 'MOMENT_POST_QUIET']);
export const MOMENT_POST_CANCELLATIONS = new Set([...MOMENT_POST_DEFERRALS, 'MOMENT_POST_EXPIRED', 'MOMENT_POST_DISABLED']);
function authorize(store: Store, context: PlayerContext, characterId?: string) {
  ensure(store.get('SELECT 1 FROM worlds WHERE id=? AND owner_id=?', context.worldId, context.playerId), 'FORBIDDEN');
  if (characterId !== undefined) ensure(store.get('SELECT 1 FROM world_characters WHERE world_id=? AND character_id=?', context.worldId, characterId), 'NOT_FOUND');
}
export function momentSettings(store: Store, context: PlayerContext, characterId: string): MomentSettings {
  authorize(store, context, characterId);
  const row = store.get<{ revision: number; policy_json: string }>('SELECT revision,policy_json FROM moment_post_settings WHERE world_id=? AND character_id=?', context.worldId, characterId);
  return { worldId: context.worldId, characterId, revision: row?.revision ?? 0, policy: row ? JSON.parse(row.policy_json) : { ...MOMENT_POST_DEFAULTS } };
}
export function listMomentSettings(store: Store, context: PlayerContext): MomentSettings[] {
  authorize(store, context);
  return store.all<{ character_id: string }>('SELECT character_id FROM world_characters WHERE world_id=? ORDER BY character_id', context.worldId)
    .map(row => momentSettings(store, context, row.character_id));
}
function expire(store: Store, scope: CharacterScope, localDay: string, reason: string) {
  store.run(`UPDATE moment_post_days SET status='expired',reason=? WHERE world_id=? AND character_id=? AND local_day=? AND status IN ('scheduled','pending')`,
    reason, scope.worldId, scope.characterId, localDay);
  store.run(`UPDATE dialogue_deliveries SET state='cancelled' WHERE world_id=? AND conversation_id=? AND character_id=? AND state='queued'`, ...params(scope));
  store.run(`UPDATE jobs SET status='failed',failure_code=? WHERE world_id=? AND conversation_id=? AND character_id=? AND surface='moment_post' AND status='leased'`, reason, ...params(scope));
}
export function saveMomentSettings(store: Store, context: PlayerContext, characterId: string, value: unknown): MomentSettingsReceipt {
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'expectedRevision,policy,requestId', 'INVALID_REQUEST');
  const input = value as SaveMomentSettingsInput;
  ensure(typeof input.requestId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(input.requestId) &&
    Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0 && input.expectedRevision < Number.MAX_SAFE_INTEGER, 'INVALID_REQUEST');
  validateAutonomy(input.policy);
  const { enabled, dailyProbability, startMinute, endMinute, minimumGapMinutes } = input.policy;
  const policy = { enabled, dailyProbability, startMinute, endMinute, minimumGapMinutes };
  const requestHash = createHash('sha256').update(JSON.stringify([characterId, input.expectedRevision, policy])).digest('hex');
  return store.transaction(() => {
    const current = momentSettings(store, context, characterId);
    const old = store.get<{ request_hash: string; result_json: string }>('SELECT request_hash,result_json FROM moment_post_setting_requests WHERE world_id=? AND request_id=?', context.worldId, input.requestId);
    if (old) { ensure(old.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT'); return { ...JSON.parse(old.result_json), duplicate: true }; }
    ensure(current.revision === input.expectedRevision, 'MOMENT_SETTINGS_REVISION_CONFLICT');
    const result = { worldId: context.worldId, characterId, revision: current.revision + 1, policy, duplicate: false };
    store.run(`INSERT INTO moment_post_settings VALUES (?,?,?,?) ON CONFLICT(world_id,character_id) DO UPDATE SET revision=excluded.revision,policy_json=excluded.policy_json`,
      context.worldId, characterId, result.revision, JSON.stringify(policy));
    store.run('INSERT INTO moment_post_setting_requests VALUES (?,?,?,?,?)', context.worldId, characterId, input.requestId, requestHash, JSON.stringify(result));
    // Disabling is immediate, including reviewed but not yet published drafts. Enabling never redraws today.
    if (!enabled) for (const day of store.all<{ local_day: string; conversation_id: string | null }>(
      `SELECT local_day,conversation_id FROM moment_post_days WHERE world_id=? AND character_id=? AND status IN ('scheduled','pending')`, context.worldId, characterId)) {
      expire(store, { ...context, characterId, conversationId: day.conversation_id ?? '' }, day.local_day, 'MOMENT_POST_DISABLED');
    }
    return result;
  });
}

/** Posting is a separate surface, not a private contact. Quotas count committed roots, not attempts or bubbles. */
export function checkMomentPostGate(store: Store, scope: CharacterScope, now: number, jobId = '') {
  ensure(momentSettings(store, scope, scope.characterId).policy.enabled, 'MOMENT_POST_DISABLED');
  const row = store.get<{ expires_at: number; scheduled_at: number; status: string; policy_json: string; schedule_json: string }>(
    `SELECT expires_at,scheduled_at,status,policy_json,schedule_json FROM moment_post_days WHERE world_id=? AND conversation_id=? AND character_id=?`, ...params(scope));
  ensure(row?.status === 'pending' && row.scheduled_at <= now && row.expires_at > now, 'MOMENT_POST_EXPIRED');
  const policy: AutonomyPolicy = JSON.parse(row.policy_json), schedule: WeeklySchedule = JSON.parse(row.schedule_json);
  const local = localTime(now, schedule.timeZone);
  ensure(local.minute >= policy.startMinute && local.minute < policy.endMinute &&
    schedule.days[local.day].some(slot => slot.catchUp && local.minute >= slot.startMinute && local.minute < slot.endMinute), 'MOMENT_POST_EXPIRED');
  const world = store.get<{ time_zone: string; policy_json: string }>('SELECT time_zone,policy_json FROM worlds WHERE id=?', scope.worldId)!;
  const worldLocal = localTime(now, world.time_zone);
  const { quietStartMinute: start, quietEndMinute: end } = JSON.parse(world.policy_json);
  ensure(!(start === end ? false : start < end ? worldLocal.minute >= start && worldLocal.minute < end : worldLocal.minute >= start || worldLocal.minute < end), 'MOMENT_POST_QUIET');
  // Cross-conversation reads here are aggregates only; no private text enters this surface.
  const usage = store.get<{ actor: number; total: number; last_own: number | null; last_world: number | null }>(
    `SELECT coalesce(sum(m.author_id=? AND m.quota_day=?),0) actor,coalesce(sum(m.quota_day=?),0) total,
      max(CASE WHEN m.author_id=? THEN m.created_at END) last_own,max(m.created_at) last_world
      FROM moment_threads t JOIN messages m ON m.world_id=t.world_id AND m.conversation_id=t.conversation_id AND m.id=t.root_message_id
      WHERE t.world_id=? AND m.author_kind='character'`, scope.characterId, worldLocal.date, worldLocal.date, scope.characterId, scope.worldId)!;
  ensure(usage.actor < MOMENT_POST_LIMITS.perCharacterDaily && usage.total < MOMENT_POST_LIMITS.perWorldDaily, 'MOMENT_POST_QUOTA');
  ensure((usage.last_own === null || now - usage.last_own >= policy.minimumGapMinutes * MINUTE) &&
    (usage.last_world === null || now - usage.last_world >= MOMENT_POST_LIMITS.worldGapMs), 'MOMENT_POST_COOLDOWN');
  ensure(!store.get(`SELECT 1 FROM jobs WHERE world_id=? AND surface='moment_post' AND status='leased' AND lease_until>? AND id!=?`, scope.worldId, now, jobId), 'MOMENT_POST_WORLD_BUSY');
}
export function completeMomentPost(store: Store, scope: CharacterScope, messageId: string) {
  store.run('INSERT INTO moment_threads(world_id,conversation_id,root_message_id,responder_id) VALUES (?,?,?,?)', scope.worldId, scope.conversationId, messageId, scope.characterId);
  store.run(`UPDATE moment_post_days SET status='complete',reason=NULL,published_message_id=? WHERE world_id=? AND conversation_id=? AND character_id=? AND status='pending'`, messageId, ...params(scope));
}

/** Own published posts only, and never widen a restricted post's original audience. Not private/group comments. */
export function ownMomentEvidence(store: Store, scope: CharacterScope): TextGenerationRequest['evidence'] {
  const sources = store.all<{ conversation_id: string; root_message_id: string }>(
    `SELECT t.conversation_id,t.root_message_id FROM moment_threads t JOIN messages m ON m.world_id=t.world_id AND m.conversation_id=t.conversation_id AND m.id=t.root_message_id
     WHERE t.world_id=? AND m.author_kind='character' AND m.author_id=? AND NOT EXISTS (
       SELECT 1 FROM participants audience WHERE audience.world_id=? AND audience.conversation_id=? AND NOT EXISTS (
         SELECT 1 FROM participants old WHERE old.world_id=t.world_id AND old.conversation_id=t.conversation_id AND old.character_id=audience.character_id))
     ORDER BY m.seq DESC LIMIT 6`, scope.worldId, scope.characterId, scope.worldId, scope.conversationId);
  return sources.flatMap(source => {
    const row = store.get<{ body: string; created_at: number; learned_at: number }>(
      `SELECT m.body,m.created_at,k.learned_at FROM messages m JOIN group_message_knowledge k
       ON k.world_id=m.world_id AND k.conversation_id=m.conversation_id AND k.message_id=m.id AND k.character_id=?
       WHERE m.world_id=? AND m.conversation_id=? AND m.id=?`, scope.characterId, scope.worldId, source.conversation_id, source.root_message_id);
    return row ? [{ id: `moment:${source.root_message_id}`, kind: 'observed_moment_message', observedAt: row.learned_at,
      text: JSON.stringify({ sourceConversationId: source.conversation_id, sourceMessageId: source.root_message_id,
        authorKind: 'character', authorName: '自己', text: row.body, occurredAt: row.created_at }) }] : [];
  });
}

export function momentActivities(store: Store, context: PlayerContext): MomentActivity[] {
  authorize(store, context);
  return store.all<{ character_id: string; status: string; error_code: string | null; retry_at: number | null; scheduled_at: number | null }>(
    `SELECT d.character_id,d.status,r.error_code,r.retry_at,d.scheduled_at FROM moment_post_days d
     LEFT JOIN text_retry_state r ON r.world_id=d.world_id AND r.conversation_id=d.conversation_id AND r.character_id=d.character_id
     WHERE d.world_id=? AND (d.status IN ('pending','scheduled') OR (d.status='expired' AND r.error_code IS NOT NULL))
       AND NOT EXISTS (SELECT 1 FROM moment_post_days newer WHERE newer.world_id=d.world_id AND newer.character_id=d.character_id AND newer.local_day>d.local_day)
     ORDER BY d.character_id`, context.worldId).map(row => ({ characterId: row.character_id,
      status: row.error_code ? 'failed' : row.status === 'scheduled' ? 'scheduled' : 'generating', errorCode: store.beta ? playerGenerationError(row.error_code) : row.error_code,
      nextAttemptAt: row.status === 'expired' ? null : row.error_code ? row.retry_at : row.scheduled_at }));
}

/** One persisted opportunity per role/day. No Mac downtime catch-up and no probabilistic retries. */
export class MomentScheduler {
  readonly engine: Engine;
  readonly startedAt: number;
  constructor(engine: Engine) { this.engine = engine; this.startedAt = engine.clock.now(); }
  get store() { return this.engine.store; }
  advance(): string[] {
    return this.store.transaction(() => {
      const now = this.engine.clock.now(), changed = new Set<string>();
      const actors = this.store.all<PlayerContext & { characterId: string; config_json: string }>(
        `SELECT w.owner_id playerId,w.id worldId,c.character_id characterId,t.config_json FROM worlds w
         JOIN world_characters c ON c.world_id=w.id JOIN character_templates t ON t.id=c.character_id ORDER BY w.id,c.character_id`);
      for (const actor of actors) {
        if (playerSuspended(this.store, actor.playerId)) continue;
        const role: CharacterTemplate = JSON.parse(actor.config_json), policy = momentSettings(this.store, actor, actor.characterId).policy;
        const day = localTime(now, role.schedule.timeZone).date;
        if (this.store.get('SELECT 1 FROM moment_post_days WHERE world_id=? AND character_id=? AND local_day>=? LIMIT 1', actor.worldId, actor.characterId, day)) continue;
        const choice = planDailyOpportunity(policy, role.schedule, now, this.engine.random);
        const missed = choice.scheduledAt !== null && choice.scheduledAt < now;
        this.store.run(`INSERT INTO moment_post_days(world_id,character_id,local_day,template_version,schedule_json,policy_json,planned_at,roll,time_roll,scheduled_at,expires_at,status,reason)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, actor.worldId, actor.characterId, choice.localDay, role.version, JSON.stringify(role.schedule), JSON.stringify(policy), now,
          choice.roll, choice.timeRoll, choice.scheduledAt, choice.expiresAt, missed ? 'expired' : choice.reason ? 'skipped' : 'scheduled', missed ? 'MOMENT_POST_EXPIRED' : choice.reason);
        changed.add(actor.worldId);
      }
      const days = this.store.all<CharacterScope & { local_day: string; planned_at: number; scheduled_at: number; expires_at: number; status: string }>(
        `SELECT w.owner_id playerId,d.world_id worldId,d.character_id characterId,coalesce(d.conversation_id,'') conversationId,d.local_day,d.planned_at,d.scheduled_at,d.expires_at,d.status
         FROM moment_post_days d JOIN worlds w ON w.id=d.world_id WHERE d.status IN ('scheduled','pending') ORDER BY d.scheduled_at,d.world_id,d.character_id`);
      for (const day of days) {
        if (playerSuspended(this.store, day.playerId)) continue;
        const reason = !momentSettings(this.store, day, day.characterId).policy.enabled ? 'MOMENT_POST_DISABLED' :
          ((day.planned_at < this.startedAt && day.scheduled_at < this.startedAt) || day.expires_at <= now ||
            (day.status === 'scheduled' && now - day.scheduled_at > 2 * MINUTE)) ? 'MOMENT_POST_EXPIRED' : null;
        if (reason) { expire(this.store, day, day.local_day, reason); changed.add(day.worldId); continue; }
        if (day.status !== 'scheduled' || day.scheduled_at > now) continue;
        const members = this.store.all<{ character_id: string }>('SELECT character_id FROM world_characters WHERE world_id=? AND character_id!=? ORDER BY character_id LIMIT 31', day.worldId, day.characterId);
        const conversationId = this.engine.createConversation(day, [day.characterId, ...members.map(row => row.character_id)], 'moment');
        this.store.run('INSERT INTO moment_post_drafts VALUES (?,?,?,?)', day.worldId, conversationId, day.characterId, day.local_day);
        this.store.run(`UPDATE moment_post_days SET status='pending',conversation_id=? WHERE world_id=? AND character_id=? AND local_day=?`, conversationId, day.worldId, day.characterId, day.local_day);
        changed.add(day.worldId);
      }
      return [...changed];
    });
  }
  ready(): CharacterScope[] {
    return this.store.all<CharacterScope>(textQueueSQL(this.store, `SELECT w.owner_id playerId,d.world_id worldId,d.conversation_id conversationId,d.character_id characterId,d.scheduled_at queuedAt
      FROM moment_post_days d JOIN worlds w ON w.id=d.world_id LEFT JOIN text_retry_state r ON r.world_id=d.world_id AND r.conversation_id=d.conversation_id AND r.character_id=d.character_id
      WHERE d.status='pending' AND d.expires_at>? AND (r.world_id IS NULL OR r.retry_at<=?)
      `, 'queuedAt,worldId,characterId'), this.engine.clock.now(), this.engine.clock.now());
  }
}
