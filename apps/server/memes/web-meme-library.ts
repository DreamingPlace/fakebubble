import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { DetailedError, ensure } from '../../../packages/domain/errors.ts';
import {
  MEME_BATCH_MAX,
  MEME_KEPT_CATEGORIES,
  MEME_LIBRARY_CAP,
  MEME_MEANING_MAX,
  MEME_PAGE_SIZE,
  MEME_TERM_MAX,
  MEME_TERM_MIN,
  isKeptCategory,
  isMemeCategory,
  type MemeEntryView,
  type MemeListInput,
  type MemeListView,
  type MemeQueueItem,
  type MemeQueueView,
  type MemeRowProblem,
  type MemeSource,
} from '../../../packages/contracts/web-memes.ts';
import { MEME_ENTRIES, memeEntry } from './meme-dictionary.ts';
import { buildMatchLibrary, type MemeMatchLibrary } from './meme-match.ts';

/**
 * Part 37c-1b: the library of 网络梗 = the shipped entries (re-curated) + the owner's own entries, with the owner's edits, switches and
 * deletions applied. NO numbered migration (expected-migrations is untouched): the six tables below are a SECOND digest-checked runtime
 * step beside the on/off table of Part 37c-1 (web-meme-store.ts). Any other state (a foreign `web_memelib_*` table, a changed digest)
 * stops the start with WEB_MEMELIB_SCHEMA_MISMATCH.
 *
 *   web_memelib_entry      the owner's own entries (typed in, or approved from the queue): term, meaning, category, year, on/off, source
 *   web_memelib_override   the owner's edit of a SHIPPED entry's meaning / category (a null column = the shipped text)
 *   web_memelib_deleted    a term the owner deleted: a shipped one (restorable) or an own one (the entry is gone for good, the term is
 *                          remembered so that an automatic source never suggests it again and an upload flags it 曾删除)
 *   web_memelib_queue      the 待审 queue: suggestions from an upload (now) and from 梗雷达 / 玩家聊天 (Part 37c-2)
 *   web_memelib_dismissed  terms the owner refused with 不要: an automatic source never suggests them again
 *
 * Nothing here holds a player, an id of a person, an email or a message: a term, its meaning and counts. The shipped dictionary is
 * never copied into a table; a shipped entry's on/off stays in web_meme_switch. The business object is the only writer.
 */
const statements = [
  `CREATE TABLE web_memelib_entry(term TEXT PRIMARY KEY CHECK(length(term) BETWEEN 1 AND 40),meaning TEXT NOT NULL CHECK(length(meaning) BETWEEN 1 AND 200),
    category TEXT NOT NULL,year INTEGER,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
    source TEXT NOT NULL CHECK(source IN ('manual','upload','radar','chat')),created_at INTEGER NOT NULL,changed_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_memelib_override(term TEXT PRIMARY KEY,meaning TEXT CHECK(meaning IS NULL OR length(meaning) BETWEEN 1 AND 200),category TEXT,
    changed_at INTEGER NOT NULL,CHECK(meaning IS NOT NULL OR category IS NOT NULL)) STRICT`,
  `CREATE TABLE web_memelib_deleted(term TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('shipped','own')),deleted_at INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_memelib_queue(term TEXT PRIMARY KEY CHECK(length(term) BETWEEN 1 AND 40),meaning TEXT NOT NULL CHECK(length(meaning) BETWEEN 1 AND 200),
    category TEXT NOT NULL,year INTEGER,source TEXT NOT NULL CHECK(source IN ('upload','radar','chat')),
    links_json TEXT NOT NULL CHECK(json_valid(links_json)),player_count INTEGER,created_at INTEGER NOT NULL) STRICT`,
  'CREATE TABLE web_memelib_dismissed(term TEXT PRIMARY KEY,dismissed_at INTEGER NOT NULL) STRICT',
  'CREATE TABLE web_memelib_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
const TABLES = [
  'web_memelib_deleted',
  'web_memelib_dismissed',
  'web_memelib_entry',
  'web_memelib_override',
  'web_memelib_queue',
  'web_memelib_schema',
];

export function installMemeLibrary(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_memelib_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_memelib_*'"), 'WEB_MEMELIB_SCHEMA_MISMATCH');
      for (const statement of statements) store.run(statement);
      store.run('INSERT INTO web_memelib_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_memelib_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_MEMELIB_SCHEMA_MISMATCH');
    const tables = store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name GLOB 'web_memelib_*' ORDER BY name",
    );
    ensure(tables.map((row) => row.name).join(',') === TABLES.join(','), 'WEB_MEMELIB_SCHEMA_MISMATCH');
  });
}

