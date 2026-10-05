/** Safe transport observations only. No prices, budgets, database handles or model input. */
export type ProviderStage = 'draft' | 'review' | 'speech' | 'source_summary';
export type ProviderBounds = { unit: 'tokens'; inputTokens: number; outputTokens: number } | { unit: 'utf8_bytes'; bytes: number };
export type ProviderUsage = { unit: 'tokens'; inputTokens: number | null; cacheHitInputTokens: number | null; cacheMissInputTokens: number | null; outputTokens: number | null } |
  { unit: 'utf8_bytes'; bytes: number | null };
export interface ProviderCallSpec { provider: string; model: string; stage: ProviderStage; bounds: ProviderBounds }
export interface ProviderObservation {
  outcome: 'succeeded' | 'failed' | 'interrupted'; providerRequestId: string | null; reportedModel: string | null;
  usage: ProviderUsage; errorCode: string | null;
}
export interface ProviderCallObserver { finish(value: ProviderObservation): void | Promise<void> }
/** Generators supply the exact wire request digest. Optional only for legacy local ledger callers; cloud send gates must reject omission.
 * requestBytes is the exact UTF-8 size of the wire body; meters may use it to tighten token holds. */
export interface ProviderReservation { start(stage: ProviderStage, requestHash?: string, requestBytes?: number): ProviderCallObserver | Promise<ProviderCallObserver>; close(): void | Promise<void> }
export interface ProviderMeter { reserve(calls: ProviderCallSpec[]): ProviderReservation | Promise<ProviderReservation> }
export interface ProviderDeclaration { readonly providerCalls?: 'external' | 'fixture' }

/** The existing local ledger remains synchronous; transports accept both variants and must await every hook. */
export interface SynchronousProviderReservation extends ProviderReservation { start(stage: ProviderStage, requestHash?: string, requestBytes?: number): ProviderCallObserver; close(): void }
export interface SynchronousProviderMeter extends ProviderMeter { reserve(calls: ProviderCallSpec[]): SynchronousProviderReservation }
