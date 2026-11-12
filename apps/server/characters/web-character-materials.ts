import {
  PINNED_S21_BINDING,
  resolveVoiceModel,
  type FishModel,
  type VoiceModelBinding,
} from '../../../packages/contracts/audio.ts';
import type { VoiceBinding } from '../../../packages/contracts/media.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import {
  clipManifest,
  effectiveVoice,
  footerRequired,
  setSiteVoiceModel,
  siteVoiceModel,
} from './web-clip-manifest.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { SYNTHETIC_TRIAL_FOOTER } from '../conversation/web-vertical-publisher.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import { inspectPCM, pcmLevels } from '../../../workers/audio/wav.ts';
import { contentHash } from './admin-content-hash.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import type { StoredWebCharacterProfile, WebCharacterProfile } from './web-character-catalog.ts';
import { upgradedProfile } from './web-character-catalog.ts';
import { webWelcomeLinesInstalled } from './web-welcome-schema.ts';
import { identifier, keys, nonempty, record } from './template-validation.ts';
import type { WebAdminSpeech } from './web-admin-speech.ts';
import { webAdminSpeechInstalled } from './web-admin-speech-schema.ts';
import {
  checkAudioReference,
  fixedObjectScope,
  loadProviderAudio,
  type ProviderAudioStore,
} from '../audio/web-provider-media.ts';

type Actor = { memberId: string; sessionId: string };
type MaterialStore = BusinessStore & ProviderAudioStore;
export type MaterialKind = 'welcome' | 'footer';
export type MaterialRow = {
  id: string;
  request_hash: string;
  character_id: string;
  revision: number;
  profile_hash: string;
  voice_version: string;
  voice_revision: number;
  profile_id: string;
  reference_id: string;
  model: string;
  evidence_json: string;
  created_at: number;
};
type AssetRow = {
  material_id: string;
  kind: MaterialKind;
  media_id: string;
  body: string;
  text_version: string | null;
  sha256: string;
  byte_length: number;
  duration_ms: number;
  audio_bytes: Uint8Array | null;
  audio_ref_json: string | null;
  created_at: number;
};
/** Part 24k-2: the welcome slot of one line of a multi-line profile (a one-line profile keeps the single welcome asset). */
type LineRow = {
  material_id: string;
  line_id: string;
  body: string;
  media_id: string;
  sha256: string;
  byte_length: number;
  duration_ms: number;
  audio_bytes: Uint8Array | null;
  audio_ref_json: string | null;
  created_at: number;
};
const lineDTO = (row: LineRow) => ({
  kind: 'welcome' as const,
  lineId: row.line_id,
  sha256: row.sha256,
  byteLength: row.byte_length,
  durationMs: row.duration_ms,
  body: row.body,
});
export function materialLines(store: BusinessStore, id: string, includeAudio = false): LineRow[] {
  if (!webWelcomeLinesInstalled(store)) return [];
  const columns = includeAudio
    ? '*'
    : 'material_id,line_id,body,media_id,sha256,byte_length,duration_ms,created_at,NULL audio_bytes,NULL audio_ref_json';
  return store.all<LineRow>(
    `SELECT ${columns} FROM web_welcome_material_lines WHERE material_id=? ORDER BY line_id`,
    id,
  );
}
/** The clip a manifest slot has in a 素材版本: a line's own row, else the single welcome asset made for that line. */
function clipFor(
  store: BusinessStore,
  materialId: string,
  slot: { kind: 'welcome' | 'footer'; lineId: string | null },
) {
  if (slot.kind === 'footer') {
    const a = materialAssets(store, materialId).find((x) => x.kind === 'footer');
    return a ? { body: a.body, sha256: a.sha256, durationMs: a.duration_ms, byteLength: a.byte_length } : null;
  }
  const line = materialLines(store, materialId).find((x) => x.line_id === slot.lineId);
  if (line) return { body: line.body, sha256: line.sha256, durationMs: line.duration_ms, byteLength: line.byte_length };
  const single = materialAssets(store, materialId).find((x) => x.kind === 'welcome' && x.text_version === slot.lineId);
  return single
    ? { body: single.body, sha256: single.sha256, durationMs: single.duration_ms, byteLength: single.byte_length }
    : null;
}
/**
 * Where a 素材版本 stands against the draft's clip manifest (Part 29 C): the voice must be the same, and every slot of the
 * manifest either has a clip with exactly its text, or is empty. A clip with other text never lets the version be used.
 */
