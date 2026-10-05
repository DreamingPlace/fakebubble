import { createHash, randomInt, randomUUID } from 'node:crypto';
import { playerSuspended } from './beta-accounts.ts';
import type { CharacterScope, CharacterSelection, CharacterTemplate, Clock, DialogueCandidate, MessageDTO, PlayerContext,
  RandomSource, RelationshipPreset, ReplyCandidate, TextGenerationRequest } from '../../packages/contracts/index.ts';
import { RULES } from '../../packages/domain/defaults.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { advanceSession, catchUpAt, closeSession, emptySession, localTime, slotAt,
  validateSchedule } from '../../packages/domain/schedule.ts';
import type { SessionState } from '../../packages/domain/schedule.ts';
import type { BusinessStore as Store } from './store-contract.ts';
import { DIALOGUE, dialogueCandidate, dialogueWire } from '../../packages/domain/dialogue.ts';
import { recallMemories, recordDialogueMemories, selectProactiveTopic, recentTurns, validateDialogueMemoryEvidence } from './memory.ts';
import { recallMemories as recallAcceptedMemories } from './accepted-memory.ts';
import { deliveryDelay } from '../../packages/domain/delivery.ts';
import { correctMemory, listCorrections, listMemoryTopics, memoryVersion, readMemoryDetail, recallCorrections } from './memory-review.ts';
import { groupContext, groupReadSnapshot, knownGroupEvidence, recordGroupKnowledge } from './group-knowledge.ts';
import { freezeContextEvidence } from './context-evidence.ts';
import { validateAutonomy } from '../../packages/domain/autonomy.ts';
import { checkAutonomyGate } from './autonomy.ts';
import { checkMomentPostGate, completeMomentPost, ownMomentEvidence } from './moment-autonomy.ts';
import { VoiceCatalog } from './voices.ts';
import type { PreparedVoice } from './media.ts';
import { playerContextKey, playerIntroduction } from './player-profile.ts';
import { freezeSceneContext, frozenSceneInputs, projectedSceneStyle, recordSceneBubble, sceneRevision, touchScene } from './scenes.ts';
import { freezeRelationshipMessages, recordRelationshipEvents, relationshipContext, relationshipVersion } from './relationships.ts';
import { relationshipTestValues, relationshipTestVersion } from './relationship-test.ts';

export interface WorldPolicy {
  perCharacterDaily: number;
  perWorldDaily: number;
  quietStartMinute: number;
  quietEndMinute: number;
}
const defaultPolicy: WorldPolicy = { perCharacterDaily: RULES.perCharacterDaily,
  perWorldDaily: RULES.perWorldDaily, quietStartMinute: 1380, quietEndMinute: 420 };
interface WorldRow { id: string; owner_id: string; time_zone: string; policy_json: string }
interface ScopeRow { world_id: string; conversation_id: string; character_id: string }
interface BatchRow extends ScopeRow {
  id: string; epoch: number; status: 'waiting' | 'eligible' | 'complete'; guaranteed_at: number;
  response_ready_at: number;
  last_draw_at: number | null; draw_count: number; last_roll: number | null; last_probability: number | null;
}
interface MessageRow {
  seq: number; id: string; world_id: string; conversation_id: string; author_kind: 'player' | 'character'; author_id: string;
  body: string; created_at: number; delivery: 'text' | 'voice'; voice_fallback: number;
  media_id: string | null; proactive: number; request_hash: string | null;
  mentioned_ids_json: string | null;
  reply_to_json: string | null;
}
interface JobRow extends ScopeRow {
  id: string; kind: 'reply' | 'proactive'; epoch: number; status: 'leased' | 'published' | 'failed';
  lease_until: number; covered_ids_json: string; requested_delivery: 'text' | 'voice';
  intent_id: string | null; failure_code: string | null; published_message_id: string | null;
  memory_version: number;
  player_context_key: string;
  relationship_version: number;
  scene_revision: number;
  surface: 'chat' | 'moment_post';
}
interface IntentRow extends ScopeRow { id: string; status: string; expires_at: number }
interface DeliveryRow {
  template_version: number; payload_json: string; delays_json: string; next_ordinal: number; next_due_at: number;
  state: 'queued' | 'complete' | 'cancelled';
}
interface PendingRow { message_id: string; seq: number; batch_id: string; status: string; epoch: number;
  job_id: string | null; not_before: number; awaiting_player: number; response_ready_at: number }
export interface WorkItem {
  id: string; kind: 'reply' | 'proactive'; messageIds: string[]; leaseUntil: number;
  requestedDelivery: 'text' | 'voice'; mustClose: boolean; graceUntil: number | null;
}
const scopeParams = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const scoped = 'world_id = ? AND conversation_id = ? AND character_id = ?';
const messageDTO = (row: MessageRow): MessageDTO => ({ id: row.id, worldId: row.world_id,
  conversationId: row.conversation_id, authorKind: row.author_kind, authorId: row.author_id,
  text: row.body, createdAt: row.created_at, delivery: row.delivery, voiceFallback: !!row.voice_fallback,
  mediaId: row.media_id, proactive: !!row.proactive,
  ...(row.mentioned_ids_json ? { mentionedCharacterIds: JSON.parse(row.mentioned_ids_json) as string[] } : {}),
  ...(row.reply_to_json ? { replyTo: JSON.parse(row.reply_to_json) } : {}) });
function text(value: unknown, max: number, code = 'INVALID_TEXT'): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, code);
}
function validateRelationship(value: unknown): asserts value is RelationshipPreset {
  ensure(value !== undefined && value !== null, 'RELATIONSHIP_SELECTION_REQUIRED');
  ensure(typeof value === 'string' && ['new', 'friend', 'close_friend', 'lover'].includes(value), 'INVALID_RELATIONSHIP');
}

/** Internal application service. No method accepts an unauthenticated network request. */
export class Engine {
  readonly store: Store;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly delayRandom: RandomSource;
  readonly availabilityFloor: boolean;
  readonly playtest: boolean;
  constructor(store: Store, options: { clock?: Clock; random?: RandomSource; delayRandom?: RandomSource; availabilityFloor?: boolean; playtest?: boolean } = {}) {
    this.store = store;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.random = options.random ?? { next: () => randomInt(0, 2 ** 32) / 2 ** 32 };
    this.delayRandom = options.delayRandom ?? { next: () => randomInt(0, 2 ** 32) / 2 ** 32 };
    this.availabilityFloor = options.availabilityFloor ?? true;
    this.playtest = options.playtest ?? false;
  }
  private playerKey(scope: CharacterScope) {
    return playerContextKey(this.store, scope) + (this.playtest ? ':test:' + relationshipTestVersion(this.store, scope) : ':normal');
  }
  private relationship(scope: CharacterScope, preset: RelationshipPreset) {
    const context = relationshipContext(this.store, scope, preset);
    const values = this.playtest ? relationshipTestValues(this.store, scope) : null;
    return values ? { ...context, familiarity: values.familiarity,
      openness: values.boundaryOpenness >= 67 ? 'comfortable' as const : values.boundaryOpenness >= 34 ? 'settling' as const : 'reserved' as const,
      testOverride: values } : context;
  }

  registerTemplate(template: CharacterTemplate): void {
    text(template.id, 128); text(template.name, 100); text(template.persona, 20_000);
    ensure(template.fictional === true && Number.isInteger(template.version) && template.version > 0, 'INVALID_TEMPLATE');
    validateSchedule(template.schedule);
    if (template.autonomy !== undefined) validateAutonomy(template.autonomy);
    if (template.voice !== undefined) new VoiceCatalog(this.store, this.clock).resolve(template.voice);
    this.store.transaction(() => {
      const old = this.store.get<{ version: number }>('SELECT version FROM character_templates WHERE id = ?', template.id);
      ensure(!old || template.version > old.version, 'VERSION_MUST_INCREASE');
      this.store.run('INSERT INTO character_template_versions VALUES (?,?,?,?)', template.id, template.version,
        JSON.stringify(template), this.clock.now());
      this.store.run('INSERT INTO character_templates VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, config_json=excluded.config_json',
        template.id, template.version, JSON.stringify(template));
    });
  }

