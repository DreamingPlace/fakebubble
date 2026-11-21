import { MEME_DICTIONARY_ROWS } from './meme-dictionary.generated.ts';

/**
 * Part 37c-1: the shipped dictionary (data/chinese-meme-dict/memes-2022plus.json, CC BY 4.0; see scripts/build-memes.ts). An entry's
 * key is its term (unique in the data, asserted by the tests). Never fetched at runtime.
 */
export interface MemeEntry {
  key: string;
  term: string;
  meaning: string;
  year: number;
  tags: readonly string[];
  /** A common everyday word (jieba frequency, see scripts/build-memes.ts): starts switched OFF; the owner's switch overrides it. */
  defaultOff: boolean;
}
export const MEME_ENTRIES: readonly MemeEntry[] = Object.freeze(
  MEME_DICTIONARY_ROWS.map(([term, meaning, year, tags, defaultOff]) =>
    Object.freeze({ key: term, term, meaning, year, tags, defaultOff }),
  ),
);
const byKey = new Map(MEME_ENTRIES.map((entry) => [entry.key, entry] as const));
export const memeEntry = (key: string): MemeEntry | undefined => byKey.get(key);
