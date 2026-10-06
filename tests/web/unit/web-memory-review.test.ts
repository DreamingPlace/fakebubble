import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import type { TopicMemory } from '../../../packages/contracts/index.ts';
import { applyTextReview, reviewTool } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { recordDialogueMemories, validateDialogueMemoryEvidence } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';
import { NOW, candidate, memoryStore, scope } from '../fixtures/memory-store.ts';

const topic = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  summary: `玩家谈到${key}。`,
  sourceKind: 'player_statement' as const,
  evidenceMessageIds: ['p1'],
  ...extra,
});
const importanceOf = (store: ReturnType<typeof memoryStore>, key: string) =>
  store.get<{ importance: number }>('SELECT importance FROM memory_topics WHERE topic_key=?', key)?.importance;

test('a topic keeps the maximum importance it was ever given; a topic without one is recorded as small talk', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const record = (job: string, ...topics: ReturnType<typeof topic>[]) =>
    recordDialogueMemories(user, scope, job, candidate(topics), [], ['p1'], NOW);
  record('job1', topic('猫', { importance: 8 }), topic('天气'));
  assert.equal(importanceOf(store, '猫'), 8);
  assert.equal(importanceOf(store, '天气'), 3);
  record('job2', topic('猫', { importance: 4 }));
  assert.equal(importanceOf(store, '猫'), 8, 'a lower later importance never lowers it');
  record('job3', topic('猫', { importance: 9 }));
  assert.equal(importanceOf(store, '猫'), 9);
  record('job2', topic('天气', { importance: 1 }));
  assert.equal(importanceOf(store, '天气'), 3, 'an unimportant restatement does not lower the stored value');
});

test('a topic linked to a memory adds an episode under that memory instead of a new topic key', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  recordDialogueMemories(user, scope, 'job1', candidate([topic('宠物', { importance: 6 })]), [], ['p1'], NOW);
  const id = store.get<{ id: string }>("SELECT id FROM memory_catalog WHERE topic_key='宠物'")!.id;
  const linked = candidate([topic('宠物', { linkedMemoryId: id, importance: 5 })]);
  validateDialogueMemoryEvidence(user, scope, 'job2', linked);
  recordDialogueMemories(user, scope, 'job2', linked, [], ['p2'], NOW + 1);
  assert.equal(store.all('SELECT 1 FROM memory_topics').length, 1);
  assert.equal(store.all('SELECT 1 FROM memory_catalog').length, 1);
  assert.equal(store.all("SELECT 1 FROM memory_episodes WHERE topic_key='宠物'").length, 2);
  assert.equal(importanceOf(store, '宠物'), 6);
});

test('a memory link must name a memory of this very scope under its own key', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  recordDialogueMemories(user, scope, 'job1', candidate([topic('宠物')]), [], ['p1'], NOW);
  const other = { ...scope, conversationId: 'conversation-other', characterId: 'other' };
  recordDialogueMemories(
    user,
    other,
    'job-other',
    candidate([topic('别人的话题', { evidenceMessageIds: ['other-p1'] })]),
    [],
    ['other-p1'],
    NOW,
  );
  const own = store.get<{ id: string }>("SELECT id FROM memory_catalog WHERE topic_key='宠物'")!.id;
  const foreign = store.get<{ id: string }>("SELECT id FROM memory_catalog WHERE topic_key='别人的话题'")!.id;
  const check = (linkedMemoryId: string, key = '宠物') =>
    validateDialogueMemoryEvidence(user, scope, 'job2', candidate([topic(key, { linkedMemoryId })]));
  check(own);
  assert.throws(() => check(foreign), /INVALID_MEMORY_LINK/, 'another conversation');
  assert.throws(() => check(foreign, '别人的话题'), /INVALID_MEMORY_LINK/, 'even under that memory own key');
  assert.throws(() => check(own, '别的key'), /INVALID_MEMORY_LINK/, 'wrong key');
  assert.throws(() => check('no-such-id'), /INVALID_MEMORY_LINK/);
});