  createWorld(playerId: string, selections: CharacterSelection[], timeZone = 'Asia/Singapore', policy = defaultPolicy): PlayerContext {
    text(playerId, 128); localTime(this.now(), timeZone);
    ensure(Number.isInteger(policy.perCharacterDaily) && policy.perCharacterDaily >= 0 &&
      Number.isInteger(policy.perWorldDaily) && policy.perWorldDaily >= 0 &&
      [policy.quietStartMinute, policy.quietEndMinute].every(x => Number.isInteger(x) && x >= 0 && x < 1440), 'INVALID_POLICY');
    ensure(Array.isArray(selections) && selections.length > 0, 'INVALID_CHARACTERS');
    for (const selection of selections) {
      ensure(selection && typeof selection === 'object', 'RELATIONSHIP_SELECTION_REQUIRED');
      text(selection.characterId, 128, 'INVALID_CHARACTERS');
      validateRelationship(selection.relationship);
    }
    const characterIds = selections.map(selection => selection.characterId);
    ensure(new Set(characterIds).size === characterIds.length, 'INVALID_CHARACTERS');
    return this.store.transaction(() => {
      ensure(!this.store.get('SELECT 1 FROM worlds WHERE owner_id=?', playerId), 'WORLD_ALREADY_EXISTS');
      const context = { playerId, worldId: randomUUID() };
      for (const id of characterIds) {
        this.template(id);
        ensure(!this.store.get('SELECT 1 FROM player_characters WHERE character_id=?', id), 'FORBIDDEN');
      }
      this.store.run('INSERT INTO worlds VALUES (?,?,?,?)', context.worldId, playerId, timeZone, JSON.stringify(policy));
      for (const selection of selections) this.store.run('INSERT INTO world_characters VALUES (?,?,?)', context.worldId, selection.characterId, selection.relationship);
      return context;
    });
  }

  addCharacter(context: PlayerContext, characterId: string, relationship: RelationshipPreset): void {
    this.store.transaction(() => {
      this.world(context); this.template(characterId);
      ensure(!this.store.get('SELECT 1 FROM player_characters WHERE character_id=? AND world_id!=?', characterId, context.worldId), 'FORBIDDEN');
      validateRelationship(relationship);
      this.store.run('INSERT INTO world_characters VALUES (?,?,?)', context.worldId, characterId, relationship);
    });
  }

  createConversation(context: PlayerContext, characterIds: string[], kind: 'private' | 'group' | 'moment' = 'private'): string {
    return this.store.transaction(() => {
      this.world(context);
      ensure(new Set(characterIds).size === characterIds.length &&
        ((kind === 'private' && characterIds.length === 1) ||
          ((kind === 'group' || kind === 'moment') && characterIds.length >= (kind === 'group' ? 2 : 1) && characterIds.length <= 32)), 'INVALID_PARTICIPANTS');
      for (const id of characterIds) ensure(this.store.get('SELECT 1 FROM world_characters WHERE world_id=? AND character_id=?', context.worldId, id), 'FORBIDDEN');
      if (kind === 'private') {
        const existing = this.store.get<{ id: string }>("SELECT id FROM conversations WHERE world_id=? AND private_character_id=? AND kind='private'", context.worldId, characterIds[0]!);
        if (existing) return existing.id;
      }
      const id = randomUUID();
      this.store.run('INSERT INTO conversations VALUES (?,?,?,?)', context.worldId, id, kind === 'private' ? 'private' : 'group', kind === 'private' ? characterIds[0]! : null);
      if (kind === 'group') this.store.run('INSERT INTO group_conversations(world_id,conversation_id,name,created_at) VALUES (?,?,?,?)',
        context.worldId, id, '群聊', this.now());
      for (const characterId of characterIds) {
        this.store.run('INSERT INTO participants VALUES (?,?,?)', context.worldId, id, characterId);
        this.store.run('INSERT INTO contacts VALUES (?,?,?,?)', context.worldId, id, characterId, JSON.stringify(emptySession()));
      }
      return id;
    });
  }

