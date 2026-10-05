import { createHash } from 'node:crypto';
import { playerSuspended } from './beta-accounts.ts';
import type {
  AutonomyPolicy,
  CharacterScope,
  CharacterTemplate,
  WeeklySchedule,
} from '../../packages/contracts/index.ts';
import { planDailyOpportunity } from '../../packages/domain/autonomy.ts';
import { MINUTE } from '../../packages/domain/defaults.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { localTime } from '../../packages/domain/schedule.ts';
import type { Engine } from './engine.ts';
import type { BusinessStore as Store } from './store-contract.ts';

const values = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const scoped = 'world_id=? AND conversation_id=? AND character_id=?';
const worldGapMs = 5 * MINUTE;
export const PROACTIVE_DEFERRALS = new Set([
  'QUIET_HOURS',
  'QUOTA_EXCEEDED',
  'AUTONOMY_COOLDOWN',
  'AUTONOMY_WORLD_BUSY',
]);
export const PROACTIVE_CANCELLATIONS = new Set([
  ...PROACTIVE_DEFERRALS,
  'REPLIES_FIRST',
  'INTENT_EXPIRED',
  'AUTONOMY_DISABLED',
  'AUTONOMY_MISSED',
]);
interface DayRow extends CharacterScope {
  local_day: string;
  planned_at: number;
  scheduled_at: number;
  expires_at: number;
  status: 'scheduled' | 'pending';
  intent_id: string | null;
  config_json: string;
}

/** Additional gates belong only to automatic daily opportunities, not explicit/manual intents. */
export function checkAutonomyGate(
  store: Store,
  scope: CharacterScope,
  intentId: string,
  now: number,
  currentTemplate: CharacterTemplate,
  jobId?: string,
): boolean {
  const row = store.get<{ status: string; expires_at: number; policy_json: string; schedule_json: string }>(
    `SELECT status,expires_at,policy_json,schedule_json FROM autonomy_days WHERE ${scoped} AND intent_id=?`,
    ...values(scope),
    intentId,
  );
  if (!row) return false;
  ensure(currentTemplate.autonomy?.enabled, 'AUTONOMY_DISABLED');
  ensure(row.status === 'pending' && row.expires_at > now, 'INTENT_EXPIRED');
  const policy: AutonomyPolicy = JSON.parse(row.policy_json);
  const schedule: WeeklySchedule = JSON.parse(row.schedule_json);
  const local = localTime(now, schedule.timeZone);
  ensure(
    local.minute >= policy.startMinute &&
      local.minute < policy.endMinute &&
      schedule.days[local.day].some(
        (slot) => slot.catchUp && local.minute >= slot.startMinute && local.minute < slot.endMinute,
      ),
    'INTENT_EXPIRED',
  );
  const own = store.get<{ at: number | null }>(
    `SELECT max(at) at FROM (
    SELECT created_at at FROM messages WHERE world_id=? AND conversation_id=? AND author_kind='character' AND author_id=? AND proactive=1
    UNION ALL SELECT last_at at FROM retired_proactive_usage WHERE world_id=? AND character_id=?)`,
    ...values(scope),
    scope.worldId,
    scope.characterId,
  )!.at;
  // Only aggregate publication timestamps cross conversations, as in the world's daily quota. No bodies are read.
  const world = store.get<{ at: number | null }>(
    `SELECT max(at) at FROM (SELECT created_at at FROM messages WHERE world_id=? AND proactive=1
    UNION ALL SELECT last_at at FROM retired_proactive_usage WHERE world_id=?)`,
    scope.worldId,
    scope.worldId,
  )!.at;
  ensure(
    (own === null || now - own >= policy.minimumGapMinutes * MINUTE) && (world === null || now - world >= worldGapMs),
    'AUTONOMY_COOLDOWN',
  );
  ensure(
    !store.get(
      `SELECT 1 FROM jobs WHERE world_id=? AND kind='proactive' AND surface='chat' AND status='leased' AND lease_until>? AND id!=?`,
      scope.worldId,
      now,
      jobId ?? '',
    ),
    'AUTONOMY_WORLD_BUSY',
  );
  return true;
}

/** One persisted calendar decision per configured private contact; no model or network here. */
export class AutonomyScheduler {
  readonly engine: Engine;
  readonly startedAt: number;
  constructor(engine: Engine) {
    this.engine = engine;
    this.startedAt = engine.clock.now();
  }
  get store() {
    return this.engine.store;
  }

