import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../packages/contracts/index.ts';
import { SYNTHETIC_TRIAL_FOOTER } from './web-vertical-publisher.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { inspectPCM, pcmLevels } from '../../workers/audio/wav.ts';
import { contentHash } from './admin-content-hash.ts';
import type { BusinessStore } from './store-contract.ts';
import type { WebCharacterProfile } from './web-character-catalog.ts';
import { characterProfileHash } from './web-character-catalog.ts';
import { identifier, keys, nonempty, record } from './template-validation.ts';
import { checkAudioReference, fixedObjectScope, loadProviderAudio, type ProviderAudioStore } from './web-provider-media.ts';

type Actor = { memberId: string; sessionId: string };
type MaterialStore = BusinessStore & ProviderAudioStore;
export type MaterialKind = 'welcome' | 'footer';
export type MaterialRow = { id: string; request_hash: string; character_id: string; revision: number; profile_hash: string;
  voice_version: string; voice_revision: number; profile_id: string; reference_id: string; model: string;
  evidence_json: string; created_at: number };
type AssetRow = { material_id: string; kind: MaterialKind; media_id: string; body: string; text_version: string | null;
  sha256: string; byte_length: number; duration_ms: number; audio_bytes: Uint8Array | null; audio_ref_json: string | null; created_at: number };
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const assetDTO = (row: AssetRow) => ({ kind: row.kind, sha256: row.sha256, byteLength: row.byte_length,
  durationMs: row.duration_ms, body: row.body, textVersion: row.text_version });
export function materialAssets(store: BusinessStore, id: string, includeAudio = false) {
  // Catalog/manifest reads must not load every historical BLOB into memory.
  const columns = includeAudio ? '*' : 'material_id,kind,media_id,body,text_version,sha256,byte_length,duration_ms,created_at,NULL audio_bytes,NULL audio_ref_json';
  return store.all<AssetRow>(`SELECT ${columns} FROM web_character_material_assets WHERE material_id=? ORDER BY kind`, id);
}
export function materialManifest(store: BusinessStore, row: MaterialRow) {
  return contentHash([row.id,row.character_id,row.revision,row.profile_hash,row.voice_version,row.voice_revision,
    row.profile_id,row.reference_id,row.model,row.evidence_json,materialAssets(store,row.id).map(assetDTO)]);
}
function exactDraft(store: BusinessStore, row: Pick<MaterialRow, 'character_id' | 'revision' | 'profile_hash'>) {
  const draft = store.get<{ profile_json: string; content_hash: string }>(`SELECT r.* FROM web_character_drafts d
    JOIN web_character_revisions r ON r.character_id=d.character_id AND r.revision=d.revision
    WHERE d.character_id=? AND d.revision=?`, row.character_id,row.revision);
  ensure(draft && draft.content_hash === row.profile_hash, 'DRAFT_CONFLICT');
  const profile = JSON.parse(draft.profile_json) as WebCharacterProfile;
  ensure(characterProfileHash(profile) === row.profile_hash, 'DRAFT_CONFLICT');
  return profile;
}
export function approvedCharacterMaterial(store: BusinessStore, id: string, materialId: string, revision: number, hash: string) {
  identifier(materialId);
  const row = store.get<MaterialRow>('SELECT * FROM web_character_materials WHERE id=? AND character_id=?',materialId,id);
  ensure(row && row.revision === revision && row.profile_hash === hash, 'CHARACTER_MATERIALS_REQUIRED');
  const approval = store.get<{ manifest_hash: string }>('SELECT manifest_hash FROM web_character_material_approvals WHERE material_id=?',materialId);
  ensure(approval && approval.manifest_hash === materialManifest(store,row) && materialAssets(store,materialId).length === 2,
    'CHARACTER_MATERIALS_REQUIRED');
  return row;
}

