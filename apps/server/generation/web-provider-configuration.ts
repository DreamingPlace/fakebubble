import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import type { verifySelectedVoiceSetup } from './web-provider-materials.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import { WebDispatchLedger } from '../budget/web-dispatch-ledger.ts';
import { DEFAULT_TEXT_MODELS } from '../platform/config.ts';
import { WEB_LIMITS } from '../../../config/web-v1.ts';
import { webConcurrency } from '../../../config/web-concurrency.ts';
import type { WebBudgetPolicy } from '../budget/web-provider-budget-contract.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { PLAYER_MODELS } from '../../../packages/contracts/player-models.ts';

/**
 * Conservative USD upper bounds, in whole micro-dollars per unit (a token is billed at the dearer of its input/output rate).
 * DeepSeek and Fish checked against provider prices on 2026-09-28; xAI and Gemini on 2026-10-15 (docs/PROVIDERS.md).
 * LIST prices only, never an introductory one: Gemini 3.8 Flash is $0.75/$3.75 per million tokens until 2026-12-31 and
 * $1.50/$7.50 from 2027-01-01, so its bound is the 2027 output rate rounded up to 8; Grok 4.7 is $2/$6 below 200k prompt
 * tokens (the $4/$12 tier is impossible: a request over 150000 bytes is refused before it is sent, see text-wire.ts).
 */
export const PROVIDER_PRICES = [
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.draft, phase: 'draft', unit: 'token', upper: 2 },
  { provider: 'deepseek', model: DEFAULT_TEXT_MODELS.review, phase: 'review', unit: 'token', upper: 4 },
  { provider: 'fish', model: 's2.1-pro', phase: 'speech', unit: 'byte', upper: 15 },
  // Drama 3 is billed per CHARACTER: $10/M during the launch discount (until 2026-11-12), $50/M after it. The ledger reserves
  // per UTF-8 byte (never fewer than the characters, so never an understatement) at the list price of $50/M, from the day
  // renew-prices installs it: an ASCII direction is one byte per character, and the date is the owner's, not the code's.
  { provider: 'fish', model: 'drama-3', phase: 'speech', unit: 'byte', upper: 50 },
  { provider: 'xai', model: PLAYER_MODELS.xai.model, phase: 'draft', unit: 'token', upper: 6 },
  { provider: 'gemini', model: PLAYER_MODELS.gemini.model, phase: 'draft', unit: 'token', upper: 8 },
  { provider: 'gemini', model: PLAYER_MODELS.gemini.model, phase: 'review', unit: 'token', upper: 8 },
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
  return store.transaction(() => {
    ensureModelProviders(store, now);
    return PROVIDER_PRICES.map((price): PriceRenewal => {
      const latest = store.get<{ valid_until: number; version: number }>(
        'SELECT valid_until,version FROM web_provider_prices WHERE provider=? AND model=? AND phase=? ORDER BY valid_until DESC LIMIT 1',
        price.provider,
        price.model,
        price.phase,
      );
      const base = { provider: price.provider, model: price.model, phase: price.phase };
      // The row in force today. When its price is not the one the code now holds, a new version takes over FROM NOW (it runs
      // at least as long as the latest row, so the old one never comes back); the old row stays exactly as it was.
      const inForce = store.get<{ upper_micros_per_unit: number }>(
        `SELECT upper_micros_per_unit FROM web_provider_prices
        WHERE provider=? AND model=? AND phase=? AND valid_from<=? AND valid_until>? ORDER BY version DESC LIMIT 1`,
        price.provider,
        price.model,
        price.phase,
        now,
        now,
      );
      const supersede = !!latest && !!inForce && inForce.upper_micros_per_unit !== price.upper;
      if (!supersede && latest && latest.valid_until - now > PRICE_RENEWAL_DUE_MS)
        return { ...base, result: 'not-due', validFrom: null, validUntil: latest.valid_until };
      const validFrom = supersede ? now : latest && latest.valid_until > now ? latest.valid_until : now,
        validUntil = supersede ? Math.max(now + PRICE_RENEWAL_MS, latest!.valid_until) : validFrom + PRICE_RENEWAL_MS,
        id = `${price.provider}-${price.model}-${price.phase}-${validFrom}`;
      if (store.get('SELECT 1 FROM web_provider_prices WHERE id=?', id))
        return { ...base, result: 'duplicate', validFrom, validUntil };
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
        validUntil,
        version: (max?.v ?? 0) + 1,
      });
      return { ...base, result: 'renewed', validFrom, validUntil };
    });
  });
}

/**
 * Part 21b: a provider that appears in PROVIDER_PRICES but was added after the deployment was initialized (xAI, Gemini) has
 * no spending bound and no capacity ticket yet, and a price row cannot reference a provider without them. This creates the
 * missing ones, once, with the SAME bound policy as DeepSeek (unlimited stays unlimited, a test cap stays a cap) and the
 * configured text concurrency. It only adds rows; it never changes one that exists. Before initialization (no DeepSeek
 * spending row) it does nothing and the price step fails as it always did.
 */
function ensureModelProviders(store: WebRuntimeStore, now: number) {
  const reference = store.get<{ limit_micros: number | null }>(
    "SELECT limit_micros FROM web_provider_spending WHERE provider='deepseek'",
  );
  if (!reference) return;
  const ledger = new WebProviderOffline(store, { now: () => now });
  const capacity = new WebDispatchLedger(store, { now: () => now });
  for (const price of PROVIDER_PRICES) {
    if (price.provider === 'deepseek' || price.provider === 'fish') continue;
    if (!store.get('SELECT 1 FROM web_provider_spending WHERE provider=?', price.provider))
      ledger.configureBudget(price.provider, reference.limit_micros);
    if (
      !store.get(
        "SELECT 1 FROM web_external_budgets WHERE provider=? AND stage='text' AND phase=?",
        price.provider,
        price.phase,
      )
    )
      capacity.configureBudget({
        provider: price.provider,
        stage: 'text',
        phase: price.phase,
        capacity: webConcurrency(store).maxTextRunning,
      });
  }
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
    // Part 21b: initialization seeds exactly what it always did. The optional writing models (xAI, Gemini) get their
    // spending bound, capacity ticket and first prices from `renew-prices` (renewProviderPrices), the same step that
    // seeds them on a deployment that was initialized before this Part: a model stays unavailable until that has run.
    for (const price of PROVIDER_PRICES.filter((item) => item.provider === 'deepseek' || item.provider === 'fish'))
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
