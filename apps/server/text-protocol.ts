import type { DialogueCandidate, TextGenerationRequest } from '../../packages/contracts/index.ts';
import { EXPRESSIONS } from '../../packages/contracts/index.ts';
import { dialogueCandidate, topicKey } from '../../packages/domain/dialogue.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { BUBBLE_LIMITS, VOICE_BUBBLE_LIMITS, bubbleLimits, DRAFT_BUBBLE_LIMITS, validatedBubbles } from '../../packages/domain/bubbles.ts';
import { DEFAULT_TEXT_MODELS } from './config.ts';
import { SCENE_KINDS } from '../../packages/contracts/scenes.ts';
import { changedScene, validateSceneEvidence } from '../../packages/domain/scenes.ts';
import { RELATIONSHIP_EVENT_KINDS } from '../../packages/contracts/relationships.ts';
import { memoryReferences } from './memory-links.ts';

export type TextDraft = Pick<DialogueCandidate, 'mode' | 'bubbles' | 'endsSession'>;
export const TEXT_PROTOCOL_VERSION = 'strict_draft_audit_v10_thinking_review';
export const DRAFT_REVIEW_ISSUES = ['none', 'subject', 'unconfirmed_action', 'unsupported_fact', 'boundary', 'focus', 'expression', 'presentation', 'instruction'] as const;
type Schema = Record<string, unknown>;
const objectSchema = (properties: Record<string, Schema>): Schema => ({ type: 'object', properties,
  required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' };
const array = (items: Schema): Schema => ({ type: 'array', items });
const idArray = (ids: string[]) => array(ids.length ? { type: 'string', enum: ids } : string);
const bubbleSchema = objectSchema({ text: string, expression: { type: 'string', enum: EXPRESSIONS } });
const draftSchema = objectSchema({ mode: { type: 'string', enum: ['casual', 'conflict_apology'] },
  bubbles: array(bubbleSchema), endsSession: { type: 'boolean' } });
const speechDraftSchema = objectSchema({ mode: { type: 'string', enum: ['casual', 'conflict_apology'] },
  utterance: { ...bubbleSchema, description: '这一刻自然说出口的一段话。完整表达当前意思；短应声也可以，不为分条截断句子。' },
  afterthoughts: { ...array(bubbleSchema), description: '只有说完后确实另补一句或转换情绪才填写；没有补充用空数组，不续写上一条没说完的句子。' },
  endsSession: { type: 'boolean' } });
const coverageSchema = objectSchema({ status: { type: 'string', enum: ['answered', 'needs_player', 'later'] },
  supportQuote: string, missingInformation: string });
const sourceKindSchema = { type: 'string', enum: ['fictional_daily', 'player_statement', 'conversation'] };

const tool = (name: string, description: string, parameters: Schema) => ({ type: 'function' as const,
  function: { name, description, strict: true, parameters } });
// These are structured output envelopes, never executable tools or permission to publish.
export const draftTool = (delivery: 'text' | 'voice' = 'text') => tool('submit_dialogue_draft',
  delivery === 'voice' ? '提交角色要说出口的话与可选的独立补充；不是填满几个文字气泡。' : '提交尚未发布的角色短气泡，仅用于结构化输出。',
  delivery === 'voice' ? speechDraftSchema : draftSchema);
function reviewSchema(draftCount: number, requiredIds: string[], localIds: string[], sourceIds: string[], relationships = false, scenes = false, memoryIds: string[] = []) {
  const proof = objectSchema({ messageId: localIds.length ? { type: 'string', enum: localIds } : string, quote: string });
  const bubbleCheck = objectSchema({ index: { type: 'integer', enum: Array.from({ length: draftCount }, (_, index) => index) }, issue: { type: 'string', enum: DRAFT_REVIEW_ISSUES },
    messageId: localIds.length ? { anyOf: [{ type: 'string', enum: localIds }, { type: 'null' }] } : { type: 'null' }, quote: string });
  return objectSchema({
    bubbleChecks: array(bubbleCheck),
    decision: { type: 'string', enum: ['accept', 'reject'] }, replacementBubbles: array(bubbleSchema),
    // DeepSeek rejects empty-object schemas. Omit inapplicable maps, never add fake IDs.
    ...(requiredIds.length ? { coverage: objectSchema(Object.fromEntries(requiredIds.map(id => [id, coverageSchema]))) } : {}),
    topics: array(objectSchema({ key: string,
      memoryId: memoryIds.length ? { anyOf: [{ type: 'string', enum: memoryIds }, { type: 'null' }] } : { type: 'null' },
      summary: string, sourceKind: sourceKindSchema, evidenceMessageIds: idArray(localIds) })),
    ...(scenes ? { sceneUpdate: { anyOf: [objectSchema({ scene: objectSchema({ kind: { type: 'string', enum: SCENE_KINDS },
      setting: { type: ['string', 'null'] }, plan: { type: ['string', 'null'] }, proximity: { type: 'string', enum: ['ordinary', 'close'] },
      speaking: { type: 'string', enum: ['normal', 'quiet'] } }), evidence: array(proof), responseQuote: string }), { type: 'null' }] } } : {}),
    ...(relationships ? { relationshipEvents: array(objectSchema({ kind: { type: 'string', enum: RELATIONSHIP_EVENT_KINDS },
      key: string, anchor: proof, evidence: array(proof), responseQuote: string, summary: string,
      basis: { type: 'string', enum: ['in_chat', 'player_report'] }, repairsEventId: { type: ['string', 'null'] } })) } : {}),
    ...(sourceIds.length ? { sourceUsage: objectSchema(Object.fromEntries(sourceIds.map(id => [id, array(string)]))) } : {}),
  });
}
export function reviewTool(request: TextGenerationRequest, draft: TextDraft) {
  ensure(Array.isArray(draft.bubbles) && draft.bubbles.length > 0 && draft.bubbles.length <= DRAFT_BUBBLE_LIMITS.maxBubbles, 'INVALID_DRAFT_SCHEMA');
  const localIds = [...new Set([...request.messages.map(item => item.id),
    ...(request.clarifications ?? []).flatMap(item => item.messages.map(message => message.id))])];
  return tool('submit_dialogue_audit', '先逐条检查所有草稿气泡，再提交修正、回答状态与来源；不执行操作。',
    reviewSchema(draft.bubbles.length, request.requiredMessageIds, localIds, request.evidence.map(source => source.id), request.relationshipContext?.auditEnabled,
      !!request.sceneContext, memoryReferences(request).map(memory => memory.id)));
}
// Include schema changes in the preview approval fingerprint, not just prose changes.
export const protocolFingerprint = () => [TEXT_PROTOCOL_VERSION, DEFAULT_TEXT_MODELS, BUBBLE_LIMITS, VOICE_BUBBLE_LIMITS, DRAFT_BUBBLE_LIMITS, draftSchema, speechDraftSchema,
  reviewSchema(3, ['required-id'], ['local-id'], ['source-id'], true, true, ['memory-id']), reviewSchema(1, [], [], [])];

function exact(value: unknown, keys: string[], code: string): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), code);
}
function boundedText(value: unknown, limit: number): asserts value is string {
  ensure(typeof value === 'string' && [...value].length <= limit && !/[\r\n]/u.test(value), 'INVALID_REVIEW_COVERAGE');
}

