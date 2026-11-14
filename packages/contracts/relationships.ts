import type { RelationshipPreset } from './index.ts';
import type { MemoryScope } from './memory.ts';

/**
 * Part 35: there is no relationship setting any more (初识 / 朋友 / 亲近朋友 / 恋人 are gone from the console and from every 预演).
 * The reply pipeline still wants a preset for a new player's conversation, and the stored 预演 run still has the column: both get
 * THIS value, today's default for a new player (the one a first visit writes in web-provider-application.ts). The chat prompt still
 * has its 关系预设 wording; Part 37a removes that slot, and with it this constant.
 */
export const NEW_PLAYER_RELATIONSHIP: RelationshipPreset = 'new';

export const RELATIONSHIP_EVENT_KINDS = [
  'support',
  'boundary_respected',
  'promise_kept',
  'shared_experience',
  'trust_damage',
  'repair',
] as const;
export type RelationshipEventKind = (typeof RELATIONSHIP_EVENT_KINDS)[number];
export interface RelationshipProof {
  messageId: string;
  quote: string;
}
/** Independent review proposes evidence, never points or a new relationship identity. */
export interface RelationshipEventCandidate {
  kind: RelationshipEventKind;
  key: string;
  anchor: RelationshipProof;
  evidence: RelationshipProof[];
  responseQuote: string;
  summary: string;
  basis: 'in_chat' | 'player_report';
  repairsEventId: string | null;
}
export interface RelationshipContext {
  policyVersion: 1;
  revision: number;
  trust: number;
  familiarity: number;
  positiveDays: number;
  eventKinds: RelationshipEventKind[];
  openness: 'reserved' | 'settling' | 'comfortable';
  testOverride?: import('./playtest-social.ts').RelationshipTestValues;
  // First slice earns events in private chats only. Shared threads omit this entire context.
  auditEnabled: boolean;
  recentEvents: {
    id: string;
    kind: RelationshipEventKind;
    key: string;
    summary: string;
    at: number;
    response: RelationshipProof;
    corrected: boolean;
    repairable: boolean;
  }[];
}
export interface RelationshipJournalItem {
  id: string;
  kind: RelationshipEventKind;
  summary: string;
  basis: 'in_chat' | 'player_report';
  at: number;
  anchor: RelationshipProof;
  evidence: RelationshipProof[];
  response: RelationshipProof;
  counted: boolean;
  correction: { reason: string; at: number } | null;
}
export interface RelationshipJournalPage {
  scope: MemoryScope;
  items: RelationshipJournalItem[];
  before: string | null;
  hasMore: boolean;
}
export interface RelationshipCorrectionInput {
  requestId: string;
  expectedRevision: 0;
  reason: string;
}
export interface RelationshipCorrectionReceipt {
  scope: MemoryScope;
  eventId: string;
  revision: 1;
  reason: string;
  at: number;
  duplicate: boolean;
}
