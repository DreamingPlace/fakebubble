import type { RelationshipPreset } from './index.ts';
import type { Association } from './profile.ts';
import type { CharacterSummary } from './player-api.ts';

export interface CharacterRequest {
  id: string;
  playerId: string;
  character: CharacterSummary;
  status: 'pending' | 'accepted' | 'rejected';
  revision: number;
  createdAt: number;
  updatedAt: number;
  readAt: number | null;
  worldId: string | null;
  conversationId: string | null;
  relationship: RelationshipPreset | null;
  association: Association | null;
}
export interface CharacterRequestCounts {
  pending: number;
  unread: number;
}
export interface CharacterRequestPage extends CharacterRequestCounts {
  items: CharacterRequest[];
  before: string | null;
  hasMore: boolean;
}
export type CharacterRequestAction = { requestId: string; expectedRevision: number } & (
  | { action: 'accept'; relationship: RelationshipPreset; association: Association }
  | { action: 'reject' | 'read' }
);
export interface CharacterRequestReceipt {
  request: CharacterRequest;
  duplicate: boolean;
}