type Reader = Pick<BusinessStore, 'get' | 'all'>;
type Writer = Pick<BusinessStore, 'get' | 'all' | 'run'>;
const has = (store: Reader, table: string) => !!store.get('SELECT 1 FROM sqlite_master WHERE name=?', table);

// ---- the layers ----------------------------------------------------------------------------------------------------------------
interface OwnRow {
  term: string;
  meaning: string;
  category: string;
  year: number | null;
  enabled: boolean;
  source: Exclude<MemeSource, 'builtin'>;
  createdAt: number;
}
interface Layers {
  switches: Map<string, boolean>;
  overrides: Map<string, { meaning: string | null; category: string | null }>;
  deleted: Map<string, 'shipped' | 'own'>;
  own: OwnRow[];
}
/** A database without the tables (an older one) has no layers: the library is the shipped dictionary with its defaults. */
function layers(store: Reader): Layers {
  const lib = has(store, 'web_memelib_schema');
  return {
    switches: has(store, 'web_meme_switch')
      ? new Map(
          store
            .all<{ entry_key: string; enabled: number }>('SELECT entry_key,enabled FROM web_meme_switch')
            .map((row) => [row.entry_key, row.enabled === 1]),
        )
      : new Map(),
    overrides: lib
      ? new Map(
          store
            .all<{ term: string; meaning: string | null; category: string | null }>(
              'SELECT term,meaning,category FROM web_memelib_override',
            )
            .map((row) => [row.term, { meaning: row.meaning, category: row.category }]),
        )
      : new Map(),
    deleted: lib
      ? new Map(
          store
            .all<{ term: string; kind: 'shipped' | 'own' }>('SELECT term,kind FROM web_memelib_deleted')
            .map((row) => [row.term, row.kind]),
        )
      : new Map(),
    own: lib
      ? store
          .all<{
            term: string;
            meaning: string;
            category: string;
            year: number | null;
            enabled: number;
            source: OwnRow['source'];
            created_at: number;
          }>(
            'SELECT term,meaning,category,year,enabled,source,created_at FROM web_memelib_entry ORDER BY created_at,term',
          )
          .map((row) => ({
            term: row.term,
            meaning: row.meaning,
            category: row.category,
            year: row.year,
            enabled: row.enabled === 1,
            source: row.source,
            createdAt: row.created_at,
          }))
      : [],
  };
}

const viewOfShipped = (entry: (typeof MEME_ENTRIES)[number], l: Layers): MemeEntryView => {
  const override = l.overrides.get(entry.key);
  const deleted = l.deleted.get(entry.key) === 'shipped';
  return {
    key: entry.key,
    term: entry.term,
    meaning: override?.meaning ?? entry.meaning,
    year: entry.year,
    tags: [...entry.tags],
    enabled: !deleted && (l.switches.get(entry.key) ?? !entry.defaultOff),
    defaultOff: entry.defaultOff,
    category: override?.category ?? entry.category,
    source: 'builtin',
    deleted,
    edited: !!override,
    original: override ? { meaning: entry.meaning, category: entry.category } : null,
  };
};
const viewOfOwn = (row: OwnRow): MemeEntryView => ({
  key: row.term,
  term: row.term,
  meaning: row.meaning,
  year: row.year,
  tags: [],
  enabled: row.enabled,
  defaultOff: false,
  category: row.category,
  source: row.source,
  deleted: false,
  edited: false,
  original: null,
});
/** Every entry of the library, the deleted shipped ones included (flagged), in dictionary order then the owner's by date. */
function everything(l: Layers): MemeEntryView[] {
  return [...MEME_ENTRIES.map((entry) => viewOfShipped(entry, l)), ...l.own.map(viewOfOwn)];
}

