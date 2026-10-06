import type { DialogueCandidate } from '../contracts/index.ts';
import { ensure } from './errors.ts';
import { bubbleLimits, validatedBubbles } from './bubbles.ts';
import { sceneUpdate } from './scenes.ts';
import { relationshipCandidates } from './relationships.ts';

export const DIALOGUE = Object.freeze({
  continuationMs: 60_000,
  shortMemoryMs: 48 * 60 * 60_000,
  promotionMentions: 2,
  // A topic without a review importance (older candidates) is recorded as ordinary small talk.
  defaultImportance: 3,
  recallStep: 0.01,
  maxRecallBonus: 0.03,
});
function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REPLY_SCHEMA');
}
function ids(value: unknown): asserts value is string[] {
  ensure(
    Array.isArray(value) &&
      value.length <= 32 &&
      value.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128) &&
      new Set(value).size === value.length,
    'INCOMPLETE_COVERAGE',
  );
}
export const importanceValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
export function topicKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}
/** Parse the model's v2 wire format; derived legacy text is never accepted from the model. */
export function dialogueCandidate(
  value: unknown,
  requiredIds: string[],
  mustClose: boolean,
  delivery: 'text' | 'voice' = 'text',
): DialogueCandidate {
  object(value);
  const keys = Object.keys(value)
    .filter((key) => key !== 'relationshipEvents' && key !== 'sceneUpdate')
    .sort()
    .join(',');
  ensure(
    keys === 'bubbles,coveredMessageIds,deferredMessageIds,endsSession,mode,topics' ||
      keys === 'awaitingPlayerMessageIds,bubbles,coveredMessageIds,deferredMessageIds,endsSession,mode,topics',
    'INVALID_REPLY_SCHEMA',
  );
  ensure(value.mode === 'casual' || value.mode === 'conflict_apology', 'INVALID_REPLY_SCHEMA');
  const bubbles = validatedBubbles(value.bubbles, bubbleLimits(delivery)[value.mode]);
  ids(value.coveredMessageIds);
  ids(value.deferredMessageIds);
  const awaitingPlayerMessageIds = Object.hasOwn(value, 'awaitingPlayerMessageIds')
    ? value.awaitingPlayerMessageIds
    : [];
  ids(awaitingPlayerMessageIds);
  const partition = [...value.coveredMessageIds, ...value.deferredMessageIds, ...awaitingPlayerMessageIds];
  ensure(
    new Set(partition).size === partition.length &&
      JSON.stringify(partition.sort()) === JSON.stringify([...requiredIds].sort()),
    'INCOMPLETE_COVERAGE',
  );
  ensure(typeof value.endsSession === 'boolean', 'INVALID_REPLY_SCHEMA');
  ensure(!mustClose || value.endsSession, 'CLOSING_REQUIRED');
  ensure(Array.isArray(value.topics) && value.topics.length <= 3, 'INVALID_TOPICS');
  const topics = value.topics.map((topic) => {
    object(topic);
    const keys = Object.keys(topic)
      .filter((key) => key !== 'linkedMemoryId' && key !== 'importance')
      .sort()
      .join(',');
    ensure(
      (keys === 'evidenceMessageIds,key,sourceKind,summary' ||
        keys === 'evidenceMessageIds,key,sourceEvidenceIds,sourceKind,summary') &&
        typeof topic.key === 'string' &&
        typeof topic.summary === 'string' &&
        topic.summary.trim().length > 0 &&
        [...topic.summary].length <= 240 &&
        ['fictional_daily', 'player_statement', 'conversation'].includes(String(topic.sourceKind)),
      'INVALID_TOPICS',
    );
    const key = topicKey(topic.key);
    ensure(/^[\p{L}\p{N} _.-]{1,64}$/u.test(key), 'INVALID_TOPICS');
    if (Object.hasOwn(topic, 'linkedMemoryId'))
      ensure(
        typeof topic.linkedMemoryId === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(topic.linkedMemoryId),
        'INVALID_MEMORY_LINK',
      );
    if (Object.hasOwn(topic, 'importance')) ensure(importanceValue(topic.importance), 'INVALID_TOPICS');
    ids(topic.evidenceMessageIds);
    ensure(topic.evidenceMessageIds.length <= 8, 'INVALID_TOPICS');
    if (Object.hasOwn(topic, 'sourceEvidenceIds')) {
      ids(topic.sourceEvidenceIds);
      ensure(topic.sourceEvidenceIds.length <= 8, 'INVALID_TOPICS');
    }
    return {
      key,
      summary: topic.summary,
      sourceKind: topic.sourceKind as DialogueCandidate['topics'][number]['sourceKind'],
      evidenceMessageIds: topic.evidenceMessageIds,
      ...(Object.hasOwn(topic, 'sourceEvidenceIds') ? { sourceEvidenceIds: topic.sourceEvidenceIds as string[] } : {}),
      ...(Object.hasOwn(topic, 'linkedMemoryId') ? { linkedMemoryId: topic.linkedMemoryId as string } : {}),
      ...(Object.hasOwn(topic, 'importance') ? { importance: topic.importance as number } : {}),
    };
  });
  ensure(new Set(topics.map((topic) => topic.key)).size === topics.length, 'INVALID_TOPICS');
  return {
    text: bubbles.map((bubble) => bubble.text).join('\n'),
    delivery: 'text',
    bubbles,
    mode: value.mode,
    coveredMessageIds: value.coveredMessageIds,
    deferredMessageIds: value.deferredMessageIds,
    awaitingPlayerMessageIds,
    endsSession: value.endsSession,
    topics,
    ...(Object.hasOwn(value, 'sceneUpdate') ? { sceneUpdate: sceneUpdate(value.sceneUpdate) } : {}),
    ...(Object.hasOwn(value, 'relationshipEvents')
      ? { relationshipEvents: relationshipCandidates(value.relationshipEvents) }
      : {}),
  };
}
export function dialogueWire(candidate: DialogueCandidate) {
  const { bubbles, mode, coveredMessageIds, deferredMessageIds, awaitingPlayerMessageIds, endsSession, topics } =
    candidate;
  return {
    bubbles,
    mode,
    coveredMessageIds,
    deferredMessageIds,
    awaitingPlayerMessageIds,
    endsSession,
    topics,
    ...(Object.hasOwn(candidate, 'sceneUpdate') ? { sceneUpdate: candidate.sceneUpdate } : {}),
    ...(candidate.relationshipEvents ? { relationshipEvents: candidate.relationshipEvents } : {}),
  };
}