function reviewFixture(memories: Pick<TopicMemory, 'id' | 'key'>[]) {
  const request = textRequest();
  request.memories = memories.map((memory) => ({
    ...memory,
    tier: 'long' as const,
    playerMentions: 2,
    recallWeight: 1,
    lastSeenAt: NOW,
    episodes: [],
  }));
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, ...review } = auditReply(request, draft);
  const apply = (topics: unknown[], sourceUsage?: Record<string, string[]>) =>
    applyTextReview({ ...review, topics, ...(sourceUsage ? { sourceUsage } : {}) }, draft, request);
  return { request, apply };
}
const reviewTopic = (key: string, memoryId: string | null, importance: unknown = 5) => ({
  key,
  memoryId,
  summary: `玩家谈到${key}。`,
  importance,
  sourceKind: 'player_statement',
  evidenceMessageIds: ['question-1'],
});

test('the review tool lets memoryId name only the memories recalled for this request, or null', () => {
  const properties = (request: ReturnType<typeof textRequest>) =>
    (
      reviewTool(request).function.parameters as {
        properties: { topics: { items: { properties: Record<string, unknown>; required: string[] } } };
      }
    ).properties.topics.items;
  const none = properties(reviewFixture([]).request);
  assert.deepEqual(none.properties.memoryId, { type: 'null' }, 'nothing recalled: only null');
  const some = properties(
    reviewFixture([
      { id: 'mem-1', key: '宠物' },
      { id: 'mem-2', key: '工作' },
    ]).request,
  );
  assert.deepEqual(some.properties.memoryId, {
    anyOf: [{ type: 'string', enum: ['mem-1', 'mem-2'] }, { type: 'null' }],
  });
  assert.deepEqual(some.properties.importance, { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] });
  assert.ok(some.required.includes('memoryId') && some.required.includes('importance'));
});

test('a review topic with a recalled memoryId continues that memory under its own key', () => {
  const { apply } = reviewFixture([{ id: 'mem-1', key: '宠物' }]);
  const result = apply([reviewTopic('小猫咪', 'mem-1', 7)]);
  assert.deepEqual(
    result.topics.map(({ key, linkedMemoryId, importance }) => ({ key, linkedMemoryId, importance })),
    [{ key: '宠物', linkedMemoryId: 'mem-1', importance: 7 }],
  );
  const fresh = apply([reviewTopic('小猫咪', null, 2)]);
  assert.deepEqual(
    fresh.topics.map(({ key, linkedMemoryId }) => ({ key, linkedMemoryId })),
    [{ key: '小猫咪', linkedMemoryId: undefined }],
  );
});

test('the review cannot link to an unrecalled memory, mix two memories under one wording, or omit/misstate importance', () => {
  const { apply } = reviewFixture([
    { id: 'mem-1', key: '宠物' },
    { id: 'mem-2', key: '工作' },
  ]);
  assert.throws(() => apply([reviewTopic('x', 'mem-9')]), /INVALID_MEMORY_LINK/, 'not in this request');
  assert.throws(() => apply([reviewTopic('工作', 'mem-1')]), /INVALID_MEMORY_LINK/, 'wording names another memory');
  assert.throws(
    () => apply([reviewTopic('猫', 'mem-1'), reviewTopic('猫', 'mem-2')]),
    /INVALID_MEMORY_LINK/,
    'one wording, two memories',
  );
  assert.throws(
    () => apply([reviewTopic('猫', 'mem-1'), reviewTopic('小猫', 'mem-1')]),
    /INVALID_TOPICS/,
    'two topics cannot continue the same memory',
  );
  for (const bad of [0, 11, 5.5, '5', null])
    assert.throws(() => apply([reviewTopic('猫', null, bad)]), /INVALID_TOPICS/, String(bad));
  const { memoryId: _unused, ...withoutMemoryId } = reviewTopic('猫', null);
  assert.throws(() => apply([withoutMemoryId]), /INVALID_TOPICS/);
  const { importance: _gone, ...withoutImportance } = reviewTopic('猫', null);
  assert.throws(() => apply([withoutImportance]), /INVALID_TOPICS/);
});
