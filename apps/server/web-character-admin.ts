import type { WebCharacterDeletion } from './web-character-deletion.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import type { Clock } from '../../packages/contracts/index.ts';
import { canCreateCharacter, hasCharacterPermission, type CharacterAdminAction } from '../../packages/contracts/web-admin-permissions.ts';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore } from './store-contract.ts';
import type { WebAccountAdmin } from './web-account-admin.ts';
import { identifier, keys, nonempty, record, validatedTemplate } from './template-validation.ts';
import { characterProfileHash, publishedWebCharacters, type WebCharacterProfile } from './web-character-catalog.ts';
import { WebCharacterPreviews, readWebPreview, webPreviewDTO } from './web-character-preview.ts';
import { publishWebCharacter } from './web-character-publication.ts';

import { WebCharacterMaterials } from './web-character-materials.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
type DraftRow = { character_id: string; revision: number; base_version: number | null; profile_json: string;
  content_hash: string; created_at: number };
const draftDTO = (row: DraftRow) => ({ characterId: row.character_id, revision: row.revision,
  baseVersion: row.base_version, profile: JSON.parse(row.profile_json) as WebCharacterProfile,
  contentHash: row.content_hash, savedAt: row.created_at });

function profile(value: unknown): WebCharacterProfile {
  record(value); keys(value, ['template','presentation']);
  const template = validatedTemplate(value.template), display = value.presentation;
  record(display); keys(display, ['displayName','publicDescription','welcome']);
  nonempty(display.displayName, 100);
  ensure(typeof display.publicDescription === 'string' && display.publicDescription.length <= 500, 'INVALID_ADMIN_REQUEST');
  record(display.welcome); keys(display.welcome, ['text','version']);
  nonempty(display.welcome.text, 500); identifier(display.welcome.version);
  return { template, presentation: { displayName: display.displayName,
    publicDescription: display.publicDescription, welcome: { text: display.welcome.text, version: display.welcome.version } } };
}

