import { WELCOME_LIMITS } from '../../../packages/contracts/web-welcomes.ts';
import { PROFILE_LIMITS } from './profile-template.ts';

/**
 * Part 29 G (audit F-07): how large a profile save may be, derived from the validators, in ONE place used by both transports.
 * The validators count characters; a body is counted in bytes, and a Chinese character is 3 bytes in UTF-8. So the limit is
 * 3 x the characters the validators allow, plus the structure the characters sit in (the schedule is the biggest part).
 */
export const PROFILE_FIELD_CHARS = Object.freeze({
  name: PROFILE_LIMITS.displayName,
  displayName: PROFILE_LIMITS.displayName,
  publicDescription: PROFILE_LIMITS.oneLiner,
  persona: PROFILE_LIMITS.persona,
  /** JSON.stringify(authorCanon.settings).length (template-validation.ts). */
  canon: PROFILE_LIMITS.canon,
  /** WELCOME_LIMITS.maxLines lines of WELCOME_LIMITS.text characters, each with an id of up to 64. */
  welcome: WELCOME_LIMITS.maxLines * (WELCOME_LIMITS.text + 64),
  palette: PROFILE_LIMITS.paletteItems * (7 + PROFILE_LIMITS.colourName + 6),
});
const characters = Object.values(PROFILE_FIELD_CHARS).reduce((sum, n) => sum + n, 0);
/** 7 days x 48 slots x about 100 bytes of JSON each: the shape of the schedule, not text. */
const SCHEDULE_BYTES = 7 * 48 * 100;
const ENVELOPE_BYTES = 8 * 1024;
export const PROFILE_BODY_LIMIT = 3 * characters + SCHEDULE_BYTES + ENVELOPE_BYTES;
