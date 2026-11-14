import { PLAYER_MODEL_IDS, PLAYER_MODELS, isPlayerModelId, type PlayerModelId } from './player-models.ts';

/**
 * Part 35: 多轮预演. A run is a SCRIPT, an ordered list of player turns (6-20) against ONE character, run on one or more draft
 * models side by side. Everything here is admin-only synthetic data: no player id, no content of a player.
 *
 * One player message per turn: the reply pipeline answers exactly one input message per operation
 * (`requiredMessageIds` is one id, checked at dispatch in web-v7-request.ts), and Part 36 owns changing that. So there is no
 * 连发 set and a turn is one message.
 */
export const REHEARSAL_TURNS_MIN = 6;
export const REHEARSAL_TURNS_MAX = 20;
/** Longest player message of a turn, in characters. */
export const REHEARSAL_TURN_CHARS = 200;
export const REHEARSAL_NAME_CHARS = 30;
export const REHEARSAL_SCRIPTS_MAX = 40;
export const REHEARSAL_PHRASES_MAX = 30;
export const REHEARSAL_PHRASE_CHARS = 20;
/** A 梗与故事 run takes at most this many memes / stories: each makes three turns (two hints, one look-alike). */
export const REHEARSAL_ITEMS_MAX = 6;
export const REHEARSAL_MODEL_IDS: readonly PlayerModelId[] = PLAYER_MODEL_IDS;
export const REHEARSAL_MODEL_LABELS: Readonly<Record<PlayerModelId, string>> = Object.freeze({
  deepseek: PLAYER_MODELS.deepseek.label,
  gemini: PLAYER_MODELS.gemini.label,
  xai: PLAYER_MODELS.xai.label,
});

export const REHEARSAL_SETS = ['chat', 'repeat'] as const;
export type RehearsalSet = (typeof REHEARSAL_SETS)[number];
export const REHEARSAL_SET_LABELS: Readonly<Record<RehearsalSet | 'memes', string>> = Object.freeze({
  chat: '日常闲聊',
  repeat: '重复检测',
  memes: '梗与故事',
});

/** What a run plays: a saved script, a built-in set, or the memes / stories of the character's cast file. */
export type RehearsalSource =
  | { kind: 'script'; scriptId: string }
  | { kind: 'set'; set: RehearsalSet }
  | { kind: 'memes'; items: string[] };

export interface RehearsalScriptView {
  id: string;
  name: string;
  turns: string[];
  updatedAt: number;
}
export interface RehearsalPhrases {
  /** 客服腔. */
  customerService: string[];
  /** 没问就给的建议 (注意休息 / 早点睡 / 多喝水 ...). */
  advice: string[];
}
export interface RehearsalSetView {
  set: RehearsalSet;
  label: string;
  turns: string[];
}
export interface RehearsalLibrary {
  scripts: RehearsalScriptView[];
  sets: RehearsalSetView[];
  phrases: RehearsalPhrases;
  defaultPhrases: RehearsalPhrases;
  models: RehearsalModelView[];
}
export interface RehearsalModelView {
  id: PlayerModelId;
  label: string;
  /** False: no key, no price or no capacity in this environment. */
  available: boolean;
}
export interface RehearsalItem {
  key: string;
  kind: 'meme' | 'story';
  label: string;
}
export interface RehearsalItems {
  /** False: there is no cast file draft that has this character. */
  available: boolean;
  items: RehearsalItem[];
}

export interface RehearsalEstimate {
  models: PlayerModelId[];
  turns: number;
  /** Draft + review calls of every model and turn. */
  replyCalls: number;
  /** Hint writing and judging, on the house reviewer. */
  judgeCalls: number;
  calls: number;
  /** The one total the administrator confirms, in micro-USD. */
  totalMicros: number;
}
export interface RehearsalStartInput {
  requestId: string;
  characterId: string;
  draftRevision: number;
  profileHash: string;
  source: RehearsalSource;
  models: PlayerModelId[];
  /** 带关系与故事. */
  withCast: boolean;
  acknowledgeMicros: number;
}

export type RehearsalCellState = 'pending' | 'running' | 'done' | 'failed' | 'unconfirmed' | 'skipped';
export interface RehearsalCell {
  state: RehearsalCellState;
  errorCode: string | null;
  bubbles: string[] | null;
  /** The reply covers the turn's message and defers nothing. */
  answered: boolean | null;
}
export interface RehearsalTurn {
  text: string;
  /** 梗与故事 only. */
  role: 'hint' | 'negative' | null;
  item: string | null;
}
export interface RehearsalCounts {
  replies: number;
  answeredAll: number;
  unaskedAdvice: number;
  endsWithQuestion: number;
  avgChars: number | null;
  avgBubbles: number | null;
  customerService: number;
  repeated: number;
  unconfirmed: number;
  failed: number;
}
export interface RehearsalMemeCell {
  /** One per hint phrasing: did the reply recognise it. null = not judged. */
  hints: Array<boolean | null>;
  /** The look-alike drew the meme out although it is not about it. */
  falseTrigger: boolean | null;
  /** The character spoke from its own side of the story. */
  ownSide: boolean | null;
  state: 'judged' | 'pending' | 'unconfirmed' | 'failed' | 'skipped';
}
export interface RehearsalMemeRow {
  label: string;
  kind: 'meme' | 'story';
  /** false: the hint phrasings could not be written (the item was left out). */
  played: boolean;
  /** Part 31b: the two hint phrasings the judge wrote and the look-alike sentence, so the owner can see which one missed. null = not written. */
  hints: [string | null, string | null];
  lookAlike: string | null;
  models: Record<string, RehearsalMemeCell>;
}
export interface RehearsalRunInfo {
  runId: string;
  createdAt: number;
  scriptName: string;
  models: PlayerModelId[];
  turns: number;
  withCast: boolean;
  status: 'running' | 'done' | 'failed';
  estimatedMicros: number;
  chargedMicros: number;
}
export interface RehearsalRunDetail {
  run: RehearsalRunInfo;
  reviewer: string;
  turns: RehearsalTurn[];
  columns: Array<{
    model: PlayerModelId;
    label: string;
    cells: RehearsalCell[];
    counts: RehearsalCounts;
  }>;
  memes: RehearsalMemeRow[] | null;
}

export const isRehearsalModels = (value: unknown): value is PlayerModelId[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= PLAYER_MODEL_IDS.length &&
  new Set(value).size === value.length &&
  value.every(isPlayerModelId);

/** Characters of a message: code points, so a face does not count twice. */
export const charLength = (text: string) => [...text].length;
export function checkTurns(turns: unknown): turns is string[] {
  return (
    Array.isArray(turns) &&
    turns.length >= REHEARSAL_TURNS_MIN &&
    turns.length <= REHEARSAL_TURNS_MAX &&
    turns.every((t) => typeof t === 'string' && t.trim().length > 0 && charLength(t) <= REHEARSAL_TURN_CHARS)
  );
}
