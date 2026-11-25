import { createHash } from 'node:crypto';
import type { Clock, MessageQuote } from '../../../packages/contracts/index.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { DomainError, ensure, RetryAfterError } from '../../../packages/domain/errors.ts';
import type { WebAdmission } from '../admission/web-admission.ts';
import { requireWebContent, webDataLifecycleEnabled } from '../admission/web-retention.ts';
import { requirePublishedWebCharacter, webCharacterOnline } from '../characters/web-character-catalog.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { TURN_MAX_BUBBLES, TURN_MAX_PENDING, TURN_QUIET_MS, installWebTurns, webTurnsInstalled } from './web-turn-schema.ts';

/**
 * Part 36: 连发. The only writer of the turn rows. A bubble is stored the moment it is sent (an ordinary `messages` row plus a
 * `web_turn_bubbles` row, idempotent per request id), so nothing is lost on reload, offline or a closed tab. The reply is a TURN:
 * one operation that answers the whole batch. It is admitted (and charged) ONCE, when the batch closes:
 *   - the player has been quiet for TURN_QUIET_MS (4 s) after the last bubble, or
 *   - TURN_MAX_BUBBLES (5) bubbles are waiting (closed inside the request that stored the fifth), and
 *   - no earlier turn of this conversation is still running (bubbles sent meanwhile wait for the next turn).
 * The closing is the business object's own: `pass(now)` runs from its alarm (Cloudflare) or its timer (local server), never from
 * the open page. The turn's input message is its LAST bubble, so every table that keys one input message per operation keeps its
 * meaning; the earlier bubbles are found through `web_turn_bubbles.operation_id` (see `turnMemberIds`).
 * Money: the turn goes through WebAdmission.admit exactly like a single message, so one reservation / one charge per reply, and the
 * budget, UNKNOWN and re-queue rules downstream are untouched.
 */
export interface TurnActor {
  principalId: string;
  world_id: string;
  player_id: string;
}
export interface TurnView {
  state: 'idle' | 'collecting' | 'replying' | 'refused';
  /** When the quiet period ends (collecting only); null otherwise. */
  dueAt: number | null;
  pending: number;
  operationId: string | null;
  errorCode: string | null;
}
const REQUEST_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const BUSY = "status NOT IN ('published','cancelled','failed','unknown')";
/** Transient refusals: the bubbles stay pending and the close is tried again. */
const TRANSIENT = new Set(['QUEUE_FULL', 'WEB_USER_QUEUE_FULL', 'WEB_DAILY_LIMIT_REACHED']);
export const TURN_RETRY_MS = 2_000;

/** The bubbles a turn answers, in the order they were sent. An operation with no bubble rows (a single message) answers its own input. */
export function turnMemberIds(
  store: Pick<WebRuntimeStore, 'all' | 'get'>,
  operationId: string,
  inputMessageId: string,
): string[] {
  if (!webTurnsInstalled(store)) return [inputMessageId];
  const rows = store.all<{ message_id: string }>(
    `SELECT b.message_id FROM web_turn_bubbles b JOIN messages m ON m.id=b.message_id
    WHERE b.operation_id=? AND b.state='turn' ORDER BY m.seq`,
    operationId,
  );
  return rows.length ? rows.map((row) => row.message_id) : [inputMessageId];
}

export class WebTurns {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly admission: WebAdmission;
  private readonly nextId: () => string;
  /** Called after a turn is admitted so the executor can start it at once. */
  onAdmitted: (() => void) | null = null;
  constructor(store: WebRuntimeStore, clock: Clock, admission: WebAdmission, nextId: () => string = () => globalThis.crypto.randomUUID()) {
    installWebTurns(store);
    this.store = store;
    this.clock = clock;
    this.admission = admission;
    this.nextId = nextId;
  }

