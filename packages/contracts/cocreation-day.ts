/**
 * Part 47: the fixed card 「{name}的一天都会干什么？」. Six optional parts; at least one must be written to hand it in.
 * Storage needs no schema change: each answered part is ONE ordinary text answer of the submission (card id `day-<part>`, the
 * existing kind 'text', target_field 'free'), so which parts were answered is simply which rows exist. The administrators adopt a
 * part into `authorCanon.settings.dailyLife` (see speech-profile.ts); there is no time-of-day line in any prompt.
 */
export const DAY_PARTS = ['morning', 'noon', 'afternoon', 'evening', 'lateNight', 'whole'] as const;
export type DayPart = (typeof DAY_PARTS)[number];
export const DAY_PART_LABELS: Readonly<Record<DayPart, string>> = Object.freeze({
  morning: '早上',
  noon: '中午',
  afternoon: '下午',
  evening: '晚上',
  lateNight: '深夜',
  whole: '一整天的故事',
});
/** Code points one part may hold (what a player may write and what 「一天的安排」 may hold after an adoption). */
export const DAY_PART_MAX: Readonly<Record<DayPart, number>> = Object.freeze({
  morning: 300,
  noon: 300,
  afternoon: 300,
  evening: 300,
  lateNight: 300,
  whole: 800,
});
export const DAY_CARD_PREFIX = 'day-';
export const DAY_PROMPT = '{name}的一天都会干什么？';
export const dayCardId = (part: DayPart) => `${DAY_CARD_PREFIX}${part}`;
/** The part a card id stands for, or null when it is not a 一天 card. */
export const dayPartOf = (cardId: string): DayPart | null => {
  if (!cardId.startsWith(DAY_CARD_PREFIX)) return null;
  const part = cardId.slice(DAY_CARD_PREFIX.length);
  return (DAY_PARTS as readonly string[]).includes(part) ? (part as DayPart) : null;
};

/** The `authorCanon.settings` key of 「一天的安排」, and its label in the 说话档案. */
export const DAILY_LIFE_KEY = 'dailyLife';
export const DAILY_LIFE_LABEL = '一天的安排';
const len = (text: string) => [...text].length;
/**
 * The stored shape: a record whose keys are some of the six parts and whose values are non-blank texts within the part's cap.
 * (An empty part is simply absent.) Used by the template validation of the server and by the 说话档案 editor.
 */
export function dailyLifeValid(value: unknown): value is Partial<Record<DayPart, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, text]) =>
      (DAY_PARTS as readonly string[]).includes(key) &&
      typeof text === 'string' &&
      text.trim() !== '' &&
      len(text) <= DAY_PART_MAX[key as DayPart],
  );
}
