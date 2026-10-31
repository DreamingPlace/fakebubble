import { createHash } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { EXPRESSIONS } from '../../../packages/contracts/index.ts';
import type { FishModel, SpeechRequest, SpeechResult } from '../../../packages/contracts/audio.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';
import { finalizeFishWav } from '../../../workers/audio/wav.ts';
import type { WebProviderBudget } from '../budget/web-provider-budget.ts';
import type { Store } from '../platform/store.ts';

/** One fixed, neutral line for every character and expression: the listening test compares voices, not scripts. */
export const VOICE_SAMPLE_TEXT = '我在这儿，你慢慢说，我听着呢。';

export interface VoiceSampleClip {
  characterId: string;
  expression: (typeof EXPRESSIONS)[number];
  model: FishModel;
  billedBytes: number;
  requestId: string | null;
  recovered: boolean;
}

/**
 * Staging listening aid: one clip per approved character voice per expression, on the requested model. It reads only the
 * voice bindings (profile and reference ids): no player, conversation, message or memory row is touched, and the text is
 * the fixed line above. It spends real money, so it follows the asset renderer's rules: the budget hold is made before
 * the provider call, a failed or unknown call keeps its hold and is never resent (`WEB_SHARED_ATTEMPT_UNRESOLVED` on the
 * next run), and a clip that was already paid for is reused instead of regenerated.
 */
export async function renderVoiceSamples(
  store: Store,
  clock: Clock,
  budget: WebProviderBudget,
  generate: (request: SpeechRequest, signal: AbortSignal) => Promise<SpeechResult>,
  options: { model: FishModel; sink: (clip: VoiceSampleClip, wav: Uint8Array) => void },
) {
  const instance = store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
  ensure(instance, 'WEB_SHARED_INSTANCE_INVALID');
  const price = store.get<{ upper_micros_per_unit: number }>(
    `SELECT upper_micros_per_unit
    FROM web_provider_prices WHERE provider='fish' AND model=? AND phase='speech'
    AND unit='byte' AND currency='USD' AND valid_from<=? AND valid_until>? ORDER BY version DESC LIMIT 1`,
    options.model,
    clock.now(),
    clock.now(),
  );
  ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
  const clips: VoiceSampleClip[] = [];
  for (const binding of store.all<{
    character_id: string;
    voice_version: string;
    voice_revision: number;
    profile_id: string;
    reference_id: string;
    direction: string | null;
  }>(
    `SELECT character_id,voice_version,voice_revision,profile_id,reference_id,
      (SELECT json_extract(t.config_json,'$.voice.direction') FROM character_templates t WHERE t.id=character_id) direction
    FROM web_provider_voice_bindings WHERE source='user_selected' AND approved=1 ORDER BY character_id`,
  )) {
    // Part 23b: the live character's base direction, heard only on Drama 3 (the s2 wire ignores it, so nothing else moves).
    const direction = options.model === 'drama-3' && binding.direction !== null ? binding.direction : undefined;
    for (const expression of EXPRESSIONS) {
      const speech: SpeechRequest = {
        jobId: `sample-${binding.character_id}-${expression}`,
        text: VOICE_SAMPLE_TEXT,
        expression,
        speed: 1,
        deliveryStyle: 'conversational',
        voice: { profileId: binding.profile_id, referenceId: binding.reference_id, version: binding.voice_revision },
        model: options.model,
        // Same as replies: the user-selected voices were verified with quality guard on (s2 only; Drama 3 ignores it).
        qualityGuard: true,
        ...(direction === undefined ? {} : { direction }),
      };
      const prepared = fishSpeechRequest(speech, options.model);
      const id = JSON.stringify([
        instance.instance_id,
        'voice-sample',
        binding.character_id,
        expression,
        options.model,
        binding.voice_version,
        ...(direction === undefined ? [] : [direction]),
      ]);
      const fingerprint = createHash('sha256')
        .update(JSON.stringify([prepared.requestHash, binding.voice_version, prepared.bytes]))
        .digest('hex');
      const prior = budget.read(id, fingerprint);
      const micros = prepared.bytes * price.upper_micros_per_unit;
      let audio: Uint8Array;
      let requestId: string | null = null;
      if (prior) {
        ensure(prior.state === 'known' && prior.audio, 'WEB_SHARED_ATTEMPT_UNRESOLVED');
        audio = prior.audio;
      } else {
        budget.reserve(id, 'fish', fingerprint, micros);
        const result = await generate(speech, new AbortController().signal);
        ensure(
          result.inputUTF8Bytes === prepared.bytes && result.model === options.model,
          'WEB_PROVIDER_USAGE_MISMATCH',
        );
        audio = finalizeFishWav(result.audio).audio;
        requestId = result.requestId;
        budget.settle(id, fingerprint, micros, { requestId, billedBytes: result.inputUTF8Bytes }, audio);
      }
      const clip: VoiceSampleClip = {
        characterId: binding.character_id,
        expression,
        model: options.model,
        billedBytes: prepared.bytes,
        requestId,
        recovered: !!prior,
      };
      options.sink(clip, audio);
      clips.push(clip);
    }
  }
  return clips;
}
