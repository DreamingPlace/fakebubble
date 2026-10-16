import type { SpeechDeliveryStyle } from './scenes.ts';
import type { Expression, SoundCue } from './index.ts';
import type { ProviderDeclaration, ProviderMeter } from './provider-calls.ts';

/**
 * `drama-3` is the exact `model` header value in the current Fish docs (docs/PROVIDERS.md). An unrecognised value does
 * NOT fail: Fish silently serves s2.1-pro. Never add an unverified spelling (e.g. `drama-3-preview`) here.
 */
export type FishModel = 's2.1-pro' | 's2-pro' | 'drama-3';
export const FISH_MODELS: readonly FishModel[] = Object.freeze(['s2.1-pro', 's2-pro', 'drama-3']);
export const isFishModel = (value: unknown): value is FishModel => FISH_MODELS.some((model) => model === value);
/** Site-wide default for voices that are not pinned (env `FISH_VOICE_MODEL`). */
export const SITE_VOICE_MODELS: readonly FishModel[] = Object.freeze(['s2.1-pro', 'drama-3']);
export const DEFAULT_SITE_VOICE_MODEL: FishModel = 's2.1-pro';
/**
 * A voice binding stores one of: `s2.1-pro` (unpinned: follows the site default, which is also what every binding made
 * before Drama 3 means), `drama-3`, `s2-pro`, or `pin:s2.1-pro` (the admin pinned this character back to s2.1-pro).
 * Stored in the existing free-text model column, so no migration is needed.
 */
export const PINNED_S21_BINDING = 'pin:s2.1-pro';
export type VoiceModelBinding = FishModel | typeof PINNED_S21_BINDING;
export const isVoiceModelBinding = (value: unknown): value is VoiceModelBinding =>
  isFishModel(value) || value === PINNED_S21_BINDING;
export function resolveVoiceModel(binding: VoiceModelBinding, siteDefault: FishModel): FishModel {
  if (binding === PINNED_S21_BINDING) return 's2.1-pro';
  return binding === 's2.1-pro' ? siteDefault : binding;
}
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
  /** Rendered only for Drama 3; ignored for s2 models. */
  soundCue?: SoundCue;
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
