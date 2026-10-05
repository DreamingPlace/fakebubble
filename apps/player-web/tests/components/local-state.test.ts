import assert from 'node:assert/strict';
import test from 'node:test';
import { operationLabel, playable, sameScope } from '../../src/features/local/local-state.ts';
import type { WebLocalMessage, WebLocalOperation } from '../../../../packages/contracts/web-local.ts';
import type { LocalScope } from '../../src/session/local-session.ts';

const scope: LocalScope = { instanceId: 'i', recoveryEpoch: 'e', principalId: 'p', worldId: 'w', generation: 2 };

test('late work cannot cross an identity or generation boundary', () => {
  assert.equal(sameScope(scope, { ...scope }), true);
  assert.equal(sameScope(scope, { ...scope, generation: 3 }), false);
  assert.equal(sameScope(scope, { ...scope, principalId: 'other' }), false);
  assert.equal(sameScope(scope, { ...scope, worldId: 'other' }), false);
  assert.equal(sameScope(null, scope), false);
});

test('operation labels distinguish waiting, published, unknown and failed', () => {
  const operation = { status: 'queued' } as WebLocalOperation;
  assert.match(operationLabel(operation), /等待/);
  assert.match(operationLabel({ ...operation, status: 'published' }), /已发布/);
  assert.match(operationLabel({ ...operation, status: 'unknown' }), /勿重复发送/);
  assert.match(operationLabel({ ...operation, status: 'retryable_failed' }), /人工确认/);
});

test('only published character synthetic audio gets a play control', () => {
  const message = { author: 'character', origin: 'narrative', audio: { status: 'ready', mediaId: 'm', synthetic: true } } as WebLocalMessage;
  assert.equal(playable(message), true);
  assert.equal(playable({ ...message, origin: 'trial_footer' }), true);
  assert.equal(playable({ ...message, author: 'player' }), false);
  assert.equal(playable({ ...message, audio: null }), false);
});
