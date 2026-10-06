import assert from 'node:assert/strict';
import test from 'node:test';
import { promptMessages, reviewPromptMessages } from '../../../apps/server/generation/accepted-text-prompt.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { PROMPTS_V7 } from '../../../apps/server/generation/prompts.generated.ts';
import { recallPlayerFacts, recordDialogueMemories } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { draftPresentation, textRequest } from '../../text-fixtures.ts';
import { NOW, candidate, memoryStore, scope } from '../fixtures/memory-store.ts';

const facts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ factKey: `事实${i}`, statement: `玩家的第${i}件事。` }));
const withFacts = (playerFacts?: { factKey: string; statement: string }[]) => ({
  ...textRequest(),
  ...(playerFacts ? { playerFacts } : {}),
  playerIntroduction: { source: 'player_setup' as const, revision: 1, name: '小测', age: 14 },
});
const userContent = (messages: { content: string }[]) => JSON.parse(messages[1]!.content) as Record<string, unknown>;

test('playerFacts follows playerIntroduction in both the draft and the review message, before the per-turn fields', () => {
  const request = withFacts(facts(2));
  const draft = draftPresentation(request) as TextDraft;
  for (const messages of [promptMessages(request), reviewPromptMessages(request, draft)]) {
    const keys = Object.keys(userContent(messages));
    assert.equal(keys.indexOf('playerFacts'), keys.indexOf('playerIntroduction') + 1);
    assert.ok(keys.indexOf('playerFacts') < keys.indexOf('memories'));
    assert.ok(keys.indexOf('playerFacts') < keys.indexOf('messages'));
    assert.deepEqual(userContent(messages).playerFacts, facts(2));
  }
  assert.deepEqual(userContent(promptMessages(withFacts()))?.playerFacts, [], 'no facts is an empty list');
});

test('the facts sit in the stable prompt prefix: later turns change only what comes after them', () => {
  const prefix = (request: ReturnType<typeof withFacts>) => {
    const content = promptMessages(request)[1]!.content;
    return content.slice(0, content.indexOf('"conversation":'));
  };
  const a = withFacts(facts(3)),
    b = { ...withFacts(facts(3)), now: a.now + 86_400_000, mustClose: true };
  b.messages = [{ ...b.messages[0]!, id: 'later', text: '换个话题' }];
  b.requiredMessageIds = ['later'];
  assert.equal(prefix(a), prefix(b));
  assert.notEqual(prefix(a), prefix(withFacts(facts(2))), 'a changed fact does change the prefix');
});

test('at most 20 well-formed facts are accepted; extra fields never reach the prompt', () => {
  assert.equal((userContent(promptMessages(withFacts(facts(20)))).playerFacts as unknown[]).length, 20);
  assert.throws(() => promptMessages(withFacts(facts(21))), /INVALID_TEXT_REQUEST/);
  assert.throws(() => promptMessages(withFacts([{ factKey: '', statement: 'x' }])), /INVALID_TEXT_REQUEST/);
  assert.throws(
    () => promptMessages(withFacts([{ factKey: 'k', statement: '字'.repeat(241) }])),
    /INVALID_TEXT_REQUEST/,
  );
  const leaked = withFacts([{ factKey: 'k', statement: 's', id: 'secret', evidence: ['x'] } as never]);
  assert.deepEqual(userContent(promptMessages(leaked)).playerFacts, [{ factKey: 'k', statement: 's' }]);
});

test('the content rules tell the character to use facts naturally, in both the draft and the review prompt', () => {
  const line = PROMPTS_V7.textContentRules.split('\n').filter((row) => row.startsWith('playerFacts'));
  assert.equal(line.length, 1);
  assert.match(line[0]!, /不要像清单一样背诵/);
  const request = withFacts(facts(1));
  const draft = draftPresentation(request) as TextDraft;
  for (const messages of [promptMessages(request), reviewPromptMessages(request, draft)])
    assert.ok(messages[0]!.content.includes(line[0]!));
});

test('recallPlayerFacts: active facts of the scope, most important first, at most 20, deterministic', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const put = (key: string, importance: number, at: number, extra = '') =>
    store.run(
      `INSERT INTO memory_facts(world_id,conversation_id,character_id,id,fact_key,statement,importance,
      evidence_message_ids_json,created_at,updated_at,retired_at) VALUES ('world',?,?,?,?,?,?,'["p1"]',?,?,?)`,
      extra ? 'conversation-other' : 'conversation',
      extra ? 'other' : 'character',
      `id-${key}-${extra}`,
      key,
      `${key}的陈述`,
      importance,
      at,
      at,
      null,
    );
  put('次要', 3, NOW);
  put('身份', 10, NOW - 5);
  put('同级旧', 6, NOW - 10);
  put('同级新', 6, NOW);
  put('别人的', 10, NOW, 'other');
  store.run(
    `INSERT INTO memory_facts(world_id,conversation_id,character_id,id,fact_key,statement,importance,
    evidence_message_ids_json,created_at,updated_at,retired_at) VALUES ('world','conversation','character','gone','已撤销','x',10,'[]',1,1,5)`,
  );
  assert.deepEqual(
    recallPlayerFacts(user, scope).map((fact) => fact.factKey),
    ['身份', '同级新', '同级旧', '次要'],
  );
  for (let i = 0; i < 30; i++) put(`批量${String(i).padStart(2, '0')}`, 1, NOW - 100 - i);
  const all = recallPlayerFacts(user, scope);
  assert.equal(all.length, 20);
  assert.deepEqual(all, recallPlayerFacts(user, scope), 'stable between calls');
  assert.equal(all[0]!.factKey, '身份');
});

test('a fact written by a publication is what the next request reads back', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  recordDialogueMemories(
    user,
    scope,
    'job1',
    candidate([], {
      factOps: [
        { op: 'add', factKey: '职业', statement: '玩家是一名护士。', importance: 7, evidenceMessageIds: ['p1'] },
      ],
    }),
    [],
    ['p1'],
    NOW,
  );
  assert.deepEqual(recallPlayerFacts(user, scope), [{ factKey: '职业', statement: '玩家是一名护士。' }]);
});
