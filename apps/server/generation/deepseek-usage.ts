// The currently supported V4 models advertise 1M context. Reserve the conservative 2^20 ceiling,
// not a guessed text/token ratio. Recheck this bound before adding another model family.
export const DEEPSEEK_INPUT_RESERVATION = 1_048_576;
