import { randomUUID } from 'node:crypto';
import {
  CAST_ALIAS_ATTITUDES,
  CAST_KNOWLEDGE,
  CAST_LIMITS,
  CAST_SCHEMA,
  type CastAlias,
  type CastCharacter,
  type CastDirection,
  type CastDoc,
  type CastExperience,
  type CastGroup,
  type CastGroupStory,
  type CastIssue,
  type CastMeme,
  type CastPeriod,
  type CastPerson,
  type CastStory,
  type CastText,
  type CastValidation,
} from '../../../packages/contracts/web-cast.ts';
import { DetailedError } from '../../../packages/domain/errors.ts';
import { minimalViewSize } from './cast-compile.ts';

/**
 * Validation of the cast document (Part 24a). Two layers:
 *  - normalizeCastDoc: the SHAPE. Strict (unknown keys, wrong types, over-long text, too many entries are refused), assigns the
 *    stable ids and returns the document in one canonical key order. Throws CAST_INVALID with the path of the first problem.
 *  - validateCastDoc: the MEANING (references, duplicates, the rating grid, the publish rules). Returns every error and warning,
 *    each as a code and a path made of ids and indexes - never a piece of the content.
 */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PERIOD = /^(?:|\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)$/;
const SHORT_CONTROL = /[\u0000-\u001f\u007f]/u;
const LONG_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/u;

export type Obj = Record<string, unknown>;
const fail = (path: string): never => {
  throw new DetailedError('CAST_INVALID', { issues: [{ code: 'CAST_SHAPE', path }] });
};
const object = (value: unknown, path: string, keys: readonly string[], optional: readonly string[] = []): Obj => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(path);
  const present = Object.keys(value);
  const allowed = new Set([...keys, ...optional]);
  if (present.some((key) => !allowed.has(key)) || keys.some((key) => !present.includes(key))) return fail(path);
  return value as Obj;
};
const list = (value: unknown, path: string, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length > max) return fail(path);
  return value;
};
/** Short fields are one line; long ones may hold line breaks. Nothing else below U+0020 is accepted. */
function text(value: unknown, path: string, max: number, options: { min?: number; multiline?: boolean } = {}): string {
  if (
    typeof value !== 'string' ||
    value.length > max ||
    value.length < (options.min ?? 0) ||
    (options.multiline ? LONG_CONTROL : SHORT_CONTROL).test(value)
  )
    return fail(path);
  return value;
}
const idList = (value: unknown, path: string, max: number): string[] => {
  const items = list(value, path, max).map((item, index) => {
    if (typeof item !== 'string' || !ID.test(item)) return fail(`${path}[${index}]`);
    return item as string;
  });
  return items;
};

