import type { VoiceBinding } from '../../../packages/contracts/media.ts';
import { ensure } from '../../../packages/domain/errors.ts';

function id(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_VOICE_ID');
}
function object(value: unknown, fields: string[]): asserts value is Record<string, unknown> {
  ensure(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).length === fields.length &&
      Object.keys(value).every((key) => fields.includes(key)),
    'INVALID_VOICE_PROFILE',
  );
}
/** Part 23b: plain Chinese text, 1-40 characters once trimmed; the server alone adds the brackets. */
export function validateVoiceDirection(value: unknown): asserts value is string {
  ensure(
    typeof value === 'string' &&
      value === value.trim() &&
      [...value].length >= 1 &&
      [...value].length <= 40 &&
      !/[\[\]<>\r\n\u2028\u2029\u0000-\u001f]/u.test(value),
    'INVALID_VOICE_BINDING',
  );
}
export function validateVoiceBinding(value: unknown): asserts value is VoiceBinding {
  const optional = [
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'messageProbability') ? ['messageProbability'] : []),
    ...(value && typeof value === 'object' && Object.hasOwn(value, 'direction') ? ['direction'] : []),
  ];
  object(value, ['profileId', 'version', 'speed', ...optional]);
  if (Object.hasOwn(value, 'direction')) validateVoiceDirection(value.direction);
  id(value.profileId);
  ensure(
    value.messageProbability === undefined ||
      (typeof value.messageProbability === 'number' &&
        Number.isFinite(value.messageProbability) &&
        value.messageProbability >= 0 &&
        value.messageProbability <= 1),
    'INVALID_VOICE_BINDING',
  );
  ensure(
    Number.isSafeInteger(value.version) &&
      Number(value.version) > 0 &&
      typeof value.speed === 'number' &&
      Number.isFinite(value.speed) &&
      value.speed >= 0.5 &&
      value.speed <= 2,
    'INVALID_VOICE_BINDING',
  );
}
