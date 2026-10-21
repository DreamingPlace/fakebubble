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
export function validateVoiceBinding(value: unknown): asserts value is VoiceBinding {
  const optional =
    value && typeof value === 'object' && Object.hasOwn(value, 'messageProbability') ? ['messageProbability'] : [];
  object(value, ['profileId', 'version', 'speed', ...optional]);
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
