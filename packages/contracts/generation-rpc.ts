import type { TextGenerationRequest, TextGenerationResult } from './index.ts';
import type { SpeechRequest, SpeechResult } from './audio.ts';
import type { ProviderMeter } from './provider-calls.ts';
export type GenerationResult<T, G> = { ok: true; value: T } | { ok: false; code: string; generation: G | null };
export type TextRPCResult = GenerationResult<TextGenerationResult, Omit<TextGenerationResult, 'reply'>>;
export type SpeechRPCResult = GenerationResult<
  SpeechResult,
  Pick<
    SpeechResult,
    'provider' | 'model' | 'elapsedMs' | 'requestId' | 'inputCharacters' | 'inputUTF8Bytes' | 'billedAmount'
  >
>;
export interface GenerationSession {
  text(request: TextGenerationRequest, meter: ProviderMeter, policyHash: string): Promise<TextRPCResult>;
  speech(request: SpeechRequest, meter: ProviderMeter): Promise<SpeechRPCResult>;
  cancel(): Promise<void>;
  [Symbol.dispose](): void;
}
export interface GenerationBinding {
  open(): Promise<GenerationSession>;
}
