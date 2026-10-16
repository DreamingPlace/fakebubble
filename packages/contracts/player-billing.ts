import { isPlayerModelId, type PlayerModelId } from './player-models.ts';

/**
 * 消费记录 (Part 21f): what POST /billing/history answers. Points only; no ids of players or operations, no money.
 * `points` of a reply is the NET spent (after a cheaper-backup or no-voice refund), positive; 0 and `free` for a reply
 * that is not charged (an invited player). The page shows it as a minus.
 */
export type BillingItem =
  | {
      kind: 'reply';
      at: number;
      characterId: string;
      /** The model that actually wrote the reply. */
      model: PlayerModelId;
      /** Set when a backup wrote it: the model the player had chosen. */
      backupFor?: PlayerModelId;
      voice: boolean;
      /** Net points spent on this reply (after any backup / no-voice refund); 0 and `free` for an invited player. */
      points: number;
      free: boolean;
    }
  | { kind: 'pending'; at: number; characterId: string; model: PlayerModelId; points: number; free: boolean }
  | { kind: 'failed'; at: number; characterId: string; refunded: number; free: boolean }
  | { kind: 'bonus' | 'grant' | 'daily_refill' | 'reset'; at: number; points: number };

export interface BillingPage {
  /** False for an invited player: nothing is charged, there is no balance. */
  metered: boolean;
  balance: number | null;
  month: {
    byModel: { model: PlayerModelId; points: number; replies: number }[];
    byCharacter: { characterId: string; points: number; replies: number }[];
  };
  items: BillingItem[];
  page: number;
  hasMore: boolean;
}

const count = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 10_000_000;
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 128;
const time = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

/** Strict parse of the server's page: anything unexpected yields undefined and the page says it could not load. */
export function parseBillingPage(value: unknown): BillingPage | undefined {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const month = v.month as { byModel?: unknown; byCharacter?: unknown } | null;
  if (
    typeof v.metered !== 'boolean' ||
    !(v.balance === null || count(v.balance)) ||
    !Number.isSafeInteger(v.page) ||
    typeof v.hasMore !== 'boolean' ||
    !Array.isArray(v.items) ||
    !month ||
    !Array.isArray(month.byModel) ||
    !Array.isArray(month.byCharacter)
  )
    return undefined;
  const byModel: BillingPage['month']['byModel'] = [];
  for (const raw of month.byModel as Record<string, unknown>[]) {
    if (!raw || !isPlayerModelId(raw.model) || !count(raw.points) || !count(raw.replies)) return undefined;
    byModel.push({ model: raw.model, points: raw.points, replies: raw.replies });
  }
  const byCharacter: BillingPage['month']['byCharacter'] = [];
  for (const raw of month.byCharacter as Record<string, unknown>[]) {
    if (!raw || !text(raw.characterId) || !count(raw.points) || !count(raw.replies)) return undefined;
    byCharacter.push({ characterId: raw.characterId, points: raw.points, replies: raw.replies });
  }
  const items: BillingItem[] = [];
  for (const raw of v.items as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object' || !time(raw.at)) return undefined;
    const at = raw.at;
    if (raw.kind === 'reply') {
      if (
        !text(raw.characterId) ||
        !isPlayerModelId(raw.model) ||
        typeof raw.voice !== 'boolean' ||
        typeof raw.free !== 'boolean' ||
        !Number.isSafeInteger(raw.points) ||
        !(raw.backupFor === undefined || isPlayerModelId(raw.backupFor))
      )
        return undefined;
      items.push({
        kind: 'reply',
        at,
        characterId: raw.characterId,
        model: raw.model,
        ...(raw.backupFor ? { backupFor: raw.backupFor as PlayerModelId } : {}),
        voice: raw.voice,
        points: raw.points as number,
        free: raw.free,
      });
    } else if (raw.kind === 'pending') {
      if (
        !text(raw.characterId) ||
        !isPlayerModelId(raw.model) ||
        typeof raw.free !== 'boolean' ||
        !Number.isSafeInteger(raw.points)
      )
        return undefined;
      items.push({
        kind: 'pending',
        at,
        characterId: raw.characterId,
        model: raw.model,
        points: raw.points as number,
        free: raw.free,
      });
    } else if (raw.kind === 'failed') {
      if (!text(raw.characterId) || !count(raw.refunded) || typeof raw.free !== 'boolean') return undefined;
      items.push({ kind: 'failed', at, characterId: raw.characterId, refunded: raw.refunded, free: raw.free });
    } else if (raw.kind === 'bonus' || raw.kind === 'grant' || raw.kind === 'daily_refill' || raw.kind === 'reset') {
      if (!Number.isSafeInteger(raw.points)) return undefined;
      items.push({ kind: raw.kind, at, points: raw.points as number });
    } else return undefined;
  }
  return {
    metered: v.metered,
    balance: v.balance as number | null,
    month: { byModel, byCharacter },
    items,
    page: v.page as number,
    hasMore: v.hasMore,
  };
}
