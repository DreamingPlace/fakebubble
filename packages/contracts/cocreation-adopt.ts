import type { CocreationTargetField } from './cocreation-cards.ts';
import { dayPartOf, type DayPart } from './cocreation-day.ts';
import { addSample, writeCoreCard, writeDailyPart } from './speech-profile.ts';

/**
 * Turns one player idea an administrator chose into a change of a character draft's template. Pure: the caller
 * saves the result through the existing draft save API (compare-and-swap on the revision) and nothing is published.
 * `persona` is a paragraph appended to the persona text; everything else lives in `authorCanon.settings`.
 */
export type AdoptField = Exclude<CocreationTargetField, 'free'>;
export const ADOPT_FIELDS: readonly AdoptField[] = [
  'persona',
  'speechStyle',
  'dialogueStyle',
  'dialogueExamples',
  'interests',
  'boundaries',
  'personalityLayers',
  'fictionalPeople',
];

export type AdoptDraft =
  | { field: Exclude<AdoptField, 'dialogueExamples'>; text: string }
  | { field: 'dialogueExamples'; situation: string; player: string; reply: string[] };

/** Part 47: a part of 「一天」 is adopted into 一天的安排 (`authorCanon.settings.dailyLife`), not into one of the fields above. */
export type AdoptTarget = AdoptField | 'dailyLife';

export class CocreationAdoptError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'CocreationAdoptError';
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new CocreationAdoptError(code);
};

/** Fields where the settings value is free text; a list of strings is also appended to, never reshaped. */
const TEXT_FIELDS = new Set<AdoptField>(['speechStyle', 'dialogueStyle']);

type Template = { persona: string; authorCanon?: { kind: 'author_canon'; settings: Record<string, unknown> } } & Record<
  string,
  unknown
>;

/** A suggested starting point for the editor: the administrator may change both the text and the field. */
export function suggestAdoptDraft(
  field: AdoptField,
  answer: { text: string } | { player: string; replies: string[] },
  characterName: string,
): AdoptDraft {
  const plain =
    'text' in answer
      ? answer.text
      : [`玩家：${answer.player}`, ...answer.replies.map((reply) => `${characterName}：${reply}`)].join('\n');
  if (field !== 'dialogueExamples') return { field, text: plain };
  return 'text' in answer
    ? { field, situation: '日常聊天', player: '', reply: [answer.text] }
    : { field, situation: '日常聊天', player: answer.player, reply: [...answer.replies] };
}

const nonBlank = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && [...value].length <= max;

/**
 * Returns a modified copy of `template`. Errors are codes the editor shows next to the field:
 * ADOPT_TEXT_REQUIRED, ADOPT_EXAMPLE_INVALID, ADOPT_FIELD_SHAPE_UNSUPPORTED (the field exists but is neither text
 * nor a list, so there is no safe place to append).
 */
export function adoptIntoTemplate<T extends object>(template: T, draft: AdoptDraft): T {
  const next = structuredClone(template) as unknown as Template;
  if (draft.field === 'persona') {
    if (!nonBlank(draft.text, 5000)) fail('ADOPT_TEXT_REQUIRED');
    next.persona = `${next.persona.trimEnd()}\n\n${draft.text.trim()}`;
    return next as unknown as T;
  }
  const canon = (next.authorCanon ??= { kind: 'author_canon', settings: {} });
  const settings = canon.settings;
  const current = settings[draft.field];
  if (draft.field === 'dialogueExamples') {
    if (
      !nonBlank(draft.situation, 100) ||
      !nonBlank(draft.player, 120) ||
      draft.reply.length < 1 ||
      draft.reply.length > 2 ||
      !draft.reply.every((reply) => nonBlank(reply, 120))
    )
      fail('ADOPT_EXAMPLE_INVALID');
    const example = {
      situation: draft.situation.trim(),
      player: draft.player.trim(),
      reply: draft.reply.map((reply) => reply.trim()),
    };
    if (current === undefined) settings.dialogueExamples = [example];
    else if (Array.isArray(current)) current.push(example);
    else fail('ADOPT_FIELD_SHAPE_UNSUPPORTED');
    return next as unknown as T;
  }
  if (!nonBlank(draft.text, 2000)) fail('ADOPT_TEXT_REQUIRED');
  const text = draft.text.trim();
  if (current === undefined) settings[draft.field] = TEXT_FIELDS.has(draft.field) ? text : [text];
  else if (typeof current === 'string') settings[draft.field] = `${current.trimEnd()}\n${text}`;
  else if (Array.isArray(current)) current.push(text);
  else fail('ADOPT_FIELD_SHAPE_UNSUPPORTED');
  return next as unknown as T;
}

