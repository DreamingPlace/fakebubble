import type { AcceptedV7StageOutput, TextGenerationRequest, TextGenerationStage } from './index.ts';
import type { FishModel, SpeechRequest } from './audio.ts';
import type { ProviderMeter, ProviderObservation } from './provider-calls.ts';
import type { TextRoute } from './text-route.ts';
import type { TextRPCResult, SpeechRPCResult } from './generation-rpc.ts';

export interface WebKnownDraft {
  payload: unknown;
  metadata: TextGenerationStage;
  requestDigest: string;
  policyHash: string;
}
export interface WebSpeechWire {
  body: string;
  wireRequestHash: string;
  model: FishModel;
  billedTextBytes: number;
  speech: SpeechRequest;
}
/** Texts to embed with the pinned model. The generation Worker holds no database: the business object stores vectors. */
export interface WebEmbedWire {
  texts: string[];
  model: string;
}
export type WebEmbedRPCResult =
  | { ok: true; value: { vectors: number[][]; usageTokens: number | null; requestId: string | null } }
  /** `known`: the provider rejected the call before running it (or the gate refused it): nothing was billed. */
  | { ok: false; code: string; known: boolean };
/**
 * Part 30: ONE plain-text completion on the draft model for 按反馈重录. The Worker accepts only the pinned clip-direction system
 * prompt (it checks the text and `systemSha256`); the business object has already reserved the budget.
 */
export interface WebCompleteWire {
  system: string;
  systemSha256: string;
  user: string;
  maxTokens: number;
}
export type WebCompleteRPCResult =
  | { ok: true; value: { text: string; inputTokens: number; outputTokens: number; model: string; receipt: unknown } }
  | { ok: false; code: string };
/**
 * Part 35: ONE plain completion on a house reviewer model for 多轮预演 (the hint writer and the verdict). The Worker runs only a system
 * prompt whose text and `systemSha256` are exactly one of the pinned judge prompts, and only a house reviewer model; the business
 * object has already reserved the budget.
 */
export interface WebJudgeWire {
  system: string;
  systemSha256: string;
  user: string;
  maxTokens: number;
  model: string;
}
export type WebJudgeRPCResult = WebCompleteRPCResult;
export interface WebGenerationSession {
  text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
    /** Part 21b: absent = DeepSeek only, exactly as before. */
    route?: TextRoute,
  ): Promise<TextRPCResult>;
  speech(wire: WebSpeechWire, authorize: () => Promise<void>): Promise<SpeechRPCResult>;
  embed(wire: WebEmbedWire, authorize: () => Promise<void>): Promise<WebEmbedRPCResult>;
  /** Part 30: the clip-direction rewrite (absent on an older generation Worker: 按反馈重录 then stays off). */
  complete?(wire: WebCompleteWire, authorize: () => Promise<void>): Promise<WebCompleteRPCResult>;
  /** Part 35: the 多轮预演 judge (absent on an older generation Worker: a run that needs a judge then fails before anything is sent). */
  judge?(wire: WebJudgeWire, authorize: () => Promise<void>): Promise<WebJudgeRPCResult>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}
/**
 * Part 54: ONE call, ONE result. The business object reserves the money for every stage BEFORE the call and settles from the
 * result AFTER it; generation never calls back into the business object while a reply is being made.
 *
 * Job: plain data only (no functions, no stubs). `stages` are the limits the business object reserved against; generation
 * refuses to send a request that could cost more than its reservation (WEB_PROVIDER_STAGE_INVALID, nothing sent).
 */
export interface WebStageLimit {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}
export interface WebTextJob {
  /** `${operationId}:${attempt}` - only for correlation and idempotent retries by the caller; carries no content. */
  reservationId: string;
  request: TextGenerationRequest;
  policyHash: string;
  known: WebKnownDraft | null;
  /** One model per stage: a model that is proven not billed is retried by the business object as a NEW call and reservation. */
  route?: TextRoute;
  stages: { draft: WebStageLimit | null; review: WebStageLimit };
  /** A limit for each provider call, below the stage lease and the RPC limit. Generation clamps it to 1..60 000. */
  callTimeoutMs: number;
}
/**
 * What happened to one stage. not_sent: nothing was sent for it (proved by generation: it was never started). started: the request
 * was handed to the provider; `observation` is what came back, or absent when nothing could be observed (then it is UNKNOWN).
 */
export type WebStageRun =
  | { state: 'not_sent' }
  | {
      state: 'started';
      wireRequestHash: string;
      requestBytes: number;
      observation: ProviderObservation | null;
      /** The validated, accepted stage output (only for a succeeded stage). */
      accepted: AcceptedV7StageOutput | null;
      /** Admin diagnosis only: the raw words of a response that failed validation. */
      rejected: { raw: string; errorCode: string } | null;
    };
export interface WebTextRun {
  stages: { draft: WebStageRun; review: WebStageRun };
  result: TextRPCResult;
}
export interface WebSpeechJob {
  reservationId: string;
  wire: WebSpeechWire;
  callTimeoutMs: number;
}
export interface WebEmbedJob {
  reservationId: string;
  wire: WebEmbedWire;
}
export interface WebGenerationBinding {
  /** Part 54: the reply path. Absent on an older generation Worker: the reply then fails before anything is sent. */
  runText?(job: WebTextJob): Promise<WebTextRun>;
  runSpeech?(job: WebSpeechJob): Promise<SpeechRPCResult>;
  runEmbed?(job: WebEmbedJob): Promise<WebEmbedRPCResult>;
  open(): Promise<WebGenerationSession>;
  /**
   * Part 21g: which optional text-provider keys the generation Worker holds (booleans only, never a key). The business object
   * uses it as part of the model ceiling and for the 未配置 state on the admin page. Absent on an older generation Worker.
   */
  modelKeys?(): Promise<{ xai: boolean; gemini: boolean }>;
}
