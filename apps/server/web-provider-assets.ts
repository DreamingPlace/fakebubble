import { createHash } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import type { SpeechRequest, SpeechResult } from '../../packages/contracts/audio.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { fishSpeechRequest } from '../../workers/audio/fish.ts';
import { finalizeFishWav } from '../../workers/audio/wav.ts';
import { WEB_PROVIDER_WELCOME } from '../../config/web-v1.ts';
import { SYNTHETIC_TRIAL_FOOTER } from './web-vertical-publisher.ts';
import { WebProviderOffline } from './web-provider-offline.ts';
import type { WebProviderBudget } from './web-provider-budget.ts';
import type { Store } from './store.ts';

export async function renderProviderAssets(store: Store, clock: Clock, budget: WebProviderBudget,
  generate: (request: SpeechRequest, signal: AbortSignal) => Promise<SpeechResult>) {
  const ledger = new WebProviderOffline(store, clock);
  const instance = store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
  ensure(instance, 'WEB_SHARED_INSTANCE_INVALID');
  const rendered: { kind: string; characterId: string; billedBytes: number; recovered: boolean }[] = [];
  for (const binding of store.all<{ character_id: keyof typeof WEB_PROVIDER_WELCOME; voice_version: string;
    voice_revision: number; profile_id: string; reference_id: string; model: string }>(
    "SELECT * FROM web_provider_voice_bindings WHERE source='user_selected' AND approved=1 ORDER BY character_id")) {
    for (const kind of ['welcome', 'footer'] as const) {
      const table = kind === 'welcome' ? 'web_provider_welcome_assets' : 'web_provider_footer_assets';
      if (store.get(`SELECT 1 FROM ${table} WHERE character_id=? AND voice_version=?`,
        binding.character_id, binding.voice_version)) continue;
      ensure(binding.model === 's2.1-pro', 'WEB_PROVIDER_VOICE_UNAPPROVED');
      const body = kind === 'welcome' ? WEB_PROVIDER_WELCOME[binding.character_id].text : SYNTHETIC_TRIAL_FOOTER;
      const speech: SpeechRequest = { jobId: `asset-${kind}-${binding.character_id}`, text: body,
        expression: 'neutral', speed: 1, qualityGuard: true, deliveryStyle: 'conversational',
        voice: { profileId: binding.profile_id, referenceId: binding.reference_id,
          version: binding.voice_revision }, model: binding.model };
      const prepared = fishSpeechRequest(speech, binding.model);
      const id = JSON.stringify([instance.instance_id, 'asset', binding.character_id, kind, binding.voice_version]);
      const fingerprint = createHash('sha256').update(JSON.stringify([
        prepared.requestHash, binding.voice_version, prepared.bytes])).digest('hex');
      const prior = budget.read(id, fingerprint);
      let audio: Uint8Array;
      if (prior) {
        ensure(prior.state === 'known' && prior.audio, 'WEB_SHARED_ATTEMPT_UNRESOLVED');
        audio = prior.audio;
      } else {
        const price = store.get<{ upper_micros_per_unit: number }>(`SELECT upper_micros_per_unit
          FROM web_provider_prices WHERE provider='fish' AND model=? AND phase='speech'
          AND unit='byte' AND currency='USD' AND valid_from<=? AND valid_until>?`,
        binding.model, clock.now(), clock.now());
        ensure(price, 'WEB_PROVIDER_PRICE_REQUIRED');
        budget.reserve(id, 'fish', fingerprint, prepared.bytes * price.upper_micros_per_unit);
        // Any error, including a missing/invalid receipt, keeps the hold and blocks a resend.
        const result = await generate(speech, new AbortController().signal);
        ensure(result.inputUTF8Bytes === prepared.bytes && result.model === binding.model,
          'WEB_PROVIDER_USAGE_MISMATCH');
        audio = finalizeFishWav(result.audio).audio;
        budget.settle(id, fingerprint, prepared.bytes * price.upper_micros_per_unit,
          { requestId: result.requestId, billedBytes: result.inputUTF8Bytes }, audio);
      }
      // The result was durably saved with the bill before this local asset registration.
      if (kind === 'welcome') ledger.registerWelcome({ characterId: binding.character_id,
        voiceVersion: binding.voice_version, body, wav: audio });
      else ledger.registerApprovedFooter({ characterId: binding.character_id,
        voiceVersion: binding.voice_version, body, wav: audio, approved: true });
      rendered.push({ kind, characterId: binding.character_id, billedBytes: prepared.bytes, recovered: !!prior });
    }
  }
  return rendered;
}
