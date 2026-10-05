import type { CharacterTemplate, ScheduleSlot, Weekday, WeeklySchedule } from '../contracts/index.ts';

export const MINUTE = 60_000;
export const RULES = Object.freeze({
  redrawAfterMs: 45 * MINUTE,
  idleMs: 10 * MINUTE,
  graceMs: 10 * MINUTE,
  catchUpDelayMs: 15 * MINUTE,
  jobLeaseMs: 5 * MINUTE,
  proactiveTtlMs: 30 * MINUTE,
  perCharacterDaily: 3,
  perWorldDaily: 6,
  maxReplyItems: 32,
  maxPlayerMessageCharacters: 500,
});

export function defaultSchedule(timeZone = 'Asia/Singapore'): WeeklySchedule {
  const bounds = [0, 420, 720, 840, 1080, 1380, 1440];
  const days = {} as Record<Weekday, ScheduleSlot[]>;
  for (let day = 0; day < 7; day++) {
    const probabilities =
      day === 0 || day === 6 ? [0.1, 0.65, 0.85, 0.7, 0.9, 0.5] : [0.05, 0.35, 0.8, 0.35, 0.9, 0.25];
    days[day as Weekday] = probabilities.map((probability, i) => ({
      startMinute: bounds[i]!,
      endMinute: bounds[i + 1]!,
      probability,
      catchUp: i === 2 || i === 4,
    }));
  }
  return { timeZone, days };
}

// Test fixtures only. Never import these into a real player's world implicitly.
export function testCharacters(): CharacterTemplate[] {
  return ['甲', '乙', '丙'].map((name, index) => ({
    id: `fixture-${index + 1}`,
    name: `测试角色${name}`,
    version: 1,
    fictional: true,
    persona: '仅供规则测试的虚构角色，不代表真实人物。',
    schedule: defaultSchedule(),
  }));
}
