// Accepted v7 baseline from 初v.0.0.0911; kept separate from the deferred v8–v10 experiment.
import type { DialogueCandidate, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { EXPRESSIONS, SOUND_CUES } from '../../../packages/contracts/index.ts';
import { dialogueCandidate, importanceValue, topicKey } from '../../../packages/domain/dialogue.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import {
  BUBBLE_LIMITS,
  VOICE_BUBBLE_LIMITS,
  bubbleLimits,
  DRAFT_BUBBLE_LIMITS,
  validatedBubbles,
} from '../../../packages/domain/bubbles.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { SCENE_KINDS } from '../../../packages/contracts/scenes.ts';
import { changedScene, validateSceneEvidence } from '../../../packages/domain/scenes.ts';
import { RELATIONSHIP_EVENT_KINDS } from '../../../packages/contracts/relationships.ts';

export type TextDraft = Pick<DialogueCandidate, 'mode' | 'bubbles' | 'endsSession'>;
export const TEXT_PROTOCOL_VERSION = 'strict_draft_audit_v7_spoken_turn';
type Schema = Record<string, unknown>;
const objectSchema = (properties: Record<string, Schema>): Schema => ({
  type: 'object',
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const string = { type: 'string' };
const array = (items: Schema): Schema => ({ type: 'array', items });
const idArray = (ids: string[]) => array(ids.length ? { type: 'string', enum: ids } : string);
const bubbleSchema = objectSchema({ text: string, expression: { type: 'string', enum: EXPRESSIONS } });
const draftSchema = objectSchema({
  mode: { type: 'string', enum: ['casual', 'conflict_apology'] },
  bubbles: array(bubbleSchema),
  endsSession: { type: 'boolean' },
});
// Strict structured output has no optional keys: "none" is the optional enum's absent value and is dropped on parse.
const spokenBubbleSchema = objectSchema({
  text: string,
  expression: { type: 'string', enum: EXPRESSIONS },
  soundCue: {
    type: 'string',
    enum: ['none', ...SOUND_CUES],
    description: '可选的一个声音提示，整段话至多一次；不需要就填none。不要在text里写任何方括号或标签。',
  },
});
const speechDraftSchema = objectSchema({
  mode: { type: 'string', enum: ['casual', 'conflict_apology'] },
  utterance: {
    ...spokenBubbleSchema,
    description: '这一刻自然说出口的一段话。完整表达当前意思；短应声也可以，不为分条截断句子。',
  },
  afterthoughts: {
    ...array(spokenBubbleSchema),
    description: '只有说完后确实另补一句或转换情绪才填写；没有补充用空数组，不续写上一条没说完的句子。',
  },
  endsSession: { type: 'boolean' },
});
const coverageSchema = objectSchema({
  status: { type: 'string', enum: ['answered', 'needs_player', 'later'] },
  supportQuote: string,
  missingInformation: string,
});
const sourceKindSchema = { type: 'string', enum: ['fictional_daily', 'player_statement', 'conversation'] };

const tool = (name: string, description: string, parameters: Schema) => ({
  type: 'function' as const,
  function: { name, description, strict: true, parameters },
});
// These are structured output envelopes, never executable tools or permission to publish.
export const draftTool = (delivery: 'text' | 'voice' = 'text') =>
  tool(
    'submit_dialogue_draft',
    delivery === 'voice'
      ? '提交角色要说出口的话与可选的独立补充；不是填满几个文字气泡。'
      : '提交尚未发布的角色短气泡，仅用于结构化输出。',
    delivery === 'voice' ? speechDraftSchema : draftSchema,
  );
const importanceSchema = { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] };
// A topic either continues one of the memories recalled for this request (its catalog id) or starts a new one (null).
const memoryIdSchema = (ids: string[]): Schema =>
  ids.length ? { anyOf: [{ type: 'string', enum: ids }, { type: 'null' }] } : { type: 'null' };
function reviewSchema(
  requiredIds: string[],
  localIds: string[],
  sourceIds: string[],
  relationships = false,
  scenes = false,
  memoryIds: string[] = [],
) {
  const proof = objectSchema({
    messageId: localIds.length ? { type: 'string', enum: localIds } : string,
    quote: string,
  });
  return objectSchema({
    decision: { type: 'string', enum: ['accept', 'reject'] },
    replacementBubbles: array(bubbleSchema),
    // DeepSeek rejects empty-object schemas. Omit inapplicable maps, never add fake IDs.
    ...(requiredIds.length
      ? { coverage: objectSchema(Object.fromEntries(requiredIds.map((id) => [id, coverageSchema]))) }
      : {}),
    topics: array(
      objectSchema({
        key: string,
        memoryId: memoryIdSchema(memoryIds),
        summary: string,
        importance: importanceSchema,
        sourceKind: sourceKindSchema,
        evidenceMessageIds: idArray(localIds),
      }),
    ),
    ...(scenes
      ? {
          sceneUpdate: {
            anyOf: [
              objectSchema({
                scene: objectSchema({
                  kind: { type: 'string', enum: SCENE_KINDS },
                  setting: { type: ['string', 'null'] },
                  plan: { type: ['string', 'null'] },
                  proximity: { type: 'string', enum: ['ordinary', 'close'] },
                  speaking: { type: 'string', enum: ['normal', 'quiet'] },
                }),
                evidence: array(proof),
                responseQuote: string,
              }),
              { type: 'null' },
            ],
          },
        }
      : {}),
    ...(relationships
      ? {
          relationshipEvents: array(
            objectSchema({
              kind: { type: 'string', enum: RELATIONSHIP_EVENT_KINDS },
              key: string,
              anchor: proof,
              evidence: array(proof),
              responseQuote: string,
              summary: string,
              basis: { type: 'string', enum: ['in_chat', 'player_report'] },
              repairsEventId: { type: ['string', 'null'] },
            }),
          ),
        }
      : {}),
    factOps: array(
      objectSchema({
        op: { type: 'string', enum: ['add', 'update', 'retire'] },
        factKey: string,
        statement: string,
        importance: importanceSchema,
        evidenceMessageIds: idArray(localIds),
      }),
    ),
    ...(sourceIds.length
      ? { sourceUsage: objectSchema(Object.fromEntries(sourceIds.map((id) => [id, array(string)]))) }
      : {}),
  });
}
/** Catalog ids of the memories recalled for this request: the only ids a review topic may link to. */
export const recalledMemoryIds = (request: TextGenerationRequest) =>
  (request.memories ?? []).flatMap((memory) => (memory.id === undefined ? [] : [memory.id]));
export function reviewTool(request: TextGenerationRequest) {
  const localIds = [
    ...new Set([
      ...request.messages.map((item) => item.id),
      ...(request.clarifications ?? []).flatMap((item) => item.messages.map((message) => message.id)),
    ]),
  ];
  return tool(
    'submit_dialogue_audit',
    '独立审核候选，逐项标记回答状态与来源；不执行操作。',
    reviewSchema(
      request.requiredMessageIds,
      localIds,
      request.evidence.map((source) => source.id),
      request.relationshipContext?.auditEnabled,
      !!request.sceneContext,
      recalledMemoryIds(request),
    ),
  );
}
// Include schema changes in the preview approval fingerprint, not just prose changes.
export const protocolFingerprint = () => [
  TEXT_PROTOCOL_VERSION,
  DEFAULT_TEXT_MODELS,
  BUBBLE_LIMITS,
  VOICE_BUBBLE_LIMITS,
  DRAFT_BUBBLE_LIMITS,
  draftSchema,
  speechDraftSchema,
  reviewSchema(['required-id'], ['local-id'], ['source-id'], true, true, ['memory-id']),
  reviewSchema([], [], []),
];

function exact(value: unknown, keys: string[], code: string): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()),
    code,
  );
}
function boundedText(value: unknown, limit: number): asserts value is string {
  ensure(typeof value === 'string' && [...value].length <= limit && !/[\r\n]/u.test(value), 'INVALID_REVIEW_COVERAGE');
}