  /**
   * Stores one bubble. The text rules, the access decisions and the queue limits are admit()'s own (a dry run), so a bubble is
   * accepted only when the turn it will join could be admitted. A quote must name a message of THIS conversation.
   */
  addBubble(
    actor: TurnActor,
    input: { requestId: string; characterId: string; text: string; quoteMessageId?: string | null; ipHash: string },
  ) {
    ensure(REQUEST_ID.test(input.requestId), 'INVALID_REQUEST_ID');
    ensure(typeof input.text === 'string' && typeof input.characterId === 'string', 'INVALID_TEXT');
    ensure(
      input.quoteMessageId === undefined ||
        input.quoteMessageId === null ||
        (typeof input.quoteMessageId === 'string' && REQUEST_ID.test(input.quoteMessageId)),
      'INVALID_REQUEST',
    );
    const quote = input.quoteMessageId ?? null;
    const hash = createHash('sha256').update(JSON.stringify([input.characterId, input.text, quote, 'bubble'])).digest('hex');
    return this.store.transaction(() => {
      const prior = this.store.get<{ message_id: string; request_hash: string; conversation_id: string }>(
        'SELECT message_id,request_hash,conversation_id FROM web_turn_bubbles WHERE principal_id=? AND request_id=?',
        actor.principalId,
        input.requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { messageId: prior.message_id, conversationId: prior.conversation_id, duplicate: true as const, turn: this.view(actor, input.characterId) };
      }
      // The lifecycle gate precedes everything else: expired content stays private.
      if (webDataLifecycleEnabled(this.store)) requireWebContent(this.store, this.clock, actor.principalId, actor.world_id);
      requirePublishedWebCharacter(this.store, input.characterId);
      ensure(webCharacterOnline(this.store, input.characterId), 'WEB_CHARACTER_UNAVAILABLE');
      ensure(
        input.text.trim().length > 0 &&
          [...input.text].length <= WEB_LIMITS.maxInputCodePoints &&
          !/[\u0000-\u001f\u007f]/u.test(input.text),
        'INVALID_TEXT',
      );
      // The same decisions a single message gets (entitlement, points, trial counters, queue limits); nothing is written.
      this.admission.canAdmit({ principalId: actor.principalId, characterId: input.characterId, text: input.text, ipHash: input.ipHash });
      let conversation = this.store.get<{ id: string }>(
        `SELECT id FROM conversations WHERE world_id=? AND private_character_id=? AND kind='private'`,
        actor.world_id,
        input.characterId,
      );
      if (quote !== null)
        // Scoped to this identity, world and conversation: another conversation's message (or a message that does not exist) is refused.
        ensure(
          conversation &&
            this.store.get(
              'SELECT 1 FROM messages WHERE id=? AND world_id=? AND conversation_id=?',
              quote,
              actor.world_id,
              conversation.id,
            ),
          'QUOTE_UNAVAILABLE',
        );
      const waiting = conversation
        ? this.store.get<{ n: number }>(
            "SELECT count(*) n FROM web_turn_bubbles WHERE principal_id=? AND world_id=? AND conversation_id=? AND state='pending'",
            actor.principalId,
            actor.world_id,
            conversation.id,
          )!.n
        : 0;
      ensure(waiting < TURN_MAX_PENDING, 'WEB_TURN_BUBBLES_FULL');
      if (!conversation) conversation = this.admission.createConversation(actor.world_id, input.characterId);
      const now = this.clock.now();
      const messageId = this.nextId();
      this.store.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,request_id,request_hash)
        VALUES (?,?,?,'player',?,?,?,'text',?,?)`,
        messageId,
        actor.world_id,
        conversation.id,
        actor.player_id,
        input.text,
        now,
        input.requestId,
        hash,
      );
      this.store.run(
        'INSERT INTO outbox(world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)',
        actor.world_id,
        conversation.id,
        messageId,
        now,
      );
      this.store.run(
        `INSERT INTO web_turn_bubbles(message_id,principal_id,world_id,conversation_id,character_id,request_id,request_hash,
          quote_message_id,ip_hash,created_at,state) VALUES (?,?,?,?,?,?,?,?,?,?,'pending')`,
        messageId,
        actor.principalId,
        actor.world_id,
        conversation.id,
        input.characterId,
        input.requestId,
        hash,
        quote,
        input.ipHash,
        now,
      );
      // The fifth waiting bubble closes the batch right now (when no reply is running); otherwise the quiet period decides.
      this.closeConversation(actor.principalId, actor.world_id, conversation.id, now, true);
      return { messageId, conversationId: conversation.id, duplicate: false as const, turn: this.view(actor, input.characterId) };
    });
  }

  /** What the page shows: nothing, collecting (with the moment the quiet period ends), her reply running, or a refused turn. */
  view(actor: TurnActor, characterId: string): TurnView {
    const idle: TurnView = { state: 'idle', dueAt: null, pending: 0, operationId: null, errorCode: null };
    if (!webTurnsInstalled(this.store)) return idle;
    const conversation = this.store.get<{ id: string }>(
      `SELECT id FROM conversations WHERE world_id=? AND private_character_id=? AND kind='private'`,
      actor.world_id,
      characterId,
    );
    if (!conversation) return idle;
    const busy = this.store.get<{ id: string }>(
      `SELECT id FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND ${BUSY} ORDER BY created_at DESC LIMIT 1`,
      actor.principalId,
      actor.world_id,
      conversation.id,
    );
    const pending = this.store.get<{ n: number; last: number | null }>(
      "SELECT count(*) n,max(created_at) last FROM web_turn_bubbles WHERE principal_id=? AND world_id=? AND conversation_id=? AND state='pending'",
      actor.principalId,
      actor.world_id,
      conversation.id,
    )!;
    if (busy) return { state: 'replying', dueAt: null, pending: pending.n, operationId: busy.id, errorCode: null };
    if (pending.n > 0)
      return {
        state: 'collecting',
        dueAt: pending.n >= TURN_MAX_BUBBLES ? this.clock.now() : (pending.last ?? this.clock.now()) + TURN_QUIET_MS,
        pending: pending.n,
        operationId: null,
        errorCode: null,
      };
    const refused = this.store.get<{ refused_code: string }>(
      `SELECT refused_code FROM web_turn_bubbles WHERE principal_id=? AND world_id=? AND conversation_id=? AND state='refused'
      ORDER BY created_at DESC LIMIT 1`,
      actor.principalId,
      actor.world_id,
      conversation.id,
    );
    const last = this.store.get<{ operation_id: string | null }>(
      `SELECT operation_id FROM web_turn_bubbles WHERE principal_id=? AND world_id=? AND conversation_id=? AND state='turn'
      ORDER BY created_at DESC LIMIT 1`,
      actor.principalId,
      actor.world_id,
      conversation.id,
    );
    if (refused && !last) return { state: 'refused', dueAt: null, pending: 0, operationId: null, errorCode: refused.refused_code };
    return { state: 'idle', dueAt: null, pending: 0, operationId: last?.operation_id ?? null, errorCode: refused?.refused_code ?? null };
  }

  /**
   * Closes the batch of one conversation when it is due (or `force`d by the fifth bubble). Returns the operation id or null.
   * Runs inside the caller's transaction. An operation of this conversation that is still running keeps the bubbles waiting.
   */
  private closeConversation(principalId: string, worldId: string, conversationId: string, now: number, fiveCloses = false) {
    const pending = this.store.all<{ message_id: string; character_id: string; ip_hash: string; created_at: number; body: string }>(
      `SELECT b.message_id,b.character_id,b.ip_hash,b.created_at,m.body FROM web_turn_bubbles b JOIN messages m ON m.id=b.message_id
      WHERE b.principal_id=? AND b.world_id=? AND b.conversation_id=? AND b.state='pending' ORDER BY m.seq LIMIT ?`,
      principalId,
      worldId,
      conversationId,
      TURN_MAX_BUBBLES,
    );
    if (!pending.length) return null;
    const last = pending[pending.length - 1]!;
    const full = pending.length >= TURN_MAX_BUBBLES;
    if (!(full || (!fiveCloses && now >= last.created_at + TURN_QUIET_MS))) return null;
    if (
      this.store.get(
        `SELECT 1 FROM web_operations WHERE principal_id=? AND world_id=? AND conversation_id=? AND ${BUSY} LIMIT 1`,
        principalId,
        worldId,
        conversationId,
      )
    )
      return null;
    const first = pending[0]!;
    const refuse = (code: string) => {
      for (const bubble of pending)
        this.store.run(
          "UPDATE web_turn_bubbles SET state='refused',refused_code=? WHERE message_id=? AND state='pending'",
          code,
          bubble.message_id,
        );
      return null;
    };
    let admitted: { operationId: string };
    try {
      // Guarded: a refusal here must not abort the caller's transaction (the bubbles are already stored).
      admitted = this.store.transaction(() =>
        this.admission.admit({
          principalId,
          requestId: `turn.${first.message_id}`,
          characterId: first.character_id,
          text: last.body,
          ipHash: first.ip_hash,
          anchor: { messageId: last.message_id, conversationId },
        }),
      );
    } catch (error) {
      const code = error instanceof DomainError ? error.code : 'TURN_NOT_ADMITTED';
      if (error instanceof RetryAfterError || TRANSIENT.has(code)) return null;
      return refuse(code);
    }
    for (const bubble of pending)
      this.store.run(
        "UPDATE web_turn_bubbles SET state='turn',operation_id=? WHERE message_id=? AND state='pending'",
        admitted.operationId,
        bubble.message_id,
      );
    this.onAdmitted?.();
    return admitted.operationId;
  }

  /** Closes every batch whose quiet period is over. Idempotent; the alarm and the timer both call it. */
  pass(now = this.clock.now()) {
    if (!webTurnsInstalled(this.store)) return 0;
    const groups = this.store.all<{ principal_id: string; world_id: string; conversation_id: string }>(
      "SELECT DISTINCT principal_id,world_id,conversation_id FROM web_turn_bubbles WHERE state='pending'",
    );
    let closed = 0;
    for (const group of groups)
      if (this.store.transaction(() => this.closeConversation(group.principal_id, group.world_id, group.conversation_id, now)))
        closed++;
    return closed;
  }

  /** The next moment `pass` has work: the quiet period of the oldest-due batch (a batch that could not close is retried later). */
  nextDue(now = this.clock.now()): number | null {
    if (!webTurnsInstalled(this.store)) return null;
    const rows = this.store.all<{ n: number; last: number }>(
      `SELECT count(*) n,max(created_at) last FROM web_turn_bubbles WHERE state='pending'
      GROUP BY principal_id,world_id,conversation_id`,
    );
    if (!rows.length) return null;
    let next = Infinity;
    for (const row of rows) {
      const due = row.n >= TURN_MAX_BUBBLES ? now : row.last + TURN_QUIET_MS;
      next = Math.min(next, due > now ? due : now + TURN_RETRY_MS);
    }
    return Number.isFinite(next) ? next : null;
  }
}

/**
 * The quotes of a set of bubbles, as the writer's request carries them (`messages[].replyTo`: who wrote the quoted message and what it
 * said, fixed by the server). Read only from the SAME conversation; a quoted message that is gone is left out. The text is cut at
 * 500 characters so a long message cannot grow the request.
 */
export function turnQuotes(
  store: Pick<WebRuntimeStore, 'all' | 'get'>,
  worldId: string,
  conversationId: string,
  messageIds: string[],
): Map<string, MessageQuote> {
  const out = new Map<string, MessageQuote>();
  if (!messageIds.length || !webTurnsInstalled(store)) return out;
  const rows = store.all<{ message_id: string; id: string; author_kind: 'player' | 'character'; author_id: string; body: string; delivery: 'text' | 'voice' }>(
    `SELECT b.message_id,q.id,q.author_kind,q.author_id,q.body,q.delivery
    FROM web_turn_bubbles b JOIN messages q ON q.id=b.quote_message_id AND q.world_id=b.world_id AND q.conversation_id=b.conversation_id
    WHERE b.world_id=? AND b.conversation_id=? AND b.message_id IN (${messageIds.map(() => '?').join(',')})`,
    worldId,
    conversationId,
    ...messageIds,
  );
  for (const row of rows)
    out.set(row.message_id, {
      id: row.id,
      authorKind: row.author_kind,
      authorId: row.author_id,
      text: [...row.body].slice(0, 500).join(''),
      delivery: row.delivery,
    });
  return out;
}
