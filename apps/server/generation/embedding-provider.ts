import { createHash } from 'node:crypto';

/** Memory topics are embedded with one multilingual model; the model and its width are pinned, not configurable. */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
export const EMBEDDING_DIMS = 1024;
/** Workers AI list price: USD 0.0118 per million input tokens, expressed as micro-dollars per million tokens. */
export const EMBEDDING_PRICE_MICROS_PER_MILLION_TOKENS = 11_800;
/** One call carries at most this many texts, each at most this many UTF-8 bytes. */
export const EMBEDDING_MAX_TEXTS = 16;
export const EMBEDDING_MAX_TEXT_BYTES = 4_096;

/**
 * `known` is true only when the provider definitely rejected the request before running it (a 4xx the
 * provider answered, or a binding error that says "not executed"). A timeout, a network error, a 5xx or an
 * unreadable response is NOT known: the call may have run and been billed, so it is never sent again.
 */
export class EmbeddingFailure extends Error {
  readonly code: string;
  readonly known: boolean;
  constructor(code: string, known: boolean) {
    super(code);
    this.name = 'EmbeddingFailure';
    this.code = code;
    this.known = known;
  }
}

export interface EmbeddingResult {
  /** One vector per input text, in input order, each EMBEDDING_DIMS finite numbers. */
  vectors: Float32Array[];
  /** Input tokens the provider reported, or null when it reports none (the estimate is then billed). */
  usageTokens: number | null;
  requestId: string | null;
}

/**
 * `authorize` runs immediately before the bytes leave: the business object re-checks its lease and entitlement
 * there, exactly like the speech send gate. A provider never persists anything.
 */
export interface EmbeddingProvider {
  readonly model: string;
  readonly dims: number;
  embed(
    texts: readonly string[],
    signal: AbortSignal,
    authorize?: () => void | Promise<void>,
  ): Promise<EmbeddingResult>;
}

/** Conservative billing estimate: UTF-8 bytes / 2, rounded up (a token never covers fewer than two bytes here). */
export function estimateEmbeddingTokens(texts: readonly string[]): number {
  let bytes = 0;
  for (const text of texts) bytes += Buffer.byteLength(text, 'utf8');
  return Math.max(1, Math.ceil(bytes / 2));
}

/** Micro-dollars for a token count at the pinned price, rounded up and never zero (a hold must be positive). */
export function embeddingMicros(tokens: number): number {
  return Math.max(1, Math.ceil((tokens * EMBEDDING_PRICE_MICROS_PER_MILLION_TOKENS) / 1_000_000));
}

export function checkEmbeddingInput(texts: readonly string[]) {
  if (
    texts.length < 1 ||
    texts.length > EMBEDDING_MAX_TEXTS ||
    texts.some(
      (text) =>
        typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > EMBEDDING_MAX_TEXT_BYTES,
    )
  )
    throw new EmbeddingFailure('EMBEDDING_INPUT_INVALID', true);
}

/** Validate a provider payload into float32 vectors: right count, right width, finite, not the zero vector. */
export function parseEmbeddingVectors(data: unknown, count: number, dims = EMBEDDING_DIMS): Float32Array[] {
  if (!Array.isArray(data) || data.length !== count) throw new EmbeddingFailure('EMBEDDING_RESPONSE_INVALID', false);
  return data.map((row) => {
    if (!Array.isArray(row) && !ArrayBuffer.isView(row))
      throw new EmbeddingFailure('EMBEDDING_RESPONSE_INVALID', false);
    const values = Float32Array.from(row as ArrayLike<number>);
    let norm = 0;
    for (const value of values) {
      if (!Number.isFinite(value)) throw new EmbeddingFailure('EMBEDDING_RESPONSE_INVALID', false);
      norm += value * value;
    }
    if (values.length !== dims || norm === 0) throw new EmbeddingFailure('EMBEDDING_RESPONSE_INVALID', false);
    return values;
  });
}

