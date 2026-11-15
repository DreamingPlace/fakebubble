import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { DeepSeekTextGenerator } from '../../apps/server/generation/deepseek.ts';
import { TextGenerationFailure } from '../../apps/server/generation/text-generation-error.ts';
import { WRITER_V8_PROMPT_SHA256, writerPromptBytesHash } from '../../apps/server/generation/writer-v8.ts';
import { FishAudio, fishSpeechRequest } from '../audio/fish.ts';
import { SpeechFailure } from '../audio/validation-error.ts';
import type { AcceptedV7StageOutput, TextGenerationRequest } from '../../packages/contracts/index.ts';
import type { ProviderMeter } from '../../packages/contracts/provider-calls.ts';
import type { TextRoute } from '../../packages/contracts/text-route.ts';
import type {
  WebEmbedRPCResult,
  WebCompleteRPCResult,
  WebCompleteWire,
  WebEmbedWire,
  WebGenerationSession,
  WebJudgeRPCResult,
  WebJudgeWire,
  WebKnownDraft,
  WebSpeechWire,
} from '../../packages/contracts/web-generation-rpc.ts';
import {
  EMBEDDING_MODEL,
  EmbeddingFailure,
  WorkersAiEmbeddings,
  type WorkersAiBinding,
} from '../../apps/server/generation/embedding-provider.ts';
import {
  CLIP_DIRECTION_PROMPT,
  CLIP_DIRECTION_PROMPT_SHA256,
  clipPromptHash,
} from '../../apps/server/characters/clip-direction-prompt.ts';
import {
  REHEARSAL_JUDGE_MODELS,
  REHEARSAL_JUDGE_PROMPTS,
  promptHash,
} from '../../apps/server/characters/web-rehearsal-prompts.ts';
import type { TextRPCResult, SpeechRPCResult } from '../../packages/contracts/generation-rpc.ts';

export interface WebGenerationEnvironment {
  EXTERNAL_CALLS?: string;
  DEEPSEEK_API_KEY: string;
  FISH_API_KEY: string;
  /** Part 21b: optional writing models. A missing key makes that model unavailable (the reply goes to the backup), never a crash. */
  XAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  /** Workers AI binding for memory embeddings; used only when EMBEDDINGS_ENABLED is 'true'. */
  AI?: WorkersAiBinding;
  EMBEDDINGS_ENABLED?: string;
}
// Workers rejects redirect:'error' before dispatch. Manual mode preserves the
// adapters' fail-closed non-2xx checks without forwarding credentials elsewhere.
const providerFetch: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'manual' });
const safeCode = (error: unknown) => (error instanceof DomainError ? error.code : 'GENERATION_SERVICE_FAILED');
async function callback<T>(work: () => T | Promise<T>) {
  try {
    return await work();
  } catch (error) {
    throw new DomainError(
      error instanceof Error && /^[A-Z][A-Z0-9_]{0,80}$/.test(error.message)
        ? error.message
        : 'WEB_GENERATION_CALLBACK_FAILED',
    );
  }
}

