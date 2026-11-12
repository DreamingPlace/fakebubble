import type { WebCharacterDeletion } from './web-character-deletion.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import {
  canCreateCharacter,
  hasCastPermission,
  hasCharacterPermission,
  type CharacterAdminAction,
} from '../../../packages/contracts/web-admin-permissions.ts';
import { DetailedError, DomainError, ensure } from '../../../packages/domain/errors.ts';
import { upgradeWelcomes, welcomeProblems, welcomeTextProblem } from '../../../packages/contracts/web-welcomes.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { identifier, keys, nonempty, record, validatedTemplate } from './template-validation.ts';
import {
  characterProfileHash,
  offlineWebCharacters,
  publishedWebCharacters,
  webCharacterAtLive,
  upgradedProfile,
  type StoredWebCharacterProfile,
  type WebCharacterProfile,
} from './web-character-catalog.ts';
import {
  installWebAvailability,
  orderGroup,
  savedOrder,
  saveGroupOrder,
  setWebCharacterAvailability,
  SIDEBAR_GROUPS,
  type SidebarGroup,
} from './web-character-availability.ts';
import { WebCharacterPreviews, readWebPreview, webPreviewDTO } from './web-character-preview.ts';
import { WebReviewCompare } from './web-review-compare.ts';
import { publishWebCharacter } from './web-character-publication.ts';
import { characterHistory, characterVersion, restoreWebCharacter } from './web-character-history.ts';
import { draftHistory } from './web-character-draft-history.ts';
import {
  evalSetDelete,
  evalSetList,
  evalSetSave,
  previewDetail,
  previewsStatus,
  runDetail,
  runList,
} from './web-character-preview-read.ts';

import { WebCharacterMaterials } from './web-character-materials.ts';
import { WebClipTakes } from './web-clip-takes.ts';
import type { WebClipDirection } from './web-clip-direction.ts';
import type { WebAdminSpeech } from './web-admin-speech.ts';
import { effectiveVoice, footerRequired, siteVoiceModel } from './web-clip-manifest.ts';
import { WebProfileImport, type ImportContext } from './web-profile-import.ts';
import { checklistOf, codeOf } from './web-profile-schema.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
type DraftRow = {
  character_id: string;
  revision: number;
  base_version: number | null;
  profile_json: string;
  content_hash: string;
  created_at: number;
};
const draftDTO = (row: DraftRow) => ({
  characterId: row.character_id,
  revision: row.revision,
  baseVersion: row.base_version,
  // Old drafts upgrade in memory; contentHash stays the hash of the stored bytes.
  profile: upgradedProfile(JSON.parse(row.profile_json) as StoredWebCharacterProfile),
  contentHash: row.content_hash,
  savedAt: row.created_at,
});

/**
 * Part 24k-2: the lines of a saved profile. `welcomes` (1-8 weighted lines, summing to 100) is the format; the old single
 * `welcome {text, version}` is still accepted as input and becomes one line of weight 100. A refusal names the line.
 */
function welcomeLines(display: Record<string, unknown>) {
  ensure(display.welcomes !== undefined || display.welcome !== undefined, 'INVALID_ADMIN_REQUEST');
  // A request that still carries the old `welcome` is an explicit edit of the one welcome: it replaces the whole list with one
  // line (a client that sends the new format never sends `welcome`).
  if (display.welcome !== undefined) {
    record(display.welcome);
    keys(display.welcome, ['text', 'version']);
    ensure(!welcomeTextProblem(display.welcome.text), 'INVALID_ADMIN_REQUEST');
    identifier(display.welcome.version);
    return upgradeWelcomes({ welcome: display.welcome });
  }
  const problems = welcomeProblems(display.welcomes);
  if (problems.length) throw new DetailedError('WELCOMES_INVALID', { problems });
  return (display.welcomes as { id: string; text: string; weight: number }[]).map((line) => {
    record(line);
    keys(line, ['id', 'text', 'weight']);
    return { id: line.id, text: line.text, weight: line.weight };
  });
}

