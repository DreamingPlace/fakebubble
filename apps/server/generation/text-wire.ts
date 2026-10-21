import { createHash } from 'node:crypto';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { ProviderObservation, ProviderUsage } from '../../../packages/contracts/provider-calls.ts';

/**
 * Wire formats of the text providers (Part 21b). All three speak Chat Completions with one forced function call, so the
 * adapter shape is one: the PROMPT TEXT (messages) and the output tool are identical for every provider and only the
 * envelope below differs. Nothing here may change a prompt or a policy hash; the strict server-side validation of the
 * returned payload stays the source of truth, whatever a provider claims to enforce.
 *
 * Sources and what was and was not confirmed are in docs/PROVIDERS.md.
 */
export type { ModelRef, TextProviderId, TextRoute } from '../../../packages/contracts/text-route.ts';
import type { TextProviderId } from '../../../packages/contracts/text-route.ts';

export const TEXT_ENDPOINTS: Readonly<Record<TextProviderId, string>> = Object.freeze({
  // DeepSeek keeps the endpoint of its pinned policy (text-generation-policy.ts); listed here for hashing only.
  deepseek: 'https://api.deepseek.com/beta/chat/completions',
  xai: 'https://api.x.ai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
});

/**
 * Reasoning tokens bill as OUTPUT, and neither xAI nor Gemini documents a hard cap on them that we could verify. The hold
 * therefore covers the visible reply (policy max_tokens) PLUS this headroom; the same total is sent as the completion
 * limit. DeepSeek runs with thinking disabled, so it has none.
 */
export const REASONING_HEADROOM: Readonly<Record<TextProviderId, number>> = Object.freeze({
  deepseek: 0,
  xai: 12_288,
  gemini: 12_288,
});
/**
 * xAI bills a request with 200k or more prompt tokens at double the rate. A byte-level tokenizer never yields more tokens
 * than bytes, so refusing a body above this size makes the expensive tier impossible without ever sending it.
 */
export const MAX_REQUEST_BYTES: Readonly<Partial<Record<TextProviderId, number>>> = Object.freeze({ xai: 150_000 });

export const outputBound = (provider: TextProviderId, visibleMaxTokens: number) =>
  visibleMaxTokens + REASONING_HEADROOM[provider];

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Gemini accepts an OpenAPI subset: no additionalProperties, no `type: null`, no type arrays. Rewrite exactly those into
 * their nullable form. The rewrite only loosens what the model is told; every payload is still validated strictly here.
 */
export function geminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(geminiSchema);
  if (!isObject(schema)) return schema;
  const { additionalProperties: _drop, strict: _strict, $schema: _dialect, ...rest } = schema;
  const out: Schema = {};
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'properties' && isObject(value))
      out.properties = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, geminiSchema(item)]));
    else if (key === 'items') out.items = geminiSchema(value);
    else if (key !== 'anyOf' && key !== 'type') out[key] = value;
  }
  if (Array.isArray(rest.type)) {
    const kinds = rest.type.filter((kind) => kind !== 'null');
    out.type = kinds[0] ?? 'string';
    if (kinds.length < rest.type.length) out.nullable = true;
  } else if (rest.type === 'null') {
    out.type = 'string';
    out.nullable = true;
  } else if (rest.type !== undefined) out.type = rest.type;
  if (Array.isArray(rest.anyOf)) {
    const branches = rest.anyOf as unknown[];
    const nullable = branches.some((branch) => isObject(branch) && branch.type === 'null');
    const others = branches.filter((branch) => !(isObject(branch) && branch.type === 'null')).map(geminiSchema);
    if (others.length === 1 && isObject(others[0])) Object.assign(out, others[0], nullable ? { nullable: true } : {});
    else if (others.length === 0) Object.assign(out, { type: 'string', nullable: true });
    else {
      out.anyOf = others;
      if (nullable) out.nullable = true;
    }
  }
  return out;
}

export interface WireInput {
  model: string;
  messages: unknown;
  tool: { type: 'function'; function: { name: string; description: string; strict: boolean; parameters: unknown } };
  /** Visible reply limit from the pinned policy. */
  maxTokens: number;
  /** Stable hash of the conversation scope, never the scope itself. */
  user: string;
}
/** The exact JSON body for xAI or Gemini. DeepSeek's body is built by deepseek.ts from its pinned policy, unchanged. */
export function chatBody(provider: Exclude<TextProviderId, 'deepseek'>, input: WireInput): string {
  const limit = outputBound(provider, input.maxTokens);
  const name = input.tool.function.name;
  const toolChoice = { type: 'function', function: { name } };
  if (provider === 'xai')
    return JSON.stringify({
      model: input.model,
      messages: input.messages,
      tools: [input.tool],
      tool_choice: toolChoice,
      stream: false,
      max_completion_tokens: limit,
      reasoning_effort: 'low',
      user: input.user,
    });
  const tool = {
    type: 'function',
    function: { ...input.tool.function, strict: undefined, parameters: geminiSchema(input.tool.function.parameters) },
  };
  return JSON.stringify({
    model: input.model,
    messages: input.messages,
    tools: [tool],
    tool_choice: toolChoice,
    stream: false,
    max_tokens: limit,
    reasoning_effort: 'low',
  });
}

const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000_000;
const record = (value: unknown): Record<string, unknown> => (isObject(value) ? value : {});

/**
 * Billable usage of a chat completion. Output is total minus prompt, which includes reasoning/thinking tokens whether a
 * provider reports them inside completion_tokens or beside it; a response whose numbers do not add up has NO usage (and
 * the call stays UNKNOWN). DeepSeek keeps its exact historical rule (prompt + completion == total).
 */