/** A coverage quote may sit in one bubble or span 2+ consecutive bubbles (joined with "" or one space). */
function quoteInBubbles(bubbles: readonly { text: string }[], quote: string): boolean {
  for (let start = 0; start < bubbles.length; start++) {
    let plain = '',
      spaced = '';
    for (let end = start; end < bubbles.length; end++) {
      plain += bubbles[end]!.text;
      spaced += (end > start ? ' ' : '') + bubbles[end]!.text;
      if (plain.includes(quote) || spaced.includes(quote)) return true;
    }
  }
  return false;
}

export function parseTextDraft(value: unknown, request: TextGenerationRequest): TextDraft {
  if (request.deliveryMode === 'voice') {
    exact(value, ['mode', 'utterance', 'afterthoughts', 'endsSession'], 'INVALID_DRAFT_SCHEMA');
    ensure(
      Array.isArray(value.afterthoughts) && value.afterthoughts.length < DRAFT_BUBBLE_LIMITS.maxBubbles,
      'INVALID_BUBBLES',
    );
    // "none" only means no cue; any other value (or a key on a text-delivery bubble) is validated strictly downstream.
    const spoken = [value.utterance, ...value.afterthoughts].map((bubble) =>
      bubble &&
      typeof bubble === 'object' &&
      !Array.isArray(bubble) &&
      (bubble as Record<string, unknown>).soundCue === 'none'
        ? Object.fromEntries(Object.entries(bubble).filter(([key]) => key !== 'soundCue'))
        : bubble,
    );
    return parsePresentation({ mode: value.mode, bubbles: spoken, endsSession: value.endsSession }, request, 'draft');
  }
  return parsePresentation(value, request, 'draft');
}
function parsePresentation(value: unknown, request: TextGenerationRequest, phase: 'draft' | 'final'): TextDraft {
  exact(value, ['mode', 'bubbles', 'endsSession'], 'INVALID_DRAFT_SCHEMA');
  ensure(value.mode === 'casual' || value.mode === 'conflict_apology', 'INVALID_REPLY_SCHEMA');
  ensure(typeof value.endsSession === 'boolean', 'INVALID_REPLY_SCHEMA');
  ensure(!request.mustClose || value.endsSession, 'CLOSING_REQUIRED');
  const bubbles = validatedBubbles(
    value.bubbles,
    phase === 'draft' ? DRAFT_BUBBLE_LIMITS : bubbleLimits(request.deliveryMode)[value.mode],
  );
  return { mode: value.mode, bubbles, endsSession: value.endsSession };
}