// ---- reading for matching --------------------------------------------------------------------------------------------------------
/** The keys that are OFF now: shipped entries that are deleted or off (the default unless switched), own entries that are off. */
export function readMemesOff(store: Reader): Set<string> {
  const l = layers(store);
  const off = new Set<string>();
  for (const entry of MEME_ENTRIES)
    if (l.deleted.get(entry.key) === 'shipped' || !(l.switches.get(entry.key) ?? !entry.defaultOff)) off.add(entry.key);
  for (const row of l.own) if (!row.enabled) off.add(row.term);
  return off;
}
/** What a reply (or a run that freezes it) needs of the owner's layer: the keys that are off, the own entries, the edited meanings. */
export interface MemeLibraryState {
  off: string[];
  own: { term: string; meaning: string }[];
  meanings: Record<string, string>;
}
export function readMemeLibraryState(store: Reader): MemeLibraryState {
  const l = layers(store);
  return {
    off: [...readMemesOff(store)].sort(),
    own: l.own.map((row) => ({ term: row.term, meaning: row.meaning })),
    meanings: Object.fromEntries(
      [...l.overrides].filter(([, o]) => o.meaning !== null).map(([term, o]) => [term, o.meaning!] as const),
    ),
  };
}
export const matchLibraryOf = (state: Pick<MemeLibraryState, 'own' | 'meanings'>): MemeMatchLibrary =>
  buildMatchLibrary(state.own, new Map(Object.entries(state.meanings)));
/** The effective library as live matching reads it: the off set and the entries (shipped + own, meanings edited). */
export function readMemeLibrary(store: Reader): { off: Set<string>; library: MemeMatchLibrary } {
  const state = readMemeLibraryState(store);
  return { off: new Set(state.off), library: matchLibraryOf(state) };
}

// ---- validation ---------------------------------------------------------------------------------------------------------------------
const fold = (text: string) => text.normalize('NFKC').toLowerCase();
const points = (text: string) => [...text].length;
/** Control characters never belong in a term or a meaning (a tab or newline would break the CSV and the prompt line). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u001F\u007F]/u;
export interface MemeFields {
  term: string;
  meaning: string;
  category: string;
}
/**
 * The problem of a (trimmed) term / meaning / category, or null. `existing`: the term is already in the library (an edit, an unchanged
 * row, an update): it may keep a category outside the five, and its length is not judged again (the shipped data holds one 1-character
 * term, 润, which never matches but is an entry like any other).
 */
export function memeProblem(fields: MemeFields, existing = false): MemeRowProblem | null {
  if (fields.term === '' || CONTROL.test(fields.term)) return 'EMPTY_TERM';
  if (points(fields.term) > MEME_TERM_MAX) return 'TERM_TOO_LONG';
  if (!existing && points(fields.term) < MEME_TERM_MIN) return 'TERM_TOO_SHORT';
  if (fields.meaning === '' || CONTROL.test(fields.meaning)) return 'EMPTY_MEANING';
  if (points(fields.meaning) > MEME_MEANING_MAX) return 'MEANING_TOO_LONG';
  if (!(existing ? isMemeCategory(fields.category) : isKeptCategory(fields.category))) return 'BAD_CATEGORY';
  return null;
}
const PROBLEM_CODE: Record<MemeRowProblem, string> = {
  EMPTY_TERM: 'MEME_TERM_EMPTY',
  EMPTY_MEANING: 'MEME_MEANING_EMPTY',
  TERM_TOO_LONG: 'MEME_TERM_TOO_LONG',
  TERM_TOO_SHORT: 'MEME_TERM_TOO_SHORT',
  MEANING_TOO_LONG: 'MEME_MEANING_TOO_LONG',
  BAD_CATEGORY: 'MEME_CATEGORY_INVALID',
  DUPLICATE_IN_FILE: 'MEME_DUPLICATE',
};
const refuse = (problem: MemeRowProblem): never => {
  throw new DetailedError(PROBLEM_CODE[problem], {});
};
export const memeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
const yearOf = (value: unknown): number | null => {
  ensure(
    value === null ||
      value === undefined ||
      (Number.isSafeInteger(value) && (value as number) >= 1990 && (value as number) <= 2100),
    'INVALID_REQUEST',
  );
  return (value as number | null | undefined) ?? null;
};

