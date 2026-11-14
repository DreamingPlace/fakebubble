import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { CastRequestContext } from '../../../packages/contracts/web-cast.ts';
import { NEW_PLAYER_RELATIONSHIP } from '../../../packages/contracts/relationships.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { promptMessages } from '../generation/accepted-text-prompt.ts';
import { writerDraftMessages } from '../generation/writer-v8.ts';
import { parseRehearsalColumn } from '../../../packages/contracts/web-rehearsal.ts';

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
  opening?: { text: string };
  cast?: CastRequestContext;
  /** The clock of the first turn. */
  baseAt: number;
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
  const column = parseRehearsalColumn(model) ?? { model: 'deepseek' as const, writer: 'v7' as const };
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
  const request: TextGenerationRequest = {
    jobId: rehearsalJobId(runId, model, turn),
    scope: { worldId, conversationId, characterId },
    now: frozen.baseAt + (turn - 1) * TURN_GAP_MS + 4_000,
    character: structuredClone(frozen.template),
    ...(frozen.cast ? { cast: structuredClone(frozen.cast) } : {}),
    // Part 37a: a 新 column runs the v8 writer, which sends no relationship preset. Never the live switch: the column decides.
    ...(v8 ? { writer: 'v8' as const } : { relationship: NEW_PLAYER_RELATIONSHIP }),
    requiredMessageIds: [`p${turn}`],
    mustClose: false,
    evidence: [],
    deliveryMode: frozen.template.voice ? 'voice' : 'text',
    // The welcome line is the character's first line only while the history still reaches the start of the chat.
    ...(frozen.opening && all.length <= REHEARSAL_HISTORY_WINDOW ? { opening: frozen.opening } : {}),
    messages,
  };
  if (v8) writerDraftMessages(request);
  else promptMessages(request);
  return request;
}
