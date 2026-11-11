import { createHash, randomUUID } from 'node:crypto';
import { EXPRESSIONS, SOUND_CUES } from '../../../packages/contracts/index.ts';
import type { Clock, Expression, SoundCue } from '../../../packages/contracts/index.ts';
import type { FishModel, VoiceIdentity } from '../../../packages/contracts/audio.ts';
import { DetailedError, DomainError, ensure } from '../../../packages/domain/errors.ts';
import { fishSpeechRequest } from '../../../workers/audio/fish.ts';
import { finalizeFishWav, inspectPCM } from '../../../workers/audio/wav.ts';
import { budgetHash } from '../budget/web-provider-budget-contract.ts';
import type { FakeFish } from '../generation/web-provider-runner.ts';
import { webSpeechRequest } from '../generation/web-speech-request.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { contentHash } from './admin-content-hash.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { installWebAdminSpeech } from './web-admin-speech-schema.ts';
import { readWebPreview } from './web-character-preview.ts';
import { identifier } from './template-validation.ts';
import { effectiveVoice } from './web-clip-manifest.ts';
import type { VoiceBinding } from '../../../packages/contracts/media.ts';

/** Same shared authority the live reply and the 预演 use. Provider is always 'fish' here. */
export interface WebAdminSpeechBudget {
  reserve(id: string, provider: 'fish', fingerprint: string, micros: number): void | Promise<void>;
  settle(id: string, fingerprint: string, micros: number, receipt: unknown): void | Promise<void>;
}
export type SpeechPurpose = 'material-welcome' | 'material-footer' | 'preview';
type Actor = { memberId: string; sessionId: string };
/** One line of text is bounded so one clip always fits a database row (a welcome line may be 200 characters). */
export const ADMIN_SPEECH_TEXT_MAX = 200;
const AUDIO_MAX_BYTES = 1_900_000;
/** A preview is at most this many bubbles; each is one Fish call. */
export const ADMIN_SPEECH_BUBBLES_MAX = 12;
const IN_FLIGHT_MAX = 2;

/**
 * The one admin-only "speak this text in this character's draft voice" call (Part 24k-1). A caller passes
 * (characterId, draft revision, text, purpose); the voice, the model, the price, the reservation and the bill are decided
 * here, never by the caller. Part 24k-2 will call `speak` once per welcome line.
 *
 * Money, exactly as for a live reply: the Fish price row must be in force (else a located refusal, before anything is held);
 * the local hold and the shared-budget reservation are made before the provider is called; once a call may have been sent a
 * failure or a missing receipt leaves it UNKNOWN: it is never sent again and its reservation is never released; a known bill
 * is settled in the shared budget exactly once, and `recoverBills` finishes that after a restart.
 */
