import type { WebAudioStatus, WebErrorCode, WebOperationStatus, WebTheme } from './web-v1.ts';

/** Separate provider-web protocol. Synthetic local-1/2/3 wire objects are not assignable. */
export const WEB_PROVIDER_CONTRACT = 'web-v1-provider-2' as const;
/** Initial approved seed only, never the operational runtime allowlist. */
export const WEB_PROVIDER_CHARACTER_IDS = ['chen-jimi', 'wei-guagua', 'jojo'] as const;
export type WebProviderCharacterId = string;
export const isWebProviderCharacterId = (value: unknown): value is WebProviderCharacterId =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export type WebProviderUnavailableReason =
  | 'material_missing'
  | 'voice_unverified'
  | 'audio_missing'
  | 'quality_pending'
  | 'region_unavailable';

export type WebProviderMedia =
  | { state: 'available'; mediaId: string; url: string; version: string; sha256: string; durationMs: number }
  | { state: 'unavailable'; reason: WebProviderUnavailableReason };
export interface WebProviderCharacter {
  characterId: WebProviderCharacterId;
  displayName: string;
  publicDescription: string;
  portraitUrl: string | null;
  theme: WebTheme | null;
  availability:
    | { state: 'available'; personaVersion: number }
    | { state: 'unavailable'; reason: WebProviderUnavailableReason };
  welcome:
    | { text: string; version: string; audio: WebProviderMedia }
    | { text: null; version: null; audio: { state: 'unavailable'; reason: WebProviderUnavailableReason } };
}
export type WebProviderSlot =
  | { kind: 'character'; characterId: WebProviderCharacterId }
  | { kind: 'preview'; slotId: string; label: string };

export type WebProviderAccess =
  | {
      kind: 'guest';
      principalId: string;
      playerId: string;
      worldId: string;
      revision: number;
      lockedCharacterId: WebProviderCharacterId | null;
      remainingReplies: number;
      reservedReplies: number;
      trialExpiresAt: number | null;
      canSend: boolean;
    }
  | {
      kind: 'invite';
      principalId: string;
      playerId: string;
      worldId: string;
      revision: number;
      grantId: string;
      status: 'active' | 'revoked' | 'expired';
      lockedCharacterId: null;
      remainingReplies: null;
      reservedReplies: null;
      trialExpiresAt: null;
      canSend: boolean;
    };
