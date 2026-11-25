import {
  canCreateCharacter,
  hasCastPermission,
  type CastAdminPermission,
} from '../../../packages/contracts/web-admin-permissions.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { buildLegacyCast } from '../cast/cast-import.ts';
import { exportCastFile, type NewCharacter } from '../cast/cast-file.ts';
import {
  castCounts,
  compilePreview,
  importCastFile,
  previewCastFile,
  listVersions,
  publishDraft,
  readDraft,
  readPublication,
  replaceDraftWithImport,
  rollbackTo,
  saveDraft,
  validateDraft,
  latestPublication,
  type PublishOutcome,
} from '../cast/cast-store.ts';
import {
  addMeme,
  approveMemes,
  deleteMemes,
  dismissMemes,
  editMeme,
  enqueueUpload,
  listMemes,
  listQueue,
  restoreMemes,
  restoreOriginal,
  setMemesEnabled,
} from '../memes/web-meme-library.ts';
import { previewUpload, type MemeUpload } from '../memes/meme-import.ts';
import {
  MEME_STATES,
  isMemeCategory,
  isMemeSource,
  type MemeListInput,
  type MemeQueueView,
} from '../../../packages/contracts/web-memes.ts';
import { publishedWebCharacters } from '../characters/web-character-catalog.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WebCharacterAdmin } from '../characters/web-character-admin.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import { once, requestHash } from './web-admin-actions.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
const object = (value: unknown) => {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_REQUEST');
  return value as Record<string, unknown>;
};
const exactly = (value: unknown, keys: string[]) => {
  const body = object(value);
  ensure(Object.keys(body).sort().join(',') === [...keys].sort().join(','), 'INVALID_REQUEST');
  return body;
};
const short = (digest: string) => digest.slice(0, 12);

/**
 * 世界设定 (Part 24a, no console yet - that is 24b-2): the cast document's draft, its publications and the per-character view.
 * Every call needs the session, CSRF and Origin of any administrator write, then its own permission (cast.read / cast.edit /
 * cast.publish, or the owner role), THEN the body is read. Writes are idempotent per request id and leave one audit row; the audit
 * row, like everything stored about a call, carries the action, the version, the revision, counts and digests only: no cast text,
 * no email. The business object is the only writer, and nothing here reads or writes a player table.
 */
