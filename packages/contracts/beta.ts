export interface BetaRelease {
  channel: 'beta';
  version: string;
  label: string;
  instanceId: string;
}
export interface BetaPairInput {
  inviteToken: string;
  deviceSecret: string;
  deviceName: string;
  channel: 'beta';
  instanceId: string;
  nickname: string;
}
export interface PlayerAccount {
  nickname: string;
}
export interface AdminPlayerAccount extends PlayerAccount {
  playerId: string;
  meteringId: string;
  status: 'active' | 'suspended';
  revision: number;
  createdAt: number;
  suspendedAt: number | null;
}
export interface AccountStatusInput {
  requestId: string;
  expectedRevision: number;
  status: 'active' | 'suspended';
}
export interface ReplyGroup {
  id: string;
  worldId: string;
  conversationId: string;
  characterId: string;
  characterVersion: number;
  publishedMessageIds: string[];
  complete: boolean;
  finalMessageId: string | null;
}
export interface ReplyGroupPage {
  worldId: string;
  conversationId: string;
  groups: ReplyGroup[];
}