/** Where a term stands in the library right now (the deleted entries included). */
export type TermState =
  | { kind: 'free' }
  | { kind: 'live'; entry: MemeEntryView }
  | { kind: 'deleted-shipped'; entry: MemeEntryView }
  | { kind: 'deleted-own' };
function termIndex(l: Layers) {
  const index = new Map<string, MemeEntryView | 'deleted-own'>();
  for (const view of everything(l)) index.set(fold(view.term), view);
  for (const [term, kind] of l.deleted)
    if (kind === 'own' && !index.has(fold(term))) index.set(fold(term), 'deleted-own');
  return index;
}
const stateIn = (index: ReturnType<typeof termIndex>, term: string): TermState => {
  const found = index.get(fold(term));
  if (found === undefined) return { kind: 'free' };
  if (found === 'deleted-own') return { kind: 'deleted-own' };
  return found.deleted ? { kind: 'deleted-shipped', entry: found } : { kind: 'live', entry: found };
};
export function termState(store: Reader, term: string): TermState {
  return stateIn(termIndex(layers(store)), term);
}
/** A reader of many terms against ONE read of the library (an upload preview checks up to 2,000). */
export function termStates(store: Reader): (term: string) => TermState {
  const index = termIndex(layers(store));
  return (term) => stateIn(index, term);
}
/** The library's size against its cap: shipped entries that are not deleted + the owner's own. */
export function libraryCount(store: Reader): number {
  const l = layers(store);
  return MEME_ENTRIES.filter((entry) => l.deleted.get(entry.key) !== 'shipped').length + l.own.length;
}
const queueCount = (store: Reader) =>
  has(store, 'web_memelib_queue') ? store.get<{ n: number }>('SELECT COUNT(*) n FROM web_memelib_queue')!.n : 0;
export const queuedTerms = (store: Reader): Set<string> =>
  has(store, 'web_memelib_queue')
    ? new Set(store.all<{ term: string }>('SELECT term FROM web_memelib_queue').map((row) => fold(row.term)))
    : new Set();

// ---- the list (admin page and export) ---------------------------------------------------------------------------------------------------
export function listMemes(store: Reader, input: MemeListInput): MemeListView {
  const l = layers(store);
  const all = everything(l);
  const query = fold(input.query.trim());
  const live = all.filter((entry) => !entry.deleted);
  const matching = all.filter(
    (entry) =>
      (input.state === 'deleted' ? entry.deleted : !entry.deleted) &&
      (input.year === null || entry.year === input.year) &&
      (input.tag === null || entry.tags.includes(input.tag)) &&
      (input.category == null || entry.category === input.category) &&
      (input.source == null || entry.source === input.source) &&
      (input.state === 'all' ||
        input.state === 'deleted' ||
        (input.state === 'default-off' ? entry.defaultOff : (input.state === 'on') === entry.enabled)) &&
      (query === '' ||
        fold(entry.term).includes(query) ||
        fold(entry.meaning).includes(query) ||
        fold(entry.category).includes(query) ||
        entry.tags.some((tag) => fold(tag).includes(query))),
  );
  // With a search text the entry whose term IS the text comes first, then the terms that contain it, then the rest (list order).
  const rank = (entry: MemeEntryView) =>
    query === '' ? 0 : fold(entry.term) === query ? 0 : fold(entry.term).includes(query) ? 1 : 2;
  if (query !== '') matching.sort((a, b) => rank(a) - rank(b));
  const pages = Math.max(1, Math.ceil(matching.length / MEME_PAGE_SIZE));
  const page = Math.min(Math.max(1, input.page), pages);
  const tagCounts = new Map<string, number>();
  for (const entry of live) for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const categoryCounts = new Map<string, number>();
  for (const entry of live) categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
  const categories = [...new Set([...MEME_KEPT_CATEGORIES, ...categoryCounts.keys()])];
  return {
    entries: matching.slice((page - 1) * MEME_PAGE_SIZE, page * MEME_PAGE_SIZE),
    matching: matching.length,
    page,
    pages,
    total: live.length,
    on: live.filter((entry) => entry.enabled).length,
    defaultOff: live.filter((entry) => entry.defaultOff).length,
    deleted: all.length - live.length,
    pending: queueCount(store),
    years: [...new Set(live.map((entry) => entry.year).filter((year): year is number => year !== null))].sort(
      (a, b) => b - a,
    ),
    tags: [...tagCounts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([tag, count]) => ({ tag, count })),
    categories: categories.map((category) => ({ category, count: categoryCounts.get(category) ?? 0 })),
  };
}

