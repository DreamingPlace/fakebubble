import { createHash } from 'node:crypto';
import {
  MEME_HITS_MAX,
  MEME_LEVELS,
  MEME_LEVEL_DEFAULT,
  MEME_LEVEL_LABELS,
  MEME_TERM_MIN,
  MEME_TURNS,
  type MemeHit,
  type MemeLevel,
} from '../../../packages/contracts/web-memes.ts';
import { castSelectFingerprint } from '../cast/cast-select.ts';

/**
 * Part 37c-1: what 新+档案+梗 adds to a 新+档案 request. The matched dictionary entries (frozen in the request as `memeHits`, with the
 * character's level for each) go in the system message AFTER everything stable and after the picked examples; with no match nothing
 * is added at all. The selected cast context (`request.cast`, selected per reply by cast-select.ts) is printed exactly as 24a prints it.
 *
 * The words below and the rules of matching and selection are pinned by `writerMemesHash()` (the pin of 新+档案+梗 only: 旧, 新 and
 * 新+档案 never read this file).
 */
export const MEMES_HEAD =
  '网络梗（玩家最近的话里出现了下面这些词。词义是通用的；用不用、怎么用，看你自己的档位，不要硬塞）：';
export const MEME_LEVEL_RULES: Readonly<Record<MemeLevel, string>> = Object.freeze({
  use: '你听得懂，也可以在自然、符合你性格的时候自己用一下',
  know: '你听得懂，但你自己从不使用它',
  avoid: '你只要别误解它的意思；你自己不用，也不跟着玩，用你自己的话正常回应',
});

/** The block ('' when nothing matched). */
export function memesBlock(hits: readonly MemeHit[] | undefined): string {
  if (!hits?.length) return '';
  const lines = hits.map(
    (hit) => `- 「${hit.term}」：${hit.meaning}（${MEME_LEVEL_LABELS[hit.level]}：${MEME_LEVEL_RULES[hit.level]}）`,
  );
  return `${MEMES_HEAD}\n${lines.join('\n')}`;
}

export const memesFingerprint = () => [
  MEMES_HEAD,
  MEME_LEVELS.map((level) => [level, MEME_LEVEL_LABELS[level], MEME_LEVEL_RULES[level]]),
  MEME_LEVEL_DEFAULT,
  MEME_HITS_MAX,
  MEME_TURNS,
  MEME_TERM_MIN,
  castSelectFingerprint(),
];
export const writerMemesHash = () => createHash('sha256').update(JSON.stringify(memesFingerprint())).digest('hex');
/** The pin: the generation Worker refuses a 新+档案+梗 request when these words and rules do not hash to exactly this. */
export const WRITER_MEMES_SHA256 = 'a43554c584cadef62dc5b9ed1041268d1f0505f6cfff59d635502e3c35c6a485';
