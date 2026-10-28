import { createHash } from 'node:crypto';
import type { CastDoc, CastRequestContext, CastValidation, CastView } from '../../../packages/contracts/web-cast.ts';
import { DetailedError, ensure } from '../../../packages/domain/errors.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import { castPromptHash } from '../generation/cast-prompt.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import {
  compileCastView,
  compileCastViewDetailed,
  castKnowledge,
  CAST_DROP_ORDER,
  type CastCompiled,
  type CastKnowledgeRow,
} from './cast-compile.ts';
import {
  canonicalCastJson,
  castEntryIds,
  emptyCastDoc,
  freshCastId,
  isEmptyCastDoc,
  normalizeCastDoc,
  validateCastDoc,
  type CastCharacterLookup,
} from './cast-validation.ts';

/**
 * Storage of the cast (Part 24a; tables from 129_cast.sql): the one draft row and the append-only publications. Nothing here
 * reads or writes a player table (chats, memory, relationships, scenes, points, stats): publishing and rolling back are cast-only.
 */
type Store = Pick<BusinessStore, 'get' | 'all' | 'run' | 'transaction'>;
type ReadStore = Pick<BusinessStore, 'get' | 'all'>;

export const castDigest = (value: string) => createHash('sha256').update(value).digest('hex');
export const castTablesExist = (store: Pick<BusinessStore, 'get'>) =>
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cast_draft'") &&
  !!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_cast_publications'");

export interface CastDraft {
  revision: number;
  doc: CastDoc;
  digest: string;
  updatedAt: number;
}
export interface CastPublication {
  version: number;
  doc: CastDoc;
  digest: string;
  publishedAt: number;
  kind: 'publish' | 'rollback';
  fromVersion: number | null;
}
/** Counts only: what the audit and the version list say about a document. */
export interface CastCounts {
  characters: number;
  people: number;
  groups: number;
  stories: number;
  memes: number;
}
export const castCounts = (doc: CastDoc): CastCounts => ({
  characters: doc.characters.length,
  people: doc.people.length,
  groups: doc.groups.length,
  stories: doc.stories.length,
  memes: doc.memes.length,
});

const parse = (json: string): CastDoc => {
  // A stored document went through normalizeCastDoc before it was written; reading it back re-normalizes with its own ids.
  const raw = JSON.parse(json) as unknown;
  const doc = normalizeCastDoc(raw, { known: castEntryIds(raw as CastDoc), fresh: freshCastId });
  ensure(canonicalCastJson(doc) === json, 'CAST_STORED_DOC_INVALID');
  return doc;
};

export function readDraft(store: ReadStore): CastDraft {
  const row = store.get<{ revision: number; doc_json: string; updated_at: number }>(
    'SELECT revision,doc_json,updated_at FROM web_cast_draft WHERE singleton=1',
  );
  ensure(row, 'CAST_UNAVAILABLE');
  return {
    revision: row.revision,
    doc: parse(row.doc_json),
    digest: castDigest(row.doc_json),
    updatedAt: row.updated_at,
  };
}

const publication = (row: {
  version: number;
  doc_json: string;
  digest: string;
  published_at: number;
  kind: 'publish' | 'rollback';
  from_version: number | null;
}): CastPublication => {
  ensure(castDigest(row.doc_json) === row.digest, 'CAST_STORED_DOC_INVALID');
  return {
    version: row.version,
    doc: parse(row.doc_json),
    digest: row.digest,
    publishedAt: row.published_at,
    kind: row.kind,
    fromVersion: row.from_version,
  };
};
export function latestPublication(store: ReadStore): CastPublication | null {
  const row = store.get<Parameters<typeof publication>[0]>(
    'SELECT * FROM web_cast_publications ORDER BY version DESC LIMIT 1',
  );
  return row ? publication(row) : null;
}
export function readPublication(store: ReadStore, version: number): CastPublication {
  const row = store.get<Parameters<typeof publication>[0]>(
    'SELECT * FROM web_cast_publications WHERE version=?',
    version,
  );
  ensure(row, 'NOT_FOUND');
  return publication(row);
}
export function listVersions(store: ReadStore) {
  return store
    .all<Parameters<typeof publication>[0]>('SELECT * FROM web_cast_publications ORDER BY version DESC')
    .map((row) => {
      const found = publication(row);
      return {
        version: found.version,
        kind: found.kind,
        fromVersion: found.fromVersion,
        digest: found.digest,
        publishedAt: found.publishedAt,
        counts: castCounts(found.doc),
      };
    });
}

/**
 * The character table as validation sees it. A character exists when it has a live template OR a saved draft (角色工作台's 新建角色):
 * a not-yet-live character may be in the cast (cards, stories, groups) and simply has no chat of its own, because castFreeze only
 * runs for a character that chats, and a chat needs the live template. A draft that is later discarded (and never went live)
 * makes the character missing again, which blocks the next publish.
 */
