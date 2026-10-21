import type { ScheduleSlot, Weekday, WeeklySchedule } from '../contracts/index.ts';

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
