import { randomUUID, createHash } from 'node:crypto';
import { resolveVoiceModel, type VoiceModelBinding } from '../../../packages/contracts/audio.ts';
import type { Clock } from '../../../packages/contracts/index.ts';
import { DetailedError, ensure } from '../../../packages/domain/errors.ts';
import { NO_ONSET_CODE, placeVoiceStart } from '../../../workers/audio/leading-onset.ts';
import { stripDirectionMarkup } from '../../../workers/audio/fish.ts';
import {
  checkAudioReference,
  fixedObjectScope,
  loadProviderAudio,
  type ProviderAudioStore,
} from '../audio/web-provider-media.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { identifier, keys, record } from './template-validation.ts';
import { currentDraft, type WebCharacterMaterials } from './web-character-materials.ts';
import { clipManifest, effectiveVoice, footerRequired, siteVoiceModel } from './web-clip-manifest.ts';
import { installWebClipTakes } from './web-clip-takes-schema.ts';
import { CLIP_FEEDBACK_MAX, type WebClipDirection } from './web-clip-direction.ts';
import { webWelcomeLinesInstalled } from './web-welcome-schema.ts';
import { adminSpeechGenerated, adminSpeechTakeIssues } from './web-admin-speech-schema.ts';

/**
 * Part 30 section 1: SLOTS and TAKES. A slot is one welcome line (by line id) or the footer (only while required), identified by
 * its text and the voice. A slot holds takes (generated, generated from feedback, uploaded); the person marks ONE as 选用 and
 * approves per slot. A take is usable for a slot while its text is the slot's text and its voice is the character's voice: a
 * changed line makes ONLY that slot need a new take, a changed voice makes every slot need one. Nothing here writes a 素材版本
 * until a publication asks for one (`bundle`), and nothing published ever changes.
 */
type Actor = { memberId: string; sessionId: string };
type Store = BusinessStore & ProviderAudioStore;
/** The binding every new generated take is made with: it follows the site voice model. */
const NEW_TAKE_BINDING: VoiceModelBinding = 's2.1-pro';
const NAME_MAX = 20;
const NOTE_MAX = 200;
const slotKeyOf = (slot: { kind: 'welcome' | 'footer'; lineId: string | null }) =>
  slot.kind === 'footer' ? 'footer' : `line:${slot.lineId}`;

interface TakeRow {
  id: string;
  request_id: string | null;
  character_id: string;
  slot_key: string;
  ordinal: number;
  origin: 'generated' | 'feedback' | 'uploaded';
  status: 'ready' | 'unusable';
  name: string;
  note: string;
  feedback: string | null;
  markup: string | null;
  body: string;
  reference_id: string;
  binding: string;
  resolved_model: string;
  scope_version: string;
  sha256: string | null;
  byte_length: number | null;
  duration_ms: number | null;
  audio_bytes: Uint8Array | null;
  audio_ref_json: string | null;
  call_id: string | null;
  error_code: string | null;
  created_at: number;
}
interface ChoiceRow {
  slot_key: string;
  take_id: string;
  approved_sha256: string | null;
  approved_at: number | null;
}
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;

export class WebClipTakes {
  private readonly store: Store;
  private readonly clock: Clock;
  private readonly materials: WebCharacterMaterials;
  private readonly nextId: () => string;
  private direction: WebClipDirection | null = null;
  constructor(store: Store, clock: Clock, materials: WebCharacterMaterials, nextId: () => string = randomUUID) {
    installWebClipTakes(store);
    this.store = store;
    this.clock = clock;
    this.materials = materials;
    this.nextId = nextId;
    this.migrate();
  }
  /** Turn on 按反馈重录 (the text model). */
  enableDirection(direction: WebClipDirection) {
    this.direction = direction;
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }

  // ---- migration: every existing 素材版本 clip becomes a take, an approved version's clips become 选用 + approved ------------
  /**
   * Idempotent runtime step (no numbered migration), once per 素材版本 (web_clip_migrated). A take points at the very private
   * object the version already holds (same scope), so no audio is copied and nothing published changes. Versions are read oldest
   * first: a later approved version's clip becomes the slot's 选用 + approved take.
   */
  private migrate() {
    if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_character_materials'")) return;
    const materials = this.store.all<{
      id: string;
      character_id: string;
      reference_id: string;
      model: string;
      evidence_json: string;
      created_at: number;
    }>(
      `SELECT m.id,m.character_id,m.reference_id,m.model,m.evidence_json,m.created_at FROM web_character_materials m
      WHERE NOT EXISTS(SELECT 1 FROM web_clip_migrated x WHERE x.material_id=m.id) ORDER BY m.created_at,m.rowid`,
    );
    for (const m of materials)
      this.store.transaction(() => {
        const approved = this.store.get<{ manifest_hash: string }>(
          'SELECT manifest_hash FROM web_character_material_approvals WHERE material_id=?',
          m.id,
        );
        const evidence = JSON.parse(m.evidence_json) as { resolvedModel?: string };
        const made =
          evidence.resolvedModel ?? resolveVoiceModel(m.model as VoiceModelBinding, siteVoiceModel(this.store));
        const voiceVersion = this.store.get<{ voice_version: string }>(
          'SELECT voice_version FROM web_character_materials WHERE id=?',
          m.id,
        )!.voice_version;
        const lines = webWelcomeLinesInstalled(this.store)
          ? this.store.all<{
              line_id: string;
              body: string;
              sha256: string;
              byte_length: number;
              duration_ms: number;
              audio_bytes: Uint8Array | null;
              audio_ref_json: string | null;
              created_at: number;
            }>('SELECT * FROM web_welcome_material_lines WHERE material_id=? ORDER BY line_id', m.id)
          : [];
        const assets = this.store.all<{
          kind: 'welcome' | 'footer';
          body: string;
          text_version: string | null;
          sha256: string;
          byte_length: number;
          duration_ms: number;
          audio_bytes: Uint8Array | null;
          audio_ref_json: string | null;
          created_at: number;
        }>('SELECT * FROM web_character_material_assets WHERE material_id=?', m.id);
        const found: {
          slotKey: string;
          kind: 'welcome' | 'footer';
          scope: string;
          row: {
            body: string;
            sha256: string;
            byte_length: number;
            duration_ms: number;
            audio_bytes: Uint8Array | null;
            audio_ref_json: string | null;
            created_at: number;
          };
        }[] = [];
        for (const line of lines)
          found.push({
            slotKey: `line:${line.line_id}`,
            kind: 'welcome',
            scope: `${voiceVersion}#${line.line_id}`,
            row: line,
          });
        for (const asset of assets) {
          if (asset.kind === 'footer')
            found.push({ slotKey: 'footer', kind: 'footer', scope: voiceVersion, row: asset });
          else if (asset.text_version)
            found.push({ slotKey: `line:${asset.text_version}`, kind: 'welcome', scope: voiceVersion, row: asset });
        }
        for (const clip of found) {
          // One take per (slot, sha256, voice): a clip identical to a take that is already there (a version that carried it over, a
          // bundle made from takes) reuses that take; for an approved version the reused take becomes 选用 + approved below.
          const same = this.store.get<{ id: string }>(
            `SELECT id FROM web_clip_takes WHERE character_id=? AND slot_key=? AND sha256=? AND reference_id=? AND resolved_model=?
            AND status='ready' ORDER BY ordinal LIMIT 1`,
            m.character_id,
            clip.slotKey,
            clip.row.sha256,
            m.reference_id,
            made,
          );
          const id =
            same?.id ?? `mig-${createHash('sha256').update(`${m.id}|${clip.slotKey}`).digest('hex').slice(0, 40)}`;
          if (!same) {
            const ordinal = this.nextOrdinal(m.character_id, clip.slotKey);
            this.store.run(
              `INSERT INTO web_clip_takes(id,request_id,character_id,slot_key,ordinal,origin,status,name,note,feedback,markup,body,
              reference_id,binding,resolved_model,scope_version,sha256,byte_length,duration_ms,audio_bytes,audio_ref_json,call_id,
              error_code,created_at) VALUES (?,NULL,?,?,?,?,'ready',?,'',NULL,NULL,?,?,?,?,?,?,?,?,?,?,NULL,NULL,?)`,
              id,
              m.character_id,
              clip.slotKey,
              ordinal,
              adminSpeechGenerated(this.store, m.character_id, `material-${clip.kind}`, clip.row.sha256)
                ? 'generated'
                : 'uploaded',
              `第 ${ordinal} 条`,
              clip.row.body,
              m.reference_id,
              m.model,
              made,
              clip.scope,
              clip.row.sha256,
              clip.row.byte_length,
              clip.row.duration_ms,
              clip.row.audio_bytes,
              clip.row.audio_ref_json,
              clip.row.created_at,
            );
          }
          if (approved)
            this.store.run(
              `INSERT INTO web_clip_choices(character_id,slot_key,take_id,approved_sha256,approved_at,updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(character_id,slot_key) DO UPDATE SET take_id=excluded.take_id,approved_sha256=excluded.approved_sha256,
              approved_at=excluded.approved_at,updated_at=excluded.updated_at`,
              m.character_id,
              clip.slotKey,
              id,
              clip.row.sha256,
              m.created_at,
              m.created_at,
            );
        }
        this.store.run('INSERT INTO web_clip_migrated VALUES (?)', m.id);
      });
  }
  private nextOrdinal(characterId: string, slotKey: string) {
    return (
      (this.store.get<{ n: number | null }>(
        'SELECT MAX(ordinal) n FROM web_clip_takes WHERE character_id=? AND slot_key=?',
        characterId,
        slotKey,
      )?.n ?? 0) + 1
    );
  }