export interface WebProviderConversation {
  conversationId: string;
  characterId: WebProviderCharacterId;
  lastMessageId: string | null;
  unreadCount: number;
}
export interface WebProviderBootstrap {
  contractVersion: typeof WEB_PROVIDER_CONTRACT;
  mode: 'provider-local' | 'provider-cloud';
  region: 'local-test' | 'public';
  fixture: boolean;
  instanceId: string;
  recoveryEpoch: string;
  csrf: string;
  access: WebProviderAccess;
  characters: WebProviderCharacter[];
  /** Exactly 15 visual slots; previews are never sendable identities. */
  slots: WebProviderSlot[];
  conversations: WebProviderConversation[];
  syncCursor: string;
}
export interface WebProviderSend {
  requestId: string;
  characterId: WebProviderCharacterId;
  text: string;
  delivery: 'voice';
}
export interface WebProviderOperation {
  operationId: string;
  requestId: string;
  characterId: WebProviderCharacterId;
  conversationId: string;
  status: WebOperationStatus;
  revision: number;
  acceptedAt: number;
  deadlineAt: number;
  errorCode: WebErrorCode | null;
  canCancel: boolean;
  canRetry: boolean;
  publication: { narrativeMessageIds: string[]; footerMessageId: string | null } | null;
}
export interface WebProviderMessage {
  messageId: string;
  conversationId: string;
  characterId: WebProviderCharacterId;
  operationId: string | null;
  replyOrdinal: number | null;
  author: 'player' | 'character' | 'admin';
  origin: 'input' | 'narrative' | 'trial_footer' | 'admin_character';
  text: string;
  createdAt: number;
  audio: {
    revision: number;
    status: WebAudioStatus;
    mediaId: string | null;
    durationMs: number | null;
    errorCode: WebErrorCode | null;
  } | null;
}
export interface WebProviderHistory {
  characterId: WebProviderCharacterId;
  conversationId: string;
  messages: WebProviderMessage[];
  before: string | null;
  hasMore: boolean;
}
export interface WebProviderEvent {
  eventId: string;
  conversationId: string | null;
  characterId: WebProviderCharacterId | null;
  kind: 'operation' | 'publication' | 'access' | 'catalog';
  revision: number;
  payload: Record<string, unknown>;
}
export interface WebProviderSync {
  events: WebProviderEvent[];
  cursor: string;
  hasMore: boolean;
}
/** One principal-level SSE stream; each private event carries conversation and character scope. */
export interface WebProviderActions {
  /** Reuse LocalApi bootstrap/byRequest/operation/SSE cursor pattern after redeem or uncertain send. */
  redeemInvite(input: { requestId: string; code: string }): Promise<{ grantId: string; duplicate: boolean }>;
  bootstrap(): Promise<WebProviderBootstrap>;
  byRequest(requestId: string): Promise<WebProviderOperation>;
  operation(operationId: string): Promise<WebProviderOperation>;
  submit(input: WebProviderSend): Promise<{ operation: WebProviderOperation; duplicate: boolean }>;
  history(input: {
    characterId: WebProviderCharacterId;
    conversationId: string;
    before: string | null;
  }): Promise<WebProviderHistory>;
  sync(input: { cursor: string | null }): Promise<WebProviderSync>;
  eventUrl(cursor: string): string;
  audio(input: {
    characterId: WebProviderCharacterId;
    conversationId: string;
    messageId: string;
    mediaId: string;
  }): Promise<Uint8Array>;
}
export interface WebProviderError {
  error: { code: WebErrorCode; requestId: string | null; retryAfterMs: number | null };
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WEB_PROVIDER_PROTOCOL_INVALID');
  return value as Record<string, unknown>;
};
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const characterId = isWebProviderCharacterId;
const millis = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const reasons = new Set<WebProviderUnavailableReason>([
  'material_missing',
  'voice_unverified',
  'audio_missing',
  'quality_pending',
  'region_unavailable',
]);
const reason = (value: unknown): value is WebProviderUnavailableReason =>
  reasons.has(value as WebProviderUnavailableReason);
const color = (value: unknown): value is string => typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
const publicUrl = (value: unknown, kind: 'public-audio' | 'public-image', mediaId?: string) =>
  typeof value === 'string' &&
  new RegExp(`^/api/web/provider/${kind}/[A-Za-z0-9_-]{1,128}$`).test(value) &&
  (mediaId === undefined || value.endsWith(`/${mediaId}`));
const invalid = (): never => {
  throw new Error('WEB_PROVIDER_PROTOCOL_INVALID');
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).sort().join(',') !== keys.sort().join(',')) invalid();
};
function parseTheme(value: unknown): void {
  if (value === null) return;
  const theme = record(value);
  exact(theme, [
    'themeVersion',
    'pageBackground',
    'sourceColor',
    'resolvedColor',
    'adjustment',
    'approved',
    'cardSurface',
    'messageSurface',
    'inputSurface',
    'textColor',
    'border',
    'shadow',
  ]);
  if (
    !millis(theme.themeVersion) ||
    !color(theme.pageBackground) ||
    !(theme.sourceColor === null || color(theme.sourceColor)) ||
    !color(theme.resolvedColor) ||
    !(
      theme.adjustment === null ||
      (typeof theme.adjustment === 'number' &&
        Number.isFinite(theme.adjustment) &&
        theme.adjustment >= -1 &&
        theme.adjustment <= 1)
    ) ||
    typeof theme.approved !== 'boolean' ||
    !color(theme.cardSurface) ||
    !color(theme.messageSurface) ||
    !color(theme.inputSurface) ||
    !color(theme.textColor) ||
    !color(theme.border) ||
    theme.shadow !== 'none'
  )
    invalid();
}

