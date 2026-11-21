import { PLAYER_MODEL_IDS, PLAYER_MODELS, isPlayerModelId, type PlayerModelId } from './player-models.ts';
import type { WriterLine } from './web-writer.ts';

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
/**
 * Part 37a-2: the built-in 开场 script starts from one of the character's welcome lines (with its 情境) and has 5 player follow-ups,
 * so it is the one script allowed below REHEARSAL_TURNS_MIN. A script of your own still needs 6.
 */
export const REHEARSAL_OPENING_TURNS = 5;
/** Part 37b: a 档案 situation script is four turns (one situation, a few lines), the second script allowed below REHEARSAL_TURNS_MIN. */
export const REHEARSAL_PROFILE_TURNS = 4;
export const rehearsalTurnsMin = (set?: string) =>
  set === 'opening'
    ? REHEARSAL_OPENING_TURNS
    : (REHEARSAL_PROFILE_SETS as readonly unknown[]).includes(set)
      ? REHEARSAL_PROFILE_TURNS
      : REHEARSAL_TURNS_MIN;
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

/**
 * Part 37a: a COLUMN is (model, writer): `deepseek` is DeepSeek·旧 (the v7 writer, the key every earlier run stored) and `deepseek-v8` is
 * DeepSeek·新 (the v8 writer). The `models` of an estimate, a start and a stored run are column keys. A rehearsal never reads the live
 * 回复写法 switch: it runs what its columns say.
 */
export const REHEARSAL_WRITER_LABELS: Readonly<Record<WriterLine, string>> = Object.freeze({ v7: '旧', v8: '新' });
/** Part 37b: the third column of a model, 新+档案 (the v8 writer plus the character's own 核心卡 and examples). Preview only for now. */
export const REHEARSAL_PROFILE_LABEL = '新+档案';
/** Part 37c-1: the fourth column, 新+档案+梗 (新+档案 plus the matched internet-meme meanings and the selected cast context). */
export const REHEARSAL_MEMES_LABEL = '新+档案+梗';
export const rehearsalColumnKey = (model: PlayerModelId, writer: WriterLine, profile = false, memes = false) =>
  writer === 'v8' ? `${model}-${memes ? 'v8m' : profile ? 'v8p' : 'v8'}` : model;
export function parseRehearsalColumn(
  key: unknown,
): { model: PlayerModelId; writer: WriterLine; profile: boolean; memes: boolean } | null {
  if (typeof key !== 'string') return null;
  const memes = key.endsWith('-v8m');
  // 新+档案+梗 is 新+档案 plus the memes: it carries the profile flag too.
  const profile = memes || key.endsWith('-v8p');
  const v8 = profile || key.endsWith('-v8');
  const model = profile ? key.slice(0, -4) : v8 ? key.slice(0, -3) : key;
  return isPlayerModelId(model) ? { model, writer: v8 ? 'v8' : 'v7', profile, memes } : null;
}
/** Every column the console can offer, in display order: each model's 旧, 新, 新+档案, then 新+档案+梗. */
export const REHEARSAL_COLUMN_KEYS: readonly string[] = PLAYER_MODEL_IDS.flatMap((model) => [
  rehearsalColumnKey(model, 'v7'),
  rehearsalColumnKey(model, 'v8'),
  rehearsalColumnKey(model, 'v8', true),
  rehearsalColumnKey(model, 'v8', true, true),
]);
export const rehearsalColumnLabel = (key: string) => {
  const column = parseRehearsalColumn(key);
  return column
    ? `${REHEARSAL_MODEL_LABELS[column.model]}·${column.memes ? REHEARSAL_MEMES_LABEL : column.profile ? REHEARSAL_PROFILE_LABEL : REHEARSAL_WRITER_LABELS[column.writer]}`
    : key;
};

/**
 * Part 37b: eight more built-in sets, one per 说话档案 situation (`profile-<tag>`), each a few player turns in a young, casual,
 * trend-aware voice. They run like any set, so the 37a-3 counts work on them.
 */
export const REHEARSAL_PROFILE_SETS = [
  'profile-daily',
  'profile-tease',
  'profile-complain',
  'profile-comfort',
  'profile-fight',
  'profile-share',
  'profile-inside',
  'profile-serious',
] as const;
export type RehearsalProfileSet = (typeof REHEARSAL_PROFILE_SETS)[number];
/**
 * Part 37c-1: four more built-in sets of players using 2022+ internet memes in casual chat (six turns each, so they need no exception
 * to the six-turn minimum). Every turn holds at least one entry of the shipped dictionary; a test holds that, and the run page shows
 * how many memes each column was given the meaning of.
 */
export const REHEARSAL_NET_SETS = ['net-daily', 'net-work', 'net-trip', 'net-feelings'] as const;
export type RehearsalNetSet = (typeof REHEARSAL_NET_SETS)[number];
export const REHEARSAL_SETS = ['chat', 'repeat', 'opening', ...REHEARSAL_PROFILE_SETS, ...REHEARSAL_NET_SETS] as const;
export type RehearsalSet = (typeof REHEARSAL_SETS)[number];
export const isProfileSet = (set: unknown): set is RehearsalProfileSet =>
  (REHEARSAL_PROFILE_SETS as readonly unknown[]).includes(set);
