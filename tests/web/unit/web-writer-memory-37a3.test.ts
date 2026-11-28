import assert from 'node:assert/strict';
import test from 'node:test';
import type { TextGenerationRequest } from '../../../packages/contracts/index.ts';
import { PROMPTS_V8 } from '../../../apps/server/generation/writer-prompts.generated.ts';
import {
  applyReview,
  parseDraft,
  writerDraftMessages,
  type WriterDraft,
} from '../../../apps/server/generation/writer-v8.ts';
import { recallMemories, recordDialogueMemories } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { textRequest } from '../../text-fixtures.ts';
import { NOW, memoryStore, scope } from '../fixtures/memory-store.ts';

/**
 * Part 37a-3: a detail the character makes up about its own day is recorded (as fictional_daily), kept, and given back in a
 * later turn, so the writer can mention it again consistently.
 */
const v8 = (messageId: string, over: Partial<TextGenerationRequest> = {}): TextGenerationRequest => {
  const { relationship: _drop, ...base } = textRequest();
  return {
    ...base,
    writer: 'v8',
    requiredMessageIds: [messageId],
    messages: [{ ...base.messages[0]!, id: messageId }],
    ...over,
  } as TextGenerationRequest;
};
const guard = (topics: unknown[]) => ({ fixes: [], mode: 'casual', endsSession: false, topics, factOps: [] });

test('a detail made up in turn 2 is recorded as fictional_daily and available in turn 8', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  // Turn 2: the character says it had pork ribs for lunch; the guard records it as the character's own daily life.
  const turn2 = v8('p1');
  const draft = parseDraft({ text: '中午吃了排骨，有点腻' }, turn2) as WriterDraft;
  const reply = applyReview(
    guard([
      {
        key: '午饭 排骨',
        memoryId: null,
        summary: '角色说中午吃了排骨，有点腻。',
        importance: 2,
        sourceKind: 'fictional_daily',
        evidenceMessageIds: ['p1'],
      },
    ]),
    draft,
    turn2,
  );
  assert.deepEqual(
    reply.topics.map((topic) => [topic.key, topic.sourceKind]),
    [['午饭 排骨', 'fictional_daily']],
  );
  recordDialogueMemories(user, scope, 'job1', reply, [], ['p1'], NOW);
  // Turn 8 (six turns, a few minutes later), on a different subject: the detail is still recalled ...
  const later = NOW + 6 * 120_000;
  const recalled = recallMemories(user, scope, later, '周末你有什么打算');
  const kept = recalled.find((memory) => memory.key === '午饭 排骨');
  assert.ok(kept, 'the made-up detail is in recall even though the player did not ask about it');
  assert.equal(kept.episodes.at(-1)!.sourceKind, 'fictional_daily');
  // ... and it reaches the writer's prompt, so "中午吃了排骨" can be mentioned again.
  const turn8 = v8('p2', { memories: recalled, now: later });
  const prompt = JSON.parse(writerDraftMessages(turn8, 'deepseek')[1]!.content) as {
    memories: Array<{ key: string; episodes: Array<{ summary: string; sourceKind: string }> }>;
  };
  const memory = prompt.memories.find((item) => item.key === '午饭 排骨');
  assert.match(memory!.episodes[0]!.summary, /排骨/);
  assert.equal(memory!.episodes[0]!.sourceKind, 'fictional_daily');
  // A question about it finds it by words too.
  assert.ok(recallMemories(user, scope, later, '你午饭吃了什么 排骨').some((m) => m.key === '午饭 排骨'));
});

test('the guard is told to record made-up daily details, and the writer to keep them consistent or say it forgot', () => {
  assert.match(PROMPTS_V8.guard, /现编的、关于自己生活的小细节/);
  assert.match(PROMPTS_V8.guard, /fictional_daily/);
  assert.match(PROMPTS_V8.writer, /前后要一致/);
  assert.match(PROMPTS_V8.writer, /想不起来就自然地说忘了，不要另编一个不一样的/);
  // The hard line about the setting stays: identity is still not invented.
  assert.match(PROMPTS_V8.writer, /人设里没有的身份不编/);
});