export function validateDialogueEvidence(candidate: DialogueCandidate, request: TextGenerationRequest) {
  const clarificationIds = new Set(
    (request.clarifications ?? []).flatMap((item) => item.messages.map((message) => message.id)),
  );
  // A player fact comes only from player-authored messages of this very request (never a character's or a clarification).
  for (const op of candidate.factOps ?? [])
    ensure(
      op.evidenceMessageIds.every((id) =>
        request.messages.some((message) => message.id === id && message.authorKind === 'player'),
      ),
      'INVALID_MEMORY_EVIDENCE',
    );
  for (const topic of candidate.topics) {
    ensure(
      topic.evidenceMessageIds.every(
        (id) =>
          request.messages.some(
            (message) =>
              message.id === id && (topic.sourceKind !== 'player_statement' || message.authorKind === 'player'),
          ) ||
          (topic.sourceKind !== 'player_statement' && clarificationIds.has(id)),
      ),
      'INVALID_MEMORY_EVIDENCE',
    );
    ensure(topic.sourceKind !== 'player_statement' || topic.evidenceMessageIds.length > 0, 'INVALID_MEMORY_EVIDENCE');
    // A link is valid only to a memory recalled for THIS request, under that memory's own key.
    ensure(
      topic.linkedMemoryId === undefined ||
        (request.memories ?? []).some((memory) => memory.id === topic.linkedMemoryId && memory.key === topic.key),
      'INVALID_MEMORY_LINK',
    );
    ensure(
      (topic.sourceEvidenceIds ?? []).every((id) => request.evidence.some((source) => source.id === id)),
      'INVALID_SOURCE_EVIDENCE',
    );
  }
}

