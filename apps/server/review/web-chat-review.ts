import { ensure } from '../../../packages/domain/errors.ts';
import { localTime } from '../../../packages/domain/schedule.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

/**
 * Tester chat review (Part 19, flag CHAT_REVIEW_ENABLED; tables from 122_chat_review.sql).
 *
 * The owner reads whole transcripts to tune the characters' tone without being able to tell which account one belongs to:
 *   - a transcript is labelled "<character label>-<code>"; the 4-character code is drawn at random per principal and is the
 *     same across that player's characters (never derived from an id, email, IP or invite);
 *   - the player's nicknames (current and past) are replaced by 〔昵称〕 in everything that leaves this module;
 *   - when a player's chats are removed, the transcript is first copied - in the transaction that starts the purge - into an
 *     archive that holds no identity at all and that the sweep deletes 180 days later.
 * This module only reads player data (and assigns a missing code); nothing in it reaches a prompt or a provider.
 */

type Db = Pick<BusinessStore, 'get' | 'all' | 'run'>;
type Reader = Pick<BusinessStore, 'get' | 'all'>;

export const REVIEW_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const REVIEW_CODE_LENGTH = 4;
export const ARCHIVE_TTL_MS = 180 * 24 * 60 * 60_000;
export const NICKNAME_PLACEHOLDER = '〔昵称〕';
const ARCHIVE_SWEEP_BATCH = 200;

const tableExists = (store: Pick<BusinessStore, 'get'>, name: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", name);
/** The tables of 122_chat_review.sql: an older database has no chat review. */
export const chatReviewTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  tableExists(store, 'web_review_codes') && tableExists(store, 'web_review_archive');

// ---- codes ----------------------------------------------------------------------------------------------------------

/** One random code character, uniform over the alphabet (rejection sampling: 248 = 8 x 31). */
function randomCodeChar() {
  const buffer = new Uint8Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buffer);
    if (buffer[0]! < 248) return REVIEW_ALPHABET[buffer[0]! % REVIEW_ALPHABET.length]!;
  }
}
const newCode = () => Array.from({ length: REVIEW_CODE_LENGTH }, randomCodeChar).join('');

/** True while a live code row or an archive row still carries this code. */
const codeTaken = (store: Reader, code: string) =>
  !!store.get('SELECT 1 FROM web_review_codes WHERE code=?', code) ||
  !!store.get('SELECT 1 FROM web_review_archive WHERE review_code=? LIMIT 1', code);

/**
 * The principal's code, assigned on first use. Unique against live codes AND against codes still present in the archive;
 * a collision draws again. Call inside the caller's transaction.
 */
export function reviewCodeFor(store: Db, principalId: string, now: number, draw: () => string = newCode) {
  const existing = store.get<{ code: string }>('SELECT code FROM web_review_codes WHERE principal_id=?', principalId);
  if (existing) return existing.code;
  for (let attempt = 0; attempt < 64; attempt++) {
    const code = draw();
    ensure(
      code.length === REVIEW_CODE_LENGTH && [...code].every((c) => REVIEW_ALPHABET.includes(c)),
      'REVIEW_CODE_INVALID',
    );
    if (codeTaken(store, code)) continue;
    store.run('INSERT INTO web_review_codes(principal_id,code,assigned_at) VALUES (?,?,?)', principalId, code, now);
    return code;
  }
  throw new Error('REVIEW_CODE_EXHAUSTED');
}

// ---- nicknames ------------------------------------------------------------------------------------------------------

