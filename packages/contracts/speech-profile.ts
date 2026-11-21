/**
 * Part 37b: 说话档案. Pure, shared by the console and the writer. NOTHING here is stored anywhere of its own: the 核心卡 and the 说话样本
 * live in the character draft's `authorCanon.settings` (a free JSON record, no schema change), and a draft reaches players only
 * through 发布 (正式版本), exactly as before.
 *
 * 核心卡 (four fields) → existing / new keys of settings:
 *   说话习惯 → speechStyle      (existing)
 *   幽默方式 → humorStyle       (new key, text)
 *   绝不会说的话 → neverSay     (new key, text)
 *   回复长短 → dialogueStyle    (existing)
 * 说话样本 → settings.dialogueExamples ({situation, player, reply[]}), `situation` limited to the eight tags below. An example whose
 * `situation` is any other string stays readable as 未分类 and is never rewritten by this code.
 *
 * Until a field has content the character's current settings ARE its card: a character with only speechStyle has a card of one field.
 */
export const SPEECH_SITUATIONS = ['日常闲聊', '调侃', '抱怨', '安慰', '吵架', '分享日常', '内部梗', '认真'] as const;
export type SpeechSituation = (typeof SPEECH_SITUATIONS)[number];
export const UNCATEGORIZED = '未分类';
export const isSpeechSituation = (value: unknown): value is SpeechSituation =>
  typeof value === 'string' && (SPEECH_SITUATIONS as readonly string[]).includes(value);

export const CORE_FIELDS = ['speechHabit', 'humor', 'neverSay', 'length'] as const;
export type CoreField = (typeof CORE_FIELDS)[number];
export const CORE_FIELD_LABELS: Readonly<Record<CoreField, string>> = Object.freeze({
  speechHabit: '说话习惯',
  humor: '幽默方式',
  neverSay: '绝不会说的话',
  length: '回复长短',
});
/** The `authorCanon.settings` key each field is stored under. */
export const CORE_FIELD_KEYS: Readonly<Record<CoreField, 'speechStyle' | 'humorStyle' | 'neverSay' | 'dialogueStyle'>> =
  Object.freeze({
    speechHabit: 'speechStyle',
    humor: 'humorStyle',
    neverSay: 'neverSay',
    length: 'dialogueStyle',
  });
/** Code points one 核心卡 field may hold (what a save or an adoption may leave it at). */
export const CORE_FIELD_MAX = 300;
/** Examples of ONE situation of ONE character. */
export const EXAMPLES_PER_SITUATION_MAX = 6;
/** Limits of one example (the same as 24b-6 / 39: a player line and one or two reply lines). */
export const EXAMPLE_PLAYER_MAX = 120;
export const EXAMPLE_REPLY_MAX = 120;

export type Example = { situation?: string; player?: string; reply?: string[] };
type Settings = Record<string, unknown>;

export class SpeechProfileError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'SpeechProfileError';
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new SpeechProfileError(code);
};

