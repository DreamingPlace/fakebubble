import { createHash, randomUUID } from 'node:crypto';
import type { CharacterScope, DialogueCandidate, MessageDTO, RelationshipPreset } from '../../packages/contracts/index.ts';
import type { RelationshipContext, RelationshipCorrectionReceipt, RelationshipEventCandidate, RelationshipJournalItem,
  RelationshipJournalPage, RelationshipProof } from '../../packages/contracts/relationships.ts';
import { associationBaseline } from '../../packages/domain/association.ts';
import { isTrivialRelationshipInput, relationshipFingerprintText, RELATIONSHIP_POINTS, RELATIONSHIP_POLICY } from '../../packages/domain/relationships.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { localTime } from '../../packages/domain/schedule.ts';
import { characterAssociation } from './player-profile.ts';
import type { BusinessStore as Store } from './store-contract.ts';

const where = 'world_id=? AND conversation_id=? AND character_id=?';
const params = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const publicScope = (scope: CharacterScope) => ({ worldId: scope.worldId, conversationId: scope.conversationId, characterId: scope.characterId });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function identifier(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value), 'INVALID_REQUEST');
}
interface State { revision: number; trust_delta: number; familiarity_delta: number; positive_days: number; kinds_json: string }
interface EventRow {
  seq: number; id: string; event_key: string; candidate_json: string; response_id: string; trust_delta: number;
  familiarity_delta: number; local_day: string; recorded_at: number; reason: string | null; corrected_at: number | null;
}
const eventQuery = `SELECT e.*,c.reason,c.recorded_at corrected_at FROM relationship_events e LEFT JOIN relationship_corrections c
  ON c.world_id=e.world_id AND c.conversation_id=e.conversation_id AND c.character_id=e.character_id AND c.event_id=e.id
  WHERE e.world_id=? AND e.conversation_id=? AND e.character_id=?`;
