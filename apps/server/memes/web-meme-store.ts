import { createHash } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import {
  MEME_PAGE_SIZE,
  type MemeEntryView,
  type MemeListInput,
  type MemeListView,
} from '../../../packages/contracts/web-memes.ts';
import { MEME_ENTRIES, memeEntry } from './meme-dictionary.ts';

/**
 * Part 37c-1: the per-entry on/off of the internet-meme dictionary. NO numbered migration (expected-migrations is untouched): the two
 * tables are installed idempotently at business-object start and checked against the digest of their statements. Any other state
 * (a foreign `web_meme_*` table, a changed digest) stops the start with WEB_MEME_SCHEMA_MISMATCH.
 *
 * An entry is ON unless it is a common everyday word (shipped DEFAULT OFF in the data). The table holds only the administrator's
 * OVERRIDES of that default, both ways: enabled=1 turns a default-off entry on, enabled=0 turns any entry off; a switch back to the
 * default deletes the row. No content, no player data, no id of a person. The dictionary itself ships with the build (meme-dictionary.generated.ts).
 */
const statements = [
  'CREATE TABLE web_meme_switch(entry_key TEXT PRIMARY KEY,enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),changed_at INTEGER NOT NULL) STRICT',
  'CREATE TABLE web_meme_schema(version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL) STRICT',
];
const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');

export function installMemeStore(store: BusinessStore) {
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_meme_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_meme_*'"), 'WEB_MEME_SCHEMA_MISMATCH');
      for (const statement of statements) store.run(statement);
      store.run('INSERT INTO web_meme_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_meme_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_MEME_SCHEMA_MISMATCH');
    const tables = store.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE name GLOB 'web_meme_*' ORDER BY name",
    );
    ensure(tables.map((row) => row.name).join(',') === 'web_meme_schema,web_meme_switch', 'WEB_MEME_SCHEMA_MISMATCH');
  });
}

type Reader = Pick<BusinessStore, 'get' | 'all'>;
/** The administrator's overrides: key -> enabled. A database without the table (an older one) has none. */
function overrides(store: Reader): Map<string, boolean> {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_meme_switch'")) return new Map();
  return new Map(
    store
      .all<{ entry_key: string; enabled: number }>('SELECT entry_key,enabled FROM web_meme_switch')
      .map((row) => [row.entry_key, row.enabled === 1]),
  );
}
/** The keys that are OFF now: the default-off entries, unless switched on, plus every entry the administrator switched off. */
export function readMemesOff(store: Reader): Set<string> {
  const set = overrides(store);
  const off = new Set<string>();
  for (const entry of MEME_ENTRIES) if (!(set.get(entry.key) ?? !entry.defaultOff)) off.add(entry.key);
  return off;
}

/** Switch entries on or off (idempotent; the override is dropped when it equals the default). Returns how many entries changed state. */
export function setMemesEnabled(
  store: Pick<BusinessStore, 'get' | 'all' | 'run'>,
  now: number,
  keys: readonly string[],
  enabled: boolean,
) {
  ensure(
    keys.length > 0 && keys.length <= MEME_ENTRIES.length && keys.every((key) => memeEntry(key)),
    'MEME_NOT_FOUND',
  );
  const off = readMemesOff(store);
  let changed = 0;
  for (const key of new Set(keys)) {
    if (off.has(key) !== enabled) continue;
    changed++;
    if (enabled === !memeEntry(key)!.defaultOff) store.run('DELETE FROM web_meme_switch WHERE entry_key=?', key);
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

const fold = (text: string) => text.normalize('NFKC').toLowerCase();
/** The admin list: filter (text over term, meaning and tags; year; tag; state), 50 a page, in dictionary order. */
export function listMemes(store: Reader, input: MemeListInput): MemeListView {
  const off = readMemesOff(store);
  const query = fold(input.query.trim());
  const view = (entry: (typeof MEME_ENTRIES)[number]): MemeEntryView => ({
    key: entry.key,
    term: entry.term,
    meaning: entry.meaning,
    year: entry.year,
    tags: [...entry.tags],
    enabled: !off.has(entry.key),
    defaultOff: entry.defaultOff,
  });
  const matching = MEME_ENTRIES.filter(
    (entry) =>
      (input.year === null || entry.year === input.year) &&
      (input.tag === null || entry.tags.includes(input.tag)) &&
      (input.state === 'all' ||
        (input.state === 'default-off' ? entry.defaultOff : (input.state === 'on') === !off.has(entry.key))) &&
      (query === '' ||
        fold(entry.term).includes(query) ||
        fold(entry.meaning).includes(query) ||
        entry.tags.some((tag) => fold(tag).includes(query))),
  );
  // With a search text the entry whose term IS the text comes first, then the terms that contain it, then the rest (dictionary order).
  const rank = (entry: (typeof MEME_ENTRIES)[number]) =>
    query === '' ? 0 : fold(entry.term) === query ? 0 : fold(entry.term).includes(query) ? 1 : 2;
  if (query !== '') matching.sort((a, b) => rank(a) - rank(b));
  const pages = Math.max(1, Math.ceil(matching.length / MEME_PAGE_SIZE));
  const page = Math.min(Math.max(1, input.page), pages);
  const tagCounts = new Map<string, number>();
  for (const entry of MEME_ENTRIES) for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  const known = MEME_ENTRIES.filter((entry) => !off.has(entry.key)).length;
  return {
    entries: matching.slice((page - 1) * MEME_PAGE_SIZE, page * MEME_PAGE_SIZE).map(view),
    matching: matching.length,
    page,
    pages,
    total: MEME_ENTRIES.length,
    on: known,
    defaultOff: MEME_ENTRIES.filter((entry) => entry.defaultOff).length,
    years: [...new Set(MEME_ENTRIES.map((entry) => entry.year))].sort((a, b) => b - a),
    tags: [...tagCounts]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 40)
      .map(([tag, count]) => ({ tag, count })),
  };
}