export function parseTextDraft(value: unknown, request: TextGenerationRequest): TextDraft {
  if (request.deliveryMode === 'voice') {
    exact(value, ['mode', 'utterance', 'afterthoughts', 'endsSession'], 'INVALID_DRAFT_SCHEMA');
    ensure(Array.isArray(value.afterthoughts) && value.afterthoughts.length < DRAFT_BUBBLE_LIMITS.maxBubbles, 'INVALID_BUBBLES');
    return parsePresentation({ mode: value.mode, bubbles: [value.utterance, ...value.afterthoughts], endsSession: value.endsSession }, request, 'draft');
  }
  return parsePresentation(value, request, 'draft');
}
function parsePresentation(value: unknown, request: TextGenerationRequest, phase: 'draft' | 'final'): TextDraft {
  exact(value, ['mode', 'bubbles', 'endsSession'], 'INVALID_DRAFT_SCHEMA');
  ensure(value.mode === 'casual' || value.mode === 'conflict_apology', 'INVALID_REPLY_SCHEMA');
  ensure(typeof value.endsSession === 'boolean', 'INVALID_REPLY_SCHEMA');
  ensure(!request.mustClose || value.endsSession, 'CLOSING_REQUIRED');
  const bubbles = validatedBubbles(value.bubbles, phase === 'draft' ? DRAFT_BUBBLE_LIMITS : bubbleLimits(request.deliveryMode)[value.mode]);
  return { mode: value.mode, bubbles, endsSession: value.endsSession };
}