/** Editing and static preview never generate or publish; publication is a separate guarded command. */
export class WebCharacterAdmin {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private deletion: WebCharacterDeletion | null = null;
  enableDeletion(deletion: WebCharacterDeletion) { this.deletion = deletion; }
  private materials: WebCharacterMaterials | null = null;
  enableMaterials(materials: WebCharacterMaterials) { this.materials = materials; }
  private previews: WebCharacterPreviews | null = null;
  enablePreviews(previews: WebCharacterPreviews) { this.previews = previews; }
  constructor(store: BusinessStore, clock: Clock, admin: WebAccountAdmin) {
    this.store = store; this.clock = clock; this.admin = admin;
  }
  private actor(auth: Auth) {
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    return { ...actor, member: this.admin.session(auth.cookie).member };
  }
  private require(auth: Auth, action: CharacterAdminAction, id: string) {
    identifier(id); const actor = this.actor(auth);
    ensure(actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, action, id), 'ADMIN_PERMISSION_REQUIRED');
    return actor;
  }
  private draft(id: string) {
    return this.store.get<DraftRow>(`SELECT r.* FROM web_character_drafts d JOIN web_character_revisions r
      ON r.character_id=d.character_id AND r.revision=d.revision WHERE d.character_id=?`, id);
  }
  private live(id: string) { return publishedWebCharacters(this.store).find(row => row.characterId === id); }
  private audit(actor: string, action: string, target: string, now: number) {
    this.store.run('INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)', actor, action, target, now);
  }
  list(auth: Auth) {
    const actor = this.actor(auth), live = publishedWebCharacters(this.store);
    const ids = new Set([...live.map(row => row.characterId),
      ...this.store.all<{ character_id: string }>('SELECT character_id FROM web_character_drafts').map(row => row.character_id)]);
    const allDeleted = actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, 'read', '*');
    const deletedScope = actor.member.permissions.filter(p => p.startsWith('characters.read:')).map(p => p.slice('characters.read:'.length));
    const deletions = this.deletion ? this.store.all<{ character_id:string }>(`SELECT character_id FROM web_character_deletions
      WHERE (? OR character_id IN (${deletedScope.length ? deletedScope.map(() => '?').join(',') : 'NULL'}))
      ORDER BY state='purging' DESC,created_at DESC,id DESC LIMIT 100`, Number(allDeleted), ...deletedScope)
      .map(row => this.deletion!.status(row.character_id)) : [];
    return { deletions,characters: [...ids].filter(id => actor.role === 'owner' || hasCharacterPermission(actor.member.permissions, 'read', id))
      .sort().map(id => {
        const current = live.find(row => row.characterId === id), draft = this.draft(id);
        return { characterId: id, displayName: current?.presentation.displayName ?? draftDTO(draft!).profile.presentation.displayName,
          publishedVersion: current?.version ?? null, draftRevision: draft?.revision ?? null };
      }) };
  }
  detail(auth: Auth, id: string) {
    this.require(auth, 'read', id); const current = this.live(id), draft = this.draft(id);
    ensure(current || draft, 'NOT_FOUND');
    const previews = this.previews ? this.store.all<{id:string}>(`SELECT p.id FROM admin_previews p JOIN web_character_preview_jobs j ON j.preview_id=p.id
      WHERE p.character_id=? ORDER BY p.created_at DESC,p.id DESC LIMIT 20`,id).map(row => webPreviewDTO(readWebPreview(this.store,row.id))) : [];
    return { characterId: id, previews,previewAvailable:!!this.previews, published: current ? { version: current.version,
      profile: { template: current.template, presentation: current.presentation } } : null,
    draft: draft ? draftDTO(draft) : null };
  }
  save(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'edit', id); record(input); keys(input, ['expectedRevision','profile']);
    ensure(input.expectedRevision === null || Number.isSafeInteger(input.expectedRevision) && Number(input.expectedRevision) > 0,
      'INVALID_DRAFT_REVISION');
    const next = profile(input.profile); ensure(next.template.id === id, 'CHARACTER_ID_MISMATCH');
    const digest = characterProfileHash(next);
    return this.store.transaction(() => {
      this.require(auth, 'edit', id); ensure(!webCharacterDeleted(this.store,id), 'CHARACTER_DELETED');
      const current = this.draft(id), live = this.live(id);
      if (!current && !live) ensure(actor.role === 'owner' || canCreateCharacter(actor.member.permissions), 'ADMIN_PERMISSION_REQUIRED');
      // Strict compare-and-swap, with only the immediately preceding lost-save response replayable.
      if (current?.content_hash === digest && (current.revision === input.expectedRevision ||
        current.revision === Number(input.expectedRevision) + 1)) return draftDTO(current);
      ensure((current?.revision ?? null) === input.expectedRevision, 'DRAFT_CONFLICT');
      const base = current ? current.base_version : live?.version ?? null;
      ensure((live?.version ?? null) === base, 'LIVE_VERSION_CONFLICT');
      ensure(next.template.version === (base ?? 0) + 1, 'INVALID_DRAFT_VERSION');
      if (!current) ensure(this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_drafts')!.n < 100, 'CHARACTER_DRAFT_LIMIT');
      const revision = this.store.get<{ n: number }>(`SELECT coalesce(max(revision),0)+1 n
        FROM web_character_revisions WHERE character_id=?`, id)!.n, now = this.clock.now();
      ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
      this.store.run('INSERT INTO web_character_revisions VALUES (?,?,?,?,?,?,?)', id, revision, base,
        JSON.stringify(next), digest, now, actor.sessionId);
      this.store.run(`INSERT INTO web_character_drafts VALUES (?,?)
        ON CONFLICT(character_id) DO UPDATE SET revision=excluded.revision`, id, revision);
      this.audit(actor.memberId, `character-draft-saved:${revision}`, id, now);
      return draftDTO(this.draft(id)!);
    });
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
    const draft = this.draft(id); ensure(draft && draft.revision === revision, 'DRAFT_CONFLICT');
    const current = this.live(id), next = draftDTO(draft);
    const previous = current ? { template: current.template, presentation: current.presentation } : null;
    const fields = ['template','presentation'] as const;
    return { kind: 'profile-preview' as const, draft: next, published: previous,
      changedSections: fields.filter(key => JSON.stringify(previous?.[key] ?? null) !== JSON.stringify(next.profile[key])),
      externalCalls: false, publishAvailable: false,
      publicationBlocker: 'REAL_PREVIEW_REQUIRED' as const };
  }
  startPreview(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'preview', id);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    return this.previews.start(actor, id, input);
  }
  previewStatus(auth: Auth, id: string, previewId: unknown) {
    this.require(auth, 'read', id); identifier(previewId);
    ensure(this.previews, 'PREVIEW_UNAVAILABLE');
    const row = readWebPreview(this.store, previewId); ensure(row.character_id === id, 'NOT_FOUND');
    return webPreviewDTO(row);
  }
  authorizeMaterialUpload(auth: Auth, id: string) { return this.require(auth, 'materials', id); }
  materialList(auth: Auth, id: string) {
    this.require(auth, 'read', id); ensure(this.materials, 'MATERIALS_UNAVAILABLE'); return this.materials.list(id);
  }
  materialPrepare(auth: Auth, id: string, input: unknown) {
    const actor = this.require(auth, 'materials', id); ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.prepare(actor, id, input);
  }
  materialUpload(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'materials', id); ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.upload(id, input, () => this.require(auth, 'materials', id));
  }
  materialAudio(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'read', id); ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.audio(id, input, () => this.require(auth, 'read', id));
  }
  materialApprove(auth: Auth, id: string, input: unknown) {
    this.require(auth, 'approve-materials', id); ensure(this.materials, 'MATERIALS_UNAVAILABLE');
    return this.materials.approve(id, input, () => this.require(auth, 'approve-materials', id));
  }
  deletionPreview(auth: Auth, id: string) {
    this.require(auth,'delete',id); ensure(this.deletion,'DELETION_UNAVAILABLE'); return this.deletion.preview(id);
  }
  deletionStart(auth: Auth, id: string, input: unknown) {
    return this.store.transaction(() => {
      const actor=this.require(auth,'delete',id); ensure(this.deletion,'DELETION_UNAVAILABLE'); return this.deletion.start(actor,id,input);
    });
  }
  deletionStatus(auth: Auth, id: string) {
    this.require(auth,'read',id); ensure(this.deletion,'DELETION_UNAVAILABLE'); return this.deletion.status(id);
  }
  publish(auth: Auth, id: string, input: unknown) {
    return this.store.transaction(() => {
      const actor = this.require(auth, 'publish', id);
      return publishWebCharacter(this.store, this.clock.now(), actor, id, input);
    });
  }
}
