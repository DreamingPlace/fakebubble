import type { BusinessStore } from '../platform/store-contract.ts';
import { effectiveTier } from './web-model-settings.ts';

/**
 * Part 26a (flag GUEST_ONE_CHARACTER_ENABLED, default off): an unregistered guest chats with one character.
 *
 * Who is locked: a principal of kind 'guest' that is not registered (isRegistered false) and holds no unlimited / daily_refill
 * entitlement - exactly `effectiveTier(...).tier === 'guest'`. Registered players, holders and accounts are never locked.
 *
 * What it is locked to: every character it already has a message with. The set is DERIVED from the messages, never from a
 * counter, so a guest that chatted with several characters before the flag was switched on keeps all of them, and a guest
 * that has none yet may still pick any. "Clear this device" creates a new guest, which has no messages, so it starts fresh.
 */
type Reader = Pick<BusinessStore, 'get' | 'all'> & { guestOneCharacter?: boolean; publicFreeTier?: boolean };

export const guestLockApplies = (store: Reader, principalId: string, now: number) =>
  store.guestOneCharacter === true &&
  (effectiveTier(store as Parameters<typeof effectiveTier>[0], principalId, now)?.tier ?? null) === 'guest';

/** The characters this guest already has a message with (in first-contact order). */
export function guestCharacterIds(store: Reader, principalId: string): string[] {
  return store
    .all<{ character_id: string }>(
      `SELECT c.private_character_id character_id FROM web_principals p
      JOIN conversations c ON c.world_id=p.world_id AND c.kind='private'
      JOIN messages m ON m.world_id=c.world_id AND m.conversation_id=c.id AND m.author_kind='player'
      WHERE p.id=? AND c.private_character_id IS NOT NULL
      GROUP BY c.private_character_id ORDER BY min(m.seq)`,
      principalId,
    )
    .map((row) => row.character_id);
}

/** null when the lock does not apply to this principal; otherwise the characters it may chat with ([] = any, none chosen yet). */
export function lockedCharacterIds(store: Reader, principalId: string, now: number): string[] | null {
  return guestLockApplies(store, principalId, now) ? guestCharacterIds(store, principalId) : null;
}
