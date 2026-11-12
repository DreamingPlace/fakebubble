import type { SoundCue, Expression } from '../../../packages/contracts/index.ts';
import type { FishModel, SpeechRequest, VoiceIdentity } from '../../../packages/contracts/audio.ts';
import type { SpeechDeliveryStyle } from '../../../packages/contracts/scenes.ts';

/**
 * Part 24k-1: the ONE builder of a Fish speech request. A live voice reply and the admin speech path (generated 成品
 * clips, 预演 试听) both call it, so they cannot drift apart. Drama 3 direction handling needs nothing more here: the
 * expression, delivery style and sound cue are turned into direction text by `speechPayload` (workers/audio/fish.ts) from
 * the same request, for the same model.
 */
export function webSpeechRequest(input: {
  jobId: string;
  text: string;
  expression: Expression;
  voice: VoiceIdentity;
  model: FishModel;
  deliveryStyle: SpeechDeliveryStyle;
  soundCue?: SoundCue;
  /** The voice was heard and selected by a person with Fish quality-guard on (s2 only; Drama 3 ignores it). */
  userSelected: boolean;
  /** Part 30: the text with direction markup (an admin take made from feedback). */
  markup?: string;
}): SpeechRequest {
  return {
    jobId: input.jobId,
    text: input.text,
    expression: input.expression,
    speed: 1,
    voice: input.voice,
    model: input.model,
    ...(input.userSelected ? { qualityGuard: true } : {}),
    deliveryStyle: input.deliveryStyle,
    ...(input.soundCue === undefined ? {} : { soundCue: input.soundCue }),
    ...(input.markup === undefined ? {} : { markup: input.markup }),
  };
}