// ---- the owner's writes --------------------------------------------------------------------------------------------------------------
const keysOf = (keys: readonly string[]) => {
  ensure(keys.length > 0 && keys.length <= MEME_BATCH_MAX, 'INVALID_REQUEST');
  return [...new Set(keys)];
};

/** Switch entries (shipped or own) on or off. Returns how many entries changed state. A deleted entry is not found. */
export function setMemesEnabled(store: Writer, now: number, keys: readonly string[], enabled: boolean) {
  const l = layers(store);
  const ownBy = new Map(l.own.map((row) => [row.term, row] as const));
  const unique = keysOf(keys);
  ensure(
    unique.every((key) => (memeEntry(key) && l.deleted.get(key) !== 'shipped') || ownBy.has(key)),
    'MEME_NOT_FOUND',
  );
  let changed = 0;
  for (const key of unique) {
    const own = ownBy.get(key);
    if (own) {
      if (own.enabled === enabled) continue;
      changed++;
      store.run('UPDATE web_memelib_entry SET enabled=?,changed_at=? WHERE term=?', enabled ? 1 : 0, now, key);
      continue;
    }
    const entry = memeEntry(key)!;
    if ((l.switches.get(key) ?? !entry.defaultOff) === enabled) continue;
    changed++;
    if (enabled === !entry.defaultOff) store.run('DELETE FROM web_meme_switch WHERE entry_key=?', key);
    else
      store.run(
        'INSERT INTO web_meme_switch(entry_key,enabled,changed_at) VALUES (?,?,?) ON CONFLICT(entry_key) DO UPDATE SET enabled=excluded.enabled,changed_at=excluded.changed_at',
        key,
        enabled ? 1 : 0,
        now,
      );
  }
  return changed;
}

const insertOwn = (
  store: Writer,
  now: number,
  fields: MemeFields & { year: number | null; source: Exclude<MemeSource, 'builtin'>; enabled: boolean },
) =>
  store.run(
    `INSERT INTO web_memelib_entry(term,meaning,category,year,enabled,source,created_at,changed_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(term) DO UPDATE SET meaning=excluded.meaning,category=excluded.category,year=excluded.year,enabled=excluded.enabled,changed_at=excluded.changed_at`,
    fields.term,
    fields.meaning,
    fields.category,
    fields.year,
    fields.enabled ? 1 : 0,
    fields.source,
    now,
    now,
  );

/** Add the owner's own entry (default ON). A duplicate term is refused (MEME_DUPLICATE, with where it is) and so is a full library. */
export function addMeme(
  store: Writer,
  now: number,
  input: { term: unknown; meaning: unknown; category: unknown; year?: unknown },
) {
  const fields: MemeFields = {
    term: memeText(input.term),
    meaning: memeText(input.meaning),
    category: memeText(input.category),
  };
  const problem = memeProblem(fields);
  if (problem) refuse(problem);
  const year = yearOf(input.year);
  const state = termState(store, fields.term);
  if (state.kind === 'live' || state.kind === 'deleted-shipped')
    throw new DetailedError('MEME_DUPLICATE', { deleted: state.kind === 'deleted-shipped', key: state.entry.key });
  ensure(libraryCount(store) < MEME_LIBRARY_CAP, 'MEME_LIBRARY_FULL');
  insertOwn(store, now, { ...fields, year, source: 'manual', enabled: true });
  // The owner typed it himself: an earlier deletion of the term (an own one) is over, and a refusal of it too.
  store.run('DELETE FROM web_memelib_deleted WHERE term=?', fields.term);
  store.run('DELETE FROM web_memelib_dismissed WHERE term=?', fields.term);
  return { key: fields.term };
}