/** Every name the player ever had (all 名片 revisions), longest first. */
export function nicknamesOfWorld(store: Reader, worldId: string): string[] {
  if (!tableExists(store, 'player_profile_versions')) return [];
  const names = new Set<string>();
  for (const row of store.all<{ profile_json: string }>(
    'SELECT profile_json FROM player_profile_versions WHERE world_id=?',
    worldId,
  ))
    try {
      const name = (JSON.parse(row.profile_json) as { name?: unknown }).name;
      if (typeof name === 'string' && name.trim() !== '') names.add(name.trim());
    } catch {
      // A revision that is not JSON has no name to hide.
    }
  return [...names].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

// Comparison form of a character: compatibility-folded and lower-cased (full-width letters, case), with white space and
// invisible format characters ignored, so "小 明", "ＡＢＣ" and "abc" all find the nickname "小明" / "abc".
const skipped = /[\p{White_Space}\p{Cf}]/u;
const fold = (char: string) => (skipped.test(char) ? '' : char.normalize('NFKC').toLowerCase());

/**
 * Replaces every occurrence of any of the names with 〔昵称〕. Matching is on the folded form (see above); every character
 * a match touches is replaced, and neighbouring matches become one placeholder. Single pass: the placeholder is never
 * itself searched.
 */
export function redactNicknames(text: string, names: readonly string[]): string {
  const needles = [...new Set(names.map((n) => [...n].map(fold).join('')).filter((n) => n !== ''))].sort(
    (a, b) => b.length - a.length,
  );
  if (needles.length === 0 || text === '') return text;
  const chars = [...text];
  let folded = '';
  const owner: number[] = [];
  chars.forEach((char, index) => {
    const form = fold(char);
    for (let k = 0; k < form.length; k++) owner.push(index);
    folded += form;
  });
  const hit = new Array<boolean>(chars.length).fill(false);
  for (const needle of needles)
    for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + 1)) {
      const first = owner[at]!,
        last = owner[at + needle.length - 1]!;
      for (let index = first; index <= last; index++) hit[index] = true;
    }
  let result = '';
  for (let index = 0; index < chars.length; index++) {
    if (!hit[index]) result += chars[index];
    else {
      result += NICKNAME_PLACEHOLDER;
      while (index + 1 < chars.length && hit[index + 1]) index++;
    }
  }
  return result;
}

// ---- transcripts ----------------------------------------------------------------------------------------------------

export type TranscriptLine = {
  /** Position within the transcript, from 0. */
  order: number;
  /** Character-local time: "YYYY-MM-DD HH:MM". */
  time: string;
  speaker: 'player' | 'character' | 'proactive';
  text: string;
  status: 'ok' | 'failed';
  errorCode: string | null;
  reviewChanged: boolean;
};
export type CharacterFacts = { characterId: string; label: string; timeZone: string };

/** Display label and time zone of a character: the published profile, else the template, else the id. */
export function characterFacts(store: Reader, characterId: string): CharacterFacts {
  let label: string | null = null,
    timeZone: string | null = null;
  if (tableExists(store, 'web_character_catalog')) {
    const row = store.get<{ profile_json: string }>(
      `SELECT v.profile_json FROM web_character_catalog c
      JOIN web_character_versions v ON v.character_id=c.character_id AND v.version=c.version WHERE c.character_id=?`,
      characterId,
    );
    if (row)
      try {
        const profile = JSON.parse(row.profile_json) as {
          presentation?: { displayName?: unknown };
          template?: { schedule?: { timeZone?: unknown } };
        };
        if (typeof profile.presentation?.displayName === 'string') label = profile.presentation.displayName;
        if (typeof profile.template?.schedule?.timeZone === 'string') timeZone = profile.template.schedule.timeZone;
      } catch {
        // fall through to the template
      }
  }
  if (label === null || timeZone === null) {
    const row = store.get<{ config_json: string }>(
      'SELECT config_json FROM character_templates WHERE id=?',
      characterId,
    );
    if (row)
      try {
        const config = JSON.parse(row.config_json) as { name?: unknown; schedule?: { timeZone?: unknown } };
        if (label === null && typeof config.name === 'string') label = config.name;
        if (timeZone === null && typeof config.schedule?.timeZone === 'string') timeZone = config.schedule.timeZone;
      } catch {
        // fall back to the id
      }
  }
  return { characterId, label: label ?? characterId, timeZone: timeZone ?? 'UTC' };
}
export const reviewLabel = (character: Pick<CharacterFacts, 'label'>, code: string) => `${character.label}-${code}`;

