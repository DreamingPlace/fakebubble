import assert from 'node:assert/strict';
import test from 'node:test';
import type { FactOp } from '../../../packages/contracts/index.ts';
import { applyTextReview } from '../../../apps/server/generation/accepted-text-protocol.ts';
import type { TextDraft } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { recordDialogueMemories, validateDialogueMemoryEvidence } from '../../../apps/server/memory/memory.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { auditReply, draftPresentation, textRequest } from '../../text-fixtures.ts';
import { NOW, candidate, memoryStore, scope } from '../fixtures/memory-store.ts';

const fact = (extra: Partial<FactOp> = {}): FactOp => ({
  op: 'add',
  factKey: '宠物',
  statement: '玩家养了一只叫团子的猫。',
  importance: 8,
  evidenceMessageIds: ['p1'],
  ...extra,
});
const topic = () => ({
  key: '猫',
  summary: '玩家谈到猫。',
  sourceKind: 'player_statement' as const,
  evidenceMessageIds: ['p1'],
});

function review() {
  const request = textRequest();
  request.messages.push({
    ...request.messages[0]!,
    id: 'char-1',
    authorKind: 'character',
    authorId: request.character.id,
    text: '我养了一只狗。',
  });
  request.clarifications = [{ messageId: 'question-1', messages: [{ id: 'clar-1', text: '你养宠物吗？' }] }];
  const draft = draftPresentation(request) as TextDraft;
  const { bubbleChecks: _checks, factOps: _facts, ...base } = auditReply(request, draft);
  const apply = (factOps: unknown) => applyTextReview({ ...base, factOps }, draft, request);
  const op = (extra: Record<string, unknown> = {}) => ({
    op: 'add',
    factKey: '宠物',
    statement: '玩家养了一只叫团子的猫。',
    importance: 8,
    evidenceMessageIds: ['question-1'],
    ...extra,
  });
  return { apply, op, base, draft, request };
}

test('the review returns validated fact ops, normalized like topic keys', () => {
  const { apply, op } = review();
  assert.deepEqual(apply([]).factOps, []);
  assert.deepEqual(apply([op({ factKey: '  宠物 ', statement: ' 玩家养猫。 ' })]).factOps, [
    { op: 'add', factKey: '宠物', statement: '玩家养猫。', importance: 8, evidenceMessageIds: ['question-1'] },
  ]);
  assert.deepEqual(
    apply([op({ op: 'retire', statement: '' }), op({ factKey: '职业', op: 'update' })]).factOps?.length,
    2,
  );
});

test('a character-authored, absent or clarification message can never be the evidence of a fact', () => {
  const { apply, op } = review();
  for (const id of ['char-1', 'not-in-request', 'clar-1'])
    for (const kind of ['add', 'update', 'retire'])
      assert.throws(
        () => apply([op({ op: kind, evidenceMessageIds: [id] })]),
        /INVALID_MEMORY_EVIDENCE/,
        `${kind} ${id}`,
      );
  assert.throws(() => apply([op({ evidenceMessageIds: ['question-1', 'char-1'] })]), /INVALID_MEMORY_EVIDENCE/);
});

test('fact ops are validated strictly: shape, op, bounds, evidence and duplicates', () => {
  const { apply, op, base, draft, request } = review();
  assert.throws(() => applyTextReview(base, draft, request), /INVALID_REVIEW_SCHEMA/, 'factOps is required');
  const bad: [string, unknown][] = [
    ['not an array', {}],
    ['four ops', [1, 2, 3, 4].map((n) => op({ factKey: `k${n}` }))],
    ['unknown op', [op({ op: 'delete' })]],
    ['extra key', [op({ extra: 1 })]],
    ['empty statement on add', [op({ statement: '  ' })]],
    ['empty statement on update', [op({ op: 'update', statement: '' })]],
    ['241 chars', [op({ statement: '字'.repeat(241) })]],
    ['newline', [op({ statement: '第一行\n第二行' })]],
    ['importance 0', [op({ importance: 0 })]],
    ['importance 11', [op({ importance: 11 })]],
    ['importance float', [op({ importance: 7.5 })]],
    ['empty key', [op({ factKey: '' })]],
    ['key with a symbol', [op({ factKey: 'a/b' })]],
    ['65-char key', [op({ factKey: 'a'.repeat(65) })]],
    ['no evidence', [op({ evidenceMessageIds: [] })]],
    ['duplicate evidence', [op({ evidenceMessageIds: ['question-1', 'question-1'] })]],
    ['duplicate key', [op(), op({ op: 'update', factKey: ' 宠物' })]],
    ['null item', [null]],
  ];
  for (const [name, value] of bad) assert.throws(() => apply(value), /INVALID_FACTS/, name);
  assert.equal(apply([op({ statement: '字'.repeat(240) })]).factOps?.length, 1);
});