function writeOverride(
  store: Writer,
  now: number,
  entry: (typeof MEME_ENTRIES)[number],
  meaning: string,
  category: string,
) {
  const m = meaning === entry.meaning ? null : meaning;
  const c = category === entry.category ? null : category;
  if (m === null && c === null) store.run('DELETE FROM web_memelib_override WHERE term=?', entry.key);
  else
    store.run(
      'INSERT INTO web_memelib_override(term,meaning,category,changed_at) VALUES (?,?,?,?) ON CONFLICT(term) DO UPDATE SET meaning=excluded.meaning,category=excluded.category,changed_at=excluded.changed_at',
      entry.key,
      m,
      c,
      now,
    );
}
/** Edit the meaning and the category of ANY entry. A shipped entry gets an override (the shipped text stays); equal to it = none. */
export function editMeme(store: Writer, now: number, input: { key: unknown; meaning: unknown; category: unknown }) {
  const key = memeText(input.key);
  const fields: MemeFields = { term: key, meaning: memeText(input.meaning), category: memeText(input.category) };
  const problem = memeProblem(fields, true);
  if (problem) refuse(problem);
  const l = layers(store);
  if (l.own.some((row) => row.term === key)) {
    store.run(
      'UPDATE web_memelib_entry SET meaning=?,category=?,changed_at=? WHERE term=?',
      fields.meaning,
      fields.category,
      now,
      key,
    );
    return { key };
  }
  const entry = memeEntry(key);
  ensure(entry && l.deleted.get(key) !== 'shipped', 'MEME_NOT_FOUND');
  writeOverride(store, now, entry, fields.meaning, fields.category);
  return { key };
}
/** 恢复原文: the shipped meaning and category again. Returns how many entries had an edit. */
export function restoreOriginal(store: Writer, keys: readonly string[]) {
  const l = layers(store);
  const unique = keysOf(keys);
  ensure(
    unique.every((key) => memeEntry(key) && l.deleted.get(key) !== 'shipped'),
    'MEME_NOT_FOUND',
  );
  let changed = 0;
  for (const key of unique)
    if (l.overrides.has(key)) {
      changed++;
      store.run('DELETE FROM web_memelib_override WHERE term=?', key);
    }
  return changed;
}

/**
 * Delete entries. The owner's own entries are gone for good (only the term is remembered, for the rules of the queue); a shipped
 * entry moves to the 已删除 list and can be restored there. Either way it no longer matches and no longer counts.
 */
export function deleteMemes(store: Writer, now: number, keys: readonly string[]) {
  const l = layers(store);
  const unique = keysOf(keys);
  const ownBy = new Set(l.own.map((row) => row.term));
  ensure(
    unique.every((key) => ownBy.has(key) || (memeEntry(key) && l.deleted.get(key) !== 'shipped')),
    'MEME_NOT_FOUND',
  );
  let own = 0;
  for (const key of unique) {
    if (ownBy.has(key)) {
      own++;
      store.run('DELETE FROM web_memelib_entry WHERE term=?', key);
      store.run('INSERT OR REPLACE INTO web_memelib_deleted(term,kind,deleted_at) VALUES (?,?,?)', key, 'own', now);
    } else
      store.run('INSERT OR REPLACE INTO web_memelib_deleted(term,kind,deleted_at) VALUES (?,?,?)', key, 'shipped', now);
  }
  return { changed: unique.length, own };
}
/** Restore shipped entries from 已删除 (an own entry is gone for good: not found). */
export function restoreMemes(store: Writer, keys: readonly string[]) {
  const l = layers(store);
  const unique = keysOf(keys);
  ensure(
    unique.every((key) => memeEntry(key) && l.deleted.get(key) === 'shipped'),
    'MEME_NOT_FOUND',
  );
  for (const key of unique) store.run('DELETE FROM web_memelib_deleted WHERE term=?', key);
  return { changed: unique.length };
}

