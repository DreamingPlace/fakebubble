/** WEB-V1 draft wire contract. S0 review is required before a server route uses it. */
export type WebId = string;
export type WebAccessKind = 'guest' | 'account' | 'invite';
export type WebOperationStatus =
  | 'queued'
  | 'text_running'
  | 'text_ready'
  | 'audio_pending'
  | 'audio_running'
  | 'ready_to_publish'
  | 'published'
  | 'retryable_failed'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type WebAudioStatus = 'pending' | 'generating' | 'ready' | 'failed' | 'unknown';
export type WebErrorCode =
  | 'INVALID_REQUEST'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TRIAL_EXHAUSTED'
  | 'TRIAL_CHARACTER_LOCKED'
  | 'QUEUE_FULL'
  | 'WEB_DAILY_LIMIT_REACHED'
  | 'REGION_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'SESSION_EXPIRED'
  | 'OPERATION_EXPIRED'
  | 'OPERATION_UNKNOWN'
  | 'VOICE_UNAVAILABLE'
  | 'READ_ONLY_ARCHIVE'
  | 'NOT_FOUND'
  | 'INVALID_CURSOR'
  | 'MEMORY_CONFLICT'
  | 'INTERNAL_ERROR';

export interface WebAccess {
  kind: WebAccessKind;
  principalId: WebId;
  playerId: WebId;
  worldId: WebId;
  revision: number;
  trialCharacterId: WebId | null;
  /** Available new admissions, after both IP and principal used+reserved counts. */
  trialRemaining: number | null;
  trialReserved: number | null;
  expiresAt: number | null;
  canChooseText: boolean;
  canSend: boolean;
}

export interface WebTheme {
  themeVersion: number;
  pageBackground: string;
  sourceColor: string | null;
  resolvedColor: string;
  adjustment: number | null;
  approved: boolean;
  cardSurface: string;
  messageSurface: string;
  inputSurface: string;
  textColor: string;
  border: string;
  shadow: string;
}

export interface WebCharacter {
  characterId: WebId;
  name: string;
  description: string;
  imageUrl: string | null;
  /** Public approved-material snapshot only; never a source voice sample or license file. */
  audition:
    | {
        state: 'available';
        url: string;
        mediaId: WebId;
        voiceVersion: string;
        sha256: string;
        durationMs: number | null;
      }
    | { state: 'unavailable'; reason: 'not_approved' | 'missing' | 'region_unavailable' };
  theme: WebTheme;
}

export interface WebConversation {
  conversationId: WebId;
  characterId: WebId;
  lastMessageId: WebId | null;
  unreadCount: number;
  latestOperationId: WebId | null;
}

export interface WebAudio {
  /** Monotone within one published message; stale status cannot replace a newer one. */
  revision: number;
  status: WebAudioStatus;
  mediaId: WebId | null;
  durationMs: number | null;
  listenedAt: number | null;
  errorCode: WebErrorCode | null;
}

export interface WebMessage {
  messageId: WebId;
  conversationId: WebId;
  characterId: WebId;
  operationId: WebId | null;
  /** Zero-based narrative order; null for input, footer and admin messages. */
  replyOrdinal: number | null;
  author: 'player' | 'character' | 'admin';
  origin: 'narrative' | 'trial_footer' | 'admin_character';
  text: string;
  createdAt: number;
  audio: WebAudio | null;
}

export interface WebOperation {
  operationId: WebId;
  requestId: WebId;
  conversationId: WebId;
  /** Monotone per operation, including terminal transitions. */
  revision: number;
  status: WebOperationStatus;
  acceptedAt: number;
  deadlineAt: number;
  errorCode: WebErrorCode | null;
  retryAfterMs: number | null;
  canCancel: boolean;
  canRetry: boolean;
  /** Present only after atomic publication; footer is not a narrative ordinal. */
  publication: { narrativeMessageIds: WebId[]; footerMessageId: WebId | null } | null;
}

