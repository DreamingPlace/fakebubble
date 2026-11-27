import { MEME_DICTIONARY_ROWS } from './meme-dictionary.generated.ts';

/**
 * Part 37c-1: the shipped dictionary (data/chinese-meme-dict/memes-2022plus.json, CC BY 4.0; see scripts/build-memes.ts). An entry's
 * key is its term (unique in the data, asserted by the tests). Never fetched at runtime.
 *
 * Part 37c-1b: every entry carries the category it was given in the re-curation (decided entry by entry by hand). An entry ships ON
 * only when it was kept (心情 / 关系 / 日常 / 追星娱乐 / 句式) and is not an everyday word; every other entry ships OFF and its category is
 * the reason. The owner's switch overrides the default both ways; his edits and deletions are a layer on top (web-meme-library.ts).
 */
export interface MemeEntry {
  key: string;
  term: string;
  meaning: string;
  year: number;
  tags: readonly string[];
  /** Ships switched OFF: dropped in the re-curation, or a common everyday word (jieba frequency, see scripts/build-memes.ts). */
  defaultOff: boolean;
  category: string;
  /** A common everyday word: stays off whatever the category (the 72 of Part 37c-1). */
  everyday: boolean;
}
export const MEME_ENTRIES: readonly MemeEntry[] = Object.freeze(
  MEME_DICTIONARY_ROWS.map(([term, meaning, year, tags, defaultOff, category, everyday]) =>
    Object.freeze({ key: term, term, meaning, year, tags, defaultOff, category, everyday }),
  ),
);
const byKey = new Map(MEME_ENTRIES.map((entry) => [entry.key, entry] as const));
export const memeEntry = (key: string): MemeEntry | undefined => byKey.get(key);
