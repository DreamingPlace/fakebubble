import type { BubblePresentationCheck, DialogueBubble, DialogueCandidate } from '../contracts/index.ts';
import { EXPRESSIONS } from '../contracts/index.ts';
import { DomainError, ensure } from './errors.ts';

interface BubbleLimits { maxBubbles: number; maxCharacters: number; maxTotalCharacters: number; allowLineBreaks: boolean }
export const BUBBLE_LIMITS = Object.freeze({
  casual: Object.freeze({ maxBubbles: 3, maxCharacters: 60, maxTotalCharacters: 150, allowLineBreaks: false }),
  conflict_apology: Object.freeze({ maxBubbles: 6, maxCharacters: 160, maxTotalCharacters: 700, allowLineBreaks: false }),
}) satisfies Record<DialogueCandidate['mode'], BubbleLimits>;
// Spoken turns can contain several short sentences without becoming separate recordings.
export const VOICE_BUBBLE_LIMITS = Object.freeze({
  casual: Object.freeze({ maxBubbles: 3, maxCharacters: 120, maxTotalCharacters: 180, allowLineBreaks: false }),
  conflict_apology: BUBBLE_LIMITS.conflict_apology,
}) satisfies Record<DialogueCandidate['mode'], BubbleLimits>;
export function bubbleLimits(delivery: 'text' | 'voice' = 'text') {
  ensure(delivery === 'text' || delivery === 'voice', 'INVALID_DELIVERY');
  return delivery === 'voice' ? VOICE_BUBBLE_LIMITS : BUBBLE_LIMITS;
}
// A bounded draft may need presentation repair. These are NOT publication limits.
export const DRAFT_BUBBLE_LIMITS = Object.freeze({ maxBubbles: 8, maxCharacters: 240, maxTotalCharacters: 1200, allowLineBreaks: true });
const maxInspected = 8;

/** Bounded, content-free diagnostics for both audit input and persisted attempt metadata. */
export function inspectBubbles(value: unknown, limits: BubbleLimits): BubblePresentationCheck {
  const check: BubblePresentationCheck = { bubbleCount: null, charactersPerBubble: [], totalCharacters: null, issues: [] };
  if (!Array.isArray(value)) { check.issues.push({ code: 'not_array' }); return check; }
  check.bubbleCount = value.length;
  if (value.length < 1 || value.length > Math.min(limits.maxBubbles, maxInspected)) check.issues.push({ code: 'bubble_count' });
  for (const [bubbleIndex, bubble] of value.slice(0, maxInspected).entries()) {
    const issue = (code: BubblePresentationCheck['issues'][number]['code']) => check.issues.push({ code, bubbleIndex });
    if (!bubble || typeof bubble !== 'object' || Array.isArray(bubble)) {
      check.charactersPerBubble.push(null); issue('bubble_shape'); continue;
    }
    if (Object.keys(bubble).sort().join(',') !== 'expression,text') issue('bubble_shape');
    if (typeof bubble.text !== 'string') { check.charactersPerBubble.push(null); issue('text_type'); }
    else {
      const length = [...bubble.text].length; check.charactersPerBubble.push(length);
      if (!bubble.text.trim()) issue('empty_text');
      if (length > limits.maxCharacters) issue('text_length');
      if (!limits.allowLineBreaks && /[\r\n]/u.test(bubble.text)) issue('line_break');
      if (/[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F]/u.test(bubble.text)) issue('control_character');
    }
    if (!EXPRESSIONS.some(expression => expression === bubble.expression)) issue('expression');
  }
  if (value.length <= maxInspected && check.charactersPerBubble.every(length => length !== null)) {
    check.totalCharacters = check.charactersPerBubble.reduce<number>((sum, length) => sum + length!, 0);
    if (check.totalCharacters > limits.maxTotalCharacters) check.issues.push({ code: 'total_length' });
  }
  return check;
}

export class BubbleValidationError extends DomainError {
  readonly presentation: BubblePresentationCheck;
  constructor(presentation: BubblePresentationCheck) { super('INVALID_BUBBLES'); this.presentation = presentation; }
}
export function validatedBubbles(value: unknown, limits: BubbleLimits): DialogueBubble[] {
  const check = inspectBubbles(value, limits);
  if (check.issues.length) throw new BubbleValidationError(check);
  return (value as DialogueBubble[]).map(({ text, expression }) => ({ text, expression }));
}