  advance(): string[] {
    return this.store.transaction(() => {
      const now = this.engine.clock.now();
      const changed = new Set<string>();
      const contacts = this.store.all<CharacterScope & { config_json: string }>(
        `SELECT w.owner_id AS playerId,c.world_id AS worldId,c.conversation_id AS conversationId,c.character_id AS characterId,t.config_json
         FROM contacts c JOIN worlds w ON w.id=c.world_id
         JOIN conversations v ON v.world_id=c.world_id AND v.id=c.conversation_id AND v.kind='private'
         JOIN character_templates t ON t.id=c.character_id ORDER BY c.world_id,c.conversation_id,c.character_id`,
      );
      for (const scope of contacts) {
        if (playerSuspended(this.store, scope.playerId)) continue;
        const template: CharacterTemplate = JSON.parse(scope.config_json);
        if (!template.autonomy) continue;
        const day = localTime(now, template.schedule.timeZone).date;
        // Moving a clock/time zone back, editing a schedule or toggling a setting cannot refresh a day.
        if (
          this.store.get(`SELECT 1 FROM autonomy_days WHERE ${scoped} AND local_day>=? LIMIT 1`, ...values(scope), day)
        )
          continue;
        const decision = planDailyOpportunity(template.autonomy, template.schedule, now, this.engine.random);
        const missed = decision.scheduledAt !== null && decision.scheduledAt < now;
        this.store.run(
          `INSERT INTO autonomy_days(world_id,conversation_id,character_id,local_day,template_version,schedule_json,policy_json,
          planned_at,roll,time_roll,scheduled_at,expires_at,status,reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ...values(scope),
          decision.localDay,
          template.version,
          JSON.stringify(template.schedule),
          JSON.stringify(template.autonomy),
          now,
          decision.roll,
          decision.timeRoll,
          decision.scheduledAt,
          decision.expiresAt,
          missed ? 'expired' : decision.reason ? 'skipped' : 'scheduled',
          missed ? 'AUTONOMY_MISSED' : decision.reason,
        );
      }
      const days =
        this.store.all<DayRow>(`SELECT w.owner_id AS playerId,d.world_id AS worldId,d.conversation_id AS conversationId,
        d.character_id AS characterId,d.local_day,d.planned_at,d.scheduled_at,d.expires_at,d.status,d.intent_id,t.config_json
        FROM autonomy_days d JOIN worlds w ON w.id=d.world_id JOIN character_templates t ON t.id=d.character_id
        WHERE d.status IN ('scheduled','pending') ORDER BY d.scheduled_at,d.world_id,d.conversation_id`);
      for (const day of days) {
        if (playerSuspended(this.store, day.playerId)) continue;
        const current: CharacterTemplate = JSON.parse(day.config_json);
        if (!current.autonomy?.enabled) {
          this.expire(day, 'AUTONOMY_DISABLED');
          changed.add(day.worldId);
          continue;
        }
        // Resume only future opportunities. Pending replies remain eligible; stale new topics do not get replayed.
        if ((day.planned_at < this.startedAt && day.scheduled_at < this.startedAt) || day.expires_at <= now) {
          this.expire(day, 'AUTONOMY_MISSED');
          changed.add(day.worldId);
          continue;
        }
        if (day.status === 'pending') {
          const intent = this.store.get<{ status: string }>(
            `SELECT status FROM proactive_intents WHERE ${scoped} AND id=?`,
            ...values(day),
            day.intent_id,
          )!;
          if (intent.status !== 'pending') {
            this.store.run(
              `UPDATE autonomy_days SET status=?,reason=? WHERE ${scoped} AND local_day=?`,
              intent.status,
              intent.status === 'complete' ? null : 'INTENT_EXPIRED',
              ...values(day),
              day.local_day,
            );
            changed.add(day.worldId);
          }
          continue;
        }
        if (day.scheduled_at > now) continue;
        // A sleeping Mac can resume without restarting Node; do not turn an old due time into a catch-up burst.
        if (now - day.scheduled_at > 2 * MINUTE) {
          this.expire(day, 'AUTONOMY_MISSED');
          continue;
        }
        try {
          const requestId =
            'daily-' +
            createHash('sha256')
              .update(JSON.stringify([...values(day), day.local_day]))
              .digest('hex');
          const intentId = this.engine.requestProactive(day, requestId, day.expires_at);
          this.store.run(
            `UPDATE autonomy_days SET status='pending',intent_id=? WHERE ${scoped} AND local_day=?`,
            intentId,
            ...values(day),
            day.local_day,
          );
          changed.add(day.worldId);
        } catch (error) {
          if (!(error instanceof DomainError) || !PROACTIVE_DEFERRALS.has(error.code)) throw error;
          this.expire(day, error.code);
        }
      }
      return [...changed];
    });
  }
  private expire(day: DayRow, reason: string) {
    this.store.run(
      `UPDATE autonomy_days SET status='expired',reason=? WHERE ${scoped} AND local_day=?`,
      reason,
      ...values(day),
      day.local_day,
    );
    if (day.intent_id) {
      this.store.run(
        `UPDATE proactive_intents SET status='expired' WHERE ${scoped} AND id=? AND status='pending'`,
        ...values(day),
        day.intent_id,
      );
      this.store.run(
        `UPDATE jobs SET status='failed',failure_code=? WHERE ${scoped} AND intent_id=? AND kind='proactive' AND status='leased'`,
        reason,
        ...values(day),
        day.intent_id,
      );
    }
  }
}
