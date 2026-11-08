import { randomInt } from 'node:crypto';
import { pickWelcome, type WelcomeLine } from '../../../packages/contracts/web-welcomes.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { webWelcomeLines } from './web-character-catalog.ts';
import { webWelcomeLinesInstalled } from './web-welcome-schema.ts';

/**
 * Part 24k-2: which of a character's welcome lines a player gets.
 *
 * One line per (world, character), chosen by weight the first time the player meets the character's welcome (the home card's
 * play pill or the chat, whichever comes first - both read the catalog, so the first catalog read is the meeting). The choice is
 * stored and stays fixed, so the pill, the chat's opening bubble and the memory (26a) always agree.
 *
 * The draw is a crypto-random integer; nothing a player controls feeds it. Only the business object calls this (inside its own
 * transaction).
 */
export type WelcomeChoice = { lineId: string; text: string };

/** 0 <= unit < 1 from the crypto source (2^32 steps are far finer than a whole-percent weight). */
export const cryptoUnit = () => randomInt(0, 2 ** 32) / 2 ** 32;

/** Whether a chat of this world with this character already exists (then it has an opening bubble and its history is kept). */
const chatExists = (store: Pick<BusinessStore, 'get'>, worldId: string, characterId: string) =>
  !!store.get(
    "SELECT 1 FROM conversations WHERE world_id=? AND kind='private' AND private_character_id=? LIMIT 1",
    worldId,
    characterId,
  );

/**
 * The line this player has for this character, drawing and storing one on the first meeting.
 * - the stored line is still published (same id, same text): it is returned unchanged;
 * - it is gone from the published version: a player with no chat gets a new draw; a player whose chat exists keeps it.
 * Without the table (a store that never installed it) the first line is returned and nothing is stored.
 */
export function chooseWelcome(
  store: BusinessStore,
  input: { worldId: string; characterId: string; version: number; lines: readonly WelcomeLine[]; now: number },
  unit: () => number = cryptoUnit,
): WelcomeChoice {
  const first = input.lines[0]!;
  if (!webWelcomeLinesInstalled(store)) return { lineId: first.id, text: first.text };
  const row = store.get<{ line_id: string; body: string }>(
    'SELECT line_id,body FROM web_welcome_choices WHERE world_id=? AND character_id=?',
    input.worldId,
    input.characterId,
  );
  if (row) {
    const still = input.lines.find((line) => line.id === row.line_id && line.text === row.body);
    if (still) return { lineId: still.id, text: still.text };
    if (chatExists(store, input.worldId, input.characterId)) return { lineId: row.line_id, text: row.body };
  }
  const picked = input.lines.length === 1 ? input.lines[0]! : pickWelcome(input.lines, unit());
  store.run(
    `INSERT INTO web_welcome_choices(world_id,character_id,line_id,body,version,chosen_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(world_id,character_id) DO UPDATE SET line_id=excluded.line_id,body=excluded.body,
    version=excluded.version,chosen_at=excluded.chosen_at`,
    input.worldId,
    input.characterId,
    picked.id,
    picked.text,
    input.version,
    input.now,
  );
  return { lineId: picked.id, text: picked.text };
}

/** The stored line only (never draws): what the memory and the frozen request use. */
export function storedWelcome(
  store: Pick<BusinessStore, 'get'>,
  worldId: string,
  characterId: string,
): WelcomeChoice | null {
  if (!webWelcomeLinesInstalled(store)) return null;
  const row = store.get<{ line_id: string; body: string }>(
    'SELECT line_id,body FROM web_welcome_choices WHERE world_id=? AND character_id=?',
    worldId,
    characterId,
  );
  return row ? { lineId: row.line_id, text: row.body } : null;
}

/** Retention: a player's choices go with the player (world), a character's with the character (every world). */
export function purgeWelcomeChoices(
  store: Pick<BusinessStore, 'get' | 'run'>,
  scope: { worldId: string } | { characterId: string },
) {
  if (!webWelcomeLinesInstalled(store)) return;
  if ('worldId' in scope) store.run('DELETE FROM web_welcome_choices WHERE world_id=?', scope.worldId);
  else store.run('DELETE FROM web_welcome_choices WHERE character_id=?', scope.characterId);
}

export type WelcomeClip = { mediaId: string; sha256: string; durationMs: number };
/**
 * The clip of ONE line: the line table's row of the character's CURRENT approved bundle, or (a one-line profile, and every clip
 * made before Part 24k-2) the single welcome clip of that bundle whose text is the line's exact text. `kept` is for a line a
 * player keeps after a later version dropped it: its clip may be in any earlier bundle.
 */
export function welcomeClipFor(
  store: Pick<BusinessStore, 'get'>,
  characterId: string,
  line: { lineId: string; text: string },
  kept = false,
): WelcomeClip | null {
  const bound = `v.character_id=? AND v.approved=1 AND v.source='user_selected'`;
  if (webWelcomeLinesInstalled(store)) {
    const row = store.get<{ media_id: string; sha256: string; duration_ms: number }>(
      `SELECT l.media_id,l.sha256,l.duration_ms FROM web_provider_welcome_lines l
      JOIN web_provider_voice_bindings v ON v.character_id=l.character_id ${kept ? '' : 'AND v.voice_version=l.voice_version'}
      WHERE ${bound} AND l.line_id=? AND l.body=? ORDER BY l.created_at DESC LIMIT 1`,
      characterId,
      line.lineId,
      line.text,
    );
    if (row) return { mediaId: row.media_id, sha256: row.sha256, durationMs: row.duration_ms };
  }
  const old = store.get<{ media_id: string; sha256: string; duration_ms: number }>(
    `SELECT w.media_id,w.sha256,w.duration_ms FROM web_provider_welcome_assets w
    JOIN web_provider_voice_bindings v ON v.character_id=w.character_id ${kept ? '' : 'AND v.voice_version=w.voice_version'}
    WHERE ${bound} AND w.body=? ORDER BY w.created_at DESC LIMIT 1`,
    characterId,
    line.text,
  );
  return old ? { mediaId: old.media_id, sha256: old.sha256, durationMs: old.duration_ms } : null;
}

/**
 * May the public route play a clip of this text? Only while the character is on the home page, and only for the text of a
 * published line - or of a line some player still keeps (their chat already shows it) after a later version dropped it.
 */
export function welcomeServable(store: BusinessStore, characterId: string, body: string) {
  const lines = webWelcomeLines(store, characterId);
  if (!lines) return false;
  if (lines.some((line) => line.text === body)) return true;
  return (
    webWelcomeLinesInstalled(store) &&
    !!store.get('SELECT 1 FROM web_welcome_choices WHERE character_id=? AND body=? LIMIT 1', characterId, body)
  );
}

/**
 * A clip of the character's CURRENT approved bundle plays when its text is servable (above). A clip of an earlier bundle plays
 * only when no published line has that text any more and some player still keeps it: it is that player's chat history.
 */
export function welcomeClipServable(
  store: BusinessStore,
  row: { character_id: string; voice_version: string; body: string },
  currentVersion: string,
) {
  if (row.voice_version === currentVersion) return welcomeServable(store, row.character_id, row.body);
  const lines = webWelcomeLines(store, row.character_id);
  return (
    !!lines &&
    !lines.some((line) => line.text === row.body) &&
    webWelcomeLinesInstalled(store) &&
    !!store.get('SELECT 1 FROM web_welcome_choices WHERE character_id=? AND body=? LIMIT 1', row.character_id, row.body)
  );
}
