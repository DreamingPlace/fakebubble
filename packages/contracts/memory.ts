import type { CharacterScope, ContextEvidence, TopicCandidate } from './index.ts';

export type MemoryScope = Pick<CharacterScope, 'worldId' | 'conversationId' | 'characterId'>;
export interface MemoryCorrection {
  id: string; memoryId: string; topicKey: string; revision: number;
  summary: string; reason: string; evidenceMessageIds: string[]; recordedAt: number;
  source: 'player_correction';
}
export interface MemoryCorrectionInput {
  requestId: string; expectedRevision: number; summary: string; reason: string; evidenceMessageIds: string[];
}
export interface MemoryTopicDTO {
  id: string; key: string; tier: 'short' | 'long'; playerMentions: number; lastSeenAt: number;
  activeUntil: number; active: boolean; revision: number; latestCorrection: MemoryCorrection | null;
}
export interface MemoryEpisodeDTO {
  id: string; summary: string; sourceKind: TopicCandidate['sourceKind']; at: number; messageIds: string[];
  sources?: ContextEvidence[];
  excerpts: { id: string; authorKind: 'player' | 'character'; authorId?: string; text: string; at: number }[];
}
export interface MemoryTopicPage { scope: MemoryScope; items: MemoryTopicDTO[]; before: string | null; hasMore: boolean }
export interface MemoryDetail {
  scope: MemoryScope; topic: MemoryTopicDTO; episodes: MemoryEpisodeDTO[]; before: string | null; hasMore: boolean;
}
export interface MemoryCorrectionPage { scope: MemoryScope; items: MemoryCorrection[]; before: string | null; hasMore: boolean }
export interface MemoryCorrectionReceipt { scope: MemoryScope; correction: MemoryCorrection; duplicate: boolean }
