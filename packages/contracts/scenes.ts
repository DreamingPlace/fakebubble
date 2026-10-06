import type { MemoryScope } from './memory.ts';

export const SCENE_KINDS = ['remote', 'proposed', 'planned', 'together'] as const;
export interface SceneDescription {
  kind: (typeof SCENE_KINDS)[number];
  setting: string | null;
  // A quoted relative plan is anchored to updatedAt, never silently treated as today's plan.
  plan: string | null;
  proximity: 'ordinary' | 'close';
  speaking: 'normal' | 'quiet';
}
export interface SceneState extends SceneDescription {
  revision: number;
  updatedAt: number | null;
  expiresAt: number | null;
  needsConfirmation: boolean;
  lastChange: 'dialogue' | 'player_control' | null;
}
export interface SceneProof {
  messageId: string;
  quote: string;
}
/** Independent audit proposes a transition; the publisher verifies evidence and commits it. */
export interface SceneUpdate {
  scene: SceneDescription;
  evidence: SceneProof[];
  responseQuote: string;
}
export interface SceneEvent {
  id: string;
  revision: number;
  scene: SceneDescription;
  at: number;
  source: 'dialogue' | 'player_control';
  evidence: SceneProof[];
  response: SceneProof | null;
}
export interface ScenePage {
  scope: MemoryScope;
  state: SceneState;
  recentEvents: SceneEvent[];
}
export interface EndSceneInput {
  requestId: string;
  expectedRevision: number;
}
export interface EndSceneReceipt {
  scope: MemoryScope;
  revision: number;
  at: number;
  duplicate: boolean;
}
export type SpeechDeliveryStyle = 'conversational' | 'quiet' | 'tender_whisper';
