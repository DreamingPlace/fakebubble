export const FISH_MODELS = Object.freeze(['s2.1-pro', 's2-pro', 'drama-3']);
export const isFishModel = (value) => FISH_MODELS.some((model) => model === value);
/** Site-wide default for voices that are not pinned (env `FISH_VOICE_MODEL`). */
export const SITE_VOICE_MODELS = Object.freeze(['s2.1-pro', 'drama-3']);
export const DEFAULT_SITE_VOICE_MODEL = 's2.1-pro';
/**
 * A voice binding stores one of: `s2.1-pro` (unpinned: follows the site default, which is also what every binding made
 * before Drama 3 means), `drama-3`, `s2-pro`, or `pin:s2.1-pro` (the admin pinned this character back to s2.1-pro).
 * Stored in the existing free-text model column, so no migration is needed.
 */
export const PINNED_S21_BINDING = 'pin:s2.1-pro';
export const isVoiceModelBinding = (value) => isFishModel(value) || value === PINNED_S21_BINDING;
export function resolveVoiceModel(binding, siteDefault) {
    if (binding === PINNED_S21_BINDING)
        return 's2.1-pro';
    return binding === 's2.1-pro' ? siteDefault : binding;
}
