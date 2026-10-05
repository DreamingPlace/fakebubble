import type { TextGenerationRequest } from '../../packages/contracts/index.ts';
import { topicKey } from '../../packages/domain/dialogue.ts';
import { ensure } from '../../packages/domain/errors.ts';

/** References come only from this frozen authorized context, never a model-supplied database lookup. */
export function memoryReferences(request: TextGenerationRequest): { id: string; key: string }[] {
  const memories = request.memories ?? [], corrections = request.memoryCorrections ?? [];
  ensure(Array.isArray(memories) && memories.length <= 12 && Array.isArray(corrections) && corrections.length <= 12, 'INVALID_MEMORY_CONTEXT');
  const ids = new Map<string, string>(), keys = new Map<string, string>();
  const add = (id: unknown, key: unknown) => {
    ensure(typeof id === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(id) && typeof key === 'string' &&
      key === topicKey(key) && /^[\p{L}\p{N} _.-]{1,64}$/u.test(key), 'INVALID_MEMORY_CONTEXT');
    ensure((!ids.has(id) || ids.get(id) === key) && (!keys.has(key) || keys.get(key) === id), 'INVALID_MEMORY_CONTEXT');
    ids.set(id, key); keys.set(key, id);
  };
  for (const memory of memories) { ensure(memory && typeof memory === 'object', 'INVALID_MEMORY_CONTEXT'); add(memory.id, memory.key); }
  for (const correction of corrections) { ensure(correction && typeof correction === 'object', 'INVALID_MEMORY_CONTEXT'); add(correction.memoryId, correction.topicKey); }
  return [...ids].map(([id, key]) => ({ id, key }));
}
