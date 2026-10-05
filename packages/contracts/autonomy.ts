export interface AutonomyPolicy {
  enabled: boolean;
  dailyProbability: number;
  startMinute: number;
  endMinute: number;
  minimumGapMinutes: number;
}

// Product starting points, not inferred facts about a character or a daily message target.
export const AUTONOMY_PRESETS = {
  standard: { enabled: true, dailyProbability: 0.6, startMinute: 720, endMinute: 1320, minimumGapMinutes: 360 },
  veryLow: { enabled: true, dailyProbability: 0.07, startMinute: 720, endMinute: 1320, minimumGapMinutes: 360 },
} as const satisfies Record<string, AutonomyPolicy>;
