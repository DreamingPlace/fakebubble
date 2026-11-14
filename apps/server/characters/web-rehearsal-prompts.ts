import { createHash } from 'node:crypto';

/**
 * Part 35: the two judge prompts of 多轮预演. They are sent ONLY to the house reviewer model, through the generation Worker, which
 * accepts a system prompt only when its text and sha256 are exactly one of these (it never runs arbitrary text on the provider key).
 * They are not part of the reply pipeline: no pinned prompt or policy hash of a chat reply depends on them.
 */
export const REHEARSAL_HINT_PROMPT = `你在为一个虚构聊天角色的"梗与故事"测试写测试用语。输入是一条梗或一个故事的资料（JSON）。
请写：
1. hints：2 句玩家可能说的话，用调侃、暗示的方式提到这件事，让熟悉它的人能听懂。每句口语化，不超过 30 个字。不得出现资料里的关键词或标题，不得出现任何人物的名字、别名或称呼。
2. negative：1 句长得像、但其实不是在说这件事的话：字面或话题相近，意思不相干（例如梗是生日，可以写"你生日哪天"这类普通的问法）。同样不得出现关键词、标题和任何名字，不超过 30 个字。
只输出一个 JSON 对象：{"hints":["…","…"],"negative":"…"}。不要输出任何别的文字。`;

export const REHEARSAL_VERDICT_PROMPT = `你在评估一个虚构聊天角色对"梗或故事"的反应。输入是 JSON：item 是这条梗或故事的资料，turns 依次是玩家的两句暗示（role 为 hint）和一句长得像但无关的话（role 为 negative），每句带着角色当时的回复 reply。
请判断：
1. hints：对每句暗示，回复是否认出了它，即明显按这件事回应，而不只是泛泛地接话。
2. negative：回复是否把那句无关的话当成了在说这件事（true 表示误触发）。
3. ownSide：角色是否站在自己的立场谈这件事（按 item 里的身份：亲历、听说或梗的当事人），没有替别人说、没有当旁白讲解。如果两句暗示都没有被认出，写 null。
只输出一个 JSON 对象：{"hints":[true,false],"negative":false,"ownSide":true}。不要输出任何别的文字。`;

export const promptHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const REHEARSAL_HINT_PROMPT_SHA256 = promptHash(REHEARSAL_HINT_PROMPT);
export const REHEARSAL_VERDICT_PROMPT_SHA256 = promptHash(REHEARSAL_VERDICT_PROMPT);
/** The system prompts the generation Worker will run. */
export const REHEARSAL_JUDGE_PROMPTS: Readonly<Record<string, string>> = Object.freeze({
  [REHEARSAL_HINT_PROMPT_SHA256]: REHEARSAL_HINT_PROMPT,
  [REHEARSAL_VERDICT_PROMPT_SHA256]: REHEARSAL_VERDICT_PROMPT,
});
/** Most tokens a judge answer may use (visible output); the hold adds the input bytes. */
export const REHEARSAL_JUDGE_OUTPUT_TOKENS = 400;
/** The only models a judge call may name: the house reviewers. */
export const REHEARSAL_JUDGE_MODELS: readonly string[] = ['deepseek-v4-pro', 'deepseek-flash'];

const parseObject = (text: string): Record<string, unknown> | null => {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    const value: unknown = JSON.parse(trimmed);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};
const HINT_MAX = 40;

/**
 * The written hints, or null when they break a rule (a name, the key word, too long, empty, not two different hints). The rules
 * are checked by code, not trusted to the model: `forbidden` is the key word or title and every name the view knows.
 */
export function parseHints(
  text: string,
  forbidden: readonly string[],
): { hints: [string, string]; negative: string } | null {
  const value = parseObject(text);
  if (!value || Object.keys(value).sort().join(',') !== 'hints,negative') return null;
  const hints = value.hints;
  const negative = value.negative;
  if (!Array.isArray(hints) || hints.length !== 2 || typeof negative !== 'string') return null;
  const lines = [...hints, negative];
  if (!lines.every((line) => typeof line === 'string')) return null;
  const clean = (lines as string[]).map((line) => line.trim());
  const banned = forbidden.map((word) => word.trim().toLowerCase()).filter((word) => word.length > 0);
  for (const line of clean) {
    if (line.length === 0 || [...line].length > HINT_MAX) return null;
    const lower = line.toLowerCase();
    if (banned.some((word) => lower.includes(word))) return null;
  }
  if (new Set(clean).size !== 3) return null;
  return { hints: [clean[0]!, clean[1]!], negative: clean[2]! };
}

export interface Verdict {
  hints: [boolean, boolean];
  negative: boolean;
  ownSide: boolean | null;
}
/** The judge's verdict, or null when it is not exactly the requested shape. */
export function parseVerdict(text: string): Verdict | null {
  const value = parseObject(text);
  if (!value || Object.keys(value).sort().join(',') !== 'hints,negative,ownSide') return null;
  const { hints, negative, ownSide } = value;
  if (
    !Array.isArray(hints) ||
    hints.length !== 2 ||
    !hints.every((h) => typeof h === 'boolean') ||
    typeof negative !== 'boolean' ||
    !(ownSide === null || typeof ownSide === 'boolean')
  )
    return null;
  return { hints: [hints[0] as boolean, hints[1] as boolean], negative, ownSide };
}