/** Admin sentences (docs/ADMIN_COPY.md, Part 37b). */
export const SPEECH_PROFILE_ERROR_TEXT: Record<string, string> = {
  PROFILE_TEXT_REQUIRED: '请先写下要加入的内容。',
  PROFILE_CARD_TOO_LONG: `这一栏最多 ${CORE_FIELD_MAX} 字，请先精简现有内容。`,
  PROFILE_SITUATION_FULL: `这个情境已有 ${EXAMPLES_PER_SITUATION_MAX} 条样本，请先删掉一条。`,
  PROFILE_EXAMPLE_INVALID: `样本需要玩家的话（不超过 ${EXAMPLE_PLAYER_MAX} 字）和一到两句角色的回复（每句不超过 ${EXAMPLE_REPLY_MAX} 字）。`,
  PROFILE_SITUATION_INVALID: '请从八个情境里选一个。',
  PROFILE_FIELD_SHAPE_UNSUPPORTED:
    '这个字段现有的结构既不是文字也不是列表，无法自动改写。请在角色工作台的其他分区手动编辑。',
  PROFILE_SAMPLE_MISSING: '这条样本已经不在草稿里了，请刷新后再试。',
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');
const len = (text: string) => [...text].length;
const nonBlank = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && len(value.trim()) <= max;

/** The settings of a template (an empty record when it has none). Never mutated. */
export const settingsOf = (template: unknown): Settings => {
  const canon = isObject(template) ? template.authorCanon : undefined;
  return isObject(canon) && isObject(canon.settings) ? canon.settings : {};
};

/** A field's current text: one text, a list joined by lines, or '' (absent / another shape). */
export function cardText(settings: Settings, field: CoreField): string {
  const value = settings[CORE_FIELD_KEYS[field]];
  if (typeof value === 'string') return value;
  if (isStrings(value)) return value.join('\n');
  return '';
}
/** False for a field whose stored value is neither text nor a list (the editor shows it read-only). */
export const cardEditable = (settings: Settings, field: CoreField) => {
  const value = settings[CORE_FIELD_KEYS[field]];
  return value === undefined || typeof value === 'string' || isStrings(value);
};
export type CoreCard = Record<CoreField, string>;
export const readCoreCard = (template: unknown): CoreCard => {
  const settings = settingsOf(template);
  return Object.fromEntries(CORE_FIELDS.map((field) => [field, cardText(settings, field)])) as CoreCard;
};

const exampleOf = (value: unknown): Example | null =>
  isObject(value) &&
  (value.situation === undefined || typeof value.situation === 'string') &&
  (value.player === undefined || typeof value.player === 'string') &&
  (value.reply === undefined || isStrings(value.reply))
    ? (value as Example)
    : null;

export type BankEntry = { index: number; situation: SpeechSituation | typeof UNCATEGORIZED; example: Example };
/** Every readable example in stored order with its group; an entry of another shape is skipped (and never touched by this code). */
export function readBank(template: unknown): BankEntry[] {
  const list = settingsOf(template).dialogueExamples;
  if (!Array.isArray(list)) return [];
  const out: BankEntry[] = [];
  list.forEach((raw, index) => {
    const example = exampleOf(raw);
    if (example)
      out.push({ index, situation: isSpeechSituation(example.situation) ? example.situation : UNCATEGORIZED, example });
  });
  return out;
}
export const bankCounts = (template: unknown): Record<SpeechSituation | typeof UNCATEGORIZED, number> => {
  const counts = Object.fromEntries([...SPEECH_SITUATIONS, UNCATEGORIZED].map((tag) => [tag, 0])) as Record<
    SpeechSituation | typeof UNCATEGORIZED,
    number
  >;
  for (const entry of readBank(template)) counts[entry.situation]++;
  return counts;
};

const cloneTemplate = <T extends object>(template: T) =>
  structuredClone(template) as unknown as Record<string, unknown>;
const settingsForWrite = (copy: Record<string, unknown>): Settings => {
  if (!isObject(copy.authorCanon)) copy.authorCanon = { kind: 'author_canon', settings: {} };
  const canon = copy.authorCanon as Record<string, unknown>;
  if (!isObject(canon.settings)) canon.settings = {};
  return canon.settings as Settings;
};

/**
 * 核心卡: adds `text` to one field (appended on its own line when the field already has text), or, with `replace`, sets the field.
 * The result may not be longer than CORE_FIELD_MAX (an existing longer text must be shortened first).
 */
export function writeCoreCard<T extends object>(
  template: T,
  field: CoreField,
  text: string,
  mode: 'append' | 'replace' = 'append',
): T {
  if (mode === 'replace') {
    if (text.trim() === '') {
      const copy = cloneTemplate(template);
      if (isObject(copy.authorCanon) && isObject((copy.authorCanon as Record<string, unknown>).settings))
        delete ((copy.authorCanon as Record<string, unknown>).settings as Settings)[CORE_FIELD_KEYS[field]];
      return copy as unknown as T;
    }
  } else if (typeof text !== 'string' || text.trim() === '') fail('PROFILE_TEXT_REQUIRED');
  else if (len(text.trim()) > CORE_FIELD_MAX) fail('PROFILE_CARD_TOO_LONG');
  const copy = cloneTemplate(template);
  const settings = settingsForWrite(copy);
  const key = CORE_FIELD_KEYS[field];
  if (!cardEditable(settings, field)) fail('PROFILE_FIELD_SHAPE_UNSUPPORTED');
  const current = cardText(settings, field).trimEnd();
  const next = mode === 'append' && current !== '' ? `${current}\n${text.trim()}` : text.trim();
  if (len(next) > CORE_FIELD_MAX) fail('PROFILE_CARD_TOO_LONG');
  settings[key] = next;
  return copy as unknown as T;
}

/** 说话样本: adds one example under one of the eight situations. A full situation (6) is refused. */
export function addSample<T extends object>(
  template: T,
  input: { situation: string; player: string; reply: string[] },
): T {
  if (!isSpeechSituation(input.situation)) fail('PROFILE_SITUATION_INVALID');
  if (
    !nonBlank(input.player, EXAMPLE_PLAYER_MAX) ||
    input.reply.length < 1 ||
    input.reply.length > 2 ||
    !input.reply.every((line) => nonBlank(line, EXAMPLE_REPLY_MAX))
  )
    fail('PROFILE_EXAMPLE_INVALID');
  if (bankCounts(template)[input.situation as SpeechSituation] >= EXAMPLES_PER_SITUATION_MAX)
    fail('PROFILE_SITUATION_FULL');
  const copy = cloneTemplate(template);
  const settings = settingsForWrite(copy);
  const list = settings.dialogueExamples;
  const example = {
    situation: input.situation,
    player: input.player.trim(),
    reply: input.reply.map((line) => line.trim()),
  };
  if (list === undefined) settings.dialogueExamples = [example];
  else if (Array.isArray(list)) list.push(example);
  else fail('PROFILE_FIELD_SHAPE_UNSUPPORTED');
  return copy as unknown as T;
}

/** Removes the example at `index` of the stored list. Every other entry (any shape) stays exactly as it was. */
export function deleteSample<T extends object>(template: T, index: number): T {
  const copy = cloneTemplate(template);
  const list = settingsOf(copy).dialogueExamples;
  if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length)
    fail('PROFILE_SAMPLE_MISSING');
  (list as unknown[]).splice(index, 1);
  if ((list as unknown[]).length === 0) delete settingsOf(copy).dialogueExamples;
  return copy as unknown as T;
}

