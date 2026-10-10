import type { CocreationTargetField } from './cocreation-cards.ts';

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
  ADOPT_TEXT_REQUIRED: '请先写下要加入的内容。',
  ADOPT_EXAMPLE_INVALID: '对话示例需要情境、玩家的话，以及一到两句角色的回复，且每句不超过限制长度。',
  ADOPT_FIELD_SHAPE_UNSUPPORTED:
    '这个字段现有的结构既不是文字也不是列表，无法自动追加。请改选其他字段，或在角色工作台手动编辑。',
};
