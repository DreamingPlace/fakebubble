import type {
  WebBootstrap,
  WebHistoryPage,
  WebOperation,
  WebSaveTrialReceipt,
  WebSendReceipt,
  WebSyncPage,
} from '../../../packages/contracts/web-v1.ts';

/** Synthetic snapshots: mockBootstrap is an accepted third-round operation; mockHistory is its later publication. */
export const mockBootstrap = {
  contractVersion: 'web-v1-draft-1',
  instanceId: 'mock-instance',
  recoveryEpoch: 'mock-epoch-1',
  access: {
    kind: 'guest',
    principalId: 'mock-principal',
    playerId: 'mock-player',
    worldId: 'mock-world',
    revision: 3,
    trialCharacterId: 'mock-character-a',
    trialRemaining: 0,
    trialReserved: 1,
    expiresAt: 1_800_000_000_000,
    canChooseText: false,
    canSend: false,
  },
  characters: [
    {
      characterId: 'mock-character-a',
      name: '合成人物甲',
      description: '仅用于交互开发',
      imageUrl: null,
      audition: { state: 'unavailable', reason: 'not_approved' },
      theme: {
        themeVersion: 1,
        pageBackground: '#ddd8d2',
        sourceColor: null,
        resolvedColor: '#ddd8d2',
        adjustment: null,
        approved: false,
        cardSurface: '#f8f6f2',
        messageSurface: '#fffdfa',
        inputSurface: '#ffffff',
        textColor: '#292725',
        border: '#b5aaa0',
        shadow: '#665c5226',
      },
    },
    {
      characterId: 'mock-character-b',
      name: '合成人物乙',
      description: '仅用于交互开发',
      imageUrl: null,
      audition: { state: 'unavailable', reason: 'not_approved' },
      theme: {
        themeVersion: 1,
        pageBackground: '#d3ddd9',
        sourceColor: null,
        resolvedColor: '#d3ddd9',
        adjustment: null,
        approved: false,
        cardSurface: '#f6f9f7',
        messageSurface: '#ffffff',
        inputSurface: '#ffffff',
        textColor: '#25302a',
        border: '#a6b7ae',
        shadow: '#52665a26',
      },
    },
  ],
  conversations: [
    {
      conversationId: 'mock-conversation-a',
      characterId: 'mock-character-a',
      lastMessageId: 'mock-prior-message',
      unreadCount: 1,
      latestOperationId: 'mock-operation-1',
    },
  ],
  syncCursor: 'mock-event-1',
} satisfies WebBootstrap;

/** Initial browse and first-send state: no live conversation exists yet. */
export const mockNewGuestBootstrap = {
  ...mockBootstrap,
  access: {
    ...mockBootstrap.access,
    revision: 1,
    trialCharacterId: null,
    trialRemaining: 3,
    trialReserved: 0,
    canSend: true,
  },
  conversations: [],
  syncCursor: null,
} satisfies WebBootstrap;

export const mockHistory = {
  conversationId: 'mock-conversation-a',
  before: null,
  hasMore: false,
  messages: [
    {
      messageId: 'mock-message-1',
      conversationId: 'mock-conversation-a',
      characterId: 'mock-character-a',
      operationId: 'mock-operation-1',
      replyOrdinal: 0,
      author: 'character',
      origin: 'narrative',
      text: '这是一条合成示例。',
      createdAt: 1_700_000_000_000,
      audio: {
        revision: 1,
        status: 'ready',
        mediaId: 'mock-media-1',
        durationMs: 1400,
        listenedAt: null,
        errorCode: null,
      },
    },
    {
      messageId: 'mock-message-2',
      conversationId: 'mock-conversation-a',
      characterId: 'mock-character-a',
      operationId: 'mock-operation-1',
      replyOrdinal: 1,
      author: 'character',
      origin: 'narrative',
      text: '这是第二段合成回复。',
      createdAt: 1_700_000_000_001,
      audio: {
        revision: 1,
        status: 'ready',
        mediaId: 'mock-media-2',
        durationMs: 1200,
        listenedAt: null,
        errorCode: null,
      },
    },
    {
      messageId: 'mock-footer-1',
      conversationId: 'mock-conversation-a',
      characterId: 'mock-character-a',
      operationId: 'mock-operation-1',
      replyOrdinal: null,
      author: 'character',
      origin: 'trial_footer',
      text: '合成收尾素材占位。',
      createdAt: 1_700_000_000_002,
      audio: {
        revision: 1,
        status: 'ready',
        mediaId: 'mock-footer-media',
        durationMs: 900,
        listenedAt: null,
        errorCode: null,
      },
    },
  ],
} satisfies WebHistoryPage;

