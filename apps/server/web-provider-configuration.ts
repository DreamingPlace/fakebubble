import type { WebRuntimeStore } from './web-store-contract.ts';
import type { verifySelectedVoiceSetup } from './web-provider-materials.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { WebDispatchLedger } from './web-dispatch-ledger.ts';
import { DEFAULT_TEXT_MODELS } from './config.ts';
import { WEB_LIMITS } from '../../config/web-v1.ts';
import type { WebBudgetPolicy } from './web-provider-budget-contract.ts';
import { ensure } from '../../packages/domain/errors.ts';

/** Conservative USD upper bounds, checked against provider prices on 2026-09-28. */
export const PROVIDER_PRICES = [
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.draft, phase: 'draft', unit: 'token', upper: 2 },
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.review, phase: 'review', unit: 'token', upper: 4 },
  { provider: 'fish', model: 's2.1-pro', phase: 'speech', unit: 'byte', upper: 15 },
] as const;
export const PROVIDER_LIMIT_MICROS = 3_000_000;
const PRICE_VALID_MS = 30 * 86_400_000;

/** Local instance ceilings are not spending authorization; live calls also need the shared ledger. */
export function configureWebProvider(
  store: WebRuntimeStore,
  selected: ReturnType<typeof verifySelectedVoiceSetup>,
  now: number,
  policy: WebBudgetPolicy = 'test-cumulative',
) {
  ensure(policy === 'test-cumulative' || policy === 'production-unlimited', 'WEB_PROVIDER_BUDGET_INVALID');
  store.transaction(() => {
    const clock = { now: () => now },
      ledger = new WebProviderOffline(store, clock);
    for (const item of selected)
      ledger.configureSelectedVoice({
        characterId: item.characterId,
        voiceVersion: item.voice.voiceVersion,
        voiceRevision: item.voice.revision,
        profileId: item.voice.profileId,
        referenceId: item.voice.referenceId,
        model: item.voice.model,
        evidence: item.evidence as unknown as Record<string, string>,
      });
    for (const provider of ['deepseek', 'fish'])
      ledger.configureBudget(provider, policy === 'production-unlimited' ? null : PROVIDER_LIMIT_MICROS);
    for (const price of PROVIDER_PRICES)
      ledger.configurePrice({
        id: `${price.provider}-${price.phase}-${now}`,
        provider: price.provider,
        model: price.model,
        phase: price.phase,
        currency: 'USD',
        unit: price.unit,
        upperMicrosPerUnit: price.upper,
        validFrom: now,
        validUntil: now + PRICE_VALID_MS,
        version: 1,
      });
    const capacity = new WebDispatchLedger(store, clock);
    // UNKNOWN calls retain their ticket; use the configured stage limits, not one global ticket.
    capacity.configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase: 'draft',
      capacity: WEB_LIMITS.maxTextRunning,
    });
    capacity.configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase: 'review',
      capacity: WEB_LIMITS.maxTextRunning,
    });
    capacity.configureBudget({
      provider: 'fish',
      stage: 'audio',
      phase: 'speech',
      capacity: WEB_LIMITS.maxAudioRunning,
    });
  });
}
