// Fixed requests whose assembled prompt messages are pinned byte-for-byte in tests/web/fixtures/prompt-snapshots/.
import type { MessageDTO, TextGenerationRequest } from '../../../packages/contracts/index.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const NOW = Date.parse('2026-09-09T12:00:00+08:00');
const scope = { worldId: 'snap-world', conversationId: 'snap-conversation', characterId: 'snap-character' };

const base = (): TextGenerationRequest => ({
  jobId: 'snap-job',
  scope,
  now: NOW,
  relationship: 'friend',
  requiredMessageIds: ['m-2'],
  character: {
    id: scope.characterId,
    name: '快照角色',
    version: 1,
    fictional: true,
    persona: '虚构测试人物：开朗，爱聊日常，不凭空编造玩家经历。',
    birthDate: '2012-05-17',
    schedule: defaultSchedule(),
    authorCanon: { kind: 'author_canon', settings: { hobby: '测试甜点' } },
  },
  messages: [
    message('m-1', 'character', 'snap-character', '昨天那家店你去了吗？', NOW - 26 * 3_600_000),
    message('m-2', 'player', 'snap-player', '去了（笑）这次的甜点特别好吃', NOW - 90_000),
  ],
  mustClose: false,
  evidence: [],
});

function message(id: string, authorKind: 'player' | 'character', authorId: string, text: string, createdAt: number) {
  return {
    id,
    worldId: scope.worldId,
    conversationId: scope.conversationId,
    authorKind,
    authorId,
    text,
    createdAt,
    delivery: 'text',
    voiceFallback: false,
    mediaId: null,
    proactive: false,
  } satisfies MessageDTO;
}

const draft = (text: string, endsSession = false): TextDraft => ({
  mode: 'casual',
  bubbles: [{ text, expression: 'upbeat' }],
  endsSession,
});

export interface PromptSnapshotCase {
  name: string;
  request: TextGenerationRequest;
  draft: TextDraft;
}

export function promptSnapshotCases(): PromptSnapshotCase[] {
  const text = base();
  const voice: TextGenerationRequest = { ...base(), deliveryMode: 'voice' };
  const moment: TextGenerationRequest = {
    ...base(),
    requiredMessageIds: [],
    messages: [],
    deliveryMode: 'text',
    conversation: {
      kind: 'moment_post',
      name: '朋友圈',
      members: [
        { id: scope.characterId, name: '快照角色' },
        { id: 'other-member', name: '另一位成员' },
      ],
    },
  };
  const proactive: TextGenerationRequest = {
    ...base(),
    requiredMessageIds: [],
    messages: [message('m-1', 'character', 'snap-character', '昨天那家店你去了吗？', NOW - 26 * 3_600_000)],
    proactiveTopic: { key: '测试甜点' },
  };
  const memories: TextGenerationRequest = {
    ...base(),
    playerIntroduction: { source: 'player_setup', revision: 2, name: '小测', age: 14 },
    memories: [
      {
        key: '测试甜点',
        tier: 'long',
        playerMentions: 3,
        recallWeight: 0.8,
        lastSeenAt: NOW - 3 * 86_400_000,
        episodes: [
          {
            summary: '玩家提到喜欢测试甜点。',
            sourceKind: 'player_statement',
            messageIds: ['old-1'],
            at: NOW - 3 * 86_400_000,
            excerpts: [{ id: 'old-1', authorKind: 'player', text: '我最喜欢测试甜点', at: NOW - 3 * 86_400_000 }],
          },
        ],
      },
    ],
    memoryCorrections: [
      {
        id: 'corr-1',
        memoryId: 'mem-1',
        topicKey: '测试甜点',
        revision: 2,
        summary: '玩家订正：其实更喜欢测试饮料。',
        reason: '口味变了',
        evidenceMessageIds: ['old-1'],
        recordedAt: NOW - 86_400_000,
        source: 'player_correction',
      },
    ],
    shortTermTurns: [
      {
        id: 'turn-1',
        at: NOW - 26 * 3_600_000,
        messages: [{ id: 'm-1', text: '昨天那家店你去了吗？', expression: 'neutral' }],
      },
    ],
  };
  const facts: TextGenerationRequest = {
    ...base(),
    playerIntroduction: { source: 'player_setup', revision: 2, name: '小测', age: 14 },
    playerFacts: [
      { factKey: '宠物', statement: '玩家养了一只叫团子的猫。' },
      { factKey: '职业', statement: '玩家是一名护士。' },
    ],
  };
  const evidence: TextGenerationRequest = {
    ...base(),
    conversation: {
      kind: 'group',
      name: '测试群',
      members: [
        { id: scope.characterId, name: '快照角色' },
        { id: 'snap-player', name: '小测' },
      ],
    },
    evidence: [
      {
        id: 'group:g-1',
        kind: 'observed_group_message',
        text: '群里有人说周末一起去测试公园。',
        observedAt: NOW - 5 * 3_600_000,
      },
    ],
  };
  return [
    { name: 'text-reply', request: text, draft: draft('哇，真的吗？下次带我一起去。') },
    { name: 'voice-reply', request: voice, draft: draft('嗯，听起来真不错。') },
    { name: 'moment-post', request: moment, draft: draft('今天的云像棉花糖。') },
    { name: 'proactive-contact', request: proactive, draft: draft('突然想起测试甜点了。') },
    { name: 'memories-corrections', request: memories, draft: draft('那我记住啦，更喜欢测试饮料。') },
    { name: 'player-facts', request: facts, draft: draft('团子今天乖不乖？') },
    { name: 'evidence-group', request: evidence, draft: draft('周末的测试公园我也想去。') },
  ];
}