export class WebCastAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private characters: WebCharacterAdmin | null = null;
  /** The draft-character route of 角色工作台, for the cast file import. Without it a file with new characters is refused. */
  enableCharacters(characters: WebCharacterAdmin) {
    this.characters = characters;
  }
  constructor(store: BusinessStore, clock: Clock, admin: WebAccountAdmin) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
  }
  private actor(auth: Auth, need: CastAdminPermission) {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    ensure(
      actor.role === 'owner' || hasCastPermission(this.admin.session(auth.cookie).member.permissions, need),
      'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  /** Who may create a character: the owner, or a member holding characters.create. */
  private mayCreate(auth: Auth) {
    const session = this.admin.session(auth.cookie);
    return session.member.role === 'owner' || canCreateCharacter(session.member.permissions);
  }
  private audit(actorId: string, action: string, detail: string) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actorId,
      action,
      detail,
      this.clock.now(),
    );
  }
  private detail(parts: Record<string, string | number>) {
    return Object.entries(parts)
      .map(([key, value]) => `${key}=${value}`)
      .join(';');
  }

  /** The draft: document, revision and what is wrong with it as a draft (cast.read). */
  draft(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    exactly(input, []);
    const draft = readDraft(this.store);
    return {
      revision: draft.revision,
      digest: draft.digest,
      updatedAt: draft.updatedAt,
      doc: draft.doc,
      counts: castCounts(draft.doc),
      validation: validateDraft(this.store, 'draft'),
    };
  }

  /** Every published version, newest first: counts and digests, never text (cast.read). */
  versions(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    exactly(input, []);
    return { versions: listVersions(this.store), latest: latestPublication(this.store)?.version ?? null };
  }

  /** Part 24b-7: one stored version's document, exactly as stored (cast.read). A version that does not exist is NOT_FOUND. */
  version(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    const body = exactly(input, ['version']);
    ensure(Number.isSafeInteger(body.version) && (body.version as number) > 0, 'INVALID_REQUEST');
    const found = readPublication(this.store, body.version as number);
    return { version: found.version, digest: found.digest, doc: found.doc };
  }

  /** What would block publishing the draft right now (errors), and what is only a warning (cast.read). */
  validate(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    exactly(input, []);
    const draft = readDraft(this.store);
    return { revision: draft.revision, validation: validateDraft(this.store, 'publish') };
  }

  /** The compiled view of one character: from the draft, or from a published version (the latest by default). */
  compilePreview(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    const body = object(input);
    ensure(
      Object.keys(body).every((key) => ['characterId', 'source', 'version'].includes(key)) &&
        typeof body.characterId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(body.characterId) &&
        (body.source === 'draft' || body.source === 'published') &&
        (body.version === undefined || (body.source === 'published' && Number.isSafeInteger(body.version))),
      'INVALID_REQUEST',
    );
    return compilePreview(
      this.store,
      body.characterId,
      body.source === 'draft'
        ? { kind: 'draft' }
        : { kind: 'published', ...(body.version === undefined ? {} : { version: body.version as number }) },
    );
  }

  /** Save the draft (cast.edit). Compare-and-swap on the revision: a stale one is refused with the current revision. */
  save(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'cast.edit');
    const body = exactly(input, ['requestId', 'expectedRevision', 'doc']);
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'cast-save',
        hash: requestHash({ action: 'cast-save', expectedRevision: body.expectedRevision, doc: body.doc }),
        adminId: actor.memberId,
      },
      () => {
        const saved = saveDraft(this.store, now, body.expectedRevision, body.doc);
        this.audit(
          actor.memberId,
          'cast-draft-saved',
          this.detail({ revision: saved.revision, ...saved.counts, digest: short(saved.digest) }),
        );
        return saved;
      },
    );
  }

  /** Publish the whole draft as the next version (cast.publish). */
  publish(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'cast.publish');
    const body = exactly(input, ['requestId', 'expectedRevision']);
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'cast-publish',
        hash: requestHash({ action: 'cast-publish', expectedRevision: body.expectedRevision }),
        adminId: actor.memberId,
      },
      () => this.recorded(actor.memberId, 'cast-published', publishDraft(this.store, now, body.expectedRevision)),
    );
  }

  /** Republish an old version's document as a new version, kind=rollback (cast.publish). */
  rollback(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'cast.publish');
    const body = exactly(input, ['requestId', 'version']);
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'cast-rollback',
        hash: requestHash({ action: 'cast-rollback', version: body.version }),
        adminId: actor.memberId,
      },
      () => this.recorded(actor.memberId, 'cast-rolled-back', rollbackTo(this.store, now, body.version)),
    );
  }
  private recorded(actorId: string, action: string, outcome: PublishOutcome) {
    this.audit(
      actorId,
      action,
      this.detail({
        version: outcome.version,
        ...(outcome.fromVersion === null ? {} : { from: outcome.fromVersion }),
        ...outcome.counts,
        digest: short(outcome.digest),
      }),
    );
    return outcome;
  }

  /**
   * Build the draft from the published characters' authorCanon (cast.edit). Allowed when the draft is empty, or with
   * overwrite=true; always compare-and-swap on the revision. character_templates is never touched.
   */
  importLegacy(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'cast.edit');
    const body = exactly(input, ['requestId', 'expectedRevision', 'overwrite']);
    ensure(typeof body.overwrite === 'boolean', 'INVALID_REQUEST');
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'cast-import-legacy',
        hash: requestHash({
          action: 'cast-import-legacy',
          expectedRevision: body.expectedRevision,
          overwrite: body.overwrite,
        }),
        adminId: actor.memberId,
      },
      () => {
        let report: ReturnType<typeof buildLegacyCast>['report'] | undefined;
        const saved = replaceDraftWithImport(
          this.store,
          now,
          { expectedRevision: body.expectedRevision, overwrite: body.overwrite as boolean },
          () => {
            const built = buildLegacyCast(
              publishedWebCharacters(this.store).map((entry) => ({
                characterId: entry.characterId,
                displayName: entry.presentation.displayName,
                publicDescription: entry.presentation.publicDescription,
                template: entry.template,
              })),
            );
            report = built.report;
            return built.doc;
          },
        );
        this.audit(
          actor.memberId,
          'cast-draft-imported',
          this.detail({
            revision: saved.revision,
            ...saved.counts,
            overrides: report?.overrides ?? 0,
            unmapped: report?.withUnmapped ?? 0,
            digest: short(saved.digest),
          }),
        );
        return { ...saved, report: report! };
      },
    );
  }

  /**
   * 网络梗 (Part 37c-1, cast.read): the library (the shipped entries re-curated + the owner's own), filtered and paged: text over term,
   * meaning, category and tags; year; tag; category; source; on / off / 默认关闭 / 已删除. Part 37c-1b adds the optional `category` and
   * `source`. Dictionary data only: no player, no id, no message.
   */
  memesList(auth: Auth, input: unknown): ReturnType<typeof listMemes> {
    this.actor(auth, 'cast.read');
    const body = object(input);
    const keys = Object.keys(body).filter(
      (key) => !(key === 'category' || key === 'source') || body[key] !== undefined,
    );
    ensure(
      ['query', 'year', 'tag', 'state', 'page'].every((key) => keys.includes(key)) &&
        keys.every((key) => ['query', 'year', 'tag', 'state', 'page', 'category', 'source'].includes(key)),
      'INVALID_REQUEST',
    );
    ensure(
      typeof body.query === 'string' &&
        body.query.length <= 100 &&
        (body.year === null || (Number.isSafeInteger(body.year) && (body.year as number) >= 1900)) &&
        (body.tag === null || (typeof body.tag === 'string' && body.tag.length <= 40)) &&
        (MEME_STATES as readonly unknown[]).includes(body.state) &&
        (body.category === undefined || body.category === null || isMemeCategory(body.category)) &&
        (body.source === undefined || body.source === null || isMemeSource(body.source)) &&
        Number.isSafeInteger(body.page) &&
        (body.page as number) >= 1,
      'INVALID_REQUEST',
    );
    return listMemes(this.store, body as unknown as MemeListInput);
  }

  /** The 待审 queue (cast.read): terms, meanings, categories, sources and dates; what the library holds under the same term. */
  memesQueue(auth: Auth, input: unknown): MemeQueueView {
    this.actor(auth, 'cast.read');
    exactly(input, []);
    return listQueue(this.store);
  }

  /**
   * One owner write of the library, the same way every time: the session, CSRF and Origin, cast.edit, THEN the body; idempotent per
   * request id (the same id with other content is IDEMPOTENCY_CONFLICT); one audit row with the action and counts, never a term. It is
   * LIVE for the next reply (not through a 草稿 or a 发布); a reply in flight keeps the entries it froze.
   */
  private memesWrite<T extends object>(
    auth: Auth,
    input: unknown,
    action: string,
    fields: string[],
    run: (body: Record<string, unknown>, now: number) => T,
    count: (result: T, body: Record<string, unknown>) => Record<string, string | number>,
  ) {
    const actor = this.actor(auth, 'cast.edit');
    const body = exactly(input, ['requestId', ...fields]);
    const now = this.clock.now();
    const { requestId: _id, ...content } = body;
    return once(
      this.store,
      now,
      { requestId: body.requestId, action, hash: requestHash({ action, content }), adminId: actor.memberId },
      () => {
        const result = run(body, now);
        this.audit(actor.memberId, action, this.detail(count(result, body)));
        return result;
      },
    );
  }
  private termList(value: unknown, max = 2_000) {
    ensure(
      Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= max &&
        value.every((key) => typeof key === 'string' && key.length >= 1 && key.length <= 160),
      'INVALID_REQUEST',
    );
    return value as string[];
  }

  /** Switch entries on or off (cast.edit); shipped or own. The audit row says how many entries changed and the direction. */
  memesSet(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-set',
      ['keys', 'enabled'],
      (body, now) => {
        const keys = this.termList(body.keys);
        ensure(typeof body.enabled === 'boolean', 'INVALID_REQUEST');
        return { changed: setMemesEnabled(this.store, now, keys, body.enabled as boolean) };
      },
      (r, body) => ({ enabled: body.enabled ? 1 : 0, changed: r.changed, asked: (body.keys as unknown[]).length }),
    );
  }
  /** Add one own entry (default on). A duplicate term is refused (MEME_DUPLICATE, with the existing entry's key), a full library too. */
  memesAdd(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-add',
      ['term', 'meaning', 'category', 'year'],
      (body, now) =>
        addMeme(this.store, now, body as { term: unknown; meaning: unknown; category: unknown; year: unknown }),
      () => ({ added: 1 }),
    );
  }
  /** Edit the meaning and the category of any entry (a shipped one gets an override). */
  memesEdit(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-edit',
      ['key', 'meaning', 'category'],
      (body, now) => editMeme(this.store, now, body as { key: unknown; meaning: unknown; category: unknown }),
      () => ({ edited: 1 }),
    );
  }
  /** 恢复原文: the shipped meaning and category again, for shipped entries. */
  memesRestoreOriginal(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-restore-original',
      ['keys'],
      (body) => ({ changed: restoreOriginal(this.store, this.termList(body.keys)) }),
      (r) => ({ changed: r.changed }),
    );
  }
  /** Delete entries, single or bulk: own ones for good, shipped ones into 已删除. */
  memesDelete(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-delete',
      ['keys'],
      (body, now) => deleteMemes(this.store, now, this.termList(body.keys)),
      (r) => ({ changed: r.changed, own: r.own }),
    );
  }
  /** Put shipped entries back from 已删除. */
  memesRestore(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-restore',
      ['keys'],
      (body) => restoreMemes(this.store, this.termList(body.keys)),
      (r) => ({ changed: r.changed }),
    );
  }

  private upload(value: unknown): MemeUpload {
    const body = object(value);
    ensure(
      (body.kind === 'text' &&
        typeof body.text === 'string' &&
        body.text.length <= 1_500_000 &&
        Object.keys(body).length === 2) ||
        (body.kind === 'xlsx' &&
          typeof body.base64 === 'string' &&
          body.base64.length <= 3_200_000 &&
          Object.keys(body).length === 2),
      'INVALID_REQUEST',
    );
    return body as unknown as MemeUpload;
  }
  /** What an upload would do, row by row; nothing is saved (cast.edit, like the import itself). */
  memesImportPreview(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.edit');
    const body = exactly(input, ['upload']);
    return previewUpload(this.store, this.upload(body.upload));
  }
  /** The rows of an upload that pass go to the 待审 queue (source 上传); nothing enters the library. Rows that do not pass stay in the preview. */
  memesImport(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-import',
      ['upload'],
      (body, now) => {
        const preview = previewUpload(this.store, this.upload(body.upload));
        const queued = enqueueUpload(
          this.store,
          now,
          preview.rows.filter((row) => row.status === 'ok' || row.status === 'update' || row.status === 'revive'),
        );
        return { queued, counts: preview.counts };
      },
      (r) => ({ queued: r.queued, invalid: r.counts.invalid, unchanged: r.counts.unchanged }),
    );
  }
  /** 通过: queue items (with the owner's edits of meaning and category) enter the library, on. */
  memesApprove(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-approve',
      ['items'],
      (body, now) => {
        ensure(Array.isArray(body.items), 'INVALID_REQUEST');
        const items = (body.items as unknown[]).map((raw) => {
          const item = object(raw);
          ensure(
            typeof item.term === 'string' &&
              Object.keys(item).every((key) => ['term', 'newTerm', 'meaning', 'category'].includes(key)) &&
              ['meaning', 'category'].every((key) => key in item) &&
              (item.newTerm === undefined || typeof item.newTerm === 'string'),
            'INVALID_REQUEST',
          );
          return {
            term: item.term as string,
            ...(item.newTerm === undefined ? {} : { newTerm: item.newTerm }),
            meaning: item.meaning,
            category: item.category,
          };
        });
        return approveMemes(this.store, now, items);
      },
      (r) => ({ changed: r.changed, updated: r.updated, revived: r.revived }),
    );
  }
  /** 不要: queue items are dismissed; an automatic source never suggests the term again. */
  memesDismiss(auth: Auth, input: unknown) {
    return this.memesWrite(
      auth,
      input,
      'memes-dismiss',
      ['terms'],
      (body, now) => dismissMemes(this.store, now, this.termList(body.terms)),
      (r) => ({ changed: r.changed }),
    );
  }

  /** The current draft as a cast file, to start from or to keep (cast.read). Existing characters by id; no workbench blocks. */
  exportFile(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.read');
    exactly(input, []);
    const draft = readDraft(this.store);
    return { revision: draft.revision, digest: draft.digest, file: exportCastFile(draft.doc) };
  }

  /** What importing a file would do, without saving anything (cast.edit, like the import itself). */
  importPreview(auth: Auth, input: unknown) {
    this.actor(auth, 'cast.edit');
    const body = exactly(input, ['file']);
    const preview = previewCastFile(this.store, body.file);
    if (!this.mayCreate(auth) && preview.created.some((c) => !c.matched))
      preview.problems.push({
        code: 'CAST_FILE_NO_CREATE',
        path: 'doc.characters',
        who: null,
        text: '没有新建角色的权限，文件里却有新角色',
      });
    return {
      ...preview,
      importable: preview.importable && !preview.problems.some((p) => p.code === 'CAST_FILE_NO_CREATE'),
    };
  }

  /**
   * Import a cast file into the DRAFT (cast.edit; characters.create too when the file has new characters). One transaction: the
   * draft characters of the `new:` keys, the key rewrite and the compare-and-swap save of the draft commit or vanish together.
   * Idempotent per request id. Never publishes. The audit row says what happened in counts and a digest, nothing of the content.
   */
  importFile(auth: Auth, input: unknown) {
    const actor = this.actor(auth, 'cast.edit');
    const body = exactly(input, ['requestId', 'expectedRevision', 'file']);
    const now = this.clock.now();
    return once(
      this.store,
      now,
      {
        requestId: body.requestId,
        action: 'cast-import-file',
        hash: requestHash({ action: 'cast-import-file', expectedRevision: body.expectedRevision, file: body.file }),
        adminId: actor.memberId,
      },
      () => {
        const saved = importCastFile(this.store, now, {
          expectedRevision: body.expectedRevision,
          file: body.file,
          create: (character) => {
            ensure(this.characters, 'CAST_FILE_NO_CREATE');
            ensure(this.mayCreate(auth), 'ADMIN_PERMISSION_REQUIRED');
            this.characters.createDraftForCast(
              { memberId: actor.memberId, sessionId: actor.sessionId },
              newCharacterProfile(character),
              now,
            );
          },
        });
        this.audit(
          actor.memberId,
          saved.unchanged ? 'cast-file-import-unchanged' : 'cast-file-imported',
          this.detail({
            revision: saved.revision,
            ...saved.counts,
            created: saved.created,
            digest: short(saved.digest),
          }),
        );
        return saved;
      },
    );
  }
}

/** The first draft of a character a cast file creates: the blank one of 新建角色 with the file's workbench seed. */
function newCharacterProfile(character: NewCharacter) {
  const days: Record<number, unknown[]> = {};
  for (let day = 0; day < 7; day++) days[day] = [{ startMinute: 0, endMinute: 1440, probability: 1, catchUp: true }];
  return {
    template: {
      id: character.id,
      name: character.name,
      version: 1,
      fictional: true,
      persona: character.workbench.persona,
      schedule: { timeZone: 'Asia/Singapore', days },
    },
    presentation: {
      displayName: character.workbench.displayName,
      publicDescription: '',
      welcome: { text: character.workbench.welcome, version: 'welcome-v1' },
    },
  };
}