export class WebAdminSpeech {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly fish: FakeFish;
  private readonly budget: WebAdminSpeechBudget;
  private readonly model: FishModel;
  private readonly nextId: () => string;
  private readonly inFlight = new Set<string>();
  private readonly settling = new Set<string>();
  constructor(
    store: BusinessStore,
    clock: Clock,
    fish: FakeFish,
    budget: WebAdminSpeechBudget,
    /** `FISH_VOICE_MODEL` (already validated at startup). */
    model: FishModel,
    nextId: () => string = randomUUID,
  ) {
    installWebAdminSpeech(store);
    this.store = store;
    this.clock = clock;
    this.fish = fish;
    this.budget = budget;
    this.model = model;
    this.nextId = nextId;
  }
  /** The model every un-pinned voice speaks with. */
  get siteModel(): FishModel {
    return this.model;
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  // ---- what a call would be ---------------------------------------------------------------------------------------
  /** The voice of a draft: its binding exactly, else the one derived from the Fish id a profile import recorded. */
  voiceFor(characterId: string, revision: number): VoiceIdentity | null {
    const draft = this.store.get<{ profile_json: string }>(
      'SELECT profile_json FROM web_character_revisions WHERE character_id=? AND revision=?',
      characterId,
      revision,
    );
    if (!draft) return null;
    const effective = effectiveVoice(
      this.store,
      characterId,
      (JSON.parse(draft.profile_json) as { template?: { voice?: VoiceBinding } }).template ?? {},
    );
    return effective
      ? {
          profileId: effective.binding.profileId,
          version: effective.binding.version,
          referenceId: effective.referenceId,
        }
      : null;
  }
  private price(model: FishModel = this.model) {
    const now = this.now();
    return this.store.get<{ id: string; upper_micros_per_unit: number }>(
      `SELECT id,upper_micros_per_unit FROM web_provider_prices
      WHERE provider='fish' AND model=? AND phase='speech' AND unit='byte' AND currency='USD' AND valid_from<=? AND valid_until>?
      ORDER BY version DESC LIMIT 1`,
      model,
      now,
      now,
    );
  }
  private requirePrice(model: FishModel = this.model) {
    const price = this.price(model);
    // A located refusal: it names the provider and the model whose price row is not in force, before anything is held.
    if (!price) throw new DetailedError('SPEECH_PRICE_REQUIRED', { provider: 'fish', model, unit: 'byte' });
    return price;
  }
  private speech(call: Call, voice: VoiceIdentity, jobId: string) {
    const model = call.model ?? this.model;
    ensure(
      typeof call.text === 'string' &&
        call.text.trim() &&
        [...call.text].length <= ADMIN_SPEECH_TEXT_MAX &&
        // The wire format reserves brackets and angle marks for direction text; the builder refuses them too.
        !/[[\]<>]/u.test(call.text),
      'SPEECH_TEXT_INVALID',
    );
    ensure(EXPRESSIONS.includes(call.expression ?? 'neutral'), 'SPEECH_TEXT_INVALID');
    ensure(call.soundCue === undefined || SOUND_CUES.includes(call.soundCue), 'SPEECH_TEXT_INVALID');
    const request = webSpeechRequest({
      jobId,
      text: call.text,
      expression: call.expression ?? 'neutral',
      voice,
      model,
      deliveryStyle: 'conversational',
      ...(call.soundCue === undefined ? {} : { soundCue: call.soundCue }),
      // Admin-bound voices were heard and chosen by a person: the same quality guard as a live reply on such a voice.
      userSelected: true,
    });
    return { request, prepared: fishSpeechRequest(request, model), model };
  }
  /** What one call would cost, without holding anything. Never throws for a state the page can show (it says why instead). */
  estimateCalls(characterId: string, revision: number, calls: Call[]) {
    const voice = this.voiceFor(characterId, revision);
    if (!voice) return { ok: false as const, reason: 'NO_VOICE_REFERENCE' };
    const model = calls[0]?.model ?? this.model;
    const price = this.price(model);
    if (!price) return { ok: false as const, reason: 'PRICE_MISSING' };
    let bytes = 0,
      characters = 0;
    try {
      for (const call of calls) {
        bytes += this.speech(call, voice, 'estimate').prepared.bytes;
        characters += [...call.text].length;
      }
    } catch {
      return { ok: false as const, reason: 'TEXT_INVALID' };
    }
    return {
      ok: true as const,
      calls: calls.length,
      characters,
      bytes,
      microsPerUnit: price.upper_micros_per_unit,
      estimateMicros: bytes * price.upper_micros_per_unit,
      model,
    };
  }

  // ---- the call ---------------------------------------------------------------------------------------------------
  /**
   * Speak one text. Idempotent per (requestId, ordinal): a replay returns the same clip and spends nothing; a replay of a
   * call that is unknown, failed or still running never sends again. `acknowledgeMicros` must equal the estimate the person
   * confirmed, or nothing is held (the price or the text changed since they looked).
   */
  async speak(
    authorize: () => Actor,
    input: Call & { acknowledgeMicros: number | null },
  ): Promise<{ clip: AdminClip; audio: Uint8Array }> {
    const actor = authorize();
    identifier(input.requestId);
    ensure(Number.isSafeInteger(input.ordinal) && input.ordinal >= 0 && input.ordinal < 64, 'SPEECH_REQUEST_INVALID');
    ensure(
      Number.isSafeInteger(input.revision) && input.revision > 0 && !webCharacterDeleted(this.store, input.characterId),
      'CHARACTER_DELETED',
    );
    const voice = input.voice ?? this.voiceFor(input.characterId, input.revision);
    ensure(voice, 'SPEECH_VOICE_REQUIRED');
    const requestHash = contentHash([
      actor.memberId,
      input.characterId,
      input.revision,
      input.purpose,
      input.targetId,
      input.ordinal,
      createHash('sha256').update(input.text).digest('hex'),
      input.expression ?? 'neutral',
      input.soundCue ?? null,
      voice,
      ...(input.model === undefined ? [] : [input.model]),
    ]);
    const prior = this.byRequest(input.requestId, input.ordinal);
    if (prior) return this.replay(prior, requestHash);
    ensure(this.inFlight.size < IN_FLIGHT_MAX, 'SPEECH_BUSY');
    const callModel = input.model ?? this.model;
    const price = this.requirePrice(callModel);
    const callId = this.nextId();
    const { request, prepared } = this.speech(input, voice, `adm-${callId}`);
    const held = prepared.bytes * price.upper_micros_per_unit;
    ensure(Number.isSafeInteger(held) && held > 0, 'SPEECH_TEXT_INVALID');
    ensure(input.acknowledgeMicros === held, 'SPEECH_ESTIMATE_CHANGED');
    const instance = this.store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
    ensure(instance, 'WEB_LOCAL_INSTANCE_MISMATCH');
    const budgetId = JSON.stringify([instance.instance_id, 'admin-speech', callId]);
    const fingerprint = budgetHash([
      actor.memberId,
      input.characterId,
      input.revision,
      input.requestId,
      input.ordinal,
      requestHash,
      prepared.requestHash,
      callModel,
      price.id,
      prepared.bytes,
      held,
    ]);
    // 1. The local hold and the intent row are one transaction; the price, the permission and the draft are checked in it.
    this.store.transaction(() => {
      const current = authorize();
      ensure(!webCharacterDeleted(this.store, input.characterId), 'CHARACTER_DELETED');
      ensure(
        this.store.get(
          'SELECT 1 FROM web_character_revisions WHERE character_id=? AND revision=?',
          input.characterId,
          input.revision,
        ),
        'NOT_FOUND',
      );
      ensure(this.byRequest(input.requestId, input.ordinal) === undefined, 'SPEECH_REQUEST_INVALID');
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros+?
          WHERE provider='fish' AND (limit_micros IS NULL OR held_micros+spent_micros+?<=limit_micros)
          AND held_micros<=9007199254740991-spent_micros-?`,
          held,
          held,
          held,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_EXHAUSTED',
      );
      this.store.run(
        `INSERT INTO web_speech_admin_calls(id,request_id,ordinal,request_hash,character_id,revision,purpose,target_id,
        text_sha256,characters,model,wire_hash,price_id,max_units,held_micros,budget_id,fingerprint,state,member_id,session_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'intent',?,?,?)`,
        callId,
        input.requestId,
        input.ordinal,
        requestHash,
        input.characterId,
        input.revision,
        input.purpose,
        input.targetId,
        createHash('sha256').update(input.text).digest('hex'),
        [...input.text].length,
        callModel,
        prepared.requestHash,
        price.id,
        prepared.bytes,
        held,
        budgetId,
        fingerprint,
        current.memberId,
        current.sessionId,
        this.now(),
      );
    });
    this.inFlight.add(callId);
    try {
      // 2. Reserve in the shared budget BEFORE the provider is called. A plain refusal (nothing reserved) returns the local hold.
      try {
        await this.budget.reserve(budgetId, 'fish', fingerprint, held);
      } catch (error) {
        if (error instanceof DomainError && error.code === 'WEB_SHARED_BUDGET_EXHAUSTED') {
          this.release(callId, held, error.code);
          throw error;
        }
        this.markUnknown(callId, causeCode(error));
        throw new DomainError('SPEECH_CALL_UNKNOWN');
      }
      // 3. The possible-send boundary, with the permission rechecked after the awaits.
      try {
        this.store.transaction(() => {
          authorize();
          ensure(!webCharacterDeleted(this.store, input.characterId), 'CHARACTER_DELETED');
          ensure(
            this.store.run("UPDATE web_speech_admin_calls SET state='sent' WHERE id=? AND state='intent'", callId)
              .changes === 1,
            'SPEECH_REQUEST_INVALID',
          );
        });
      } catch (error) {
        // Reserved but not sent: there is no release API, so both holds stay and the call is never made.
        this.markUnknown(callId, causeCode(error));
        throw error;
      }
      // 4. The call. Any failure from here on is UNKNOWN: kept, never retried.
      let result: Awaited<ReturnType<FakeFish>>;
      try {
        result = await this.fish(
          {
            body: prepared.body,
            wireRequestHash: prepared.requestHash,
            model: callModel,
            billedTextBytes: prepared.bytes,
            speech: request,
          },
          new AbortController().signal,
          // The send gate, exactly as a live reply passes one: the provider Worker calls it at the last moment before the
          // request leaves. A missing gate is refused by the transport (WEB_PROVIDER_SEND_GATE_REQUIRED).
          () => {
            authorize();
            ensure(!webCharacterDeleted(this.store, input.characterId), 'CHARACTER_DELETED');
            ensure(
              this.store.get("SELECT 1 FROM web_speech_admin_calls WHERE id=? AND state='sent'", callId) !== undefined,
              'SPEECH_REQUEST_INVALID',
            );
          },
        );
      } catch (error) {
        this.markUnknown(callId, causeCode(error));
        throw new DomainError('SPEECH_CALL_UNKNOWN');
      }
      const units = result.usageUnits;
      if (!Number.isSafeInteger(units) || units < 0 || units > prepared.bytes || result.receipt === undefined) {
        this.markUnknown(callId, 'WEB_PROVIDER_USAGE_MISMATCH');
        throw new DomainError('SPEECH_CALL_UNKNOWN');
      }
      // 5. The bill is known. Whatever the audio turns out to be, the bill is recorded once and settled once.
      const audio = finalizeFishWav(result.audio).audio;
      let code: string | null = null,
        durationMs = 0;
      try {
        durationMs = Math.round(inspectPCM(audio, 60_000).durationMs);
        if (!(durationMs > 0) || audio.length > AUDIO_MAX_BYTES) code = 'SPEECH_AUDIO_INVALID';
      } catch {
        code = 'SPEECH_AUDIO_INVALID';
      }
      this.confirm(callId, code, units, result.receipt, code ? null : { audio, durationMs });
      await this.settleShared(callId).catch(() => undefined);
      if (code) throw new DomainError(code);
      return { clip: this.clipOf(callId), audio };
    } finally {
      this.inFlight.delete(callId);
    }
  }

  /** Whether a call with this request id and ordinal was ever made (a replay would spend nothing). */
  hasRequest(requestId: string, ordinal = 0) {
    return this.byRequest(requestId, ordinal) !== undefined;
  }
  /** The slot's clip is a generated one: a succeeded call of this character and purpose whose output is exactly these bytes. */
  generatedFor(characterId: string, purpose: SpeechPurpose, sha256: string) {
    return !!this.store.get(
      "SELECT 1 FROM web_speech_admin_calls WHERE character_id=? AND purpose=? AND outcome='succeeded' AND output_sha256=? LIMIT 1",
      characterId,
      purpose,
      sha256,
    );
  }
  private byRequest(requestId: string, ordinal: number) {
    return this.store.get<CallRow>(
      'SELECT * FROM web_speech_admin_calls WHERE request_id=? AND ordinal=?',
      requestId,
      ordinal,
    );
  }
  private replay(prior: CallRow, requestHash: string) {
    ensure(prior.request_hash === requestHash, 'IDEMPOTENCY_CONFLICT');
    if (prior.state === 'known') {
      if (prior.shared_settled === 0) void this.settleShared(prior.id).catch(() => undefined);
      ensure(prior.outcome === 'succeeded', prior.error_code ?? 'SPEECH_AUDIO_INVALID');
      const audio = this.store.get<{ audio: Uint8Array }>(
        'SELECT audio FROM web_speech_admin_audio WHERE call_id=?',
        prior.id,
      );
      ensure(audio, 'SPEECH_AUDIO_GONE');
      return { clip: this.clipOf(prior.id), audio: audio.audio };
    }
    if (prior.state === 'released') throw new DomainError(prior.error_code ?? 'WEB_SHARED_BUDGET_EXHAUSTED');
    if (this.inFlight.has(prior.id)) throw new DomainError('SPEECH_IN_PROGRESS');
    // Not running in this process: it may have been sent. It stays unknown and is never sent again.
    this.markUnknown(prior.id, 'SPEECH_RESTARTED');
    throw new DomainError('SPEECH_CALL_UNKNOWN');
  }
  /** Reserved or sent, outcome not known: both holds stay for ever. */
  private markUnknown(id: string, code: string) {
    // The underlying error code (a fixed string, never an id or content) is kept on the row, shown on the slot and logged once.
    const changed = this.store.run(
      "UPDATE web_speech_admin_calls SET state='unknown',error_code=? WHERE id=? AND state IN ('intent','sent')",
      code,
      id,
    ).changes;
    if (changed !== 1) return;
    const row = this.store.get<{ purpose: string }>('SELECT purpose FROM web_speech_admin_calls WHERE id=?', id);
    console.log(JSON.stringify({ event: 'admin_speech_unknown', purpose: row?.purpose ?? 'unknown', code }));
  }
  /** Refused before any reservation existed: the local hold goes back; the row stays as the record. */
  private release(id: string, held: number, code: string) {
    this.store.transaction(() => {
      if (
        this.store.run(
          "UPDATE web_speech_admin_calls SET state='released',error_code=? WHERE id=? AND state='intent'",
          code,
          id,
        ).changes === 1
      )
        ensure(
          this.store.run(
            "UPDATE web_provider_spending SET held_micros=held_micros-? WHERE provider='fish' AND held_micros>=?",
            held,
            held,
          ).changes === 1,
          'WEB_PROVIDER_BUDGET_CONFLICT',
        );
    });
  }
  private confirm(
    id: string,
    errorCode: string | null,
    units: number,
    receipt: unknown,
    audio: { audio: Uint8Array; durationMs: number } | null,
  ) {
    this.store.transaction(() => {
      const row = this.store.get<CallRow>('SELECT * FROM web_speech_admin_calls WHERE id=?', id);
      ensure(row && (row.state === 'sent' || row.state === 'unknown'), 'SPEECH_BILL_UNCONFIRMED');
      const price = this.store.get<{ upper_micros_per_unit: number }>(
        'SELECT upper_micros_per_unit FROM web_provider_prices WHERE id=?',
        row.price_id,
      )!;
      const charged = units * price.upper_micros_per_unit;
      ensure(Number.isSafeInteger(charged) && charged <= row.held_micros, 'SPEECH_BILL_UNCONFIRMED');
      this.store.run(
        `UPDATE web_speech_admin_calls SET state='known',outcome=?,error_code=?,charged_micros=?,receipt_json=?,output_sha256=?,
        settled_at=? WHERE id=?`,
        errorCode ? 'failed' : 'succeeded',
        errorCode,
        charged,
        JSON.stringify(receipt),
        audio ? createHash('sha256').update(audio.audio).digest('hex') : null,
        this.now(),
        id,
      );
      ensure(
        this.store.run(
          `UPDATE web_provider_spending SET held_micros=held_micros-?,spent_micros=spent_micros+?
          WHERE provider='fish' AND held_micros>=?`,
          row.held_micros,
          charged,
          row.held_micros,
        ).changes === 1,
        'WEB_PROVIDER_BUDGET_CONFLICT',
      );
      if (audio)
        this.store.run(
          'INSERT INTO web_speech_admin_audio(call_id,sha256,byte_length,duration_ms,audio,created_at) VALUES (?,?,?,?,?,?)',
          id,
          createHash('sha256').update(audio.audio).digest('hex'),
          audio.audio.length,
          audio.durationMs,
          audio.audio,
          this.now(),
        );
    });
  }
  /** Settle a known bill in the shared budget, once. The flag is set only after the budget accepted it. */
  private async settleShared(id: string) {
    if (this.settling.has(id)) return;
    this.settling.add(id);
    try {
      const row = this.store.get<CallRow>('SELECT * FROM web_speech_admin_calls WHERE id=?', id);
      if (!row || row.shared_settled === 1) return;
      ensure(
        row.state === 'known' && row.charged_micros !== null && row.receipt_json !== null,
        'SPEECH_BILL_UNCONFIRMED',
      );
      await this.budget.settle(row.budget_id, row.fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
      this.store.run("UPDATE web_speech_admin_calls SET shared_settled=1 WHERE id=? AND state='known'", id);
    } finally {
      this.settling.delete(id);
    }
  }
  /** After a restart: a call that may have been sent becomes unknown (kept), a known bill that was not settled is settled. */
  async recoverBills() {
    let n = 0;
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_speech_admin_calls WHERE state IN ('intent','sent') LIMIT 16",
    ))
      if (!this.inFlight.has(row.id)) {
        this.markUnknown(row.id, 'SPEECH_RESTARTED');
        n++;
      }
    for (const row of this.store.all<{ id: string }>(
      "SELECT id FROM web_speech_admin_calls WHERE state='known' AND shared_settled=0 LIMIT 16",
    )) {
      await this.settleShared(row.id);
      n++;
    }
    return n;
  }
  /** Wake-up for the owner's timer: something to recover soon, else null. */
  nextDue() {
    const pending = this.store.get(
      `SELECT 1 FROM web_speech_admin_calls WHERE (state='known' AND shared_settled=0) OR state IN ('intent','sent') LIMIT 1`,
    );
    return pending ? this.now() + 10_000 : null;
  }

  // ---- reading ----------------------------------------------------------------------------------------------------
  private clipOf(id: string): AdminClip {
    const row = this.store.get<CallRow & { sha256: string; byte_length: number; duration_ms: number }>(
      `SELECT c.*,a.sha256,a.byte_length,a.duration_ms FROM web_speech_admin_calls c
      JOIN web_speech_admin_audio a ON a.call_id=c.id WHERE c.id=?`,
      id,
    );
    ensure(row, 'SPEECH_AUDIO_GONE');
    return {
      callId: row.id,
      ordinal: row.ordinal,
      purpose: row.purpose,
      sha256: row.sha256,
      byteLength: row.byte_length,
      durationMs: row.duration_ms,
      chargedMicros: row.charged_micros ?? 0,
      settled: row.shared_settled === 1,
    };
  }
  /** The clips of one purpose target (a 预演, a 素材版本 slot) that still have their audio, in order. */
  clips(characterId: string, purpose: SpeechPurpose, targetId: string): AdminClip[] {
    return this.store
      .all<{ id: string }>(
        `SELECT c.id FROM web_speech_admin_calls c JOIN web_speech_admin_audio a ON a.call_id=c.id
        WHERE c.character_id=? AND c.purpose=? AND c.target_id=? ORDER BY c.created_at,c.ordinal`,
        characterId,
        purpose,
        targetId,
      )
      .map((row) => this.clipOf(row.id));
  }
  /**
   * Calls of a 素材版本's slots that ended UNKNOWN or released, with the underlying code (a fixed string). An UNKNOWN call is
   * never resent and keeps its hold, so the slot shows it for as long as it has no clip.
   */
  slotIssues(characterId: string, materialId: string) {
    return this.store
      .all<{ purpose: string; target_id: string; state: string; error_code: string | null }>(
        `SELECT purpose,target_id,state,error_code FROM web_speech_admin_calls
        WHERE character_id=? AND purpose IN ('material-welcome','material-footer') AND (target_id=? OR target_id GLOB ?)
        AND state IN ('unknown','released') ORDER BY created_at DESC,id`,
        characterId,
        materialId,
        `${materialId}#*`,
      )
      .map((row) => ({
        kind: row.purpose === 'material-footer' ? ('footer' as const) : ('welcome' as const),
        lineId: row.target_id.includes('#') ? row.target_id.slice(row.target_id.indexOf('#') + 1) : null,
        state: row.state as 'unknown' | 'released',
        code: row.error_code ?? (row.state === 'unknown' ? 'SPEECH_CALL_UNKNOWN' : 'WEB_SHARED_BUDGET_EXHAUSTED'),
      }));
  }
  /** Admin-only audio of one call, scoped to the character in the URL. */
  audio(characterId: string, callId: unknown) {
    identifier(callId);
    const row = this.store.get<{ audio: Uint8Array; sha256: string; duration_ms: number }>(
      `SELECT a.audio,a.sha256,a.duration_ms FROM web_speech_admin_audio a JOIN web_speech_admin_calls c ON c.id=a.call_id
      WHERE c.id=? AND c.character_id=?`,
      callId,
      characterId,
    );
    ensure(row, 'NOT_FOUND');
    return {
      mimeType: 'audio/wav' as const,
      sha256: row.sha256,
      durationMs: row.duration_ms,
      base64: Buffer.from(row.audio).toString('base64'),
    };
  }

  // ---- 预演 试听 --------------------------------------------------------------------------------------------------
  /** The final bubbles of a succeeded 预演 of this character, as calls. */
  previewCalls(characterId: string, previewId: string, requestId: string): { revision: number; calls: Call[] } {
    const row = readWebPreview(this.store, previewId);
    ensure(row.character_id === characterId, 'NOT_FOUND');
    ensure(row.status === 'succeeded' && row.result_json, 'SPEECH_PREVIEW_NOT_READY');
    const reply = (JSON.parse(row.result_json) as { reply?: { bubbles?: unknown } }).reply;
    const bubbles = Array.isArray(reply?.bubbles) ? (reply.bubbles as Record<string, unknown>[]) : [];
    ensure(bubbles.length > 0 && bubbles.length <= ADMIN_SPEECH_BUBBLES_MAX, 'SPEECH_PREVIEW_NOT_READY');
    return {
      revision: row.revision,
      calls: bubbles.map((b, ordinal) => ({
        characterId,
        revision: row.revision,
        purpose: 'preview' as const,
        targetId: previewId,
        requestId,
        ordinal,
        text: typeof b.text === 'string' ? b.text : '',
        expression: (EXPRESSIONS as readonly string[]).includes(b.expression as string)
          ? (b.expression as Expression)
          : 'neutral',
        ...((SOUND_CUES as readonly string[]).includes(b.soundCue as string)
          ? { soundCue: b.soundCue as SoundCue }
          : {}),
      })),
    };
  }
  estimatePreview(characterId: string, previewId: string) {
    const row = readWebPreview(this.store, previewId);
    ensure(row.character_id === characterId, 'NOT_FOUND');
    if (row.status !== 'succeeded') return { ok: false as const, reason: 'NOT_SUCCEEDED' };
    let planned;
    try {
      planned = this.previewCalls(characterId, previewId, 'estimate');
    } catch {
      return { ok: false as const, reason: 'NO_BUBBLES' };
    }
    return this.estimateCalls(characterId, planned.revision, planned.calls);
  }
  /** Speak every final bubble in order. One request id covers the whole listen; each bubble is its own bill. */
  async listenPreview(
    authorize: () => Actor,
    characterId: string,
    previewId: string,
    requestId: string,
    acknowledgeMicros: unknown,
  ) {
    identifier(requestId);
    const planned = this.previewCalls(characterId, previewId, requestId);
    const voice = this.voiceFor(characterId, planned.revision);
    ensure(voice, 'SPEECH_VOICE_REQUIRED');
    // Bubbles already spoken under this request id are replayed for free; the rest are what the person confirmed.
    const fresh = planned.calls.filter((call) => !this.byRequest(requestId, call.ordinal));
    const total = fresh.reduce((sum, call) => sum + this.speech(call, voice, 'estimate').prepared.bytes, 0);
    const price = fresh.length ? this.requirePrice() : null;
    ensure(
      fresh.length === 0 ||
        (Number.isSafeInteger(acknowledgeMicros) && acknowledgeMicros === total * price!.upper_micros_per_unit),
      'SPEECH_ESTIMATE_CHANGED',
    );
    const clips: AdminClip[] = [];
    for (const call of planned.calls) {
      const prepared = this.speech(call, voice, 'estimate').prepared;
      const { clip } = await this.speak(authorize, {
        ...call,
        acknowledgeMicros: price ? prepared.bytes * price.upper_micros_per_unit : null,
      });
      clips.push(clip);
    }
    return { clips };
  }
}

/** A fixed, safe code for whatever ended a call: a DomainError's code, else a generic one. Never a message. */
function causeCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code ?? (error instanceof Error ? error.message : '');
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) ? code : 'SPEECH_PROVIDER_FAILED';
}