export const ADOPT_ERROR_TEXT: Record<string, string> = {
  ADOPT_NO_DRAFT: '这个角色还没有可编辑的版本，请先在角色工作台中创建草稿。',
  ADOPT_TEXT_REQUIRED: '请先写下要加入的内容。',
  ADOPT_EXAMPLE_INVALID: '对话示例需要情境、玩家的话，以及一到两句角色的回复，且每句不超过限制长度。',
  ADOPT_FIELD_SHAPE_UNSUPPORTED:
    '这个字段现有的结构既不是文字也不是列表，无法自动追加。请改选其他字段，或在角色工作台手动编辑。',
};

// ---- Part 55: 采纳 - one answer into its destination, written by the server --------------------------------------------------------

/** Where an answer goes. `situation` is for 说话样本 (one of the eight), `part` for 一天的安排. */
export type AdoptDestination = { field: AdoptTarget; situation?: string; part?: DayPart };
export const ADOPT_DEFAULT_SITUATION = '日常闲聊';
export type AdoptAnswer =
  | { kind: 'text'; text: string; cardId: string; targetField: CocreationTargetField }
  | { kind: 'dialogue'; player: string; replies: string[]; cardId: string; targetField: CocreationTargetField };

/**
 * The destination an answer goes to when the administrator picks none ("picked as today"): a part of 一天 → 一天的安排; a dialogue →
 * 说话样本 under 日常闲聊; a text answer → the field its card is routed to (说话风格 and 对话方式 are the 核心卡 fields), a free one → 人设.
 */
export function defaultDestination(answer: Pick<AdoptAnswer, 'kind' | 'cardId' | 'targetField'>): AdoptDestination {
  const part = dayPartOf(answer.cardId);
  if (part) return { field: 'dailyLife', part };
  if (answer.kind === 'dialogue') return { field: 'dialogueExamples', situation: ADOPT_DEFAULT_SITUATION };
  if (answer.targetField === 'free' || answer.targetField === 'dialogueExamples') return { field: 'persona' };
  return { field: answer.targetField as AdoptField };
}

/**
 * Returns a modified copy of `template` with the answer merged into its destination. Pure; throws CocreationAdoptError or
 * SpeechProfileError (codes the caller names). A text goes in as a new line / list entry / paragraph, never over what is there.
 */
export function adoptAnswerIntoTemplate<T extends object>(
  template: T,
  answer: AdoptAnswer,
  destination: AdoptDestination,
  characterName: string,
): T {
  const plain =
    answer.kind === 'text'
      ? answer.text
      : [`玩家：${answer.player}`, ...answer.replies.map((reply) => `${characterName}：${reply}`)].join('\n');
  const { field } = destination;
  if (field === 'dailyLife') {
    const part = destination.part ?? dayPartOf(answer.cardId);
    if (!part) return fail('ADOPT_TEXT_REQUIRED');
    return writeDailyPart(template, part, plain, 'append');
  }
  if (field === 'dialogueExamples') {
    if (answer.kind !== 'dialogue') return fail('ADOPT_EXAMPLE_INVALID');
    return addSample(template, {
      situation: destination.situation ?? ADOPT_DEFAULT_SITUATION,
      player: answer.player,
      reply: [...answer.replies],
    });
  }
  if (field === 'speechStyle') return writeCoreCard(template, 'speechHabit', plain, 'append');
  if (field === 'dialogueStyle') return writeCoreCard(template, 'length', plain, 'append');
  return adoptIntoTemplate(template, { field, text: plain });
}
