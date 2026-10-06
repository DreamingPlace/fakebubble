import type { RelationshipPreset } from './index.ts';
import type { Association } from './profile.ts';
import type { MemoryScope } from './memory.ts';

export interface CreateFriendInput {
  requestId: string;
  name: string;
  background: string;
  speakingStyle: string;
  birthDate: string | null;
  timeZone: string;
  relationship: RelationshipPreset;
  association: Association;
}
export interface CreateFriendReceipt {
  worldId: string;
  characterId: string;
  conversationId: string;
  duplicate: boolean;
}
export interface ReadConversationInput {
  throughMessageId: string;
}
export interface ReadConversationReceipt {
  worldId: string;
  conversationId: string;
  throughMessageId: string;
}
export interface RelationshipTestValues {
  familiarity: number;
  boundaryOpenness: number;
}
export interface RelationshipTestState {
  scope: MemoryScope;
  revision: number;
  values: RelationshipTestValues | null;
  naturalFamiliarity: number;
  naturalOpenness: number;
}
export interface RelationshipTestInput {
  requestId: string;
  expectedRevision: number;
  values: RelationshipTestValues | null;
}
export interface RelationshipTestReceipt {
  scope: MemoryScope;
  revision: number;
  duplicate: boolean;
}
