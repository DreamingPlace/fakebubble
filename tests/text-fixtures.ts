import type { TextGenerationRequest, TextGenerationResult } from '../packages/contracts/index.ts';
import { defaultSchedule } from '../packages/domain/defaults.ts';
import { dialogueCandidate } from '../packages/domain/dialogue.ts';

export function approvedProfile(id = 'text-fixture') {
  return {
    id,
    name: '测试角色',
    version: 1,
    fictional: true,
    reviewStatus: 'approved_for_implementation',
    initialRelationship: null,
    relationshipSelection: 'player_onboarding',
    timeZone: 'Asia/Singapore',
    persona: '测试世界中的角色，开朗但不会凭空编造玩家经历。',
    speechStyle: '短句，真诚。',
    contentBasis: { kind: 'author_canon', truthScope: 'fictional_world' },
    basicInfo: { birthDate: '2012-05-17', birthPlace: '虚构城', source: '/private/archive.md' },
    interests: { foods: ['测试甜点'] },
    voice: { referenceFiles: ['/private/sample.m4a'], uploadApproved: false },
    provenance: { secret: 'EXCLUDE_PROVENANCE' },
    referencePerson: { name: 'EXCLUDE_REFERENCE_IDENTITY' },
  };
}
export function textRequest(): TextGenerationRequest {
  const now = Date.parse('2026-09-09T12:00:00+08:00');
  const scope = { worldId: 'text-world', conversationId: 'text-conversation', characterId: 'text-fixture' };
  return {
    jobId: 'text-job',
    scope,
    now,
    relationship: 'new',
    requiredMessageIds: ['question-1'],
    character: {
      id: scope.characterId,
      name: '测试角色',
      version: 1,
      fictional: true,
      persona: '只用于离线测试。',
      birthDate: '2012-05-17',
      schedule: defaultSchedule(),
    },
    messages: [
      {
        id: 'question-1',
        worldId: scope.worldId,
        conversationId: scope.conversationId,
        authorKind: 'player',
        authorId: 'text-player',
        text: '今天想聊什么？',
        createdAt: now,
        delivery: 'text',
        voiceFallback: false,
        mediaId: null,
        proactive: false,
      },
    ],
    mustClose: false,
    evidence: [],
  };
}
export function generation(request: TextGenerationRequest): TextGenerationResult {
  return {
    reply: dialogueCandidate(wireReply(request), request.requiredMessageIds, request.mustClose, request.deliveryMode),
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    elapsedMs: 1,
    requestId: 'offline-fixture',
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
  };
}
export function wireReply(request = textRequest()) {
  return {
    bubbles: [{ text: '离线测试文本，不是真实模型生成。', expression: 'neutral' }],
    mode: 'casual',
    coveredMessageIds: [...request.requiredMessageIds],
    deferredMessageIds: [],
    endsSession: request.mustClose,
    topics: [
      {
        key: '测试话题',
        summary: '用于离线测试的对话。',
        sourceKind: 'conversation',
        evidenceMessageIds: request.requiredMessageIds.slice(0, 8),
      },
    ],
  };
}
export function envelope(request = textRequest()) {
  return {
    id: 'response-fixture',
    model: 'deepseek-v4-flash',
    choices: [
      {
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          reasoning_content: 'DO_NOT_RETURN_REASONING',
          content: JSON.stringify(wireReply(request)),
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

export function draftPresentation(request = textRequest()) {
  const { mode, bubbles, endsSession } = wireReply(request);
  return { mode, bubbles, endsSession };
}
export function draftWire(request = textRequest(), draft = draftPresentation(request)) {
  if (request.deliveryMode !== 'voice') return draft;
  const [utterance, ...afterthoughts] = draft.bubbles;
  return { mode: draft.mode, utterance, afterthoughts, endsSession: draft.endsSession };
}
export function auditReply(request = textRequest(), draft = draftPresentation(request)) {
  return {
    bubbleChecks: draft.bubbles.map((_, index) => ({
      index,
      issue: 'none',
      messageId: null as string | null,
      quote: '',
    })),
    decision: 'accept',
    replacementBubbles: [] as { text: string; expression: string }[],
    ...(request.sceneContext ? { sceneUpdate: null } : {}),
    ...(request.relationshipContext?.auditEnabled ? { relationshipEvents: [] } : {}),
    ...(request.requiredMessageIds.length
      ? {
          coverage: Object.fromEntries(
            request.requiredMessageIds.map((id) => [
              id,
              {
                status: 'answered',
                supportQuote: draft.bubbles[0]!.text,
                missingInformation: '',
              },
            ]),
          ),
        }
      : {}),
    topics: wireReply(request).topics.map((topic) => ({ ...topic, memoryId: null as string | null })),
    ...(request.evidence.length
      ? { sourceUsage: Object.fromEntries(request.evidence.map((source) => [source.id, [] as string[]])) }
      : {}),
  };
}
export function toolEnvelope(name: string, argumentsValue: unknown) {
  return {
    id: 'response-fixture',
    model: 'deepseek-v4-flash',
    choices: [
      {
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: null as string | null,
          reasoning_content: 'DO_NOT_RETURN_REASONING',
          tool_calls: [
            { id: 'call-fixture', type: 'function', function: { name, arguments: JSON.stringify(argumentsValue) } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}
export const draftEnvelope = (request = textRequest()) => toolEnvelope('submit_dialogue_draft', draftWire(request));
export const auditEnvelope = (request = textRequest()) => toolEnvelope('submit_dialogue_audit', auditReply(request));
export function acceptedAuditEnvelope(request = textRequest()) {
  const { bubbleChecks: _checks, topics, ...audit } = auditReply(request);
  return toolEnvelope('submit_dialogue_audit', {
    ...audit,
    topics: topics.map(({ memoryId: _id, ...topic }) => topic),
  });
}
