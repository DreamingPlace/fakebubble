import type { AutonomyPolicy } from '../contracts/index.ts';
import { ensure } from './errors.ts';

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
