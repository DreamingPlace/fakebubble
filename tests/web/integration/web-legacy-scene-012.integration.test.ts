import assert from 'node:assert/strict';
import test from 'node:test';
import { dialogueCandidate } from '../../../packages/domain/dialogue.ts';
import { setup } from '../../helpers.ts';

test('C-S3-006 A-WEB-012 old proactive proposed scene accepts its legitimate no-player-input cutoff 0', t => {
  const f = setup(t, '2026-09-07T11:30:00+08:00', [0]);
  const intent = f.engine.requestProactive(f.scope, 'c-synthetic-proposal');
  const claim = f.engine.claimProactive(f.scope, intent);
  assert(claim);
  const request = f.engine.textRequest(f.scope, claim.id);
  assert.deepEqual(request.requiredMessageIds, []);
  assert.equal(f.store.get<{ last_input_seq: number }>(
    'SELECT last_input_seq FROM scene_job_contexts WHERE job_id=?', claim.id)?.last_input_seq, 0);
  const candidate = dialogueCandidate({ mode: 'casual',
    bubbles: [{ text: '要不要在虚构公园散步？', expression: 'neutral' }],
    coveredMessageIds: [], deferredMessageIds: [], endsSession: false, topics: [],
    sceneUpdate: { scene: { kind: 'proposed', setting: '虚构公园', plan: null,
      proximity: 'ordinary', speaking: 'normal' }, evidence: [], responseQuote: '散步' } }, [], false);
  assert.equal(f.engine.sceneDelivery(f.scope, claim.id, candidate), 'conversational');
});

test('C-S3-006 A-WEB-012 invalid old scene cutoff is still rejected, unlike legitimate zero', t => {
  const f = setup(t, '2026-09-07T11:30:00+08:00', [0]);
  const intent = f.engine.requestProactive(f.scope, 'c-invalid-cutoff');
  const claim = f.engine.claimProactive(f.scope, intent);
  assert(claim);
  f.engine.textRequest(f.scope, claim.id);
  const candidate = dialogueCandidate({ mode: 'casual',
    bubbles: [{ text: '要不要去看虚构灯光？', expression: 'neutral' }],
    coveredMessageIds: [], deferredMessageIds: [], endsSession: false, topics: [],
    sceneUpdate: { scene: { kind: 'proposed', setting: '虚构公园', plan: null,
      proximity: 'ordinary', speaking: 'normal' }, evidence: [], responseQuote: '虚构灯光' } }, [], false);
  f.store.run('UPDATE scene_job_contexts SET last_input_seq=-1 WHERE job_id=?', claim.id);
  assert.throws(() => f.engine.sceneDelivery(f.scope, claim.id, candidate), /SCENE_CONTEXT_MISSING/);
});