export function materialState(store: BusinessStore, row: MaterialRow, profile: WebCharacterProfile) {
  const eff = effectiveVoice(store, row.character_id, profile.template);
  const binding = row.model as VoiceModelBinding;
  const made = (JSON.parse(row.evidence_json) as { resolvedModel?: string }).resolvedModel ?? null;
  const voiceStale =
    !eff ||
    eff.referenceId !== row.reference_id ||
    (made !== null && made !== resolveVoiceModel(binding, siteVoiceModel(store)));
  const manifest = clipManifest(store, profile, { referenceId: row.reference_id }, binding);
  const slots = manifest.slots.map((slot) => {
    const clip = clipFor(store, row.id, slot);
    return {
      ...slot,
      clip,
      state: !clip ? ('empty' as const) : clip.body === slot.text ? ('ready' as const) : ('stale' as const),
    };
  });
  const textStale = slots.some((slot) => slot.state === 'stale');
  return {
    manifest,
    slots,
    voiceStale,
    textStale,
    stale: voiceStale ? ('voice' as const) : textStale ? ('text' as const) : null,
    valid: !voiceStale && !textStale,
    complete: !voiceStale && slots.every((slot) => slot.state === 'ready'),
  };
}
/** Is every slot of this profile's manifest filled? (A footer slot exists only while the free tier is off.) */
export function slotsComplete(store: BusinessStore, materialId: string, profile: WebCharacterProfile) {
  return clipManifest(store, profile, { referenceId: '' }, 's2.1-pro').slots.every((slot) => {
    const clip = clipFor(store, materialId, slot);
    return !!clip && clip.body === slot.text;
  });
}
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const assetDTO = (row: AssetRow) => ({
  kind: row.kind,
  sha256: row.sha256,
  byteLength: row.byte_length,
  durationMs: row.duration_ms,
  body: row.body,
  textVersion: row.text_version,
});
export function materialAssets(store: BusinessStore, id: string, includeAudio = false) {
  // Catalog/manifest reads must not load every historical BLOB into memory.
  const columns = includeAudio
    ? '*'
    : 'material_id,kind,media_id,body,text_version,sha256,byte_length,duration_ms,created_at,NULL audio_bytes,NULL audio_ref_json';
  return store.all<AssetRow>(
    `SELECT ${columns} FROM web_character_material_assets WHERE material_id=? ORDER BY kind`,
    id,
  );
}
export function materialManifest(store: BusinessStore, row: MaterialRow) {
  return contentHash([
    row.id,
    row.character_id,
    row.revision,
    row.profile_hash,
    row.voice_version,
    row.voice_revision,
    row.profile_id,
    row.reference_id,
    row.model,
    row.evidence_json,
    materialAssets(store, row.id).map(assetDTO),
    // Part 24k-2: only a material that has line slots adds them, so every earlier manifest hash is what it was.
    ...(materialLines(store, row.id).length ? [materialLines(store, row.id).map(lineDTO)] : []),
  ]);
}
/** The draft as it is NOW. A 素材版本 is not tied to a revision: it is tied to the clip manifest (see materialState). */
function currentDraft(store: BusinessStore, row: Pick<MaterialRow, 'character_id'>) {
  const draft = store.get<{ profile_json: string }>(
    `SELECT r.* FROM web_character_drafts d
    JOIN web_character_revisions r ON r.character_id=d.character_id AND r.revision=d.revision
    WHERE d.character_id=?`,
    row.character_id,
  );
  ensure(draft, 'DRAFT_CONFLICT');
  return upgradedProfile(JSON.parse(draft.profile_json) as StoredWebCharacterProfile);
}
/** A draft the 素材版本 can still be used with: same voice, no clip whose text is no longer a line. */
function usableDraft(store: BusinessStore, row: MaterialRow) {
  const profile = currentDraft(store, row);
  ensure(materialState(store, row, profile).valid, 'MATERIAL_STALE');
  return profile;
}
export function approvedCharacterMaterial(store: BusinessStore, id: string, materialId: string) {
  identifier(materialId);
  const row = store.get<MaterialRow>(
    'SELECT * FROM web_character_materials WHERE id=? AND character_id=?',
    materialId,
    id,
  );
  ensure(row, 'CHARACTER_MATERIALS_REQUIRED');
  const approval = store.get<{ manifest_hash: string }>(
    'SELECT manifest_hash FROM web_character_material_approvals WHERE material_id=?',
    materialId,
  );
  ensure(
    approval &&
      approval.manifest_hash === materialManifest(store, row) &&
      materialState(store, row, currentDraft(store, row)).complete,
    'CHARACTER_MATERIALS_REQUIRED',
  );
  return row;
}

