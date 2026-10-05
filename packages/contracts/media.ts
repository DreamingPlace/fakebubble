import type { FishModel } from './audio.ts';

export interface VoiceBinding {
  profileId: string; version: number; speed: number;
  /** Per-character channel preference, not voice identity. Omitted legacy bindings retain voice-only delivery. */
  messageProbability?: number;
}
export interface VoiceProfile {
  id: string;
  version: number;
  name: string;
  kind: 'custom' | 'preset';
  provider: 'fish';
  model: FishModel;
  referenceId: string;
  /** Frozen per version; omitted legacy profiles keep their original synthesis parameters. */
  qualityGuard?: boolean;
}
export interface VoiceProfileRecord {
  profile: VoiceProfile;
  createdAt: number;
  approvedAt: number | null;
  approvalNote: string | null;
}
export interface VoiceMessageState {
  worldId: string;
  conversationId: string;
  messageId: string;
  mediaId: string;
  state: 'queued' | 'generating' | 'ready' | 'failed';
  voice: { profileId: string; version: number };
  durationMs: number | null;
  byteLength: number | null;
  sha256: string | null;
  mime: 'audio/wav';
  errorCode: string | null;
}
export interface VoiceRetryInput { requestId: string }
export interface VoiceRetryReceipt { voice: VoiceMessageState; duplicate: boolean }
