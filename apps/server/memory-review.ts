import { createHash, randomUUID } from 'node:crypto';
import type { CharacterScope } from '../../packages/contracts/index.ts';
import type { MemoryCorrection, MemoryCorrectionInput, MemoryCorrectionPage, MemoryCorrectionReceipt, MemoryDetail,
  MemoryEpisodeDTO, MemoryScope, MemoryTopicDTO, MemoryTopicPage } from '../../packages/contracts/memory.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { topicKey } from '../../packages/domain/dialogue.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { episodeSources } from './context-evidence.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const publicScope = (scope: CharacterScope): MemoryScope => ({ worldId: scope.worldId, conversationId: scope.conversationId, characterId: scope.characterId });
interface Catalog { seq: number; id: string; topic_key: string }
interface CorrectionRow { seq: number; id: string; topic_key: string; revision: number; request_hash: string;
  summary: string; reason: string; evidence_ids_json: string; recorded_at: number }
function identifier(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'INVALID_REQUEST');
}
function catalog(store: Store, scope: CharacterScope, id: string): Catalog {
  identifier(id); const found = store.get<Catalog>(`SELECT * FROM memory_catalog WHERE ${where} AND id=?`, ...params(scope), id);
  ensure(found, 'NOT_FOUND'); return found;
}
function correctionDTO(row: CorrectionRow, memory: Catalog): MemoryCorrection {
  return { id: row.id, memoryId: memory.id, topicKey: row.topic_key, revision: row.revision,
    summary: row.summary, reason: row.reason, evidenceMessageIds: JSON.parse(row.evidence_ids_json), recordedAt: row.recorded_at, source: 'player_correction' };
}
function latestRow(store: Store, scope: CharacterScope, key: string) {
  return store.get<CorrectionRow>(`SELECT * FROM memory_corrections WHERE ${where} AND topic_key=? ORDER BY revision DESC LIMIT 1`, ...params(scope), key);
}
function topicDTO(store: Store, scope: CharacterScope, memory: Catalog, now: number): MemoryTopicDTO {
  const row = store.get<{ tier: 'short' | 'long'; player_mentions: number; last_seen: number; active_until: number }>(
    `SELECT * FROM memory_topics WHERE ${where} AND topic_key=?`, ...params(scope), memory.topic_key);
  ensure(row, 'MEMORY_INTEGRITY_ERROR'); const latest = latestRow(store, scope, memory.topic_key);
  return { id: memory.id, key: memory.topic_key, tier: row.tier, playerMentions: row.player_mentions, lastSeenAt: row.last_seen,
    activeUntil: row.active_until, active: row.tier === 'long' || row.active_until > now, revision: latest?.revision ?? 0,
    latestCorrection: latest ? correctionDTO(latest, memory) : null };
}
export function memoryVersion(store: Store, scope: CharacterScope): number {
  return store.get<{ version: number }>(`SELECT version FROM memory_context_versions WHERE ${where}`, ...params(scope))?.version ?? 0;
}

