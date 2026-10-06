import type {
  WebLocalBootstrap,
  WebLocalHistoryPage,
  WebLocalMessage,
  WebLocalOperation,
  WebLocalStatus,
  WebLocalSyncPage,
} from './web-local.ts';

export class WebLocalProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebLocalProtocolError';
  }
}

const statuses = new Set<WebLocalStatus>([
  'queued',
  'text_running',
  'text_ready',
  'audio_pending',
  'audio_running',
  'ready_to_publish',
  'retryable_failed',
  'unknown',
  'published',
  'cancelled',
  'failed',
]);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WebLocalProtocolError('object expected');
  return value as Record<string, unknown>;
};
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const fail = (message: string): never => {
  throw new WebLocalProtocolError(message);
};

export type LocalAccess = WebLocalBootstrap['access'];
export type LocalView = {
  kind: 'synthetic-local';
  bootstrap: WebLocalBootstrap;
  capabilities: { sendVoice: true; read: false; listened: false; invite: boolean; audition: false };
};
export type LocalSendAction = { kind: 'send-voice'; characterId: string; text: string; requestId: string };
export type LocalError = { code: string; requestId: null; retryAfterMs: null };

export function parseAccess(value: unknown): LocalAccess {
  const v = object(value);
  if (
    (v.kind !== 'guest' && v.kind !== 'account') ||
    !string(v.principalId) ||
    !string(v.playerId) ||
    !string(v.worldId) ||
    !number(v.revision) ||
    !(v.trialCharacterId === null || string(v.trialCharacterId)) ||
    !(v.trialRemaining === null || number(v.trialRemaining)) ||
    !(v.trialReserved === null || number(v.trialReserved)) ||
    typeof v.canSend !== 'boolean' ||
    v.canChooseText !== false
  )
    return fail('invalid access');
  return v as unknown as LocalAccess;
}

export function parseOperation(value: unknown): WebLocalOperation {
  const v = object(value);
  if (
    !string(v.operationId) ||
    !string(v.requestId) ||
    !string(v.conversationId) ||
    !statuses.has(v.status as WebLocalStatus) ||
    !number(v.revision) ||
    !number(v.acceptedAt) ||
    !number(v.deadlineAt) ||
    !(v.errorCode === null || string(v.errorCode)) ||
    typeof v.canCancel !== 'boolean'
  )
    return fail('invalid operation');
  if (v.publication !== null) {
    const p = object(v.publication);
    if (
      !string(p.operationId) ||
      !Array.isArray(p.messageIds) ||
      !p.messageIds.every(string) ||
      !(p.footerMessageId === null || string(p.footerMessageId))
    )
      return fail('invalid publication');
  }
  return v as unknown as WebLocalOperation;
}

export function parseBootstrap(value: unknown): LocalView {
  const v = object(value);
  if (
    !['web-v1-local-1', 'web-v1-local-2'].includes(String(v.contractVersion)) ||
    v.mode !== 'synthetic-local' ||
    v.region !== 'local-test'
  )
    return fail('unsupported local protocol');
  if (
    !string(v.instanceId) ||
    !string(v.recoveryEpoch) ||
    !string(v.csrf) ||
    !string(v.syncCursor) ||
    !Array.isArray(v.characters) ||
    !Array.isArray(v.conversations) ||
    !Array.isArray(v.activeOperations) ||
    !Array.isArray(v.unsupported) ||
    !v.unsupported.every(string)
  )
    return fail('invalid bootstrap');
  const access = parseAccess(v.access);
  if (v.contractVersion === 'web-v1-local-2') {
    const expiry = access.trialExpiresAt,
      state = access.retentionState;
    if (
      !(expiry === null || number(expiry)) ||
      !['unstarted', 'active', 'expired', 'protected'].includes(String(state)) ||
      (access.kind === 'account'
        ? state !== 'protected'
        : state === 'protected' ||
          (state === 'active' && expiry === null) ||
          (state === 'unstarted' && expiry !== null) ||
          (state === 'expired' && (access.canSend || expiry === null)))
    )
      return fail('invalid local-2 retention');
  }
  for (const raw of v.characters) {
    const c = object(raw),
      audition = object(c.audition);
    if (
      !string(c.characterId) ||
      !string(c.name) ||
      c.synthetic !== true ||
      audition.state !== 'unavailable' ||
      audition.reason !== 'not_approved'
    )
      return fail('invalid character');
  }
  for (const raw of v.conversations) {
    const c = object(raw);
    if (!string(c.conversationId) || !string(c.characterId)) return fail('invalid conversation');
  }
  v.activeOperations.forEach(parseOperation);
  return {
    kind: 'synthetic-local',
    bootstrap: v as unknown as WebLocalBootstrap,
    capabilities: {
      sendVoice: true,
      read: false,
      listened: false,
      invite: v.contractVersion === 'web-v1-local-2' && !v.unsupported.includes('invite'),
      audition: false,
    },
  };
}

export function parseError(value: unknown): LocalError {
  const e = object(object(value).error);
  if (!string(e.code) || e.requestId !== null || e.retryAfterMs !== null) return fail('invalid error');
  return e as unknown as LocalError;
}

export function parseMessage(value: unknown): WebLocalMessage {
  const v = object(value);
  if (
    !string(v.messageId) ||
    !string(v.conversationId) ||
    !string(v.characterId) ||
    !string(v.operationId) ||
    !(v.replyOrdinal === null || number(v.replyOrdinal)) ||
    (v.author !== 'player' && v.author !== 'character') ||
    !['input', 'narrative', 'trial_footer'].includes(String(v.origin)) ||
    !string(v.text) ||
    !number(v.createdAt)
  )
    return fail('invalid message');
  if (v.audio !== null) {
    const a = object(v.audio);
    if (a.status !== 'ready' || !string(a.mediaId) || a.synthetic !== true) return fail('invalid audio');
  }
  return v as unknown as WebLocalMessage;
}

export function parseHistory(value: unknown): WebLocalHistoryPage {
  const v = object(value);
  if (
    !string(v.conversationId) ||
    !Array.isArray(v.messages) ||
    !(v.before === null || string(v.before)) ||
    typeof v.hasMore !== 'boolean'
  )
    return fail('invalid history');
  v.messages.forEach(parseMessage);
  return v as unknown as WebLocalHistoryPage;
}

export function parseSync(value: unknown): WebLocalSyncPage {
  const v = object(value);
  if (!Array.isArray(v.events) || !string(v.cursor) || typeof v.hasMore !== 'boolean') return fail('invalid sync');
  for (const raw of v.events) {
    const e = object(raw);
    if (
      !string(e.eventId) ||
      !(e.conversationId === null || string(e.conversationId)) ||
      !['operation', 'publication', 'access'].includes(String(e.kind)) ||
      !number(e.revision)
    )
      return fail('invalid sync event');
    object(e.payload);
  }
  return v as unknown as WebLocalSyncPage;
}