export function validateDialogueEvidence(candidate: DialogueCandidate, request: TextGenerationRequest) {
  const clarificationIds = new Set((request.clarifications ?? []).flatMap(item => item.messages.map(message => message.id)));
  const memories = candidate.topics.some(topic => topic.linkedMemoryId !== undefined) ? memoryReferences(request) : [];
  for (const topic of candidate.topics) {
    if (topic.linkedMemoryId !== undefined) ensure(memories.some(memory => memory.id === topic.linkedMemoryId && memory.key === topic.key), 'INVALID_MEMORY_LINK');
    ensure(topic.evidenceMessageIds.every(id => request.messages.some(message => message.id === id &&
      (topic.sourceKind !== 'player_statement' || message.authorKind === 'player')) ||
      (topic.sourceKind !== 'player_statement' && clarificationIds.has(id))), 'INVALID_MEMORY_EVIDENCE');
    ensure(topic.sourceKind !== 'player_statement' || topic.evidenceMessageIds.length > 0, 'INVALID_MEMORY_EVIDENCE');
    ensure((topic.sourceEvidenceIds ?? []).every(id => request.evidence.some(source => source.id === id)), 'INVALID_SOURCE_EVIDENCE');
  }
}

export function applyTextReview(value: unknown, draft: TextDraft, request: TextGenerationRequest): DialogueCandidate {
  exact(value, ['bubbleChecks', 'decision', 'replacementBubbles', 'topics', ...(request.requiredMessageIds.length ? ['coverage'] : []),
    ...(request.evidence.length ? ['sourceUsage'] : []), ...(request.relationshipContext?.auditEnabled ? ['relationshipEvents'] : []), ...(request.sceneContext ? ['sceneUpdate'] : [])], 'INVALID_REVIEW_SCHEMA');
  ensure(value.decision === 'accept' || value.decision === 'reject', 'INVALID_REVIEW_SCHEMA');
  ensure(value.decision === 'accept', 'TEXT_REVIEW_REJECTED');
  ensure(Array.isArray(value.replacementBubbles), 'INVALID_REVIEW_SCHEMA');
  const coverage = value.coverage ?? {}, sourceUsage = value.sourceUsage ?? {};
  exact(coverage, request.requiredMessageIds, 'INCOMPLETE_COVERAGE');
  exact(sourceUsage, request.evidence.map(source => source.id), 'INVALID_SOURCE_EVIDENCE');
  // The auditor cannot accidentally remove mode/closing, nor introduce unrelated root fields.
  const presentation = parsePresentation({ ...draft, bubbles: value.replacementBubbles.length ? value.replacementBubbles : draft.bubbles }, request, 'final');
  validateBubbleChecks(value.bubbleChecks, draft, presentation, request);
  if (request.conversation?.kind === 'moment_post') ensure(presentation.mode === 'casual' && presentation.bubbles.length === 1 && !presentation.endsSession, 'INVALID_MOMENT_POST');
  const coveredMessageIds: string[] = [], deferredMessageIds: string[] = [], awaitingPlayerMessageIds: string[] = [];
  for (const id of request.requiredMessageIds) {
    const item = coverage[id];
    exact(item, ['status', 'supportQuote', 'missingInformation'], 'INVALID_REVIEW_COVERAGE');
    boundedText(item.supportQuote, 160); boundedText(item.missingInformation, 240);
    if (item.status === 'answered') {
      ensure(item.supportQuote.trim().length > 0 && presentation.bubbles.some(bubble => bubble.text.includes(item.supportQuote as string)) &&
        item.missingInformation === '', 'INVALID_REVIEW_COVERAGE');
      coveredMessageIds.push(id);
    } else if (item.status === 'needs_player') {
      const previous = request.clarifications?.find(clarification => clarification.messageId === id)?.messages ?? [];
      ensure(item.supportQuote.trim().length > 0 && item.missingInformation.trim().length > 0 &&
        [...presentation.bubbles, ...previous].some(message => message.text.includes(item.supportQuote as string)), 'INVALID_REVIEW_COVERAGE');
      awaitingPlayerMessageIds.push(id);
    } else {
      ensure(item.status === 'later' && item.supportQuote === '' && item.missingInformation === '', 'INVALID_REVIEW_COVERAGE');
      deferredMessageIds.push(id);
    }
  }
  ensure(Array.isArray(value.topics) && value.topics.length <= 3, 'INVALID_TOPICS');
  const memories = memoryReferences(request), aliases = new Map<string, string>();
  const proposedKeys = new Set<string>();
  const topics = value.topics.map(topic => {
    exact(topic, ['key', 'memoryId', 'summary', 'sourceKind', 'evidenceMessageIds'], 'INVALID_TOPICS');
    ensure(typeof topic.key === 'string', 'INVALID_TOPICS'); const key = topicKey(topic.key);
    ensure(/^[\p{L}\p{N} _.-]{1,64}$/u.test(key) && !proposedKeys.has(key), 'INVALID_TOPICS'); proposedKeys.add(key);
    ensure(topic.memoryId === null || (typeof topic.memoryId === 'string' && memories.some(memory => memory.id === topic.memoryId)), 'INVALID_MEMORY_LINK');
    const named = memories.find(memory => memory.key === key);
    const linked = topic.memoryId === null ? named : memories.find(memory => memory.id === topic.memoryId)!;
    ensure(!linked || !named || linked.id === named.id, 'INVALID_MEMORY_LINK');
    const canonicalKey = linked?.key ?? key;
    for (const name of [key, canonicalKey]) {
      ensure(!aliases.has(name) || aliases.get(name) === canonicalKey, 'INVALID_MEMORY_LINK'); aliases.set(name, canonicalKey);
    }
    return { key: canonicalKey, summary: topic.summary, sourceKind: topic.sourceKind, evidenceMessageIds: topic.evidenceMessageIds,
      ...(linked ? { linkedMemoryId: linked.id } : {}) };
  });
  const candidate = dialogueCandidate({ ...presentation, coveredMessageIds, deferredMessageIds, awaitingPlayerMessageIds,
    topics, ...(request.sceneContext ? { sceneUpdate: value.sceneUpdate } : {}), ...(request.relationshipContext?.auditEnabled ? { relationshipEvents: value.relationshipEvents } : {}) }, request.requiredMessageIds, request.mustClose, request.deliveryMode);
  const sourcesByTopic = new Map(candidate.topics.map(topic => [topic.key, [] as string[]]));
  for (const [sourceId, keys] of Object.entries(sourceUsage)) {
    ensure(Array.isArray(keys) && keys.length <= 3 && keys.every(key => typeof key === 'string'), 'INVALID_SOURCE_EVIDENCE');
    const normalized = (keys as string[]).map(key => aliases.get(topicKey(key)));
    ensure(normalized.every((key): key is string => key !== undefined && sourcesByTopic.has(key)) &&
      new Set(normalized).size === normalized.length, 'INVALID_SOURCE_EVIDENCE');
    for (const key of normalized) sourcesByTopic.get(key)!.push(sourceId);
  }
  for (const topic of candidate.topics) {
    topic.sourceEvidenceIds = sourcesByTopic.get(topic.key)!;
    ensure(topic.sourceEvidenceIds.length <= 8, 'INVALID_SOURCE_EVIDENCE');
  }
  if (request.sceneContext) candidate.sceneUpdate = changedScene(candidate.sceneUpdate, request.sceneContext);
  validateSceneEvidence(candidate.sceneUpdate, request.sceneContext, request.messages, candidate, request.messages.find(message => message.authorKind === 'player')?.authorId ?? '');
  validateDialogueEvidence(candidate, request);
  return candidate;
}

