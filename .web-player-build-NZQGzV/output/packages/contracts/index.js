export const EXPRESSIONS = [
    'neutral',
    'upbeat',
    'soft',
    'hesitant',
    'serious',
    'playful',
    'mock_annoyed',
    'excited',
    'sad',
    'surprised',
];
/**
 * Whitelist of one-shot sound cues the draft model may pick per spoken bubble. The server alone renders a cue into the
 * speech payload (Drama 3 only); the model never writes brackets or tags. Only tags spelled out in the Drama 3 docs are
 * listed (docs/PROVIDERS.md): add one only after verifying its spelling.
 */
export const SOUND_CUES = ['small_laugh', 'shaky_breath'];
