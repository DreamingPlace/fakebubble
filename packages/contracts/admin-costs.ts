import type { ProviderBounds, ProviderObservation, ProviderStage, ProviderUsage } from './provider-calls.ts';

/** Administrator-only cost contracts. Never include these in player bootstrap/sync DTOs. */
export type CostMicros = string; // Canonical nonnegative integer; 1 currency unit = 1,000,000 micros.
export type CostUnit = 'tokens' | 'utf8_bytes';
export type CostStage = ProviderStage;
export type CostFunction = 'chat' | 'proactive_chat' | 'moment_post' | 'moment_reply' | 'character_preview' | 'voice_preview' | 'source_summary';
export type CostOwner = { kind: 'global' } | { kind: 'operations' } | { kind: 'player'; playerId: string };
export type CostScope = { kind: 'player'; playerId: string; worldId: string; conversationId: string; characterId: string } |
  { kind: 'operations'; characterId: string | null };
export interface CostPrice {
  id: string; provider: string; model: string; currency: string; validFrom: number; validUntil: number;
  rates: { unit: 'tokens'; cacheHitInput: CostMicros; cacheMissInput: CostMicros; output: CostMicros } |
    { unit: 'utf8_bytes'; bytes: CostMicros }; // Micros per 1,000,000 units; round up once per call.
}
export interface CostBudget {
  id: string; owner: CostOwner; currency: string; from: number; until: number;
  revision: number; limitMicros: CostMicros; heldMicros: CostMicros; chargedMicros: CostMicros;
}
export type CostBounds = ProviderBounds;
export type CostUsage = ProviderUsage;
export interface CostCallInput {
  id: string; scope: CostScope; function: CostFunction; taskId: string; stage: CostStage;
  provider: string; model: string; bounds: CostBounds;
}
export type CostObservation = ProviderObservation;
export interface CostCall {
  id: string; scope: CostScope; meteringId: string | null; function: CostFunction; taskId: string; stage: CostStage;
  provider: string; model: string; priceId: string; currency: string; bounds: CostBounds;
  globalBudgetId: string; ownerBudgetId: string; reservedMicros: CostMicros;
  state: 'reserved' | 'dispatched' | 'unknown' | 'finished' | 'cancelled'; revision: number;
  basis: 'pending' | 'unknown' | 'estimated' | 'reconciled' | 'not_sent'; amountMicros: CostMicros | null;
  reviewRequired: boolean;
  observation: CostObservation | null; createdAt: number; dispatchedAt: number | null; updatedAt: number;
}
export interface CostBudgetInput {
  requestId: string; id: string; owner: CostOwner; currency: string; from: number; until: number; expectedRevision: number; limitMicros: CostMicros;
}
export interface CostReconciliationInput { requestId: string; expectedRevision: number; currency: string; amountMicros: CostMicros; reference: string }
export type CostGrouping = 'player' | 'character' | 'model' | 'function' | 'overall';
export interface CostFilters {
  from: number | null; until: number | null; owner: 'all' | 'players' | 'operations';
  playerId?: string; characterId?: string; provider?: string; model?: string; function?: CostFunction;
}
export interface CostQuantityTotal { known: string; unknownRecords: number }
export interface CostTotals {
  records: number; dispatched: number; pending: number; unknown: number; notSent: number; reviewRequired: number;
  estimatedMicros: CostMicros; reconciledMicros: CostMicros; knownMicros: CostMicros; textMicros: CostMicros; speechMicros: CostMicros; heldMicros: CostMicros;
  inputTokens: CostQuantityTotal; cacheHitInputTokens: CostQuantityTotal; cacheMissInputTokens: CostQuantityTotal; outputTokens: CostQuantityTotal; speechBytes: CostQuantityTotal;
}
export interface CostReportGroup {
  key: string; currency: string; owner: 'players' | 'operations'; playerId: string | null; nickname: string | null;
  characterId: string | null; provider: string | null; model: string | null; function: CostFunction | null; totals: CostTotals;
}
export interface CostPage<T> { items: T[]; after: string | null; hasMore: boolean }
export interface CostReport extends CostPage<CostReportGroup> { groupBy: CostGrouping; filters: CostFilters; queriedAt: number }
export interface CostCallPage extends CostPage<CostCall> { filters: CostFilters }
export interface CostEvent { requestId: string; kind: 'observation' | 'reconciliation' | 'cancel'; input: unknown; result: CostCall; createdAt: number }