function validateBubbleChecks(value: unknown, draft: TextDraft, final: TextDraft, request: TextGenerationRequest): void {
  ensure(Array.isArray(value) && value.length === draft.bubbles.length, 'INCOMPLETE_BUBBLE_REVIEW');
  const messages = [...request.messages, ...(request.clarifications ?? []).flatMap(item => item.messages)];
  const changed = JSON.stringify(final.bubbles) !== JSON.stringify(draft.bubbles);
  const indices = new Set<number>();
  for (const item of value) {
    exact(item, ['index', 'issue', 'messageId', 'quote'], 'INVALID_BUBBLE_REVIEW');
    ensure(Number.isInteger(item.index) && Number(item.index) >= 0 && Number(item.index) < draft.bubbles.length && !indices.has(Number(item.index)), 'INCOMPLETE_BUBBLE_REVIEW');
    indices.add(Number(item.index));
    ensure(DRAFT_REVIEW_ISSUES.some(issue => issue === item.issue) && typeof item.quote === 'string' &&
      [...item.quote].length <= 160 && !/[\r\n]/u.test(item.quote), 'INVALID_BUBBLE_REVIEW');
    ensure(item.messageId === null ? item.quote === '' : typeof item.messageId === 'string' && item.quote.trim().length > 0 &&
      messages.some(message => message.id === item.messageId && message.text.includes(item.quote as string)), 'INVALID_BUBBLE_REVIEW_EVIDENCE');
    if (item.issue !== 'none') ensure(changed, 'UNREPAIRED_DRAFT_ISSUE');
    // A flagged factual/boundary error cannot survive as an unchanged standalone bubble.
    // This validates the repair contract, not the semantic correctness of an unflagged claim.
    if (['subject', 'unconfirmed_action', 'unsupported_fact', 'boundary', 'instruction'].includes(String(item.issue))) {
      ensure(!final.bubbles.some(bubble => bubble.text === draft.bubbles[Number(item.index)]!.text), 'UNREPAIRED_DRAFT_ISSUE');
    }
  }
}
