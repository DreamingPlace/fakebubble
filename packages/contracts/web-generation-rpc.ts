import type { AcceptedV7StageOutput, TextGenerationRequest, TextGenerationStage } from './index.ts';
import type { FishModel, SpeechRequest } from './audio.ts';
import type { ProviderMeter } from './provider-calls.ts';
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
export interface WebGenerationSession {
  text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
  ): Promise<TextRPCResult>;
  speech(wire: WebSpeechWire, authorize: () => Promise<void>): Promise<SpeechRPCResult>;
  embed(wire: WebEmbedWire, authorize: () => Promise<void>): Promise<WebEmbedRPCResult>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}
export interface WebGenerationBinding {
  open(): Promise<WebGenerationSession>;
}
