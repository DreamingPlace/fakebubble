import type { MessageDTO } from './index.ts';
import type { ReplyState } from './player-api.ts';

export interface CreateGroupInput {
  requestId: string;
  name: string;
  characterIds: string[];
}
export interface GroupMember {
  characterId: string;
  replyState: ReplyState;
}
export interface GroupSummary {
  id: string;
  worldId: string;
  name: string;
  createdAt: number | null;
  members: GroupMember[];
  lastMessage: MessageDTO | null;
  lastMessageDurationMs?: number | null;
  unreadCount?: number;
}
export interface CreateGroupReceipt {
  group: GroupSummary;
  duplicate: boolean;
}
export interface SendGroupInput {
  requestId: string;
  text: string;
  mentionedCharacterIds: string[];
  replyToMessageId?: string;
}
export interface GroupRouting {
  responderIds: string[];
  mentionedCharacterIds: string[];
  reason: 'explicit' | 'continuation' | 'rotation';
}
export interface SendGroupReceipt {
  message: MessageDTO;
  duplicate: boolean;
  routing: GroupRouting;
  members: GroupMember[];
}
