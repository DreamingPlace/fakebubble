import {
  CAST_FILE_FORMAT,
  CAST_FILE_LIMITS,
  CAST_FILE_NEW_PREFIX,
  CAST_FILE_VERSION,
  CAST_LIMITS,
  type CastDoc,
  type CastFileProblem,
  type CastFileSummary,
  type CastFileViewReport,
  type CastIssue,
  type CastWorkbenchSeed,
} from '../../../packages/contracts/web-cast.ts';
import { ISSUE_LABEL, humanIssue } from '../../../packages/contracts/web-cast-text.ts';
import { DetailedError } from '../../../packages/domain/errors.ts';
import { compileCastViewDetailed } from './cast-compile.ts';
import {
  canonicalCastJson,
  freshCastId,
  normalizeCastDoc,
  validateCastDoc,
  type CastCharacterLookup,
} from './cast-validation.ts';

/**
 * The cast file (Part 24b-5), read the same way by the server (preview and import) and by scripts/cast-file.ts (Codex's local
 * check): header, `new:<name>` characters, the optional `workbench` seed of a new character, then the ordinary cast rules of
 * cast-validation.ts. Nothing here writes anything; it only turns a file into a document, a summary and a list of problems.
 *
 * Problems come in three kinds. `problems` stop the import (a draft can't hold them). `publishBlockers` do not stop it - the draft
 * saves - but the cast could not be published until they are fixed. `warnings` never block anything.
 */
type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const CONTROL = /[\u0000-\u001f\u007f]/u;
const PERSON_TOKEN = /^new-[A-Za-z0-9_-]{1,64}$/;
const HEADER_KEYS = ['format', 'version'];
const DOC_KEYS = ['schema', 'world', 'characters', 'people', 'ratings', 'directions', 'groups', 'stories', 'memes'];
/** Characters that are not in the file's own words as plain text: the cap on what a person has to read in a report. */
const MISSING = new Set(['CAST_CHARACTER_MISSING', 'CAST_CHARACTER_DELETED']);

export interface NewCharacter {
  /** The `new:<name>` key as written in the file. */
  key: string;
  /** The id it was given (or, when `matched`, the id of the draft character it already is). */
  id: string;
  name: string;
  workbench: CastWorkbenchSeed;
  /** A draft character of that name is already in the cast: nothing is created for it. */
  matched: boolean;
}
export interface PrepareInput {
  /** The draft as it is now. Null for the local check, where no draft exists. */
  current: CastDoc | null;
  /** The entry ids a file may carry (the draft's own; for the local check, every id the file carries). */
  known: ReadonlySet<string>;
  lookup: CastCharacterLookup;
  /** An id for each new character. */
  newId: () => string;
  /** The ids of entries the file leaves without one. */
  entryId?: () => string;
}
export interface PreparedCastFile {
  /** The document with every key rewritten, or null when the file could not be read as one. */
  doc: CastDoc | null;
  created: NewCharacter[];
  problems: CastFileProblem[];
  publishBlockers: CastFileProblem[];
  warnings: CastFileProblem[];
  summary: CastFileSummary | null;
  views: CastFileViewReport[];
  /** Nothing stops the import. */
  importable: boolean;
}

/** Entry ids a file carries, anywhere: what the local check (which has no draft to compare with) accepts as already known. */
export function idsInFile(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) idsInFile(item, into);
  else if (isObj(value))
    for (const [key, item] of Object.entries(value)) {
      // A `new-…` person is a token to be given an id, not an id the file already has.
      if (key === 'id' && typeof item === 'string') {
        if (!PERSON_TOKEN.test(item)) into.add(item);
      } else if (key !== 'ratings') idsInFile(item, into);
    }
  return into;
}

const stripIds = (value: unknown): string => JSON.stringify(value, (key, item) => (key === 'id' ? undefined : item));

