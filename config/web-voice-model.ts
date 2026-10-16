import { DEFAULT_SITE_VOICE_MODEL, SITE_VOICE_MODELS, type FishModel } from '../packages/contracts/audio.ts';
import { ensure } from '../packages/domain/errors.ts';

/**
 * `FISH_VOICE_MODEL`: the model for every voice that is not pinned (see `resolveVoiceModel`). Unset means s2.1-pro, i.e.
 * unchanged behaviour. Fish serves s2.1-pro silently for an unknown model header, so anything not listed here (including
 * `drama`, `drama-3-preview`) is rejected at startup instead of being passed on.
 */
export function siteVoiceModelFromEnv(value: string | undefined): FishModel {
  if (value === undefined || value === '') return DEFAULT_SITE_VOICE_MODEL;
  const model = SITE_VOICE_MODELS.find((candidate) => candidate === value);
  ensure(model, 'INVALID_FISH_VOICE_MODEL');
  return model;
}
