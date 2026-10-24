import { hasCastPermission, type CastAdminPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { buildLegacyCast } from '../cast/cast-import.ts';
import {
  castCounts,
  compilePreview,
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
}