function workbenchSeed(value: unknown, name: string, issue: (code: string) => void): CastWorkbenchSeed {
  const fallback: CastWorkbenchSeed = {
    displayName: name.slice(0, CAST_FILE_LIMITS.displayName),
    persona: `${name}是一个虚构人物，设定待补充。`,
    welcome: `你好，我是${name}。`,
  };
  if (value === undefined) return fallback;
  if (!isObj(value) || Object.keys(value).some((key) => !['displayName', 'persona', 'welcome'].includes(key))) {
    issue('CAST_FILE_WORKBENCH');
    return fallback;
  }
  const field = (key: keyof CastWorkbenchSeed, max: number) => {
    const given = value[key];
    if (given === undefined) return fallback[key];
    if (typeof given !== 'string' || !given.trim() || given.length > max || CONTROL.test(given)) {
      issue('CAST_FILE_WORKBENCH');
      return fallback[key];
    }
    return given;
  };
  return {
    displayName: field('displayName', CAST_FILE_LIMITS.displayName),
    persona: field('persona', CAST_FILE_LIMITS.persona),
    welcome: field('welcome', CAST_FILE_LIMITS.welcome),
  };
}

/**
 * Rewrites every reference site of a document through `map` (new-character keys and matched person tokens to real ids).
 * `dangling(path)` is told about each `new:` key that is used but never defined as a character of the file.
 */
function rewrite(doc: Obj, map: ReadonlyMap<string, string>, dangling: (path: string) => void) {
  let at = '';
  const to = (value: unknown) => {
    if (typeof value !== 'string') return value;
    if (!map.has(value) && value.startsWith(CAST_FILE_NEW_PREFIX)) dangling(at);
    return map.get(value) ?? value;
  };
  const each = (value: unknown, one: (item: Obj, index: number) => void) => {
    if (Array.isArray(value)) value.forEach((item, index) => isObj(item) && one(item, index));
  };
  each(doc.characters, (c, i) => {
    at = `doc.characters[${i}]`;
    c.characterId = to(c.characterId);
    if (isObj(c.identity) && isObj(c.identity.prototype))
      c.identity.prototype.personId = to(c.identity.prototype.personId);
  });
  each(doc.people, (p, i) => {
    at = `doc.people[${i}]`;
    p.id = to(p.id);
  });
  if (isObj(doc.ratings)) {
    const out: Obj = {};
    for (const [from, row] of Object.entries(doc.ratings)) {
      at = 'doc.ratings';
      if (!isObj(row)) {
        out[to(from) as string] = row;
        continue;
      }
      out[to(from) as string] = Object.fromEntries(Object.entries(row).map(([target, value]) => [to(target), value]));
    }
    doc.ratings = out;
  }
  each(doc.directions, (d, i) => {
    at = `doc.directions[${i}]`;
    d.from = to(d.from);
    d.to = to(d.to);
  });
  const ids = (list: unknown) => (Array.isArray(list) ? list.map(to) : list);
  each(doc.groups, (g, i) => {
    at = `doc.groups[${i}].members`;
    g.members = ids(g.members);
  });
  each(doc.stories, (s, i) => {
    at = `doc.stories[${i}].participants`;
    s.participants = ids(s.participants);
    each(s.overrides, (o, j) => {
      at = `doc.stories[${i}].overrides[${j}]`;
      o.characterId = to(o.characterId);
    });
  });
  each(doc.memes, (m, i) => {
    at = `doc.memes[${i}].parties`;
    m.parties = ids(m.parties);
  });
}

const ratingPairs = (doc: CastDoc) => Object.values(doc.ratings).reduce((n, row) => n + Object.keys(row).length, 0);