export function chatUsage(provider: TextProviderId, value: unknown): ProviderUsage & { unit: 'tokens' } {
  const usage = record(record(value).usage);
  const input = usage.prompt_tokens,
    completion = usage.completion_tokens,
    total = usage.total_tokens;
  const consistent =
    count(input) &&
    count(completion) &&
    count(total) &&
    (provider === 'deepseek'
      ? input + completion === total
      : total >= input + completion && total - input <= 1_000_000);
  const inputTokens = consistent ? input : null;
  const outputTokens = consistent ? total - input : null;
  let hit: unknown, miss: unknown;
  if (provider === 'deepseek') {
    hit = usage.prompt_cache_hit_tokens;
    miss = usage.prompt_cache_miss_tokens;
  } else {
    hit = record(usage.prompt_tokens_details).cached_tokens;
    miss = hit !== undefined && count(hit) && count(input) ? input - hit : undefined;
  }
  const valid =
    inputTokens !== null &&
    (hit == null || (count(hit) && hit <= inputTokens)) &&
    (miss == null || (count(miss) && miss <= inputTokens)) &&
    (hit == null || miss == null || Number(hit) + Number(miss) === inputTokens);
  return {
    unit: 'tokens',
    inputTokens,
    outputTokens,
    cacheHitInputTokens: valid && count(hit) ? hit : null,
    cacheMissInputTokens: valid && count(miss) ? miss : null,
  };
}
export function chatObservation(
  provider: TextProviderId,
  value: unknown,
  outcome: ProviderObservation['outcome'],
  errorCode: string | null,
): ProviderObservation {
  const v = record(value);
  return {
    outcome,
    errorCode,
    usage: chatUsage(provider, v),
    providerRequestId: typeof v.id === 'string' && /^[A-Za-z0-9_.:-]{1,256}$/.test(v.id) ? v.id : null,
    reportedModel: typeof v.model === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(v.model) ? v.model : null,
  };
}

const PREFIX: Record<TextProviderId, string> = { deepseek: 'DEEPSEEK', xai: 'XAI', gemini: 'GEMINI' };
const NOT_ALLOWED = String.raw`(?:not\s+(?:supported|available|allowed)|unsupported|restricted|blocked)`;
const PLACE = String.raw`(?:location|region|country|territor\w*)`;
const REGION = new RegExp(`${PLACE}[^.]{0,80}${NOT_ALLOWED}|${NOT_ALLOWED}[^.]{0,80}${PLACE}`, 'i');

/**
 * Failure codes by HTTP status. The suffixes decide billing certainty (see NOT_BILLED below). `text` is the start of an
 * error body, read only to recognise the documented "location/region not supported" answer.
 */
export function statusFailure(provider: TextProviderId, status: number, text = ''): string {
  const p = PREFIX[provider];
  if (REGION.test(text) && (status === 400 || status === 403 || status === 451)) return `${p}_REGION_UNSUPPORTED`;
  if (status === 401) return `${p}_AUTH_FAILED`;
  if (status === 402) return `${p}_BALANCE_REQUIRED`;
  if (status === 429) return `${p}_RATE_LIMITED`;
  // 503 is the documented "overloaded / temporarily unavailable" answer (DeepSeek, Gemini). xAI documents none we could
  // verify, so its 503 stays an ordinary server error (UNKNOWN).
  if (status === 503 && provider !== 'xai') return `${p}_OVERLOADED`;
  return status >= 500 ? `${p}_UNAVAILABLE` : `${p}_REQUEST_REJECTED`;
}

/**
 * Codes that prove the provider did NOT run (and so did not bill) the request. Only these may be retried on the next model.
 * Everything else after a possible send (timeout, reset, 5xx, unparseable) is UNKNOWN: never retried, never released.
 */
export const NOT_BILLED_CODES: ReadonlySet<string> = new Set([
  'MODEL_UNAVAILABLE',
  'MODEL_REQUEST_TOO_LARGE',
  'PROVIDER_CONNECT_FAILED',
  ...(['DEEPSEEK', 'XAI', 'GEMINI'] as const).flatMap((p) => [
    `${p}_RATE_LIMITED`,
    `${p}_REGION_UNSUPPORTED`,
    `${p}_AUTH_FAILED`,
    `${p}_BALANCE_REQUIRED`,
  ]),
  'DEEPSEEK_OVERLOADED',
  'GEMINI_OVERLOADED',
]);
export const isNotBilled = (code: string | null | undefined) => typeof code === 'string' && NOT_BILLED_CODES.has(code);
/** True for the answers that were never sent to the provider at all (no key, body too large): no ledger work is needed. */
export const isPreSend = (code: string) => code === 'MODEL_UNAVAILABLE' || code === 'MODEL_REQUEST_TOO_LARGE';

const CONNECT_CODES = new Set(['ENOTFOUND', 'ECONNREFUSED', 'EAI_AGAIN']);
/** A fetch rejection that proves the connection never opened (so nothing was sent). Anything else stays ambiguous. */
export function connectFailure(error: unknown): DomainError | null {
  const cause = record(record(error).cause);
  return typeof cause.code === 'string' && CONNECT_CODES.has(cause.code)
    ? new DomainError('PROVIDER_CONNECT_FAILED')
    : null;
}

/** Stable per-scope hash for providers that take an end-user id. */
export const scopeUser = (parts: readonly string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
