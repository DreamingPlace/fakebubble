import { randomUUID } from 'node:crypto';
import type { CharacterScope, Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { requireWebContent } from '../admission/web-retention.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { currentTopicText, embeddingHash, packVector, scopeHasVectors } from '../memory/memory-embeddings.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { userStore } from '../platform/store-boundary.ts';
import {
  EMBEDDING_DIMS,
  EMBEDDING_MAX_TEXTS,
  EMBEDDING_MODEL,
  EMBEDDING_PRICE_MICROS_PER_MILLION_TOKENS,
  embeddingMicros,
  estimateEmbeddingTokens,
  type EmbeddingResult,
} from './embedding-provider.ts';
import { embeddingTableExists } from '../budget/web-embed-purge.ts';

/** Embedding spend is Cloudflare's, not DeepSeek's or Fish's: its own row in web_provider_spending. */
export const EMBED_PROVIDER = 'cloudflare';
/** A safety ceiling, not a target: 1 USD is billions of tokens at the pinned price, a runaway loop hits it first. */
export const EMBED_LIMIT_MICROS = 1_000_000;
/** An index call carries at most this many topics (one scope per call). */
export const INDEX_BATCH = EMBEDDING_MAX_TEXTS;
/** A known failure leaves its scope's topics pending, but not before this long has passed. */
export const INDEX_RETRY_MS = 60_000;
/** With nothing pending, the scan over every scope is not repeated sooner than this unless a publication committed. */
export const INDEX_IDLE_MS = 60_000;
/** The runner aborts an index call after this; the attempt lease covers a crash, never a live call. */
export const INDEX_CALL_TIMEOUT_MS = 20_000;
export const INDEX_LEASE_MS = 30_000;
const QUERY_LEASE_GRACE_MS = 5_000;
const SCAN_ROWS = 64;

export interface EmbedItem {
  /** world, conversation, character, topic key, the latest episode the text came from, sha256 of the exact text */
  w: string;
  c: string;
  ch: string;
  key: string;
  seq: number;
  hash: string;
}
export interface IndexBatch {
  attemptId: string;
  texts: string[];
  items: EmbedItem[];
}
export interface QueryClaim {
  attemptId: string;
  operationId: string;
  text: string;
  /** sha256 of the exact text: the frozen request refuses a vector computed for any other text. */
  digest: string;
}
export type FailureKind = 'released' | 'known' | 'unknown';
type Attempt = {
  id: string;
  kind: 'index' | 'query';
  world_id: string;
  conversation_id: string;
  character_id: string;
  operation_id: string | null;
  model: string;
  texts: number;
  max_units: number;
  held_micros: number;
  items_json: string | null;
  state: 'not_sent' | 'sent' | 'unknown' | 'known';
  lease_expires_at: number;
};
type Counter = 'calls' | 'texts' | 'failures' | 'unknowns' | 'query_fallbacks' | 'query_timeouts';

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const openStates = "('not_sent','sent')";

/** The text of a reply-time query: the player's input, bounded. Never stored. */
export const queryText = (body: string) => [...body].slice(0, 500).join('');

/**
 * Dispatch ledger and budget of the embedding provider calls (phase 'embed'). Every call is written down and its money
 * held BEFORE it can be sent; sent -> known | unknown. A known failure returns the hold; an UNKNOWN call keeps it and is
 * never sent again. Only the business object writes here; a provider never sees this database.
 */
export class WebEmbedLedger {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  readonly model: string;
  readonly dims: number;
  constructor(store: BusinessStore, clock: Clock, model = EMBEDDING_MODEL, dims = EMBEDDING_DIMS) {
    this.store = store;
    this.clock = clock;
    this.model = model;
    this.dims = dims;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  /** Schema 116 is applied. */
  available() {
    return (
      embeddingTableExists(this.store, 'web_embed_attempts') && embeddingTableExists(this.store, 'memory_embeddings')
    );
  }
  /** Idempotent: the embedding allowance row exists. Never raises or resets an existing limit. */
  ensureBudget(limitMicros = EMBED_LIMIT_MICROS) {
    ensure(this.available(), 'WEB_EMBEDDING_MIGRATION_REQUIRED');
    ensure(
      Number.isSafeInteger(limitMicros) && limitMicros > 0 && limitMicros <= 3_000_000,
      'WEB_PROVIDER_BUDGET_INVALID',
    );
    this.store.run(
      "INSERT OR IGNORE INTO web_provider_spending(provider,currency,limit_micros) VALUES (?,'USD',?)",
      EMBED_PROVIDER,
      limitMicros,
    );
  }
  /** Embedding is configured: schema 116 and the allowance row. */
  ready() {
    return this.available() && !!this.store.get('SELECT 1 FROM web_provider_spending WHERE provider=?', EMBED_PROVIDER);
  }
  private bump(counter: Counter, n = 1) {
    this.store.run(
      `INSERT INTO web_embed_metrics(day,${counter}) VALUES (?,?)
      ON CONFLICT(day) DO UPDATE SET ${counter}=${counter}+excluded.${counter}`,
      dayOf(this.now()),
      n,
    );
  }
  /** A reply continued without semantic recall (failed, unknown or timed-out query embedding). */
  recordQueryFallback(timeout: boolean) {
    this.store.transaction(() => {
      this.bump('query_fallbacks');
      if (timeout) this.bump('query_timeouts');
    });
  }
  private openCount() {
    return this.store.get<{ n: number }>(`SELECT count(*) n FROM web_embed_attempts WHERE state IN ${openStates}`)!.n;
  }
  attempt(id: string) {
    return this.store.get<Attempt>('SELECT * FROM web_embed_attempts WHERE id=?', id);
  }

  /** Hold the money, then record the call. Both or neither (the caller owns the transaction). */
  private reserve(
    kind: 'index' | 'query',
    scope: { w: string; c: string; ch: string },
    operationId: string | null,
    texts: string[],
    items: EmbedItem[] | null,
    leaseMs: number,
  ) {
    const now = this.now();
    const tokens = estimateEmbeddingTokens(texts);
    const held = embeddingMicros(tokens);
    ensure(
      this.store.run(
        `UPDATE web_provider_spending SET held_micros=held_micros+?
        WHERE provider=? AND currency='USD' AND (limit_micros IS NULL OR held_micros+spent_micros+?<=limit_micros)`,
        held,
        EMBED_PROVIDER,
        held,
      ).changes === 1,
      'WEB_PROVIDER_BUDGET_EXHAUSTED',
    );
    const id = randomUUID();
    this.store.run(
      `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,operation_id,model,texts,max_units,
      price_micros_per_million,held_micros,items_json,state,lease_expires_at,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'not_sent',?,?)`,
      id,
      kind,
      scope.w,
      scope.c,
      scope.ch,
      operationId,
      this.model,
      texts.length,
      tokens,
      EMBEDDING_PRICE_MICROS_PER_MILLION_TOKENS,
      held,
      items ? JSON.stringify(items) : null,
      now + leaseMs,
      now,
    );
    return id;
  }

  /** Scopes whose principal may have content now: not a guest (guests are never recalled), not deleted, not purging. */
  private authorized(worldId: string, characterId: string) {
    const principal = this.store.get<{ id: string; kind: string }>(
      'SELECT id,kind FROM web_principals WHERE world_id=?',
      worldId,
    );
    if (!principal || principal.kind === 'guest' || webCharacterDeleted(this.store, characterId)) return false;
    try {
      requireWebContent(this.store, this.clock, principal.id, worldId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Claim the pending topics of ONE scope (at most INDEX_BATCH) and hold the money for one embedding call.
   * 'busy': every embedding slot is taken. null: nothing is pending. Pending means: no ready vector or UNKNOWN mark for
   * the topic's current text (its latest episode) and the scope has no call in flight or recently failed. Called after a
   * publication has committed, never inside the publication transaction.
   */
  claimIndexBatch(maxRunning: number): IndexBatch | 'busy' | null {
    if (!this.ready()) return null;
    return this.store.transaction(() => {
      // Queries keep one slot of their own whenever there is more than one.
      if (this.openCount() >= Math.max(1, maxRunning - 1)) return 'busy';
      const now = this.now();
      const rows = this.store.all<{
        world_id: string;
        conversation_id: string;
        character_id: string;
        topic_key: string;
      }>(
        `WITH latest AS (SELECT t.world_id,t.conversation_id,t.character_id,t.topic_key,t.last_seen,
          (SELECT e.rowid FROM memory_episodes e WHERE e.world_id=t.world_id AND e.conversation_id=t.conversation_id
            AND e.character_id=t.character_id AND e.topic_key=t.topic_key
            ORDER BY e.created_at DESC,e.rowid DESC LIMIT 1) seq FROM memory_topics t
          JOIN web_principals p ON p.world_id=t.world_id AND p.kind<>'guest')
        SELECT l.world_id,l.conversation_id,l.character_id,l.topic_key FROM latest l
        LEFT JOIN memory_embeddings m ON m.world_id=l.world_id AND m.conversation_id=l.conversation_id
          AND m.character_id=l.character_id AND m.topic_key=l.topic_key AND m.model=?
        WHERE l.seq IS NOT NULL AND (m.topic_key IS NULL OR m.source_seq<>l.seq)
          AND NOT EXISTS (SELECT 1 FROM web_embed_attempts a WHERE a.kind='index' AND a.world_id=l.world_id
            AND a.conversation_id=l.conversation_id AND a.character_id=l.character_id
            AND (a.state IN ${openStates} OR (a.state='known' AND a.outcome IN ('failed','not_dispatched') AND a.settled_at>?)))
        ORDER BY l.last_seen DESC,l.world_id,l.conversation_id,l.character_id,l.topic_key LIMIT ?`,
        this.model,
        now - INDEX_RETRY_MS,
        SCAN_ROWS,
      );
      const seen = new Set<string>();
      for (const first of rows) {
        const scopeKey = JSON.stringify([first.world_id, first.conversation_id, first.character_id]);
        if (seen.has(scopeKey)) continue;
        seen.add(scopeKey);
        if (!this.authorized(first.world_id, first.character_id)) continue;
        const scope: CharacterScope = {
          playerId: '',
          worldId: first.world_id,
          conversationId: first.conversation_id,
          characterId: first.character_id,
        };
        const items: EmbedItem[] = [];
        const texts: string[] = [];
        for (const row of rows) {
          if (items.length >= INDEX_BATCH) break;
          if (
            row.world_id !== scope.worldId ||
            row.conversation_id !== scope.conversationId ||
            row.character_id !== scope.characterId
          )
            continue;
          const current = currentTopicText(userStore(this.store), scope, row.topic_key);
          if (!current) continue;
          items.push({
            w: scope.worldId,
            c: scope.conversationId,
            ch: scope.characterId,
            key: row.topic_key,
            seq: current.seq,
            hash: current.hash,
          });
          texts.push(current.text);
        }
        if (!items.length) continue;
        const attemptId = this.reserve(
          'index',
          { w: scope.worldId, c: scope.conversationId, ch: scope.characterId },
          null,
          texts,
          items,
          INDEX_LEASE_MS,
        );
        return { attemptId, texts, items };
      }
      return null;
    });
  }

  /** Operations whose reply could use a query embedding: queued, not yet frozen, scope has vectors, no call ever made. */
  queryCandidates(limit: number): string[] {
    if (!this.ready()) return [];
    const now = this.now();
    return this.store
      .all<{ id: string }>(
        `SELECT o.id FROM web_operations o JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
        WHERE o.status='queued' AND o.quota_state='reserved' AND o.text_queued_at IS NOT NULL AND o.text_queued_at<=?
          AND o.deadline_at>? AND p.kind<>'guest'
          AND NOT EXISTS (SELECT 1 FROM web_v7_requests r WHERE r.operation_id=o.id)
          AND NOT EXISTS (SELECT 1 FROM web_embed_attempts a WHERE a.kind='query' AND a.operation_id=o.id)
          AND EXISTS (SELECT 1 FROM memory_embeddings m WHERE m.world_id=o.world_id AND m.conversation_id=o.conversation_id
            AND m.character_id=o.character_id AND m.model=? AND m.state='ready')
        ORDER BY o.admission_seq LIMIT ?`,
        now,
        now,
        this.model,
        limit,
      )
      .map((row) => row.id);
  }

  /**
   * Hold the money and record the one query embedding this operation may ever have. null when it must proceed
   * lexically: no free slot, a guest, no vectors, an operation that moved on, or an exhausted allowance.
   */
  claimQuery(operationId: string, maxRunning: number, timeoutMs: number): QueryClaim | null {
    if (!this.ready()) return null;
    return this.store.transaction(() => {
      if (this.openCount() >= maxRunning) return null;
      const now = this.now();
      const op = this.store.get<{
        principal_id: string;
        world_id: string;
        conversation_id: string;
        character_id: string;
        input_message_id: string;
        player_id: string;
        kind: string;
      }>(
        `SELECT o.principal_id,o.world_id,o.conversation_id,o.character_id,o.input_message_id,p.player_id,p.kind
        FROM web_operations o JOIN web_principals p ON p.id=o.principal_id AND p.world_id=o.world_id
        WHERE o.id=? AND o.status='queued' AND o.quota_state='reserved' AND o.deadline_at>?
          AND NOT EXISTS (SELECT 1 FROM web_v7_requests r WHERE r.operation_id=o.id)
          AND NOT EXISTS (SELECT 1 FROM web_embed_attempts a WHERE a.kind='query' AND a.operation_id=o.id)`,
        operationId,
        now,
      );
      if (!op || op.kind === 'guest' || !this.authorized(op.world_id, op.character_id)) return null;
      const scope: CharacterScope = {
        playerId: op.player_id,
        worldId: op.world_id,
        conversationId: op.conversation_id,
        characterId: op.character_id,
      };
      if (!scopeHasVectors(userStore(this.store), scope, this.model)) return null;
      // The input message of THIS operation, in THIS conversation, written by this player: the same row the input
      // snapshot freezes. Nothing else is ever sent.
      const input = this.store.get<{ body: string }>(
        `SELECT body FROM messages WHERE id=? AND world_id=? AND conversation_id=? AND author_kind='player' AND author_id=?`,
        op.input_message_id,
        op.world_id,
        op.conversation_id,
        op.player_id,
      );
      const text = input ? queryText(input.body) : '';
      if (!text) return null;
      let attemptId: string;
      try {
        // A savepoint: an exhausted allowance leaves no trace and the reply simply continues lexically.
        attemptId = this.store.transaction(() =>
          this.reserve(
            'query',
            { w: op.world_id, c: op.conversation_id, ch: op.character_id },
            operationId,
            [text],
            null,
            timeoutMs + QUERY_LEASE_GRACE_MS,
          ),
        );
      } catch {
        return null;
      }
      return { attemptId, operationId, text, digest: embeddingHash(text) };
    });
  }

  /** The send boundary: after this returns the bytes may leave. Fails (and the caller sends nothing) when the lease is gone. */
  markSent(attemptId: string) {
    this.store.transaction(() => {
      const now = this.now();
      ensure(
        this.store.run(
          `UPDATE web_embed_attempts SET state='sent',sent_at=? WHERE id=? AND state='not_sent' AND lease_expires_at>?`,
          now,
          attemptId,
          now,
        ).changes === 1,
        'WEB_EMBED_ATTEMPT_STALE',
      );
      this.bump('calls');
    });
  }

  private settleMoney(row: Attempt, charged: number) {
    ensure(
      this.store.run(
        'UPDATE web_provider_spending SET held_micros=held_micros-?,spent_micros=spent_micros+? WHERE provider=? AND held_micros>=?',
        row.held_micros,
        charged,
        EMBED_PROVIDER,
        row.held_micros,
      ).changes === 1,
      'WEB_EMBED_BUDGET_CORRUPT',
    );
  }
  private charge(row: Attempt, result: EmbeddingResult) {
    const usage = result.usageTokens ?? row.max_units;
    const charged = Math.min(embeddingMicros(usage), row.held_micros);
    return {
      usage,
      charged,
      receipt: JSON.stringify({
        requestId: result.requestId,
        texts: row.texts,
        dims: this.dims,
        usageTokens: result.usageTokens,
        estimated: result.usageTokens === null,
        capped: embeddingMicros(usage) > row.held_micros,
      }),
    };
  }

  /**
   * The call returned: write the vectors, the bill and the receipt in ONE transaction. Vectors are written only for topics
   * that still exist in an authorized scope; a topic that changed meanwhile keeps the stamp of the text that was embedded,
   * so it is pending again. Returns how many vectors were stored.
   */
  settleIndex(attemptId: string, result: EmbeddingResult): number {
    return this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row && row.kind === 'index' && row.state === 'sent' && row.items_json !== null, 'WEB_EMBED_ATTEMPT_STALE');
      const items = JSON.parse(row.items_json) as EmbedItem[];
      ensure(
        result.vectors.length === items.length && result.vectors.every((vector) => vector.length === this.dims),
        'WEB_EMBED_RESULT_INVALID',
      );
      const now = this.now();
      let stored = 0;
      items.forEach((item, i) => {
        if (
          !this.store.get(
            'SELECT 1 FROM memory_topics WHERE world_id=? AND conversation_id=? AND character_id=? AND topic_key=?',
            item.w,
            item.c,
            item.ch,
            item.key,
          ) ||
          !this.authorized(item.w, item.ch)
        )
          return;
        const unit = normalized(result.vectors[i]!);
        this.store.run(
          `INSERT INTO memory_embeddings(world_id,conversation_id,character_id,topic_key,model,dims,vector,content_hash,
          source_seq,state,created_at) VALUES (?,?,?,?,?,?,?,?,?,'ready',?)
          ON CONFLICT(world_id,conversation_id,character_id,topic_key,model) DO UPDATE SET dims=excluded.dims,
          vector=excluded.vector,content_hash=excluded.content_hash,source_seq=excluded.source_seq,state='ready',
          created_at=excluded.created_at`,
          item.w,
          item.c,
          item.ch,
          item.key,
          this.model,
          this.dims,
          packVector(unit),
          item.hash,
          item.seq,
          now,
        );
        stored++;
      });
      const bill = this.charge(row, result);
      this.store.run(
        `UPDATE web_embed_attempts SET state='known',outcome='succeeded',usage_units=?,charged_micros=?,receipt_json=?,
        items_json=NULL,settled_at=? WHERE id=?`,
        bill.usage,
        bill.charged,
        bill.receipt,
        now,
        attemptId,
      );
      this.settleMoney(row, bill.charged);
      this.bump('texts', stored);
      return stored;
    });
  }

  /** The reply-time call returned. Nothing about the text or the vector is stored. */
  settleQuery(attemptId: string, result: EmbeddingResult) {
    this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row && row.kind === 'query' && row.state === 'sent', 'WEB_EMBED_ATTEMPT_STALE');
      ensure(result.vectors.length === 1 && result.vectors[0]!.length === this.dims, 'WEB_EMBED_RESULT_INVALID');
      const bill = this.charge(row, result);
      this.store.run(
        `UPDATE web_embed_attempts SET state='known',outcome='succeeded',usage_units=?,charged_micros=?,receipt_json=?,
        settled_at=? WHERE id=?`,
        bill.usage,
        bill.charged,
        bill.receipt,
        this.now(),
        attemptId,
      );
      this.settleMoney(row, bill.charged);
      this.bump('texts');
    });
  }

  private close(row: Attempt, outcome: 'failed' | 'not_dispatched', code: string) {
    this.store.run(
      `UPDATE web_embed_attempts SET state='known',outcome=?,usage_units=0,charged_micros=0,receipt_json=?,items_json=NULL,
      settled_at=? WHERE id=? AND state IN ${openStates}`,
      outcome,
      JSON.stringify({ code }),
      this.now(),
      row.id,
    );
    this.settleMoney(row, 0);
  }

  /** Release a call proven never to have left (its gate refused, or its lease ran out first). */
  releaseUnsent(attemptId: string, code: string) {
    this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row && row.state === 'not_sent', 'WEB_EMBED_ATTEMPT_STALE');
      this.close(row, 'not_dispatched', code);
    });
  }

  /** The provider rejected the call before running it: nothing billed, the hold returns, the topics stay pending. */
  failKnown(attemptId: string, code: string) {
    this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row && row.state === 'sent', 'WEB_EMBED_ATTEMPT_STALE');
      this.close(row, 'failed', code);
      this.bump('failures');
    });
  }

  /**
   * The outcome is not known. The hold stays, the call is never sent again, and the topics it carried are marked
   * 'unknown': lexical-only until their text changes (a new latest episode is new work).
   */
  markUnknown(attemptId: string) {
    this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row && (row.state === 'sent' || row.state === 'unknown'), 'WEB_EMBED_ATTEMPT_STALE');
      if (row.state === 'sent') {
        this.store.run("UPDATE web_embed_attempts SET state='unknown' WHERE id=? AND state='sent'", attemptId);
        this.bump('unknowns');
      }
      if (row.items_json === null) return;
      const now = this.now();
      for (const item of JSON.parse(row.items_json) as EmbedItem[]) {
        if (
          !this.store.get(
            'SELECT 1 FROM memory_topics WHERE world_id=? AND conversation_id=? AND character_id=? AND topic_key=?',
            item.w,
            item.c,
            item.ch,
            item.key,
          )
        )
          continue;
        this.store.run(
          `INSERT INTO memory_embeddings(world_id,conversation_id,character_id,topic_key,model,dims,vector,content_hash,
          source_seq,state,created_at) VALUES (?,?,?,?,?,?,NULL,?,?,'unknown',?)
          ON CONFLICT(world_id,conversation_id,character_id,topic_key,model) DO UPDATE SET dims=excluded.dims,vector=NULL,
          content_hash=excluded.content_hash,source_seq=excluded.source_seq,state='unknown',created_at=excluded.created_at`,
          item.w,
          item.c,
          item.ch,
          item.key,
          this.model,
          this.dims,
          item.hash,
          item.seq,
          now,
        );
      }
      this.store.run('UPDATE web_embed_attempts SET items_json=NULL WHERE id=?', attemptId);
    });
  }

  /** After a failed call: decide from what the ledger knows, never from the error alone. */
  fail(attemptId: string, failure: { code: string; known: boolean }): FailureKind {
    return this.store.transaction(() => {
      const row = this.attempt(attemptId);
      ensure(row, 'WEB_EMBED_ATTEMPT_STALE');
      if (row.state === 'not_sent') {
        this.releaseUnsent(attemptId, failure.code);
        return 'released' as const;
      }
      if (row.state === 'known') return 'known' as const;
      if (failure.known && row.state === 'sent') {
        this.failKnown(attemptId, failure.code);
        return 'known' as const;
      }
      this.markUnknown(attemptId);
      return 'unknown' as const;
    });
  }

  /**
   * Calls whose lease ran out (a crashed or evicted process): one that never reached 'sent' is released, one that did is
   * UNKNOWN. Cheap when nothing is stale.
   */
  recover(): number {
    if (!this.available()) return 0;
    const stale = this.store.all<{ id: string; state: string }>(
      `SELECT id,state FROM web_embed_attempts WHERE state IN ${openStates} AND lease_expires_at<=?`,
      this.now(),
    );
    for (const { id, state } of stale) {
      if (state === 'not_sent') this.releaseUnsent(id, 'EMBED_LEASE_EXPIRED');
      else this.markUnknown(id);
    }
    return stale.length;
  }
}

function normalized(vector: Float32Array) {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);
  ensure(norm > 0 && Number.isFinite(norm), 'WEB_EMBED_RESULT_INVALID');
  return vector.map((value) => value / norm);
}

/**
 * The next time something must happen without a request: a call's lease running out (crash recovery), or a failed
 * scope's retry wait ending. Only future times are returned for the retry, so an old failure never keeps an alarm alive.
 */
export function webEmbedNextDue(store: BusinessStore, now: number): number | null {
  if (!embeddingTableExists(store, 'web_embed_attempts')) return null;
  const open = store.get<{ due: number | null }>(
    `SELECT min(lease_expires_at) due FROM web_embed_attempts WHERE state IN ${openStates}`,
  )?.due;
  const retry = store.get<{ due: number | null }>(
    `SELECT min(settled_at) due FROM web_embed_attempts
    WHERE kind='index' AND state='known' AND outcome IN ('failed','not_dispatched') AND settled_at+?>?`,
    INDEX_RETRY_MS,
    now,
  )?.due;
  const times = [open, retry == null ? null : retry + INDEX_RETRY_MS].filter((value): value is number => value != null);
  return times.length ? Math.max(now, Math.min(...times)) : null;
}