function profile(value: unknown): WebCharacterProfile {
  record(value);
  keys(value, ['template', 'presentation']);
  const template = validatedTemplate(value.template),
    display = value.presentation;
  record(display);
  keys(display, ['displayName', 'publicDescription', 'welcome', 'welcomes', 'color', 'palette']);
  nonempty(display.displayName, 100);
  ensure(
    typeof display.publicDescription === 'string' && display.publicDescription.length <= 500,
    'INVALID_ADMIN_REQUEST',
  );
  const welcomes = welcomeLines(display);
  ensure(
    display.color === undefined || (typeof display.color === 'string' && /^#[0-9A-F]{6}$/.test(display.color)),
    'INVALID_ADMIN_REQUEST',
  );
  return {
    template,
    presentation: {
      displayName: display.displayName,
      publicDescription: display.publicDescription,
      welcomes,
      ...(display.color === undefined ? {} : { color: display.color }),
      ...(display.palette === undefined ? {} : { palette: palette(display.palette) }),
    },
  };
}
/** Parts 24j/24k-2: the template's colours: 1-5 entries (one 主 and up to 4 点缀) of {hex, name (<=24), role}; at most one 'main'. */
function palette(value: unknown): NonNullable<WebCharacterProfile['presentation']['palette']> {
  ensure(Array.isArray(value) && value.length > 0 && value.length <= 5, 'INVALID_ADMIN_REQUEST');
  const out = value.map((entry) => {
    record(entry);
    keys(entry, ['hex', 'name', 'role']);
    ensure(typeof entry.hex === 'string' && /^#[0-9A-F]{6}$/.test(entry.hex), 'INVALID_ADMIN_REQUEST');
    ensure(typeof entry.name === 'string' && entry.name.length <= 24, 'INVALID_ADMIN_REQUEST');
    ensure(entry.role === 'main' || entry.role === 'accent', 'INVALID_ADMIN_REQUEST');
    return { hex: entry.hex, name: entry.name, role: entry.role as 'main' | 'accent' };
  });
  const mains = out.filter((entry) => entry.role === 'main').length;
  ensure(mains <= 1, 'INVALID_ADMIN_REQUEST');
  return out;
}

/** Editing and static preview never generate or publish; publication is a separate guarded command. */
export class WebCharacterAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private deletion: WebCharacterDeletion | null = null;
  enableDeletion(deletion: WebCharacterDeletion) {
    this.deletion = deletion;
  }
  /** Part 24l: 下线 / 重新上线 and the per-admin sidebar order. Off (no tables) until enabled. */
  enableAvailability() {
    installWebAvailability(this.store);
  }
  private materials: WebCharacterMaterials | null = null;
  /** Part 30: the slot/take layer on top of the materials (the 素材版本 is now only the bundle a publication stands on). */
  private takes: WebClipTakes | null = null;
  enableMaterials(materials: WebCharacterMaterials) {
    this.materials = materials;
    if (this.speech) materials.enableSpeech(this.speech);
    this.takes = new WebClipTakes(this.store as never, this.clock, materials);
    if (this.direction) this.takes.enableDirection(this.direction);
  }
  /** Part 30: 按反馈重录 (the text model that places direction markup). Off until the runtime that can call it enables it. */
  private direction: WebClipDirection | null = null;
  enableDirection(direction: WebClipDirection) {
    this.direction = direction;
    this.takes?.enableDirection(direction);
  }
  /** Part 24k-1: the admin speech path (生成 on a 成品 slot, 预演 试听). Off until the runtime that can call Fish enables it. */
  private speech: WebAdminSpeech | null = null;
  enableSpeech(speech: WebAdminSpeech) {
    this.speech = speech;
    this.materials?.enableSpeech(speech);
  }
  /** Part 24j: 导入角色资料 and the 角色代码. Off (no tables, nothing offered) until enabled. */
  private profileImport: WebProfileImport | null = null;
  enableProfileImport() {
    this.profileImport = new WebProfileImport(this.store, this.clock, {
      characters: () => {
        const ids = new Set([
          ...publishedWebCharacters(this.store).map((row) => row.characterId),
          ...offlineWebCharacters(this.store).map((row) => row.characterId),
          ...this.store
            .all<{ character_id: string }>('SELECT character_id FROM web_character_drafts')
            .map((r) => r.character_id),
        ]);
        return [...ids].sort().map((id) => {
          const draft = this.draft(id),
            live = this.live(id);
          return {
            id,
            name: draft ? draftDTO(draft).profile.template.name : live!.template.name,
            draftRevision: draft?.revision ?? null,
            liveVersion: live?.version ?? null,
          };
        });
      },
      base: (id) => {
        const draft = this.draft(id),
          live = this.live(id);
        if (draft) return draftDTO(draft).profile;
        if (!live) return null;
        const profile = structuredClone({ template: live.template, presentation: live.presentation });
        profile.template.version = live.version + 1;
        return profile;
      },
      normalize: (value) => profile(value),
      write: (actor, id, next, now) => {
        const checked = profile(next);
        ensure(checked.template.id === id, 'CHARACTER_ID_MISMATCH');
        const current = this.draft(id),
          live = this.live(id);
        const base = current ? current.base_version : (live?.version ?? null);
        ensure((live?.version ?? null) === base, 'LIVE_VERSION_CONFLICT');
        ensure(checked.template.version === (base ?? 0) + 1, 'INVALID_DRAFT_VERSION');
        const digest = characterProfileHash(checked);
        if (current?.content_hash === digest) return null;
        return this.writeRevision(actor, id, base, checked, digest, now);
      },
      create: (actor, next, now) => this.createDraftForCast(actor, next, now),
    });
  }
  /** What the import may do for this session. A session that can write none of it is refused before any body is read. */
  private importContext(auth: Auth): ImportContext {
    const actor = this.actor(auth);
    const grants = actor.member.permissions;
    const owner = actor.role === 'owner';
    const mayCreate = owner || canCreateCharacter(grants);
    const anyEdit = grants.includes('category.characters') || grants.some((p) => p.startsWith('characters.edit:'));
    ensure(owner || (hasCastPermission(grants, 'cast.edit') && (mayCreate || anyEdit)), 'ADMIN_PERMISSION_REQUIRED');
    ensure(this.profileImport, 'PROFILE_IMPORT_UNAVAILABLE');
    return {
      actor: { memberId: actor.memberId, sessionId: actor.sessionId },
      mayCreate,
      mayEdit: (id) => owner || hasCharacterPermission(grants, 'edit', id),
      mayCast: owner || hasCastPermission(grants, 'cast.edit'),
    };
  }
  profileImportPreview(auth: Auth, input: unknown) {
    const ctx = this.importContext(auth);
    return this.profileImport!.preview(ctx, input);
  }
  profileImportApply(auth: Auth, input: unknown) {
    const ctx = this.importContext(auth);
    return this.profileImport!.apply(ctx, input);
  }
  /** 角色代码 by hand, on 身份与展示 (character edit). */
  profileCodeSave(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'edit', id);
    ensure(this.profileImport, 'PROFILE_IMPORT_UNAVAILABLE');
    return this.profileImport.saveCode(id, input);
  }
  profileChecklistDismiss(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'edit', id);
    ensure(this.profileImport, 'PROFILE_IMPORT_UNAVAILABLE');
    return this.profileImport.dismiss(id, input);
  }
  private previews: WebCharacterPreviews | null = null;
  private compare: WebReviewCompare | null = null;
  enablePreviews(previews: WebCharacterPreviews) {
    this.previews = previews;
    // Part 26b: the reviewer comparison lives next to 预演: same permission, same queue.
    this.compare = new WebReviewCompare(this.store, this.clock);
  }
  constructor(store: BusinessStore, clock: Clock, admin: WebAccountAdmin) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
  }
  private actor(auth: Auth) {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    return { ...actor, member: this.admin.session(auth.cookie).member };
  }
  private require(auth: Auth, action: CharacterAdminAction, id: string) {
    identifier(id);
    const actor = this.actor(auth);
    ensure(
      actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, action, id),
      'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  private draft(id: string) {
    return this.store.get<DraftRow>(
      `SELECT r.* FROM web_character_drafts d JOIN web_character_revisions r
      ON r.character_id=d.character_id AND r.revision=d.revision WHERE d.character_id=?`,
      id,
    );
  }
  /** The character at its current live version: on the home page or, once 下线, not (its live version stays). */
  private live(id: string) {
    return webCharacterAtLive(this.store, id);
  }
  /** Where a character stands, from the catalog and the versions (never from the cast). null = nothing to show (deleted or unknown). */
  private groupOf(id: string, inCatalog: ReadonlySet<string>, offline: ReadonlySet<string>): SidebarGroup {
    return inCatalog.has(id) ? 'live' : offline.has(id) ? 'offline' : 'draft';
  }
  private audit(actor: string, action: string, target: string, now: number) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor,
      action,
      target,
      now,
    );
  }
  /** The characters this admin may read, each with its group, in this admin's own order (groups: 当前阵容 / 未发布草稿 / 已下线). */
  private sidebar(actor: { role: string; memberId: string; member: { permissions: string[] } }) {
    const live = publishedWebCharacters(this.store),
      offline = offlineWebCharacters(this.store);
    const inCatalog = new Set(live.map((row) => row.characterId)),
      isOffline = new Set(offline.map((row) => row.characterId));
    const ids = new Set([
      ...inCatalog,
      ...isOffline,
      ...this.store
        .all<{ character_id: string }>('SELECT character_id FROM web_character_drafts')
        .map((row) => row.character_id),
    ]);
    const visible = [...ids]
      .filter((id) => !webCharacterDeleted(this.store, id))
      .filter((id) => actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, 'read', id))
      .sort();
    // Default order inside a group: the home page order for 当前阵容, the id for the others. A saved order only reorders.
    const position = new Map(live.map((row) => [row.characterId, row.position] as const));
    const byDefault = [...visible].sort(
      (a, b) => (position.get(a) ?? 99) - (position.get(b) ?? 99) || (a < b ? -1 : a > b ? 1 : 0),
    );
    const grouped = byDefault.map((id) => ({ id, group: this.groupOf(id, inCatalog, isOffline) }));
    const saved = savedOrder(this.store, actor.memberId);
    return {
      grouped,
      ordered: SIDEBAR_GROUPS.flatMap((group) =>
        orderGroup(
          grouped.filter((c) => c.group === group).map((c) => c.id),
          saved,
        ).map((id) => ({ id, group })),
      ),
      live,
      offline,
    };
  }
  list(auth: Auth) {
    const actor = this.actor(auth),
      { ordered, live, offline } = this.sidebar(actor);
    const allDeleted = actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, 'read', '*');
    const deletedScope = actor.member.permissions
      .filter((p) => p.startsWith('characters.read:'))
      .map((p) => p.slice('characters.read:'.length));
    const deletions = this.deletion
      ? this.store
          .all<{ character_id: string }>(
            `SELECT character_id FROM web_character_deletions
      WHERE (? OR character_id IN (${deletedScope.length ? deletedScope.map(() => '?').join(',') : 'NULL'}))
      ORDER BY state='purging' DESC,created_at DESC,id DESC LIMIT 100`,
            Number(allDeleted),
            ...deletedScope,
          )
          .map((row) => this.deletion!.status(row.character_id))
      : [];
    return {
      deletions,
      characters: ordered.map(({ id, group }) => {
        const current = live.find((row) => row.characterId === id) ?? offline.find((row) => row.characterId === id),
          draft = this.draft(id);
        // Part 24b-6, round 4 (read-only): the main colour the console paints this character with: the draft's when a draft exists,
        // else the published one, else null. Both are validated #RRGGBB on save, and anything else reads as null here.
        const colour = (draft ? draftDTO(draft).profile.presentation.color : current?.presentation.color) ?? null;
        return {
          characterId: id,
          displayName: current?.presentation.displayName ?? draftDTO(draft!).profile.presentation.displayName,
          publishedVersion: current?.version ?? null,
          draftRevision: draft?.revision ?? null,
          color: typeof colour === 'string' && /^#[0-9A-F]{6}$/.test(colour) ? colour : null,
          // Part 24l: server truth for the sidebar groups. online = on the home page.
          group,
          online: group === 'live',
        };
      }),
    };
  }
  /** 拖动排序: this admin's own order of one sidebar group. Never read by another admin, the home page or a player. */
  saveOrder(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    record(input);
    keys(input, ['group', 'ids']);
    return this.store.transaction(() =>
      saveGroupOrder(this.store, actor.memberId, this.sidebar(actor).grouped, input.group, input.ids),
    );
  }
  /** 下线 / 重新上线: the owner's alone (no grant opens it), like deletion. */
  setAvailability(auth: Auth, id: string, action: 'offline' | 'online', input: unknown) {
    identifier(id);
    const owner = () => {
      const actor = this.actor(auth);
      ensure(actor.role === 'owner', 'ADMIN_OWNER_REQUIRED');
      return actor;
    };
    owner();
    return this.store.transaction(() =>
      setWebCharacterAvailability(this.store, this.clock.now(), owner(), id, action, input),
    );
  }
  detail(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    const current = this.live(id),
      draft = this.draft(id);
    ensure(current || draft, 'NOT_FOUND');
    const voice = effectiveVoice(
      this.store,
      id,
      (draft ? upgradedProfile(JSON.parse(draft.profile_json) as StoredWebCharacterProfile) : current)?.template ?? {},
    );
    const previews = this.previews
      ? this.store
          .all<{ id: string }>(
            `SELECT p.id FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
      WHERE p.character_id=? ORDER BY p.created_at DESC,p.id DESC LIMIT 20`,
            id,
          )
          .map((row) => webPreviewDTO(readWebPreview(this.store, row.id)))
      : [];
    return {
      characterId: id,
      previews,
      previewAvailable: !!this.previews,
      // Part 24k-1: whether 生成 / 试听 exist here, and whether the draft has a voice reference to speak with.
      speech: {
        available: !!this.speech,
        hasVoice: !!voice,
        /** Part 29 B: the ONE voice the character speaks with (its binding, or the one derived from the recorded Fish id). */
        voice: voice
          ? {
              referenceId: voice.referenceId,
              profileId: voice.binding.profileId,
              version: voice.binding.version,
              speed: voice.binding.speed,
              derived: voice.derived,
            }
          : null,
        /** The model that will ACTUALLY speak for an un-pinned voice: the site's voice model (FISH_VOICE_MODEL). */
        siteModel: siteVoiceModel(this.store),
        footerRequired: footerRequired(this.store),
      },
      published: current
        ? { version: current.version, profile: { template: current.template, presentation: current.presentation } }
        : null,
      // Part 24l: on the home page now (a published character that is not is 已下线; its live version above stays).
      online: !!publishedWebCharacters(this.store).some((row) => row.characterId === id),
      draft: draft ? draftDTO(draft) : null,
      // Part 24j: the 角色代码, the avatar file name and Fish voice id recorded against it, and the open checklist.
      profileMeta: this.profileImport
        ? this.profileImport.meta(id)
        : { available: false as const, code: null, avatarFile: null, voiceReferenceId: null, checklist: [] },
    };
  }
  save(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'edit', id);
    record(input);
    keys(input, ['expectedRevision', 'profile']);
    ensure(
      input.expectedRevision === null ||
        (Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0),
      'INVALID_DRAFT_REVISION',
    );
    const next = profile(input.profile);
    ensure(next.template.id === id, 'CHARACTER_ID_MISMATCH');
    const digest = characterProfileHash(next);
    return this.store.transaction(() => {
      this.require(auth, 'edit', id);
      ensure(!webCharacterDeleted(this.store, id), 'CHARACTER_DELETED');
      const current = this.draft(id),
        live = this.live(id);
      if (!current && !live)
        ensure(actor.role === 'owner' || canCreateCharacter(actor.member.permissions), 'ADMIN_PERMISSION_REQUIRED');
      // Strict compare-and-swap, with only the immediately preceding lost-save response replayable.
      if (
        current?.content_hash === digest &&
        (current.revision === input.expectedRevision || current.revision === Number(input.expectedRevision) + 1)
      )
        return draftDTO(current);
      ensure((current?.revision ?? null) === input.expectedRevision, 'DRAFT_CONFLICT');
      const base = current ? current.base_version : (live?.version ?? null);
      ensure((live?.version ?? null) === base, 'LIVE_VERSION_CONFLICT');
      ensure(next.template.version === (base ?? 0) + 1, 'INVALID_DRAFT_VERSION');
      if (!current)
        ensure(
          this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_drafts')!.n < 100,
          'CHARACTER_DRAFT_LIMIT',
        );
      const now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      this.writeRevision(actor, id, base, next, digest, now);
      return draftDTO(this.draft(id)!);
    });
  }
  /** The rows of one saved draft revision (and the audit line): shared by save() and the cast file import. */
  private writeRevision(
    actor: { memberId: string; sessionId: string },
    id: string,
    base: number | null,
    next: WebCharacterProfile,
    digest: string,
    now: number,
  ) {
    const revision = this.store.get<{ n: number }>(
      `SELECT coalesce(max(revision),0)+1 n
        FROM web_character_revisions WHERE character_id=?`,
      id,
    )!.n;
    this.store.run(
      'INSERT INTO web_character_revisions VALUES (?,?,?,?,?,?,?)',
      id,
      revision,
      base,
      JSON.stringify(next),
      digest,
      now,
      actor.sessionId,
    );
    this.store.run(
      `INSERT INTO web_character_drafts VALUES (?,?)
        ON CONFLICT(character_id) DO UPDATE SET revision=excluded.revision`,
      id,
      revision,
    );
    this.audit(actor.memberId, `character-draft-saved:${revision}`, id, now);
    return revision;
  }
  /**
   * Part 24b-5: the first draft of a brand-new character, for the cast file import, inside the CALLER's transaction (so a failed
   * import leaves no orphan draft). Same checks and rows as save() for an id with no draft and no live version; who may create is
   * the caller's to decide (cast.edit and characters.create) and nothing else of an existing character is read or written.
   */
  createDraftForCast(actor: { memberId: string; sessionId: string }, input: unknown, now: number) {
    const next = profile(input);
    const id = next.template.id;
    identifier(id);
    ensure(!webCharacterDeleted(this.store, id), 'CHARACTER_DELETED');
    ensure(!this.draft(id) && !this.live(id), 'DRAFT_CONFLICT');
    ensure(next.template.version === 1, 'INVALID_DRAFT_VERSION');
    ensure(
      this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_drafts')!.n < 100,
      'CHARACTER_DRAFT_LIMIT',
    );
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    this.writeRevision(actor, id, null, next, characterProfileHash(next), now);
  }
  discard(auth: Auth, id: string, revision: unknown) {
    const actor = this.require(auth, 'discard', id);
    ensure(Number.isSafeInteger(revision) && Number(revision) > 0, 'INVALID_DRAFT_REVISION');
    return this.store.transaction(() => {
      this.require(auth, 'discard', id);
      ensure(this.draft(id)?.revision === revision, 'DRAFT_CONFLICT');
      this.store.run('DELETE FROM web_character_drafts WHERE character_id=?', id);
      this.audit(actor.memberId, `character-draft-discarded:${revision}`, id, this.clock.now());
      return { discarded: true, historyRetained: true };
    });
  }
  preview(auth: Auth, id: string, revision: unknown) {
    this.require(auth, 'read', id);
    ensure(Number.isSafeInteger(revision) && Number(revision) > 0, 'INVALID_DRAFT_REVISION');
    const draft = this.draft(id);
    ensure(draft && draft.revision === revision, 'DRAFT_CONFLICT');
    const current = this.live(id),
      next = draftDTO(draft);
    const previous = current ? { template: current.template, presentation: current.presentation } : null;
    const fields = ['template', 'presentation'] as const;
    return {
      kind: 'profile-preview' as const,
      draft: next,
      published: previous,
      changedSections: fields.filter(
        (key) => JSON.stringify(previous?.[key] ?? null) !== JSON.stringify(next.profile[key]),
      ),
      externalCalls: false,
      publishAvailable: false,
      publicationBlocker: 'REAL_PREVIEW_REQUIRED' as const,
    };
  }
  startPreview(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'preview', id);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return this.previews.start(actor, id, input);
  }
  previewStatus(auth: Auth, id: string, previewId: unknown) {
    this.require(auth, 'read', id);
    identifier(previewId);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    const row = readWebPreview(this.store, previewId);
    ensure(row.character_id === id, 'NOT_FOUND');
    return webPreviewDTO(row);
  }
  /** Part 13b: one batch = one run (idempotent by requestId). Same permission and queue as a single preview. */
  startRun(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'preview', id);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return this.previews.startRun(actor, id, input);
  }
  runList(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return runList(this.store, id);
  }
  runDetail(auth: Auth, id: string, runId: unknown) {
    this.require(auth, 'read', id);
    identifier(runId);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return runDetail(this.store, id, runId);
  }
  previewDetail(auth: Auth, id: string, previewId: unknown) {
    this.require(auth, 'read', id);
    identifier(previewId);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return previewDetail(this.store, id, previewId);
  }
  /** The poller's single call: statuses of one run's previews, or of the character's recent ones when runId is null. */
  previewsStatus(auth: Auth, id: string, runId: unknown) {
    this.require(auth, 'read', id);
    if (runId !== null) identifier(runId);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return previewsStatus(this.store, id, runId);
  }
  /** Eval sets are global lists of synthetic inputs. Reading needs any preview grant; writing needs preview on every character. */
  private evalActor(auth: Auth, write: boolean) {
    const actor = this.actor(auth);
    const grants = actor.member.permissions;
    ensure(
      actor.role === 'owner' ||
        (write
          ? hasCharacterPermission(grants, 'preview', '*')
          : hasCharacterPermission(grants, 'preview', '*') || grants.some((p) => p.startsWith('characters.preview:'))),
      'ADMIN_PERMISSION_REQUIRED',
    );
    return actor;
  }
  /** Part 26b 审核对比: reading needs any preview grant; starting and marking need preview on every character (or the owner). */
  compareEstimate(auth: Auth) {
    this.evalActor(auth, false);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return this.compare.estimate();
  }
  compareStart(auth: Auth, input: unknown) {
    const actor = this.evalActor(auth, true);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return this.compare.start(actor, input);
  }
  compareList(auth: Auth) {
    this.evalActor(auth, false);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return { runs: this.compare.list() };
  }
  compareDetail(auth: Auth, runId: unknown) {
    this.evalActor(auth, false);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return this.compare.detail(runId);
  }
  compareMark(auth: Auth, input: unknown) {
    const actor = this.evalActor(auth, true);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return this.compare.mark(actor, input);
  }
  compareExport(auth: Auth, runId: unknown) {
    this.evalActor(auth, false);
    ensure(this.compare, 'PREVIEW_UNAVAILABLE');
    return this.compare.exportText(runId);
  }
  evalSetList(auth: Auth) {
    this.evalActor(auth, false);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return { sets: evalSetList(this.store) };
  }
  evalSetSave(auth: Auth, input: unknown) {
    const actor = this.evalActor(auth, true);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    record(input);
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    const saved = evalSetSave(this.store, now, actor.memberId, input);
    this.audit(actor.memberId, `eval-set-saved:${saved.version}`, saved.id, now);
    return saved;
  }
  evalSetDelete(auth: Auth, id: unknown, expectedVersion: unknown) {
    const actor = this.evalActor(auth, true);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    const result = evalSetDelete(this.store, id, expectedVersion);
    this.audit(actor.memberId, 'eval-set-deleted', String(id), this.clock.now());
    return result;
  }
  authorizeMaterialUpload(auth: Auth, id: string) {
    return this.require(auth, 'materials', id);
  }
  materialList(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.list(id);
  }
  materialPrepare(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'materials', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.prepare(actor, id, input);
  }
  /** After materialPrepare: carry unchanged clips into the new 素材版本. Never throws. */
  async materialCarry(auth: Auth, id: string, materialId: string) {
    const actor = this.require(auth, 'materials', id);
    await this.materials?.carry(actor, id, materialId);
  }
  materialUpload(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'materials', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.upload(id, input, () => this.require(auth, 'materials', id));
  }
  materialAudio(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'read', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.audio(id, input, () => this.require(auth, 'read', id));
  }
  /** Part 24k-1: 生成 a slot's 成品 through the admin speech path. Same permission as an upload; never approves. */
  materialGenerate(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'materials', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.generate(id, input, () => this.require(auth, 'materials', id));
  }
  /** What a paid speech call would say and cost (no hold), or why it is not offered. */
  speechEstimate(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'read', id);
    ensure(this.speech && this.materials, 'SPEECH_UNAVAILABLE');
    record(input);
    if (input.kind === 'preview') {
      keys(input, ['kind', 'previewId']);
      identifier(input.previewId);
      return this.speech.estimatePreview(id, input.previewId);
    }
    ensure(input.kind === 'material', 'INVALID_REQUEST');
    keys(input, ['kind', 'materialId', 'slot', 'lineId']);
    return this.materials.estimateGenerate(id, {
      materialId: input.materialId,
      kind: input.slot,
      ...(input.lineId === undefined ? {} : { lineId: input.lineId }),
    });
  }
  /** 试听: speak the final bubbles of a succeeded 预演 (one confirmed cost), then the page plays them. */
  previewListen(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'preview', id);
    ensure(this.speech, 'SPEECH_UNAVAILABLE');
    record(input);
    keys(input, ['requestId', 'previewId', 'acknowledgeMicros']);
    identifier(input.previewId);
    return this.speech.listenPreview(
      () => this.require(auth, 'preview', id),
      id,
      input.previewId,
      String(input.requestId),
      input.acknowledgeMicros,
    );
  }
  speechClips(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'read', id);
    ensure(this.speech, 'SPEECH_UNAVAILABLE');
    record(input);
    keys(input, ['previewId']);
    identifier(input.previewId);
    return { clips: this.speech.clips(id, 'preview', input.previewId) };
  }
  speechAudio(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'read', id);
    ensure(this.speech, 'SPEECH_UNAVAILABLE');
    record(input);
    keys(input, ['callId']);
    return this.speech.audio(id, input.callId);
  }
  /** Part 30: slots and takes. Reads need 'read'; changing a take 'materials'; approving 'approve-materials'; the bundle 'publish'. */
  async takeCall(auth: Auth, id: string, action: string, input: unknown) {
    const takes = this.takes;
    ensure(takes, 'MATERIALS_UNAVAILABLE');
    const need = (permission: CharacterAdminAction) => {
      this.require(auth, permission, id);
      return () => this.require(auth, permission, id);
    };
    if (action === 'list') {
      need('read')();
      return takes.view(id);
    }
    if (action === 'audio') return takes.audio(id, input, need('read'));
    if (action === 'estimate') {
      need('read')();
      return takes.estimate(id, input);
    }
    if (action === 'estimate-direction') {
      need('read')();
      return takes.estimateDirection(id, input);
    }
    if (action === 'upload') return takes.upload(id, input, need('materials'));
    if (action === 'generate') return takes.generate(id, input, need('materials'));
    if (action === 'generate-all') return takes.generateAll(id, input, need('materials'));
    if (action === 'rewrite') return takes.rewrite(id, input, need('materials'));
    if (action === 'select') return takes.select(id, input, need('materials'));
    if (action === 'rename') return takes.rename(id, input, need('materials'));
    if (action === 'delete') return takes.remove(id, input, need('materials'));
    if (action === 'approve') return takes.approve(id, input, need('approve-materials'));
    if (action === 'bundle') return takes.bundle(id, need('publish'));
    throw new DomainError('NOT_FOUND');
  }
  materialApprove(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'approve-materials', id);
    ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.approve(id, input, () => this.require(auth, 'approve-materials', id));
  }
  deletionPreview(auth: Auth, id: string) {
    this.require(auth, 'delete', id);
    ensure(this.deletion, 'DELETION_UNAVAILABLE');
    return this.deletion.preview(id);
  }
  deletionStart(auth: Auth, id: string, input: unknown) {
    return this.store.transaction(() => {
      const actor = this.require(auth, 'delete', id);
      ensure(this.deletion, 'DELETION_UNAVAILABLE');
      return this.deletion.start(actor, id, input);
    });
  }
  deletionStatus(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    ensure(this.deletion, 'DELETION_UNAVAILABLE');
    return this.deletion.status(id);
  }
  /** 版本历史: everyone who may read the character. Snapshots only, no player data. */
  history(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    return characterHistory(this.store, id);
  }
  /** Part 24b-7: 草稿记录, the revisions of the current draft line with a mark per admin. Read-only; characters.read. */
  draftHistory(auth: Auth, id: string) {
    this.require(auth, 'read', id);
    return draftHistory(this.store, id);
  }
  historyVersion(auth: Auth, id: string, version: unknown) {
    this.require(auth, 'read', id);
    return characterVersion(this.store, id, version);
  }
  /** 恢复此版本: the owner's alone (no grant opens it). */
  restore(auth: Auth, id: string, input: unknown) {
    identifier(id);
    const owner = () => {
      const actor = this.actor(auth);
      ensure(actor.role === 'owner', 'ADMIN_OWNER_REQUIRED');
      return actor;
    };
    owner();
    return this.store.transaction(() => restoreWebCharacter(this.store, this.clock.now(), owner(), id, input));
  }
  publish(auth: Auth, id: string, input: unknown) {
    return this.store.transaction(() => {
      const actor = this.require(auth, 'publish', id);
      return publishWebCharacter(this.store, this.clock.now(), actor, id, input);
    });
  }
}