/**
 * `dropInvalidMetadata` is what every production caller passes (generation, queue re-validation, previews): topics or
 * factOps that are still invalid after normalization cost the turn its memory, not its reply. Without it the review is
 * validated strictly end to end (the unit tests of the individual checks).
 */
export interface ReviewOptions {
  dropInvalidMetadata?: boolean;
}
export const DROP_INVALID_METADATA: ReviewOptions = { dropInvalidMetadata: true };
export function applyTextReview(
  value: unknown,
  draft: TextDraft,
  request: TextGenerationRequest,
  options: ReviewOptions = {},
): DialogueCandidate {
  exact(
    value,
    [
      'decision',
      'replacementBubbles',
      'topics',
      'factOps',
      ...(request.requiredMessageIds.length ? ['coverage'] : []),
      ...(request.evidence.length ? ['sourceUsage'] : []),
      ...(request.relationshipContext?.auditEnabled ? ['relationshipEvents'] : []),
      ...(request.sceneContext ? ['sceneUpdate'] : []),
    ],
    'INVALID_REVIEW_SCHEMA',
  );
  ensure(value.decision === 'accept' || value.decision === 'reject', 'INVALID_REVIEW_SCHEMA');
  // A "reject" that still hands over publishable replacement bubbles is an "accept" of those bubbles: the model used the
  // wrong word for a rewrite. Everything below (schema, presentation, coverage, topics, facts, ...) still applies to it
  // unchanged, so a bad replacement fails with the same code as before. "reject" with no bubbles stays rejected.
  const decisionNormalized =
    value.decision === 'reject' && Array.isArray(value.replacementBubbles) && value.replacementBubbles.length > 0;
  ensure(value.decision === 'accept' || decisionNormalized, 'TEXT_REVIEW_REJECTED');
  ensure(Array.isArray(value.replacementBubbles), 'INVALID_REVIEW_SCHEMA');
  const coverage = value.coverage ?? {},
    sourceUsage = value.sourceUsage ?? {};
  exact(coverage, request.requiredMessageIds, 'INCOMPLETE_COVERAGE');
  exact(
    sourceUsage,
    request.evidence.map((source) => source.id),
    'INVALID_SOURCE_EVIDENCE',
  );
  // The auditor cannot accidentally remove mode/closing, nor introduce unrelated root fields.
  const presentation = parsePresentation(
    { ...draft, bubbles: value.replacementBubbles.length ? value.replacementBubbles : draft.bubbles },
    request,
    'final',
  );
  if (request.conversation?.kind === 'moment_post')
    ensure(
      presentation.mode === 'casual' && presentation.bubbles.length === 1 && !presentation.endsSession,
      'INVALID_MOMENT_POST',
    );
  const coveredMessageIds: string[] = [],
    deferredMessageIds: string[] = [],
    awaitingPlayerMessageIds: string[] = [];
  for (const id of request.requiredMessageIds) {
    const item = coverage[id];
    exact(item, ['status', 'supportQuote', 'missingInformation'], 'INVALID_REVIEW_COVERAGE');
    boundedText(item.supportQuote, 160);
    boundedText(item.missingInformation, 240);
    if (item.status === 'answered') {
      ensure(
        item.supportQuote.trim().length > 0 &&
          quoteInBubbles(presentation.bubbles, item.supportQuote) &&
          item.missingInformation === '',
        'INVALID_REVIEW_COVERAGE',
      );
      coveredMessageIds.push(id);
    } else if (item.status === 'needs_player') {
      const previous = request.clarifications?.find((clarification) => clarification.messageId === id)?.messages ?? [];
      ensure(
        item.supportQuote.trim().length > 0 &&
          item.missingInformation.trim().length > 0 &&
          (quoteInBubbles(presentation.bubbles, item.supportQuote) || quoteInBubbles(previous, item.supportQuote)),
        'INVALID_REVIEW_COVERAGE',
      );
      awaitingPlayerMessageIds.push(id);
    } else {
      ensure(
        item.status === 'later' && item.supportQuote === '' && item.missingInformation === '',
        'INVALID_REVIEW_COVERAGE',
      );
      deferredMessageIds.push(id);
    }
  }
  // Topics and factOps are memory metadata, not the reply: normalize the harmless wire slips first, validate strictly,
  // and when only the metadata is still invalid deliver the reply without it (Part 16). Everything above this point
  // (format, bubbles, coverage, safety) is untouched and still fails the whole reply.
  const topicsWire = normalizeTopics(value.topics),
    factsWire = normalizeFactOps(value.factOps);
  const build = (dropTopics: boolean, dropFacts: boolean): DialogueCandidate => {
    ensure(dropTopics || (Array.isArray(topicsWire) && topicsWire.length <= 3), 'INVALID_TOPICS');
    // A topic with a memoryId continues that recalled memory under its existing key; null starts (or restates) a topic.
    const recalled = new Map(
      (request.memories ?? []).flatMap((memory) => (memory.id ? [[memory.id, memory.key]] : [])),
    );
    const recalledByKey = new Map([...recalled].map(([id, key]) => [key, id]));
    const aliases = new Map<string, string>();
    const topics = (dropTopics ? [] : (topicsWire as unknown[])).map((topic: unknown) => {
      exact(topic, ['key', 'memoryId', 'summary', 'importance', 'sourceKind', 'evidenceMessageIds'], 'INVALID_TOPICS');
      ensure(typeof topic.key === 'string' && importanceValue(topic.importance), 'INVALID_TOPICS');
      ensure(
        topic.memoryId === null || (typeof topic.memoryId === 'string' && recalled.has(topic.memoryId)),
        'INVALID_MEMORY_LINK',
      );
      const named = topicKey(topic.key),
        { memoryId, ...rest } = topic;
      const canonical = memoryId === null ? named : recalled.get(memoryId as string)!;
      // The wording the model chose must not name a different recalled memory, nor two memories share one wording.
      ensure(
        (memoryId === null || (recalledByKey.get(named) ?? memoryId) === memoryId) &&
          (aliases.get(named) ?? canonical) === canonical,
        'INVALID_MEMORY_LINK',
      );
      aliases.set(named, canonical);
      return { ...rest, key: canonical, ...(memoryId === null ? {} : { linkedMemoryId: memoryId }) };
    });
    const candidate = dialogueCandidate(
      {
        ...presentation,
        coveredMessageIds,
        deferredMessageIds,
        awaitingPlayerMessageIds,
        topics,
        factOps: dropFacts ? [] : factsWire,
        ...(request.sceneContext ? { sceneUpdate: value.sceneUpdate } : {}),
        ...(request.relationshipContext?.auditEnabled ? { relationshipEvents: value.relationshipEvents } : {}),
      },
      request.requiredMessageIds,
      request.mustClose,
      request.deliveryMode,
    );
    const sourcesByTopic = new Map(candidate.topics.map((topic) => [topic.key, [] as string[]]));
    for (const [sourceId, keys] of dropTopics ? [] : Object.entries(sourceUsage)) {
      ensure(
        Array.isArray(keys) && keys.length <= 3 && keys.every((key) => typeof key === 'string'),
        'INVALID_SOURCE_EVIDENCE',
      );
      const normalized = (keys as string[]).map((key) => aliases.get(topicKey(key)) ?? topicKey(key));
      ensure(
        new Set(normalized).size === normalized.length && normalized.every((key) => sourcesByTopic.has(key)),
        'INVALID_SOURCE_EVIDENCE',
      );
      for (const key of normalized) sourcesByTopic.get(key)!.push(sourceId);
    }
    for (const topic of candidate.topics) {
      topic.sourceEvidenceIds = sourcesByTopic.get(topic.key)!;
      ensure(topic.sourceEvidenceIds.length <= 8, 'INVALID_SOURCE_EVIDENCE');
    }
    if (request.sceneContext) candidate.sceneUpdate = changedScene(candidate.sceneUpdate, request.sceneContext);
    validateSceneEvidence(
      candidate.sceneUpdate,
      request.sceneContext,
      request.messages,
      candidate,
      request.messages.find((message) => message.authorKind === 'player')?.authorId ?? '',
    );
    validateDialogueEvidence(candidate, request);
    return candidate;
  };
  let candidate: DialogueCandidate;
  try {
    candidate = build(false, false);
  } catch (error) {
    const code = error instanceof DomainError ? error.code : '';
    if (!options.dropInvalidMetadata || !(TOPIC_FAILURES.has(code) || FACT_FAILURES.has(code))) throw error;
    // Drop only what is needed, and only if the rest of the review then validates; otherwise the original error stands.
    candidate = retryWithoutMetadata(build, error);
  }
  candidate.reviewChanged = value.replacementBubbles.length > 0;
  if (decisionNormalized) candidate.reviewDecisionNormalized = true;
  return candidate;
}

