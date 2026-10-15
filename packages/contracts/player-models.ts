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
export const POINTS_VERSION = 1;

export const POINTS = Object.freeze({
  version: POINTS_VERSION,
  /** What a signup is worth: SIGNUP_BONUS replies at `perBonusReply` points each. */
  signupBalance: 100,
  /** One reply of the old signup bonus, used to convert replies already spent into points (100 - 10 x spent). */
  perBonusReply: 10,
  /** Points per reply, by the model that writes it. */
  perReply: Object.freeze({ deepseek: 10, gemini: 20, xai: 40 }) as Readonly<Record<PlayerModelId, number>>,
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
}

export const PLAYER_MODELS: Readonly<Record<PlayerModelId, PlayerModelInfo>> = Object.freeze({
  deepseek: Object.freeze({
    id: 'deepseek',
    provider: 'deepseek',
    model: 'deepseek-flash',
    label: 'DeepSeek',
    blurb: '默认，自然稳妥，最省点',
  }),
  gemini: Object.freeze({
    id: 'gemini',
    provider: 'gemini',
    model: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    blurb: '反应快，语气灵动',
  }),
  xai: Object.freeze({
    id: 'xai',
    provider: 'xai',
    model: 'grok-4.7',
    label: 'Grok 4.7',
    blurb: '更敢说，表达更鲜明',
  }),
});

export const isPlayerModelId = (value: unknown): value is PlayerModelId =>
  typeof value === 'string' && (PLAYER_MODEL_IDS as readonly string[]).includes(value);

/** Points for one reply written by `model`, with voice when the reply includes it. */
export const replyPoints = (model: PlayerModelId, voice: boolean) =>
  POINTS.perReply[model] + (voice ? POINTS.voice : 0);

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