/** B/E boundary: never parse local-3 or private Fish identifiers as catalog data. */
export function parseWebProviderBootstrap(value: unknown): WebProviderBootstrap {
  const root = record(value);
  exact(root, [
    'contractVersion',
    'mode',
    'region',
    'fixture',
    'instanceId',
    'recoveryEpoch',
    'csrf',
    'access',
    'characters',
    'slots',
    'conversations',
    'syncCursor',
  ]);
  if (
    root.contractVersion !== WEB_PROVIDER_CONTRACT ||
    !(
      (root.mode === 'provider-local' && root.region === 'local-test') ||
      (root.mode === 'provider-cloud' && root.region === 'public' && root.fixture === false)
    ) ||
    typeof root.fixture !== 'boolean' ||
    !id(root.instanceId) ||
    !id(root.recoveryEpoch) ||
    !id(root.csrf) ||
    typeof root.syncCursor !== 'string'
  )
    invalid();
  const access = record(root.access);
  if (
    !['guest', 'invite'].includes(String(access.kind)) ||
    !id(access.principalId) ||
    !id(access.playerId) ||
    !id(access.worldId) ||
    !millis(access.revision) ||
    typeof access.canSend !== 'boolean'
  )
    invalid();
  if (access.kind === 'guest') {
    exact(access, [
      'kind',
      'principalId',
      'playerId',
      'worldId',
      'revision',
      'lockedCharacterId',
      'remainingReplies',
      'reservedReplies',
      'trialExpiresAt',
      'canSend',
    ]);
    if (
      !(access.lockedCharacterId === null || characterId(access.lockedCharacterId)) ||
      !millis(access.remainingReplies) ||
      !millis(access.reservedReplies) ||
      !(access.trialExpiresAt === null || millis(access.trialExpiresAt)) ||
      (root.fixture && access.canSend)
    )
      invalid();
  } else {
    exact(access, [
      'kind',
      'principalId',
      'playerId',
      'worldId',
      'revision',
      'grantId',
      'status',
      'lockedCharacterId',
      'remainingReplies',
      'reservedReplies',
      'trialExpiresAt',
      'canSend',
    ]);
    if (
      !id(access.grantId) ||
      !['active', 'revoked', 'expired'].includes(String(access.status)) ||
      access.lockedCharacterId !== null ||
      access.remainingReplies !== null ||
      access.reservedReplies !== null ||
      access.trialExpiresAt !== null ||
      (access.status !== 'active' && access.canSend) ||
      (root.fixture && access.canSend)
    )
      invalid();
  }
  if (
    !Array.isArray(root.characters) ||
    root.characters.length > 15 ||
    !Array.isArray(root.slots) ||
    root.slots.length !== 15 ||
    !Array.isArray(root.conversations)
  )
    invalid();
  const characters = root.characters as unknown[];
  const slots = root.slots as unknown[];
  const conversations = root.conversations as unknown[];
  const seen = new Set<string>();
  for (const raw of characters) {
    const c = record(raw);
    exact(c, ['characterId', 'displayName', 'publicDescription', 'portraitUrl', 'theme', 'availability', 'welcome']);
    if (
      !characterId(c.characterId) ||
      seen.has(c.characterId) ||
      typeof c.displayName !== 'string' ||
      !c.displayName.trim() ||
      c.displayName.length > 100 ||
      typeof c.publicDescription !== 'string' ||
      c.publicDescription.length > 500 ||
      !(c.portraitUrl === null || publicUrl(c.portraitUrl, 'public-image')) ||
      (root.fixture && c.portraitUrl !== null) ||
      !c.availability ||
      !c.welcome
    )
      invalid();
    parseTheme(c.theme);
    seen.add(c.characterId as string);
    const availability = record(c.availability),
      welcome = record(c.welcome);
    if (availability.state === 'available') {
      exact(availability, ['state', 'personaVersion']);
      if (root.fixture || !millis(availability.personaVersion) || availability.personaVersion === 0) invalid();
    } else if (availability.state === 'unavailable') {
      exact(availability, ['state', 'reason']);
      if (!reason(availability.reason)) invalid();
    } else invalid();
    exact(welcome, ['text', 'version', 'audio']);
    const audio = record(welcome.audio);
    if (audio.state === 'available') {
      exact(audio, ['state', 'mediaId', 'url', 'version', 'sha256', 'durationMs']);
      if (
        root.fixture ||
        availability.state !== 'available' ||
        !id(audio.mediaId) ||
        !publicUrl(audio.url, 'public-audio', audio.mediaId as string) ||
        !id(audio.version) ||
        !/^[a-f0-9]{64}$/.test(String(audio.sha256)) ||
        !millis(audio.durationMs) ||
        audio.durationMs === 0
      )
        invalid();
    } else if (audio.state === 'unavailable') {
      exact(audio, ['state', 'reason']);
      if (!reason(audio.reason)) invalid();
    } else invalid();
    if (welcome.text === null || welcome.version === null) {
      if (welcome.text !== null || welcome.version !== null || audio.state !== 'unavailable') invalid();
    } else if (
      typeof welcome.text !== 'string' ||
      !welcome.text.trim() ||
      [...welcome.text].length > 500 ||
      !id(welcome.version) ||
      availability.state !== 'available' ||
      root.fixture
    )
      invalid();
  }
  const slotted = new Set<string>(),
    previews = new Set<string>();
  for (const raw of slots) {
    const slot = record(raw);
    if (slot.kind === 'character') {
      exact(slot, ['kind', 'characterId']);
      if (!characterId(slot.characterId) || !seen.has(slot.characterId) || slotted.has(slot.characterId)) invalid();
      slotted.add(slot.characterId as string);
    } else if (slot.kind === 'preview') {
      exact(slot, ['kind', 'slotId', 'label']);
      if (!id(slot.slotId) || previews.has(slot.slotId) || typeof slot.label !== 'string') invalid();
      previews.add(slot.slotId as string);
    } else invalid();
  }
  if (slotted.size !== seen.size || previews.size !== 15 - seen.size) invalid();
  const conversationIds = new Set<string>();
  for (const raw of conversations) {
    const conversation = record(raw);
    exact(conversation, ['conversationId', 'characterId', 'lastMessageId', 'unreadCount']);
    if (
      !id(conversation.conversationId) ||
      !characterId(conversation.characterId) ||
      !seen.has(conversation.characterId) ||
      conversationIds.has(conversation.conversationId) ||
      !(conversation.lastMessageId === null || id(conversation.lastMessageId)) ||
      !millis(conversation.unreadCount)
    )
      invalid();
    conversationIds.add(conversation.conversationId as string);
  }
  return root as unknown as WebProviderBootstrap;
}

