import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { requireWebContent, webDataLifecycleEnabled } from '../admission/web-retention.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { installWebFeedback, webFeedbackInstalled } from './web-feedback-schema.ts';

/**
 * Part 36: 👍 / 👎 on a character's reply. The only writer of the feedback tables.
 *  - One rating per player per message. The player's desired state is sent (`up`, `down` with its target, or `none`), so tapping
 *    the same button again (`none`), switching (the other value) and a repeated request are all idempotent.
 *  - Only a reply of the character in the player's OWN conversation can be rated (a voice message or a text-fallback reply; never the
 *    welcome clip, the trial footer or a broadcast). Anything else, another player's message and another conversation's message
 *    answer NOT_FOUND.
 *  - A 👎 says what is rated down: the `voice` (only for a message that has audio) or the reply `content`.
 *  - The writer (回复写法) and the model that wrote the reply are copied when the rating is written.
 */
export type Rating = 'up' | 'down';
export type RatingTarget = 'voice' | 'content';
export interface RatingState {
  value: Rating;
  target: RatingTarget | null;
}
interface Actor {
  principalId: string;
  world_id: string;
  player_id: string;
}
const REQUEST_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** The writer name of a stored request, the same names the export uses ('v7' | 'v8' | 'v8p' | 'v8m'). */
export const writerOfRequest = (json: { writer?: unknown; writerProfile?: unknown; writerMemes?: unknown } | null) =>
  json?.writer === 'v8' ? (json.writerMemes === true ? 'v8m' : json.writerProfile === true ? 'v8p' : 'v8') : 'v7';

export class WebFeedback {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  constructor(store: WebRuntimeStore, clock: Clock) {
    installWebFeedback(store);
    this.store = store;
    this.clock = clock;
  }

  rate(
    actor: Actor,
    input: {
      requestId: string;
      conversationId: string;
      messageId: string;
      rating: Rating | 'none';
      target?: RatingTarget;
    },
  ): { rating: Rating | null; target: RatingTarget | null } {
    ensure(
      REQUEST_ID.test(input.requestId) &&
        ID.test(input.conversationId) &&
        ID.test(input.messageId) &&
        (input.rating === 'up' || input.rating === 'down' || input.rating === 'none') &&
        (input.rating === 'down' ? input.target === 'voice' || input.target === 'content' : input.target === undefined),
      'INVALID_REQUEST',
    );
    const hash = createHash('sha256')
      .update(JSON.stringify([input.conversationId, input.messageId, input.rating, input.target ?? null]))
      .digest('hex');
    return this.store.transaction(() => {
      if (webDataLifecycleEnabled(this.store))
        requireWebContent(this.store, this.clock, actor.principalId, actor.world_id);
      const prior = this.store.get<{ request_hash: string }>(
        'SELECT request_hash FROM web_feedback_requests WHERE principal_id=? AND request_id=?',
        actor.principalId,
        input.requestId,
      );
      if (prior) ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
      const conversation = this.store.get<{ private_character_id: string }>(
        `SELECT private_character_id FROM conversations WHERE world_id=? AND id=? AND kind='private'`,
        actor.world_id,
        input.conversationId,
      );
      ensure(conversation && !webCharacterDeleted(this.store, conversation.private_character_id), 'NOT_FOUND');
      // The reply must be one the character published to THIS player in THIS conversation.
      const reply = this.store.get<{ operation_id: string; origin: string; media_id: string | null }>(
        `SELECT i.operation_id,i.origin,i.media_id FROM web_publication_items i JOIN web_publications p ON p.operation_id=i.operation_id
        WHERE i.message_id=? AND i.origin IN ('narrative','text_fallback')
          AND p.principal_id=? AND p.player_id=? AND p.world_id=? AND p.conversation_id=?`,
        input.messageId,
        actor.principalId,
        actor.player_id,
        actor.world_id,
        input.conversationId,
      );
      ensure(reply, 'NOT_FOUND');
      // A voice target needs a voice: a reply delivered as text is rated as content only.
      ensure(
        input.target !== 'voice' || (reply.origin === 'narrative' && reply.media_id !== null),
        'FEEDBACK_TARGET_INVALID',
      );
      const now = this.clock.now();
      if (!prior)
        this.store.run(
          'INSERT INTO web_feedback_requests(principal_id,request_id,request_hash,created_at) VALUES (?,?,?,?)',
          actor.principalId,
          input.requestId,
          hash,
          now,
        );
      if (input.rating === 'none') {
        this.store.run(
          'DELETE FROM web_feedback WHERE principal_id=? AND message_id=?',
          actor.principalId,
          input.messageId,
        );
        return { rating: null, target: null };
      }
      const existing = this.store.get<{ rating: Rating; target: RatingTarget | null }>(
        'SELECT rating,target FROM web_feedback WHERE principal_id=? AND message_id=?',
        actor.principalId,
        input.messageId,
      );
      const target = input.rating === 'down' ? (input.target ?? null) : null;
      if (existing && existing.rating === input.rating && existing.target === target)
        return { rating: existing.rating, target };
      const request = this.store.get<{ request_json: string }>(
        'SELECT request_json FROM web_v7_requests WHERE operation_id=?',
        reply.operation_id,
      );
      const writer = writerOfRequest(request ? (JSON.parse(request.request_json) as Record<string, unknown>) : null);
      const model = this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_operation_models'")
        ? (this.store.get<{ model: string | null }>(
            `SELECT coalesce(draft_provider,chosen) model FROM web_operation_models WHERE operation_id=?`,
            reply.operation_id,
          )?.model ?? 'deepseek')
        : 'deepseek';
      // A switch keeps the first time and clears the owner's 「已听」; a new rating starts both.
      this.store.run(
        `INSERT INTO web_feedback(principal_id,message_id,world_id,conversation_id,character_id,operation_id,rating,target,writer,model,
          created_at,updated_at,heard_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)
        ON CONFLICT(principal_id,message_id) DO UPDATE SET rating=excluded.rating,target=excluded.target,updated_at=excluded.updated_at,heard_at=NULL`,
        actor.principalId,
        input.messageId,
        actor.world_id,
        input.conversationId,
        conversation.private_character_id,
        reply.operation_id,
        input.rating,
        target,
        writer,
        model,
        now,
        now,
      );
      return { rating: input.rating, target };
    });
  }

  /** The player's own ratings of these messages (history carries them so a reload shows the mark). */
  ratingsOf(actor: Actor, messageIds: string[]): Map<string, RatingState> {
    const out = new Map<string, RatingState>();
    if (!messageIds.length || !webFeedbackInstalled(this.store)) return out;
    for (const row of this.store.all<{ message_id: string; rating: Rating; target: RatingTarget | null }>(
      `SELECT message_id,rating,target FROM web_feedback WHERE principal_id=? AND world_id=? AND message_id IN (${messageIds.map(() => '?').join(',')})`,
      actor.principalId,
      actor.world_id,
      ...messageIds,
    ))
      out.set(row.message_id, { value: row.rating, target: row.target });
    return out;
  }
}
