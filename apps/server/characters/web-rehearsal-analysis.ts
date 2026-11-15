import type { RehearsalCounts, RehearsalPhrases } from '../../../packages/contracts/web-rehearsal.ts';

/**
 * Part 35: the counts of a 多轮预演, computed by code from the stored replies. Nothing here calls a model: the meaning-level
 * judgments (does the reply recognise a meme) are the judge's and live in web-rehearsal.ts.
 *
 * The two phrase lists are the administrator's to edit (多轮预演 → 词表); these are what an untouched install starts with.
 */
export const DEFAULT_PHRASES: Readonly<RehearsalPhrases> = Object.freeze({
  customerService: Object.freeze([
    '有什么可以帮',
    '为您',
    '请问',
    '很高兴为你',
    '希望对你有帮助',
    '如有需要',
    '随时告诉我',
    '随时联系我',
    '感谢你的',
    '抱歉给你带来',
    '我理解你的',
    '作为一个',
    '有任何问题',
  ]) as unknown as string[],
  advice: Object.freeze([
    '注意休息',
    '早点睡',
    '早点休息',
    '好好休息',
    '多喝水',
    '多喝点水',
    '别熬夜',
    '照顾好自己',
    '注意身体',
    '保重身体',
  ]) as unknown as string[],
});

/** A player line that asks for advice: a reply that then advises was asked to. */
const ASKING = ['怎么办', '怎么', '建议', '该不该', '要不要', '能不能', '如何', '怎样', '有什么办法', '帮我'];
const TRAIL = /[\s。.…~～!！,，、☆★♥❤😊😂🙂🥺😭😅🤣]+$/u;
const PUNCT = /[\s\p{P}\p{S}]/gu;

export interface AnalysedReply {
  /** The player's message of the turn. */
  player: string;
  bubbles: string[];
  /** The reply covers the turn's message and defers nothing. null: a v8 reply (the writer does not track it). */
  answered: boolean | null;
}

export const endsWithQuestion = (bubbles: readonly string[]) => {
  const last = (bubbles.at(-1) ?? '').replace(TRAIL, '');
  return /[?？]$/u.test(last) || /[吗呢么]$/u.test(last);
};
const flat = (bubbles: readonly string[]) => bubbles.join('');
export const hasPhrase = (text: string, phrases: readonly string[]) =>
  phrases.some((p) => p.length > 0 && text.includes(p));
export const unaskedAdvice = (reply: AnalysedReply, advice: readonly string[]) =>
  hasPhrase(flat(reply.bubbles), advice) && !ASKING.some((word) => reply.player.includes(word));

/** Six characters in a row, letters and kanji only: the unit of "the same phrase came back". */
const SHINGLE = 6;
const shingles = (text: string) => {
  const chars = [...text.replace(PUNCT, '')];
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= chars.length; i++) out.add(chars.slice(i, i + SHINGLE).join(''));
  return out;
};
/**
 * Replies that repeat an earlier reply of the same model: a run of SHINGLE characters (not in the player's own line of the turn,
 * which a reply may echo) that an earlier reply already had.
 */
export function repeatedReplies(replies: readonly AnalysedReply[]) {
  const seen = new Set<string>();
  let repeated = 0;
  for (const reply of replies) {
    const mine = shingles(flat(reply.bubbles));
    const echo = shingles(reply.player);
    let again = false;
    for (const s of mine) if (seen.has(s) && !echo.has(s)) again = true;
    if (again) repeated++;
    for (const s of mine) seen.add(s);
  }
  return repeated;
}

export function countReplies(
  replies: readonly AnalysedReply[],
  lists: RehearsalPhrases,
  extra: { unconfirmed: number; failed: number },
): RehearsalCounts {
  const n = replies.length;
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const avg = (values: number[]) => (n === 0 ? null : Math.round((sum(values) / n) * 10) / 10);
  return {
    replies: n,
    answeredAll: replies.some((r) => r.answered === null) ? null : replies.filter((r) => r.answered).length,
    unaskedAdvice: replies.filter((r) => unaskedAdvice(r, lists.advice)).length,
    endsWithQuestion: replies.filter((r) => endsWithQuestion(r.bubbles)).length,
    avgChars: avg(replies.map((r) => [...flat(r.bubbles)].length)),
    avgBubbles: avg(replies.map((r) => r.bubbles.length)),
    customerService: replies.filter((r) => hasPhrase(flat(r.bubbles), lists.customerService)).length,
    repeated: repeatedReplies(replies),
    unconfirmed: extra.unconfirmed,
    failed: extra.failed,
  };
}

/** A phrase list from an administrator's input: trimmed, no empty or repeated entries, bounded. */
export function cleanPhrases(value: unknown, max: number, chars: number): string[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    const text = item.trim();
    if (text.length === 0 || [...text].length > chars || /[\u0000-\u001f]/.test(text)) return null;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}