  // ---- the state of the slots --------------------------------------------------------------------------------------
  private context(id: string) {
    const profile = currentDraft(this.store, { character_id: id });
    const effective = effectiveVoice(this.store, id, profile.template);
    const draft = this.store.get<{ revision: number }>(
      'SELECT revision FROM web_character_drafts WHERE character_id=?',
      id,
    );
    ensure(draft, 'DRAFT_CONFLICT');
    const manifest = clipManifest(this.store, profile, { referenceId: effective?.referenceId ?? '' }, NEW_TAKE_BINDING);
    return {
      profile,
      effective,
      revision: draft.revision,
      slots: manifest.slots.map((slot) => ({ ...slot, key: slotKeyOf(slot) })),
      model: manifest.voice.model,
    };
  }
  private usable(take: TakeRow, slot: { text: string }, referenceId: string | null) {
    return (
      take.status === 'ready' &&
      take.body === slot.text &&
      referenceId !== null &&
      take.reference_id === referenceId &&
      resolveVoiceModel(take.binding as VoiceModelBinding, siteVoiceModel(this.store)) === take.resolved_model
    );
  }
  private takesOf(id: string) {
    const columns =
      'id,request_id,character_id,slot_key,ordinal,origin,status,name,note,feedback,markup,body,reference_id,binding,resolved_model,scope_version,sha256,byte_length,duration_ms,NULL audio_bytes,NULL audio_ref_json,call_id,error_code,created_at';
    return this.store.all<TakeRow>(
      `SELECT ${columns} FROM web_clip_takes WHERE character_id=? ORDER BY slot_key,ordinal`,
      id,
    );
  }
  private choices(id: string) {
    return this.store.all<ChoiceRow>('SELECT * FROM web_clip_choices WHERE character_id=?', id);
  }
  private approvedTake(choice: ChoiceRow | undefined, take: TakeRow | undefined) {
    return !!choice && !!take && choice.approved_sha256 !== null && choice.approved_sha256 === take.sha256;
  }

  /** Everything the 声音 tab and the 发布 tab show. No audio. */
  view(id: string) {
    const ctx = this.context(id);
    const takes = this.takesOf(id),
      choices = this.choices(id);
    const issues = [...this.speechIssues(id), ...this.directionIssues(id)];
    const slots = ctx.slots.map((slot) => {
      const mine = takes.filter((take) => take.slot_key === slot.key);
      const choice = choices.find((c) => c.slot_key === slot.key);
      const chosen = mine.find((take) => take.id === choice?.take_id);
      const selectedOk = !!chosen && this.usable(chosen, slot, ctx.effective?.referenceId ?? null);
      const newest = mine.reduce((max, take) => Math.max(max, take.created_at), 0);
      return {
        slotKey: slot.key,
        kind: slot.kind,
        lineId: slot.lineId,
        text: slot.text,
        takes: mine.map((take) => ({
          takeId: take.id,
          name: take.name,
          note: take.note,
          origin: take.origin,
          status: take.status,
          durationMs: take.duration_ms,
          sha256: take.sha256,
          createdAt: take.created_at,
          selected: choice?.take_id === take.id,
          usable: this.usable(take, slot, ctx.effective?.referenceId ?? null),
          ...(take.feedback ? { feedback: take.feedback } : {}),
          ...(take.markup ? { markup: take.markup } : {}),
          ...(take.error_code ? { errorCode: take.error_code } : {}),
        })),
        selectedTakeId: selectedOk ? choice!.take_id : null,
        approved: selectedOk && this.approvedTake(choice, chosen),
        /** Calls of this slot that ended UNKNOWN or refused after its newest take: 「未确认 · CODE」. */
        issue: issues.find((issue) => issue.slotKey === slot.key && issue.at >= newest) ?? null,
      };
    });
    return {
      voice: ctx.effective
        ? {
            referenceId: ctx.effective.referenceId,
            model: ctx.model,
            /** The voice's page on fish.audio (https://fish.audio/m/<id>, the URL the Fish SDK docs show for a model). */
            url: `https://fish.audio/m/${encodeURIComponent(ctx.effective.referenceId)}`,
            speed: ctx.effective.binding.speed,
          }
        : null,
      footerRequired: footerRequired(this.store),
      speechAvailable: !!this.materials.speechPath,
      directionAvailable: !!this.direction,
      slots,
      /** Publishing needs an approved 选用 take in every slot. */
      ready: slots.length > 0 && slots.every((slot) => slot.approved),
    };
  }
  private speechIssues(id: string) {
    return adminSpeechTakeIssues(this.store, id).map((row) => ({
      slotKey: row.target_id.slice('take:'.length),
      state: row.state === 'known' ? ('failed' as const) : (row.state as 'unknown' | 'released'),
      code: row.error_code ?? (row.state === 'unknown' ? 'SPEECH_CALL_UNKNOWN' : 'WEB_SHARED_BUDGET_EXHAUSTED'),
      at: row.created_at,
    }));
  }
  private directionIssues(id: string) {
    if (!this.direction) return [];
    return this.direction.issues(id).map((row) => ({
      slotKey: row.slot_key,
      state: row.state === 'known' ? ('failed' as const) : (row.state as 'unknown' | 'released'),
      code: row.error_code ?? (row.state === 'unknown' ? 'CLIP_DIRECTION_UNKNOWN' : 'WEB_SHARED_BUDGET_EXHAUSTED'),
      at: row.created_at,
    }));
  }
  private slot(id: string, slotKey: unknown) {
    ensure(typeof slotKey === 'string', 'INVALID_MATERIAL_KIND');
    const ctx = this.context(id);
    const slot = ctx.slots.find((item) => item.key === slotKey);
    ensure(slot, 'INVALID_MATERIAL_KIND');
    return { ctx, slot };
  }
  private takeRow(id: string, takeId: unknown, withAudio = false) {
    identifier(takeId);
    const row = this.store.get<TakeRow>(`SELECT * FROM web_clip_takes WHERE id=? AND character_id=?`, takeId, id);
    ensure(row, 'NOT_FOUND');
    if (!withAudio) return { ...row, audio_bytes: null, audio_ref_json: null };
    return row;
  }
  private scopeOf(id: string, take: Pick<TakeRow, 'slot_key' | 'scope_version'>) {
    return fixedObjectScope(this.store, take.slot_key === 'footer' ? 'footer' : 'welcome', id, take.scope_version);
  }