export interface WebBootstrap {
  contractVersion: 'web-v1-draft-1';
  instanceId: WebId;
  recoveryEpoch: WebId;
  access: WebAccess;
  characters: WebCharacter[];
  conversations: WebConversation[];
  syncCursor: string | null;
}

export interface WebSendInput {
  requestId: WebId;
  text: string;
  replyToMessageId?: WebId;
  delivery: 'voice' | 'text';
}

/** E calls B's data action, not fetch. B persists one requestId before network send. */
export type WebSendDraft = Omit<WebSendInput, 'requestId'>;
export interface WebSendAction {
  send(characterId: WebId, draft: WebSendDraft): Promise<WebSendReceipt>;
}

export interface WebSendReceipt {
  operation: WebOperation;
  duplicate: boolean;
}

export interface WebRegisterInput {
  requestId: WebId;
  username: string;
  password: string;
}
export interface WebLoginInput {
  requestId: WebId;
  username: string;
  password: string;
}
export interface WebInviteRedeemInput {
  requestId: WebId;
  code: string;
}
export interface WebRecoverInput {
  requestId: WebId;
  recoveryCode: string;
}
export interface WebPendingTrialClaim {
  claimId: WebId;
  characterId: WebId;
  sourceConversationId: WebId;
  /** Existing account's live conversation, not the read-only source. */
  targetConversationId: WebId;
  expiresAt: number;
}
export interface WebIdentityReceipt {
  access: WebAccess;
  duplicate: boolean;
  /** Only when login meets an existing same-character archive conflict. Not authorization by itself. */
  pendingTrialClaim: WebPendingTrialClaim | null;
}

export interface WebHistoryPage {
  conversationId: WebId;
  messages: WebMessage[];
  before: string | null;
  hasMore: boolean;
}

/** An existing-account trial is a separate read-only source, never a live conversation. */
export interface WebTrialArchive {
  archiveId: WebId;
  sourceConversationId: WebId;
  characterId: WebId;
  savedAt: number;
  lastMessageId: WebId | null;
}

export interface WebSaveTrialInput {
  requestId: WebId;
  claimId: WebId;
}
export interface WebSaveTrialReceipt {
  archive: WebTrialArchive;
  targetConversationId: WebId;
  duplicate: boolean;
}
export interface WebTrialArchivePage {
  archives: WebTrialArchive[];
  before: string | null;
  hasMore: boolean;
}
export interface WebTrialArchiveHistory extends WebHistoryPage {
  archiveId: WebId;
  readOnly: true;
}

export interface WebReadReceipt {
  conversationId: WebId;
  throughMessageId: WebId;
  readAt: number;
}
export interface WebListenedReceipt {
  conversationId: WebId;
  messageId: WebId;
  listenedAt: number;
}

export interface WebMemorySummary {
  memoryId: WebId;
  conversationId: WebId;
  characterId: WebId;
  summary: string;
  revision: number;
}
export interface WebMemoryPage {
  conversationId: WebId;
  memories: WebMemorySummary[];
  before: string | null;
  hasMore: boolean;
}
export interface WebMemoryCorrectionInput {
  requestId: WebId;
  expectedRevision: number;
  correction: string;
}
export interface WebMemoryCorrectionReceipt {
  memory: WebMemorySummary;
  duplicate: boolean;
}

export type WebSyncEvent =
  | { eventId: string; conversationId: WebId; kind: 'message'; message: WebMessage }
  | { eventId: string; conversationId: WebId; kind: 'operation'; operation: WebOperation }
  | { eventId: string; conversationId: WebId; kind: 'audio'; messageId: WebId; audio: WebAudio }
  | { eventId: string; conversationId: null; kind: 'access'; access: WebAccess };

export interface WebSyncPage {
  events: WebSyncEvent[];
  cursor: string | null;
  hasMore: boolean;
}

export interface WebApiError {
  error: { code: WebErrorCode; requestId: WebId | null; retryAfterMs: number | null };
}
