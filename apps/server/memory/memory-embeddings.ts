import { createHash } from 'node:crypto';
import type { CharacterScope } from '../../../packages/contracts/index.ts';
import { RECALL_SEMANTIC } from '../../../packages/domain/dialogue.ts';
import type { UserStore as Store } from '../platform/store-boundary.ts';

/** Topic vectors live in `memory_embeddings` (116): float32 little-endian, scoped like every other memory row. */
const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;

/** Embedded text is bounded by code points so even four-byte characters stay under the provider's byte limit. */
const TEXT_CODE_POINTS = 1000;

/** What is embedded for a topic: its key and its latest episode summary. */
export function embeddingText(topicKey: string, summary: string): string {
  return [...`${topicKey}\n${summary}`].slice(0, TEXT_CODE_POINTS).join('');
}
export const embeddingHash = (text: string) => createHash('sha256').update(text).digest('hex');

export function packVector(vector: Float32Array): Buffer {
  const out = Buffer.alloc(vector.length * 4);
  vector.forEach((value, i) => out.writeFloatLE(value, i * 4));
  return out;
}
export function unpackVector(bytes: Uint8Array, dims: number): Float32Array | null {
  if (bytes.byteLength !== dims * 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Cosine similarity of two same-width vectors; 0 when either has no length or the widths differ. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** (cosine − τ) / (1 − τ) clamped to [0, 1]: a cosine at or below τ means "not related". */
export function semanticRelevance(cosineValue: number, tau = RECALL_SEMANTIC.tau): number {
  return Math.min(1, Math.max(0, (cosineValue - tau) / (1 - tau)));
}

/** memory_embeddings exists from schema 116; an older database has no vectors and recalls lexically only. */
export function hasEmbeddings(store: Store, scope: CharacterScope) {
  return !!store.get(scope, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='memory_embeddings'");
}

/** True when this scope has at least one ready vector of the model: only then is a query worth embedding. */
export function scopeHasVectors(store: Store, scope: CharacterScope, model: string) {
  return (
    hasEmbeddings(store, scope) &&
    !!store.get(
      scope,
      `SELECT 1 FROM memory_embeddings WHERE ${where} AND model=? AND state='ready' LIMIT 1`,
      ...params(scope),
      model,
    )
  );
}

/**
 * Ready vectors of one scope and model, newest topics first, at most RECALL_SEMANTIC.topics. Every query carries the
 * scope's three ids: a vector of another player, conversation or character can never be read through this function.
 */
export function scopeVectors(
  store: Store,
  scope: CharacterScope,
  model: string,
  dims: number,
  limit = RECALL_SEMANTIC.topics,
): { topicKey: string; vector: Float32Array }[] {
  if (!hasEmbeddings(store, scope)) return [];
  const out: { topicKey: string; vector: Float32Array }[] = [];
  for (const row of store.all<{ topic_key: string; vector: Uint8Array }>(
    scope,
    `SELECT e.topic_key,e.vector FROM memory_embeddings e
    JOIN memory_topics t ON t.world_id=e.world_id AND t.conversation_id=e.conversation_id
      AND t.character_id=e.character_id AND t.topic_key=e.topic_key
    WHERE e.world_id=? AND e.conversation_id=? AND e.character_id=? AND e.model=? AND e.state='ready' AND e.dims=?
    ORDER BY t.last_seen DESC,e.topic_key LIMIT ?`,
    ...params(scope),
    model,
    dims,
    limit,
  )) {
    const vector = unpackVector(row.vector, dims);
    if (vector) out.push({ topicKey: row.topic_key, vector });
  }
  return out;
}

/** Cosine of the query against each of the scope's ready vectors, by topic key. */
export function semanticCosines(
  store: Store,
  scope: CharacterScope,
  query: { model: string; vector: Float32Array },
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const { topicKey, vector } of scopeVectors(store, scope, query.model, query.vector.length))
    scores.set(topicKey, cosine(query.vector, vector));
  return scores;
}

/** The text a topic is embedded as now, with the id of the episode it comes from (the staleness stamp). */
export function currentTopicText(store: Store, scope: CharacterScope, topicKey: string) {
  const row = store.get<{ seq: number; summary: string }>(
    scope,
    `SELECT rowid seq,summary FROM memory_episodes WHERE ${where} AND topic_key=?
    ORDER BY created_at DESC,rowid DESC LIMIT 1`,
    ...params(scope),
    topicKey,
  );
  if (!row) return null;
  const text = embeddingText(topicKey, row.summary);
  return { seq: row.seq, text, hash: embeddingHash(text) };
}
