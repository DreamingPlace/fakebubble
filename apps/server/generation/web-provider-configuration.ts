import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import type { verifySelectedVoiceSetup } from './web-provider-materials.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { WebDispatchLedger } from '../budget/web-dispatch-ledger.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { WebBudgetPolicy } from '../budget/web-provider-budget-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/** Conservative USD upper bounds, checked against provider prices on 2026-09-28. */
export const PROVIDER_PRICES = [
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.draft, phase: 'draft', unit: 'token', upper: 2 },
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.review, phase: 'review', unit: 'token', upper: 4 },
  { provider: 'fish', model: 's2.1-pro', phase: 'speech', unit: 'byte', upper: 15 },
  // Drama 3 lists at $10/M characters, but an unrecognised model header silently serves s2.1-pro, so the ledger reserves
  // the s2.1 upper bound.
  { provider: 'fish', model: 'drama-3', phase: 'speech', unit: 'byte', upper: 15 },
] as const;
export const PROVIDER_LIMIT_MICROS = 3_000_000;
const PRICE_VALID_MS = 30 * 86_400_000;
const DAY_MS = 86_400_000;
export const PRICE_RENEWAL_MS = 90 * DAY_MS;
/** A latest row that still runs this far into the future is not renewed. */
export const PRICE_RENEWAL_DUE_MS = 60 * DAY_MS;

export interface PriceRenewal {
  provider: string;
  model: string;
  phase: string;
  /** `renewed` appended a row; `not-due` left the latest row alone; `duplicate` found the derived row id already stored. */
  result: 'renewed' | 'not-due' | 'duplicate';
  validFrom: number | null;
  validUntil: number;
}

/**
 * Appends one contiguous 90-day row per current price entry. Rows already stored are never touched: the new row starts
 * where the latest one ends (or now, when there is none or it has expired) so rows never overlap, and its id is derived
 * from (provider, model, phase, valid_from) so a retry cannot add a second row.
 */
export function renewProviderPrices(store: WebRuntimeStore, now: number): PriceRenewal[] {
  const ledger = new WebProviderOffline(store, { now: () => now });
  return store.transaction(() =>
    PROVIDER_PRICES.map((price): PriceRenewal => {
      const latest = store.get<{ valid_until: number; version: number }>(
        'SELECT valid_until,version FROM web_provider_prices WHERE provider=? AND model=? AND phase=? ORDER BY valid_until DESC LIMIT 1',
        price.provider,
        price.model,
        price.phase,
      );
      const base = { provider: price.provider, model: price.model, phase: price.phase };
      if (latest && latest.valid_until - now > PRICE_RENEWAL_DUE_MS)
        return { ...base, result: 'not-due', validFrom: null, validUntil: latest.valid_until };
      const validFrom = latest && latest.valid_until > now ? latest.valid_until : now,
        id = `${price.provider}-${price.model}-${price.phase}-${validFrom}`;
      if (store.get('SELECT 1 FROM web_provider_prices WHERE id=?', id))
        return { ...base, result: 'duplicate', validFrom, validUntil: validFrom + PRICE_RENEWAL_MS };
      const max = store.get<{ v: number | null }>(
        'SELECT MAX(version) v FROM web_provider_prices WHERE provider=? AND model=? AND phase=?',
        price.provider,
        price.model,
        price.phase,
      );
      ledger.configurePrice({
        id,
        ...base,
        phase: price.phase,
        currency: 'USD',
        unit: price.unit,
        upperMicrosPerUnit: price.upper,
        validFrom,
        validUntil: validFrom + PRICE_RENEWAL_MS,
        version: (max?.v ?? 0) + 1,
      });
      return { ...base, result: 'renewed', validFrom, validUntil: validFrom + PRICE_RENEWAL_MS };
    }),
  );
}

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
        id: `${price.provider}-${price.model}-${price.phase}-${now}`,
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
      capacity: webConcurrency(store).maxTextRunning,
    });
    capacity.configureBudget({
      provider: 'deepseek',
      stage: 'text',
      phase: 'review',
      capacity: webConcurrency(store).maxTextRunning,
    });
    capacity.configureBudget({
      provider: 'fish',
      stage: 'audio',
      phase: 'speech',
      capacity: webConcurrency(store).maxAudioRunning,
    });
  });
}
