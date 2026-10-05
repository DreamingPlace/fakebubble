/** Implemented synthetic-local HTTPS subset. Not the web-v1-draft-1 UI contract. */
export type WebLocalStatus =
  | 'queued'
  | 'text_running'
  | 'text_ready'
  | 'audio_pending'
  | 'audio_running'
  | 'ready_to_publish'
  | 'retryable_failed'
  | 'unknown'
  | 'published'
  | 'cancelled'
  | 'failed';

export interface WebLocalOperation {
  operationId: string;
  requestId: string;
  conversationId: string;
  status: WebLocalStatus;
  revision: number;
  acceptedAt: number;
  deadlineAt: number;
  errorCode: string | null;
  canCancel: boolean;
  publication: { operationId: string; messageIds: string[]; footerMessageId: string | null } | null;
}

export interface WebLocalBootstrap {
  contractVersion: 'web-v1-local-1' | 'web-v1-local-2';
  mode: 'synthetic-local';
  region: 'local-test';
  instanceId: string;
  recoveryEpoch: string;
  csrf: string;
  access: {
    kind: 'guest' | 'account';
    principalId: string;
    playerId: string;
    worldId: string;
    revision: number;
    trialCharacterId: string | null;
    trialRemaining: number | null;
    trialReserved: number | null;
    canSend: boolean;
    canChooseText: false;
    /** local-2 only; expired guests may authenticate but cannot read private content. */
    trialExpiresAt?: number | null;
    retentionState?: 'unstarted' | 'active' | 'expired' | 'protected';
  };
  characters: {
    characterId: string;
    name: string;
    synthetic: true;
    audition: { state: 'unavailable'; reason: 'not_approved' };
  }[];
  conversations: { conversationId: string; characterId: string }[];
  activeOperations: WebLocalOperation[];
  syncCursor: string;
  unsupported: string[];
}

export interface WebLocalMessage {
  messageId: string;
  conversationId: string;
  characterId: string;
  operationId: string;
  replyOrdinal: number | null;
  author: 'player' | 'character';
  origin: 'input' | 'narrative' | 'trial_footer';
  text: string;
  createdAt: number;
  audio: { status: 'ready'; mediaId: string; synthetic: true } | null;
}

export interface WebLocalHistoryPage {
  conversationId: string;
  messages: WebLocalMessage[];
  before: string | null;
  hasMore: boolean;
}

export interface WebLocalSyncEvent {
  eventId: string;
  conversationId: string | null;
  kind: 'operation' | 'publication' | 'access';
  revision: number;
  payload: Record<string, unknown>;
}
export interface WebLocalSyncPage {
  events: WebLocalSyncEvent[];
  cursor: string;
  hasMore: boolean;
}
export interface WebLocalError {
  error: { code: string; requestId: null; retryAfterMs: null };
}