/** Provider keys only: no database, bucket or budget binding. Every session is single-use. */
export class WebIsolatedGenerationSession extends RpcTarget implements WebGenerationSession {
  private readonly controller = new AbortController();
  private started = false;
  private readonly env: WebGenerationEnvironment;
  private readonly fetcher: typeof fetch;
  constructor(env: WebGenerationEnvironment, fetcher: typeof fetch = providerFetch) {
    super();
    this.env = env;
    this.fetcher = fetcher;
  }
  private begin() {
    ensure(this.env.EXTERNAL_CALLS === 'true', 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    ensure(!this.started && !this.controller.signal.aborted, 'GENERATION_SESSION_CLOSED');
    this.started = true;
  }
  async cancel() {
    this.controller.abort();
  }
  [Symbol.dispose]() {
    this.controller.abort();
  }
  async text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    route?: TextRoute,
  ): Promise<TextRPCResult> {
    try {
      this.begin();
      const text = new DeepSeekTextGenerator({
        apiKey: this.env.DEEPSEEK_API_KEY,
        fetch: this.fetcher,
        keys: { xai: this.env.XAI_API_KEY, gemini: this.env.GEMINI_API_KEY },
      });
      // Part 37a: a v8 request rides this same route. The Worker builds the v8 prompts from its own bundle and runs them only if
      // the bytes hash to the pin (WEB_WRITER_PIN_MISMATCH); an older Worker ignores `writer`, computes the v7 policy hash and
      // refuses the v8 one (WEB_PROVIDER_WIRE_MISMATCH), so nothing is sent.
      if (request.writer === 'v8')
        ensure(writerPromptBytesHash() === WRITER_V8_PROMPT_SHA256, 'WEB_WRITER_PIN_MISMATCH');
      ensure(text.policyHashFor(request) === policyHash, 'WEB_PROVIDER_WIRE_MISMATCH');
      const remote: ProviderMeter = {
        reserve: (specs) =>
          callback(async () => {
            const reservation = await meter.reserve(specs);
            return {
              start: (stage, hash, bytes) =>
                callback(async () => {
                  const observer = await reservation.start(stage, hash, bytes);
                  return {
                    finish: (value) => callback(() => observer.finish(value)),
                    // Best effort: sent synchronously (calls on one RPC stub arrive in order, so the business side
                    // sees it before finish()) but never awaited, so it cannot delay finish() or change the bill.
                    rejected: (output) => {
                      try {
                        Promise.resolve(observer.rejected?.(output)).catch(() => {});
                      } catch {
                        /* diagnosis only */
                      }
                    },
                  };
                }),
              close: () => callback(() => reservation.close()),
            };
          }),
      };
      const confirmed = (stage: AcceptedV7StageOutput) => callback(() => accept(stage));
      const value = known
        ? await text.generateAcceptedReviewFromKnownDraft(
            request,
            this.controller.signal,
            known,
            confirmed,
            remote,
            route,
          )
        : await text.generateAcceptedStages(request, this.controller.signal, confirmed, remote, route);
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        code: safeCode(error),
        generation: error instanceof TextGenerationFailure ? error.generation : null,
      };
    }
  }
  async speech(wire: WebSpeechWire, authorize: () => Promise<void>): Promise<SpeechRPCResult> {
    try {
      this.begin();
      wire = structuredClone(wire);
      const prepared = fishSpeechRequest(wire.speech, wire.model);
      ensure(
        prepared.body === wire.body &&
          prepared.requestHash === wire.wireRequestHash &&
          prepared.bytes === wire.billedTextBytes,
        'WEB_PROVIDER_WIRE_MISMATCH',
      );
      const meter: ProviderMeter = {
        reserve: (specs) => {
          ensure(
            specs.length === 1 &&
              specs[0]!.provider === 'fish' &&
              specs[0]!.stage === 'speech' &&
              specs[0]!.model === wire.model,
            'WEB_PROVIDER_WIRE_MISMATCH',
          );
          return {
            start: async (stage, hash) => {
              ensure(stage === 'speech' && hash === wire.wireRequestHash, 'WEB_PROVIDER_WIRE_MISMATCH');
              await callback(authorize);
              ensure(!this.controller.signal.aborted, 'AUDIO_REQUEST_ABORTED');
              return { finish() {} };
            },
            close() {},
          };
        },
      };
      const value = await new FishAudio({
        apiKey: this.env.FISH_API_KEY,
        model: wire.model,
        fetch: this.fetcher,
      }).generate(wire.speech, this.controller.signal, meter);
      ensure(
        value.inputUTF8Bytes === wire.billedTextBytes && value.model === wire.model,
        'WEB_PROVIDER_USAGE_MISMATCH',
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: safeCode(error), generation: error instanceof SpeechFailure ? error.generation : null };
    }
  }
  /**
   * Part 30: one plain completion on the draft model, for the clip-direction rewrite ONLY. The system prompt must be the pinned
   * text (compared byte for byte AND by hash); any other prompt is refused before anything is sent, so this route cannot be used
   * to run arbitrary text through the DeepSeek key. The business object has reserved the budget and passes the send gate.
   */
  async complete(wire: WebCompleteWire, authorize: () => Promise<void>): Promise<WebCompleteRPCResult> {
    try {
      this.begin();
      wire = structuredClone(wire);
      ensure(
        wire.system === CLIP_DIRECTION_PROMPT &&
          wire.systemSha256 === CLIP_DIRECTION_PROMPT_SHA256 &&
          clipPromptHash(wire.system) === CLIP_DIRECTION_PROMPT_SHA256 &&
          typeof wire.user === 'string' &&
          wire.user.length > 0 &&
          wire.user.length <= 4000 &&
          Number.isSafeInteger(wire.maxTokens) &&
          wire.maxTokens > 0 &&
          wire.maxTokens <= 1000,
        'WEB_PROVIDER_WIRE_MISMATCH',
      );
      const text = new DeepSeekTextGenerator({
        apiKey: this.env.DEEPSEEK_API_KEY,
        fetch: this.fetcher,
      });
      const value = await text.completePlain(
        { system: wire.system, user: wire.user, maxTokens: wire.maxTokens },
        this.controller.signal,
        () => callback(authorize),
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: safeCode(error) };
    }
  }
  /**
   * Part 35: one judge completion for 多轮预演. Only a pinned judge prompt (its exact text and hash) and only a house reviewer model
   * run; arbitrary text never reaches the DeepSeek key. The business object has reserved the budget and passes the send gate.
   */
  async judge(wire: WebJudgeWire, authorize: () => Promise<void>): Promise<WebJudgeRPCResult> {
    try {
      this.begin();
      wire = structuredClone(wire);
      ensure(
        typeof wire.system === 'string' &&
          REHEARSAL_JUDGE_PROMPTS[wire.systemSha256] === wire.system &&
          promptHash(wire.system) === wire.systemSha256 &&
          REHEARSAL_JUDGE_MODELS.includes(wire.model) &&
          typeof wire.user === 'string' &&
          wire.user.length > 0 &&
          wire.user.length <= 20000 &&
          Number.isSafeInteger(wire.maxTokens) &&
          wire.maxTokens > 0 &&
          wire.maxTokens <= 1000,
        'WEB_PROVIDER_WIRE_MISMATCH',
      );
      const text = new DeepSeekTextGenerator({
        apiKey: this.env.DEEPSEEK_API_KEY,
        fetch: this.fetcher,
      });
      const value = await text.completePlain(
        { system: wire.system, user: wire.user, maxTokens: wire.maxTokens, model: wire.model },
        this.controller.signal,
        () => callback(authorize),
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, code: safeCode(error) };
    }
  }
  /** One bge-m3 call. The business object has already reserved budget; it stores the vectors this returns. */
  async embed(wire: WebEmbedWire, authorize: () => Promise<void>): Promise<WebEmbedRPCResult> {
    let gate: unknown;
    let crossed = false;
    try {
      this.begin();
      ensure(this.env.EMBEDDINGS_ENABLED === 'true' && this.env.AI, 'WEB_EMBEDDINGS_DISABLED');
      wire = structuredClone(wire);
      ensure(wire.model === EMBEDDING_MODEL && Array.isArray(wire.texts), 'WEB_PROVIDER_WIRE_MISMATCH');
      const result = await new WorkersAiEmbeddings(this.env.AI).embed(wire.texts, this.controller.signal, async () => {
        try {
          await callback(authorize);
        } catch (error) {
          gate = error;
          throw error;
        }
        crossed = true;
      });
      return {
        ok: true,
        value: {
          vectors: result.vectors.map((vector) => Array.from(vector)),
          usageTokens: result.usageTokens,
          requestId: result.requestId,
        },
      };
    } catch (error) {
      // A refused gate or a disabled/misconfigured Worker means nothing was sent; only a provider answer decides the rest.
      if (gate !== undefined) return { ok: false, code: safeCode(gate), known: true };
      if (error instanceof EmbeddingFailure) return { ok: false, code: error.code, known: error.known };
      return { ok: false, code: safeCode(error), known: !crossed };
    }
  }
}
export class WebGenerationService extends WorkerEntrypoint<WebGenerationEnvironment> {
  open() {
    ensure(this.env.EXTERNAL_CALLS === 'true', 'WEB_PROVIDER_LIVE_OPT_IN_REQUIRED');
    return new WebIsolatedGenerationSession(this.env);
  }
  /** Presence of the optional text-provider keys, as booleans: the keys themselves never leave this Worker. */
  modelKeys() {
    return { xai: !!this.env.XAI_API_KEY?.trim(), gemini: !!this.env.GEMINI_API_KEY?.trim() };
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
