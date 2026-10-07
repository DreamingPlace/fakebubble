import type { Clock } from '../../../packages/contracts/index.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { WEB_EMBED_DEFAULT, type WebEmbedConfig } from '../../../config/web-embeddings.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { EmbeddingFailure, type EmbeddingProvider } from './embedding-provider.ts';
import { INDEX_CALL_TIMEOUT_MS, WebEmbedLedger, type IndexBatch, type QueryClaim } from './web-embed-ledger.ts';

/** A query vector lives in memory only until the request that needs it is frozen; it is never written anywhere. */
export interface QueryVector {
  operationId: string;
  model: string;
  vector: Float32Array;
  /** sha256 of the exact text that was embedded */
  digest: string;
  at: number;
}

const failureOf = (error: unknown): { code: string; known: boolean } =>
  error instanceof EmbeddingFailure
    ? { code: error.code, known: error.known }
    : { code: error instanceof DomainError ? error.code : 'EMBEDDING_FAILED', known: false };

/**
 * Embedding provider calls of the business object: topic indexing and the reply-time query embedding. The provider
 * (the Workers AI binding in the generation Worker, or the REST API locally) only returns vectors; this class reserves
 * the money, passes the send gate, and stores the outcome. A call whose result is unknown is never retried.
 */
export class WebEmbedRunner {
  readonly ledger: WebEmbedLedger;
  readonly config: WebEmbedConfig;
  private readonly provider: EmbeddingProvider;
  private readonly clock: Clock;
  constructor(
    store: BusinessStore,
    clock: Clock,
    provider: EmbeddingProvider,
    config: WebEmbedConfig = WEB_EMBED_DEFAULT,
  ) {
    this.provider = provider;
    this.clock = clock;
    this.config = config;
    this.ledger = new WebEmbedLedger(store, clock, provider.model, provider.dims);
  }
  /** Schema 116 and the allowance row exist. */
  ready() {
    return this.ledger.ready();
  }

  /** Send one claimed index batch (one request, an array of texts) and let the ledger store what comes back. */
  async index(batch: IndexBatch, signal: AbortSignal): Promise<number> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INDEX_CALL_TIMEOUT_MS);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    try {
      const result = await this.provider.embed(batch.texts, controller.signal, () =>
        this.ledger.markSent(batch.attemptId),
      );
      return this.ledger.settleIndex(batch.attemptId, result);
    } catch (error) {
      this.ledger.fail(batch.attemptId, failureOf(error));
      return 0;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
    }
  }

  /**
   * Embed the player's input for one reply, within the configured timeout. Any failure, timeout or UNKNOWN outcome returns
   * null and the reply is frozen with lexical recall only; nothing is retried, and the query is stored nowhere.
   */
  async query(claim: QueryClaim, signal: AbortSignal): Promise<QueryVector | null> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.queryTimeoutMs);
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    try {
      const result = await this.provider.embed([claim.text], controller.signal, () =>
        this.ledger.markSent(claim.attemptId),
      );
      ensure(result.vectors.length === 1, 'WEB_EMBED_RESULT_INVALID');
      this.ledger.settleQuery(claim.attemptId, result);
      return {
        operationId: claim.operationId,
        model: this.provider.model,
        vector: result.vectors[0]!,
        digest: claim.digest,
        at: this.clock.now(),
      };
    } catch (error) {
      try {
        this.ledger.fail(claim.attemptId, failureOf(error));
      } catch {
        /* The attempt was purged or already classified; the reply continues lexically either way. */
      }
      this.ledger.recordQueryFallback(timedOut);
      return null;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
}