/** "YYYY-MM-DD HH:MM" in the character's own zone. */
export function characterLocalTime(at: number, timeZone: string) {
  let local: ReturnType<typeof localTime>;
  try {
    local = localTime(at, timeZone);
  } catch {
    local = localTime(at, 'UTC');
  }
  const hh = String(Math.floor(local.minute / 60)).padStart(2, '0'),
    mm = String(local.minute % 60).padStart(2, '0');
  return `${local.date} ${hh}:${mm}`;
}

const reviewChangedKnown = (store: Reader) =>
  !!store.get("SELECT 1 FROM pragma_table_info('web_operation_metrics') WHERE name='review_changed'");

/**
 * The transcript of one world's private conversation with one character, in order, both sides: the player's text, the
 * character's final bubbles (the published text, also for voice replies), its own unprompted messages and failed replies
 * (with their error code). Nicknames are already replaced. Reads only; the caller scopes `worldId` to the principal.
 */
export function readTranscript(
  store: Reader,
  worldId: string,
  characterId: string,
  names: readonly string[],
): TranscriptLine[] {
  const facts = characterFacts(store, characterId);
  const withMetrics = reviewChangedKnown(store);
  const messages = store.all<{
    seq: number;
    id: string;
    body: string;
    created_at: number;
    author_kind: 'player' | 'character';
    proactive: number;
    changed: number | null;
  }>(
    `SELECT m.seq,m.id,m.body,m.created_at,m.author_kind,m.proactive,
      ${
        withMetrics
          ? `(SELECT x.review_changed FROM web_publication_items i
            JOIN web_operation_metrics x ON x.operation_id=i.operation_id WHERE i.message_id=m.id)`
          : 'NULL'
      } changed
    FROM messages m JOIN conversations c ON c.world_id=m.world_id AND c.id=m.conversation_id
    WHERE m.world_id=? AND c.kind='private' AND c.private_character_id=? ORDER BY m.seq`,
    worldId,
    characterId,
  );
  const failed = store.all<{ seq: number; created_at: number; failure_code: string | null }>(
    `SELECT m.seq,m.created_at,o.failure_code FROM web_operations o JOIN messages m ON m.id=o.input_message_id
    WHERE o.world_id=? AND o.character_id=? AND o.status='failed' ORDER BY m.seq`,
    worldId,
    characterId,
  );
  type Item = { seq: number; part: number; line: Omit<TranscriptLine, 'order'> };
  const items: Item[] = [];
  for (const m of messages)
    items.push({
      seq: m.seq,
      part: 0,
      line: {
        time: characterLocalTime(m.created_at, facts.timeZone),
        speaker: m.author_kind === 'player' ? 'player' : m.proactive === 1 ? 'proactive' : 'character',
        text: redactNicknames(m.body, names),
        status: 'ok',
        errorCode: null,
        reviewChanged: m.author_kind === 'character' && m.changed === 1,
      },
    });
  // A failed reply belongs right after the player message it answered.
  for (const f of failed)
    items.push({
      seq: f.seq,
      part: 1,
      line: {
        time: characterLocalTime(f.created_at, facts.timeZone),
        speaker: 'character',
        text: '',
        status: 'failed',
        errorCode: f.failure_code ?? 'UNKNOWN',
        reviewChanged: false,
      },
    });
  items.sort((a, b) => a.seq - b.seq || a.part - b.part);
  return items.map((item, order) => ({ order, ...item.line }));
}

/** The characters this world has any private message with. */
export function charactersWithMessages(store: Reader, worldId: string) {
  return store
    .all<{ character_id: string }>(
      `SELECT DISTINCT c.private_character_id character_id FROM conversations c
      WHERE c.world_id=? AND c.kind='private' AND EXISTS
        (SELECT 1 FROM messages m WHERE m.world_id=c.world_id AND m.conversation_id=c.id)
      ORDER BY c.private_character_id`,
      worldId,
    )
    .map((row) => row.character_id);
}

// ---- archive --------------------------------------------------------------------------------------------------------

/**
 * Copies the principal's transcripts into the anonymous archive. Called by the transaction that STARTS a purge (before any
 * content is cleared) and only when that transaction really moves the principal into 'purging', so a purge resumed after a
 * restart finds the state already set and never archives twice. A missing code is assigned here. The principal's live code
 * row is deleted in the same step: from then on nothing joins the archive's code back to the account.
 * Returns the number of archived lines.
 */