/** Same wire shape as bootstrap; all media unavailable and explicitly marked as a fixture. */
export function syntheticProviderBootstrap(): WebProviderBootstrap {
  const names: Record<(typeof WEB_PROVIDER_CHARACTER_IDS)[number], string> = {
    'chen-jimi': '陈吉米',
    'wei-guagua': '瓜瓜',
    jojo: 'JOJO',
  };
  return {
    contractVersion: WEB_PROVIDER_CONTRACT,
    mode: 'provider-local',
    region: 'local-test',
    fixture: true,
    instanceId: 'fixture-instance',
    recoveryEpoch: 'fixture-epoch',
    csrf: 'fixture-csrf',
    access: {
      kind: 'guest',
      principalId: 'fixture-principal',
      playerId: 'fixture-player',
      worldId: 'fixture-world',
      revision: 0,
      lockedCharacterId: null,
      remainingReplies: 3,
      reservedReplies: 0,
      trialExpiresAt: null,
      canSend: false,
    },
    characters: WEB_PROVIDER_CHARACTER_IDS.map((characterId) => ({
      characterId,
      displayName: names[characterId],
      publicDescription: '合成契约占位，尚无可展示人物资料。',
      portraitUrl: null,
      theme: null,
      availability: { state: 'unavailable', reason: 'material_missing' },
      welcome: { text: null, version: null, audio: { state: 'unavailable', reason: 'audio_missing' } },
    })),
    slots: [
      ...WEB_PROVIDER_CHARACTER_IDS.map((characterId) => ({ kind: 'character' as const, characterId })),
      ...Array.from({ length: 12 }, (_, index) => ({
        kind: 'preview' as const,
        slotId: `preview-${index + 1}`,
        label: '敬请期待',
      })),
    ],
    conversations: [],
    syncCursor: 'fixture-cursor',
  };
}