export const REHEARSAL_SET_LABELS: Readonly<Record<RehearsalSet | 'memes', string>> = Object.freeze({
  chat: '日常闲聊',
  repeat: '重复检测',
  opening: '开场',
  // (not 「日常闲聊」: the built-in 日常闲聊 script keeps that name to itself, so a rail button is found by it unambiguously)
  'profile-daily': '档案 · 日常',
  'profile-tease': '档案 · 调侃',
  'profile-complain': '档案 · 抱怨',
  'profile-comfort': '档案 · 安慰',
  'profile-fight': '档案 · 吵架',
  'profile-share': '档案 · 分享日常',
  'profile-inside': '档案 · 内部梗',
  'profile-serious': '档案 · 认真',
  'net-daily': '网络梗 · 日常',
  'net-work': '网络梗 · 职场',
  'net-trip': '网络梗 · 出游',
  'net-feelings': '网络梗 · 情绪',
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
  /** Column keys (see rehearsalColumnKey). */
  models: string[];
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
  /** The saved draft this run is frozen on; absent when there is none (then `liveVersion` says which published version runs). */
  draftRevision?: number;
  profileHash?: string;
  /** Part 31b: with no draft, the live published version (the run records it). */
  liveVersion?: number;
  source: RehearsalSource;
  /** Column keys (see rehearsalColumnKey). */
  models: string[];
  /** 带关系与故事. */
  withCast: boolean;
  /** Part 37a-3: also judge how each column talks (自己的事, 起话题, 情绪), one more judge call per column. Absent = no. */
  style?: boolean;
  acknowledgeMicros: number;
}

export type RehearsalCellState = 'pending' | 'running' | 'done' | 'failed' | 'unconfirmed' | 'skipped';
export interface RehearsalCell {
  state: RehearsalCellState;
  errorCode: string | null;
  bubbles: string[] | null;
  /** The reply covers the turn's message and defers nothing. null for a 新 column (it does not track that). */
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
  /** null for a 新 column: the v8 writer does not answer every message, so the count says nothing about it. */
  answeredAll: number | null;
  unaskedAdvice: number;
  endsWithQuestion: number;
  avgChars: number | null;
  avgBubbles: number | null;
  customerService: number;
  repeated: number;
  unconfirmed: number;
  failed: number;
  /** Part 40: the codes of the cells that did not produce a reply (failed, unconfirmed, not sent), each with how many cells carry it. */
  codes: Record<string, number>;
}
/**
 * Part 37a-3: what the judge read from the replies of one column, as counts of its replies. null = not judged. `state` says why:
 * `none` (this run did not ask for it), or where the one judge call of the column stands.
 */
export interface RehearsalStyle {
  state: 'none' | 'pending' | 'judged' | 'unconfirmed' | 'failed' | 'skipped';
  /** 说了自己的事: the reply shares its own life or opinion. */
  sharedOwn: number | null;
  /** 主动起话题: the reply starts or turns a topic. */
  startedTopic: number | null;
  /** 情绪起伏: emotion shows in the wording. */
  showedEmotion: number | null;
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
  /** Column keys. */
  models: string[];
  turns: number;
  withCast: boolean;
  status: 'running' | 'done' | 'failed';
  estimatedMicros: number;
  chargedMicros: number;
  /** Part 31b: the published version the run used when there was no draft; null for a run on a saved draft. */
  liveVersion: number | null;
}
/**
 * Part 37c-1 (a 新+档案+梗 column only): what the dictionary did in this run, by code from the script and the frozen settings, so it
 * is the same on every read: `matched` entries found in the player's messages (before the per-reply cap), `given` meanings that went
 * into a prompt (at most 3 a reply), and how many of those were 会用 / 只懂 / 不碰 for this character.
 */
export interface RehearsalMemeCounts {
  matched: number;
  given: number;
  use: number;
  know: number;
  avoid: number;
}
export interface RehearsalRunDetail {
  run: RehearsalRunInfo;
  reviewer: string;
  turns: RehearsalTurn[];
  columns: Array<{
    /** The column key: what `memes[].models` is keyed by. */
    key: string;
    model: PlayerModelId;
    writer: WriterLine;
    label: string;
    cells: RehearsalCell[];
    counts: RehearsalCounts;
    style: RehearsalStyle;
    /** null for a column that is not 新+档案+梗. */
    netMemes: RehearsalMemeCounts | null;
  }>;
  memes: RehearsalMemeRow[] | null;
}

export const isRehearsalModels = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length >= 1 &&
  value.length <= REHEARSAL_COLUMN_KEYS.length &&
  new Set(value).size === value.length &&
  value.every((key) => parseRehearsalColumn(key) !== null);

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