export function prepareCastFile(file: unknown, input: PrepareInput): PreparedCastFile {
  const problems: CastFileProblem[] = [],
    warnings: CastFileProblem[] = [],
    publishBlockers: CastFileProblem[] = [];
  const result = (extra: Partial<PreparedCastFile> = {}): PreparedCastFile => ({
    doc: null,
    created: [],
    problems,
    publishBlockers,
    warnings,
    summary: null,
    views: [],
    importable: false,
    ...extra,
  });
  /** Names a problem with the document it is about (any shape: the document may not have passed the shape check yet). */
  const note = (list: CastFileProblem[], about: CastDoc | null, code: string, path: string) => {
    const { who, where } = about ? humanIssue(about, path) : { who: null, where: '' };
    const label = ISSUE_LABEL[code] ?? code;
    list.push({ code, path, who, text: where ? `${label}（${where}）` : label });
  };

  if (!isObj(file)) {
    note(problems, null, 'CAST_FILE_HEADER', 'file');
    return result();
  }
  if (file.format !== CAST_FILE_FORMAT || file.version !== CAST_FILE_VERSION)
    note(problems, null, 'CAST_FILE_HEADER', 'file');
  for (const key of Object.keys(file))
    if (![...HEADER_KEYS, ...DOC_KEYS].includes(key)) note(problems, null, 'CAST_SHAPE', `file.${key}`);
  if (file.schema !== 1) note(problems, null, 'CAST_SHAPE', 'doc.schema');
  if (problems.length) return result();

  // The document part. Collections a file may leave out are empty.
  // A copy: keys are rewritten in place below, and the caller's file (which the request hash was made from) must stay as it came.
  const raw: Obj = structuredClone({
    schema: file.schema,
    world: file.world ?? { background: '' },
    characters: file.characters ?? [],
    people: file.people ?? [],
    ratings: file.ratings ?? {},
    directions: file.directions ?? [],
    groups: file.groups ?? [],
    stories: file.stories ?? [],
    memes: file.memes ?? [],
  });
  const shell = raw as unknown as CastDoc;

  // New characters: pull the workbench block out, give each key an id (or find the draft character it already is).
  const created: NewCharacter[] = [];
  const map = new Map<string, string>();
  const claimed = new Set<string>();
  if (Array.isArray(raw.characters)) {
    raw.characters = raw.characters.map((entry: unknown, index: number) => {
      if (!isObj(entry)) return entry;
      const { workbench, ...character } = entry;
      const key = character.characterId;
      const at = `doc.characters[${index}]`;
      if (typeof key !== 'string' || !key.startsWith(CAST_FILE_NEW_PREFIX)) {
        if (workbench !== undefined) note(warnings, shell, 'CAST_FILE_WORKBENCH_IGNORED', at);
        return character;
      }
      const bare = key.slice(CAST_FILE_NEW_PREFIX.length);
      if (!bare || bare.length > CAST_FILE_LIMITS.newKey || CONTROL.test(bare)) {
        note(problems, shell, 'CAST_FILE_NEW_KEY', at);
        return character;
      }
      if (map.has(key)) {
        note(problems, shell, 'CAST_DUPLICATE_ID', at);
        return character;
      }
      const names =
        isObj(character.identity) && Array.isArray(character.identity.names) ? character.identity.names : [];
      const first = isObj(names[0]) && typeof names[0].text === 'string' ? names[0].text : bare;
      // Imported twice, the same file must not make the same character twice: a draft character with that first name is it.
      const same = input.current?.characters.find(
        (c) => c.identity.names[0]?.text === first && !claimed.has(c.characterId),
      );
      const id = same ? same.characterId : input.newId();
      claimed.add(id);
      map.set(key, id);
      const seed = workbenchSeed(workbench, first, (code) => note(problems, shell, code, at));
      if (same && workbench !== undefined) note(warnings, shell, 'CAST_FILE_WORKBENCH_IGNORED', at);
      created.push({ key, id, name: first, workbench: seed, matched: !!same });
      return character;
    });
  }
  // A person written `new-…` that the draft already has (same first name and kind) is that person, not a second one.
  if (input.current && Array.isArray(raw.people))
    for (const person of raw.people) {
      if (
        !isObj(person) ||
        typeof person.id !== 'string' ||
        !PERSON_TOKEN.test(person.id) ||
        input.known.has(person.id)
      )
        continue;
      const first = Array.isArray(person.names) && isObj(person.names[0]) ? person.names[0].text : null;
      const same = input.current.people.find((p) => p.names[0]?.text === first && p.kind === person.kind);
      if (same) map.set(person.id, same.id);
    }
  rewrite(raw, map, (path) => note(problems, shell, 'CAST_FILE_NEW_UNDEFINED', path));
  if (problems.length) return result({ created });

  let doc: CastDoc;
  try {
    doc = normalizeCastDoc(raw, { known: input.known, fresh: input.entryId ?? freshCastId });
  } catch (error) {
    if (!(error instanceof DetailedError) || error.code !== 'CAST_INVALID') throw error;
    for (const issue of (error.detail.issues ?? []) as CastIssue[])
      note(problems, shell, issue.path.endsWith('.id') ? 'CAST_FILE_UNKNOWN_ID' : issue.code, issue.path);
    return result({ created });
  }
  // An id-less file that says what the draft already says is the draft: keep its ids, so the import changes nothing.
  if (input.current && stripIds(doc) === stripIds(input.current)) doc = input.current;

  const made = new Set(created.filter((c) => !c.matched).map((c) => c.id));
  const lookup: CastCharacterLookup = {
    exists: (id) => made.has(id) || input.lookup.exists(id),
    deleted: (id) => input.lookup.deleted(id),
  };
  const asDraft = validateCastDoc(doc, 'draft', lookup);
  for (const issue of asDraft.errors) note(problems, doc, issue.code, issue.path);
  for (const issue of asDraft.warnings) if (!MISSING.has(issue.code)) note(warnings, doc, issue.code, issue.path);
  const asPublished = validateCastDoc(doc, 'publish', lookup);
  const have = new Set(problems.map((p) => `${p.code}\n${p.path}`));
  for (const issue of asPublished.errors) {
    if (have.has(`${issue.code}\n${issue.path}`)) continue;
    // A character that does not exist can't be saved into a draft cast any more than published: it stops the import.
    note(MISSING.has(issue.code) ? problems : publishBlockers, doc, issue.code, issue.path);
  }
  if (!doc.characters.length) note(publishBlockers, doc, 'CAST_EMPTY', 'doc.characters');

  const views: CastFileViewReport[] = [];
  const nameOf = (id: string) => doc.characters.find((c) => c.characterId === id)?.identity.names[0]?.text ?? id;
  if (!problems.length)
    for (const c of doc.characters) {
      const full = compileCastViewDetailed(doc, c.characterId, Number.POSITIVE_INFINITY).view;
      const capped = compileCastViewDetailed(doc, c.characterId).view;
      const keep = new Set([
        ...capped.stories.map((s) => `${s.level}|${s.title}`),
        ...capped.groups.flatMap((g) => g.stories.map((s) => `组合|${g.name}|${s.title}`)),
        ...capped.memes.map((m) => `梗|${m.key}`),
      ]);
      const dropped = [
        ...full.memes.filter((m) => !keep.has(`梗|${m.key}`)).map((m) => `梗「${m.key}」`),
        ...full.stories.filter((s) => !keep.has(`${s.level}|${s.title}`)).map((s) => `${s.level}故事「${s.title}」`),
        ...full.groups.flatMap((g) =>
          g.stories
            .filter((s) => !keep.has(`组合|${g.name}|${s.title}`))
            .map((s) => `组合「${g.name}」的故事「${s.title}」`),
        ),
      ];
      const texts = (view: typeof full) =>
        view.relations.filter((r) => r.address !== undefined || r.treatment !== undefined).length;
      if (texts(full) > texts(capped)) dropped.push(`${texts(full) - texts(capped)} 条称呼与相处`);
      views.push({
        name: nameOf(c.characterId),
        size: JSON.stringify(full).length,
        finalSize: JSON.stringify(capped).length,
        max: CAST_LIMITS.viewMax,
        dropped,
      });
    }

  const before = new Map((input.current?.characters ?? []).map((c) => [c.characterId, c]));
  const after = new Set(doc.characters.map((c) => c.characterId));
  const summary: CastFileSummary = {
    charactersAdded: doc.characters.filter((c) => !before.has(c.characterId)).map((c) => nameOf(c.characterId)),
    charactersChanged: doc.characters
      .filter((c) => before.has(c.characterId) && stripIds(before.get(c.characterId)) !== stripIds(c))
      .map((c) => nameOf(c.characterId)),
    charactersRemoved: [...before.values()]
      .filter((c) => !after.has(c.characterId))
      .map((c) => c.identity.names[0]?.text ?? ''),
    people: doc.people.length,
    ratings: ratingPairs(doc),
    directions: doc.directions.length,
    groups: doc.groups.length,
    stories: doc.stories.length,
    memes: doc.memes.length,
    unchanged: !!input.current && canonicalCastJson(input.current) === canonicalCastJson(doc),
  };
  return result({ doc, created, summary, views, importable: problems.length === 0 });
}

/** Turns a stored draft into the file spelling: header first, every entry with its id. The workbench block is never exported. */
export function exportCastFile(doc: CastDoc) {
  return { format: CAST_FILE_FORMAT, version: CAST_FILE_VERSION, ...doc };
}
