export interface AutonomyPolicy {
  enabled: boolean;
  dailyProbability: number;
  startMinute: number;
  endMinute: number;
  minimumGapMinutes: number;
}
