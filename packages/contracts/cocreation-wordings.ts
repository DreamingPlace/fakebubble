/**
 * Part 39b: the five themes of a character's co-creation sheet and the WORDING POOL behind them. A theme is the card (what the note is
 * about); a wording is the question the player is shown for it. Each character has a pool of wordings per theme, edited in the console
 * (共创收件箱 → 「题目」); the sheet shows ONE enabled wording per theme, picked at random each time it opens and on ↻. An empty pool falls
 * back to the plain default of the theme. `{name}` in a wording is replaced with the character's display name.
 */
import type { CocreationTargetField } from './cocreation-cards.ts';

export const COCREATION_THEME_IDS = [
  'theme-know',
  'theme-experience',
  'theme-habit',
  'theme-catchphrase',
  'theme-recent',
] as const;
export type CocreationThemeId = (typeof COCREATION_THEME_IDS)[number];
export type CocreationTheme = {
  id: CocreationThemeId;
  /** The theme's name in the console (and what an inbox row shows for a note of this theme). */
  label: string;
  /** Used when a character's pool of this theme has no enabled wording. */
  fallback: string;
  targetField: CocreationTargetField;
};
/** In the order the sheet shows them. */
export const COCREATION_THEMES: readonly CocreationTheme[] = Object.freeze([
  { id: 'theme-know', label: '认识这个人', fallback: '你眼中的{name}是什么样的人？', targetField: 'persona' },
  { id: 'theme-experience', label: '他的经历', fallback: '{name}经历过哪些事？', targetField: 'personalityLayers' },
  { id: 'theme-habit', label: '他的习惯', fallback: '{name}有哪些小习惯？', targetField: 'interests' },
  { id: 'theme-catchphrase', label: '他的口头禅', fallback: '{name}常挂在嘴边的话', targetField: 'speechStyle' },
  { id: 'theme-recent', label: '他的近况', fallback: '{name}最近在忙什么？', targetField: 'free' },
] satisfies CocreationTheme[]);
export const cocreationTheme = (id: unknown) => COCREATION_THEMES.find((theme) => theme.id === id);
export const isThemeId = (id: unknown): id is CocreationThemeId => cocreationTheme(id) !== undefined;

export const COCREATION_WORDING_LIMITS = Object.freeze({
  /** Code points of one wording (the template, `{name}` counted as written). */
  text: 80,
  /** Wordings of one theme of one character, enabled or not. */
  perTheme: 60,
  /** One generation drafts this many wordings per theme (the model's answer is refused outside the range). */
  generatedMin: 6,
  generatedMax: 10,
});

/** A wording: non-blank, one line, no control characters, within the limit. */
export const cocreationWordingOk = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  value.trim() === value &&
  [...value].length <= COCREATION_WORDING_LIMITS.text &&
  !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);

export const renderWording = (template: string, name: string) => template.replaceAll('{name}', name);

/**
 * The wording one theme shows: one entry of `enabled` (the character's enabled wordings of the theme, in any order) picked with
 * `random() ∈ [0,1)`, else the theme's plain default. Never anything but an enabled entry.
 */
export function pickWording(theme: CocreationTheme, enabled: readonly string[], name: string, random: () => number) {
  const pool = enabled.filter(cocreationWordingOk);
  const at = pool.length === 0 ? -1 : Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return renderWording(at < 0 ? theme.fallback : pool[at]!, name);
}

/**
 * Part 44: the question a theme shows when the character's wording pool IS known: exactly one entry of `online` (this character's
 * online wordings of the theme, in any order), picked with `random() ∈ [0,1)`; null when none is online, and then the theme has no card.
 * Never an offline wording, never the plain default (that is only for a pool that could not be read: see pickWording).
 */
export function pickOnlineWording(online: readonly string[], name: string, random: () => number) {
  const pool = online.filter(cocreationWordingOk);
  if (pool.length === 0) return null;
  const at = Math.min(pool.length - 1, Math.max(0, Math.floor(random() * pool.length)));
  return renderWording(pool[at]!, name);
}

/** What a player's note records of the question it answered: the exact text shown (the name already filled in). */
export const COCREATION_SHOWN_MAX = 200;