/** Caller must authorize the participant scope. Reads never draw, promote, expire or delete memory. */
export function listMemoryTopics(store: Store, scope: CharacterScope, now: number, before: string | null): MemoryTopicPage {
  const seq = before === null ? Number.MAX_SAFE_INTEGER : catalog(store, scope, before).seq;
  const rows = store.all<Catalog>(`SELECT * FROM memory_catalog WHERE ${where} AND seq<? ORDER BY seq DESC LIMIT 26`, ...params(scope), seq);
  const items = rows.slice(0, 25).map(row => topicDTO(store, scope, row, now));
  return { scope: publicScope(scope), items, before: items.at(-1)?.id ?? before, hasMore: rows.length > 25 };
}
export function readMemoryDetail(store: Store, scope: CharacterScope, now: number, id: string, before: string | null): MemoryDetail {
  const memory = catalog(store, scope, id); let seq = Number.MAX_SAFE_INTEGER;
  if (before !== null) {
    identifier(before); const found = store.get<{ seq: number }>(`SELECT rowid seq FROM memory_episodes WHERE ${where} AND topic_key=? AND job_id=?`,
      ...params(scope), memory.topic_key, before); ensure(found, 'INVALID_CURSOR'); seq = found.seq;
  }
  const rows = store.all<{ job_id: string; summary: string; source_kind: MemoryEpisodeDTO['sourceKind']; created_at: number; evidence_ids_json: string }>(
    `SELECT * FROM memory_episodes WHERE ${where} AND topic_key=? AND rowid<? ORDER BY rowid DESC LIMIT 26`, ...params(scope), memory.topic_key, seq);
  const episodes = rows.slice(0, 25).map(row => {
    const messageIds: string[] = JSON.parse(row.evidence_ids_json);
    const excerpts = messageIds.length ? store.all<MemoryEpisodeDTO['excerpts'][number]>(
      `SELECT id,author_kind AS authorKind,author_id AS authorId,body AS text,created_at AS at FROM messages WHERE body!='' AND world_id=? AND conversation_id=? AND
        id IN (${messageIds.map(() => '?').join(',')}) ORDER BY seq DESC LIMIT 4`, scope.worldId, scope.conversationId, ...messageIds)
      .reverse().map(message => ({ ...message, text: [...message.text].slice(0, 400).join('') })) : [];
    const sources = episodeSources(store, scope, memory.topic_key, row.job_id);
    return { id: row.job_id, summary: row.summary, sourceKind: row.source_kind, at: row.created_at, messageIds, excerpts, ...(sources.length ? { sources } : {}) };
  });
  return { scope: publicScope(scope), topic: topicDTO(store, scope, memory, now), episodes,
    before: episodes.at(-1)?.id ?? before, hasMore: rows.length > 25 };
}
export function listCorrections(store: Store, scope: CharacterScope, id: string, before: string | null): MemoryCorrectionPage {
  const memory = catalog(store, scope, id); let seq = Number.MAX_SAFE_INTEGER;
  if (before !== null) {
    identifier(before); const found = store.get<{ seq: number }>(`SELECT seq FROM memory_corrections WHERE ${where} AND topic_key=? AND id=?`,
      ...params(scope), memory.topic_key, before); ensure(found, 'INVALID_CURSOR'); seq = found.seq;
  }
  const rows = store.all<CorrectionRow>(`SELECT * FROM memory_corrections WHERE ${where} AND topic_key=? AND seq<? ORDER BY seq DESC LIMIT 26`,
    ...params(scope), memory.topic_key, seq);
  const items = rows.slice(0, 25).map(row => correctionDTO(row, memory));
  return { scope: publicScope(scope), items, before: items.at(-1)?.id ?? before, hasMore: rows.length > 25 };
}

