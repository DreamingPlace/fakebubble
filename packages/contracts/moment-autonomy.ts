import type { AutonomyPolicy } from './autonomy.ts';

// Product defaults, independent of a character's private-contact habits. Not a posting target.
export const MOMENT_POST_DEFAULTS: Readonly<AutonomyPolicy> = Object.freeze({ enabled: true, dailyProbability: 0.35,
  startMinute: 720, endMinute: 1320, minimumGapMinutes: 720 });
export const MOMENT_POST_LIMITS = Object.freeze({ perCharacterDaily: 1, perWorldDaily: 3, worldGapMs: 5 * 60_000 });
export interface MomentSettings { worldId: string; characterId: string; revision: number; policy: AutonomyPolicy }
export interface SaveMomentSettingsInput { requestId: string; expectedRevision: number; policy: AutonomyPolicy }
export interface MomentSettingsReceipt extends MomentSettings { duplicate: boolean }
export interface MomentActivity {
  characterId: string; status: 'scheduled' | 'generating' | 'failed'; errorCode: string | null; nextAttemptAt: number | null;
}