// ---- the 待审 queue ----------------------------------------------------------------------------------------------------------------------
export interface Suggestion {
  term: string;
  meaning: string;
  category: string;
  source: Exclude<MemeSource, 'builtin' | 'manual'>;
  year?: number | null;
  /** Part 37c-2: where it was seen (links) and how many players said it. Never a player and never a message. */
  links?: readonly string[];
  playerCount?: number | null;
}
const LINKS_MAX = 5;
const LINK_MAX = 300;
function insertQueue(store: Writer, now: number, item: Suggestion) {
  store.run(
    `INSERT INTO web_memelib_queue(term,meaning,category,year,source,links_json,player_count,created_at) VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(term) DO UPDATE SET meaning=excluded.meaning,category=excluded.category,year=excluded.year,source=excluded.source,
       links_json=excluded.links_json,player_count=excluded.player_count`,
    item.term,
    item.meaning,
    item.category,
    item.year ?? null,
    item.source,
    JSON.stringify((item.links ?? []).slice(0, LINKS_MAX).map((link) => link.slice(0, LINK_MAX))),
    item.playerCount ?? null,
    now,
  );
}
/** Rows of an upload that passed validation go to the queue (source 上传). A term already waiting keeps its item. Returns how many were added. */
export function enqueueUpload(
  store: Writer,
  now: number,
  rows: readonly { term: string; meaning: string; category: string }[],
) {
  let queued = 0;
  for (const row of rows) {
    if (store.get('SELECT 1 FROM web_memelib_queue WHERE term=?', row.term)) continue;
    insertQueue(store, now, { ...row, source: 'upload' });
    queued++;
  }
  return queued;
}
export type SuggestOutcome = 'queued' | 'dismissed' | 'deleted' | 'exists' | 'already-queued' | 'invalid';
/**
 * The ONE door an automatic source (梗雷达, 玩家聊天 - Part 37c-2) uses. It can only fill the queue, never the library, and it never
 * suggests a term the owner dismissed (不要) or deleted, nor one the library already holds or the queue already waits on.
 */
export function suggestMeme(store: Writer, now: number, item: Suggestion): SuggestOutcome {
  const term = memeText(item.term);
  const fields = { term, meaning: memeText(item.meaning), category: memeText(item.category) };
  if (memeProblem(fields)) return 'invalid';
  if (store.get('SELECT 1 FROM web_memelib_dismissed WHERE term=?', term)) return 'dismissed';
  const state = termState(store, term);
  if (state.kind === 'deleted-shipped' || state.kind === 'deleted-own') return 'deleted';
  if (state.kind === 'live') return 'exists';
  if (store.get('SELECT 1 FROM web_memelib_queue WHERE term=?', term)) return 'already-queued';
  insertQueue(store, now, { ...item, ...fields });
  return 'queued';
}

export function listQueue(store: Reader): MemeQueueView {
  if (!has(store, 'web_memelib_queue')) return { items: [], pending: 0 };
  const index = termIndex(layers(store));
  const items = store
    .all<{
      term: string;
      meaning: string;
      category: string;
      year: number | null;
      source: MemeQueueItem['source'];
      links_json: string;
      player_count: number | null;
      created_at: number;
    }>(
      'SELECT term,meaning,category,year,source,links_json,player_count,created_at FROM web_memelib_queue ORDER BY created_at,term',
    )
    .map((row): MemeQueueItem => {
      const state = stateIn(index, row.term);
      const shown = state.kind === 'live' || state.kind === 'deleted-shipped' ? state.entry : null;
      return {
        term: row.term,
        meaning: row.meaning,
        category: row.category,
        source: row.source,
        year: row.year,
        createdAt: row.created_at,
        links: JSON.parse(row.links_json) as string[],
        playerCount: row.player_count,
        existing: shown
          ? { meaning: shown.meaning, category: shown.category, enabled: shown.enabled, source: shown.source }
          : null,
        wasDeleted: state.kind === 'deleted-shipped' || state.kind === 'deleted-own',
      };
    });
  return { items, pending: items.length };
}