/** User-selected finished clips only. No provider calls, voice cloning, or publication side effects. */
export class WebCharacterMaterials {
  private readonly store: MaterialStore;
  private readonly clock: Clock;
  private readonly nextId: () => string;
  /** Part 24k-1: the admin speech path (生成). Off until enabled; uploads work without it. */
  private speech: WebAdminSpeech | null = null;
  enableSpeech(speech: WebAdminSpeech) {
    this.speech = speech;
    setSiteVoiceModel(this.store, speech.siteModel);
  }
  constructor(store: MaterialStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.nextId = nextId;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }
  private row(id: string, materialId: unknown) {
    identifier(materialId);
    const row = this.store.get<MaterialRow>(
      'SELECT * FROM web_character_materials WHERE id=? AND character_id=?',
      materialId,
      id,
    );
    ensure(row, 'NOT_FOUND');
    return row;
  }
  private draftOrNull(id: string) {
    try {
      return currentDraft(this.store, { character_id: id });
    } catch {
      return null;
    }
  }
  /** The model a 素材版本 speaks with: what it was prepared for, resolved (never the raw binding word). */
  private modelOf(row: MaterialRow): FishModel {
    return resolveVoiceModel(row.model as VoiceModelBinding, siteVoiceModel(this.store));
  }
  list(id: string) {
    const profile = this.draftOrNull(id);
    const order = this.store
      .all<{ id: string }>('SELECT id FROM web_character_materials WHERE character_id=? ORDER BY created_at,rowid', id)
      .map((row, index) => [row.id, index + 1] as const);
    const numbers = new Map(order);
    const needed = profile ? footerRequired(this.store) : false;
    return this.store
      .all<MaterialRow>(
        'SELECT * FROM web_character_materials WHERE character_id=? ORDER BY created_at DESC,rowid DESC LIMIT 64',
        id,
      )
      .map((row) => {
        const approved = !!this.store.get('SELECT 1 FROM web_character_material_approvals WHERE material_id=?', row.id);
        const state = profile ? materialState(this.store, row, profile) : null;
        const issues = this.speech && webAdminSpeechInstalled(this.store) ? this.speech.slotIssues(id, row.id) : [];
        return {
          materialId: row.id,
          number: numbers.get(row.id) ?? 0,
          draftRevision: row.revision,
          profileHash: row.profile_hash,
          voice: {
            profileId: row.profile_id,
            version: row.voice_revision,
            referenceId: row.reference_id,
            /** What actually speaks: resolved against the site's voice model, or the pin. */
            model: this.modelOf(row),
            pinned: row.model === PINNED_S21_BINDING,
          },
          assets: materialAssets(this.store, row.id).map((asset) => this.view(id, asset)),
          lines: materialLines(this.store, row.id).map((line) => this.lineView(id, line)),
          approved,
          /** Why it cannot be used with the draft as it is now (null: usable). An approved version missing a slot is stale too. */
          stale: state ? (state.stale ?? (approved && !state.complete ? ('slots' as const) : null)) : null,
          footerRequired: needed,
          slots: (state?.slots ?? []).map((slot) => ({
            kind: slot.kind,
            lineId: slot.lineId,
            text: slot.text,
            state: slot.state,
            ...(slot.clip ? { clip: { sha256: slot.clip.sha256, durationMs: slot.clip.durationMs } } : {}),
            ...(slot.state === 'empty' || slot.state === 'stale'
              ? {
                  issue:
                    issues.find(
                      (item) =>
                        item.kind === slot.kind &&
                        // a one-line profile's welcome is the material's own target (no #line)
                        (item.lineId === slot.lineId || (item.lineId === null && slot.kind === 'welcome')),
                    ) ?? null,
                }
              : {}),
          })),
          createdAt: row.created_at,
        };
      });
  }
  /**
   * A new 素材版本 for the draft as it is now. Saves nothing: the voice is the draft's binding, or the one derived from the
   * Fish id a profile import recorded. Clips of an earlier version whose text and voice are unchanged are carried over by
   * `carry` (called right after), so only what changed needs a new clip.
   */
  prepare(actor: Actor, id: string, input: unknown) {
    record(input);
    keys(input, ['requestId', 'draftRevision', 'profileHash', 'referenceId', 'model']);
    identifier(input.requestId);
    if (input.referenceId !== undefined) identifier(input.referenceId);
    ensure(
      Number.isSafeInteger(input.draftRevision) &&
        Number(input.draftRevision) > 0 &&
        typeof input.profileHash === 'string' &&
        /^[a-f0-9]{64}$/.test(input.profileHash) &&
        (input.model === undefined ||
          input.model === 's2.1-pro' ||
          input.model === PINNED_S21_BINDING ||
          input.model === 'drama-3'),
      'INVALID_MATERIAL_REQUEST',
    );
    const requestId = input.requestId,
      typedReference = input.referenceId as string | undefined,
      model = (input.model ?? 's2.1-pro') as VoiceModelBinding;
    const revision = Number(input.draftRevision),
      hash = input.profileHash,
      requestHash = contentHash([actor.memberId, id, input]);
    return this.store.transaction(() => {
      const prior = this.store.get<MaterialRow>('SELECT * FROM web_character_materials WHERE request_id=?', requestId);
      if (prior) {
        ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
        return { materialId: prior.id };
      }
      // The draft the page is looking at must still be the draft (the voice it shows is the one that is used).
      const draftRow = this.store.get<{ revision: number; content_hash: string }>(
        'SELECT revision,content_hash FROM web_character_drafts d JOIN web_character_revisions r USING(character_id,revision) WHERE d.character_id=?',
        id,
      );
      ensure(draftRow && draftRow.revision === revision && draftRow.content_hash === hash, 'DRAFT_CONFLICT');
      const profile = currentDraft(this.store, { character_id: id });
      const effective = effectiveVoice(this.store, id, profile.template);
      // The draft's own Fish id wins. A typed one (an older client) only fills in where the draft has none but a binding.
      const referenceId =
        effective && effective.source !== 'live' ? effective.referenceId : (typedReference ?? effective?.referenceId);
      const binding: VoiceBinding | undefined = profile.template.voice ?? effective?.binding;
      ensure(referenceId && binding, 'CHARACTER_VOICE_REQUIRED');
      ensure(
        this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_materials WHERE character_id=?', id)!.n <
          48,
        'MATERIAL_DRAFT_LIMIT',
      );
      const materialId = this.nextId(),
        voiceVersion = 'web-material-' + materialId,
        now = this.now();
      const evidence = JSON.stringify({
        kind: 'admin-material-v1',
        materialId,
        profileHash: hash,
        resolvedModel: resolveVoiceModel(model, siteVoiceModel(this.store)),
      });
      this.store.run(
        'INSERT INTO web_character_materials VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        materialId,
        requestId,
        requestHash,
        id,
        revision,
        hash,
        voiceVersion,
        binding.version,
        binding.profileId,
        referenceId,
        model,
        evidence,
        actor.memberId,
        actor.sessionId,
        now,
      );
      return { materialId };
    });
  }
  /**
   * After `prepare`: copy into the new 素材版本 every clip of an earlier one that has exactly the slot's text, in the same voice
   * (Fish id and model). Best effort: a clip that cannot be read stays an empty slot. Never throws, never calls the provider.
   */
  async carry(actor: Actor, id: string, materialId: string) {
    try {
      const row = this.row(id, materialId);
      const profile = currentDraft(this.store, { character_id: id });
      const state = materialState(this.store, row, profile);
      if (state.voiceStale) return;
      const sources = this.store
        .all<MaterialRow>(
          'SELECT * FROM web_character_materials WHERE character_id=? AND id!=? AND reference_id=? ORDER BY created_at DESC,id',
          id,
          materialId,
          row.reference_id,
        )
        .filter((source) => this.modelOf(source) === this.modelOf(row));
      for (const slot of state.slots) {
        if (slot.state !== 'empty') continue;
        for (const source of sources) {
          const found = clipFor(this.store, source.id, slot);
          if (!found || found.body !== slot.text) continue;
          const bytes = await this.readClip(id, source, slot).catch(() => null);
          if (!bytes) continue;
          await this.place(id, materialId, slot.kind, bytes, () => actor, slot.lineId ?? undefined).catch(
            () => undefined,
          );
          break;
        }
      }
    } catch {
      /* carrying over is a convenience only */
    }
  }
  private async readClip(
    id: string,
    source: MaterialRow,
    slot: { kind: MaterialKind; lineId: string | null },
  ): Promise<Uint8Array | null> {
    const line =
      slot.kind === 'welcome'
        ? this.store.get<LineRow>(
            'SELECT * FROM web_welcome_material_lines WHERE material_id=? AND line_id=?',
            source.id,
            slot.lineId,
          )
        : undefined;
    const asset = line
      ? line
      : this.store.get<AssetRow>(
          'SELECT * FROM web_character_material_assets WHERE material_id=? AND kind=?',
          source.id,
          slot.kind,
        );
    if (!asset) return null;
    return loadProviderAudio(
      this.store,
      asset,
      fixedObjectScope(
        this.store,
        slot.kind,
        id,
        line ? `${source.voice_version}#${line.line_id}` : source.voice_version,
      ),
      async () => undefined,
      new Map(),
    );
  }
  async upload(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['materialId', 'kind', 'lineId', 'base64']);
    ensure(input.kind === 'welcome' || input.kind === 'footer', 'INVALID_MATERIAL_KIND');
    ensure(
      typeof input.base64 === 'string' && input.base64.length > 0 && input.base64.length <= 8_000_000,
      'INVALID_MATERIAL_AUDIO',
    );
    const bytes = Buffer.from(input.base64, 'base64');
    ensure(bytes.toString('base64') === input.base64 && bytes.length <= 6_000_000, 'INVALID_MATERIAL_AUDIO');
    return this.place(id, input.materialId, input.kind, bytes, authorize, input.lineId);
  }
  /**
   * Which slot a request names. A footer is the footer (and exists only while the free tier is off). A welcome slot is the
   * single welcome of a one-line profile (a lineId, when given, must be that line) or, for 2+ lines, the slot of the named line.
   */
  private slot(profile: WebCharacterProfile, kind: MaterialKind, lineId: unknown) {
    if (kind === 'footer') {
      ensure(lineId === undefined, 'INVALID_MATERIAL_KIND');
      ensure(footerRequired(this.store), 'FOOTER_NOT_REQUIRED');
      return { kind, line: null, multi: false, text: SYNTHETIC_TRIAL_FOOTER };
    }
    const lines = profile.presentation.welcomes;
    if (lines.length === 1) {
      ensure(lineId === undefined || lineId === lines[0]!.id, 'INVALID_MATERIAL_KIND');
      return { kind, line: lines[0]!, multi: false, text: lines[0]!.text };
    }
    identifier(lineId);
    const line = lines.find((item) => item.id === lineId);
    ensure(line, 'INVALID_MATERIAL_KIND');
    return { kind, line, multi: true, text: line.text };
  }
  /** The scope string of a slot's private object: the single welcome and the footer as before, a line clip names its line. */
  private scopeVersion(row: MaterialRow, slot: { multi: boolean; line: { id: string } | null }) {
    return slot.multi ? `${row.voice_version}#${slot.line!.id}` : row.voice_version;
  }
  private generated(characterId: string, purpose: 'material-welcome' | 'material-footer', sha256: string) {
    return (
      !!this.speech && webAdminSpeechInstalled(this.store) && this.speech.generatedFor(characterId, purpose, sha256)
    );
  }
  private lineView(characterId: string, line: LineRow) {
    return {
      ...lineDTO(line),
      origin: this.generated(characterId, 'material-welcome', line.sha256)
        ? ('generated' as const)
        : ('uploaded' as const),
    };
  }
  /** An asset as the page sees it: the stored facts plus where the audio came from. Never part of the manifest hash. */
  private view(characterId: string, asset: AssetRow) {
    return {
      ...assetDTO(asset),
      origin: this.generated(characterId, `material-${asset.kind}`, asset.sha256)
        ? ('generated' as const)
        : ('uploaded' as const),
    };
  }
  /** The checks every slot audio passes, uploaded or generated: PCM16 WAV, mono, 24 kHz, not silent, at most 60 s, 6 MB. */
  private checked(bytes: Uint8Array) {
    ensure(bytes.length > 0 && bytes.length <= 6_000_000, 'INVALID_MATERIAL_AUDIO');
    const info = inspectPCM(bytes, 60_000),
      duration = Math.round(info.durationMs);
    ensure(
      info.channels === 1 && info.sampleRate === 24000 && duration > 0 && pcmLevels(bytes).rms > 0.001,
      'INVALID_MATERIAL_AUDIO',
    );
    return { duration, digest: sha(bytes) };
  }
  private approvedAlready(materialId: string) {
    return !!this.store.get('SELECT 1 FROM web_character_material_approvals WHERE material_id=?', materialId);
  }
  /** Put audio into a slot (upload and 生成 share this): same checks, same immutability, same staging. */
  private async place(
    id: string,
    materialId: unknown,
    kind: MaterialKind,
    bytes: Uint8Array,
    authorize: () => Actor,
    lineId?: unknown,
  ) {
    const { duration, digest } = this.checked(bytes);
    const row = this.row(id, materialId);
    const guard = () => {
      authorize();
      usableDraft(this.store, row);
    };
    guard();
    const profile = usableDraft(this.store, row),
      slot = this.slot(profile, kind, lineId);
    const existingClip = () => clipFor(this.store, row.id, { kind, lineId: slot.line?.id ?? null });
    const dto = () =>
      slot.multi
        ? lineDTO(materialLines(this.store, row.id).find((item) => item.line_id === slot.line!.id)!)
        : assetDTO(materialAssets(this.store, row.id).find((item) => item.kind === kind)!);
    const prior = existingClip();
    if (prior) {
      ensure(prior.sha256 === digest && prior.byteLength === bytes.length, 'MATERIAL_AUDIO_IMMUTABLE');
      return dto();
    }
    // A version that was approved is fixed: it cannot gain a clip afterwards (a new 素材版本 carries the rest over).
    ensure(!this.approvedAlready(row.id), 'MATERIAL_STALE');
    const scope = fixedObjectScope(this.store, kind, id, this.scopeVersion(row, slot));
    const reference = this.store.providerAudio
      ? await this.store.providerAudio.stage(scope, bytes, async () => {
          guard();
        })
      : null;
    if (reference) checkAudioReference(reference, scope, bytes);
    return this.store.transaction(() => {
      guard();
      const existing = existingClip();
      if (existing) {
        ensure(existing.sha256 === digest && existing.byteLength === bytes.length, 'MATERIAL_AUDIO_IMMUTABLE');
        return dto();
      }
      ensure(!this.approvedAlready(row.id), 'MATERIAL_STALE');
      if (slot.multi) {
        this.store.run(
          'INSERT INTO web_welcome_material_lines VALUES (?,?,?,?,?,?,?,?,?,?)',
          row.id,
          slot.line!.id,
          slot.text,
          this.nextId(),
          digest,
          bytes.length,
          duration,
          reference ? null : bytes,
          reference ? JSON.stringify(reference) : null,
          this.now(),
        );
        return dto();
      }
      this.store.run(
        'INSERT INTO web_character_material_assets VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        row.id,
        kind,
        this.nextId(),
        slot.text,
        kind === 'welcome' ? slot.line!.id : null,
        digest,
        bytes.length,
        duration,
        reference ? null : bytes,
        reference ? JSON.stringify(reference) : null,
        this.now(),
      );
      return dto();
    });
  }
  /** What 生成 would say and cost for one slot, or why it cannot be offered. Reads only; nothing is held. */
  estimateGenerate(id: string, input: unknown) {
    record(input);
    keys(input, ['materialId', 'kind', 'lineId']);
    ensure(input.kind === 'welcome' || input.kind === 'footer', 'INVALID_MATERIAL_KIND');
    ensure(this.speech, 'SPEECH_UNAVAILABLE');
    const row = this.row(id, input.materialId),
      kind = input.kind;
    const profile = currentDraft(this.store, row);
    if (!materialState(this.store, row, profile).valid || this.approvedAlready(row.id))
      return { ok: false as const, reason: 'STALE' };
    const slot = this.slot(profile, kind, input.lineId);
    if (this.filled(row.id, slot)) return { ok: false as const, reason: 'SLOT_HAS_AUDIO' };
    return this.speech.estimateCalls(id, row.revision, [
      {
        characterId: id,
        revision: row.revision,
        purpose: `material-${kind}`,
        targetId: this.targetId(row.id, slot),
        requestId: 'estimate',
        ordinal: 0,
        text: slot.text,
        voice: { profileId: row.profile_id, version: row.voice_revision, referenceId: row.reference_id },
        model: this.modelOf(row),
      },
    ]);
  }
  private filled(materialId: string, slot: { kind: MaterialKind; line: { id: string } | null }) {
    return !!clipFor(this.store, materialId, { kind: slot.kind, lineId: slot.line?.id ?? null });
  }
  /** The ledger's target for a slot: the 素材版本, plus `#line` for a line of a multi-line welcome. */
  private targetId(materialId: string, slot: { multi: boolean; line: { id: string } | null }) {
    return slot.multi ? `${materialId}#${slot.line!.id}` : materialId;
  }
  /**
   * 生成: speak exactly the slot's text in the voice this 素材版本 was prepared with, then register the clip like an upload
   * (origin 'generated'). It never approves. A slot that already has audio is not regenerated (MATERIAL_AUDIO_IMMUTABLE) unless
   * this is a replay of the very request that filled it.
   */
  async generate(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['requestId', 'materialId', 'kind', 'lineId', 'acknowledgeMicros']);
    identifier(input.requestId);
    ensure(input.kind === 'welcome' || input.kind === 'footer', 'INVALID_MATERIAL_KIND');
    ensure(
      typeof input.acknowledgeMicros === 'number' && Number.isSafeInteger(input.acknowledgeMicros),
      'INVALID_MATERIAL_REQUEST',
    );
    ensure(this.speech, 'SPEECH_UNAVAILABLE');
    const row = this.row(id, input.materialId),
      kind = input.kind,
      requestId = input.requestId,
      acknowledgeMicros = input.acknowledgeMicros;
    const guard = () => {
      authorize();
      usableDraft(this.store, row);
    };
    // A replay of a call that already ended UNKNOWN or failed answers from the ledger, even if the draft moved since.
    const replay = this.speech.hasRequest(requestId, 0);
    if (!replay) guard();
    const profile = replay ? currentDraft(this.store, row) : usableDraft(this.store, row),
      slot = this.slot(profile, kind, input.lineId);
    if (this.filled(row.id, slot)) ensure(replay, 'MATERIAL_AUDIO_IMMUTABLE');
    const { audio } = await this.speech.speak(
      () => {
        guard();
        return authorize();
      },
      {
        characterId: id,
        revision: row.revision,
        purpose: `material-${kind}`,
        targetId: this.targetId(row.id, slot),
        requestId,
        ordinal: 0,
        text: slot.text,
        voice: { profileId: row.profile_id, version: row.voice_revision, referenceId: row.reference_id },
        model: this.modelOf(row),
        acknowledgeMicros,
      },
    );
    await this.place(id, row.id, kind, audio, authorize, input.lineId);
    return slot.multi
      ? this.lineView(id, materialLines(this.store, row.id).find((item) => item.line_id === slot.line!.id)!)
      : this.view(id, materialAssets(this.store, row.id).find((asset) => asset.kind === kind)!);
  }
  async audio(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['materialId', 'kind', 'lineId']);
    ensure(input.kind === 'welcome' || input.kind === 'footer', 'INVALID_MATERIAL_KIND');
    const row = this.row(id, input.materialId);
    const slot =
      input.kind === 'footer'
        ? { kind: 'footer' as const, line: null, multi: false }
        : (() => {
            const lineRow =
              input.lineId === undefined
                ? undefined
                : this.store.get<LineRow>(
                    'SELECT * FROM web_welcome_material_lines WHERE material_id=? AND line_id=?',
                    row.id,
                    String(input.lineId),
                  );
            return { kind: 'welcome' as const, line: lineRow ? { id: lineRow.line_id } : null, multi: !!lineRow };
          })();
    const asset = slot.multi
      ? this.store.get<LineRow>(
          'SELECT * FROM web_welcome_material_lines WHERE material_id=? AND line_id=?',
          row.id,
          slot.line!.id,
        )
      : this.store.get<AssetRow>(
          'SELECT * FROM web_character_material_assets WHERE material_id=? AND kind=?',
          row.id,
          input.kind,
        );
    ensure(asset, 'NOT_FOUND');
    const bytes = await loadProviderAudio(
      this.store,
      asset,
      fixedObjectScope(this.store, input.kind, id, this.scopeVersion(row, slot)),
      async () => {
        authorize();
      },
      new Map(),
    );
    ensure(sha(bytes) === asset.sha256 && bytes.length === asset.byte_length, 'INVALID_MATERIAL_AUDIO');
    authorize();
    return {
      ...(slot.multi ? lineDTO(asset as LineRow) : assetDTO(asset as AssetRow)),
      mimeType: 'audio/wav',
      base64: Buffer.from(bytes).toString('base64'),
    };
  }
  async approve(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, [
      'materialId',
      'acknowledgeRights',
      'acknowledgeWelcomeListening',
      'acknowledgeLines',
      'acknowledgeFooterListening',
      'note',
    ]);
    nonempty(input.note, 1000);
    const note = input.note,
      row = this.row(id, input.materialId);
    // Every slot must have been heard and ticked: the single welcome, or EVERY line of a multi-line welcome, and the footer
    // (only while the free tier is off, when the footer exists at all).
    const lines = usableDraft(this.store, row).presentation.welcomes,
      needFooter = footerRequired(this.store),
      heard = Array.isArray(input.acknowledgeLines) ? new Set(input.acknowledgeLines as unknown[]) : new Set<unknown>();
    ensure(
      input.acknowledgeRights === true &&
        (!needFooter || input.acknowledgeFooterListening === true) &&
        (lines.length === 1
          ? input.acknowledgeWelcomeListening === true
          : heard.size === lines.length && lines.every((line) => heard.has(line.id))),
      'MATERIAL_APPROVAL_REQUIRED',
    );
    const guard = () => {
      const actor = authorize();
      usableDraft(this.store, row);
      return actor;
    };
    guard();
    ensure(materialState(this.store, row, usableDraft(this.store, row)).complete, 'CHARACTER_MATERIALS_REQUIRED');
    // Re-read and hash private objects before approval; stale permissions/drafts cannot commit after R2 awaits.
    if (needFooter) await this.audio(id, { materialId: row.id, kind: 'footer' }, guard);
    for (const line of lines) {
      const inLines = materialLines(this.store, row.id).some((item) => item.line_id === line.id);
      await this.audio(id, { materialId: row.id, kind: 'welcome', ...(inLines ? { lineId: line.id } : {}) }, guard);
    }
    return this.store.transaction(() => {
      const actor = guard(),
        manifest = materialManifest(this.store, row),
        prior = this.store.get<{ manifest_hash: string; note: string }>(
          'SELECT * FROM web_character_material_approvals WHERE material_id=?',
          row.id,
        );
      if (prior) ensure(prior.manifest_hash === manifest && prior.note === note, 'MATERIAL_APPROVAL_IMMUTABLE');
      else {
        this.store.run(
          'INSERT INTO web_character_material_approvals VALUES (?,?,?,?,?,?)',
          row.id,
          manifest,
          actor.memberId,
          actor.sessionId,
          note,
          this.now(),
        );
        this.store.run(
          'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
          actor.memberId,
          'character-material-approved',
          row.id,
          this.now(),
        );
      }
      return { materialId: row.id, manifestHash: manifest, approved: true };
    });
  }
}

