import type { CharacterSelection, MessageDTO, RelationshipPreset } from './index.ts';
import type { GroupSummary } from './groups.ts';
import type { CharacterAssociation, PlayerProfile, PlayerProfileState } from './profile.ts';
import type { BetaRelease, PlayerAccount } from './beta.ts';

export interface PairingDescriptor {
  schemaVersion: 1 | 2;
  endpoint: string;
  certificateSHA256: string;
  inviteToken: string;
  expiresAt: number;
  release?: BetaRelease;
}
export interface PairInput {
  inviteToken: string;
  deviceSecret: string;
  deviceName: string;
}
export interface PairResult {
  deviceId: string;
  release?: BetaRelease;
}
export interface RecoveryPoint {
  version: 1;
  epoch: string;
  snapshotAt: number;
  restoredAt: number;
}
export interface WorldSetupInput {
  requestId: string;
  timeZone: string;
  selections: CharacterSelection[];
  profile?: PlayerProfile;
}
export interface SendMessageInput {
  requestId: string;
  text: string;
  replyToMessageId?: string;
}
export interface CharacterSummary {
  id: string;
  name: string;
  version: number;
  fictional: true;
}
export interface ConversationSummary {
  id: string;
  characterId: string;
  relationship: RelationshipPreset;
  scene?: import('./scenes.ts').SceneState;
  association?: CharacterAssociation | null;
  lastMessage: MessageDTO | null;
  lastMessageDurationMs?: number | null;
  unreadCount?: number;
  replyState: ReplyState;
}
export interface ReplyState {
  status: 'idle' | 'waiting' | 'queued' | 'generating' | 'awaiting_player' | 'failed' | 'unconfigured';
  activity?: 'typing' | 'speaking';
  pendingCount: number;
  nextAttemptAt: number | null;
  errorCode: string | null;
}
export interface BootstrapResult {
  contractVersion: 1;
  recoveryPoint?: RecoveryPoint | null;
  playerId: string;
  release?: BetaRelease;
  account?: PlayerAccount;
  world: { id: string; timeZone: string } | null;
  playerProfile?: PlayerProfileState | null;
  characters: CharacterSummary[];
  conversations: ConversationSummary[];
  groups?: GroupSummary[];
  characterRequests?: import('./character-requests.ts').CharacterRequestCounts;
  capabilities: {
    textGeneration: boolean;
    voice: boolean;
    social: false;
    groups?: boolean;
    moments?: boolean;
    momentAudienceGroups?: boolean;
    autonomousMoments?: boolean;
    feedback?: boolean;
    structuredFeedback?: boolean;
    feedbackWorkflow?: boolean;
    characterReset?: boolean;
    playerProfile?: boolean;
    relationshipJournal?: boolean;
    scenes?: boolean;
    friends?: boolean;
    readReceipts?: boolean;
    relationshipTest?: boolean;
    batchFeedback?: boolean;
    replyGroups?: boolean;
    evaluations?: boolean;
    push: false;
  };
}
export interface SyncPage {
  messages: MessageDTO[];
  cursor: string | null;
  hasMore: boolean;
}
export interface HistoryPage {
  messages: MessageDTO[];
  before: string | null;
  hasMore: boolean;
}
