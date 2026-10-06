// Accepted v7 baseline from 初v.0.0.0911; kept separate from the deferred v8–v10 experiment.
import { createHash } from 'node:crypto';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { EXPRESSIONS } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { localTime } from '../../../packages/domain/schedule.ts';
import { validBirthDate } from '../characters/characters.ts';
import { protocolFingerprint } from './accepted-text-protocol.ts';
import type { TextDraft } from './accepted-text-protocol.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { bubbleLimits, inspectBubbles } from '../../../packages/domain/bubbles.ts';
import { dialogueParts } from '../../../packages/domain/directions.ts';

import { PROMPTS_V7 } from './prompts.generated.ts';

const TEXT_CONTENT_RULES = PROMPTS_V7.textContentRules.replace('{{EXPRESSIONS}}', EXPRESSIONS.join('/'));
const { chatPresentationTask: CHAT_PRESENTATION_TASK, timeContextTask: TIME_CONTEXT_TASK } = PROMPTS_V7;
const {
  speechDraftTask: SPEECH_DRAFT_TASK,
  speechReviewTask: SPEECH_REVIEW_TASK,
  momentPostTask: MOMENT_POST_TASK,
} = PROMPTS_V7;

export const TEXT_SYSTEM_PROMPT =
  TEXT_CONTENT_RULES + PROMPTS_V7.draftSystemBody + CHAT_PRESENTATION_TASK + TIME_CONTEXT_TASK;

export const TEXT_REVIEW_PROMPT =
  TEXT_CONTENT_RULES +
  PROMPTS_V7.reviewSystemBody +
  CHAT_PRESENTATION_TASK +
  PROMPTS_V7.reviewFinalCheck +
  TIME_CONTEXT_TASK;

function promptTimestamp(at: number, now: number, timeZone: string) {
  const local = localTime(at, timeZone),
    current = localTime(now, timeZone);
  const minutes = Math.floor((now - at) / 60_000);
  return {
    localTime: `${local.date} ${String(Math.floor(local.minute / 60)).padStart(2, '0')}:${String(local.minute % 60).padStart(2, '0')}`,
    calendarDaysAgo: (Date.parse(current.date + 'T00:00:00Z') - Date.parse(local.date + 'T00:00:00Z')) / 86_400_000,
    elapsed:
      minutes < 0
        ? '时间晚于当前时钟，间隔未知'
        : minutes < 1
          ? '不足1分钟'
          : minutes < 60
            ? `${minutes}分钟`
            : `${Math.floor(minutes / 60)}小时${minutes % 60}分钟`,
  };
}

export const textPromptHash = () =>
  createHash('sha256')
    .update(JSON.stringify([TEXT_SYSTEM_PROMPT, TEXT_REVIEW_PROMPT, MOMENT_POST_TASK, protocolFingerprint()]))
    .digest('hex');
export const textPolicyHash = (models: { draft: string; review: string } = DEFAULT_TEXT_MODELS) =>
  createHash('sha256')
    .update(JSON.stringify([textPromptHash(), models.draft, models.review]))
    .digest('hex');