/**
 * Called only inside the publication transaction after its proof and quiescence gates. `binding` is the voice the published
 * version carries (the draft's binding exactly, or the derived one); `lines` are the welcome lines of that version: a clip of
 * the 素材版本 that is no longer a line of it is not published.
 */
export function promoteCharacterMaterial(
  store: BusinessStore,
  row: MaterialRow,
  version: number,
  binding: { profileId: string; version: number },
  lines: { id: string; text: string }[],
) {
  store.run('INSERT INTO web_character_material_promotions VALUES (?,?,?)', row.character_id, version, row.id);
  const values = [
    row.character_id,
    row.voice_version,
    binding.version,
    binding.profileId,
    row.reference_id,
    row.model,
    'user_selected',
    1,
    row.evidence_json,
  ];
  store.run('INSERT INTO web_character_voice_history VALUES (?,?,?,?,?,?,?,?,?)', ...values);
  store.run(
    `INSERT INTO web_provider_voice_bindings VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(character_id) DO UPDATE SET
    voice_version=excluded.voice_version,voice_revision=excluded.voice_revision,profile_id=excluded.profile_id,
    reference_id=excluded.reference_id,model=excluded.model,source=excluded.source,approved=excluded.approved,evidence_json=excluded.evidence_json`,
    ...values,
  );
  const external = store
    .all<{ name: string }>('PRAGMA table_info(web_provider_welcome_assets)')
    .some((c) => c.name === 'audio_ref_json');
  for (const line of materialLines(store, row.id, true)) {
    if (!lines.some((item) => item.id === line.line_id && item.text === line.body)) continue;
    ensure(external === (line.audio_ref_json !== null), 'WEB_AUDIO_REFERENCE_INVALID');
    store.run(
      'INSERT INTO web_provider_welcome_lines VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      row.character_id,
      row.voice_version,
      line.line_id,
      line.body,
      line.media_id,
      line.sha256,
      line.byte_length,
      line.duration_ms,
      line.audio_bytes,
      line.audio_ref_json,
      line.created_at,
    );
  }
  for (const asset of materialAssets(store, row.id, true)) {
    ensure(external === (asset.audio_ref_json !== null), 'WEB_AUDIO_REFERENCE_INVALID');
    const welcome = asset.kind === 'welcome';
    if (welcome && !lines.some((item) => item.text === asset.body)) continue;
    store.run(
      `INSERT INTO web_provider_${asset.kind}_assets(character_id,voice_version,media_id,origin,body,sha256,byte_length,
      duration_ms,audio_bytes,created_at${welcome ? ',text_version' : ''}${external ? ',audio_ref_json' : ''})
      VALUES (?,?,?,'operator_approved',?,?,?,?,?,?${welcome ? ',?' : ''}${external ? ',?' : ''})`,
      row.character_id,
      row.voice_version,
      asset.media_id,
      asset.body,
      asset.sha256,
      asset.byte_length,
      asset.duration_ms,
      asset.audio_bytes,
      asset.created_at,
      ...(welcome ? [asset.text_version] : []),
      ...(external ? [asset.audio_ref_json] : []),
    );
  }
}