/** User-selected finished clips only. No provider calls, voice cloning, or publication side effects. */
export class WebCharacterMaterials {
  private readonly store: MaterialStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  constructor(store: MaterialStore, clock: Clock, nextId: () => string = randomUUID) { this.store = store; this.clock = clock; this.nextId = nextId; }
  private now() {
    const now = this.clock.now(); ensure(Number.isSafeInteger(now) && now >= 0,'INVALID_TIME'); return now;
  }
  private row(id: string, materialId: unknown) {
    identifier(materialId);
    const row = this.store.get<MaterialRow>('SELECT * FROM web_character_materials WHERE id=? AND character_id=?',materialId,id);
    ensure(row,'NOT_FOUND'); return row;
  }
  list(id: string) {
    return this.store.all<MaterialRow>('SELECT * FROM web_character_materials WHERE character_id=? ORDER BY created_at DESC,id LIMIT 64',id)
      .map(row => ({ materialId: row.id, draftRevision: row.revision, profileHash: row.profile_hash,
        voice: { profileId: row.profile_id, version: row.voice_revision, referenceId: row.reference_id, model: row.model },
        assets: materialAssets(this.store,row.id).map(assetDTO), approved: !!this.store.get(
          'SELECT 1 FROM web_character_material_approvals WHERE material_id=?',row.id), createdAt: row.created_at }));
  }
  prepare(actor: Actor, id: string, input: unknown) {
    record(input); keys(input,['requestId','draftRevision','profileHash','referenceId','model']);
    identifier(input.requestId); identifier(input.referenceId);
    ensure(Number.isSafeInteger(input.draftRevision) && Number(input.draftRevision)>0 &&
      typeof input.profileHash === 'string' && /^[a-f0-9]{64}$/.test(input.profileHash) &&
      input.model === 's2.1-pro', 'INVALID_MATERIAL_REQUEST');
    const requestId = input.requestId, referenceId = input.referenceId, model = input.model;
    const revision = Number(input.draftRevision), hash = input.profileHash, requestHash = contentHash([actor.memberId,id,input]);
    return this.store.transaction(() => {
      const prior = this.store.get<MaterialRow>('SELECT * FROM web_character_materials WHERE request_id=?',requestId);
      if (prior) { ensure(prior.request_hash === requestHash,'IDEMPOTENCY_CONFLICT'); return { materialId: prior.id }; }
      const profile = exactDraft(this.store,{ character_id:id,revision,profile_hash:hash });
      ensure(profile.template.voice,'CHARACTER_VOICE_REQUIRED');
      ensure(this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_materials WHERE character_id=? AND revision=?',id,revision)!.n < 16,
        'MATERIAL_DRAFT_LIMIT');
      const materialId = this.nextId(), voiceVersion = 'web-material-' + materialId, now = this.now();
      const evidence = JSON.stringify({ kind:'admin-material-v1',materialId,profileHash:hash });
      this.store.run('INSERT INTO web_character_materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',materialId,requestId,requestHash,
        id,revision,hash,voiceVersion,profile.template.voice.version,profile.template.voice.profileId,referenceId,model,evidence,
        actor.memberId,actor.sessionId,now);
      return { materialId };
    });
  }
  async upload(id: string, input: unknown, authorize: () => Actor) {
    authorize(); record(input); keys(input,['materialId','kind','base64']);
    ensure(input.kind === 'welcome' || input.kind === 'footer','INVALID_MATERIAL_KIND');
    ensure(typeof input.base64 === 'string' && input.base64.length > 0 && input.base64.length <= 8_000_000,'INVALID_MATERIAL_AUDIO');
    const bytes = Buffer.from(input.base64,'base64');
    ensure(bytes.toString('base64') === input.base64 && bytes.length <= 6_000_000,'INVALID_MATERIAL_AUDIO');
    const info = inspectPCM(bytes,60_000), duration = Math.round(info.durationMs);
    ensure(info.channels === 1 && info.sampleRate === 24000 && duration > 0 && pcmLevels(bytes).rms > 0.001,'INVALID_MATERIAL_AUDIO');
    const row = this.row(id,input.materialId), kind = input.kind, digest = sha(bytes);
    const guard = () => { authorize(); exactDraft(this.store,row); };
    guard();
    const prior = materialAssets(this.store,row.id).find(item => item.kind === kind);
    if (prior) { ensure(prior.sha256 === digest && prior.byte_length === bytes.length,'MATERIAL_AUDIO_IMMUTABLE'); return assetDTO(prior); }
    const profile = exactDraft(this.store,row), scope = fixedObjectScope(this.store,kind,id,row.voice_version);
    const reference = this.store.providerAudio ? await this.store.providerAudio.stage(scope,bytes,async () => { guard(); }) : null;
    if (reference) checkAudioReference(reference,scope,bytes);
    return this.store.transaction(() => {
      guard();
      const existing = materialAssets(this.store,row.id).find(item => item.kind === kind);
      if (existing) { ensure(existing.sha256 === digest && existing.byte_length === bytes.length,'MATERIAL_AUDIO_IMMUTABLE'); return assetDTO(existing); }
      const body = kind === 'welcome' ? profile.presentation.welcome.text : SYNTHETIC_TRIAL_FOOTER;
      this.store.run('INSERT INTO web_character_material_assets VALUES (?,?,?,?,?,?,?,?,?,?,?)',row.id,kind,this.nextId(),body,
        kind === 'welcome' ? profile.presentation.welcome.version : null,digest,bytes.length,duration,reference ? null : bytes,
        reference ? JSON.stringify(reference) : null,this.now());
      return assetDTO(materialAssets(this.store,row.id).find(item => item.kind === kind)!);
    });
  }
  async audio(id: string, input: unknown, authorize: () => Actor) {
    authorize(); record(input); keys(input,['materialId','kind']);
    ensure(input.kind === 'welcome' || input.kind === 'footer','INVALID_MATERIAL_KIND');
    const row = this.row(id,input.materialId), asset = this.store.get<AssetRow>('SELECT * FROM web_character_material_assets WHERE material_id=? AND kind=?',row.id,input.kind);
    ensure(asset,'NOT_FOUND');
    const bytes = await loadProviderAudio(this.store,asset,fixedObjectScope(this.store,asset.kind,id,row.voice_version),async () => { authorize(); },new Map());
    ensure(sha(bytes) === asset.sha256 && bytes.length === asset.byte_length,'INVALID_MATERIAL_AUDIO');
    authorize(); return { ...assetDTO(asset),mimeType:'audio/wav',base64:Buffer.from(bytes).toString('base64') };
  }
  async approve(id: string, input: unknown, authorize: () => Actor) {
    authorize(); record(input); keys(input,['materialId','acknowledgeRights','acknowledgeWelcomeListening','acknowledgeFooterListening','note']);
    ensure(input.acknowledgeRights === true && input.acknowledgeWelcomeListening === true && input.acknowledgeFooterListening === true,
      'MATERIAL_APPROVAL_REQUIRED'); nonempty(input.note,1000);
    const note = input.note, row = this.row(id,input.materialId);
    const guard = () => { const actor = authorize(); exactDraft(this.store,row); return actor; };
    guard(); ensure(materialAssets(this.store,row.id).length === 2,'CHARACTER_MATERIALS_REQUIRED');
    // Re-read and hash private objects before approval; stale permissions/drafts cannot commit after R2 awaits.
    for (const kind of ['welcome','footer'] as const) await this.audio(id,{ materialId:row.id,kind },guard);
    return this.store.transaction(() => {
      const actor = guard(), manifest = materialManifest(this.store,row), prior = this.store.get<{ manifest_hash: string; note: string }>(
        'SELECT * FROM web_character_material_approvals WHERE material_id=?',row.id);
      if (prior) ensure(prior.manifest_hash === manifest && prior.note === note,'MATERIAL_APPROVAL_IMMUTABLE');
      else {
        this.store.run('INSERT INTO web_character_material_approvals VALUES (?,?,?,?,?,?)',row.id,manifest,actor.memberId,actor.sessionId,note,this.now());
        this.store.run('INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
          actor.memberId,'character-material-approved',row.id,this.now());
      }
      return { materialId:row.id,manifestHash:manifest,approved:true };
    });
  }
}

