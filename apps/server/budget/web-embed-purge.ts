import type { BusinessStore } from '../platform/store-contract.ts';

/** Tables created by 116_memory_embeddings.sql: an older database has nothing to purge there. */
export const EMBEDDING_TABLES = ['memory_embeddings', 'web_embed_attempts'] as const;
/** Purge-list tables that older schemas lack: memory_facts (115) and the embedding tables (116). */
export const LATE_TABLES: ReadonlySet<string> = new Set(['memory_facts', ...EMBEDDING_TABLES]);
export const embeddingTableExists = (store: Pick<BusinessStore, 'get'>, table: string) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table);

/**
 * Called inside a purge transaction before the scope's embedding rows are deleted. A call that never left
 * (state not_sent) holds money that was proven unspent, so its hold is returned; a sent or UNKNOWN call keeps its
 * hold even though its row goes, exactly as an UNKNOWN hold is never released anywhere else.
 */
export function releaseUnsentEmbedHolds(
  store: Pick<BusinessStore, 'get' | 'run'>,
  worldId: string,
  conversationId?: string,
) {
  if (!embeddingTableExists(store, 'web_embed_attempts')) return;
  const held = store.get<{ held: number }>(
    `SELECT coalesce(sum(held_micros),0) held FROM web_embed_attempts
    WHERE world_id=? AND state='not_sent'${conversationId === undefined ? '' : ' AND conversation_id=?'}`,
    ...(conversationId === undefined ? [worldId] : [worldId, conversationId]),
  )!.held;
  if (held > 0)
    store.run(
      "UPDATE web_provider_spending SET held_micros=held_micros-? WHERE provider='cloudflare' AND held_micros>=?",
      held,
      held,
    );
}
