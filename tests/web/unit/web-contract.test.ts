import assert from 'node:assert/strict';
import test from 'node:test';
import { mockBootstrap, mockFailedOperation, mockHistory, mockNewGuestBootstrap, mockOperationStages, mockSavedTrial, mockSendReceipt, mockSync, mockUnknownOperation } from '../fixtures/web-v1.ts';

test('synthetic web contract uses stable scoped IDs and exposes draft voice state', () => {
  const conversation = mockBootstrap.conversations[0]!;
  const message = mockHistory.messages[0]!;
  assert.equal(conversation.conversationId, message.conversationId);
  assert.equal(conversation.characterId, message.characterId);
  assert.equal(conversation.latestOperationId, mockSendReceipt.operation.operationId);
  assert.equal(mockSync.events.at(-1)?.eventId, mockSync.cursor);
  assert.equal(mockBootstrap.syncCursor, 'mock-event-1');
  assert.equal(mockSync.events[0]?.eventId, 'mock-event-2');
  assert.deepEqual(mockSync.events.filter(event => event.kind === 'message').map(event => event.message.messageId),
    mockHistory.messages.map(message => message.messageId));
  assert.deepEqual(mockOperationStages.map(operation => operation.revision), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(mockOperationStages.at(-1)?.publication?.narrativeMessageIds,
    mockHistory.messages.filter(item => item.origin === 'narrative').map(item => item.messageId));
  assert.equal(mockOperationStages.at(-1)?.publication?.footerMessageId,
    mockHistory.messages.find(item => item.origin === 'trial_footer')?.messageId);
  assert.equal(mockBootstrap.access.canChooseText, false);
  assert.equal(mockNewGuestBootstrap.conversations.length, 0);
  assert.equal(mockNewGuestBootstrap.access.trialRemaining, 3);
  assert.equal(mockNewGuestBootstrap.access.canSend, true);
  assert.equal(mockBootstrap.access.trialReserved, 1);
  assert.equal(mockBootstrap.access.canSend, false);
  assert.equal(mockFailedOperation.status, 'failed');
  assert.equal(mockFailedOperation.publication, null);
  assert.equal(mockUnknownOperation.status, 'unknown');
  assert.equal(mockUnknownOperation.canRetry, false);
  assert.equal(message.audio?.status, 'ready');
  assert.ok(mockBootstrap.characters.every(character => !character.theme.approved));
  assert.ok(mockBootstrap.characters.every(character => character.audition.state === 'unavailable'));
  assert.equal(mockSavedTrial.archive.sourceConversationId, conversation.conversationId);
  assert.equal(mockSavedTrial.archive.lastMessageId, message.messageId);
});
