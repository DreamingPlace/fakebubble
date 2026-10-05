import type { ScheduleSlot, Weekday, WeeklySchedule } from '../contracts/index.ts';
import { MINUTE, RULES } from './defaults.ts';
import { ensure } from './errors.ts';

const formatters = new Map<string, Intl.DateTimeFormat>();
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function formatter(timeZone: string): Intl.DateTimeFormat {
  let result = formatters.get(timeZone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit',
      day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, result);
  }
  return result;
}

export function localTime(at: number, timeZone: string): { day: Weekday; minute: number; date: string } {
  ensure(Number.isSafeInteger(at) && at >= 0, 'INVALID_TIME');
  const p = Object.fromEntries(formatter(timeZone).formatToParts(at).map(part => [part.type, part.value]));
  return { day: weekdays.indexOf(p.weekday!) as Weekday, minute: Number(p.hour) * 60 + Number(p.minute),
    date: `${p.year}-${p.month}-${p.day}` };
}

export function validateSchedule(schedule: WeeklySchedule): void {
  ensure(schedule && typeof schedule.timeZone === 'string' && schedule.days, 'INVALID_SCHEDULE');
  try { formatter(schedule.timeZone); } catch { ensure(false, 'INVALID_TIME_ZONE'); }
  let catchUpFound = false;
  for (let day = 0; day < 7; day++) {
    const slots = schedule.days[day as Weekday];
    ensure(Array.isArray(slots) && slots.length > 0 && slots.length <= 48, 'INVALID_SCHEDULE');
    let end = 0;
    for (const slot of slots) {
      ensure(Number.isInteger(slot.startMinute) && slot.startMinute === end &&
        Number.isInteger(slot.endMinute) && slot.endMinute > end && slot.endMinute <= 1440 &&
        Number.isFinite(slot.probability) && slot.probability >= 0 && slot.probability <= 1 &&
        typeof slot.catchUp === 'boolean', 'INVALID_SCHEDULE');
      end = slot.endMinute;
      catchUpFound ||= slot.catchUp;
    }
    ensure(end === 1440, 'INVALID_SCHEDULE');
  }
  ensure(catchUpFound, 'NO_CATCH_UP_WINDOW');
}

export function slotAt(schedule: WeeklySchedule, at: number): ScheduleSlot {
  const { day, minute } = localTime(at, schedule.timeZone);
  const result = schedule.days[day].find(slot => minute >= slot.startMinute && minute < slot.endMinute);
  ensure(result, 'INVALID_SCHEDULE');
  return result;
}

export function catchUpAt(schedule: WeeklySchedule, now: number): number {
  if (slotAt(schedule, now).catchUp) return now + RULES.catchUpDelayMs;
  // Walk real UTC minutes so skipped/repeated local hours across DST are handled naturally.
  const start = Math.floor(now / MINUTE) * MINUTE + MINUTE;
  for (let at = start; at <= now + 8 * 24 * 60 * MINUTE; at += MINUTE) {
    if (slotAt(schedule, at).catchUp) return at;
  }
  ensure(false, 'NO_CATCH_UP_WINDOW');
}

export function firstProbabilityDrop(schedule: WeeklySchedule, after: number, through: number): number | null {
  let previous = slotAt(schedule, after).probability;
  for (let at = Math.floor(after / MINUTE) * MINUTE + MINUTE; at <= through; at += MINUTE) {
    const probability = slotAt(schedule, at).probability;
    if (probability < previous) return at;
    previous = probability;
  }
  return null;
}

export interface SessionState {
  epoch: number;
  lastActivityAt: number | null;
  checkedAt: number | null;
  graceUntil: number | null;
  schedule: WeeklySchedule | null;
}
export const emptySession = (): SessionState => ({ epoch: 0, lastActivityAt: null,
  checkedAt: null, graceUntil: null, schedule: null });

export function closeSession(state: SessionState): SessionState {
  return { ...emptySession(), epoch: state.epoch + 1 };
}

export function advanceSession(input: SessionState, now: number): SessionState {
  const state = structuredClone(input);
  if (state.lastActivityAt === null) return state;
  const idleUntil = state.lastActivityAt + RULES.idleMs;
  if (state.graceUntil === null && state.schedule) {
    const drop = firstProbabilityDrop(state.schedule, state.checkedAt ?? state.lastActivityAt,
      Math.min(now, idleUntil - 1));
    if (drop !== null) state.graceUntil = drop + RULES.graceMs;
  }
  if (now >= Math.min(idleUntil, state.graceUntil ?? Infinity)) return closeSession(state);
  state.checkedAt = Math.max(now, state.checkedAt ?? now);
  return state;
}