test('facts are written through the store: add, update keeps history, retire, one active fact per key', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const record = (job: string, op: FactOp, at: number) => {
    const next = candidate([], { factOps: [op] });
    validateDialogueMemoryEvidence(user, scope, job, next);
    recordDialogueMemories(user, scope, job, next, [], ['p1'], at);
  };
  const rows = () =>
    store.all<Record<string, unknown>>(
      'SELECT fact_key,statement,importance,retired_at,superseded_by,id FROM memory_facts ORDER BY created_at,rowid',
    );
  record('job1', fact(), NOW);
  assert.equal(rows().length, 1);
  record('job2', fact({ op: 'update', statement: '玩家的猫叫团子，三岁。', importance: 9 }), NOW + 1);
  const afterUpdate = rows();
  assert.equal(afterUpdate.length, 2);
  assert.equal(afterUpdate[0]!.retired_at, NOW + 1);
  assert.equal(afterUpdate[0]!.superseded_by, afterUpdate[1]!.id);
  assert.deepEqual(
    [afterUpdate[1]!.retired_at, afterUpdate[1]!.statement, afterUpdate[1]!.importance],
    [null, '玩家的猫叫团子，三岁。', 9],
  );
  // An add of a key that is already active replaces it the same way instead of failing a paid turn.
  record('job3', fact({ statement: '玩家养猫。' }), NOW + 2);
  assert.equal(rows().filter((row) => row.retired_at === null).length, 1);
  assert.equal(rows().length, 3);
  record('job1', fact({ op: 'retire', statement: '', evidenceMessageIds: ['p2'] }), NOW + 3);
  assert.equal(rows().filter((row) => row.retired_at === null).length, 0);
  assert.equal(rows().at(-1)!.superseded_by, null, 'a retired fact has no successor');
});

test('update and retire need an active fact of this scope; another conversation never counts', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const check = (op: FactOp, at = scope) =>
    validateDialogueMemoryEvidence(user, at, 'job2', candidate([], { factOps: [op] }));
  for (const kind of ['update', 'retire'] as const)
    assert.throws(() => check(fact({ op: kind })), /INVALID_FACT_REFERENCE/, `${kind} of a missing fact`);
  const other = { ...scope, conversationId: 'conversation-other', characterId: 'other' };
  recordDialogueMemories(
    user,
    other,
    'job-other',
    candidate([], { factOps: [fact({ evidenceMessageIds: ['other-p1'] })] }),
    [],
    ['other-p1'],
    NOW,
  );
  assert.equal(store.all('SELECT 1 FROM memory_facts').length, 1);
  for (const kind of ['update', 'retire'] as const)
    assert.throws(() => check(fact({ op: kind })), /INVALID_FACT_REFERENCE/, `${kind} of the other scope's fact`);
  assert.throws(
    () => check(fact({ evidenceMessageIds: ['other-p1'] })),
    /INVALID_MEMORY_EVIDENCE/,
    'evidence from the other conversation',
  );
  check(fact({ op: 'update', evidenceMessageIds: ['other-p1'] }), other); // its own scope is fine
});

test('the store refuses a character-authored fact source and writes nothing, not even the topics of that turn', (t) => {
  const store = memoryStore();
  t.after(() => store.close());
  const user = userStore(store);
  const bad = candidate([topic()], { factOps: [fact({ evidenceMessageIds: ['c1'] })] });
  assert.throws(() => validateDialogueMemoryEvidence(user, scope, 'job1', bad), /INVALID_MEMORY_EVIDENCE/);
  assert.throws(
    () => store.transaction(() => recordDialogueMemories(user, scope, 'job1', bad, [], ['p1'], NOW)),
    /INVALID_MEMORY_EVIDENCE/,
  );
  assert.equal(store.all('SELECT 1 FROM memory_facts').length, 0);
  assert.equal(store.all('SELECT 1 FROM memory_topics').length, 0);
  // Topics and facts of one publication commit together, and roll back together.
  const good = candidate([topic()], { factOps: [fact()] });
  store.transaction(() => recordDialogueMemories(user, scope, 'job1', good, [], ['p1'], NOW));
  assert.equal(store.all('SELECT 1 FROM memory_facts').length, 1);
  assert.equal(store.all('SELECT 1 FROM memory_topics').length, 1);
});
