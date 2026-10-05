import type { AutonomyPolicy, RandomSource, WeeklySchedule } from '../contracts/index.ts';
import { MINUTE, RULES } from './defaults.ts';
import { ensure } from './errors.ts';
import { localTime } from './schedule.ts';

export function validateAutonomy(value: unknown): asserts value is AutonomyPolicy {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_AUTONOMY');
  const policy = value as AutonomyPolicy;
  ensure(
    Object.keys(policy).length === 5 &&
      Object.keys(policy).every((key) =>
        ['enabled', 'dailyProbability', 'startMinute', 'endMinute', 'minimumGapMinutes'].includes(key),
      ),
    'INVALID_AUTONOMY',
  );
  ensure(
    typeof policy.enabled === 'boolean' &&
      Number.isFinite(policy.dailyProbability) &&
      policy.dailyProbability >= 0 &&
      policy.dailyProbability <= 1 &&
      Number.isInteger(policy.startMinute) &&
      policy.startMinute >= 0 &&
      Number.isInteger(policy.endMinute) &&
      policy.endMinute > policy.startMinute &&
      policy.endMinute <= 1440 &&
      Number.isInteger(policy.minimumGapMinutes) &&
      policy.minimumGapMinutes >= 0 &&
      policy.minimumGapMinutes <= 7 * 1440,
    'INVALID_AUTONOMY',
  );
}

export interface DailyOpportunity {
  localDay: string;
  roll: number | null;
  timeRoll: number | null;
  scheduledAt: number | null;
  expiresAt: number | null;
  reason: 'DISABLED' | 'NO_ACTIVITY_WINDOW' | 'NOT_SELECTED' | null;
}

/** Called once per persisted local day, never to retry a decision or a generation. */
export function planDailyOpportunity(
  policy: AutonomyPolicy,
  schedule: WeeklySchedule,
  now: number,
  random: RandomSource,
): DailyOpportunity {
  validateAutonomy(policy);
  const localDay = localTime(now, schedule.timeZone).date;
  const empty = { localDay, roll: null, timeRoll: null, scheduledAt: null, expiresAt: null };
  if (!policy.enabled) return { ...empty, reason: 'DISABLED' };
  const minutes: number[] = [];
  const anchor = Date.parse(localDay + 'T00:00:00Z');
  // Enumerate actual instants: DST's repeated hour is real, its missing hour is not.
  for (let at = Math.max(0, anchor - 18 * 60 * MINUTE); at < anchor + 42 * 60 * MINUTE; at += MINUTE) {
    const local = localTime(at, schedule.timeZone);
    if (
      local.date === localDay &&
      local.minute >= policy.startMinute &&
      local.minute < policy.endMinute &&
      schedule.days[local.day].some(
        (slot) => slot.catchUp && local.minute >= slot.startMinute && local.minute < slot.endMinute,
      )
    )
      minutes.push(at);
  }
  if (!minutes.length) return { ...empty, reason: 'NO_ACTIVITY_WINDOW' };
  const draw = () => {
    const value = random.next();
    ensure(Number.isFinite(value) && value >= 0 && value < 1, 'INVALID_RANDOM');
    return value;
  };
  const roll = draw();
  if (roll >= policy.dailyProbability) return { ...empty, roll, reason: 'NOT_SELECTED' };
  const timeRoll = draw();
  const index = Math.floor(timeRoll * minutes.length);
  const scheduledAt = minutes[index]!;
  let expiresAt = scheduledAt + MINUTE;
  for (
    let next = index + 1;
    next < minutes.length && minutes[next] === expiresAt && expiresAt < scheduledAt + RULES.proactiveTtlMs;
    next++
  )
    expiresAt += MINUTE;
  return { localDay, roll, timeRoll, scheduledAt, expiresAt, reason: null };
}