/** 不要: the items leave the queue and the term is never suggested again by an automatic source. */
export function dismissMemes(store: Writer, now: number, terms: readonly string[]) {
  const unique = keysOf(terms);
  ensure(
    unique.every((term) => store.get('SELECT 1 FROM web_memelib_queue WHERE term=?', term)),
    'MEME_QUEUE_NOT_FOUND',
  );
  for (const term of unique) {
    store.run('DELETE FROM web_memelib_queue WHERE term=?', term);
    store.run('INSERT OR REPLACE INTO web_memelib_dismissed(term,dismissed_at) VALUES (?,?)', term, now);
  }
  return { changed: unique.length };
}

/**
 * 通过: the items (with the owner's edits of the meaning and the category) enter the library, ON.
 *   - a new term becomes an own entry (its source is where the suggestion came from);
 *   - a term the library holds: its meaning and category are updated (an override for a shipped entry) and it is switched on;
 *   - a term the owner deleted: the entry comes back (a shipped one is restored, an own one is created again), ON.
 * Everything in one transaction; the cap is checked for the whole batch.
 */
export function approveMemes(
  store: Writer,
  now: number,
  items: readonly { term: string; newTerm?: unknown; meaning: unknown; category: unknown }[],
) {
  ensure(items.length > 0 && items.length <= MEME_BATCH_MAX, 'INVALID_REQUEST');
  const terms = new Set<string>();
  const from = new Set<string>();
  const prepared = items.map((item) => {
    // The owner may edit the term too before approving: `term` names the queue item, `newTerm` (if any) is what enters the library.
    const queueTerm = memeText(item.term);
    const term = item.newTerm === undefined ? queueTerm : memeText(item.newTerm);
    ensure(!terms.has(fold(term)) && !from.has(queueTerm), 'INVALID_REQUEST');
    terms.add(fold(term));
    from.add(queueTerm);
    const queued = store.get<{ source: Exclude<MemeSource, 'builtin' | 'manual'>; year: number | null }>(
      'SELECT source,year FROM web_memelib_queue WHERE term=?',
      queueTerm,
    );
    ensure(queued, 'MEME_QUEUE_NOT_FOUND');
    const fields: MemeFields = { term, meaning: memeText(item.meaning), category: memeText(item.category) };
    const state = termState(store, term);
    // An existing entry may keep a category outside the five (editing its text does not have to move it).
    const problem = memeProblem(fields, state.kind === 'live' || state.kind === 'deleted-shipped');
    if (problem) refuse(problem);
    return { fields, queued, state, queueTerm };
  });
  const growth = prepared.filter((p) => p.state.kind !== 'live').length;
  ensure(libraryCount(store) + growth <= MEME_LIBRARY_CAP, 'MEME_LIBRARY_FULL');
  let updated = 0;
  let revived = 0;
  for (const { fields, queued, state, queueTerm } of prepared) {
    if (state.kind === 'free' || state.kind === 'deleted-own') {
      if (state.kind === 'deleted-own') revived++;
      insertOwn(store, now, { ...fields, year: queued.year, source: queued.source, enabled: true });
      store.run('DELETE FROM web_memelib_deleted WHERE term=?', fields.term);
    } else {
      if (state.kind === 'deleted-shipped') {
        revived++;
        store.run('DELETE FROM web_memelib_deleted WHERE term=?', state.entry.key);
      } else updated++;
      const shipped = memeEntry(state.entry.key);
      if (shipped) writeOverride(store, now, shipped, fields.meaning, fields.category);
      else
        store.run(
          'UPDATE web_memelib_entry SET meaning=?,category=?,changed_at=? WHERE term=?',
          fields.meaning,
          fields.category,
          now,
          state.entry.key,
        );
      setMemesEnabled(store, now, [state.entry.key], true);
    }
    store.run('DELETE FROM web_memelib_queue WHERE term=?', queueTerm);
    store.run('DELETE FROM web_memelib_dismissed WHERE term IN (?,?)', queueTerm, fields.term);
  }
  return { changed: prepared.length, updated, revived };
}
