import type { CharacterTemplate, JsonValue } from '../../packages/contracts/index.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { validateSchedule } from '../../packages/domain/schedule.ts';
import { validateAutonomy } from '../../packages/domain/autonomy.ts';
import { validateVoiceBinding } from './voices.ts';
import { validBirthDate } from './characters.ts';

export function record(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_ADMIN_REQUEST');
}
export function keys(value: Record<string, unknown>, allowed: string[]) {
  ensure(Object.keys(value).every(key => allowed.includes(key)), 'INVALID_ADMIN_REQUEST');
}
export function nonempty(value: unknown, max: number): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_ADMIN_REQUEST');
}
export function identifier(value: unknown): asserts value is string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'INVALID_ADMIN_ID');
}
function jsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  ensure(depth <= 8, 'INVALID_CANON_VALUE');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { ensure(Number.isFinite(value), 'INVALID_CANON_VALUE'); return; }
  ensure(typeof value === 'object', 'INVALID_CANON_VALUE');
  const entries = Object.entries(value);
  ensure(entries.length <= 200, 'INVALID_CANON_VALUE');
  for (const [key, child] of entries) {
    ensure(!['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_CANON_VALUE');
    jsonValue(child, depth + 1);
  }
}

/** Runtime templates only. Voice paths, source credentials and intake provenance never enter this API. */
export function validatedTemplate(value: unknown): CharacterTemplate {
  record(value); keys(value, ['id', 'name', 'version', 'fictional', 'persona', 'schedule', 'autonomy', 'voice', 'birthDate', 'authorCanon']);
  identifier(value.id); nonempty(value.name, 100); nonempty(value.persona, 20_000);
  ensure(value.fictional === true && Number.isSafeInteger(value.version) && Number(value.version) > 0, 'INVALID_TEMPLATE');
  record(value.schedule); keys(value.schedule, ['timeZone', 'days']); nonempty(value.schedule.timeZone, 100);
  record(value.schedule.days); keys(value.schedule.days, ['0', '1', '2', '3', '4', '5', '6']);
  for (const slots of Object.values(value.schedule.days)) {
    ensure(Array.isArray(slots), 'INVALID_SCHEDULE');
    for (const slot of slots) { record(slot); keys(slot, ['startMinute', 'endMinute', 'probability', 'catchUp']); }
  }
  const template = value as unknown as CharacterTemplate;
  validateSchedule(template.schedule);
  if (value.autonomy !== undefined) validateAutonomy(value.autonomy);
  if (value.voice !== undefined) validateVoiceBinding(value.voice);
  ensure(value.birthDate === undefined || validBirthDate(value.birthDate), 'INVALID_BIRTH_DATE');
  if (value.authorCanon !== undefined) {
    record(value.authorCanon); keys(value.authorCanon, ['kind', 'settings']);
    ensure(value.authorCanon.kind === 'author_canon', 'AUTHOR_CANON_REQUIRED');
    record(value.authorCanon.settings);
    keys(value.authorCanon.settings, ['basicInfo', 'speechStyle', 'dialogueStyle', 'dialogueExamples', 'appearanceNotes', 'appearanceMetrics',
      'aliases', 'selfIdentity', 'background', 'backgroundLabels', 'personalityLayers', 'interests', 'pets', 'fears', 'boundaries',
      'audienceReception', 'fictionalLocations', 'fictionalPeople', 'canonEvents']);
    jsonValue(value.authorCanon.settings);
    ensure(JSON.stringify(value.authorCanon.settings).length <= 48_000, 'CHARACTER_CONTEXT_TOO_LARGE');
    const identity = value.authorCanon.settings.selfIdentity;
    if (identity !== undefined) {
      record(identity); keys(identity, ['names', 'truthScope', 'representsRealPerson']);
      ensure(identity.truthScope === 'fictional_world' && identity.representsRealPerson === false &&
        Array.isArray(identity.names) && identity.names.length > 0 && identity.names.length <= 35 && identity.names.includes(value.name), 'INVALID_CHARACTER_ALIASES');
      for (const name of identity.names) nonempty(name, 100);
    }
    const basic = value.authorCanon.settings.basicInfo;
    if (basic !== undefined) {
      record(basic);
      keys(basic, ['englishName', 'birthDate', 'birthPlace', 'affiliation', 'youngestInGeneration', 'nationalityCulturalIdentity', 'grewUpIn']);
      ensure(basic.birthDate === undefined || basic.birthDate === value.birthDate, 'CONFLICTING_BIRTH_DATE');
    }
    const events = value.authorCanon.settings.canonEvents;
    if (events !== undefined) {
      ensure(Array.isArray(events), 'INVALID_CANON_EVENTS');
      for (const event of events) {
        record(event);
        ensure(event.sourceKind === 'author_canon' && event.truthScope === 'fictional_world' &&
          Array.isArray(event.defaultKnowers) && event.defaultKnowers.includes(value.id), 'INVALID_CANON_EVENTS');
      }
    }
  }
  return structuredClone(template);
}