export const characterLookup = (store: ReadStore): CastCharacterLookup => ({
  exists: (id) =>
    !!store.get('SELECT 1 FROM character_templates WHERE id=?', id) ||
    (!!store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_character_drafts'") &&
      !!store.get('SELECT 1 FROM web_character_drafts WHERE character_id=?', id)),
  deleted: (id) => webCharacterDeleted(store as BusinessStore, id),
});

export function validateDraft(store: ReadStore, mode: 'draft' | 'publish'): CastValidation {
  return validateCastDoc(readDraft(store).doc, mode, characterLookup(store));
}

/** Compare-and-swap on the revision: a stale revision is refused with the current one. */
export function saveDraft(store: Store, now: number, expectedRevision: unknown, input: unknown) {
  ensure(Number.isSafeInteger(expectedRevision) && Number(expectedRevision) > 0, 'INVALID_REQUEST');
  return store.transaction(() => {
    const current = readDraft(store);
    if (current.revision !== expectedRevision)
      throw new DetailedError('CAST_REVISION_CONFLICT', { currentRevision: current.revision });
    const doc = normalizeCastDoc(input, { known: castEntryIds(current.doc), fresh: freshCastId });
    const validation = validateCastDoc(doc, 'draft', characterLookup(store));
    if (validation.errors.length) throw new DetailedError('CAST_INVALID', { issues: validation.errors });
    return writeDraft(store, now, current.revision, doc, validation);
  });
}
function writeDraft(store: Store, now: number, revision: number, doc: CastDoc, validation: CastValidation) {
  const json = canonicalCastJson(doc);
  const changed = store.run(
    'UPDATE web_cast_draft SET revision=revision+1,doc_json=?,updated_at=? WHERE singleton=1 AND revision=?',
    json,
    now,
    revision,
  );
  ensure(changed.changes === 1, 'CAST_REVISION_CONFLICT');
  return { revision: revision + 1, digest: castDigest(json), counts: castCounts(doc), validation };
}

export interface PublishOutcome {
  version: number;
  digest: string;
  kind: 'publish' | 'rollback';
  fromVersion: number | null;
  counts: CastCounts;
  warnings: number;
}
function appendPublication(
  store: Store,
  now: number,
  doc: CastDoc,
  kind: 'publish' | 'rollback',
  fromVersion: number | null,
  warnings: number,
): PublishOutcome {
  const json = canonicalCastJson(doc);
  const version = store.get<{ v: number }>('SELECT coalesce(max(version),0)+1 v FROM web_cast_publications')?.v ?? 1;
  store.run(
    'INSERT INTO web_cast_publications(version,doc_json,digest,published_at,kind,from_version) VALUES (?,?,?,?,?,?)',
    version,
    json,
    castDigest(json),
    now,
    kind,
    fromVersion,
  );
  return { version, digest: castDigest(json), kind, fromVersion, counts: castCounts(doc), warnings };
}

/** The whole draft becomes the next version. The caller names the draft revision it looked at. */
export function publishDraft(store: Store, now: number, expectedRevision: unknown): PublishOutcome {
  ensure(Number.isSafeInteger(expectedRevision) && Number(expectedRevision) > 0, 'INVALID_REQUEST');
  return store.transaction(() => {
    const draft = readDraft(store);
    if (draft.revision !== expectedRevision)
      throw new DetailedError('CAST_REVISION_CONFLICT', { currentRevision: draft.revision });
    const validation = validateCastDoc(draft.doc, 'publish', characterLookup(store));
    if (draft.doc.characters.length === 0) validation.errors.push({ code: 'CAST_EMPTY', path: 'doc.characters' });
    if (validation.errors.length) throw new DetailedError('CAST_PUBLISH_BLOCKED', { issues: validation.errors });
    return appendPublication(store, now, draft.doc, 'publish', null, validation.warnings.length);
  });
}

/**
 * Republishes an old version's document as a NEW version (kind=rollback, from_version = the old one). The old document is checked
 * again for everything except whether its characters still exist: a rollback is the emergency lever, and a character that was
 * deleted since can never be chatted with, so it only costs its card in the others' views (counted in `warnings`).
 */
export function rollbackTo(store: Store, now: number, version: unknown): PublishOutcome {
  ensure(Number.isSafeInteger(version) && Number(version) > 0, 'INVALID_REQUEST');
  return store.transaction(() => {
    const old = readPublication(store, Number(version));
    const validation = validateCastDoc(old.doc, 'publish', characterLookup(store));
    const blocking = validation.errors.filter(
      (e) => e.code !== 'CAST_CHARACTER_MISSING' && e.code !== 'CAST_CHARACTER_DELETED',
    );
    if (blocking.length) throw new DetailedError('CAST_PUBLISH_BLOCKED', { issues: blocking });
    return appendPublication(
      store,
      now,
      old.doc,
      'rollback',
      old.version,
      validation.warnings.length + validation.errors.length - blocking.length,
    );
  });
}

