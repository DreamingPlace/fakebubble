import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { CastRequestContext } from '../../../packages/contracts/web-cast.ts';
import { NEW_PLAYER_RELATIONSHIP } from '../../../packages/contracts/relationships.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { promptMessages } from '../generation/accepted-text-prompt.ts';
import { writerDraftMessages } from '../generation/writer-v8.ts';
import { openingForWriter } from '../generation/opening-line.ts';
import { parseRehearsalColumn } from '../../../packages/contracts/web-rehearsal.ts';
import { MEME_TURNS, readMemeUse, withoutMemeUse } from '../../../packages/contracts/web-memes.ts';
import { castDigest } from '../cast/cast-store.ts';
import { selectCastView } from '../cast/cast-select.ts';
import { matchMemes } from '../memes/meme-match.ts';

/**
 * Part 35: the request one model gets for one turn of a script. Every 预演 starts like a NEW player: the relationship the chat
 * pipeline gives a new player (`NEW_PLAYER_RELATIONSHIP`) and no relationship context, no memories, no facts, no scene. Nothing here
 * reads a player: the history is the script's own lines and this model's own earlier replies.
 */
/** The live chat reads the last 24 messages (HISTORY_WINDOW in web-v7-request.ts); so does a rehearsal. */
export const REHEARSAL_HISTORY_WINDOW = 24;
const TURN_GAP_MS = 120_000;

/** Everything a run freezes when it is queued; the cells are built from it and from the script, never from a live draft. */
export interface RehearsalFrozen {
  template: TextGenerationRequest['character'];
  /** Part 37a-2: `context` is the line's 情境 note; only a 新 column reads it. */
  opening?: { text: string; context?: string };
  /** Part 37a-2: the teammates a 新 column gets (frozen with the run; absent when no 新 column runs). */
  roster?: NonNullable<TextGenerationRequest['roster']>;
  /** Part 51: her own names for a 新 column (the cast DRAFT's aliases merged with the profile settings). */
  ownNames?: NonNullable<TextGenerationRequest['ownNames']>;
  cast?: CastRequestContext;
  /**
   * Part 37c-1 (a 新+档案+梗 column only): the items of the character's full cast that any turn of the run may select (the union of
   * what each turn's player messages select, plus the source items of a 梗与故事 run), as a view. Each turn selects its own
   * context from it; absent when no such column runs or the run has no 带关系与故事.
   */
  castPool?: CastRequestContext;
  /** Part 37c-1 (a 新+档案+梗 column only): the dictionary entries switched off when the run was queued. */
  memeOff?: string[];
  /** The clock of the first turn. */
  baseAt: number;
  /** Part 31b: set when the run used the LIVE published version of the character (no draft); the version it ran on. */
  liveVersion?: number;
}

export const rehearsalJobId = (runId: string, model: string, turn: number) => `${runId}-${model}-${turn}`;

/** `model` is a column key (`deepseek`, `deepseek-v8`); `replies[i]` are the bubbles this column said to turn i + 1. */
export function rehearsalRequest(
  frozen: RehearsalFrozen,
  runId: string,
  model: string,
  turn: number,
  players: readonly string[],
  replies: readonly (readonly string[])[],
): TextGenerationRequest {
  ensure(turn >= 1 && turn <= players.length && replies.length >= turn - 1, 'REHEARSAL_REQUEST_INVALID');
  const column = parseRehearsalColumn(model) ?? {
    model: 'deepseek' as const,
    writer: 'v7' as const,
    profile: false,
    memes: false,
  };
  const v8 = column.writer === 'v8';
  const worldId = `admin-rehearsal-${runId}-${model}`;
  const conversationId = `${runId}-${model}`;
  const characterId = frozen.template.id;
  const all: TextGenerationRequest['messages'] = [];
  for (let i = 1; i <= turn; i++) {
    const at = frozen.baseAt + (i - 1) * TURN_GAP_MS;
    all.push({
      id: `p${i}`,
      worldId,
      conversationId,
      authorKind: 'player',
      authorId: 'admin-rehearsal',
      text: players[i - 1]!,
      createdAt: at,
      delivery: 'text',
      voiceFallback: false,
      mediaId: null,
      proactive: false,
    });
    if (i < turn)
      replies[i - 1]!.forEach((text, b) =>
        all.push({
          id: `c${i}-${b + 1}`,
          worldId,
          conversationId,
          authorKind: 'character',
          authorId: characterId,
          text,
          createdAt: at + 5_000 + b,
          delivery: 'text',
          voiceFallback: false,
          mediaId: null,
          proactive: false,
        }),
      );
  }
  const messages = all.slice(-REHEARSAL_HISTORY_WINDOW);
  // Part 37c-1: 新+档案+梗 reads the player's last messages of this window (latest first) for dictionary terms and for the cast.
  const playerTexts = column.memes
    ? messages
        .filter((message) => message.authorKind === 'player')
        .map((message) => message.text)
        .reverse()
        .slice(0, MEME_TURNS)
    : [];
  const memeHits = column.memes
    ? matchMemes(playerTexts, new Set(frozen.memeOff ?? []), readMemeUse(frozen.template))
    : [];
  const memeCast =
    column.memes && frozen.castPool
      ? (() => {
          const view = selectCastView(frozen.castPool.view, playerTexts);
          return { ...structuredClone(frozen.castPool), digest: castDigest(JSON.stringify(view)), view };
        })()
      : undefined;
  const request: TextGenerationRequest = {
    jobId: rehearsalJobId(runId, model, turn),
    scope: { worldId, conversationId, characterId },
    now: frozen.baseAt + (turn - 1) * TURN_GAP_MS + 4_000,
    // Part 37c-1: the character's own meme settings never reach a prompt (the matched entries carry the level).
    character: structuredClone(withoutMemeUse(frozen.template)),
    ...(column.memes
      ? memeCast
        ? { cast: memeCast }
        : {}
      : frozen.cast
        ? { cast: structuredClone(frozen.cast) }
        : {}),
    // Part 37a: a 新 column runs the v8 writer, which sends no relationship preset. Never the live switch: the column decides.
    ...(v8 ? { writer: 'v8' as const } : { relationship: NEW_PLAYER_RELATIONSHIP }),
    // Part 37b: a 新+档案 column adds the character's own 核心卡 and examples (writer-profile.ts); never the live switch.
    ...(column.profile ? { writerProfile: true as const } : {}),
    // Part 37c-1: 新+档案+梗 adds the matched meanings (frozen in the request; none matched = nothing is printed).
    ...(column.memes ? { writerMemes: true as const, ...(memeHits.length ? { memeHits } : {}) } : {}),
    requiredMessageIds: [`p${turn}`],
    mustClose: false,
    evidence: [],
    deliveryMode: frozen.template.voice ? 'voice' : 'text',
    // The welcome line is the character's first line only while the history still reaches the start of the chat.
    ...(frozen.opening && all.length <= REHEARSAL_HISTORY_WINDOW
      ? { opening: openingForWriter(frozen.opening, v8, turn) }
      : {}),
    ...(v8 && frozen.roster ? { roster: structuredClone(frozen.roster) } : {}),
    ...(v8 && frozen.ownNames?.length ? { ownNames: structuredClone(frozen.ownNames) } : {}),
    messages,
  };
  if (v8) writerDraftMessages(request);
  else promptMessages(request);
  return request;
}