export function archivePlayerChats(store: Db, principalId: string, worldId: string, now: number) {
  ensure(chatReviewTablesExist(store), 'REVIEW_UNAVAILABLE');
  const names = nicknamesOfWorld(store, worldId);
  let lines = 0;
  const characters = charactersWithMessages(store, worldId);
  let code: string | null = null;
  for (const characterId of characters) {
    const transcript = readTranscript(store, worldId, characterId, names);
    if (transcript.length === 0) continue;
    code ??= reviewCodeFor(store, principalId, now);
    const label = reviewLabel(characterFacts(store, characterId), code);
    for (const line of transcript) {
      store.run(
        `INSERT INTO web_review_archive(label,review_code,character_id,line_order,at_local,speaker,text,status,error_code,
          review_changed,archived_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        label,
        code,
        characterId,
        line.order,
        line.time,
        line.speaker,
        line.text,
        line.status,
        line.errorCode,
        line.reviewChanged ? 1 : 0,
        now,
        now + ARCHIVE_TTL_MS,
      );
      lines++;
    }
  }
  // The live code and the banner mark go in the same step, so the archive's code never joins back to the account.
  purgeReviewRows(store, principalId);
  return lines;
}

/** Deletes archive rows past expires_at, at most one batch per call. Idempotent; the only thing that deletes archive rows. */
export function sweepReviewArchive(store: Db, now: number) {
  if (!tableExists(store, 'web_review_archive')) return 0;
  return store.run(
    `DELETE FROM web_review_archive WHERE (label,line_order) IN
    (SELECT label,line_order FROM web_review_archive WHERE expires_at<=? LIMIT ${ARCHIVE_SWEEP_BATCH})`,
    now,
  ).changes;
}
/** When the archive next has something to delete (so the alarm wakes for it), or null. */
export function nextReviewArchiveExpiry(store: Reader) {
  if (!tableExists(store, 'web_review_archive')) return null;
  return store.get<{ due: number | null }>('SELECT min(expires_at) due FROM web_review_archive')?.due ?? null;
}

// ---- the player's own rows ------------------------------------------------------------------------------------------

/** The live code and the banner mark are player data: they go with the player. */
export function purgeReviewRows(store: Pick<BusinessStore, 'get' | 'run'>, principalId: string) {
  if (tableExists(store, 'web_review_codes'))
    store.run('DELETE FROM web_review_codes WHERE principal_id=?', principalId);
  if (tableExists(store, 'web_review_notice'))
    store.run('DELETE FROM web_review_notice WHERE principal_id=?', principalId);
}
/** True while a live code or banner mark of any of these principals remains: the lifecycle audit fails closed on it. */
export function reviewRowsRemain(store: Pick<BusinessStore, 'get'>, principalIds: string[]) {
  if (principalIds.length === 0) return false;
  const marks = principalIds.map(() => '?').join(',');
  return (
    (tableExists(store, 'web_review_codes') &&
      !!store.get(`SELECT 1 FROM web_review_codes WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds)) ||
    (tableExists(store, 'web_review_notice') &&
      !!store.get(`SELECT 1 FROM web_review_notice WHERE principal_id IN (${marks}) LIMIT 1`, ...principalIds))
  );
}

/**
 * True when the archive has a column that names (or could join to) an account: any principal / player / world /
 * conversation / session / operation / invite / email / ip / account column, or any column ending in `_id` other than the
 * character's. The audit fails closed on it.
 */
export function archiveHasIdentityColumn(store: Reader) {
  if (!tableExists(store, 'web_review_archive')) return false;
  return store
    .all<{ name: string }>('PRAGMA table_info(web_review_archive)')
    .some(
      (column) =>
        /principal|player|world|conversation|session|operation|invite|email|account|(^|_)ip|nickname/i.test(
          column.name,
        ) ||
        (/_id$/.test(column.name) && column.name !== 'character_id'),
    );
}
