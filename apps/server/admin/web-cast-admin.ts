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
  replaceDraftWithImport,
  rollbackTo,
  saveDraft,
  validateDraft,
  latestPublication,
  type PublishOutcome,
} from '../cast/cast-store.ts';
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