const operationBase = {
  operationId: 'mock-operation-1',
  requestId: 'mock-request-1',
  conversationId: 'mock-conversation-a',
  acceptedAt: 1_700_000_000_000,
  deadlineAt: 1_700_000_300_000,
  errorCode: null,
  retryAfterMs: null,
} as const;

export const mockOperationStages = [
  { ...operationBase, revision: 1, status: 'queued', canCancel: true, canRetry: false, publication: null },
  { ...operationBase, revision: 2, status: 'text_running', canCancel: true, canRetry: false, publication: null },
  { ...operationBase, revision: 3, status: 'text_ready', canCancel: true, canRetry: false, publication: null },
  { ...operationBase, revision: 4, status: 'audio_pending', canCancel: true, canRetry: false, publication: null },
  { ...operationBase, revision: 5, status: 'audio_running', canCancel: true, canRetry: false, publication: null },
  { ...operationBase, revision: 6, status: 'ready_to_publish', canCancel: false, canRetry: false, publication: null },
  {
    ...operationBase,
    revision: 7,
    status: 'published',
    canCancel: false,
    canRetry: false,
    publication: { narrativeMessageIds: ['mock-message-1', 'mock-message-2'], footerMessageId: 'mock-footer-1' },
  },
] satisfies WebOperation[];

export const mockFailedOperation = {
  ...operationBase,
  operationId: 'mock-operation-failed',
  requestId: 'mock-request-failed',
  revision: 3,
  status: 'failed',
  errorCode: 'VOICE_UNAVAILABLE',
  canCancel: false,
  canRetry: false,
  publication: null,
} satisfies WebOperation;

export const mockUnknownOperation = {
  ...operationBase,
  operationId: 'mock-operation-unknown',
  requestId: 'mock-request-unknown',
  revision: 2,
  status: 'unknown',
  errorCode: 'OPERATION_UNKNOWN',
  canCancel: false,
  canRetry: false,
  publication: null,
} satisfies WebOperation;

export const mockSendReceipt = {
  duplicate: false,
  operation: mockOperationStages[0]!,
} satisfies WebSendReceipt;

export const mockSync = {
  events: [
    ...mockOperationStages.slice(1).map((operation, index) => ({
      eventId: `mock-event-${index + 2}`,
      conversationId: 'mock-conversation-a',
      kind: 'operation' as const,
      operation,
    })),
    ...mockHistory.messages.map((message, index) => ({
      eventId: `mock-event-${index + 8}`,
      conversationId: 'mock-conversation-a',
      kind: 'message' as const,
      message,
    })),
  ],
  cursor: 'mock-event-10',
  hasMore: false,
} satisfies WebSyncPage;

export const mockSavedTrial = {
  duplicate: false,
  targetConversationId: 'mock-existing-account-conversation',
  archive: {
    archiveId: 'mock-archive-1',
    sourceConversationId: 'mock-conversation-a',
    characterId: 'mock-character-a',
    savedAt: 1_700_000_010_000,
    lastMessageId: 'mock-message-1',
  },
} satisfies WebSaveTrialReceipt;