function tokenCount(value: unknown): number | null {
  const usage = (value ?? {}) as Record<string, unknown>;
  for (const key of ['prompt_tokens', 'input_tokens', 'total_tokens'])
    if (typeof usage[key] === 'number' && Number.isSafeInteger(usage[key]) && (usage[key] as number) >= 0)
      return usage[key] as number;
  return null;
}

/** Reject when the signal fires: the call may already be running, so the caller records an UNKNOWN outcome. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new EmbeddingFailure('EMBEDDING_ABORTED', false));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new EmbeddingFailure('EMBEDDING_ABORTED', false));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export interface WorkersAiBinding {
  run(model: string, input: unknown): Promise<unknown>;
}

/** (a) The Workers AI `AI` binding on the generation Worker. Only AiError codes that say "not executed" are known. */
export class WorkersAiEmbeddings implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  readonly dims = EMBEDDING_DIMS;
  private readonly ai: WorkersAiBinding;
  constructor(ai: WorkersAiBinding) {
    this.ai = ai;
  }
  async embed(texts: readonly string[], signal: AbortSignal, authorize?: () => void | Promise<void>) {
    checkEmbeddingInput(texts);
    await authorize?.();
    if (signal.aborted) throw new EmbeddingFailure('EMBEDDING_ABORTED', true);
    let output: unknown;
    try {
      output = await abortable(this.ai.run(this.model, { text: [...texts] }), signal);
    } catch (error) {
      if (error instanceof EmbeddingFailure) throw error;
      const message = error instanceof Error ? error.message : '';
      // 3040: capacity temporarily exceeded, 5007: no such model. Both are rejected before any inference.
      if (/\b(3040|5007)\b/.test(message) || /rate.?limit|too many requests/i.test(message))
        throw new EmbeddingFailure('EMBEDDING_PROVIDER_REJECTED', true);
      throw new EmbeddingFailure('EMBEDDING_PROVIDER_ERROR', false);
    }
    const body = (output ?? {}) as { data?: unknown; usage?: unknown };
    return {
      vectors: parseEmbeddingVectors(body.data, texts.length),
      usageTokens: tokenCount(body.usage),
      requestId: null,
    };
  }
}

export interface WorkersAiRestOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
}

/** (b) Workers AI REST API for local provider mode. The token never appears in an error, a log or a receipt. */
export class WorkersAiRestEmbeddings implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  readonly dims = EMBEDDING_DIMS;
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly fetcher: typeof fetch;
  constructor(options: WorkersAiRestOptions) {
    if (!/^[a-f0-9]{32}$/.test(options.accountId) || options.apiToken.trim().length < 20)
      throw new EmbeddingFailure('EMBEDDING_CREDENTIAL_INVALID', true);
    this.accountId = options.accountId;
    this.apiToken = options.apiToken.trim();
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, { ...init, redirect: 'manual' }));
  }
  async embed(texts: readonly string[], signal: AbortSignal, authorize?: () => void | Promise<void>) {
    checkEmbeddingInput(texts);
    await authorize?.();
    if (signal.aborted) throw new EmbeddingFailure('EMBEDDING_ABORTED', true);
    let response: Response;
    try {
      response = await this.fetcher(
        `https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.model}`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${this.apiToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ text: [...texts] }),
          signal,
        },
      );
    } catch {
      throw new EmbeddingFailure(signal.aborted ? 'EMBEDDING_ABORTED' : 'EMBEDDING_NETWORK_ERROR', false);
    }
    if (response.status >= 400 && response.status < 500) {
      await response.body?.cancel().catch(() => {});
      throw new EmbeddingFailure(
        response.status === 429 ? 'EMBEDDING_RATE_LIMITED' : 'EMBEDDING_PROVIDER_REJECTED',
        true,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      await response.body?.cancel().catch(() => {});
      throw new EmbeddingFailure('EMBEDDING_PROVIDER_ERROR', false);
    }
    let body: { success?: boolean; result?: { data?: unknown; usage?: unknown } };
    try {
      body = JSON.parse(await abortable(response.text(), signal));
    } catch (error) {
      throw error instanceof EmbeddingFailure ? error : new EmbeddingFailure('EMBEDDING_RESPONSE_INVALID', false);
    }
    if (body.success === false) throw new EmbeddingFailure('EMBEDDING_PROVIDER_ERROR', false);
    return {
      vectors: parseEmbeddingVectors(body.result?.data, texts.length),
      usageTokens: tokenCount(body.result?.usage),
      requestId: response.headers.get('cf-ray'),
    };
  }
}

