import type { DialogueCandidate, MessageDTO, RelationshipPreset } from '../contracts/index.ts';
import { SCENE_KINDS } from '../contracts/scenes.ts';
import type { SceneDescription, SceneState, SceneUpdate, SpeechDeliveryStyle } from '../contracts/scenes.ts';
import { ensure } from './errors.ts';

export const REMOTE_SCENE: Readonly<SceneDescription> = Object.freeze({ kind: 'remote', setting: null, plan: null, proximity: 'ordinary', speaking: 'normal' });
export const SCENE_TTL = { remote: null, proposed: 24 * 60 * 60_000, planned: 7 * 24 * 60 * 60_000, together: 2 * 60 * 60_000 } as const;
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(','), 'INVALID_SCENE');
}
function short(value: unknown, max: number): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0 && [...value].length <= max && !/[\r\n]/u.test(value), 'INVALID_SCENE');
}
export function sceneUpdate(value: unknown): SceneUpdate | null {
  if (value === null) return null;
  exact(value, ['scene', 'evidence', 'responseQuote']);
  exact(value.scene, ['kind', 'setting', 'plan', 'proximity', 'speaking']);
  const scene = value.scene;
  ensure(SCENE_KINDS.some(kind => kind === scene.kind) && ['ordinary', 'close'].includes(String(scene.proximity)) &&
    ['normal', 'quiet'].includes(String(scene.speaking)), 'INVALID_SCENE');
  if (scene.setting !== null) short(scene.setting, 100);
  if (scene.plan !== null) short(scene.plan, 120);
  ensure(scene.kind === 'together' || scene.proximity === 'ordinary', 'INVALID_SCENE');
  ensure(scene.kind !== 'remote' || (scene.setting === null && scene.plan === null), 'INVALID_SCENE');
  ensure(scene.kind !== 'together' || scene.plan === null, 'INVALID_SCENE');
  ensure(Array.isArray(value.evidence) && value.evidence.length <= 4, 'INVALID_SCENE');
  for (const proof of value.evidence) {
    exact(proof, ['messageId', 'quote']); short(proof.messageId, 128); short(proof.quote, 240);
  }
  short(value.responseQuote, 160);
  return structuredClone(value) as unknown as SceneUpdate;
}
export function validateSceneEvidence(update: SceneUpdate | null | undefined, current: SceneState | undefined,
  messages: MessageDTO[], candidate: DialogueCandidate, playerId: string) {
  if (!update) return;
  ensure(current, 'SCENE_PRIVATE_ONLY');
  ensure(candidate.bubbles.some(bubble => bubble.text.includes(update.responseQuote)), 'INVALID_SCENE_EVIDENCE');
  ensure(update.evidence.every(proof => messages.some(message => message.id === proof.messageId && message.text.includes(proof.quote))), 'INVALID_SCENE_EVIDENCE');
  const allowedInputs = sceneConsentIds(candidate, update.scene.kind);
  const playerConsent = update.evidence.some(proof => allowedInputs.includes(proof.messageId) &&
    messages.some(message => message.id === proof.messageId && message.authorKind === 'player' && message.authorId === playerId));
  // Exact evidence is not a semantic proof of consent. The independent auditor must also verify its meaning.
  const needsConsent = update.scene.kind === 'planned' || update.scene.kind === 'together' || update.scene.speaking === 'quiet';
  ensure(!needsConsent || playerConsent, 'SCENE_CONSENT_REQUIRED');
}
export function changedScene(update: SceneUpdate | null | undefined, current: SceneState | undefined): SceneUpdate | null {
  if (!update) return null;
  if (current && !current.needsConfirmation && update.scene.kind === current.kind && update.scene.setting === current.setting &&
    update.scene.plan === current.plan && update.scene.proximity === current.proximity && update.scene.speaking === current.speaking) return null;
  return update;
}
export function sceneConsentIds(candidate: DialogueCandidate, kind: SceneDescription['kind']) {
  // Agreeing to meet and asking what time are compatible. Keep that question pending; do not fake full coverage.
  return kind === 'planned' ? [...candidate.coveredMessageIds, ...candidate.awaitingPlayerMessageIds] : candidate.coveredMessageIds;
}
export function sceneDeliveryStyle(scene: SceneDescription, relationship: RelationshipPreset): SpeechDeliveryStyle {
  if (scene.kind === 'together' && scene.proximity === 'close' && relationship === 'lover') return 'tender_whisper';
  return scene.speaking === 'quiet' ? 'quiet' : 'conversational';
}