// Memory metadata failures that may cost the metadata but never the reply. INVALID_MEMORY_EVIDENCE is raised for both
// topics and facts; the retry order below tells them apart.
const TOPIC_FAILURES = new Set([
  'INVALID_TOPICS',
  'INVALID_MEMORY_LINK',
  'INVALID_SOURCE_EVIDENCE',
  'INVALID_MEMORY_EVIDENCE',
]);
const FACT_FAILURES = new Set(['INVALID_FACTS', 'INVALID_MEMORY_EVIDENCE']);
function retryWithoutMetadata(
  build: (dropTopics: boolean, dropFacts: boolean) => DialogueCandidate,
  original: unknown,
): DialogueCandidate {
  // The first error only names the first thing that failed: try topics alone, facts alone, then both.
  const attempts: [boolean, boolean][] = [
    [true, false],
    [false, true],
    [true, true],
  ];
  for (const [dropTopics, dropFacts] of attempts) {
    try {
      const candidate = build(dropTopics, dropFacts);
      if (dropTopics) candidate.topicsDropped = true;
      if (dropFacts) candidate.factsDropped = true;
      return candidate;
    } catch {
      /* try the next, wider drop */
    }
  }
  throw original;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const keepKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
/** An integer written as a string ("3") is the number; any other value is left for the strict check. */
const integerString = (value: unknown) =>
  typeof value === 'string' && /^[0-9]{1,2}$/.test(value) ? Number(value) : value;
/**
 * Harmless wire slips only: a missing memoryId is null, importance given as an integer string is the number, and keys
 * the schema does not define are dropped. Text, importance range, sourceKind, evidence ids and memory links stay strict.
 */
function normalizeTopics(topics: unknown): unknown {
  if (!Array.isArray(topics)) return topics;
  return topics.map((topic) => {
    if (!isPlain(topic)) return topic;
    const kept = keepKeys(topic, ['key', 'memoryId', 'summary', 'importance', 'sourceKind', 'evidenceMessageIds']);
    return {
      ...kept,
      memoryId: Object.hasOwn(kept, 'memoryId') && kept.memoryId !== undefined ? kept.memoryId : null,
      ...(Object.hasOwn(kept, 'importance') ? { importance: integerString(kept.importance) } : {}),
    };
  });
}
function normalizeFactOps(ops: unknown): unknown {
  if (!Array.isArray(ops)) return ops;
  return ops.map((op) => {
    if (!isPlain(op)) return op;
    const kept = keepKeys(op, ['op', 'factKey', 'statement', 'importance', 'evidenceMessageIds']);
    return Object.hasOwn(kept, 'importance') ? { ...kept, importance: integerString(kept.importance) } : kept;
  });
}