/** A unit vector with the given weights on the given axes, normalized; the building block of fixture vectors. */
export function fixtureVector(weights: Record<number, number>, dims = EMBEDDING_DIMS): Float32Array {
  const values = new Float32Array(dims);
  for (const [axis, weight] of Object.entries(weights)) values[Number(axis)] = weight;
  const norm = Math.hypot(...values);
  return norm === 0 ? values : values.map((value) => value / norm);
}

/** Deterministic pseudo-random unit vector derived only from the text (SHA-256 counter stream). */
export function offlineVector(text: string, dims = EMBEDDING_DIMS): Float32Array {
  const values = new Float32Array(dims);
  for (let i = 0; i < dims; i += 8) {
    const block = createHash('sha256').update(`${i}\u0000${text}`).digest();
    for (let j = 0; j < 8 && i + j < dims; j++) values[i + j] = block.readUInt32LE(j * 4) / 0xffffffff - 0.5;
  }
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

export interface OfflineEmbeddingOptions {
  /** Exact text → vector. Unmapped texts get the deterministic offline vector. */
  fixtures?: ReadonlyMap<string, Float32Array>;
  /** Called with the texts of every call that reaches the "network", before it resolves. */
  onCall?: (texts: readonly string[], index: number) => void | Promise<void>;
  /** Scripted outcome of the nth call (0-based); default 'ok'. 'hang' waits for the abort signal. */
  outcome?: (index: number) => 'ok' | 'known' | 'unknown' | 'hang' | 'invalid';
  /** Tokens reported as usage; omit for a provider that reports none. */
  usageTokens?: (texts: readonly string[]) => number | null;
}

/**
 * (c) Offline embedder for tests and controlled-provider runs: deterministic, never touches a network. With
 * `fixtures` it is the fixture embedder that maps chosen sentences to chosen vectors, so a paraphrase test can
 * state exactly which topic should be semantically close to which query.
 */
export class OfflineEmbeddings implements EmbeddingProvider {
  readonly model = EMBEDDING_MODEL;
  readonly dims = EMBEDDING_DIMS;
  readonly calls: string[][] = [];
  private readonly options: OfflineEmbeddingOptions;
  constructor(options: OfflineEmbeddingOptions = {}) {
    this.options = options;
  }
  async embed(texts: readonly string[], signal: AbortSignal, authorize?: () => void | Promise<void>) {
    checkEmbeddingInput(texts);
    await authorize?.();
    if (signal.aborted) throw new EmbeddingFailure('EMBEDDING_ABORTED', true);
    const index = this.calls.length;
    this.calls.push([...texts]);
    await this.options.onCall?.(texts, index);
    const outcome = this.options.outcome?.(index) ?? 'ok';
    if (outcome === 'known') throw new EmbeddingFailure('EMBEDDING_PROVIDER_REJECTED', true);
    if (outcome === 'unknown') throw new EmbeddingFailure('EMBEDDING_PROVIDER_ERROR', false);
    if (outcome === 'hang') await abortable(new Promise<never>(() => {}), signal);
    if (outcome === 'invalid')
      return { vectors: parseEmbeddingVectors([[1]], texts.length), usageTokens: null, requestId: null };
    return {
      vectors: texts.map((text) => this.options.fixtures?.get(text) ?? offlineVector(text)),
      usageTokens: this.options.usageTokens?.(texts) ?? null,
      requestId: `offline-${index}`,
    };
  }
}
