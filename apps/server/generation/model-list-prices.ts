/**
 * LIST prices per MILLION tokens in USD, for the usage aggregates (`web_provider_usage`, `pnpm usage:report`). These are what
 * the points will be recalibrated against; they are NOT the upper bounds the budget ledger holds (PROVIDER_PRICES): that
 * ledger charges every token at the dearer of the input/output rate so a hold can never be too small.
 *
 * One USD per million tokens is exactly one micro-USD per token, so a price below is also "micros per token".
 * Peak / standard / 2027 list prices only, never an introductory or off-peak one (sources and dates: docs/PROVIDERS.md):
 *   - DeepSeek: peak rates (off-peak is half), checked 2026-10-15.
 *   - Gemini 3.8 Flash: $0.75 / $0.075 / $3.75 until 2026-12-31, then $1.50 / $0.15 / $7.50 from 2027-01-01 (list).
 *   - Grok 4.7: below 200k prompt tokens (a request above it is never sent, see MAX_REQUEST_BYTES in text-wire.ts).
 * Reasoning/thinking tokens are billed as output and are part of the output count recorded by the generator.
 */
export interface TokenListPrice {
  /** Input, cache miss. */
  readonly input: number;
  /** Input, cache hit. */
  readonly cachedInput: number;
  /** Output, including reasoning/thinking tokens. */
  readonly output: number;
}
export const TOKEN_LIST_PRICES: Readonly<Record<string, TokenListPrice>> = Object.freeze({
  'deepseek:deepseek-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'deepseek:deepseek-v4-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
  'deepseek:deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
  'gemini:gemini-3.8-flash': { input: 1.5, cachedInput: 0.15, output: 7.5 },
  'xai:grok-4.7': { input: 2, cachedInput: 0.5, output: 6 },
});
/** Fish speech s2.1-pro: USD 15 per million UTF-8 bytes. */
export const SPEECH_LIST_MICROS_PER_BYTE = 15;
/**
 * Fish bills Drama 3 per character: USD 10 per million during the launch discount, USD 50 per million after it (docs/PROVIDERS.md).
 * The report costs a byte (never fewer than the characters, so this never understates) at the rate of the UTC day of the call:
 * 10 up to and including 2026-11-12, 50 from 2026-11-13. The budget ledger holds 50 for every Drama 3 byte from the day
 * `renew-prices` installs it (PROVIDER_PRICES).
 */
export const DRAMA3_DISCOUNT_LAST_DAY = '2026-11-12';
export const DRAMA3_LIST_MICROS_PER_BYTE = { discount: 10, list: 50 } as const;
/**
 * Fish speech LIST price per UTF-8 byte (= micro-USD per byte at USD per million bytes) by the model the call was made
 * with and the UTC day ("YYYY-MM-DD") of the call. An unlisted speech model is costed at the s2.1-pro rate, the dearer one
 * of the two before the discount ends.
 */
export const speechListMicrosPerByte = (model: string, day: string): number =>
  model === 'drama-3'
    ? day <= DRAMA3_DISCOUNT_LAST_DAY
      ? DRAMA3_LIST_MICROS_PER_BYTE.discount
      : DRAMA3_LIST_MICROS_PER_BYTE.list
    : SPEECH_LIST_MICROS_PER_BYTE;

/**
 * Cost of one known call at list price, in whole micro-USD, rounded UP (never understated). `cachedInputTokens` is the part of
 * `inputTokens` served from cache (null/absent = none known: the whole input is billed as a miss). A model with no listed
 * price costs 0 here, which the report shows as an unpriced model rather than hiding.
 */
export function listPriceMicros(
  provider: string,
  model: string,
  usage: { inputTokens: number; cachedInputTokens?: number | null; outputTokens: number },
): number {
  const price = TOKEN_LIST_PRICES[`${provider}:${model}`];
  if (!price) return 0;
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens ?? 0));
  return Math.ceil(
    (usage.inputTokens - cached) * price.input + cached * price.cachedInput + usage.outputTokens * price.output,
  );
}
