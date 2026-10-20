import { randomBytes } from 'node:crypto';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * 玩家编号 (Part 22a, migration 125): a short random code per registered player - 8 characters of Crockford base32 (no I, L, O,
 * U), unique, never sequential and never derived from an id, email or invite. It is what an administrator sees instead of a
 * player, and what the player can read out to us. Distinct from the chat-review code (web_review_codes). Assigned at signup;
 * migration 125 backfilled every existing registered player, and `ensurePlayerNumber` assigns any that is still missing.
 */
export const PLAYER_NUMBER_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PLAYER_NUMBER_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

type Writer = Pick<BusinessStore, 'get' | 'run'>;
const tableExists = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_player_numbers'");

/** 8 uniform characters: 256 is a multiple of 32, so a byte maps without bias. */
export function newPlayerNumber(random: (size: number) => Buffer = randomBytes) {
  const bytes = random(8);
  let out = '';
  for (let i = 0; i < 8; i++) out += PLAYER_NUMBER_ALPHABET[bytes[i]! % 32];
  return out;
}

/** The player's number, assigning one on first call. Null on a database without migration 125. Call inside a transaction. */
export function ensurePlayerNumber(
  store: Writer,
  now: number,
  principalId: string,
  random: (size: number) => Buffer = randomBytes,
): string | null {
  if (!tableExists(store)) return null;
  const held = store.get<{ number: string }>('SELECT number FROM web_player_numbers WHERE principal_id=?', principalId);
  if (held) return held.number;
  // A collision (one in 10^12 per pair) is simply drawn again.
  for (let attempt = 0; attempt < 8; attempt++) {
    const number = newPlayerNumber(random);
    if (
      store.run(
        'INSERT OR IGNORE INTO web_player_numbers(principal_id,number,created_at) VALUES (?,?,?)',
        principalId,
        number,
        now,
      ).changes === 1
    )
      return number;
  }
  throw new Error('WEB_PLAYER_NUMBER_UNAVAILABLE');
}

export function playerNumberOf(store: Pick<BusinessStore, 'get'>, principalId: string): string | null {
  if (!tableExists(store)) return null;
  return (
    store.get<{ number: string }>('SELECT number FROM web_player_numbers WHERE principal_id=?', principalId)?.number ??
    null
  );
}