export interface IdSource {
  /** Ids the previous draft already carries: the only ids a client may send. */
  known: ReadonlySet<string>;
  fresh: () => string;
}
export const freshCastId = () => `e_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

/** Every entry id of a document (not the character ids): what a client is allowed to send back. */
export function castEntryIds(doc: CastDoc): Set<string> {
  const ids = new Set<string>();
  const texts = (items: readonly { id: string }[]) => items.forEach((item) => ids.add(item.id));
  for (const character of doc.characters) {
    texts(character.identity.names);
    texts(character.identity.aliases);
    texts(character.speech.catchphrases);
    texts(character.speech.samples);
    texts(character.speech.avoid);
    texts(character.experiences);
    texts(character.hidden);
  }
  for (const person of doc.people) {
    ids.add(person.id);
    texts(person.names);
  }
  texts(doc.directions);
  for (const group of doc.groups) {
    ids.add(group.id);
    texts(group.stories);
  }
  for (const story of doc.stories) {
    ids.add(story.id);
    texts(story.overrides);
  }
  texts(doc.memes);
  return ids;
}

export const emptyCastDoc = (): CastDoc => ({
  schema: CAST_SCHEMA,
  world: { background: '' },
  characters: [],
  people: [],
  ratings: {},
  directions: [],
  groups: [],
  stories: [],
  memes: [],
});
export const isEmptyCastDoc = (doc: CastDoc) => canonicalCastJson(doc) === canonicalCastJson(emptyCastDoc());

/**
 * A NEW person has no id yet but other entries need to refer to it in the same save, so the client may name it `new-…`: the
 * server gives it a real id and rewrites every reference to the token (ratings, directions, participants, parties, overrides,
 * prototype links). Only people are referable this way; characters are keyed by their character_templates id.
 */
const TOKEN = /^new-[A-Za-z0-9_-]{1,64}$/;

function entryId(value: Obj, path: string, ids: IdSource, tokens?: ReadonlyMap<string, string>): string {
  const given = value.id;
  if (given === undefined || given === '') return ids.fresh();
  if (typeof given === 'string' && tokens?.has(given)) return tokens.get(given)!;
  // A client cannot invent ids: an id it sends must be one the draft already holds.
  if (typeof given !== 'string' || !ID.test(given) || !ids.known.has(given)) return fail(`${path}.id`);
  return given;
}
const entries = <T>(value: unknown, path: string, max: number, one: (item: unknown, path: string) => T): T[] =>
  list(value, path, max).map((item, index) => one(item, `${path}[${index}]`));

export function normalizeCastDoc(input: unknown, ids: IdSource): CastDoc {
  const root = object(input, 'doc', [
    'schema',
    'world',
    'characters',
    'people',
    'ratings',
    'directions',
    'groups',
    'stories',
    'memes',
  ]);
  if (root.schema !== CAST_SCHEMA) fail('doc.schema');
  const world = object(root.world, 'doc.world', ['background']);
  const L = CAST_LIMITS;
  const tokens = new Map<string, string>();
  if (Array.isArray(root.people))
    for (const person of root.people) {
      const id = (person as Obj | null)?.id;
      if (typeof id === 'string' && TOKEN.test(id) && !ids.known.has(id) && !tokens.has(id))
        tokens.set(id, ids.fresh());
    }
  /** A reference to a person that is being created in this very save. */
  const ref = (id: string) => tokens.get(id) ?? id;
  const withId = (item: unknown, path: string, keys: readonly string[]) => {
    const value = object(item, path, keys, ['id']);
    return { value, id: entryId(value, path, ids, tokens) };
  };
  const texts = (value: unknown, path: string, max: number, textMax: number): CastText[] =>
    entries(value, path, max, (item, at) => {
      const { value: v, id } = withId(item, at, ['text']);
      return { id, text: text(v.text, `${at}.text`, textMax, { min: 1 }) };
    });
  const period = (value: unknown, path: string): CastPeriod => {
    const v = object(value, path, ['start', 'end']);
    const start = text(v.start, `${path}.start`, L.storyPeriod),
      end = text(v.end, `${path}.end`, L.storyPeriod);
    if (!PERIOD.test(start) || !PERIOD.test(end)) fail(path);
    return { start, end };
  };
  const names = (value: unknown, path: string, max: number = L.names): CastText[] => {
    const items = texts(value, path, max, L.name);
    if (items.length < 1) fail(path);
    return items;
  };
  const character = (item: unknown, path: string): CastCharacter => {
    const v = object(item, path, [
      'characterId',
      'identity',
      'profile',
      'personality',
      'speech',
      'experiences',
      'performance',
      'hidden',
      'unmapped',
    ]);
    if (typeof v.characterId !== 'string' || !ID.test(v.characterId)) fail(`${path}.characterId`);
    const identity = object(v.identity, `${path}.identity`, [
      'oneLiner',
      'names',
      'aliases',
      'selfConcept',
      'prototype',
    ]);
    const speech = object(v.speech, `${path}.speech`, ['catchphrases', 'samples', 'avoid']);
    let prototype: CastCharacter['identity']['prototype'] = null;
    if (identity.prototype !== null) {
      const p = object(identity.prototype, `${path}.identity.prototype`, ['personId', 'inherited', 'notInherited']);
      if (typeof p.personId !== 'string' || !ID.test(p.personId)) fail(`${path}.identity.prototype.personId`);
      prototype = {
        personId: ref(p.personId as string),
        inherited: text(p.inherited, `${path}.identity.prototype.inherited`, L.prototypeText, { multiline: true }),
        notInherited: text(p.notInherited, `${path}.identity.prototype.notInherited`, L.prototypeText, {
          multiline: true,
        }),
      };
    }
    return {
      characterId: v.characterId as string,
      identity: {
        oneLiner: text(identity.oneLiner, `${path}.identity.oneLiner`, L.oneLiner),
        names: names(identity.names, `${path}.identity.names`),
        aliases: entries(identity.aliases, `${path}.identity.aliases`, L.aliases, (a, at): CastAlias => {
          const { value: x, id } = withId(a, at, ['text', 'attitude']);
          if (!(CAST_ALIAS_ATTITUDES as readonly unknown[]).includes(x.attitude)) fail(`${at}.attitude`);
          return {
            id,
            text: text(x.text, `${at}.text`, L.alias, { min: 1 }),
            attitude: x.attitude as CastAlias['attitude'],
          };
        }),
        selfConcept: text(identity.selfConcept, `${path}.identity.selfConcept`, L.selfConcept, { multiline: true }),
        prototype,
      },
      profile: text(v.profile, `${path}.profile`, L.profile, { multiline: true }),
      personality: text(v.personality, `${path}.personality`, L.personality, { multiline: true }),
      speech: {
        catchphrases: texts(speech.catchphrases, `${path}.speech.catchphrases`, L.catchphrases, L.catchphrase),
        samples: texts(speech.samples, `${path}.speech.samples`, L.samples, L.sample),
        avoid: texts(speech.avoid, `${path}.speech.avoid`, L.avoid, L.avoidText),
      },
      experiences: entries(v.experiences, `${path}.experiences`, L.experiences, (e, at): CastExperience => {
        const { value: x, id } = withId(e, at, ['title', 'text']);
        return {
          id,
          title: text(x.title, `${at}.title`, L.experienceTitle),
          text: text(x.text, `${at}.text`, L.experienceText, { multiline: true }),
        };
      }),
      performance: text(v.performance, `${path}.performance`, L.performance, { multiline: true }),
      hidden: texts(v.hidden, `${path}.hidden`, L.hidden, L.hiddenText),
      unmapped: text(v.unmapped, `${path}.unmapped`, L.unmapped, { multiline: true }),
    };
  };
  const person = (item: unknown, path: string): CastPerson => {
    const { value: v, id } = withId(item, path, ['kind', 'names', 'oneLiner']);
    if (v.kind !== 'person' && v.kind !== 'prototype') fail(`${path}.kind`);
    return {
      id,
      kind: v.kind as CastPerson['kind'],
      names: names(v.names, `${path}.names`, L.peopleNames),
      oneLiner: text(v.oneLiner, `${path}.oneLiner`, L.oneLiner),
    };
  };
  const ratingsRoot = root.ratings;
  if (ratingsRoot === null || typeof ratingsRoot !== 'object' || Array.isArray(ratingsRoot)) fail('doc.ratings');
  const ratings: Record<string, Record<string, number>> = {};
  for (const from of Object.keys(ratingsRoot as Obj).sort()) {
    const row = (ratingsRoot as Obj)[from];
    if (!ID.test(from) || row === null || typeof row !== 'object' || Array.isArray(row)) fail(`doc.ratings.${from}`);
    const out: Record<string, number> = {};
    for (const to of Object.keys(row as Obj)) {
      const value = (row as Obj)[to];
      // Values and the grid are checked by validateCastDoc (so the editor gets a code and a path); here only the type.
      if (!ID.test(to) || typeof value !== 'number' || !Number.isFinite(value)) fail(`doc.ratings.${from}.${to}`);
      out[ref(to)] = value as number;
    }
    ratings[ref(from)] = Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
  const direction = (item: unknown, path: string): CastDirection => {
    const { value: v, id } = withId(item, path, ['from', 'to', 'address', 'treatment']);
    if (typeof v.from !== 'string' || !ID.test(v.from)) fail(`${path}.from`);
    if (typeof v.to !== 'string' || !ID.test(v.to)) fail(`${path}.to`);
    return {
      id,
      from: ref(v.from as string),
      to: ref(v.to as string),
      address: text(v.address, `${path}.address`, L.address),
      treatment: text(v.treatment, `${path}.treatment`, L.treatment, { multiline: true }),
    };
  };
  const groupStory = (item: unknown, path: string): CastGroupStory => {
    const { value: v, id } = withId(item, path, ['title', 'summary', 'details', 'period', 'boundary']);
    return {
      id,
      title: text(v.title, `${path}.title`, L.storyTitle, { min: 1 }),
      summary: text(v.summary, `${path}.summary`, L.storySummary, { multiline: true }),
      details: text(v.details, `${path}.details`, L.storyDetails, { multiline: true }),
      period: period(v.period, `${path}.period`),
      boundary: text(v.boundary, `${path}.boundary`, L.storyBoundary, { multiline: true }),
    };
  };
  const group = (item: unknown, path: string): CastGroup => {
    const { value: v, id } = withId(item, path, ['name', 'members', 'background', 'stories']);
    return {
      id,
      name: text(v.name, `${path}.name`, L.groupName, { min: 1 }),
      members: idList(v.members, `${path}.members`, L.groupMembers),
      background: text(v.background, `${path}.background`, L.groupBackground, { multiline: true }),
      stories: entries(v.stories, `${path}.stories`, L.groupStories, groupStory),
    };
  };
  const story = (item: unknown, path: string): CastStory => {
    const { value: v, id } = withId(item, path, [
      'title',
      'summary',
      'details',
      'period',
      'participants',
      'boundary',
      'overrides',
    ]);
    return {
      id,
      title: text(v.title, `${path}.title`, L.storyTitle, { min: 1 }),
      summary: text(v.summary, `${path}.summary`, L.storySummary, { multiline: true }),
      details: text(v.details, `${path}.details`, L.storyDetails, { multiline: true }),
      period: period(v.period, `${path}.period`),
      participants: idList(v.participants, `${path}.participants`, L.storyParticipants).map(ref),
      boundary: text(v.boundary, `${path}.boundary`, L.storyBoundary, { multiline: true }),
      overrides: entries(v.overrides, `${path}.overrides`, L.storyOverrides, (o, at) => {
        const { value: x, id: oid } = withId(o, at, ['characterId', 'level']);
        if (typeof x.characterId !== 'string' || !ID.test(x.characterId)) fail(`${at}.characterId`);
        if (!(CAST_KNOWLEDGE as readonly unknown[]).includes(x.level)) fail(`${at}.level`);
        return {
          id: oid,
          characterId: x.characterId as string,
          level: x.level as CastStory['overrides'][number]['level'],
        };
      }),
    };
  };
  const meme = (item: unknown, path: string): CastMeme => {
    const { value: v, id } = withId(item, path, ['key', 'parties', 'meaning', 'trigger', 'prohibited']);
    return {
      id,
      key: text(v.key, `${path}.key`, L.memeKey, { min: 1 }),
      parties: idList(v.parties, `${path}.parties`, L.memeParties).map(ref),
      meaning: text(v.meaning, `${path}.meaning`, L.memeMeaning, { multiline: true }),
      trigger: text(v.trigger, `${path}.trigger`, L.memeTrigger, { multiline: true }),
      prohibited: text(v.prohibited, `${path}.prohibited`, L.memeProhibited, { multiline: true }),
    };
  };
  const doc: CastDoc = {
    schema: CAST_SCHEMA,
    world: { background: text(world.background, 'doc.world.background', L.worldBackground, { multiline: true }) },
    characters: entries(root.characters, 'doc.characters', L.chatCharacters, character),
    people: entries(root.people, 'doc.people', L.people, person),
    ratings: Object.fromEntries(Object.entries(ratings).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    directions: entries(root.directions, 'doc.directions', L.chatCharacters * (L.chatCharacters + L.people), direction),
    groups: entries(root.groups, 'doc.groups', L.groups, group),
    stories: entries(root.stories, 'doc.stories', L.stories, story),
    memes: entries(root.memes, 'doc.memes', L.memes, meme),
  };
  if (canonicalCastJson(doc).length > L.docMax) fail('doc');
  return doc;
}

/** The one stored spelling of a document: the key order normalizeCastDoc builds (ratings sorted). */
export const canonicalCastJson = (doc: CastDoc) => JSON.stringify(doc);

/** What validation needs to know about the character table. */
export interface CastCharacterLookup {
  /** Is there a character_templates row with this id? */
  exists(characterId: string): boolean;
  /** Has the character been deleted (a tombstone in web_character_deletions)? */
  deleted(characterId: string): boolean;
}

/**
 * `draft`: references to characters that do not exist yet (or were deleted) are WARNINGS. `publish`: they are ERRORS, and so is a
 * character whose view could not fit the cap even with every droppable part removed.
 */
export function validateCastDoc(
  doc: CastDoc,
  mode: 'draft' | 'publish',
  characters: CastCharacterLookup,
): CastValidation {
  const errors: CastIssue[] = [],
    warnings: CastIssue[] = [];
  const err = (code: string, path: string) => errors.push({ code, path });
  const L = CAST_LIMITS;
  const chat = new Set(doc.characters.map((c) => c.characterId));
  const people = new Set(doc.people.map((p) => p.id));
  const known = (id: string) => chat.has(id) || people.has(id);

  // ids: unique across the whole document, characters and people share one namespace
  const seen = new Set<string>();
  const once = (id: string, path: string) => {
    if (seen.has(id)) err('CAST_DUPLICATE_ID', path);
    seen.add(id);
  };
  doc.characters.forEach((c, i) => {
    once(c.characterId, `characters[${i}]`);
    for (const group of [
      c.identity.names,
      c.identity.aliases,
      c.speech.catchphrases,
      c.speech.samples,
      c.speech.avoid,
      c.experiences,
      c.hidden,
    ])
      for (const entry of group) once(entry.id, `characters[${c.characterId}]`);
  });
  doc.people.forEach((p, i) => {
    once(p.id, `people[${i}]`);
    for (const entry of p.names) once(entry.id, `people[${p.id}]`);
  });
  for (const d of doc.directions) once(d.id, `directions[${d.id}]`);
  for (const g of doc.groups) {
    once(g.id, `groups[${g.id}]`);
    for (const s of g.stories) once(s.id, `groups[${g.id}].stories[${s.id}]`);
  }
  for (const s of doc.stories) {
    once(s.id, `stories[${s.id}]`);
    for (const o of s.overrides) once(o.id, `stories[${s.id}].overrides[${o.id}]`);
  }
  for (const m of doc.memes) once(m.id, `memes[${m.id}]`);

  // prototypes
  for (const c of doc.characters) {
    const link = c.identity.prototype;
    if (link && !doc.people.some((p) => p.id === link.personId && p.kind === 'prototype'))
      err('CAST_UNKNOWN_PERSON', `characters[${c.characterId}].identity.prototype`);
  }

  // ratings: one-way, from a chat character to another chat character or person, never itself, on the 0.5 grid
  for (const [from, row] of Object.entries(doc.ratings)) {
    if (!chat.has(from)) err('CAST_UNKNOWN_CHARACTER', `ratings[${from}]`);
    for (const [to, value] of Object.entries(row)) {
      const path = `ratings[${from}][${to}]`;
      if (!known(to)) err('CAST_UNKNOWN_CHARACTER', path);
      if (from === to) err('CAST_SELF_RATING', path);
      if (!(value >= 0 && value <= 5 && Number.isInteger(value * 2))) err('CAST_RATING_OUT_OF_GRID', path);
    }
  }

  // directions: unique per (from, to)
  const pairs = new Set<string>();
  for (const d of doc.directions) {
    const path = `directions[${d.id}]`;
    if (!chat.has(d.from)) err('CAST_UNKNOWN_CHARACTER', `${path}.from`);
    if (!known(d.to)) err('CAST_UNKNOWN_CHARACTER', `${path}.to`);
    if (d.from === d.to) err('CAST_SELF_RELATION', path);
    if (pairs.has(`${d.from}\n${d.to}`)) err('CAST_DUPLICATE_DIRECTION', path);
    pairs.add(`${d.from}\n${d.to}`);
  }

  for (const g of doc.groups) {
    const path = `groups[${g.id}]`;
    g.members.forEach((id) => {
      if (!chat.has(id)) err('CAST_UNKNOWN_CHARACTER', `${path}.members`);
    });
    if (new Set(g.members).size !== g.members.length) err('CAST_DUPLICATE_MEMBER', `${path}.members`);
    if (g.members.length < 2) warnings.push({ code: 'CAST_GROUP_TOO_SMALL', path });
    for (const s of g.stories) if (!periodOrdered(s.period)) err('CAST_PERIOD_ORDER', `${path}.stories[${s.id}]`);
  }

  for (const s of doc.stories) {
    const path = `stories[${s.id}]`;
    s.participants.forEach((id) => {
      if (!known(id)) err('CAST_UNKNOWN_CHARACTER', `${path}.participants`);
    });
    if (new Set(s.participants).size !== s.participants.length)
      err('CAST_DUPLICATE_PARTICIPANT', `${path}.participants`);
    if (!periodOrdered(s.period)) err('CAST_PERIOD_ORDER', path);
    const overridden = new Set<string>();
    for (const o of s.overrides) {
      if (!chat.has(o.characterId)) err('CAST_UNKNOWN_CHARACTER', `${path}.overrides[${o.id}]`);
      if (overridden.has(o.characterId)) err('CAST_DUPLICATE_OVERRIDE', `${path}.overrides[${o.id}]`);
      overridden.add(o.characterId);
    }
  }

  for (const m of doc.memes) {
    m.parties.forEach((id) => {
      if (!known(id)) err('CAST_UNKNOWN_CHARACTER', `memes[${m.id}].parties`);
    });
    if (new Set(m.parties).size !== m.parties.length) err('CAST_DUPLICATE_PARTICIPANT', `memes[${m.id}].parties`);
  }

  // the characters themselves: they must exist and not be deleted before anything is published
  const absent = mode === 'publish' ? err : (code: string, path: string) => warnings.push({ code, path });
  for (const c of doc.characters) {
    const path = `characters[${c.characterId}]`;
    if (characters.deleted(c.characterId)) absent('CAST_CHARACTER_DELETED', path);
    else if (!characters.exists(c.characterId)) absent('CAST_CHARACTER_MISSING', path);
  }

  // names: a view refers to people by their first name
  const primary = new Map<string, number>();
  for (const name of [
    ...doc.characters.map((c) => c.identity.names[0]!.text),
    ...doc.people.map((p) => p.names[0]!.text),
  ])
    primary.set(name, (primary.get(name) ?? 0) + 1);
  if ([...primary.values()].some((n) => n > 1)) warnings.push({ code: 'CAST_DUPLICATE_NAME', path: 'doc' });

  // a view must fit with every droppable part removed (compileCastView drops stories, memes and relation texts first)
  if (errors.length === 0)
    for (const c of doc.characters)
      if (minimalViewSize(doc, c.characterId) > L.viewMax)
        (mode === 'publish' ? errors : warnings).push({
          code: 'CAST_VIEW_TOO_LARGE',
          path: `characters[${c.characterId}]`,
        });
  if (canonicalCastJson(doc).length > L.docMax) err('CAST_DOC_TOO_LARGE', 'doc');
  return { errors, warnings };
}

const periodOrdered = (p: CastPeriod) => p.start === '' || p.end === '' || p.start <= p.end;
