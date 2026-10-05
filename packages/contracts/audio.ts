import type { SpeechDeliveryStyle } from './scenes.ts';
import type { Expression } from './index.ts';
import type { ProviderDeclaration, ProviderMeter } from './provider-calls.ts';

export type FishModel = 's2.1-pro' | 's2-pro';
export interface VoiceIdentity {
  profileId: string;
  version: number;
  referenceId: string;
}
export interface SpeechRequest {
  jobId: string;
  text: string;
  expression: Expression;
  speed: number;
  voice: VoiceIdentity;
  model?: FishModel;
  qualityGuard?: boolean;
  deliveryStyle?: SpeechDeliveryStyle;
}
export interface PCMInfo {
  sampleRate: number;
  channels: number;
  frames: number;
  durationMs: number;
  dataOffset: number;
  dataLength: number;
}
export interface SpeechResult {
  jobId: string;
  voice: VoiceIdentity;
  provider: 'fish';
  model: FishModel;
  audio: Uint8Array;
  mime: 'audio/wav';
  durationMs: number;
  sampleRate: number;
  elapsedMs: number;
  requestId: string | null;
  inputCharacters: number;
  inputUTF8Bytes?: number;
  // Present only when finalizing a known streaming container; sample bytes are unchanged.
  originalAudio?: Uint8Array;
  containerNormalization?: 'stream_length_fields';
  // Fish's binary response does not prove a billed price or token total.
  billedAmount: null;
  // Request observation only: Fish does not acknowledge backend activation in binary responses.
  qualityGuardRequested?: boolean;
}
export interface SpeechGenerator extends ProviderDeclaration {
  generate(request: SpeechRequest, signal: AbortSignal, meter?: ProviderMeter): Promise<SpeechResult>;
}
export interface VoiceUploadApproval {
  provider: 'fish';
  referenceSHA256: string;
  uploadApproved: true;
}
export interface PrivateVoice {
  id: string;
  state: 'created' | 'training' | 'trained' | 'failed';
  visibility: 'private';
}
export interface FishAPICredit {
  credit: string;
  hasCredit: boolean;
}
export interface VoiceBenchmarkCase {
  id: string;
  text: string;
  expression: Expression;
  speed: number;
}
export const VOICE_BASELINE_CASES: readonly VoiceBenchmarkCase[] = Object.freeze([
  { id: 'baseline-first-voice', text: '嗯，我在听。你慢慢说。', expression: 'neutral', speed: 1 },
]);
export const VOICE_QUALITY_CASES: readonly VoiceBenchmarkCase[] = Object.freeze([
  {
    id: 'quality-continuous-speech',
    text: '嗯，我在听。你今天过得怎么样？我刚忙完，想坐下来歇一会儿。你有什么想说的，就慢慢讲，不用着急。',
    expression: 'neutral',
    speed: 1,
  },
]);
export const VOICE_BENCHMARK_CASES: readonly VoiceBenchmarkCase[] = Object.freeze([
  { id: 'neutral-short', text: '无畏啊。', expression: 'neutral', speed: 1 },
  { id: 'upbeat-direct', text: '因为……就是很喜欢你呀。', expression: 'upbeat', speed: 1 },
  { id: 'soft-response', text: '嗯，我在听。慢慢说。', expression: 'soft', speed: 1 },
  { id: 'hesitant-response', text: '啊？等一下，我有点怕。', expression: 'hesitant', speed: 1 },
  { id: 'serious-apology', text: '刚才那句话不太合适。对不起，我重新说。', expression: 'serious', speed: 1 },
  { id: 'slower-pause', text: '今天先聊到这儿，明天再接着说。', expression: 'soft', speed: 0.9 },
]);