/** Called only inside the publication transaction after its proof and quiescence gates. */
export function promoteCharacterMaterial(store: BusinessStore, row: MaterialRow, version: number) {
  store.run('INSERT INTO web_character_material_promotions VALUES (?,?,?)',row.character_id,version,row.id);
  const values = [row.character_id,row.voice_version,row.voice_revision,row.profile_id,row.reference_id,row.model,'user_selected',1,row.evidence_json];
  store.run('INSERT INTO web_character_voice_history VALUES (?,?,?,?,?,?,?,?,?)',...values);
  store.run(`INSERT INTO web_provider_voice_bindings VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET
    voice_version=excluded.voice_version,voice_revision=excluded.voice_revision,profile_id=excluded.profile_id,
    reference_id=excluded.reference_id,model=excluded.model,source=excluded.source,approved=excluded.approved,evidence_json=excluded.evidence_json`,...values);
  const external = store.all<{ name: string }>('PRAGMA table_info(web_provider_welcome_assets)').some(c => c.name === 'audio_ref_json');
  for (const asset of materialAssets(store,row.id,true)) {
    ensure(external === (asset.audio_ref_json !== null),'WEB_AUDIO_REFERENCE_INVALID');
    const welcome = asset.kind === 'welcome';
    store.run(`INSERT INTO web_provider_${asset.kind}_assets(character_id,voice_version,media_id,origin,body,sha256,byte_length,
      duration_ms,audio_bytes,created_at${welcome ? ',text_version' : ''}${external ? ',audio_ref_json' : ''})
      VALUES (?,?,?,'operator_approved',?,?,?,?,?,?${welcome ? ',?' : ''}${external ? ',?' : ''})`,
    row.character_id,row.voice_version,asset.media_id,asset.body,asset.sha256,asset.byte_length,asset.duration_ms,asset.audio_bytes,asset.created_at,
    ...(welcome ? [asset.text_version] : []),...(external ? [asset.audio_ref_json] : []));
  }
}
