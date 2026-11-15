import { WEB_PROVIDER_WELCOME } from '../../../config/web-v1.ts';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { upgradeWelcomes } from '../../../packages/contracts/web-welcomes.ts';
import { storedWelcome } from '../characters/web-welcome-choice.ts';

/**
 * Part 26a. The character's welcome line of the PUBLISHED revision the request's template was frozen from (never the current
 * draft, never a later publication), as the request's `opening`. Nothing when it cannot be resolved or is empty.
 * The line is presentation text of the character: it is never stored as a player fact or a memory.
 */
/**
 * Part 37a-2: how long the 情境 note of the opening welcome stays in a v8 chat: while the player has sent at most this many messages.
 * The opening itself stays while the whole chat fits the history window (24 messages); the note is only about the first moments.
 */
export const OPENING_NOTE_PLAYER_MESSAGES = 6;
/** The opening of a request: the note only for the v8 writer and only while the chat is young; v7 never carries it. */
export function openingForWriter(
  opening: NonNullable<TextGenerationRequest['opening']>,
  v8: boolean,
  playerMessages: number,
): NonNullable<TextGenerationRequest['opening']> {
  const { context, ...bare } = opening;
  return v8 && context !== undefined && playerMessages <= OPENING_NOTE_PLAYER_MESSAGES ? { ...bare, context } : bare;
}

export function openingFrom(text: unknown, context?: unknown): TextGenerationRequest['opening'] | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return undefined;
  // Part 37a-2: the 情境 note rides along when the line has one; the key is absent otherwise (a line without a note is what it was).
  return typeof context === 'string' && context.trim().length > 0 ? { text, context: context.trim() } : { text };
}

/** The note of the line `lineId` with exactly this text in a stored profile (a line whose words changed has no note here). */
function noteOf(profileJson: string, lineId: string | null, text: string): string | undefined {
  try {
    const presentation = (JSON.parse(profileJson) as { presentation?: { welcome?: unknown; welcomes?: unknown } })
      .presentation;
    const lines = presentation ? upgradeWelcomes(presentation) : [];
    return lines.find((line) => (lineId === null || line.id === lineId) && line.text === text)?.context;
  } catch {
    return undefined;
  }
}

/**
 * Part 24k-2: with several welcome lines the opening is the line THIS player was given (stored on the first meeting, the same
 * line the play pill and the chat's bubble show); a player with no stored line, and a character with one line, get the frozen
 * revision's first line.
 */
export function frozenOpening(
  store: Pick<BusinessStore, 'get'>,
  characterId: string,
  templateVersion: number,
  worldId?: string,
) {
  const mine = worldId ? storedWelcome(store, worldId, characterId) : null;
  if (mine) {
    const row = store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_versions'")
      ? store.get<{ profile_json: string }>(
          'SELECT profile_json FROM web_character_versions WHERE character_id=? AND version=?',
          characterId,
          templateVersion,
        )
      : undefined;
    return openingFrom(mine.text, row ? noteOf(row.profile_json, mine.lineId, mine.text) : undefined);
  }
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_character_versions'")) {
    const seed = Object.hasOwn(WEB_PROVIDER_WELCOME, characterId)
      ? WEB_PROVIDER_WELCOME[characterId as keyof typeof WEB_PROVIDER_WELCOME]
      : undefined;
    return openingFrom(seed?.text);
  }
  const row = store.get<{ profile_json: string }>(
    'SELECT profile_json FROM web_character_versions WHERE character_id=? AND version=?',
    characterId,
    templateVersion,
  );
  if (!row) return undefined;
  try {
    const presentation = (JSON.parse(row.profile_json) as { presentation?: { welcome?: unknown; welcomes?: unknown } })
      .presentation;
    const first = presentation ? upgradeWelcomes(presentation)[0] : undefined;
    return openingFrom(first?.text, first?.context);
  } catch {
    return undefined;
  }
}
