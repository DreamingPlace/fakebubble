import {
  MEME_HITS_MAX,
  MEME_TERM_MIN,
  memeLevelOf,
  type MemeHit,
  type MemeUse,
} from '../../../packages/contracts/web-memes.ts';
import { MEME_ENTRIES } from './meme-dictionary.ts';

/**
 * Part 37c-1: which dictionary entries a reply should explain. Deterministic string matching only: no router, no embedding, no model.
 *
 *   - `texts` are the player's messages, LATEST FIRST (the writer's window is MEME_TURNS player messages);
 *   - text and term are compared after NFKC and lower-casing; a term shorter than MEME_TERM_MIN is never matched; a term made of
 *     ASCII letters / digits only must not touch another ASCII letter or digit (so 「MCP」 is not found inside 「xMCPx」, but is in 「用MCP做」);
 *   - within one message the LONGEST term wins and claims its stretch (a shorter term inside it does not count: 「GLM-4.5」 hides
 *     「GLM-4」); two terms of the same length go in code order;
 *   - messages are read latest first; every entry counts once; at most MEME_HITS_MAX entries;
 *   - an entry that is switched off (`off`) is never matched.
 * Identical input gives identical output.
 *
 * Part 37c-1b: the matcher reads an EFFECTIVE library (shipped entries with the owner's meaning edits + the owner's own entries). The
 * default library is the shipped one, so every earlier call keeps its meaning; `off` already holds the deleted entries and the ones
 * that are switched off, own and shipped alike. The words and rules above are unchanged, so the 新+档案+梗 pin does not move.
 */
const norm = (text: string) => text.normalize('NFKC').toLowerCase();
const WORD = /[A-Za-z0-9]/u;
const ASCII_WORD = /^[\x21-\x7e ]+$/u;

interface Candidate {
  key: string;
  term: string;
  meaning: string;
  needle: string;
  units: number;
  boundary: boolean;
}
/** The entries a reply may match, longest first (an equal length keeps the code order). */
export interface MemeMatchLibrary {
  readonly candidates: readonly Candidate[];
}
const candidateOf = (key: string, term: string, meaning: string): Candidate => {
  const needle = norm(term);
  return { key, term, meaning, needle, units: needle.length, boundary: ASCII_WORD.test(needle) };
};
const byLength = (a: Candidate, b: Candidate) => b.units - a.units || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
/**
 * The library for the owner's layer: `own` entries are added, `meanings` replaces the text of a shipped entry. An own entry whose
 * term is also shipped is impossible (the library refuses a duplicate term), but if one ever appeared the own one would be skipped.
 */
export function buildMatchLibrary(
  own: readonly { term: string; meaning: string }[],
  meanings: ReadonlyMap<string, string>,
): MemeMatchLibrary {
  const shipped = new Set(MEME_ENTRIES.map((entry) => entry.key));
  return {
    candidates: [
      ...MEME_ENTRIES.map((entry) => candidateOf(entry.key, entry.term, meanings.get(entry.key) ?? entry.meaning)),
      ...own
        .filter((entry) => !shipped.has(entry.term))
        .map((entry) => candidateOf(entry.term, entry.term, entry.meaning)),
    ]
      .filter((candidate) => [...candidate.needle].length >= MEME_TERM_MIN)
      .sort(byLength),
  };
}
export const SHIPPED_MEME_LIBRARY: MemeMatchLibrary = buildMatchLibrary([], new Map());

/** First position of `needle` in `text` that is not inside a claimed span (and stands alone when it must), or -1. */
function find(text: string, candidate: Candidate, claimed: ReadonlyArray<readonly [number, number]>): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(candidate.needle, from);
    if (at === -1) return -1;
    const end = at + candidate.needle.length;
    const inside = claimed.some(([a, b]) => at < b && end > a);
    const edge =
      !candidate.boundary ||
      ((at === 0 || !WORD.test(text[at - 1]!)) && (end === text.length || !WORD.test(text[end]!)));
    if (!inside && edge) return at;
    from = at + 1;
  }
}

export function matchMemes(
  texts: readonly string[],
  off: ReadonlySet<string>,
  use: MemeUse,
  max: number = MEME_HITS_MAX,
  library: MemeMatchLibrary = SHIPPED_MEME_LIBRARY,
): MemeHit[] {
  const hits: MemeHit[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const text = norm(raw);
    const claimed: Array<readonly [number, number]> = [];
    const found: Array<{ at: number; candidate: Candidate }> = [];
    for (const candidate of library.candidates) {
      if (off.has(candidate.key) || seen.has(candidate.key)) continue;
      const at = find(text, candidate, claimed);
      if (at === -1) continue;
      claimed.push([at, at + candidate.needle.length]);
      found.push({ at, candidate });
    }
    // the library's candidates are longest first, so `found` is already longest first; an equal length keeps the code order.
    for (const { candidate } of found) {
      if (hits.length >= max) return hits;
      seen.add(candidate.key);
      hits.push({ term: candidate.term, meaning: candidate.meaning, level: memeLevelOf(use, candidate.key) });
    }
  }
  return hits;
}
