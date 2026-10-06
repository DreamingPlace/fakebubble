import type { CharacterTemplate, JsonValue } from '../../packages/contracts/index.ts';
import { defaultSchedule } from '../../packages/domain/defaults.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { validateSchedule } from '../../packages/domain/schedule.ts';
import { validateAutonomy } from '../../packages/domain/autonomy.ts';
import { AUTONOMY_PRESETS } from '../../packages/contracts/autonomy.ts';

function object(value: unknown): asserts value is Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_CHARACTER_PROFILE');
}
function string(value: unknown, max: number): asserts value is string {
  ensure(typeof value === 'string' && value.trim().length > 0 && value.length <= max, 'INVALID_CHARACTER_PROFILE');
}
function jsonValue(value: unknown, depth = 0): asserts value is JsonValue {
  ensure(depth <= 8, 'INVALID_CANON_VALUE');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    ensure(Number.isFinite(value), 'INVALID_CANON_VALUE');
    return;
  }
  ensure(typeof value === 'object', 'INVALID_CANON_VALUE');
  const entries = Object.entries(value);
  ensure(entries.length <= 200, 'INVALID_CANON_VALUE');
  for (const [key, child] of entries) {
    ensure(!['__proto__', 'constructor', 'prototype'].includes(key), 'INVALID_CANON_VALUE');
    jsonValue(child, depth + 1);
  }
}
export function validBirthDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Explicit projection: never ingest whole directories, provenance, voice paths or credentials.
export function compileApprovedCharacter(input: unknown): CharacterTemplate {
  object(input);
  ensure(input.reviewStatus === 'approved_for_implementation', 'CHARACTER_REVIEW_REQUIRED');
  ensure(input.fictional === true, 'FICTIONAL_CHARACTER_REQUIRED');
  object(input.contentBasis);
  ensure(
    input.contentBasis.kind === 'author_canon' && input.contentBasis.truthScope === 'fictional_world',
    'AUTHOR_CANON_REQUIRED',
  );
  string(input.id, 128);
  string(input.name, 100);
  string(input.persona, 20_000);
  const characterId = input.id;
  ensure(Number.isSafeInteger(input.version) && Number(input.version) > 0, 'INVALID_CHARACTER_VERSION');
  ensure(
    input.initialRelationship === null && input.relationshipSelection === 'player_onboarding',
    'RELATIONSHIP_SELECTION_REQUIRED',
  );
  object(input.basicInfo);
  ensure(validBirthDate(input.basicInfo.birthDate), 'INVALID_BIRTH_DATE');
  string(input.timeZone, 100);
  const schedule =
    input.schedule === undefined ? defaultSchedule(input.timeZone) : (input.schedule as CharacterTemplate['schedule']);
  try {
    validateSchedule(schedule);
  } catch {
    throw new DomainError('INVALID_CHARACTER_SCHEDULE');
  }
  const basicInfo: Record<string, JsonValue> = {};
  for (const key of [
    'englishName',
    'birthDate',
    'birthPlace',
    'affiliation',
    'youngestInGeneration',
    'nationalityCulturalIdentity',
    'grewUpIn',
  ]) {
    const value = input.basicInfo[key];
    if (value !== undefined) {
      jsonValue(value);
      basicInfo[key] = value;
    }
  }
  const settings: Record<string, JsonValue> = { basicInfo };
  const selfNames = [input.name];
  if (typeof basicInfo.englishName === 'string') selfNames.push(basicInfo.englishName);
  if (input.aliases !== undefined) {
    ensure(Array.isArray(input.aliases) && input.aliases.length <= 32, 'INVALID_CHARACTER_ALIASES');
    for (const alias of input.aliases) {
      string(alias, 100);
      selfNames.push(alias);
    }
  }
  if (input.referencePerson !== undefined) {
    object(input.referencePerson);
    if (input.referencePerson.relationship === 'fictional_mapping') {
      string(input.referencePerson.name, 100);
      selfNames.push(input.referencePerson.name);
    }
  }
  settings.selfIdentity = {
    names: [...new Set(selfNames)],
    truthScope: 'fictional_world',
    representsRealPerson: false,
  };
  for (const key of [
    'speechStyle',
    'dialogueStyle',
    'dialogueExamples',
    'appearanceNotes',
    'appearanceMetrics',
    'aliases',
    'background',
    'backgroundLabels',
    'personalityLayers',
    'interests',
    'pets',
    'fears',
    'boundaries',
    'audienceReception',
    'fictionalLocations',
    'fictionalPeople',
  ]) {
    const value = input[key];
    if (value !== undefined) {
      jsonValue(value);
      settings[key] = value;
    }
  }
  if (input.canonEvents !== undefined) {
    ensure(Array.isArray(input.canonEvents), 'INVALID_CANON_EVENTS');
    settings.canonEvents = input.canonEvents.filter((event) => {
      object(event);
      jsonValue(event);
      ensure(
        event.sourceKind === 'author_canon' &&
          event.truthScope === 'fictional_world' &&
          Array.isArray(event.defaultKnowers),
        'INVALID_CANON_EVENTS',
      );
      return event.defaultKnowers.includes(characterId);
    });
  }
  ensure(JSON.stringify(settings).length <= 48_000, 'CHARACTER_CONTEXT_TOO_LARGE');
  let autonomy = input.autonomy;
  if (autonomy === undefined && input.behaviorPreferences !== undefined) {
    object(input.behaviorPreferences);
    const frequency = input.behaviorPreferences.proactiveFrequency;
    if (frequency === 'very_low') autonomy = AUTONOMY_PRESETS.veryLow;
    else if (frequency === 'system_default_not_personalized') autonomy = AUTONOMY_PRESETS.standard;
    else ensure(frequency === undefined, 'INVALID_AUTONOMY');
  }
  if (autonomy !== undefined) validateAutonomy(autonomy);
  return structuredClone({
    id: input.id,
    name: input.name,
    version: Number(input.version),
    fictional: true,
    persona: input.persona,
    birthDate: input.basicInfo.birthDate,
    schedule,
    ...(autonomy === undefined ? {} : { autonomy }),
    authorCanon: { kind: 'author_canon', settings },
  });
}
