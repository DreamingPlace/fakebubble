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

// ---- the library (Part 37c-1b) -----------------------------------------------------------------------------------------------------
/**
 * The library = the shipped entries (re-curated, each with a category and a default on/off) + the owner's own entries. Nothing new
 * enters it without the owner's confirmation: uploads and automatic sources only ever fill the 待审 queue.
 *
 * The five KEPT categories ship ON (an everyday word still ships OFF); the others are the reason an entry ships OFF.
 */
export const MEME_KEPT_CATEGORIES = ['心情', '关系', '日常', '追星娱乐', '句式'] as const;
export const MEME_DROP_CATEGORIES = ['AI科技', '硬件汽车', '金融', '时政', '真人', '不雅', '非日常'] as const;
export const MEME_CATEGORIES: readonly string[] = [...MEME_KEPT_CATEGORIES, ...MEME_DROP_CATEGORIES];
export const isKeptCategory = (category: string) => (MEME_KEPT_CATEGORIES as readonly string[]).includes(category);
export const isMemeCategory = (category: unknown): category is string =>
  typeof category === 'string' && MEME_CATEGORIES.includes(category);

/** 自带 = shipped; 手动 = typed in by the owner; 上传 = a file or pasted rows (through 待审); 梗雷达 / 玩家聊天 = Part 37c-2. */
export const MEME_SOURCES = ['builtin', 'manual', 'upload', 'radar', 'chat'] as const;
export type MemeSource = (typeof MEME_SOURCES)[number];
export const MEME_SOURCE_LABELS: Readonly<Record<MemeSource, string>> = Object.freeze({
  builtin: '自带',
  manual: '手动',
  upload: '上传',
  radar: '梗雷达',
  chat: '玩家聊天',
});
export const isMemeSource = (value: unknown): value is MemeSource =>
  typeof value === 'string' && (MEME_SOURCES as readonly string[]).includes(value);

export const MEME_TERM_MAX = 40;
export const MEME_MEANING_MAX = 200;
/** The whole library (shipped entries that are not deleted + the owner's own). */
export const MEME_LIBRARY_CAP = 5_000;
export const MEME_IMPORT_ROWS_MAX = 2_000;
/** Terms or keys one call may name. */
export const MEME_BATCH_MAX = 2_000;

// ---- the admin page ----------------------------------------------------------------------------------------------------------------
export interface MemeEntryView {
  /** The term (a term is unique across the library, so it is the key). */
  key: string;
  term: string;
  /** The text in use: the owner's edit when there is one, else the shipped text. */
  meaning: string;
  year: number | null;
  tags: string[];
  enabled: boolean;
  /** Ships switched off (not kept in the re-curation, or an everyday word). The owner's switch overrides it both ways. */
  defaultOff: boolean;
  category: string;
  source: MemeSource;
  /** In the 已删除 list (a shipped entry the owner deleted; it no longer matches or counts). */
  deleted: boolean;
  /** The owner edited the meaning or the category of a shipped entry. */
  edited: boolean;
  /** The shipped text, for 恢复原文 and for the hover (only when `edited`). */
  original: { meaning: string; category: string } | null;
}
export type MemeState = 'all' | 'on' | 'off' | 'default-off' | 'deleted';
export const MEME_STATES: readonly MemeState[] = ['all', 'on', 'off', 'default-off', 'deleted'];
export interface MemeListInput {
  query: string;
  year: number | null;
  tag: string | null;
  /** 'default-off' lists the entries that ship switched off, whatever their state now; 'deleted' the 已删除 list. */
  state: MemeState;
  page: number;
  /** Part 37c-1b filters; absent = no filter. */
  category?: string | null;
  source?: MemeSource | null;
}
export interface MemeListView {
  entries: MemeEntryView[];
  /** Entries matching the filter, across pages. */
  matching: number;
  page: number;
  pages: number;
  /** The library without the deleted entries: how many entries there are and how many are on. */
  total: number;
  on: number;
  /** How many entries of it ship switched off. */
  defaultOff: number;
  /** Entries in the 已删除 list. */
  deleted: number;
  /** Items waiting in the 待审 queue. */
  pending: number;
  years: number[];
  /** The most used tags first (at most 40) - every tag stays searchable by typing. */
  tags: { tag: string; count: number }[];
  categories: { category: string; count: number }[];
}

/** One 待审 item: what an upload or an automatic source suggests. `existing` is what the library holds now under the same term. */
export interface MemeQueueItem {
  term: string;
  meaning: string;
  category: string;
  source: MemeSource;
  year: number | null;
  /** Dates only (UTC, ms). */
  createdAt: number;
  /** Part 37c-2 supplies these: links the suggestion came from and how many players said it. Never a player or a message. */
  links: string[];
  playerCount: number | null;
  existing: { meaning: string; category: string; enabled: boolean; source: MemeSource } | null;
  /** The owner deleted this term once: approving brings the entry back. */
  wasDeleted: boolean;
}
export interface MemeQueueView {
  items: MemeQueueItem[];
  pending: number;
}

/** Why an uploaded row is not accepted (shown with the row, never dropped silently). */
export const MEME_ROW_PROBLEMS = [
  'EMPTY_TERM',
  'EMPTY_MEANING',
  'TERM_TOO_LONG',
  'TERM_TOO_SHORT',
  'MEANING_TOO_LONG',
  'BAD_CATEGORY',
  'DUPLICATE_IN_FILE',
] as const;
export type MemeRowProblem = (typeof MEME_ROW_PROBLEMS)[number];
export type MemeImportRow = {
  /** The row's number in the file (the header is row 1). */
  row: number;
  term: string;
  meaning: string;
  category: string;
  /** ok = new term; update = the term exists, the text differs; revive = the owner deleted this term; unchanged = same as now;
   * queued = already waiting; invalid = see `problem`. */
  status: 'ok' | 'update' | 'revive' | 'unchanged' | 'queued' | 'invalid';
  problem: MemeRowProblem | null;
  existing: { meaning: string; category: string } | null;
};
export interface MemeImportPreview {
  rows: MemeImportRow[];
  counts: { ok: number; update: number; revive: number; unchanged: number; queued: number; invalid: number };
}