/** Gives the example at `index` another situation (or, from 未分类, a first one). The target situation may not be full. */
export function moveSample<T extends object>(template: T, index: number, situation: string): T {
  if (!isSpeechSituation(situation)) fail('PROFILE_SITUATION_INVALID');
  const copy = cloneTemplate(template);
  const list = settingsOf(copy).dialogueExamples;
  const target = Array.isArray(list) ? exampleOf(list[index]) : null;
  if (!Array.isArray(list) || !target) return fail('PROFILE_SAMPLE_MISSING');
  if (target.situation === situation) return copy as unknown as T;
  if (bankCounts(template)[situation as SpeechSituation] >= EXAMPLES_PER_SITUATION_MAX) fail('PROFILE_SITUATION_FULL');
  (list[index] as Example).situation = situation;
  return copy as unknown as T;
}

// ---- independence ---------------------------------------------------------------------------------------------------------------

/**
 * Normalised text: NFKC, lower case, everything that is not a letter, digit or CJK character removed (spaces, punctuation, symbols,
 * emoji), so only the words are compared.
 */
export const normalizeLine = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');

/** Dice coefficient over character bigrams (a single-character text counts as one unigram). 1 = the same letters in the same pairs. */
export function similarity(a: string, b: string): number {
  const x = normalizeLine(a);
  const y = normalizeLine(b);
  if (x === '' || y === '') return 0;
  if (x === y) return 1;
  const grams = (text: string) => {
    const chars = [...text];
    const map = new Map<string, number>();
    const size = chars.length < 2 ? 1 : 2;
    for (let i = 0; i + size <= chars.length; i++) {
      const gram = chars.slice(i, i + size).join('');
      map.set(gram, (map.get(gram) ?? 0) + 1);
    }
    return map;
  };
  const left = grams(x);
  const right = grams(y);
  let shared = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0);
  return total === 0 ? 0 : (2 * shared) / total;
}

/** A line shorter than this (after normalising) is never compared: 「哈哈」 is not anyone's own. */
export const INDEPENDENCE_MIN_CHARS = 4;
/** score ≥ BLOCK: the same line (or all but a few characters). Saving is refused. */
export const INDEPENDENCE_BLOCK = 0.9;
/** score ≥ WARN: close. The owner is told and may save anyway. */
export const INDEPENDENCE_WARN = 0.6;

/** The lines one template contributes: each non-blank line of a card field, and each reply line of a sample (tagged or not). */
export function profileLines(template: unknown): { kind: 'card' | 'sample'; text: string }[] {
  const settings = settingsOf(template);
  const out: { kind: 'card' | 'sample'; text: string }[] = [];
  for (const field of CORE_FIELDS)
    for (const line of cardText(settings, field).split('\n'))
      if (line.trim() !== '') out.push({ kind: 'card', text: line.trim() });
  for (const entry of readBank(template))
    for (const line of entry.example.reply ?? [])
      if (line.trim() !== '') out.push({ kind: 'sample', text: line.trim() });
  return out;
}

export type IndependenceHit = { characterId: string; text: string; own: string; score: number };
export type IndependenceResult = { level: 'ok' | 'warn' | 'block'; hits: IndependenceHit[] };
/**
 * The lines of `next` that `previous` did not already have, against every OTHER character's lines. Same character is never compared.
 * Deterministic: only the normalised text and the thresholds above.
 */
export function checkIndependence(
  previous: unknown,
  next: unknown,
  others: readonly { characterId: string; template: unknown }[],
): IndependenceResult {
  const before = new Set(profileLines(previous).map((line) => normalizeLine(line.text)));
  const fresh = profileLines(next).filter((line) => {
    const key = normalizeLine(line.text);
    return [...key].length >= INDEPENDENCE_MIN_CHARS && !before.has(key);
  });
  const hits: IndependenceHit[] = [];
  for (const other of others) {
    const theirs = profileLines(other.template).filter(
      (line) => [...normalizeLine(line.text)].length >= INDEPENDENCE_MIN_CHARS,
    );
    for (const mine of fresh) {
      let best: { text: string; score: number } | null = null;
      for (const line of theirs) {
        const score = similarity(mine.text, line.text);
        if (score >= INDEPENDENCE_WARN && (!best || score > best.score)) best = { text: line.text, score };
      }
      if (best)
        hits.push({
          characterId: other.characterId,
          text: best.text,
          own: mine.text,
          score: Math.round(best.score * 100) / 100,
        });
    }
  }
  hits.sort((a, b) => b.score - a.score || (a.characterId < b.characterId ? -1 : 1));
  const level = hits.some((hit) => hit.score >= INDEPENDENCE_BLOCK) ? 'block' : hits.length ? 'warn' : 'ok';
  return { level, hits };
}
