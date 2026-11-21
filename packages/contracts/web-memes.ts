/**
 * Part 37c-1: 网络梗. The dictionary's MEANINGS are shared; how a character USES an entry is per character.
 *
 * Per-character use lives in the character draft's `authorCanon.settings` (no schema change; it goes live only with 发布, like the
 * 说话档案): `memeLevel` is the character's default level, `memeOverrides` maps an entry's term to a level for single entries.
 * Per-entry on/off is a switch of the whole dictionary (a runtime-step table, apps/server/memes/web-meme-store.ts).
 */
export const MEME_LEVELS = ['use', 'know', 'avoid'] as const;
export type MemeLevel = (typeof MEME_LEVELS)[number];
export const isMemeLevel = (value: unknown): value is MemeLevel =>
  typeof value === 'string' && (MEME_LEVELS as readonly string[]).includes(value);
/** 会用: understands and may use it · 只懂: understands, never uses it · 不碰: understands enough not to misread it, never uses it, does not play along. */
export const MEME_LEVEL_LABELS: Readonly<Record<MemeLevel, string>> = Object.freeze({
  use: '会用',
  know: '只懂',
  avoid: '不碰',
});
/** A character that was never set up: understands, never uses (the safe one). */
export const MEME_LEVEL_DEFAULT: MemeLevel = 'know';
/** One reply carries at most this many matched entries (the latest message's first, longest first). */
export const MEME_HITS_MAX = 3;
/** Player messages (the latest and the ones before it) a reply looks at for a term. */
export const MEME_TURNS = 3;
/** A term shorter than this (code points) is never matched: a single character is not a meme. */
export const MEME_TERM_MIN = 2;
/** Single-entry overrides one character may hold. */
export const MEME_OVERRIDES_MAX = 200;
export const MEME_PAGE_SIZE = 50;

export interface MemeUse {
  level: MemeLevel;
  overrides: Record<string, MemeLevel>;
}
/** What a frozen request carries for one matched entry. */
export interface MemeHit {
  term: string;
  meaning: string;
  level: MemeLevel;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const settingsOf = (template: unknown): Record<string, unknown> => {
  const canon = isObject(template) ? template.authorCanon : undefined;
  return isObject(canon) && isObject(canon.settings) ? canon.settings : {};
};

/** The character's own use of the dictionary; anything unreadable counts as not set (the default level, no overrides). */
export function readMemeUse(template: unknown): MemeUse {
  const settings = settingsOf(template);
  const overrides: Record<string, MemeLevel> = {};
  if (isObject(settings.memeOverrides))
    for (const [term, level] of Object.entries(settings.memeOverrides)) if (isMemeLevel(level)) overrides[term] = level;
  return { level: isMemeLevel(settings.memeLevel) ? settings.memeLevel : MEME_LEVEL_DEFAULT, overrides };
}
export const memeLevelOf = (use: MemeUse, term: string): MemeLevel => use.overrides[term] ?? use.level;

/** The template without its meme settings: the writers never print them (the matched entries carry the level). */
export function withoutMemeUse<T extends { authorCanon?: unknown }>(template: T): T {
  const settings = settingsOf(template);
  if (!('memeLevel' in settings) && !('memeOverrides' in settings)) return template;
  const { memeLevel: _level, memeOverrides: _overrides, ...rest } = settings;
  return { ...template, authorCanon: { ...(template.authorCanon as object), settings: rest } };
}

export class MemeUseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'MemeUseError';
    this.code = code;
  }
}
/** The template with this use written into its settings. A level equal to the default and no overrides leaves no key. */
export function writeMemeUse<T extends object>(template: T, use: MemeUse): T {
  if (!isMemeLevel(use.level)) throw new MemeUseError('MEME_LEVEL_INVALID');
  const entries = Object.entries(use.overrides);
  if (entries.length > MEME_OVERRIDES_MAX || entries.some(([term, level]) => term === '' || !isMemeLevel(level)))
    throw new MemeUseError('MEME_OVERRIDES_INVALID');
  const copy = structuredClone(template) as Record<string, unknown>;
  if (!isObject(copy.authorCanon)) copy.authorCanon = { kind: 'author_canon', settings: {} };
  const canon = copy.authorCanon as Record<string, unknown>;
  if (!isObject(canon.settings)) canon.settings = {};
  const settings = canon.settings as Record<string, unknown>;
  if (use.level === MEME_LEVEL_DEFAULT) delete settings.memeLevel;
  else settings.memeLevel = use.level;
  if (entries.length) settings.memeOverrides = Object.fromEntries(entries);
  else delete settings.memeOverrides;
  return copy as unknown as T;
}

// ---- the admin page ----------------------------------------------------------------------------------------------------------------
export interface MemeEntryView {
  key: string;
  term: string;
  meaning: string;
  year: number;
  tags: string[];
  enabled: boolean;
}
export interface MemeListInput {
  query: string;
  year: number | null;
  tag: string | null;
  /** 'all' | 'on' | 'off' */
  state: 'all' | 'on' | 'off';
  page: number;
}
export interface MemeListView {
  entries: MemeEntryView[];
  /** Entries matching the filter, across pages. */
  matching: number;
  page: number;
  pages: number;
  /** The whole dictionary: how many entries there are and how many are on. */
  total: number;
  on: number;
  years: number[];
  /** The most used tags first (at most 40) - every tag stays searchable by typing. */
  tags: { tag: string; count: number }[];
}
