/**
 * The models a player can pick to WRITE their replies (Part 21b), and what a reply costs in points.
 *
 * This file is the ONE place for the numbers and the Chinese labels; the server charges from it and the player page shows
 * from it. Points are player fairness only: they never touch the money ledger (budget reservation is separate). The prices
 * are versioned so a later recalibration (after staging, see `pnpm usage:report`) is a new version, not a silent edit.
 *
 * Nothing here reaches a prompt: the chosen model is routing data and is never put into any message sent to a model.
 */
export const PLAYER_MODEL_IDS = ['deepseek', 'gemini', 'xai'] as const;
export type PlayerModelId = (typeof PLAYER_MODEL_IDS)[number];
export const DEFAULT_PLAYER_MODEL: PlayerModelId = 'deepseek';

/** Bump when any number below changes. Stored on every points event so an old charge stays explainable. */
export const POINTS_VERSION = 2;

export const POINTS = Object.freeze({
  version: POINTS_VERSION,
  /** What a signup is worth: SIGNUP_BONUS replies at `perBonusReply` points each. */
  signupBalance: 100,
  /** One reply of the old signup bonus, used to convert replies already spent into points (100 - 10 x spent). */
  perBonusReply: 10,
  /** Points per reply, by the model that writes it. */
  perReply: Object.freeze({ deepseek: 10, gemini: 20, xai: 25 }) as Readonly<Record<PlayerModelId, number>>,
  /** Added when the reply includes voice. */
  voice: 2,
});

export interface PlayerModelInfo {
  readonly id: PlayerModelId;
  readonly provider: 'deepseek' | 'gemini' | 'xai';
  /** The provider's model id, exactly as sent on the wire. Server-side routing data. */
  readonly model: string;
  /** Shown name. */
  readonly label: string;
  /** One short line of character. */
  readonly blurb: string;
  /** Speed hint shown in the picker (measured on staging, see docs/PROVIDERS.md). */
  readonly speed: string;
}

export const PLAYER_MODELS: Readonly<Record<PlayerModelId, PlayerModelInfo>> = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek',
    blurb: '默认，自然稳妥，最省点',
    speed: '较快',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    blurb: '反应快，语气灵动',
    speed: '较快',
  }),
  xai: Object.freeze({
    id: 'xai',
    provider: 'xai',
    model: 'grok-4.7',
    label: 'Grok 4.7',
    blurb: '更敢说，表达更鲜明',
    speed: '较慢，约20秒',
  }),
});

export const isPlayerModelId = (value: unknown): value is PlayerModelId =>
  typeof value === 'string' && (PLAYER_MODEL_IDS as readonly string[]).includes(value);

/** Points for one reply written by `model`, with voice when the reply includes it. */
export const replyPoints = (model: PlayerModelId, voice: boolean) =>
  POINTS.perReply[model] + (voice ? POINTS.voice : 0);

/**
 * The model a reply is BILLED as when `actual` wrote what `chosen` was asked for: the cheaper of the two (a backup that costs
 * more than the chosen model never raises the price). Same rule as the server's settlement.
 */
export const billedModel = (chosen: PlayerModelId, actual: PlayerModelId): PlayerModelId =>
  POINTS.perReply[actual] <= POINTS.perReply[chosen] ? actual : chosen;

/** The "about N messages" figure: whole replies the balance still pays for with this model (voice included). */
export const repliesLeft = (balance: number, model: PlayerModelId, voice = true) =>
  Math.max(0, Math.floor(balance / replyPoints(model, voice)));

/**
 * PLAYER_TEXT_MODELS: a comma separated subset of PLAYER_MODEL_IDS. DeepSeek is the default and the universal fallback, so it
 * is always on; an unset or empty value means every model is offered only when the feature flag is on.
 */
export function parsePlayerTextModels(value: unknown): readonly PlayerModelId[] {
  if (value === undefined || value === null || value === '') return PLAYER_MODEL_IDS;
  if (typeof value !== 'string') return ['deepseek'];
  const listed = new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
  return PLAYER_MODEL_IDS.filter((id) => id === 'deepseek' || listed.has(id));
}

/** What GET /account tells a points holder about the picker (the server's `modelChoiceState`). */
export interface ModelChoiceInfo {
  models: { id: PlayerModelId; points: number; voicePoints: number }[];
  selected: PlayerModelId;
  /** False for an invited player: no points are charged, the page shows no prices or balance. */
  metered: boolean;
  balance: number;
  repliesLeft: number;
  version: number;
  /** Part 22a: the invite entitlement the player holds, if any (an unlimited one is never charged; a refill adds N a day up to the cap). */
  plan?: PlayerPlan;
  notice?: 'model_withdrawn';
}
export interface PlayerPlan {
  kind: 'unlimited' | 'daily_refill';
  dailyAmount?: number;
  cap?: number;
  /** UTC milliseconds, or null for no expiry. */
  expiresAt: number | null;
}
function parsePlan(value: unknown): PlayerPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000_000;
  const expiresAt = raw.expiresAt === null ? null : Number.isSafeInteger(raw.expiresAt) ? (raw.expiresAt as number) : undefined;
  if (expiresAt === undefined) return undefined;
  if (raw.kind === 'unlimited') return { kind: 'unlimited', expiresAt };
  if (raw.kind === 'daily_refill' && count(raw.dailyAmount) && count(raw.cap))
    return { kind: 'daily_refill', dailyAmount: raw.dailyAmount, cap: raw.cap, expiresAt };
  return undefined;
}
/** Strict parse of the server's state: anything unexpected yields undefined and the page simply shows no picker. */
export function parseModelChoice(value: unknown): ModelChoiceInfo | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const count = (n: unknown): n is number =>
    Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1_000_000;
  if (!Array.isArray(raw.models) || !isPlayerModelId(raw.selected) || !count(raw.balance) || !count(raw.repliesLeft))
    return undefined;
  const models: ModelChoiceInfo['models'] = [];
  for (const item of raw.models) {
    const entry = item as Record<string, unknown> | null;
    if (!entry || !isPlayerModelId(entry.id) || !count(entry.points) || !count(entry.voicePoints)) return undefined;
    models.push({ id: entry.id, points: entry.points, voicePoints: entry.voicePoints });
  }
  if (models.length === 0 || !models.some((entry) => entry.id === raw.selected)) return undefined;
  return {
    models,
    selected: raw.selected,
    metered: raw.metered !== false,
    balance: raw.balance,
    repliesLeft: raw.repliesLeft,
    version: typeof raw.version === 'number' ? raw.version : POINTS_VERSION,
    ...(parsePlan(raw.plan) ? { plan: parsePlan(raw.plan)! } : {}),
    ...(raw.notice === 'model_withdrawn' ? { notice: 'model_withdrawn' as const } : {}),
  };
}