  // ---- reading audio -----------------------------------------------------------------------------------------------
  async audio(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['takeId']);
    const take = this.takeRow(id, input.takeId, true);
    ensure(take.status === 'ready' && take.sha256, 'NOT_FOUND');
    const bytes = await loadProviderAudio(
      this.store,
      take,
      this.scopeOf(id, take),
      async () => void authorize(),
      new Map(),
    );
    ensure(
      createHash('sha256').update(bytes).digest('hex') === take.sha256 && bytes.length === take.byte_length,
      'INVALID_MATERIAL_AUDIO',
    );
    authorize();
    return {
      takeId: take.id,
      sha256: take.sha256,
      durationMs: take.duration_ms,
      mimeType: 'audio/wav' as const,
      base64: Buffer.from(bytes).toString('base64'),
    };
  }

  // ---- adding takes ------------------------------------------------------------------------------------------------
  /** Store a take: stage the private object first (async), then write the row and, for the first usable take, choose it. */
  private async insert(
    id: string,
    slotKey: string,
    ctx: ReturnType<WebClipTakes['context']>,
    slot: { text: string },
    take: {
      requestId: string | null;
      origin: TakeRow['origin'];
      audio: Uint8Array | null;
      errorCode?: string;
      feedback?: string;
      markup?: string;
      callId?: string;
      binding?: VoiceModelBinding;
    },
    authorize: () => Actor,
  ) {
    ensure(ctx.effective, 'CHARACTER_VOICE_REQUIRED');
    const takeId = this.nextId();
    const fixed = take.audio ? this.materials.checked(take.audio) : null;
    const scopeVersion = `take-${takeId}`;
    const scope = fixedObjectScope(this.store, slotKey === 'footer' ? 'footer' : 'welcome', id, scopeVersion);
    const reference =
      take.audio && this.store.providerAudio
        ? await this.store.providerAudio.stage(scope, take.audio, async () => void authorize())
        : null;
    if (reference && take.audio) checkAudioReference(reference, scope, take.audio);
    const binding = take.binding ?? NEW_TAKE_BINDING;
    return this.store.transaction(() => {
      authorize();
      if (take.requestId) {
        const prior = this.store.get<{ id: string }>(
          'SELECT id FROM web_clip_takes WHERE request_id=?',
          take.requestId,
        );
        if (prior) return prior.id;
      }
      const ordinal = this.nextOrdinal(id, slotKey);
      this.store.run(
        `INSERT INTO web_clip_takes(id,request_id,character_id,slot_key,ordinal,origin,status,name,note,feedback,markup,body,
        reference_id,binding,resolved_model,scope_version,sha256,byte_length,duration_ms,audio_bytes,audio_ref_json,call_id,
        error_code,created_at) VALUES (?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        takeId,
        take.requestId,
        id,
        slotKey,
        ordinal,
        take.origin,
        fixed ? 'ready' : 'unusable',
        `第 ${ordinal} 条`,
        take.feedback ?? null,
        take.markup ?? null,
        slot.text,
        ctx.effective!.referenceId,
        binding,
        resolveVoiceModel(binding, siteVoiceModel(this.store)),
        scopeVersion,
        fixed ? fixed.digest : null,
        fixed && take.audio ? take.audio.length : null,
        fixed ? fixed.duration : null,
        fixed && !reference ? take.audio : null,
        reference ? JSON.stringify(reference) : null,
        take.callId ?? null,
        fixed ? null : (take.errorCode ?? 'WEB_SPEECH_NO_ONSET'),
        this.now(),
      );
      if (fixed) {
        // The first usable take of a slot is chosen at once (the person can always choose another). An unusable or stale choice is replaced.
        const choice = this.store.get<{ take_id: string }>(
          'SELECT take_id FROM web_clip_choices WHERE character_id=? AND slot_key=?',
          id,
          slotKey,
        );
        const chosen = choice
          ? this.store.get<TakeRow>('SELECT * FROM web_clip_takes WHERE id=?', choice.take_id)
          : undefined;
        if (!chosen || !this.usable(chosen, slot, ctx.effective!.referenceId)) this.choose(id, slotKey, takeId);
      }
      return takeId;
    });
  }
  private choose(id: string, slotKey: string, takeId: string) {
    this.store.run(
      `INSERT INTO web_clip_choices(character_id,slot_key,take_id,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(character_id,slot_key) DO UPDATE SET take_id=excluded.take_id,approved_sha256=NULL,approved_by=NULL,
      approved_session=NULL,approved_note=NULL,approved_at=NULL,updated_at=excluded.updated_at`,
      id,
      slotKey,
      takeId,
      this.now(),
    );
  }
  private takeView(id: string, takeId: string) {
    const slotKey = this.takeRow(id, takeId).slot_key;
    const slot = this.view(id).slots.find((item) => item.slotKey === slotKey);
    const take = slot?.takes.find((item) => item.takeId === takeId);
    ensure(take, 'NOT_FOUND');
    return { slotKey, ...take };
  }
  /** An uploaded WAV (any time, also after a generation). Unchanged: no silence is added, the bytes are the person's. */
  async upload(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['slotKey', 'base64', 'name']);
    ensure(
      typeof input.base64 === 'string' && input.base64.length > 0 && input.base64.length <= 8_000_000,
      'INVALID_MATERIAL_AUDIO',
    );
    const bytes = Buffer.from(input.base64, 'base64');
    ensure(bytes.toString('base64') === input.base64 && bytes.length <= 6_000_000, 'INVALID_MATERIAL_AUDIO');
    const { ctx, slot } = this.slot(id, input.slotKey);
    const takeId = await this.insert(
      id,
      slot.key,
      ctx,
      slot,
      { requestId: null, origin: 'uploaded', audio: bytes },
      authorize,
    );
    if (input.name !== undefined) this.renameTake(id, takeId, input.name, undefined);
    return this.takeView(id, takeId);
  }

  // ---- 生成 ---------------------------------------------------------------------------------------------------------
  private speechCall(
    id: string,
    slot: { key: string; kind: 'welcome' | 'footer'; text: string },
    ctx: ReturnType<WebClipTakes['context']>,
    extra: { requestId: string; markup?: string },
  ) {
    ensure(ctx.effective, 'CHARACTER_VOICE_REQUIRED');
    return {
      characterId: id,
      revision: ctx.revision,
      purpose: `material-${slot.kind}` as const,
      targetId: `take:${slot.key}`,
      requestId: extra.requestId,
      ordinal: 0,
      text: slot.text,
      ...(extra.markup === undefined ? {} : { markup: extra.markup }),
      voice: {
        profileId: ctx.effective.binding.profileId,
        version: ctx.effective.binding.version,
        referenceId: ctx.effective.referenceId,
      },
      model: ctx.model,
    };
  }
  /** What generating these slots would cost (one number for all of them). Reads only. */
  estimate(id: string, input: unknown) {
    record(input);
    keys(input, ['slotKeys', 'markup']);
    const speech = this.materials.speechPath;
    ensure(speech, 'SPEECH_UNAVAILABLE');
    ensure(
      Array.isArray(input.slotKeys) && input.slotKeys.length > 0 && input.slotKeys.length <= 64,
      'INVALID_MATERIAL_KIND',
    );
    const ctx = this.context(id);
    const calls = input.slotKeys.map((key) => {
      const slot = ctx.slots.find((item) => item.key === key);
      ensure(slot, 'INVALID_MATERIAL_KIND');
      return this.speechCall(id, slot, ctx, {
        requestId: 'estimate',
        ...(typeof input.markup === 'string' ? { markup: input.markup } : {}),
      });
    });
    return speech.estimateCalls(id, ctx.revision, calls);
  }
  /** Settle one generation: speak, put the voice at 300 ms, store the take. NO_ONSET stores an unusable take and stops there. */
  private async speak(
    id: string,
    slot: { key: string; kind: 'welcome' | 'footer'; text: string },
    ctx: ReturnType<WebClipTakes['context']>,
    request: { requestId: string; markup?: string; feedback?: string },
    acknowledgeMicros: number,
    authorize: () => Actor,
  ) {
    const speech = this.materials.speechPath;
    ensure(speech, 'SPEECH_UNAVAILABLE');
    const prior = this.store.get<{ id: string }>('SELECT id FROM web_clip_takes WHERE request_id=?', request.requestId);
    if (prior) return prior.id;
    const call = this.speechCall(id, slot, ctx, request);
    const { clip, audio } = await speech.speak(authorize, { ...call, acknowledgeMicros });
    let placed: Uint8Array | null = null,
      errorCode: string | undefined;
    try {
      placed = placeVoiceStart(audio).audio;
    } catch (error) {
      if ((error as { code?: string }).code !== NO_ONSET_CODE) throw error;
      errorCode = NO_ONSET_CODE;
    }
    return this.insert(
      id,
      slot.key,
      ctx,
      slot,
      {
        requestId: request.requestId,
        origin: request.markup === undefined ? 'generated' : 'feedback',
        audio: placed,
        callId: clip.callId,
        ...(errorCode ? { errorCode } : {}),
        ...(request.feedback === undefined ? {} : { feedback: request.feedback }),
        ...(request.markup === undefined ? {} : { markup: request.markup }),
      },
      authorize,
    );
  }
  /** 生成 / 重录 / 按反馈重录 for ONE slot: one more take; the others stay. */
  async generate(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['requestId', 'slotKey', 'acknowledgeMicros', 'feedback', 'markup']);
    identifier(input.requestId);
    ensure(natural(input.acknowledgeMicros), 'INVALID_MATERIAL_REQUEST');
    const { ctx, slot } = this.slot(id, input.slotKey);
    let markup: string | undefined, feedback: string | undefined;
    if (input.markup !== undefined || input.feedback !== undefined) {
      ensure(
        typeof input.markup === 'string' &&
          typeof input.feedback === 'string' &&
          input.feedback.trim().length > 0 &&
          [...input.feedback].length <= CLIP_FEEDBACK_MAX,
        'CLIP_FEEDBACK_INVALID',
      );
      // The hard rule again, on what will really be sent: removing the markup gives the line's exact text.
      ensure(stripDirectionMarkup(input.markup) === slot.text && input.markup !== slot.text, 'CLIP_MARKUP_MISMATCH');
      markup = input.markup;
      feedback = input.feedback;
    }
    const takeId = await this.speak(
      id,
      slot,
      ctx,
      {
        requestId: input.requestId,
        ...(markup === undefined ? {} : { markup }),
        ...(feedback === undefined ? {} : { feedback }),
      },
      input.acknowledgeMicros as number,
      authorize,
    );
    return this.takeView(id, takeId);
  }
  /**
   * 生成全部: a take for every slot that has none, one call each, in order. One request id covers the run (each call is its own
   * bill and is reserved on its own). A call that ends UNKNOWN or refused is that slot's result; the others go on, and nothing is
   * ever sent twice (a replay of the same run answers from the ledger).
   */
  async generateAll(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['requestId', 'acknowledgeMicros']);
    identifier(input.requestId);
    ensure(natural(input.acknowledgeMicros), 'INVALID_MATERIAL_REQUEST');
    const speech = this.materials.speechPath;
    ensure(speech, 'SPEECH_UNAVAILABLE');
    const ctx = this.context(id);
    const requestOf = (index: number) => `${input.requestId}-${index}`;
    const open = ctx.slots
      .map((slot, index) => ({ slot, index }))
      .filter(({ slot, index }) => {
        // Slots already filled by THIS run (a replay) are answered from their take.
        if (this.store.get('SELECT 1 FROM web_clip_takes WHERE request_id=?', requestOf(index))) return true;
        return !this.takesOf(id).some(
          (take) => take.slot_key === slot.key && this.usable(take, slot, ctx.effective?.referenceId ?? null),
        );
      });
    ensure(open.length > 0, 'CLIP_NOTHING_TO_GENERATE');
    const per = open.map(({ slot, index }) => {
      const done = !!this.store.get('SELECT 1 FROM web_clip_takes WHERE request_id=?', requestOf(index));
      const priced =
        done || speech.hasRequest(requestOf(index), 0)
          ? null
          : speech.estimateCalls(id, ctx.revision, [this.speechCall(id, slot, ctx, { requestId: 'estimate' })]);
      ensure(!priced || priced.ok, 'SPEECH_ESTIMATE_CHANGED');
      return { slot, index, micros: priced && priced.ok ? priced.estimateMicros : 0 };
    });
    ensure(per.reduce((sum, item) => sum + item.micros, 0) === input.acknowledgeMicros, 'SPEECH_ESTIMATE_CHANGED');
    const results: { slotKey: string; takeId?: string; code?: string }[] = [];
    for (const item of per) {
      try {
        results.push({
          slotKey: item.slot.key,
          takeId: await this.speak(id, item.slot, ctx, { requestId: requestOf(item.index) }, item.micros, authorize),
        });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        results.push({ slotKey: item.slot.key, code: typeof code === 'string' ? code : 'SPEECH_PROVIDER_FAILED' });
      }
    }
    return { results };
  }
  /** What 按反馈重录 would hold for the rewrite (the text model). */
  estimateDirection(id: string, input: unknown) {
    record(input);
    keys(input, ['slotKey', 'feedback']);
    ensure(this.direction, 'SPEECH_UNAVAILABLE');
    const { slot } = this.slot(id, input.slotKey);
    return this.direction.estimate(slot.text, input.feedback);
  }
  /** The marked-up line for a take, from feedback. Shows it; nothing is generated yet. */
  async rewrite(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['requestId', 'slotKey', 'feedback']);
    identifier(input.requestId);
    ensure(this.direction, 'SPEECH_UNAVAILABLE');
    const { slot } = this.slot(id, input.slotKey);
    return this.direction.direct(authorize, {
      characterId: id,
      slotKey: slot.key,
      requestId: input.requestId,
      text: slot.text,
      feedback: input.feedback,
    });
  }

  // ---- choosing, naming, deleting ------------------------------------------------------------------------------------
  select(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['takeId']);
    const take = this.takeRow(id, input.takeId);
    const { ctx, slot } = this.slot(id, take.slot_key);
    ensure(this.usable(take, slot, ctx.effective?.referenceId ?? null), 'TAKE_NOT_USABLE');
    this.store.transaction(() => {
      authorize();
      const current = this.store.get<{ take_id: string }>(
        'SELECT take_id FROM web_clip_choices WHERE character_id=? AND slot_key=?',
        id,
        take.slot_key,
      );
      // Choosing the take that already is the 选用 one changes nothing (its approval stays).
      if (current?.take_id !== take.id) this.choose(id, take.slot_key, take.id);
    });
    return this.view(id);
  }
  private renameTake(id: string, takeId: unknown, name: unknown, note: unknown) {
    const take = this.takeRow(id, takeId);
    ensure(
      typeof name === 'string' && name.trim().length > 0 && [...name.trim()].length <= NAME_MAX,
      'CLIP_TAKE_NAME_INVALID',
    );
    ensure(note === undefined || (typeof note === 'string' && [...note].length <= NOTE_MAX), 'CLIP_TAKE_NAME_INVALID');
    this.store.run(
      'UPDATE web_clip_takes SET name=?,note=? WHERE id=?',
      name.trim(),
      note === undefined ? take.note : (note as string),
      take.id,
    );
  }
  rename(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['takeId', 'name', 'note']);
    this.renameTake(id, input.takeId, input.name, input.note);
    return this.view(id);
  }
  /** Delete a take, unless it is the 选用 take of an approved slot. The audio goes; the ledger rows of its call stay. */
  remove(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['takeId']);
    const take = this.takeRow(id, input.takeId);
    this.store.transaction(() => {
      authorize();
      const choice = this.store.get<ChoiceRow>(
        'SELECT * FROM web_clip_choices WHERE character_id=? AND slot_key=?',
        id,
        take.slot_key,
      );
      if (choice?.take_id === take.id) {
        ensure(choice.approved_sha256 === null, 'TAKE_IN_USE');
        this.store.run('DELETE FROM web_clip_choices WHERE character_id=? AND slot_key=?', id, take.slot_key);
      }
      this.store.run('DELETE FROM web_clip_takes WHERE id=?', take.id);
    });
    return this.view(id);
  }

  // ---- approval and the bundle a publication stands on ---------------------------------------------------------------
  /**
   * Approve slots: each named slot's 选用 take, heard to the end (「我已完整试听」) and with the rights confirmed. Per slot, not per
   * version: another slot's approval is untouched.
   */
  approve(id: string, input: unknown, authorize: () => Actor) {
    authorize();
    record(input);
    keys(input, ['slots', 'acknowledgeRights', 'note']);
    ensure(input.acknowledgeRights === true, 'MATERIAL_APPROVAL_REQUIRED');
    ensure(
      Array.isArray(input.slots) && input.slots.length > 0 && input.slots.length <= 64,
      'MATERIAL_APPROVAL_REQUIRED',
    );
    const note = typeof input.note === 'string' ? input.note.slice(0, 1000) : '';
    const picked = input.slots.map((entry: unknown) => {
      record(entry);
      keys(entry, ['slotKey', 'takeId', 'heard']);
      ensure(entry.heard === true, 'MATERIAL_APPROVAL_REQUIRED');
      return entry as { slotKey: string; takeId: string; heard: true };
    });
    const ctx = this.context(id);
    this.store.transaction(() => {
      const actor = authorize();
      for (const entry of picked) {
        const slot = ctx.slots.find((item) => item.key === entry.slotKey);
        ensure(slot, 'INVALID_MATERIAL_KIND');
        const choice = this.store.get<ChoiceRow>(
          'SELECT * FROM web_clip_choices WHERE character_id=? AND slot_key=?',
          id,
          slot.key,
        );
        const take = this.takeRow(id, entry.takeId);
        // The take the person heard must still be the 选用 take, and usable for the slot as it is now.
        ensure(
          choice?.take_id === take.id &&
            take.slot_key === slot.key &&
            this.usable(take, slot, ctx.effective?.referenceId ?? null),
          'TAKE_NOT_USABLE',
        );
        this.store.run(
          `UPDATE web_clip_choices SET approved_sha256=?,approved_by=?,approved_session=?,approved_note=?,approved_at=?,updated_at=?
          WHERE character_id=? AND slot_key=?`,
          take.sha256,
          actor.memberId,
          actor.sessionId,
          note,
          this.now(),
          this.now(),
          id,
          slot.key,
        );
      }
      this.store.run(
        'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
        actor.memberId,
        'character-takes-approved',
        id,
        this.now(),
      );
    });
    return this.view(id);
  }
  /**
   * The 素材版本 a publication names: needs an approved 选用 take in EVERY current slot. The bundle is made from exactly those
   * takes (reusing an identical unpublished one), so a later change to the takes never touches what was published.
   */
  async bundle(id: string, authorize: () => Actor) {
    const actor = authorize();
    const ctx = this.context(id);
    ensure(ctx.effective, 'CHARACTER_VOICE_REQUIRED');
    const choices = this.choices(id);
    const picks: { kind: 'welcome' | 'footer'; lineId: string | null; bytes: Uint8Array; sha256: string }[] = [];
    const bindings = new Set<VoiceModelBinding>();
    let welcomes = 0;
    for (const slot of ctx.slots) {
      // The label the owner reads (欢迎 N / 结束); never an id.
      const label = slot.kind === 'footer' ? '结束' : `欢迎 ${++welcomes}`;
      const choice = choices.find((c) => c.slot_key === slot.key);
      const take = choice
        ? this.store.get<TakeRow>('SELECT * FROM web_clip_takes WHERE id=?', choice.take_id)
        : undefined;
      if (!take) throw new DetailedError('CLIP_SLOT_NOT_APPROVED', { slot: label });
      if (!this.usable(take, slot, ctx.effective.referenceId))
        throw new DetailedError('CLIP_TAKE_UNUSABLE', { slot: label });
      if (!this.approvedTake(choice, take)) throw new DetailedError('CLIP_SLOT_NOT_APPROVED', { slot: label });
      bindings.add(take.binding as VoiceModelBinding);
      const bytes = await loadProviderAudio(
        this.store,
        take,
        this.scopeOf(id, take),
        async () => void authorize(),
        new Map(),
      );
      ensure(createHash('sha256').update(bytes).digest('hex') === take.sha256, 'INVALID_MATERIAL_AUDIO');
      picks.push({ kind: slot.kind, lineId: slot.lineId, bytes, sha256: take.sha256! });
    }
    ensure(bindings.size > 0, 'CHARACTER_MATERIALS_REQUIRED');
    // Every take's audio is already rendered and approved, so the bundle may mix bindings (an older 素材版本 prepared with the
    // pin, newer takes that follow the site model). Each take keeps its own binding and resolved model as evidence. One binding
    // is kept as it is; a mix takes the unpinned word, which is what any new bundle carries and which materialState,
    // approvedCharacterMaterial and a restore all accept (they compare the bundle's own recorded model with its own binding).
    const binding: VoiceModelBinding = bindings.size === 1 ? [...bindings][0]! : NEW_TAKE_BINDING;
    return {
      materialId: await this.materials.buildBundle(
        actor,
        id,
        binding,
        picks,
        authorize,
        (materialId) => void this.store.run('INSERT OR IGNORE INTO web_clip_migrated VALUES (?)', materialId),
      ),
    };
  }
}
