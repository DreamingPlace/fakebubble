import { WorkerEntrypoint, RpcTarget } from 'cloudflare:workers';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { DeepSeekTextGenerator } from '../../apps/server/generation/deepseek.ts';
import { TextGenerationFailure } from '../../apps/server/generation/text-generation-error.ts';
import { WRITER_V8_PROMPT_SHA256, writerPromptBytesHash } from '../../apps/server/generation/writer-v8.ts';
import { WRITER_PROFILE_SHA256, writerProfileHash } from '../../apps/server/generation/writer-profile.ts';
import { WRITER_MEMES_SHA256, writerMemesHash } from '../../apps/server/generation/writer-memes.ts';
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
  WebEmbedJob,
  WebSpeechJob,
  WebStageRun,
  WebTextJob,
  WebTextRun,
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
  COCREATION_TIDY_PROMPT,
  COCREATION_TIDY_PROMPT_SHA256,
  cocreationTidyHash,
} from '../../apps/server/cocreation/web-cocreation-tidy-prompt.ts';
import {
  COCREATION_WORDINGS_PROMPT,
  COCREATION_WORDINGS_PROMPT_SHA256,
  cocreationWordingsHash,
} from '../../apps/server/cocreation/web-cocreation-wordings-prompt.ts';
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
      // Part 37b: a 新+档案 request also needs this file's words and rules to hash to their own pin.
      if (request.writerProfile === true)
        ensure(writerProfileHash() === WRITER_PROFILE_SHA256, 'WEB_WRITER_PIN_MISMATCH');
      // Part 37c-1: a 新+档案+梗 request also needs the meme words and the selection rules to hash to their own pin.
      if (request.writerMemes === true) ensure(writerMemesHash() === WRITER_MEMES_SHA256, 'WEB_WRITER_PIN_MISMATCH');
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
  /**
   * Part 54: the reply's text stages as ONE call with ONE result. No function or stub crosses the boundary: the business object
   * reserved the money for every stage before calling (`job.stages` are the limits it reserved against) and settles from the
   * returned per-stage record afterwards. This method never waits for the business object, and every provider call in it
   * carries its own timeout (`job.callTimeoutMs`, below the stage lease and the RPC limit), so it always RETURNS: a call that
   * could not be observed is reported as started-without-observation (UNKNOWN to the caller), never as a hang.
   */
  async runText(job: WebTextJob): Promise<WebTextRun> {
    const phases = ['draft', 'review'] as const;
    const starts = new Map<string, { hash: string; bytes: number }>();
    const observations = new Map<string, import('../../packages/contracts/provider-calls.ts').ProviderObservation>();
    const accepted = new Map<string, AcceptedV7StageOutput>();
    const rejected = new Map<string, { raw: string; errorCode: string }>();
    const stages = (): WebTextRun['stages'] => {
      const one = (phase: (typeof phases)[number]): WebStageRun => {
        const started = starts.get(phase);
        return started
          ? {
              state: 'started',
              wireRequestHash: started.hash,
              requestBytes: started.bytes,
              observation: observations.get(phase) ?? null,
              accepted: accepted.get(phase) ?? null,
              rejected: rejected.get(phase) ?? null,
            }
          : { state: 'not_sent' };
      };
      return { draft: one('draft'), review: one('review') };
    };
    try {
      this.begin();
      job = structuredClone(job);
      ensure(
        job &&
          typeof job.reservationId === 'string' &&
          job.reservationId.length > 0 &&
          job.reservationId.length <= 256 &&
          Number.isSafeInteger(job.callTimeoutMs) &&
          job.callTimeoutMs >= 1 &&
          job.callTimeoutMs <= 60_000 &&
          job.stages?.review &&
          (job.known ? job.stages.draft === null : job.stages.draft !== null),
        'WEB_PROVIDER_WIRE_MISMATCH',
      );
      const request = job.request;
      const text = new DeepSeekTextGenerator({
        apiKey: this.env.DEEPSEEK_API_KEY,
        fetch: this.fetcher,
        keys: { xai: this.env.XAI_API_KEY, gemini: this.env.GEMINI_API_KEY },
        callTimeoutMs: job.callTimeoutMs,
      });
      if (request.writer === 'v8')
        ensure(writerPromptBytesHash() === WRITER_V8_PROMPT_SHA256, 'WEB_WRITER_PIN_MISMATCH');
      if (request.writerProfile === true)
        ensure(writerProfileHash() === WRITER_PROFILE_SHA256, 'WEB_WRITER_PIN_MISMATCH');
      if (request.writerMemes === true) ensure(writerMemesHash() === WRITER_MEMES_SHA256, 'WEB_WRITER_PIN_MISMATCH');
      ensure(text.policyHashFor(request) === job.policyHash, 'WEB_PROVIDER_WIRE_MISMATCH');
      // The route is data from the business object, one model per stage. A longer chain is refused: the second model would
      // need a reservation this call does not have.
      if (job.route)
        ensure(
          phases.every((phase) => job.route![phase].length === 1) &&
            phases.every(
              (phase) =>
                job.stages[phase] === null ||
                (job.route![phase][0]!.provider === job.stages[phase]!.provider &&
                  job.route![phase][0]!.model === job.stages[phase]!.model),
            ),
          'WEB_PROVIDER_STAGE_INVALID',
        );
      const meter: ProviderMeter = {
        reserve: (calls) => {
          for (const call of calls) {
            const limit = (call.stage === 'draft' || call.stage === 'review') && job.stages[call.stage];
            ensure(
              limit &&
                call.provider === limit.provider &&
                call.model === limit.model &&
                call.bounds.unit === 'tokens' &&
                call.bounds.outputTokens <= limit.outputTokens,
              'WEB_PROVIDER_STAGE_INVALID',
            );
          }
          return {
            start: (stage, hash, bytes) => {
              ensure(
                (stage === 'draft' || stage === 'review') &&
                  !starts.has(stage) &&
                  // The hold was sized from the request: a body larger than it is refused BEFORE anything is sent.
                  Number.isSafeInteger(bytes) &&
                  bytes! <= job.stages[stage]!.inputTokens &&
                  typeof hash === 'string' &&
                  /^[a-f0-9]{64}$/.test(hash) &&
                  Number.isSafeInteger(bytes) &&
                  bytes! > 0,
                'WEB_PROVIDER_STAGE_INVALID',
              );
              starts.set(stage, { hash, bytes: bytes! });
              return {
                finish: (value) => {
                  observations.set(stage, value);
                },
                rejected: (output) => {
                  if (typeof output?.raw === 'string' && typeof output.errorCode === 'string')
                    rejected.set(stage, { raw: output.raw, errorCode: output.errorCode });
                },
              };
            },
            close() {},
          };
        },
      };
      const collect = async (stage: AcceptedV7StageOutput) => {
        accepted.set(stage.stage, structuredClone(stage));
      };
      const value = job.known
        ? await text.generateAcceptedReviewFromKnownDraft(
            request,
            this.controller.signal,
            job.known,
            collect,
            meter,
            job.route,
          )
        : await text.generateAcceptedStages(request, this.controller.signal, collect, meter, job.route);
      return { stages: stages(), result: { ok: true, value } };
    } catch (error) {
      return {
        stages: stages(),
        result: {
          ok: false,
          code: safeCode(error),
          generation: error instanceof TextGenerationFailure ? error.generation : null,
        },
      };
    }
  }
  async speech(
    wire: WebSpeechWire,
    authorize: () => Promise<void>,
    timeoutMs?: number,
  ): Promise<SpeechRPCResult> {
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
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
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
   * Part 30 (and 39): one plain completion on the draft model, for the clip-direction rewrite and the co-creation 整理 ONLY. The system prompt must be the pinned
   * text (compared byte for byte AND by hash); any other prompt is refused before anything is sent, so this route cannot be used
   * to run arbitrary text through the DeepSeek key. The business object has reserved the budget and passes the send gate.
   */
  async complete(wire: WebCompleteWire, authorize: () => Promise<void>): Promise<WebCompleteRPCResult> {
    try {
      this.begin();
      wire = structuredClone(wire);
      // Part 39: two pinned prompts only - the clip direction and the co-creation 整理 (each by its exact text AND hash).
      const pinned =
        (wire.system === CLIP_DIRECTION_PROMPT &&
          wire.systemSha256 === CLIP_DIRECTION_PROMPT_SHA256 &&
          clipPromptHash(wire.system) === CLIP_DIRECTION_PROMPT_SHA256) ||
        (wire.system === COCREATION_TIDY_PROMPT &&
          wire.systemSha256 === COCREATION_TIDY_PROMPT_SHA256 &&
          cocreationTidyHash(wire.system) === COCREATION_TIDY_PROMPT_SHA256);
      // Part 39b: the wording pool's 生成 is the third pinned prompt; its answer is longer, so it alone may ask for more output.
      const wordings =
        wire.system === COCREATION_WORDINGS_PROMPT &&
        wire.systemSha256 === COCREATION_WORDINGS_PROMPT_SHA256 &&
        cocreationWordingsHash(wire.system) === COCREATION_WORDINGS_PROMPT_SHA256;
      ensure(
        (pinned || wordings) &&
          typeof wire.user === 'string' &&
          wire.user.length > 0 &&
          wire.user.length <= 4000 &&
          Number.isSafeInteger(wire.maxTokens) &&
          wire.maxTokens > 0 &&
          wire.maxTokens <= (wordings ? 3000 : 1000),
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
  /** Part 54: one call, one result (see WebIsolatedGenerationSession.runText). A fresh single-use session per call. */
  runText(job: WebTextJob): Promise<WebTextRun> {
    return this.session().runText(job);
  }
  async runSpeech(job: WebSpeechJob): Promise<SpeechRPCResult> {
    ensure(
      Number.isSafeInteger(job?.callTimeoutMs) && job.callTimeoutMs >= 1 && job.callTimeoutMs <= 120_000,
      'WEB_PROVIDER_WIRE_MISMATCH',
    );
    return this.session().speech(job.wire, async () => {}, job.callTimeoutMs);
  }
  async runEmbed(job: WebEmbedJob): Promise<WebEmbedRPCResult> {
    return this.session().embed(job.wire, async () => {});
  }
  /** Overridden only by the test graph, which substitutes the provider network and nothing else. */
  protected session(): WebIsolatedGenerationSession {
    return new WebIsolatedGenerationSession(this.env);
  }
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