const proposal = (row: EventRow): RelationshipEventCandidate => JSON.parse(row.candidate_json);
function rows(store: Store, scope: CharacterScope) { return store.all<EventRow>(`${eventQuery} ORDER BY e.seq`, ...params(scope)); }
function effects(events: EventRow[]) {
  const changes = new Map<string, { trust: number; familiarity: number }>();
  const restored = new Map<string, number>();
  for (const event of events) {
    const candidate = proposal(event);
    let trust = event.reason === null ? event.trust_delta : 0;
    const familiarity = event.reason === null ? event.familiarity_delta : 0;
    if (candidate.kind === 'repair') {
      const targetId = candidate.repairsEventId!;
      const loss = Math.max(0, -(changes.get(targetId)?.trust ?? 0));
      trust = Math.max(0, Math.min(trust, loss - (restored.get(targetId) ?? 0)));
      restored.set(targetId, (restored.get(targetId) ?? 0) + trust);
    }
    changes.set(event.id, { trust, familiarity });
  }
  return changes;
}
/** Only the current private chat contributes; shared-thread activity is not scored in this slice. */
function rebuild(store: Store, scope: CharacterScope) {
  const events = rows(store, scope), changes = effects(events);
  let trust = 0, familiarity = 0;
  const days = new Set<string>(), kinds = new Set<string>();
  for (const event of events) {
    const change = changes.get(event.id)!; trust += change.trust; familiarity += change.familiarity;
    const kind = proposal(event).kind;
    if (kind !== 'repair' && change.trust + change.familiarity > 0) { days.add(event.local_day); kinds.add(kind); }
  }
  store.run(`INSERT INTO relationship_states VALUES (?,?,1,?,?,?,?) ON CONFLICT(world_id,character_id)
    DO UPDATE SET revision=revision+1,trust_delta=excluded.trust_delta,familiarity_delta=excluded.familiarity_delta,
      positive_days=excluded.positive_days,kinds_json=excluded.kinds_json`, scope.worldId, scope.characterId,
    Math.max(RELATIONSHIP_POLICY.trustMinimum, Math.min(RELATIONSHIP_POLICY.trustMaximum, trust)),
    Math.min(RELATIONSHIP_POLICY.familiarityMaximum, familiarity), days.size, JSON.stringify([...kinds].sort()));
}
export function relationshipVersion(store: Store, scope: CharacterScope) {
  if (!isPrivate(store, scope)) return 0;
  return store.get<State>('SELECT * FROM relationship_states WHERE world_id=? AND character_id=?', scope.worldId, scope.characterId)?.revision ?? 0;
}
function isPrivate(store: Store, scope: CharacterScope) {
  return !!store.get("SELECT 1 FROM conversations WHERE world_id=? AND id=? AND kind='private' AND private_character_id=?", ...params(scope));
}
function authorizePrivate(store: Store, scope: CharacterScope) {
  ensure(store.get('SELECT 1 FROM worlds WHERE id=? AND owner_id=?', scope.worldId, scope.playerId) && isPrivate(store, scope), 'NOT_FOUND');
}
/** This slice supplies both event evidence and derived values only to the authorized private chat. */
export function relationshipContext(store: Store, scope: CharacterScope, relationship: RelationshipPreset): RelationshipContext {
  authorizePrivate(store, scope);
  const state = store.get<State>('SELECT * FROM relationship_states WHERE world_id=? AND character_id=?', scope.worldId, scope.characterId);
  const baseline = characterAssociation(store, scope.worldId, scope.characterId) ?? associationBaseline(relationship, 'online_stranger');
  const trust = Math.max(0, Math.min(100, baseline.initialTrust + (state?.trust_delta ?? 0)));
  const familiarity = Math.max(0, Math.min(100, baseline.initialFamiliarity + (state?.familiarity_delta ?? 0)));
  const positiveDays = state?.positive_days ?? 0;
  const eventKinds: RelationshipContext['eventKinds'] = JSON.parse(state?.kinds_json ?? '[]');
  const settled = baseline.initialFamiliarity >= 35 || (positiveDays >= 3 && eventKinds.length >= 2 && trust >= 20 && familiarity >= 12);
  const comfortable = baseline.initialFamiliarity >= 65 || (positiveDays >= 6 && eventKinds.length >= 3 && trust >= 35 && familiarity >= 25);
  const auditEnabled = isPrivate(store, scope);
  const recent = auditEnabled ? store.all<EventRow>(`${eventQuery} ORDER BY e.seq DESC LIMIT 12`, ...params(scope)) : [];
  const allEvents = recent.some(event => proposal(event).kind === 'trust_damage') ? rows(store, scope) : [];
  const allEffects = effects(allEvents);
  return { policyVersion: 1, revision: state?.revision ?? 0, trust, familiarity, positiveDays, eventKinds,
    openness: comfortable ? 'comfortable' : settled ? 'settling' : 'reserved', auditEnabled,
    recentEvents: recent.map(event => {
      const candidate = proposal(event);
      const repairs = allEvents.filter(item => proposal(item).repairsEventId === event.id)
        .reduce((sum, item) => sum + (allEffects.get(item.id)?.trust ?? 0), 0);
      return { id: event.id, kind: candidate.kind, key: event.event_key, summary: candidate.summary, at: event.recorded_at,
        response: { messageId: event.response_id, quote: candidate.responseQuote }, corrected: event.reason !== null,
        repairable: candidate.kind === 'trust_damage' && event.reason === null && -event.trust_delta > repairs };
    }) };
}
/** Freeze the same authorized messages supplied to review. Never resolve model-provided IDs globally. */
export function freezeRelationshipMessages(store: Store, scope: CharacterScope, jobId: string, messages: MessageDTO[]) {
  if (!isPrivate(store, scope)) return messages;
  store.run(`INSERT OR IGNORE INTO relationship_job_contexts VALUES (?,?,?,?,?)`, ...params(scope), jobId, JSON.stringify(messages));
  return frozenMessages(store, scope, jobId);
}
function frozenMessages(store: Store, scope: CharacterScope, jobId: string): MessageDTO[] {
  const context = store.get<{ messages_json: string }>(`SELECT messages_json FROM relationship_job_contexts WHERE ${where} AND job_id=?`, ...params(scope), jobId);
  return context ? JSON.parse(context.messages_json) : [];
}
function verdict(store: Store, scope: CharacterScope, jobId: string, candidate: RelationshipEventCandidate,
  covered: string[], published: MessageDTO[], events: EventRow[]) {
  const messages = frozenMessages(store, scope, jobId);
  const find = (proof: RelationshipProof) => messages.find(message => message.id === proof.messageId && message.text.includes(proof.quote));
  const anchor = find(candidate.anchor), evidence = candidate.evidence.map(find);
  const current = evidence.filter(message => message?.authorKind === 'player' && message.authorId === scope.playerId && covered.includes(message.id));
  if (!anchor || evidence.some(message => !message) || !current.length) return { rejection: 'invalid_evidence' };
  const index = messages.findIndex(message => covered.includes(message.id));
  if (index < 0 || messages.indexOf(anchor) >= index) return { rejection: 'missing_prior_anchor' };
  const response = published.find(message => message.text.includes(candidate.responseQuote));
  if (!response) return { rejection: 'unpublished_acceptance' };
  if (current.every(message => isTrivialRelationshipInput(message!.text))) return { rejection: 'trivial_input' };
  if (candidate.kind === 'promise_kept') {
    if (anchor.authorKind !== 'player' || anchor.authorId !== scope.playerId || !evidence.some(message => message?.authorKind === 'character' &&
      message.authorId === scope.characterId && messages.indexOf(message) > messages.indexOf(anchor) && messages.indexOf(message) < index)) {
      return { rejection: 'missing_prior_agreement' };
    }
  } else if (anchor.authorKind !== 'character' || anchor.authorId !== scope.characterId) return { rejection: 'invalid_anchor_author' };
  if (candidate.kind === 'repair') {
    const target = events.find(event => event.id === candidate.repairsEventId);
    if (!target || proposal(target).kind !== 'trust_damage' || target.reason !== null || target.response_id !== anchor.id || target.trust_delta >= 0) {
      return { rejection: 'no_repairable_loss' };
    }
    const changes = effects(events);
    if (events.filter(event => proposal(event).repairsEventId === target.id)
      .reduce((sum, event) => sum + (changes.get(event.id)?.trust ?? 0), 0) >= -target.trust_delta) return { rejection: 'loss_already_repaired' };
  }
  const fingerprint = hash([...new Set(current.map(message => relationshipFingerprintText(message!.text)))].sort().join('|'));
  const key = candidate.key.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
  if (store.get(`SELECT 1 FROM relationship_events WHERE ${where} AND (event_key=? OR anchor_id=? OR input_fingerprint=?)`,
    ...params(scope), key, anchor.id, fingerprint)) return { rejection: 'duplicate_event' };
  return { response, fingerprint, key };
}
/** Full reply publication and this ledger write share Engine's transaction. Failures/partial bubbles cannot earn points. */
export function recordRelationshipEvents(store: Store, scope: CharacterScope, jobId: string, dialogue: DialogueCandidate, published: MessageDTO[], now: number) {
  const candidates = dialogue.relationshipEvents ?? [];
  if (!candidates.length) return;
  const timeZone = store.get<{ time_zone: string }>('SELECT time_zone FROM worlds WHERE id=? AND owner_id=?', scope.worldId, scope.playerId)?.time_zone;
  ensure(timeZone, 'FORBIDDEN'); const day = localTime(now, timeZone).date;
  let changed = false;
  for (const [ordinal, candidate] of candidates.entries()) {
    const result = isPrivate(store, scope) ? verdict(store, scope, jobId, candidate, dialogue.coveredMessageIds, published, rows(store, scope)) : { rejection: 'shared_events_not_enabled' };
    let outcome = result.rejection ?? 'recorded';
    if (!result.rejection && 'response' in result && result.response) {
      const used = store.get<{ positive_used: number; negative_used: number }>(
        'SELECT * FROM relationship_daily_budgets WHERE world_id=? AND character_id=? AND local_day=?', scope.worldId, scope.characterId, day);
      const points = RELATIONSHIP_POINTS[candidate.kind];
      const available = candidate.kind === 'trust_damage' ? RELATIONSHIP_POLICY.dailyNegative - (used?.negative_used ?? 0) :
        RELATIONSHIP_POLICY.dailyPositive - (used?.positive_used ?? 0);
      const amount = Math.max(0, Math.min(Math.abs(points.trust) + points.familiarity, available));
      const trust = Math.sign(points.trust) * amount, familiarity = points.familiarity ? amount : 0;
      if (!amount) outcome = 'daily_cap';
      store.run(`INSERT INTO relationship_events(id,world_id,conversation_id,character_id,job_id,event_key,anchor_id,input_fingerprint,
        candidate_json,response_id,trust_delta,familiarity_delta,local_day,policy_version,review_version,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        randomUUID(), ...params(scope), jobId, result.key!, candidate.anchor.messageId, result.fingerprint!, JSON.stringify(candidate), result.response.id,
        trust, familiarity, day, RELATIONSHIP_POLICY.version, 'independent_relationship_audit_v1', now);
      store.run(`INSERT INTO relationship_daily_budgets VALUES (?,?,?,?,?) ON CONFLICT(world_id,character_id,local_day)
        DO UPDATE SET positive_used=positive_used+excluded.positive_used,negative_used=negative_used+excluded.negative_used`,
        scope.worldId, scope.characterId, day, trust + familiarity > 0 ? amount : 0, trust < 0 ? amount : 0);
      changed = true;
    }
    store.run('INSERT INTO relationship_reviews VALUES (?,?,?,?,?,?,?,?)', ...params(scope), jobId, ordinal, JSON.stringify(candidate), outcome, now);
  }
  if (changed) rebuild(store, scope);
}
function item(event: EventRow): RelationshipJournalItem {
  const candidate = proposal(event);
  return { id: event.id, kind: candidate.kind, summary: candidate.summary, basis: candidate.basis, at: event.recorded_at,
    anchor: candidate.anchor, evidence: candidate.evidence, response: { messageId: event.response_id, quote: candidate.responseQuote },
    counted: !!(event.trust_delta || event.familiarity_delta),
    correction: event.reason === null ? null : { reason: event.reason, at: event.corrected_at! } };
}
export function listRelationshipEvents(store: Store, scope: CharacterScope, before: string | null): RelationshipJournalPage {
  authorizePrivate(store, scope); let seq = Number.MAX_SAFE_INTEGER;
  if (before !== null) {
    identifier(before); const cursor = store.get<{ seq: number }>(`SELECT seq FROM relationship_events WHERE ${where} AND id=?`, ...params(scope), before);
    ensure(cursor, 'INVALID_CURSOR'); seq = cursor.seq;
  }
  const page = store.all<EventRow>(`${eventQuery} AND e.seq<? ORDER BY e.seq DESC LIMIT 26`, ...params(scope), seq);
  const items = page.slice(0, 25).map(item);
  return { scope: publicScope(scope), items, before: items.at(-1)?.id ?? before, hasMore: page.length > 25 };
}
/** Append a player's disputed-event record. It retracts contribution, not the conversation or original evidence. */
export function correctRelationshipEvent(store: Store, scope: CharacterScope, id: string, input: unknown, now: number): RelationshipCorrectionReceipt {
  identifier(id);
  ensure(input !== null && typeof input === 'object' && !Array.isArray(input) &&
    Object.keys(input).sort().join(',') === 'expectedRevision,reason,requestId', 'INVALID_REQUEST');
  const value = input as { requestId: unknown; expectedRevision: unknown; reason: unknown }; identifier(value.requestId);
  ensure(value.expectedRevision === 0 && typeof value.reason === 'string' && value.reason.trim().length > 0 &&
    [...value.reason].length <= 400 && !/[\u0000-\u001f]/u.test(value.reason), 'INVALID_REQUEST');
  const reason = value.reason.trim(), requestId = value.requestId;
  const digest = hash(JSON.stringify([scope.conversationId, scope.characterId, id, reason]));
  return store.transaction(() => {
    authorizePrivate(store, scope);
    const previous = store.get<{ event_id: string; conversation_id: string; character_id: string; request_hash: string }>(
      'SELECT event_id,conversation_id,character_id,request_hash FROM relationship_corrections WHERE world_id=? AND request_id=?', scope.worldId, requestId);
    if (previous) {
      ensure(previous.conversation_id === scope.conversationId && previous.character_id === scope.characterId && previous.event_id === id && previous.request_hash === digest, 'IDEMPOTENCY_CONFLICT');
      const receipt = store.get<{ reason: string; recorded_at: number }>(`SELECT reason,recorded_at FROM relationship_corrections WHERE ${where} AND event_id=?`, ...params(scope), id)!;
      return { scope: publicScope(scope), eventId: id, revision: 1, reason: receipt.reason, at: receipt.recorded_at, duplicate: true };
    }
    const event = store.get<EventRow>(`${eventQuery} AND e.id=?`, ...params(scope), id);
    ensure(event, 'NOT_FOUND'); ensure(event.reason === null, 'RELATIONSHIP_REVISION_CONFLICT');
    store.run('INSERT INTO relationship_corrections VALUES (?,?,?,?,?,?,?,?)', ...params(scope), id, requestId, digest, reason, now);
    rebuild(store, scope);
    return { scope: publicScope(scope), eventId: id, revision: 1, reason, at: now, duplicate: false };
  });
}
export function resetRelationshipState(store: Store, worldId: string, characterId: string) {
  // Daily budgets deliberately survive the test reset; they contain no dialogue or relationship evidence.
  store.run(`INSERT INTO relationship_states VALUES (?,?,1,0,0,0,'[]') ON CONFLICT(world_id,character_id)
    DO UPDATE SET revision=revision+1,trust_delta=0,familiarity_delta=0,positive_days=0,kinds_json='[]'`, worldId, characterId);
}