export function promptMessages(request: TextGenerationRequest) {
  ensure(
    request.character.id === request.scope.characterId && request.character.fictional === true,
    'INVALID_TEXT_SCOPE',
  );
  ensure(
    Number.isSafeInteger(request.now) && request.now >= 0 && typeof request.mustClose === 'boolean',
    'INVALID_TEXT_REQUEST',
  );
  ensure(
    request.priorServiceFailure === undefined || typeof request.priorServiceFailure === 'boolean',
    'INVALID_TEXT_REQUEST',
  );
  ensure(['new', 'friend', 'close_friend', 'lover'].includes(request.relationship), 'INVALID_RELATIONSHIP');
  ensure(
    Array.isArray(request.requiredMessageIds) &&
      request.requiredMessageIds.length <= 32 &&
      new Set(request.requiredMessageIds).size === request.requiredMessageIds.length &&
      request.requiredMessageIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 128),
    'INVALID_COVERAGE',
  );
  ensure(Array.isArray(request.messages) && request.messages.length <= 64, 'INVALID_TEXT_REQUEST');
  ensure(
    Array.isArray(request.evidence) &&
      request.evidence.length <= 12 &&
      new Set(request.evidence.map((item) => item.id)).size === request.evidence.length &&
      request.evidence.every(
        (item) =>
          typeof item.id === 'string' &&
          item.id.length > 0 &&
          item.id.length <= 128 &&
          typeof item.kind === 'string' &&
          typeof item.text === 'string' &&
          item.text.length <= 8000 &&
          Number.isSafeInteger(item.observedAt) &&
          item.observedAt >= 0,
      ),
    'INVALID_SOURCE_EVIDENCE',
  );
  const conversation = request.conversation;
  if (conversation) {
    ensure(
      ['group', 'moment', 'moment_post'].includes(conversation.kind) &&
        typeof conversation.name === 'string' &&
        conversation.name.length <= 80 &&
        Array.isArray(conversation.members) &&
        conversation.members.length >= (conversation.kind === 'group' ? 2 : 1) &&
        conversation.members.length <= 32 &&
        conversation.members.every(
          (member) =>
            typeof member.id === 'string' &&
            member.id.length > 0 &&
            member.id.length <= 128 &&
            typeof member.name === 'string' &&
            member.name.length <= 100,
        ) &&
        new Set(conversation.members.map((member) => member.id)).size === conversation.members.length &&
        conversation.members.some((member) => member.id === request.character.id),
      'INVALID_TEXT_SCOPE',
    );
    if (conversation.kind === 'moment')
      ensure(
        typeof conversation.postMessageId === 'string' &&
          request.messages.some((message) => message.id === conversation.postMessageId),
        'INVALID_TEXT_SCOPE',
      );
    if (conversation.kind === 'moment_post')
      ensure(
        request.requiredMessageIds.length === 0 &&
          request.messages.length === 0 &&
          !request.playerIntroduction &&
          !request.relationshipContext &&
          !request.sceneContext &&
          !request.proactiveTopic &&
          request.deliveryMode === 'text' &&
          !request.mustClose,
        'INVALID_TEXT_SCOPE',
      );
  }
  const authors = new Set(conversation?.members.map((member) => member.id) ?? [request.character.id]);
  for (const message of request.messages) {
    ensure(
      message.worldId === request.scope.worldId && message.conversationId === request.scope.conversationId,
      'INVALID_TEXT_SCOPE',
    );
    ensure(
      (message.authorKind === 'player' || (message.authorKind === 'character' && authors.has(message.authorId))) &&
        typeof message.text === 'string' &&
        message.text.length <= 8000,
      'INVALID_TEXT_SCOPE',
    );
  }
  const ids = new Set(request.messages.map((message) => message.id));
  const playerIds = new Set(
    request.messages.filter((message) => message.authorKind === 'player').map((message) => message.id),
  );
  ensure(
    ids.size === request.messages.length && request.requiredMessageIds.every((id) => playerIds.has(id)),
    'INVALID_COVERAGE',
  );
  const clarifications = request.clarifications ?? [];
  ensure(
    Array.isArray(clarifications) &&
      clarifications.length <= 32 &&
      new Set(clarifications.map((item) => item.messageId)).size === clarifications.length &&
      clarifications.every(
        (item) =>
          request.requiredMessageIds.includes(item.messageId) &&
          Array.isArray(item.messages) &&
          item.messages.length >= 1 &&
          item.messages.length <= 6 &&
          item.messages.every(
            (message) =>
              typeof message.id === 'string' &&
              message.id.length > 0 &&
              message.id.length <= 128 &&
              typeof message.text === 'string' &&
              [...message.text].length <= 160,
          ),
      ),
    'INVALID_CLARIFICATION_CONTEXT',
  );
  const local = localTime(request.now, request.character.schedule.timeZone);
  const describeTime = (at: number) => promptTimestamp(at, request.now, request.character.schedule.timeZone);
  const coveredTimes = request.messages
    .filter((message) => request.requiredMessageIds.includes(message.id))
    .map((message) => message.createdAt);
  let age: number | null = null;
  if (request.character.birthDate !== undefined) {
    ensure(validBirthDate(request.character.birthDate), 'INVALID_BIRTH_DATE');
    const birth = request.character.birthDate;
    age = Number(local.date.slice(0, 4)) - Number(birth.slice(0, 4)) - (local.date.slice(5) < birth.slice(5) ? 1 : 0);
    ensure(age >= 0 && age <= 150, 'INVALID_BIRTH_DATE');
  }
  const content = JSON.stringify({
    responseConstraints: {
      expressionEnum: EXPRESSIONS,
      deliveryMode: request.deliveryMode ?? 'text',
      interactionKind:
        conversation?.kind === 'moment_post'
          ? 'moment_post'
          : request.proactiveTopic
            ? 'proactive_private_contact'
            : 'reply',
      bubbleLimits: bubbleLimits(request.deliveryMode),
      contextCoverage: { messages: 'bounded_excerpt', groupEvidence: 'observed_excerpt_only' },
    },
    currentTime: new Date(request.now).toISOString(),
    characterTimeZone: request.character.schedule.timeZone,
    currentLocalTime: `${local.date} ${String(Math.floor(local.minute / 60)).padStart(2, '0')}:${String(local.minute % 60).padStart(2, '0')}`,
    localWeekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][local.day],
    responseTiming: {
      oldestCoveredInput: coveredTimes.length ? describeTime(Math.min(...coveredTimes)) : null,
      newestCoveredInput: coveredTimes.length ? describeTime(Math.max(...coveredTimes)) : null,
      priorServiceFailure: request.priorServiceFailure ?? null,
    },
    sceneContext: request.sceneContext ?? null,
    relationship: conversation ? null : request.relationship,
    relationshipContext: request.relationshipContext ?? null,
    playerIntroduction: request.playerIntroduction ?? null,
    age,
    character: {
      id: request.character.id,
      name: request.character.name,
      persona: request.character.persona,
      authorCanon: request.character.authorCanon ?? null,
    },
    conversation: conversation ?? null,
    requiredMessageIds: request.requiredMessageIds,
    mustClose: request.mustClose,
    messages: request.messages.map(({ id, authorKind, authorId, text, createdAt, mentionedCharacterIds, replyTo }) => ({
      id,
      authorKind,
      text,
      ...(authorKind === 'player' && (!conversation || conversation.kind === 'group') ? dialogueParts(text) : {}),
      createdAt,
      sentTime: describeTime(createdAt),
      ...(replyTo ? { replyTo } : {}),
      ...(conversation ? { authorId, mentionedCharacterIds: mentionedCharacterIds ?? [] } : {}),
    })),
    evidence: request.evidence.map((item) => ({ ...item, observedTime: describeTime(item.observedAt) })),

    memories: (request.memories ?? []).map((memory) => ({
      ...memory,
      lastMentionTime: describeTime(memory.lastSeenAt),
      episodes: memory.episodes.map(({ sources, ...episode }) => ({
        ...episode,
        recordedTime: describeTime(episode.at),
        excerpts: episode.excerpts.map((excerpt) => ({ ...excerpt, sentTime: describeTime(excerpt.at) })),
        ...(sources?.length ? { sourceEvidenceIds: sources.map((source) => source.id) } : {}),
      })),
    })),
    memoryCorrections: (request.memoryCorrections ?? []).map((item) => ({
      ...item,
      recordedTime: describeTime(item.recordedAt),
    })),
    shortTermTurns: (request.shortTermTurns ?? []).map((turn) => ({ ...turn, publishedTime: describeTime(turn.at) })),
    clarifications,
    proactiveTopic: request.proactiveTopic ?? null,
  });
  ensure(content.length <= 200_000, 'TEXT_CONTEXT_TOO_LARGE');
  return [
    {
      role: 'system' as const,
      content:
        TEXT_SYSTEM_PROMPT +
        (conversation?.kind === 'moment_post'
          ? MOMENT_POST_TASK
          : request.deliveryMode === 'voice'
            ? SPEECH_DRAFT_TASK
            : ''),
    },
    { role: 'user' as const, content },
  ];
}

export function reviewPromptMessages(request: TextGenerationRequest, draft: TextDraft) {
  const messages = promptMessages(request);
  messages[0]!.content =
    TEXT_REVIEW_PROMPT +
    (request.conversation?.kind === 'moment_post'
      ? MOMENT_POST_TASK
      : request.deliveryMode === 'voice'
        ? SPEECH_REVIEW_TASK
        : '');
  messages[1]!.content = JSON.stringify({
    ...JSON.parse(messages[1]!.content),
    draftPresentationCheck: inspectBubbles(draft.bubbles, bubbleLimits(request.deliveryMode)[draft.mode]),
    draftPresentation: { mode: draft.mode, bubbles: draft.bubbles, endsSession: draft.endsSession },
  });
  ensure(messages[1]!.content.length <= 210_000, 'TEXT_CONTEXT_TOO_LARGE');
  return messages;
}