export function correctionInput(value: unknown): MemoryCorrectionInput {
  ensure(value && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
  const input = value as MemoryCorrectionInput;
  ensure(Object.keys(input).sort().join(',') === 'evidenceMessageIds,expectedRevision,reason,requestId,summary', 'INVALID_REQUEST');
  identifier(input.requestId); ensure(Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 'INVALID_REQUEST');
  for (const [text, max] of [[input.summary, 600], [input.reason, 400]] as const) ensure(typeof text === 'string' && text.trim() &&
    [...text].length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text), 'INVALID_REQUEST');
  ensure(Array.isArray(input.evidenceMessageIds) && input.evidenceMessageIds.length <= 8 &&
    new Set(input.evidenceMessageIds).size === input.evidenceMessageIds.length, 'INVALID_REQUEST');
  input.evidenceMessageIds.forEach(identifier);
  return { requestId: input.requestId, expectedRevision: input.expectedRevision, summary: input.summary.trim(), reason: input.reason.trim(),
    evidenceMessageIds: [...input.evidenceMessageIds].sort() };
}
/** Caller owns a transaction. A correction is new player-supplied evidence, never a rewrite of history or author canon. */
export function correctMemory(store: Store, scope: CharacterScope, now: number, id: string, value: unknown): MemoryCorrectionReceipt {
  const input = correctionInput(value); const memory = catalog(store, scope, id);
  const digest = createHash('sha256').update(JSON.stringify([scope.conversationId, scope.characterId, memory.id, input])).digest('hex');
  // Global request uniqueness is only an index lookup; fetch private contents after scope validation.
  const previous = store.get<{ id: string; conversation_id: string; character_id: string; topic_key: string; request_hash: string }>(
    'SELECT id,conversation_id,character_id,topic_key,request_hash FROM memory_corrections WHERE world_id=? AND request_id=?', scope.worldId, input.requestId);
  if (previous) {
    ensure(previous.conversation_id === scope.conversationId && previous.character_id === scope.characterId &&
      previous.topic_key === memory.topic_key && previous.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
    const receipt = store.get<CorrectionRow>(`SELECT * FROM memory_corrections WHERE ${where} AND id=?`, ...params(scope), previous.id)!;
    return { scope: publicScope(scope), correction: correctionDTO(receipt, memory), duplicate: true };
  }
  const latest = latestRow(store, scope, memory.topic_key);
  ensure((latest?.revision ?? 0) === input.expectedRevision, 'MEMORY_REVISION_CONFLICT');
  ensure(!latest || latest.summary !== input.summary || latest.reason !== input.reason ||
    latest.evidence_ids_json !== JSON.stringify(input.evidenceMessageIds), 'MEMORY_CORRECTION_UNCHANGED');
  for (const messageId of input.evidenceMessageIds) ensure(store.get(
    'SELECT 1 FROM messages WHERE world_id=? AND conversation_id=? AND id=?', scope.worldId, scope.conversationId, messageId), 'INVALID_MEMORY_EVIDENCE');
  const correctionId = randomUUID();
  store.run(`INSERT INTO memory_corrections(id,world_id,conversation_id,character_id,topic_key,revision,request_id,request_hash,summary,reason,evidence_ids_json,recorded_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, correctionId, ...params(scope), memory.topic_key, input.expectedRevision + 1, input.requestId,
    digest, input.summary, input.reason, JSON.stringify(input.evidenceMessageIds), now);
  store.run(`INSERT INTO memory_context_versions VALUES (?,?,?,1) ON CONFLICT(world_id,conversation_id,character_id)
    DO UPDATE SET version=version+1`, ...params(scope));
  const recorded = latestRow(store, scope, memory.topic_key)!;
  return { scope: publicScope(scope), correction: correctionDTO(recorded, memory), duplicate: false };
}

/** Separate from proactive selection: corrections do not boost mention counts or revive a proactive topic. */
export function recallCorrections(store: Store, scope: CharacterScope, query: string, preferredKeys: string[] = []): MemoryCorrection[] {
  const words = [...new Set([...new Intl.Segmenter('zh', { granularity: 'word' }).segment(topicKey(query).slice(0, 4000))]
    .filter(item => item.isWordLike && item.segment.length > 1).map(item => item.segment))].slice(0, 16);
  const score = words.length ? words.map(() => '(CASE WHEN instr(c.topic_key,?)>0 OR instr(c.summary,?)>0 THEN 1 ELSE 0 END)').join('+') : '0';
  const latest = store.all<CorrectionRow>(`SELECT c.*,(${score}) relevance FROM memory_corrections c WHERE ${where} AND NOT EXISTS
    (SELECT 1 FROM memory_corrections n WHERE n.world_id=c.world_id AND n.conversation_id=c.conversation_id AND n.character_id=c.character_id
      AND n.topic_key=c.topic_key AND n.revision>c.revision) ORDER BY relevance DESC,c.seq DESC LIMIT 12`,
    ...words.flatMap(word => [word, word]), ...params(scope));
  const preferred = [...new Set(preferredKeys)].slice(0, 12).flatMap(key => { const row = latestRow(store, scope, key); return row ? [row] : []; });
  const chosen = [...preferred, ...latest.filter(row => !preferred.some(first => first.id === row.id))].slice(0, 12);
  return chosen.map(row => {
    const memory = store.get<Catalog>(`SELECT * FROM memory_catalog WHERE ${where} AND topic_key=?`, ...params(scope), row.topic_key);
    ensure(memory, 'MEMORY_INTEGRITY_ERROR'); return correctionDTO(row, memory);
  });
}