export type Call = {
  characterId: string;
  revision: number;
  purpose: SpeechPurpose;
  /** What the clip is for: a 素材版本 id or a 预演 id. */
  targetId: string;
  requestId: string;
  ordinal: number;
  text: string;
  expression?: Expression;
  soundCue?: SoundCue;
  /** Overrides the draft's voice (a 素材版本 speaks in the voice it was prepared with). */
  voice?: VoiceIdentity;
  /** The model that will actually speak (a 素材版本's resolved model). Absent: the site's voice model. */
  model?: FishModel;
};
export interface AdminClip {
  callId: string;
  ordinal: number;
  purpose: SpeechPurpose;
  sha256: string;
  byteLength: number;
  durationMs: number;
  chargedMicros: number;
  settled: boolean;
}
interface CallRow {
  id: string;
  request_id: string;
  ordinal: number;
  request_hash: string;
  character_id: string;
  revision: number;
  purpose: SpeechPurpose;
  target_id: string;
  model: string;
  price_id: string;
  max_units: number;
  held_micros: number;
  budget_id: string;
  fingerprint: string;
  state: 'intent' | 'sent' | 'unknown' | 'known' | 'released';
  outcome: 'succeeded' | 'failed' | null;
  error_code: string | null;
  charged_micros: number | null;
  receipt_json: string | null;
  shared_settled: 0 | 1;
}