  receivePlayer(context: PlayerContext, input: { conversationId: string; requestId: string;
    text: string; targetCharacterIds: string[]; mentionedCharacterIds?: string[]; replyToMessageId?: string }): { message: MessageDTO; duplicate: boolean } {
    text(input.text, 4000); text(input.requestId, 128, 'INVALID_REQUEST_ID');
    const targets = [...input.targetCharacterIds].sort();
    ensure(targets.length > 0 && targets.length === new Set(targets).size, 'INVALID_TARGETS');
    return this.store.transaction(() => {
      this.world(context);
      const scopes = targets.map(characterId => ({ ...context, conversationId: input.conversationId, characterId }));
      for (const scope of scopes) this.authorize(scope);
      const mentions = input.mentionedCharacterIds === undefined ? null : [...input.mentionedCharacterIds].sort();
      ensure(mentions === null || (this.store.get<{ kind: string }>('SELECT kind FROM conversations WHERE world_id=? AND id=?', context.worldId, input.conversationId)?.kind === 'group' &&
        new Set(mentions).size === mentions.length && mentions.every(id => targets.includes(id))), 'INVALID_TARGETS');
      if (input.replyToMessageId !== undefined) text(input.replyToMessageId, 128, 'INVALID_QUOTE');
      const hash = createHash('sha256').update(JSON.stringify([input.conversationId, input.text, targets, ...(mentions === null ? [] : [mentions]),
        ...(input.replyToMessageId === undefined ? [] : [{ replyTo: input.replyToMessageId }])])).digest('hex');
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM messages WHERE world_id=? AND request_id=?', context.worldId, input.requestId);
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { message: this.message({ ...context, conversationId: input.conversationId }, prior.id), duplicate: true };
      }
      // Apply the new limit only to new messages; lost receipts for older, longer messages remain recoverable.
      ensure([...input.text].length <= RULES.maxPlayerMessageCharacters, 'MESSAGE_TOO_LONG');
      const now = this.now();
      let quote = null;
      if (input.replyToMessageId !== undefined) {
        const source = this.store.get<MessageRow>('SELECT * FROM messages WHERE world_id=? AND conversation_id=? AND id=?', context.worldId, input.conversationId, input.replyToMessageId);
        ensure(source && source.body !== '', 'INVALID_QUOTE');
        quote = { id: source.id, authorKind: source.author_kind, authorId: source.author_id, text: source.body, delivery: source.delivery };
      }
      const id = randomUUID();
      this.store.run(`INSERT INTO messages (id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,request_id,request_hash,mentioned_ids_json,reply_to_json)
        VALUES (?,?,?,'player',?,?,?,'text',?,?,?,?)`, id, context.worldId, input.conversationId, context.playerId, input.text, now, input.requestId, hash, mentions === null ? null : JSON.stringify(mentions), quote ? JSON.stringify(quote) : null);
      this.enqueueEvent(context.worldId, input.conversationId, id, now);
      for (const scope of scopes) {
        const state = this.maintain(scope, now);
        this.store.run(`UPDATE reply_items SET not_before=0,awaiting_player=0 WHERE covered_by IS NULL AND batch_id IN
          (SELECT id FROM batches WHERE ${scoped})`, ...scopeParams(scope));
        const active = state.lastActivityAt !== null;
        const intent = this.hasIntent(scope, now);
        const template = this.template(scope.characterId);
        let batch = this.store.get<BatchRow>(`SELECT * FROM batches WHERE ${scoped} AND epoch=? AND status!='complete' ORDER BY created_at,id LIMIT 1`,
          ...scopeParams(scope), state.epoch);
        if (!batch) {
          const batchId = randomUUID();
          this.store.run(`INSERT INTO batches (id,world_id,conversation_id,character_id,epoch,status,created_at,guaranteed_at)
            VALUES (?,?,?,?,?,?,?,?)`, batchId, ...scopeParams(scope), state.epoch, active || intent ? 'eligible' : 'waiting', now, catchUpAt(template.schedule, now));
          batch = this.store.get<BatchRow>('SELECT * FROM batches WHERE id=?', batchId)!;
        }
        this.store.run('INSERT INTO reply_items (message_id,character_id,batch_id) VALUES (?,?,?)', id, scope.characterId, batch.id);
        if (active || intent) this.grantPending(scope);
        else if (batch.status === 'waiting' && (batch.last_draw_at === null || now - batch.last_draw_at > RULES.redrawAfterMs)) {
          const probability = slotAt(template.schedule, now).probability;
          const roll = this.random.next();
          ensure(Number.isFinite(roll) && roll >= 0 && roll < 1, 'INVALID_RANDOM');
          const won = roll < probability;
          let readyAt = 0;
          if (won) {
            const delay = this.delayRandom.next();
            ensure(Number.isFinite(delay) && delay >= 0 && delay < 1, 'INVALID_RANDOM');
            // Deadline belongs to this admission, not each following bubble; no endless debounce.
            readyAt = Math.min(now + Math.floor(delay * 60_001), batch.guaranteed_at);
          }
          this.store.run('INSERT INTO draws (batch_id,at,roll,probability,template_version,won) VALUES (?,?,?,?,?,?)',
            batch.id, now, roll, probability, template.version, won ? 1 : 0);
          this.store.run(`UPDATE batches SET last_draw_at=?,last_roll=?,last_probability=?,draw_count=draw_count+1,status=?,response_ready_at=? WHERE id=?`,
            now, roll, probability, won ? 'eligible' : 'waiting', readyAt, batch.id);
        }
        if (active) { state.lastActivityAt = now; this.saveSession(scope, state); }
        // A generated new topic is stale as soon as a new obligation arrives.
        for (const job of this.store.all<JobRow>(`SELECT * FROM jobs WHERE ${scoped} AND kind='proactive' AND status='leased'`, ...scopeParams(scope))) {
          this.releaseJob(job, 'REPLIES_FIRST');
        }
      }
      if (this.availabilityFloor && this.store.get("SELECT 1 FROM conversations WHERE world_id=? AND id=? AND kind='private'", context.worldId, input.conversationId)) {
        this.ensureAvailableContact(context, input.conversationId, id, now);
      }
      return { message: this.message({ ...context, conversationId: input.conversationId }, id), duplicate: false };
    });
  }

  claimReply(scope: CharacterScope, delivery: 'text' | 'voice' = 'text'): WorkItem | null {
    ensure(delivery === 'text' || delivery === 'voice', 'INVALID_DELIVERY');
    return this.store.transaction(() => {
      this.authorize(scope);
      if (playerSuspended(this.store, scope.playerId)) return null;
      const now = this.now();
      const state = this.maintain(scope, now);
      if (this.hasIntent(scope, now)) this.grantPending(scope);
      if (this.liveJob(scope)) return null;
      // One group speaker at a time: a later speaker sees committed earlier replies, not parallel stale drafts.
      if (groupContext(this.store, scope) && this.store.get(`SELECT 1 FROM jobs WHERE world_id=? AND conversation_id=? AND status='leased' AND lease_until>?`,
        scope.worldId, scope.conversationId, now)) return null;
      const pending = this.pending(scope).filter(item => !item.awaiting_player);
      const first = pending[0];
      if (!first || first.status !== 'eligible' || first.not_before > now || first.response_ready_at > now) return null;
      const selected: PendingRow[] = [];
      for (const item of pending) {
        if (selected.length >= RULES.maxReplyItems) break;
        if (item.status !== 'eligible' || item.epoch !== first.epoch || item.job_id !== null || item.not_before > now || item.response_ready_at > now) break;
        selected.push(item);
      }
      if (selected.length === 0) return null;
      const job = this.createJob(scope, 'reply', first.epoch, selected.map(item => item.message_id), delivery, now, null);
      for (const item of selected) this.store.run('UPDATE reply_items SET job_id=? WHERE message_id=? AND character_id=?', job.id, item.message_id, scope.characterId);
      return this.workItem(job, state);
    });
  }

  requestProactive(scope: CharacterScope, requestId: string, expiresAt?: number): string {
    text(requestId, 128, 'INVALID_REQUEST_ID');
    return this.store.transaction(() => {
      const world = this.authorize(scope);
      ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
      ensure(this.store.get<{ kind: string }>('SELECT kind FROM conversations WHERE world_id=? AND id=?', scope.worldId, scope.conversationId)?.kind === 'private', 'PRIVATE_ONLY');
      const previous = this.store.get<IntentRow>('SELECT * FROM proactive_intents WHERE world_id=? AND request_id=?', scope.worldId, requestId);
      if (previous) {
        ensure(previous.conversation_id === scope.conversationId && previous.character_id === scope.characterId, 'IDEMPOTENCY_CONFLICT');
        ensure(expiresAt === undefined || previous.expires_at === expiresAt, 'IDEMPOTENCY_CONFLICT');
        return previous.id;
      }
      const now = this.now();
      ensure(expiresAt === undefined || (Number.isSafeInteger(expiresAt) && expiresAt > now && expiresAt <= now + RULES.proactiveTtlMs), 'INVALID_INTENT_EXPIRY');
      this.maintain(scope, now); this.checkProactivePolicy(scope, world, now);
      const id = randomUUID();
      this.store.run('INSERT INTO proactive_intents VALUES (?,?,?,?,?,?,?,?)', id, ...scopeParams(scope), requestId, now, expiresAt ?? now + RULES.proactiveTtlMs, 'pending');
      this.grantPending(scope);
      return id;
    });
  }

  claimProactive(scope: CharacterScope, intentId: string, delivery: 'text' | 'voice' = 'text'): WorkItem | null {
    ensure(delivery === 'text' || delivery === 'voice', 'INVALID_DELIVERY');
    return this.store.transaction(() => {
      const world = this.authorize(scope); const now = this.now();
      if (playerSuspended(this.store, scope.playerId)) return null;
      const state = this.maintain(scope, now);
      const intent = this.intent(scope, intentId);
      if (intent.status !== 'pending' || intent.expires_at <= now) return null;
      this.checkProactivePolicy(scope, world, now);
      this.grantPending(scope);
      if (this.pending(scope).length || this.liveJob(scope)) return null;
      if (checkAutonomyGate(this.store, scope, intentId, now, this.template(scope.characterId)) && state.lastActivityAt !== null) return null;
      selectProactiveTopic(this.store, scope, intentId, now, this.random);
      return this.workItem(this.createJob(scope, 'proactive', state.epoch, [], delivery, now, intentId), state);
    });
  }

  claimMomentPost(scope: CharacterScope): WorkItem | null {
    return this.store.transaction(() => {
      if (playerSuspended(this.store, scope.playerId)) return null;
      this.authorize(scope); const now = this.now(), state = this.maintain(scope, now);
      if (this.liveJob(scope)) return null;
      ensure(groupContext(this.store, scope)?.kind === 'moment_post', 'MOMENT_POST_EXPIRED');
      checkMomentPostGate(this.store, scope, now);
      ensure(this.pending(scope).length === 0, 'REPLIES_FIRST');
      return this.workItem(this.createJob(scope, 'proactive', state.epoch, [], 'text', now, null, 'moment_post'), state);
    });
  }

  publish(scope: CharacterScope, jobId: string, candidate: ReplyCandidate, expectedTemplateVersion?: number): MessageDTO {
    return this.commitReply(scope, jobId, candidate, expectedTemplateVersion)[0]!;
  }

  publishDialogue(scope: CharacterScope, jobId: string, candidate: DialogueCandidate, expectedTemplateVersion?: number): MessageDTO[] {
    this.authorize(scope);
    const job = this.job(scope, jobId);
    const normalized = dialogueCandidate(dialogueWire(candidate), JSON.parse(job.covered_ids_json), false, job.requested_delivery);
    ensure(candidate.delivery === 'text' && !candidate.voiceFallback && !candidate.mediaId && candidate.text === normalized.text, 'TEXT_ONLY');
    return this.commitReply(scope, jobId, normalized, expectedTemplateVersion, normalized);
  }

  /** A trusted delivery result, never fields supplied by the text model. Each bubble is independently playable or an explicit text fallback. */
  publishVoiceDialogue(scope: CharacterScope, jobId: string, candidate: DialogueCandidate, expectedTemplateVersion: number, prepared: PreparedVoice): MessageDTO[] {
    this.authorize(scope); const job = this.job(scope, jobId);
    ensure(job.requested_delivery === 'voice', 'VOICE_NOT_REQUESTED');
    const normalized = dialogueCandidate(dialogueWire(candidate), JSON.parse(job.covered_ids_json), false, job.requested_delivery);
    ensure(candidate.delivery === 'text' && candidate.text === normalized.text && !candidate.voiceFallback && !candidate.mediaId, 'TEXT_ONLY');
    return this.commitReply(scope, jobId, normalized, expectedTemplateVersion, normalized, prepared);
  }

  stageDialogue(scope: CharacterScope, jobId: string, candidate: DialogueCandidate, version: number, prepared?: PreparedVoice): void {
    this.store.transaction(() => {
      this.authorize(scope); const job = this.job(scope, jobId);
      ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
      const normalized = dialogueCandidate(dialogueWire(candidate), JSON.parse(job.covered_ids_json), false, job.requested_delivery);
      ensure(candidate.delivery === 'text' && !candidate.voiceFallback && !candidate.mediaId && candidate.text === normalized.text, 'TEXT_ONLY');
      const previous = this.delivery(scope, jobId);
      if (previous) {
        ensure(previous.template_version === version && previous.payload_json === JSON.stringify({ candidate: normalized, prepared: prepared ?? null }), 'IDEMPOTENCY_CONFLICT');
        return;
      }
      ensure(job.status !== 'published', 'STALE_JOB');
      this.commitReply(scope, jobId, normalized, version, normalized, prepared, { kind: 'stage' });
    });
  }

  /** At most one bubble per call; overdue work is spaced from NOW, not dumped after downtime. */
  advanceDialogue(scope: CharacterScope, jobId: string): MessageDTO[] {
    return this.store.transaction(() => {
      this.authorize(scope);
      if (playerSuspended(this.store, scope.playerId)) return [];
      const delivery = this.delivery(scope, jobId);
      if (!delivery || delivery.state !== 'queued' || delivery.next_due_at > this.now()) return [];
      const value = JSON.parse(delivery.payload_json) as { candidate: DialogueCandidate; prepared: PreparedVoice | null };
      return this.commitReply(scope, jobId, value.candidate, delivery.template_version, value.candidate, value.prepared ?? undefined,
        { kind: 'step', ordinal: delivery.next_ordinal, delays: JSON.parse(delivery.delays_json) });
    });
  }

  private delivery(scope: CharacterScope, jobId: string): DeliveryRow | undefined {
    return this.store.get<DeliveryRow>(`SELECT * FROM dialogue_deliveries WHERE ${scoped} AND job_id=?`, ...scopeParams(scope), jobId);
  }

  private commitReply(scope: CharacterScope, jobId: string, candidate: ReplyCandidate,
    expectedTemplateVersion?: number, dialogue?: DialogueCandidate, prepared?: PreparedVoice,
    pacing?: { kind: 'stage' } | { kind: 'step'; ordinal: number; delays: number[] }): MessageDTO[] {
    return this.store.transaction(() => {
      const world = this.authorize(scope);
      const job = this.job(scope, jobId);
      if (job.status === 'published') return this.publishedTurn(scope, job);
      const now = this.now();
      const state = this.maintain(scope, now);
      const currentJob = this.job(scope, jobId);
      ensure(currentJob.status === 'leased' && currentJob.lease_until > now, currentJob.failure_code ?? 'STALE_JOB');
      ensure(expectedTemplateVersion === undefined || this.template(scope.characterId).version === expectedTemplateVersion, 'CHARACTER_VERSION_CHANGED');
      ensure(currentJob.memory_version === memoryVersion(this.store, scope), 'MEMORY_CONTEXT_CHANGED');
      ensure(currentJob.player_context_key === this.playerKey(scope), 'PLAYER_CONTEXT_CHANGED');
      ensure(currentJob.scene_revision === sceneRevision(this.store, scope), 'SCENE_CONTEXT_CHANGED');
      const deliveryStyle = dialogue ? this.sceneDelivery(scope, jobId, dialogue) : 'conversational';
      ensure(currentJob.relationship_version === relationshipVersion(this.store, scope), 'RELATIONSHIP_CONTEXT_CHANGED');
      ensure(candidate && typeof candidate === 'object', 'INVALID_CANDIDATE');
      text(candidate.text, 8000);
      ensure((candidate.endsSession === undefined || typeof candidate.endsSession === 'boolean') &&
        (candidate.voiceFallback === undefined || typeof candidate.voiceFallback === 'boolean'), 'INVALID_CANDIDATE');
      ensure(Array.isArray(candidate.coveredMessageIds), 'INVALID_COVERAGE');
      const expected: string[] = JSON.parse(job.covered_ids_json);
      const accounted = [...candidate.coveredMessageIds, ...(dialogue?.deferredMessageIds ?? []), ...(dialogue?.awaitingPlayerMessageIds ?? [])];
      ensure(JSON.stringify(accounted.sort()) === JSON.stringify([...expected].sort()), 'INCOMPLETE_COVERAGE');
      const directive = this.workItem(job, state);
      const started = pacing?.kind === 'step' && pacing.ordinal > 0;
      ensure(started || !directive.mustClose || candidate.endsSession === true, 'CLOSING_REQUIRED');
      if (job.surface === 'moment_post') {
        checkMomentPostGate(this.store, scope, now, job.id);
        ensure(dialogue && dialogue.mode === 'casual' && dialogue.bubbles.length === 1 && !prepared && !candidate.endsSession &&
          !dialogue.relationshipEvents?.length && !dialogue.sceneUpdate && expected.length === 0, 'INVALID_MOMENT_POST');
      } else if (job.kind === 'proactive' && !started) {
        const intent = this.intent(scope, job.intent_id!);
        ensure(intent.status === 'pending' && intent.expires_at > now, 'INTENT_EXPIRED');
        ensure(this.pending(scope).length === 0, 'REPLIES_FIRST');
        this.checkProactivePolicy(scope, world, now);
        checkAutonomyGate(this.store, scope, job.intent_id!, now, this.template(scope.characterId), job.id);
        const selected = this.proactiveTopic(scope, job.intent_id!);
        ensure(!dialogue || selected.key === null || dialogue.topics.some(topic => topic.key === selected.key), 'PROACTIVE_TOPIC_MISMATCH');
      } else if (job.kind === 'reply') {
        for (const id of expected) ensure(this.store.get('SELECT 1 FROM reply_items WHERE message_id=? AND character_id=? AND job_id=? AND covered_by IS NULL', id, scope.characterId, job.id), 'STALE_JOB');
      }
      if (prepared) {
        const binding = this.template(scope.characterId).voice;
        ensure(job.requested_delivery === 'voice' && binding && dialogue && prepared.mediaIds.length === dialogue.bubbles.length, 'INVALID_VOICE_DELIVERY');
        new VoiceCatalog(this.store, this.clock).resolve(binding);
        for (const [ordinal, mediaId] of prepared.mediaIds.entries()) {
          const task = this.store.get<{ media_id: string; state: string; profile_json: string; text: string; expression: string; delivery_style: string }>(
            `SELECT media_id,state,profile_json,text,expression,delivery_style FROM speech_tasks WHERE ${scoped} AND job_id=? AND ordinal=? AND attempt=1`,
            ...scopeParams(scope), job.id, ordinal);
          ensure(task && task.text === dialogue.bubbles[ordinal]!.text && task.expression === dialogue.bubbles[ordinal]!.expression, 'AUDIO_TEXT_MISMATCH');
          ensure(task.delivery_style === deliveryStyle, 'AUDIO_STYLE_MISMATCH');
          const profile = JSON.parse(task.profile_json);
          ensure(profile.id === binding.profileId && profile.version === binding.version, 'AUDIO_IDENTITY_MISMATCH');
          if (mediaId === null) ensure(task.state === 'failed', 'AUDIO_NOT_FINISHED');
          else ensure(mediaId === task.media_id && task.state === 'ready' && this.store.get(
            "SELECT 1 FROM media WHERE id=? AND world_id=? AND conversation_id=? AND job_id=? AND status='ready' AND relative_path IS NOT NULL",
            mediaId, scope.worldId, scope.conversationId, job.id), 'MEDIA_NOT_READY');
        }
      } else this.validateDelivery(scope, job, candidate);
      if (dialogue) validateDialogueMemoryEvidence(this.store, scope, job.id, dialogue);
      if (pacing?.kind === 'stage') {
        ensure(dialogue && expectedTemplateVersion, 'INVALID_CANDIDATE');
        const delays = dialogue.bubbles.map((bubble, ordinal) => {
          const mediaId = prepared?.mediaIds[ordinal];
          const duration = mediaId ? this.store.get<{ duration_ms: number }>(
            `SELECT duration_ms FROM speech_tasks WHERE ${scoped} AND media_id=? AND state='ready'`, ...scopeParams(scope), mediaId)?.duration_ms : undefined;
          return ordinal === 0 ? 0 : deliveryDelay(job.id, ordinal, bubble.text, duration);
        });
        this.store.run(`INSERT INTO dialogue_deliveries VALUES (?,?,?,?,?,?,?,0,?,?,'queued')`,
          job.id, ...scopeParams(scope), expectedTemplateVersion, JSON.stringify({ candidate: dialogue, prepared: prepared ?? null }), JSON.stringify(delays), now, now);
        // A reviewed result has no in-flight API to retry. Preserve it through short restarts.
        this.store.run(`UPDATE jobs SET lease_until=? WHERE id=? AND ${scoped}`, now + 15 * 60_000, job.id, ...scopeParams(scope));
        return [];
      }
      const published: MessageDTO[] = [];
      for (const [ordinal, bubble] of (dialogue?.bubbles ?? [{ text: candidate.text, expression: 'neutral' }]).entries()) {
        if (pacing?.kind === 'step' && ordinal !== pacing.ordinal) continue;
        const id = randomUUID();
        const preparedMedia = prepared?.mediaIds[ordinal];
        this.store.run(`INSERT INTO messages (id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,voice_fallback,media_id,proactive,quota_day)
        VALUES (?,?,?,'character',?,?,?,?,?,?,?,?)`, id, scope.worldId, scope.conversationId, scope.characterId,
        bubble.text, now, prepared ? (preparedMedia ? 'voice' : 'text') : candidate.delivery,
        prepared ? (preparedMedia ? 0 : 1) : candidate.voiceFallback ? 1 : 0, prepared ? preparedMedia ?? null : candidate.mediaId ?? null,
        job.kind === 'proactive' && job.surface === 'chat' ? 1 : 0, job.kind === 'proactive' ? localTime(now, world.time_zone).date : null);
        if (dialogue) this.store.run('INSERT INTO dialogue_bubbles VALUES (?,?,?,?,?,?)',
          scope.worldId, scope.conversationId, job.id, ordinal, id, bubble.expression);
        this.enqueueEvent(scope.worldId, scope.conversationId, id, now);
        published.push(this.message(scope, id));
      }
      if (dialogue) recordSceneBubble(this.store, scope, job.id, dialogue, published, now);
      if (pacing?.kind === 'step') {
        ensure(dialogue && published.length === 1, 'DELIVERY_INTEGRITY_ERROR');
        const next = pacing.ordinal + 1;
        this.store.run(`UPDATE dialogue_deliveries SET next_ordinal=?,next_due_at=?,state=? WHERE ${scoped} AND job_id=?`,
          next, now + (pacing.delays[next] ?? 0), next < dialogue.bubbles.length ? 'queued' : 'complete', ...scopeParams(scope), job.id);
        if (job.intent_id && pacing.ordinal === 0) {
          this.store.run("UPDATE proactive_intents SET status='complete' WHERE id=?", job.intent_id);
          this.store.run(`UPDATE autonomy_days SET status='complete',reason=NULL WHERE ${scoped} AND intent_id=?`, ...scopeParams(scope), job.intent_id);
        }
        if (next < dialogue.bubbles.length) {
          if (job.epoch === state.epoch) this.saveSession(scope, { ...state, lastActivityAt: now, checkedAt: now,
            schedule: state.schedule ?? this.template(scope.characterId).schedule });
          recordGroupKnowledge(this.store, scope, job.id, published, now);
          return published;
        }
        published.splice(0, published.length, ...this.publishedTurn(scope, job));
      }
      const id = published[0]!.id;
      if (job.surface === 'moment_post') completeMomentPost(this.store, scope, id);
      this.store.run("UPDATE jobs SET status='published',published_message_id=? WHERE id=?", id, job.id);
      if (dialogue?.awaitingPlayerMessageIds.length) {
        const pending = this.pending(scope);
        const lastInput = Math.max(...pending.filter(item => expected.includes(item.message_id)).map(item => item.seq));
        // Input arriving while the model was asking must not become stranded behind that question.
        const newerInput = pending.some(item => !expected.includes(item.message_id) && item.seq > lastInput);
        for (const awaited of dialogue.awaitingPlayerMessageIds) this.store.run(
          'UPDATE reply_items SET job_id=NULL,not_before=0,awaiting_player=?,clarified_by=COALESCE(clarified_by,?) WHERE job_id=? AND message_id=? AND covered_by IS NULL',
          newerInput ? 0 : 1, id, job.id, awaited);
      }
      for (const covered of candidate.coveredMessageIds) this.store.run(
        'UPDATE reply_items SET covered_by=?,awaiting_player=0 WHERE job_id=? AND message_id=? AND covered_by IS NULL', id, job.id, covered);
      this.store.run('UPDATE reply_items SET job_id=NULL,not_before=? WHERE job_id=? AND covered_by IS NULL',
        now + DIALOGUE.continuationMs, job.id);
      this.store.run(`UPDATE batches SET status='complete' WHERE ${scoped} AND NOT EXISTS
        (SELECT 1 FROM reply_items WHERE batch_id=batches.id AND covered_by IS NULL)`, ...scopeParams(scope));
      if (job.intent_id) {
        this.store.run("UPDATE proactive_intents SET status='complete' WHERE id=?", job.intent_id);
        this.store.run(`UPDATE autonomy_days SET status='complete',reason=NULL WHERE ${scoped} AND intent_id=?`, ...scopeParams(scope), job.intent_id);
      }
      if (job.epoch === state.epoch) {
        if (candidate.endsSession) this.saveSession(scope, closeSession(state));
        else this.saveSession(scope, { ...state, lastActivityAt: now, checkedAt: now,
          schedule: state.schedule ?? this.template(scope.characterId).schedule });
      }
      if (dialogue) {
        touchScene(this.store, scope, job.id, now);
        recordDialogueMemories(this.store, scope, job.id, dialogue, published, expected, now);
        recordRelationshipEvents(this.store, scope, job.id, dialogue, published, now);
        recordGroupKnowledge(this.store, scope, job.id, published, now);
      }
      return published;
    });
  }

  fail(scope: CharacterScope, jobId: string, code: 'GENERATION_FAILED' | 'AUDIO_FAILED'): void {
    ensure(code === 'GENERATION_FAILED' || code === 'AUDIO_FAILED', 'INVALID_FAILURE_CODE');
    this.store.transaction(() => {
      this.authorize(scope);
      const job = this.job(scope, jobId);
      if (job.status === 'leased') this.releaseJob(job, code);
    });
  }

  supersedeScene(scope: CharacterScope, jobId: string, code: 'SCENE_CONTEXT_CHANGED' | 'SCENE_INPUT_CHANGED') {
    this.store.transaction(() => {
      this.authorize(scope);
      const job = this.job(scope, jobId);
      if (job.status === 'leased') this.releaseJob(job, code);
      this.store.run(`UPDATE reply_items SET not_before=max(not_before,?) WHERE covered_by IS NULL AND batch_id IN
        (SELECT id FROM batches WHERE ${scoped})`, this.now() + 3000, ...scopeParams(scope));
    });
  }
  work(scope: CharacterScope, jobId: string): WorkItem {
    return this.store.transaction(() => {
      this.authorize(scope);
      const state = this.maintain(scope, this.now());
      const job = this.job(scope, jobId);
      ensure(job.status === 'leased', job.failure_code ?? 'STALE_JOB');
      return this.workItem(job, state);
    });
  }

  /** No model calls, publications or random draws are permitted on a timer tick. */
  tick(): void {
    this.store.transaction(() => {
      const now = this.now();
      for (const row of this.store.all<ScopeRow & { owner_id: string }>(`SELECT c.world_id,c.conversation_id,c.character_id,w.owner_id
        FROM contacts c JOIN worlds w ON w.id=c.world_id`)) {
        this.maintain({ worldId: row.world_id, playerId: row.owner_id, conversationId: row.conversation_id, characterId: row.character_id }, now);
      }
    });
  }

  listMessages(context: PlayerContext, conversationId: string): MessageDTO[] {
    this.world(context);
    ensure(this.store.get('SELECT 1 FROM conversations WHERE world_id=? AND id=?', context.worldId, conversationId), 'FORBIDDEN');
    return this.store.all<MessageRow>("SELECT * FROM messages WHERE body!='' AND world_id=? AND conversation_id=? ORDER BY seq", context.worldId, conversationId).map(messageDTO);
  }
  readMessage(context: PlayerContext, conversationId: string, messageId: string): MessageDTO {
    this.world(context);
    ensure(this.store.get('SELECT 1 FROM conversations WHERE world_id=? AND id=?', context.worldId, conversationId), 'FORBIDDEN');
    return this.message({ ...context, conversationId }, messageId);
  }
  characterContext(scope: CharacterScope): MessageDTO[] {
    this.authorize(scope);
    return this.listMessages(scope, scope.conversationId);
  }
  memories(scope: CharacterScope, query = '') {
    this.authorize(scope);
    return (this.store.beta || this.store.web ? recallAcceptedMemories : recallMemories)(this.store, scope, this.now(), query);
  }
  memoryTopics(scope: CharacterScope, before: string | null = null) {
    this.authorize(scope); return listMemoryTopics(this.store, scope, this.now(), before);
  }
  memoryDetail(scope: CharacterScope, id: string, before: string | null = null) {
    this.authorize(scope); return readMemoryDetail(this.store, scope, this.now(), id, before);
  }
  memoryCorrectionHistory(scope: CharacterScope, id: string, before: string | null = null) {
    this.authorize(scope); return listCorrections(this.store, scope, id, before);
  }
  correctMemory(scope: CharacterScope, id: string, input: unknown) {
    return this.store.transaction(() => {
      this.authorize(scope); return correctMemory(this.store, scope, this.now(), id, input);
    });
  }
  shortTermMemories(scope: CharacterScope) {
    this.authorize(scope);
    return recentTurns(this.store, scope, this.now());
  }
  textRequest(scope: CharacterScope, jobId: string): TextGenerationRequest {
    return this.store.transaction(() => {
      const { job, state, now } = this.checkedGeneration(scope, jobId);
      const conversation = groupContext(this.store, scope);
      const requiredMessageIds: string[] = JSON.parse(job.covered_ids_json);
      const required = requiredMessageIds.length ? this.store.all<MessageRow>(
        `SELECT * FROM messages WHERE world_id=? AND conversation_id=? AND id IN (${requiredMessageIds.map(() => '?').join(',')}) ORDER BY seq`,
        scope.worldId, scope.conversationId, ...requiredMessageIds) : [];
      ensure(required.length === requiredMessageIds.length, 'INVALID_COVERAGE');
      const priorServiceFailure = requiredMessageIds.length > 0 && !!this.store.get(`SELECT 1 FROM jobs j
        WHERE j.world_id=? AND j.conversation_id=? AND j.character_id=? AND j.id<>? AND j.status='failed'
          AND j.failure_code IN ('GENERATION_FAILED','AUDIO_FAILED') AND EXISTS
          (SELECT 1 FROM json_each(j.covered_ids_json) covered WHERE covered.value IN (${requiredMessageIds.map(() => '?').join(',')})) LIMIT 1`,
        ...scopeParams(scope), jobId, ...requiredMessageIds);
      const clarifications = requiredMessageIds.flatMap(messageId => {
        const messages = this.store.all<{ id: string; text: string }>(
          `SELECT m.id,m.body text FROM reply_items i JOIN batches b ON b.id=i.batch_id
           JOIN jobs j ON j.published_message_id=i.clarified_by AND j.world_id=b.world_id
             AND j.conversation_id=b.conversation_id AND j.character_id=b.character_id
           JOIN dialogue_bubbles d ON d.job_id=j.id AND d.world_id=b.world_id AND d.conversation_id=b.conversation_id
           JOIN messages m ON m.id=d.message_id AND m.world_id=b.world_id AND m.conversation_id=b.conversation_id
           WHERE b.world_id=? AND b.conversation_id=? AND b.character_id=? AND i.message_id=? ORDER BY d.ordinal`,
          ...scopeParams(scope), messageId);
        return messages.length ? [{ messageId, messages: messages.map(row => ({ ...row })) }] : [];
      });
      const excluded = new Set(this.pending(scope).map(item => item.message_id));
      const selected = [...required];
      let recentChars = 0;
      const recent = this.store.all<MessageRow>("SELECT * FROM messages WHERE body!='' AND world_id=? AND conversation_id=? ORDER BY seq DESC LIMIT 24",
        scope.worldId, scope.conversationId);
      for (const row of recent) {
        if (excluded.has(row.id)) continue;
        if (recentChars + row.body.length > 12_000) break;
        selected.push(row); recentChars += row.body.length;
      }
      if (conversation) {
        if (conversation.kind === 'moment' && !selected.some(row => row.id === conversation.postMessageId)) {
          const root = this.store.get<MessageRow>('SELECT * FROM messages WHERE world_id=? AND conversation_id=? AND id=?',
            scope.worldId, scope.conversationId, conversation.postMessageId);
          ensure(root, 'MOMENT_INTEGRITY_ERROR'); selected.push(root);
        }
        const ids = groupReadSnapshot(this.store, scope, job.id, selected.map(row => row.id));
        const frozen = this.store.all<MessageRow>(`SELECT * FROM messages WHERE world_id=? AND conversation_id=? AND id IN (${ids.map(() => '?').join(',')}) ORDER BY seq`,
          scope.worldId, scope.conversationId, ...ids);
        ensure(frozen.length === ids.length && requiredMessageIds.every(id => ids.includes(id)), 'GROUP_CONTEXT_INVALID');
        selected.splice(0, selected.length, ...frozen);
      }
      const relationship = this.store.get<{ relationship: RelationshipPreset }>(
        'SELECT relationship FROM world_characters WHERE world_id=? AND character_id=?', scope.worldId, scope.characterId)!.relationship;
      const introduction = playerIntroduction(this.store, scope);
      const messages = freezeRelationshipMessages(this.store, scope, jobId, selected.sort((a, b) => a.seq - b.seq).map(messageDTO));
      const sceneContext = freezeSceneContext(this.store, scope, jobId, messages, now);
      const topic = job.intent_id ? this.proactiveTopic(scope, job.intent_id) : null;
      const query = topic?.key ?? required.map(row => row.body).join(' ');
      const memories = (this.store.beta || this.store.web ? recallAcceptedMemories : recallMemories)(this.store, scope, now, query);
      const evidence = freezeContextEvidence(this.store, scope, job.id, conversation?.kind === 'moment_post' ? ownMomentEvidence(this.store, scope) : conversation ? [] : [
        ...memories.flatMap(memory => memory.episodes.flatMap(episode => episode.sources ?? [])), ...knownGroupEvidence(this.store, scope, query)]);
      for (const memory of memories) for (const episode of memory.episodes) {
        if (episode.sources) episode.sources = episode.sources.filter(source => evidence.some(item => item.id === source.id));
      }
      return { jobId, scope: { worldId: scope.worldId, conversationId: scope.conversationId, characterId: scope.characterId },
        now, priorServiceFailure, relationship, ...(introduction ? { playerIntroduction: introduction } : {}), deliveryMode: job.requested_delivery, requiredMessageIds, character: this.template(scope.characterId), ...(conversation ? { conversation } : {}),
        messages, ...(sceneContext ? { sceneContext } : {}), ...(!conversation ? { relationshipContext: this.relationship(scope, relationship) } : {}),
        mustClose: this.workItem(job, state).mustClose, evidence, clarifications,
        memories, memoryCorrections: recallCorrections(this.store, scope, query, [...(topic?.key ? [topic.key] : []), ...memories.map(item => item.key)]),
        shortTermTurns: recentTurns(this.store, scope, now).filter(turn => turn.messages.some(message => !selected.some(row => row.id === message.id))),
        ...(job.intent_id ? { proactiveTopic: this.proactiveTopic(scope, job.intent_id) } : {}) };
    });
  }
  /** Delivery needs a current binding and job directive, not another model prompt or memory search. */
  deliveryRequest(scope: CharacterScope, jobId: string): Pick<TextGenerationRequest, 'character' | 'requiredMessageIds' | 'mustClose' | 'deliveryMode'> {
    return this.store.transaction(() => {
      const { job, state } = this.checkedGeneration(scope, jobId);
      return { character: this.template(scope.characterId), requiredMessageIds: JSON.parse(job.covered_ids_json),
        mustClose: this.workItem(job, state).mustClose, deliveryMode: job.requested_delivery };
    });
  }
  sceneDelivery(scope: CharacterScope, jobId: string, candidate: DialogueCandidate, expectedTemplateVersion?: number) {
    return this.store.transaction(() => {
      const { now } = this.checkedGeneration(scope, jobId);
      ensure(expectedTemplateVersion === undefined || this.template(scope.characterId).version === expectedTemplateVersion, 'CHARACTER_VERSION_CHANGED');
      // Trusted direct-publication callers may not have requested a prompt. Freeze once for compatibility.
      const request = frozenSceneInputs(this.store, scope, jobId) ?? this.textRequest(scope, jobId);
      const relationship = this.store.get<{ relationship: RelationshipPreset }>(
        'SELECT relationship FROM world_characters WHERE world_id=? AND character_id=?', scope.worldId, scope.characterId)!.relationship;
      return projectedSceneStyle(this.store, scope, jobId, candidate, request.sceneContext, request.messages, relationship, now);
    });
  }
  /** Shared live guards; caller holds the transaction. Frozen evidence never substitutes for these checks. */
  private checkedGeneration(scope: CharacterScope, jobId: string) {
    this.authorize(scope);
    ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
    const now = this.now(), state = this.maintain(scope, now), job = this.job(scope, jobId);
    ensure(job.status === 'leased' && job.lease_until > now, job.failure_code ?? 'STALE_JOB');
    ensure(job.memory_version === memoryVersion(this.store, scope), 'MEMORY_CONTEXT_CHANGED');
    ensure(job.player_context_key === this.playerKey(scope), 'PLAYER_CONTEXT_CHANGED');
    ensure(job.scene_revision === sceneRevision(this.store, scope), 'SCENE_CONTEXT_CHANGED');
    ensure(job.relationship_version === relationshipVersion(this.store, scope), 'RELATIONSHIP_CONTEXT_CHANGED');
    const ids: string[] = JSON.parse(job.covered_ids_json);
    if (ids.length) ensure(this.store.get<{ count: number }>(`SELECT count(*) count FROM messages
      WHERE world_id=? AND conversation_id=? AND id IN (${ids.map(() => '?').join(',')})`,
      scope.worldId, scope.conversationId, ...ids)!.count === ids.length, 'INVALID_COVERAGE');
    return { job, state, now };
  }
  inspect(scope: CharacterScope) {
    this.authorize(scope);
    return { session: this.session(scope), batches: this.store.all<BatchRow>(`SELECT * FROM batches WHERE ${scoped} ORDER BY created_at,id`, ...scopeParams(scope)),
      pendingMessageIds: this.pending(scope).map(item => item.message_id), quota: this.quota(scope, this.world(scope), this.now()) };
  }

  private now() { const now = this.clock.now(); ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME'); return now; }
  private world(context: PlayerContext): WorldRow {
    const world = this.store.get<WorldRow>('SELECT * FROM worlds WHERE id=? AND owner_id=?', context.worldId, context.playerId);
    ensure(world, 'FORBIDDEN'); return world;
  }
  private authorize(scope: CharacterScope): WorldRow {
    const world = this.world(scope);
    ensure(this.store.get(`SELECT 1 FROM participants WHERE ${scoped}`, ...scopeParams(scope)), 'FORBIDDEN');
    return world;
  }
  private template(id: string): CharacterTemplate {
    const row = this.store.get<{ config_json: string }>('SELECT config_json FROM character_templates WHERE id=?', id);
    ensure(row, 'UNKNOWN_CHARACTER'); return JSON.parse(row.config_json);
  }
  private session(scope: CharacterScope): SessionState {
    const row = this.store.get<{ state_json: string }>(`SELECT state_json FROM contacts WHERE ${scoped}`, ...scopeParams(scope));
    ensure(row, 'FORBIDDEN'); return JSON.parse(row.state_json);
  }
  private saveSession(scope: CharacterScope, state: SessionState) {
    this.store.run(`UPDATE contacts SET state_json=? WHERE ${scoped}`, JSON.stringify(state), ...scopeParams(scope));
  }
  private maintain(scope: CharacterScope, now: number): SessionState {
    const state = advanceSession(this.session(scope), now);
    this.saveSession(scope, state);
    this.store.run(`UPDATE batches SET status='eligible' WHERE ${scoped} AND status='waiting' AND guaranteed_at<=?`, ...scopeParams(scope), now);
    this.store.run(`UPDATE proactive_intents SET status='expired' WHERE ${scoped} AND status='pending' AND expires_at<=?`, ...scopeParams(scope), now);
    for (const job of this.store.all<JobRow>(`SELECT * FROM jobs WHERE ${scoped} AND status='leased'`, ...scopeParams(scope))) {
      if (job.lease_until <= now) this.releaseJob(job, 'LEASE_EXPIRED');
      else if (job.intent_id && this.intent(scope, job.intent_id).status !== 'pending' && !(this.delivery(scope, job.id)?.next_ordinal)) this.releaseJob(job, 'INTENT_EXPIRED');
    }
    return state;
  }
  private pending(scope: CharacterScope): PendingRow[] {
    return this.store.all<PendingRow>(`SELECT i.message_id,m.seq,i.batch_id,i.job_id,i.not_before,i.awaiting_player,b.status,b.epoch,b.response_ready_at FROM reply_items i
      JOIN batches b ON b.id=i.batch_id JOIN messages m ON m.id=i.message_id
      WHERE b.world_id=? AND b.conversation_id=? AND b.character_id=? AND i.covered_by IS NULL ORDER BY m.seq`, ...scopeParams(scope));
  }
  private grantPending(scope: CharacterScope) {
    this.store.run(`UPDATE batches SET status='eligible',response_ready_at=0 WHERE ${scoped} AND status='waiting'`, ...scopeParams(scope));
  }
  private ensureAvailableContact(context: PlayerContext, triggeringConversation: string, messageId: string, now: number) {
    const contacts = this.store.all<{ character_id: string; conversation_id: string | null; state_json: string | null }>(
      `SELECT w.character_id,c.id conversation_id,s.state_json FROM world_characters w
       LEFT JOIN conversations c ON c.world_id=w.world_id AND c.private_character_id=w.character_id AND c.kind='private'
       LEFT JOIN contacts s ON s.world_id=c.world_id AND s.conversation_id=c.id AND s.character_id=w.character_id WHERE w.world_id=?`, context.worldId);
    const candidates: { scope: CharacterScope; first: PendingRow }[] = [];
    for (const contact of contacts) {
      // An uncontacted or active friend is not a lost draw. No unsolicited messages are invented.
      if (!contact.conversation_id || !contact.state_json || advanceSession(JSON.parse(contact.state_json), now).lastActivityAt !== null) return;
      const scope = { ...context, conversationId: contact.conversation_id, characterId: contact.character_id };
      const pending = this.pending(scope);
      if (!pending.length || pending.some(item => item.status !== 'waiting' || item.awaiting_player || item.job_id) || this.hasIntent(scope, now)) return;
      // A provider/worker failure must remain visible, never be rewritten as a missed probability draw.
      if (this.store.get(`SELECT 1 FROM text_retry_state WHERE ${scoped}`, ...scopeParams(scope))) return;
      candidates.push({ scope, first: pending[0]! });
    }
    candidates.sort((a, b) => Number(a.scope.conversationId === triggeringConversation) - Number(b.scope.conversationId === triggeringConversation) || a.first.seq - b.first.seq);
    const chosen = candidates[0]; if (!chosen) return;
    this.grantPending(chosen.scope);
    this.store.run(`UPDATE batches SET guaranteed_at=min(guaranteed_at,?),response_ready_at=0 WHERE ${scoped} AND status='eligible'`, now, ...scopeParams(chosen.scope));
    this.store.run('INSERT INTO response_fallbacks VALUES (?,?,?,?,?,?)', messageId, context.worldId, chosen.scope.conversationId, chosen.scope.characterId, chosen.first.batch_id, now);
  }
  private hasIntent(scope: CharacterScope, now: number) {
    return !!this.store.get(`SELECT 1 FROM proactive_intents WHERE ${scoped} AND status='pending' AND expires_at>?`, ...scopeParams(scope), now);
  }
  private liveJob(scope: CharacterScope) {
    return this.store.get(`SELECT 1 FROM jobs WHERE ${scoped} AND status='leased'`, ...scopeParams(scope));
  }
  private job(scope: CharacterScope, id: string): JobRow {
    const job = this.store.get<JobRow>(`SELECT * FROM jobs WHERE id=? AND ${scoped}`, id, ...scopeParams(scope));
    ensure(job, 'FORBIDDEN'); return job;
  }
  private intent(scope: CharacterScope, id: string): IntentRow {
    const intent = this.store.get<IntentRow>(`SELECT * FROM proactive_intents WHERE id=? AND ${scoped}`, id, ...scopeParams(scope));
    ensure(intent, 'FORBIDDEN'); return intent;
  }
  private proactiveTopic(scope: CharacterScope, intentId: string): { key: string | null } {
    // Pre-migration leased jobs have no selection. They retain a fresh topic without drawing.
    const row = this.store.get<{ selected_key: string | null }>(
      `SELECT selected_key FROM proactive_topics WHERE ${scoped} AND intent_id=?`, ...scopeParams(scope), intentId);
    return { key: row?.selected_key ?? null };
  }
  private createJob(scope: CharacterScope, kind: 'reply' | 'proactive', epoch: number, ids: string[],
    delivery: 'text' | 'voice', now: number, intentId: string | null, surface: 'chat' | 'moment_post' = 'chat'): JobRow {
    const id = randomUUID();
    this.store.run(`INSERT INTO jobs (id,world_id,conversation_id,character_id,kind,epoch,status,created_at,lease_until,covered_ids_json,requested_delivery,intent_id,memory_version,player_context_key,relationship_version,scene_revision,surface)
      VALUES (?,?,?,?,?,?,'leased',?,?,?,?,?,?,?,?,?,?)`, id, ...scopeParams(scope), kind, epoch, now, now + RULES.jobLeaseMs, JSON.stringify(ids), delivery, intentId, memoryVersion(this.store, scope), this.playerKey(scope), relationshipVersion(this.store, scope), sceneRevision(this.store, scope), surface);
    return this.job(scope, id);
  }
  private workItem(job: JobRow, state: SessionState): WorkItem {
    return { id: job.id, kind: job.kind, messageIds: JSON.parse(job.covered_ids_json), leaseUntil: job.lease_until,
      requestedDelivery: job.requested_delivery, mustClose: job.epoch !== state.epoch, graceUntil: state.graceUntil };
  }
  private releaseJob(job: JobRow, code: string) {
    this.store.run(`UPDATE dialogue_deliveries SET state='cancelled' WHERE world_id=? AND conversation_id=? AND character_id=? AND job_id=? AND state='queued'`,
      job.world_id, job.conversation_id, job.character_id, job.id);
    this.store.run("UPDATE jobs SET status='failed',failure_code=? WHERE id=?", code, job.id);
    this.store.run('UPDATE reply_items SET job_id=NULL WHERE job_id=? AND covered_by IS NULL', job.id);
  }
  private validateDelivery(scope: CharacterScope, job: JobRow, candidate: ReplyCandidate) {
    ensure(candidate.delivery === 'text' || candidate.delivery === 'voice', 'INVALID_DELIVERY');
    if (candidate.delivery === 'voice') {
      ensure(job.requested_delivery === 'voice' && !candidate.voiceFallback && typeof candidate.mediaId === 'string', 'INVALID_DELIVERY');
      // Only M4's verified-media importer may mark an asset ready, never model output.
      ensure(this.store.get(`SELECT 1 FROM media WHERE id=? AND world_id=? AND conversation_id=? AND job_id=? AND status='ready' AND relative_path IS NOT NULL`,
        candidate.mediaId, scope.worldId, scope.conversationId, job.id), 'MEDIA_NOT_READY');
    } else {
      ensure(candidate.mediaId === undefined, 'INVALID_DELIVERY');
      ensure(job.requested_delivery !== 'voice' || candidate.voiceFallback === true, 'EXPLICIT_TEXT_FALLBACK_REQUIRED');
      ensure(job.requested_delivery === 'voice' || !candidate.voiceFallback, 'INVALID_DELIVERY');
    }
  }
  private quota(scope: CharacterScope, world: WorldRow, now: number) {
    const day = localTime(now, world.time_zone).date;
    const all = this.store.get<{ total: number; actor: number | null }>(`SELECT count(*) AS total,
      sum(CASE WHEN m.author_id=? THEN 1 ELSE 0 END) AS actor FROM messages m LEFT JOIN dialogue_bubbles b ON b.message_id=m.id
      WHERE m.world_id=? AND m.proactive=1 AND m.quota_day=? AND COALESCE(b.ordinal,0)=0`,
      scope.characterId, scope.worldId, day)!;
    const retired = this.store.get<{ total: number | null; actor: number | null }>(`SELECT sum(contacts) total,
      sum(CASE WHEN character_id=? THEN contacts ELSE 0 END) actor FROM retired_proactive_usage WHERE world_id=? AND quota_day=?`,
      scope.characterId, scope.worldId, day)!;
    return { day, character: (all.actor ?? 0) + (retired.actor ?? 0), world: all.total + (retired.total ?? 0) };
  }
  private checkProactivePolicy(scope: CharacterScope, world: WorldRow, now: number) {
    const policy: WorldPolicy = JSON.parse(world.policy_json);
    const minute = localTime(now, world.time_zone).minute;
    const { quietStartMinute: start, quietEndMinute: end } = policy;
    const quiet = start === end ? false : start < end ? minute >= start && minute < end : minute >= start || minute < end;
    ensure(!quiet, 'QUIET_HOURS');
    const usage = this.quota(scope, world, now);
    ensure(usage.character < policy.perCharacterDaily && usage.world < policy.perWorldDaily, 'QUOTA_EXCEEDED');
  }
  private message(context: PlayerContext & { conversationId: string }, id: string): MessageDTO {
    const row = this.store.get<MessageRow>('SELECT * FROM messages WHERE id=? AND world_id=? AND conversation_id=?', id, context.worldId, context.conversationId);
    ensure(row, 'FORBIDDEN'); ensure(row.body !== '', 'MESSAGE_EXPIRED'); return messageDTO(row);
  }
  private publishedTurn(scope: CharacterScope, job: JobRow): MessageDTO[] {
    const rows = this.store.all<MessageRow>(`SELECT m.* FROM messages m JOIN dialogue_bubbles b ON b.message_id=m.id
      WHERE b.world_id=? AND b.conversation_id=? AND b.job_id=? AND m.world_id=? AND m.conversation_id=? ORDER BY b.ordinal`,
      scope.worldId, scope.conversationId, job.id, scope.worldId, scope.conversationId);
    return rows.length ? rows.map(messageDTO) : [this.message(scope, job.published_message_id!)];
  }
  private enqueueEvent(worldId: string, conversationId: string, messageId: string, now: number) {
    this.store.run('INSERT INTO outbox (world_id,conversation_id,message_id,created_at) VALUES (?,?,?,?)', worldId, conversationId, messageId, now);
  }
}