/** Replace the draft with a document built from the published characters (see cast-import.ts); CAS on the revision. */
export function replaceDraftWithImport(
  store: Store,
  now: number,
  input: { expectedRevision: unknown; overwrite: boolean },
  build: () => CastDoc,
) {
  ensure(Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0, 'INVALID_REQUEST');
  return store.transaction(() => {
    const current = readDraft(store);
    if (current.revision !== input.expectedRevision)
      throw new DetailedError('CAST_REVISION_CONFLICT', { currentRevision: current.revision });
    if (!isEmptyCastDoc(current.doc)) ensure(input.overwrite, 'CAST_DRAFT_NOT_EMPTY');
    const doc = build();
    const validation = validateCastDoc(doc, 'draft', characterLookup(store));
    if (validation.errors.length) throw new DetailedError('CAST_INVALID', { issues: validation.errors });
    return writeDraft(store, now, current.revision, doc, validation);
  });
}

export interface CastCompilePreview extends CastCompiled {
  source: { kind: 'draft'; revision: number } | { kind: 'published'; version: number };
  size: number;
  knowledge: CastKnowledgeRow[];
  /** The documented order in which a view over the cap gives things up (for the console to show). */
  dropOrder: readonly string[];
}
/** The view of one character from the draft or from a given (default: the latest) published version. */
export function compilePreview(
  store: ReadStore,
  characterId: string,
  source: { kind: 'draft' } | { kind: 'published'; version?: number },
): CastCompilePreview {
  let doc: CastDoc, label: CastCompilePreview['source'];
  if (source.kind === 'draft') {
    const draft = readDraft(store);
    doc = draft.doc;
    label = { kind: 'draft', revision: draft.revision };
  } else {
    const found = source.version === undefined ? latestPublication(store) : readPublication(store, source.version);
    ensure(found, 'NOT_FOUND');
    doc = found.doc;
    label = { kind: 'published', version: found.version };
  }
  const compiled = compileCastViewDetailed(doc, characterId);
  return {
    ...compiled,
    source: label,
    size: JSON.stringify(compiled.view).length,
    knowledge: castKnowledge(doc, characterId),
    dropOrder: CAST_DROP_ORDER,
  };
}

/** Is the cast context switched on for this store (CAST_CONTEXT_ENABLED, set by the business object)? */
export const castContextEnabled = (store: object) => (store as { castContext?: boolean }).castContext === true;

/**
 * What an operation freezes at its first text claim: the compiled view of the LATEST publication for this character, with the
 * publication version and the digest of the view's JSON - or null (the switch is off, nothing is published, or the character is
 * not in the published cast), in which case all three snapshot columns stay NULL.
 */
export function castFreeze(
  store: ReadStore,
  characterId: string,
): { version: number; json: string; digest: string } | null {
  if (!castContextEnabled(store) || !castTablesExist(store)) return null;
  const latest = latestPublication(store);
  if (!latest || !latest.doc.characters.some((c) => c.characterId === characterId)) return null;
  const json = JSON.stringify(compileCastView(latest.doc, characterId));
  return { version: latest.version, json, digest: castDigest(json) };
}

/** request.cast from a frozen snapshot: the view is read back from the frozen JSON, never recompiled. */
export function castRequestContext(snapshot: {
  cast_version?: number | null;
  cast_json?: string | null;
  cast_digest?: string | null;
}): CastRequestContext | undefined {
  if (snapshot.cast_json === null || snapshot.cast_json === undefined) return undefined;
  ensure(
    typeof snapshot.cast_version === 'number' &&
      typeof snapshot.cast_digest === 'string' &&
      castDigest(snapshot.cast_json) === snapshot.cast_digest,
    'WEB_V7_CAST_INVALID',
  );
  return {
    version: snapshot.cast_version,
    digest: snapshot.cast_digest,
    promptHash: castPromptHash(),
    view: JSON.parse(snapshot.cast_json) as CastView,
  };
}

/** Preview: the same compile as production, from the published cast, the draft, or none. */
export function castForPreview(
  store: ReadStore,
  characterId: string,
  source: 'none' | 'published' | 'draft',
): CastRequestContext | undefined {
  if (source === 'none') return undefined;
  ensure(castTablesExist(store), 'CAST_UNAVAILABLE');
  let doc: CastDoc, version: number;
  if (source === 'draft') {
    const draft = readDraft(store);
    doc = draft.doc;
    version = draft.revision;
  } else {
    const latest = latestPublication(store);
    ensure(latest, 'CAST_NOT_PUBLISHED');
    doc = latest.doc;
    version = latest.version;
  }
  ensure(
    doc.characters.some((c) => c.characterId === characterId),
    'CAST_CHARACTER_NOT_IN_CAST',
  );
  const json = JSON.stringify(compileCastView(doc, characterId));
  return {
    version,
    digest: castDigest(json),
    promptHash: castPromptHash(),
    view: JSON.parse(json) as CastView,
  };
}
