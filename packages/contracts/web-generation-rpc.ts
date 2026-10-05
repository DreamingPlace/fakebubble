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
export interface WebGenerationSession {
  text(
    request: TextGenerationRequest,
    policyHash: string,
    known: WebKnownDraft | null,
    meter: ProviderMeter,
    accept: (stage: AcceptedV7StageOutput) => Promise<void>,
  ): Promise<TextRPCResult>;
  speech(wire: WebSpeechWire, authorize: () => Promise<void>): Promise<SpeechRPCResult>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}
export interface WebGenerationBinding {
  open(): Promise<WebGenerationSession>;
}
