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
const CANDIDATES: readonly Candidate[] = MEME_ENTRIES.map((entry) => {
  const needle = norm(entry.term);
  return {
    key: entry.key,
    term: entry.term,
    meaning: entry.meaning,
    needle,
    units: needle.length,
    boundary: ASCII_WORD.test(needle),
  };
})
  .filter((candidate) => [...candidate.needle].length >= MEME_TERM_MIN)
  .sort((a, b) => b.units - a.units || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

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
): MemeHit[] {
  const hits: MemeHit[] = [];
  const seen = new Set<string>();
  for (const raw of texts) {
    const text = norm(raw);
    const claimed: Array<readonly [number, number]> = [];
    const found: Array<{ at: number; candidate: Candidate }> = [];
    for (const candidate of CANDIDATES) {
      if (off.has(candidate.key) || seen.has(candidate.key)) continue;
      const at = find(text, candidate, claimed);
      if (at === -1) continue;
      claimed.push([at, at + candidate.needle.length]);
      found.push({ at, candidate });
    }
    // CANDIDATES is longest first, so `found` is already longest first; an equal length keeps the code order.
    for (const { candidate } of found) {
      if (hits.length >= max) return hits;
      seen.add(candidate.key);
      hits.push({ term: candidate.term, meaning: candidate.meaning, level: memeLevelOf(use, candidate.key) });
    }
  }
  return hits;
}
