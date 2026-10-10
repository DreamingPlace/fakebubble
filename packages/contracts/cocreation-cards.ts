/**
 * Co-creation ("共创") cards: players write ideas that make an official character more like themselves.
 * The card list is the single definition shared by the player sheet, the submit route and the admin inbox.
 * `targetField` is a hidden routing hint for administrators; players never see it. Nothing here reaches a
 * prompt: an administrator copies an answer into a draft and publishes it through the normal flow.
 */
export const COCREATION_TARGET_FIELDS = [
  'persona',
  'speechStyle',
  'dialogueStyle',
  'dialogueExamples',
  'interests',
  'boundaries',
  'personalityLayers',
  'fictionalPeople',
  'free',
] as const;
export type CocreationTargetField = (typeof COCREATION_TARGET_FIELDS)[number];
export type CocreationKind = 'text' | 'dialogue';
export type CocreationCard = {
  id: string;
  /** `{name}` is replaced with the character's display name. */
  prompt: string;
  targetField: CocreationTargetField;
  kind: CocreationKind;
};

export const COCREATION_CARDS: readonly CocreationCard[] = Object.freeze([
  { id: 'praise-stubborn', prompt: '{name}被夸的时候会怎么嘴硬？', targetField: 'personalityLayers', kind: 'text' },
  { id: 'catchphrase', prompt: '{name}最常挂在嘴边的一句话', targetField: 'speechStyle', kind: 'text' },
  { id: 'cannot-stand', prompt: '{name}最受不了什么', targetField: 'boundaries', kind: 'text' },
  { id: 'comfort-way', prompt: '{name}安慰人的方式', targetField: 'dialogueStyle', kind: 'text' },
  { id: 'quirk', prompt: '{name}有什么小怪癖', targetField: 'persona', kind: 'text' },
  { id: 'topics', prompt: '{name}最爱聊、最烦聊的话题', targetField: 'interests', kind: 'text' },
  { id: 'people-around', prompt: '{name}身边有哪些人', targetField: 'fictionalPeople', kind: 'text' },
  { id: 'small-secret', prompt: '{name}的一个小秘密（无伤大雅的那种）', targetField: 'persona', kind: 'text' },
  { id: 'when-angry', prompt: '{name}生气时会怎样', targetField: 'personalityLayers', kind: 'text' },
  { id: 'not-like', prompt: '你觉得{name}现在哪里不像{name}', targetField: 'persona', kind: 'text' },
  { id: 'free', prompt: '随便写点什么', targetField: 'free', kind: 'text' },
  { id: 'dialogue', prompt: '来一段对话', targetField: 'dialogueExamples', kind: 'dialogue' },
] satisfies CocreationCard[]);

const byId = new Map(COCREATION_CARDS.map((card) => [card.id, card]));
export const cocreationCard = (id: string) => byId.get(id);
export const cocreationPrompt = (card: CocreationCard, name: string) => card.prompt.replaceAll('{name}', name);

export const COCREATION_LIMITS = Object.freeze({
  text: 300,
  free: 1000,
  dialoguePlayer: 120,
  dialogueReply: 120,
  dialogueReplies: 2,
  answersPerSubmission: 12,
  submissionsPerDay: 5,
  windowMs: 86_400_000,
  note: 1000,
});

/** Friendly labels the administrator sees; the player never does. */
export const COCREATION_FIELD_LABELS: Record<CocreationTargetField, string> = {
  persona: '人设 · 性格底色',
  speechStyle: '说话风格 · 口头禅',
  dialogueStyle: '对话方式',
  dialogueExamples: '对话示例',
  interests: '兴趣话题',
  boundaries: '雷点 · 边界',
  personalityLayers: '性格层次',
  fictionalPeople: '身边的人',
  free: '自由发挥',
};

export type CocreationAnswer = { cardId: string; text: string } | { cardId: string; player: string; replies: string[] };

/** Same rule as chat input: non-blank after trim, counted in code points, no control characters (not even a newline). */
export const cocreationTextOk = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  [...value].length <= max &&
  !/[\u0000-\u001f\u007f]/u.test(value);

export type CocreationValidation = { ok: true; answers: CocreationAnswer[] } | { ok: false; code: string };

/** Strict shape check against the shared card list; the server relies on this, the sheet uses it to enable the button. */
export function validateCocreationAnswers(value: unknown): CocreationValidation {
  const bad = (code: string): CocreationValidation => ({ ok: false, code });
  if (!Array.isArray(value) || value.length === 0) return bad('COCREATION_EMPTY');
  if (value.length > COCREATION_LIMITS.answersPerSubmission) return bad('COCREATION_TOO_MANY_ANSWERS');
  const seen = new Set<string>();
  const answers: CocreationAnswer[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return bad('INVALID_REQUEST');
    const entry = raw as Record<string, unknown>;
    const card = typeof entry.cardId === 'string' ? cocreationCard(entry.cardId) : undefined;
    if (!card || seen.has(card.id)) return bad('COCREATION_CARD_INVALID');
    seen.add(card.id);
    const keys = Object.keys(entry).sort().join(',');
    if (card.kind === 'text') {
      if (keys !== 'cardId,text') return bad('INVALID_REQUEST');
      if (!cocreationTextOk(entry.text, card.id === 'free' ? COCREATION_LIMITS.free : COCREATION_LIMITS.text))
        return bad('COCREATION_TEXT_INVALID');
      answers.push({ cardId: card.id, text: entry.text });
    } else {
      if (keys !== 'cardId,player,replies') return bad('INVALID_REQUEST');
      const replies = entry.replies;
      if (
        !cocreationTextOk(entry.player, COCREATION_LIMITS.dialoguePlayer) ||
        !Array.isArray(replies) ||
        replies.length < 1 ||
        replies.length > COCREATION_LIMITS.dialogueReplies ||
        !replies.every((reply) => cocreationTextOk(reply, COCREATION_LIMITS.dialogueReply))
      )
        return bad('COCREATION_TEXT_INVALID');
      answers.push({ cardId: card.id, player: entry.player, replies: [...(replies as string[])] });
    }
  }
  return { ok: true, answers };
}
