import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { hasBroadcastPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { BUBBLE_LIMITS, inspectBubbles } from '../../../packages/domain/bubbles.ts';
import { DomainError, ensure } from '../../../packages/domain/errors.ts';
import { inspectPCM, pcmLevels } from '../../../workers/audio/wav.ts';
import { NO_ONSET_CODE, placeVoiceStart } from '../../../workers/audio/leading-onset.ts';
import { freeTier } from '../admission/web-free-tier.ts';
import { webTierSql } from '../admission/web-retention.ts';
import type { WebAccountAdmin } from '../admin/web-account-admin.ts';
import { contentHash } from '../characters/admin-content-hash.ts';
import { publishedWebCharacters } from '../characters/web-character-catalog.ts';
import { consoleCharacterOrder, sortByConsoleOrder } from '../characters/web-character-order.ts';
import { webCharacterDeleted } from '../characters/web-character-deleted.ts';
import type { WebAdminSpeech } from '../characters/web-admin-speech.ts';
import type { WebRuntimeStore } from '../platform/web-store-contract.ts';
import { webBroadcastInstalled } from './web-broadcast-schema.ts';
import { emptySession } from '../../../packages/domain/schedule.ts';

type Auth = { cookie: unknown; csrf: unknown; origin: unknown };
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (value: unknown): value is string => typeof value === 'string' && ID.test(value);
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const exact = (value: unknown, names: string[]): Record<string, unknown> => {
  ensure(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === [...names].sort().join(','),
    'INVALID_REQUEST',
  );
  return value as Record<string, unknown>;
};

/** What the page and the checks need to know about the limits. */
export const BROADCAST_LIMITS = Object.freeze({
  bubbles: BUBBLE_LIMITS.casual.maxBubbles,
  bubbleCharacters: BUBBLE_LIMITS.casual.maxCharacters,
  totalCharacters: BUBBLE_LIMITS.casual.maxTotalCharacters,
  /** A clip is one database row (a Durable Object row holds at most 2 MB), like the admin speech audio. */
  audioBytes: 1_900_000,
  uploadBase64: 2_700_000,
  characters: 64,
  /** The farthest a broadcast can be scheduled. */
  scheduleDays: 366,
  listMax: 50,
});
/** Players handled in one transaction. A broadcast is a series of these, so chat is never held for the whole send. */
export const BROADCAST_BATCH = 50;
/** One executor pass works at most this many batches, yielding between them. */
export const BROADCAST_BATCHES_PER_PASS = 8;
const MIN = 60_000;

export type BroadcastState = 'scheduled' | 'sending' | 'sent' | 'cancelled';
interface Row {
  id: string;
  member_id: string;
  state: BroadcastState;
  revision: number;
  send_at: number;
  bubbles_json: string;
  character_ids_json: string;
  recipients: number;
  total: number;
  delivered: number;
  cursor: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  cancelled_at: number | null;
}
interface TakeRow {
  id: string;
  character_id: string;
  origin: 'generated' | 'uploaded';
  text_sha256: string | null;
  sha256: string;
  byte_length: number;
  duration_ms: number;
  created_at: number;
}

/**
 * Part 42: 广播 - a character sends a text and/or voice message to every REGISTERED player.
 *
 * The business object is the only writer. The console routes only record a broadcast (a request-id-idempotent row); the executor's
 * alarm starts it at its time and writes the messages in short batches (a broadcast id and a recipient cursor), so a large send never
 * blocks chat and resumes after a restart without a duplicate. A delivered message is the CHARACTER's own message in the player's
 * conversation with it (history, the audio route and the writer's context read it as such); it costs the player nothing and is not
 * the player's chat. The record keeps counts only: no player identity, no message content in any list or log.
 */
export class WebBroadcast {
  private readonly store: WebRuntimeStore;
  private readonly clock: Clock;
  private readonly admin: WebAccountAdmin;
  private readonly speechPath: () => WebAdminSpeech | null;
  private readonly nextId: () => string;
  private readonly batch: number;
  constructor(
    store: WebRuntimeStore,
    clock: Clock,
    admin: WebAccountAdmin,
    speechPath: () => WebAdminSpeech | null = () => null,
    options: { nextId?: () => string; batch?: number } = {},
  ) {
    this.store = store;
    this.clock = clock;
    this.admin = admin;
    this.speechPath = speechPath;
    this.nextId = options.nextId ?? randomUUID;
    this.batch = options.batch ?? BROADCAST_BATCH;
    ensure(Number.isSafeInteger(this.batch) && this.batch >= 1 && this.batch <= 1000, 'INVALID_REQUEST');
  }
  private now() {
    const now = this.clock.now();
    ensure(Number.isSafeInteger(now) && now >= 0, 'INVALID_TIME');
    return now;
  }

  // ---- who may --------------------------------------------------------------------------------------------------------------
  private actor(auth: Auth) {
    ensure(webBroadcastInstalled(this.store), 'NOT_FOUND');
    const actor = this.admin.authorize(auth.cookie, auth.csrf, auth.origin);
    const member = this.admin.session(auth.cookie).member;
    ensure(actor.role === 'owner' || hasBroadcastPermission(member.permissions), 'ADMIN_PERMISSION_REQUIRED');
    return actor as typeof actor & { memberId: string; sessionId: string };
  }
  private audit(memberId: string, action: string, count: number) {
    // A fixed action and a count: never an id, a name or content.
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      memberId,
      action,
      `n=${count}`,
      this.now(),
    );
  }
  /** Runs `work` once per request id inside the caller's transaction; a repeat answers with the first result. */
  private once<T extends { id: string }>(
    kind: string,
    memberId: string,
    requestId: unknown,
    body: unknown,
    work: () => T,
    replay: (id: string) => T,
  ): T {
    ensure(isId(requestId), 'INVALID_REQUEST');
    const hash = contentHash([memberId, kind, body]);
    return this.store.transaction(() => {
      const prior = this.store.get<{ kind: string; request_hash: string; broadcast_id: string }>(
        'SELECT kind,request_hash,broadcast_id FROM web_broadcast_requests WHERE request_id=?',
        requestId,
      );
      if (prior) {
        ensure(prior.kind === kind && prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return replay(prior.broadcast_id);
      }
      const done = work();
      this.store.run(
        'INSERT INTO web_broadcast_requests(request_id,kind,request_hash,broadcast_id,member_id,created_at) VALUES (?,?,?,?,?,?)',
        requestId,
        kind,
        hash,
        done.id,
        memberId,
        this.now(),
      );
      return done;
    });
  }

  // ---- who receives ---------------------------------------------------------------------------------------------------------
  /** The registered players right now: everyone whose tier is not guest (the one definition the points grant uses), not being purged. */
  private recipientSql(now: number) {
    const schema = this.store.get<{ user_version: number }>('PRAGMA user_version')?.user_version ?? 0;
    const tier = webTierSql(schema, freeTier(this.store).on, now);
    const retention = this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_guest_retention'")
      ? "AND NOT EXISTS (SELECT 1 FROM web_guest_retention r WHERE r.principal_id=p.id AND r.state IN ('purging','purged'))"
      : '';
    return {
      sql: `SELECT id FROM (SELECT p.id id,${tier.sql} tier FROM web_principals p WHERE 1=1 ${retention}) WHERE tier!='guest'`,
      args: tier.args,
    };
  }
  recipientCount(now = this.now()) {
    const q = this.recipientSql(now);
    return this.store.get<{ n: number }>(`SELECT count(*) n FROM (${q.sql})`, ...q.args)!.n;
  }
  private isRecipient(principalId: string, now: number) {
    const q = this.recipientSql(now);
    return !!this.store.get(`SELECT 1 FROM (${q.sql}) WHERE id=?`, ...q.args, principalId);
  }

  // ---- the characters -------------------------------------------------------------------------------------------------------
  private live() {
    return publishedWebCharacters(this.store).filter((c) => !webCharacterDeleted(this.store, c.characterId));
  }
  /** The revision whose voice speaks: the draft, else the character's latest revision (a published character always has one). */
  private draftRevision(characterId: string) {
    if (!this.store.get("SELECT 1 FROM sqlite_master WHERE type='table' AND name='web_character_drafts'"))
      return undefined;
    return (
      this.store.get<{ revision: number }>(
        'SELECT revision FROM web_character_drafts WHERE character_id=?',
        characterId,
      )?.revision ??
      this.store.get<{ revision: number }>(
        'SELECT max(revision) revision FROM web_character_revisions WHERE character_id=?',
        characterId,
      )?.revision ??
      undefined
    );
  }
  private hasVoice(characterId: string) {
    const speech = this.speechPath();
    const revision = this.draftRevision(characterId);
    return !!speech && revision !== undefined && speech.voiceFor(characterId, revision) !== null;
  }

  /** The page's first read: the live characters in console order, whether each has a voice, and how many registered players there are. */
  options(auth: Auth) {
    this.actor(auth);
    const live = this.live();
    const order = consoleCharacterOrder(
      this.store,
      live.map((c) => c.characterId),
    );
    const byId = new Map(live.map((c) => [c.characterId, c] as const));
    return {
      characters: order
        .filter((id) => byId.has(id))
        .map((id) => ({
          characterId: id,
          name: byId.get(id)!.presentation.displayName,
          color: byId.get(id)!.presentation.color ?? null,
          voice: this.hasVoice(id),
        })),
      recipients: this.recipientCount(),
      speechAvailable: !!this.speechPath(),
      limits: BROADCAST_LIMITS,
      now: this.now(),
    };
  }

  // ---- validation -----------------------------------------------------------------------------------------------------------
  private bubbles(value: unknown) {
    ensure(
      Array.isArray(value) && value.length >= 1 && value.length <= BROADCAST_LIMITS.bubbles,
      'BROADCAST_TEXT_INVALID',
    );
    ensure(
      value.every((v) => typeof v === 'string'),
      'BROADCAST_TEXT_INVALID',
    );
    const texts = (value as string[]).map((text) => text.trim());
    const check = inspectBubbles(
      texts.map((text) => ({ text, expression: 'neutral' })),
      BUBBLE_LIMITS.casual,
    );
    ensure(check.issues.length === 0, 'BROADCAST_TEXT_INVALID');
    return texts;
  }
  private characters(value: unknown) {
    ensure(
      Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= BROADCAST_LIMITS.characters &&
        value.every(isId) &&
        new Set(value).size === value.length,
      'BROADCAST_CHARACTERS_INVALID',
    );
    const live = new Set(this.live().map((c) => c.characterId));
    ensure(
      (value as string[]).every((id) => live.has(id)),
      'BROADCAST_CHARACTERS_INVALID',
    );
    // Stored in the console's order, whatever order the page sent.
    return sortByConsoleOrder(consoleCharacterOrder(this.store, value as string[]), value as string[]);
  }
  private sendAt(value: unknown, now: number) {
    if (value === null) return now;
    ensure(
      Number.isSafeInteger(value) &&
        (value as number) >= now + MIN &&
        (value as number) <= now + BROADCAST_LIMITS.scheduleDays * 86_400_000,
      'BROADCAST_TIME_INVALID',
    );
    return value as number;
  }
  private acknowledge(value: unknown, characters: number, sendNow: boolean) {
    const ack = exact(value, ['characters', 'recipients']);
    ensure(ack.characters === characters, 'BROADCAST_COUNT_CHANGED');
    // A scheduled broadcast takes the registered players of its own time, so only a send now can name the recipients.
    if (sendNow) ensure(ack.recipients === this.recipientCount(), 'BROADCAST_COUNT_CHANGED');
  }
  /** The audio of a take as it is stored; the same checks as a clip: a WAV, mono 24 kHz, 16-bit, audible. */
  private checkedAudio(bytes: Uint8Array) {
    ensure(bytes.length > 0 && bytes.length <= BROADCAST_LIMITS.audioBytes, 'INVALID_BROADCAST_AUDIO');
    let info: ReturnType<typeof inspectPCM>;
    try {
      info = inspectPCM(bytes, 60_000);
    } catch {
      throw new DomainError('INVALID_BROADCAST_AUDIO');
    }
    const duration = Math.round(info.durationMs);
    ensure(
      info.channels === 1 && info.sampleRate === 24000 && duration > 0 && pcmLevels(bytes).rms > 0.001,
      'INVALID_BROADCAST_AUDIO',
    );
    return { duration, digest: sha(bytes) };
  }

  // ---- 语音: generate or upload a take --------------------------------------------------------------------------------------
  private speechCall(characterId: string, texts: string[]) {
    const speech = this.speechPath();
    ensure(speech, 'SPEECH_UNAVAILABLE');
    ensure(isId(characterId) && this.live().some((c) => c.characterId === characterId), 'BROADCAST_CHARACTERS_INVALID');
    const revision = this.draftRevision(characterId);
    ensure(revision !== undefined, 'CHARACTER_VOICE_REQUIRED');
    const voice = speech.voiceFor(characterId, revision);
    ensure(voice, 'CHARACTER_VOICE_REQUIRED');
    return { speech, revision, voice, text: texts.join('') };
  }
  /** What generating one voice would cost (reads only; nothing is held). */
  estimate(auth: Auth, input: unknown) {
    this.actor(auth);
    const body = exact(input, ['characterId', 'bubbles']);
    const texts = this.bubbles(body.bubbles);
    const { speech, revision, voice, text } = this.speechCall(body.characterId as string, texts);
    return speech.estimateCalls(body.characterId as string, revision, [
      {
        characterId: body.characterId as string,
        revision,
        purpose: 'preview',
        targetId: `broadcast:${body.characterId as string}`,
        requestId: 'estimate',
        ordinal: 0,
        text,
        voice,
      },
    ]);
  }
  private takeView(row: TakeRow) {
    return {
      takeId: row.id,
      characterId: row.character_id,
      origin: row.origin,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
    };
  }
  private insertTake(
    memberId: string,
    requestId: string | null,
    characterId: string,
    origin: 'generated' | 'uploaded',
    textSha: string | null,
    audio: Uint8Array,
  ) {
    const { duration, digest } = this.checkedAudio(audio);
    const id = this.nextId();
    this.store.run(
      `INSERT INTO web_broadcast_takes(id,request_id,member_id,character_id,origin,text_sha256,sha256,byte_length,duration_ms,audio,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      requestId,
      memberId,
      characterId,
      origin,
      textSha,
      digest,
      audio.length,
      duration,
      audio,
      this.now(),
    );
    return this.store.get<TakeRow>(
      'SELECT id,character_id,origin,text_sha256,sha256,byte_length,duration_ms,created_at FROM web_broadcast_takes WHERE id=?',
      id,
    )!;
  }
  /**
   * 生成: this character's own Fish voice through the existing admin speech path (its budget is reserved before the call, an
   * UNKNOWN call is never sent again and keeps its reservation), the voice placed at 0.3 s like a clip take, kept as a take to
   * listen to before sending. `acknowledgeMicros` is the estimate the person confirmed.
   */
  async speak(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    const body = exact(input, ['requestId', 'characterId', 'bubbles', 'acknowledgeMicros']);
    ensure(isId(body.requestId), 'INVALID_REQUEST');
    const texts = this.bubbles(body.bubbles);
    const requestId = body.requestId;
    const characterId = body.characterId as string;
    const prior = this.store.get<TakeRow>(
      `SELECT id,character_id,origin,text_sha256,sha256,byte_length,duration_ms,created_at FROM web_broadcast_takes WHERE request_id=?`,
      requestId,
    );
    if (prior) {
      ensure(prior.character_id === characterId && prior.text_sha256 === sha(texts.join('')), 'IDEMPOTENCY_CONFLICT');
      return this.takeView(prior);
    }
    const { speech, revision, voice, text } = this.speechCall(characterId, texts);
    ensure(Number.isSafeInteger(body.acknowledgeMicros) && (body.acknowledgeMicros as number) > 0, 'INVALID_REQUEST');
    const authorize = () => {
      const current = this.actor(auth);
      return { memberId: current.memberId, sessionId: current.sessionId };
    };
    const { audio } = await speech.speak(authorize, {
      characterId,
      revision,
      purpose: 'preview',
      targetId: `broadcast:${characterId}`,
      requestId,
      ordinal: 0,
      text,
      voice,
      acknowledgeMicros: body.acknowledgeMicros as number,
    });
    let placed: Uint8Array;
    try {
      placed = placeVoiceStart(audio).audio;
    } catch (error) {
      if ((error as { code?: string }).code === NO_ONSET_CODE) throw new DomainError(NO_ONSET_CODE);
      throw error;
    }
    return this.store.transaction(() => {
      authorize();
      const raced = this.store.get<TakeRow>(
        `SELECT id,character_id,origin,text_sha256,sha256,byte_length,duration_ms,created_at FROM web_broadcast_takes WHERE request_id=?`,
        requestId,
      );
      if (raced) return this.takeView(raced);
      return this.takeView(this.insertTake(actor.memberId, requestId, characterId, 'generated', sha(text), placed));
    });
  }
  /** 上传: a WAV for one character (the same checks as a clip upload; the bytes are the person's, nothing is added). */
  upload(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    const body = exact(input, ['characterId', 'base64']);
    ensure(
      typeof body.base64 === 'string' && body.base64.length > 0 && body.base64.length <= BROADCAST_LIMITS.uploadBase64,
      'INVALID_BROADCAST_AUDIO',
    );
    ensure(
      isId(body.characterId) && this.live().some((c) => c.characterId === body.characterId),
      'BROADCAST_CHARACTERS_INVALID',
    );
    const bytes = Buffer.from(body.base64, 'base64');
    ensure(bytes.toString('base64') === body.base64, 'INVALID_BROADCAST_AUDIO');
    return this.store.transaction(() =>
      this.takeView(this.insertTake(actor.memberId, null, body.characterId as string, 'uploaded', null, bytes)),
    );
  }
  /** The take as a person listens to it before sending (admin only; the bytes of the stored take). */
  takeAudio(auth: Auth, input: unknown) {
    this.actor(auth);
    const body = exact(input, ['takeId']);
    ensure(isId(body.takeId), 'INVALID_REQUEST');
    const row = this.store.get<{ audio: Uint8Array; duration_ms: number }>(
      'SELECT audio,duration_ms FROM web_broadcast_takes WHERE id=?',
      body.takeId,
    );
    ensure(row, 'NOT_FOUND');
    return { base64: Buffer.from(row.audio).toString('base64'), durationMs: row.duration_ms };
  }

  // ---- the record ------------------------------------------------------------------------------------------------------------
  private row(id: unknown) {
    ensure(isId(id), 'INVALID_REQUEST');
    const row = this.store.get<Row>('SELECT * FROM web_broadcasts WHERE id=?', id);
    ensure(row, 'NOT_FOUND');
    return row;
  }
  private names() {
    return new Map(publishedWebCharacters(this.store).map((c) => [c.characterId, c.presentation.displayName] as const));
  }
  private view(row: Row) {
    const names = this.names();
    const ids = JSON.parse(row.character_ids_json) as string[];
    const percent =
      row.state === 'sent'
        ? 100
        : row.state === 'sending'
          ? row.recipients === 0
            ? 100
            : Math.min(99, Math.floor((row.cursor / row.recipients) * 100))
          : 0;
    return {
      id: row.id,
      state: row.state,
      revision: row.revision,
      sendAt: row.send_at,
      createdAt: row.created_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      characters: ids.map((id) => ({ characterId: id, name: names.get(id) ?? '（已下线或已删除）' })),
      recipients: row.recipients,
      delivered: row.delivered,
      percent,
    };
  }
  /** The list: status, characters, time and the count of recipients. Never a player and never the text. */
  list(auth: Auth) {
    this.actor(auth);
    return {
      broadcasts: this.store
        .all<Row>('SELECT * FROM web_broadcasts ORDER BY created_at DESC,id DESC LIMIT ?', BROADCAST_LIMITS.listMax)
        .map((row) => this.view(row)),
      recipients: this.recipientCount(),
    };
  }
  /** One broadcast. Only a scheduled one carries its words and voices back: it is what the person edits. */
  detail(auth: Auth, input: unknown) {
    this.actor(auth);
    const row = this.row(exact(input, ['id']).id);
    const base = this.view(row);
    if (row.state !== 'scheduled') return { ...base, editable: false };
    const voices: Record<string, { kind: 'generated' | 'uploaded'; durationMs: number }> = {};
    for (const v of this.store.all<{ character_id: string; voice: 'generated' | 'uploaded'; duration_ms: number }>(
      "SELECT character_id,voice,duration_ms FROM web_broadcast_characters WHERE broadcast_id=? AND voice!='none'",
      row.id,
    ))
      voices[v.character_id] = { kind: v.voice, durationMs: v.duration_ms };
    return {
      ...base,
      editable: true,
      bubbles: JSON.parse(row.bubbles_json) as string[],
      characterIds: JSON.parse(row.character_ids_json) as string[],
      voices,
    };
  }

  /** The characters' voice rows of a broadcast, from the takes named (or kept). Inside the caller's transaction. */
  private writeCharacters(
    broadcastId: string,
    ids: string[],
    texts: string[],
    voices: Record<string, unknown>,
    keep: Map<
      string,
      { voice: 'generated' | 'uploaded'; sha256: string; byte_length: number; duration_ms: number; audio: Uint8Array }
    >,
  ) {
    ensure(
      Object.keys(voices).every((id) => ids.includes(id)),
      'BROADCAST_VOICE_INVALID',
    );
    this.store.run('DELETE FROM web_broadcast_characters WHERE broadcast_id=?', broadcastId);
    const joined = sha(texts.join(''));
    ids.forEach((characterId, ordinal) => {
      const spec = voices[characterId] ?? null;
      let voice: {
        voice: 'generated' | 'uploaded';
        sha256: string;
        byte_length: number;
        duration_ms: number;
        audio: Uint8Array;
      } | null = null;
      if (spec === 'keep') {
        voice = keep.get(characterId) ?? null;
        ensure(voice, 'BROADCAST_VOICE_INVALID');
      } else if (spec !== null) {
        ensure(isId(spec), 'BROADCAST_VOICE_INVALID');
        const take = this.store.get<TakeRow & { audio: Uint8Array }>(
          'SELECT * FROM web_broadcast_takes WHERE id=?',
          spec,
        );
        ensure(take && take.character_id === characterId, 'BROADCAST_VOICE_INVALID');
        // A generated voice reads exactly the words it was made from: changed words need a new one.
        ensure(take.origin === 'uploaded' || take.text_sha256 === joined, 'BROADCAST_VOICE_STALE');
        voice = {
          voice: take.origin,
          sha256: take.sha256,
          byte_length: take.byte_length,
          duration_ms: take.duration_ms,
          audio: take.audio,
        };
      }
      // A kept generated voice of words that have changed is stale as well.
      if (voice && spec === 'keep' && voice.voice === 'generated')
        ensure(this.keptTextMatches(broadcastId, characterId, joined), 'BROADCAST_VOICE_STALE');
      this.store.run(
        `INSERT INTO web_broadcast_characters(broadcast_id,character_id,ordinal,voice,sha256,byte_length,duration_ms,audio)
        VALUES (?,?,?,?,?,?,?,?)`,
        broadcastId,
        characterId,
        ordinal,
        voice?.voice ?? 'none',
        voice?.sha256 ?? null,
        voice?.byte_length ?? null,
        voice?.duration_ms ?? null,
        voice?.audio ?? null,
      );
    });
  }
  private keptTextMatches(broadcastId: string, _characterId: string, joinedSha: string) {
    const row = this.store.get<{ bubbles_json: string }>(
      'SELECT bubbles_json FROM web_broadcasts WHERE id=?',
      broadcastId,
    );
    return !!row && sha((JSON.parse(row.bubbles_json) as string[]).join('')) === joinedSha;
  }
  private voicesOf(value: unknown) {
    ensure(value && typeof value === 'object' && !Array.isArray(value), 'BROADCAST_VOICE_INVALID');
    return value as Record<string, unknown>;
  }

  /** 发送 (now or at a time): records the broadcast. The executor starts it at its time. */
  create(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    const body = exact(input, ['requestId', 'bubbles', 'characterIds', 'voices', 'sendAt', 'acknowledge']);
    const done = this.once(
      'create',
      actor.memberId,
      body.requestId,
      body,
      () => {
        const now = this.now();
        const texts = this.bubbles(body.bubbles);
        const ids = this.characters(body.characterIds);
        const sendAt = this.sendAt(body.sendAt, now);
        this.acknowledge(body.acknowledge, ids.length, body.sendAt === null);
        const id = this.nextId();
        this.store.run(
          `INSERT INTO web_broadcasts(id,member_id,state,send_at,bubbles_json,character_ids_json,created_at)
          VALUES (?,?,'scheduled',?,?,?,?)`,
          id,
          actor.memberId,
          sendAt,
          JSON.stringify(texts),
          JSON.stringify(ids),
          now,
        );
        this.writeCharacters(id, ids, texts, this.voicesOf(body.voices), new Map());
        this.audit(actor.memberId, body.sendAt === null ? 'broadcast-send' : 'broadcast-schedule', ids.length);
        return { id };
      },
      (id) => ({ id }),
    );
    return this.viewOf(done.id);
  }
  private viewOf(id: string) {
    return this.view(this.row(id));
  }

  /** Edit a scheduled broadcast (words, characters, voices, time) until it starts. Compare-and-swap on its revision. */
  update(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    const body = exact(input, [
      'requestId',
      'id',
      'expectedRevision',
      'bubbles',
      'characterIds',
      'voices',
      'sendAt',
      'acknowledge',
    ]);
    const done = this.once(
      'update',
      actor.memberId,
      body.requestId,
      body,
      () => {
        const now = this.now();
        const row = this.row(body.id);
        ensure(row.state === 'scheduled', 'BROADCAST_NOT_EDITABLE');
        ensure(row.revision === body.expectedRevision, 'BROADCAST_STALE');
        const texts = this.bubbles(body.bubbles);
        const ids = this.characters(body.characterIds);
        const sendAt = this.sendAt(body.sendAt, now);
        this.acknowledge(body.acknowledge, ids.length, body.sendAt === null);
        const keep = new Map<string, never>();
        for (const kept of this.store.all<{
          character_id: string;
          voice: 'generated' | 'uploaded';
          sha256: string;
          byte_length: number;
          duration_ms: number;
          audio: Uint8Array;
        }>("SELECT * FROM web_broadcast_characters WHERE broadcast_id=? AND voice!='none'", row.id))
          keep.set(kept.character_id, kept as never);
        // The old words decide whether a kept generated voice still reads them.
        this.writeCharacters(row.id, ids, texts, this.voicesOf(body.voices), keep);
        ensure(
          this.store.run(
            `UPDATE web_broadcasts SET bubbles_json=?,character_ids_json=?,send_at=?,revision=revision+1
            WHERE id=? AND state='scheduled' AND revision=?`,
            JSON.stringify(texts),
            JSON.stringify(ids),
            sendAt,
            row.id,
            row.revision,
          ).changes === 1,
          'BROADCAST_STALE',
        );
        this.audit(actor.memberId, 'broadcast-edit', ids.length);
        return { id: row.id };
      },
      (id) => ({ id }),
    );
    return this.viewOf(done.id);
  }

  /** Cancel a scheduled broadcast; one that has started cannot be taken back. */
  cancel(auth: Auth, input: unknown) {
    const actor = this.actor(auth);
    const body = exact(input, ['requestId', 'id']);
    const done = this.once(
      'cancel',
      actor.memberId,
      body.requestId,
      body,
      () => {
        const row = this.row(body.id);
        ensure(row.state === 'scheduled', 'BROADCAST_NOT_CANCELLABLE');
        ensure(
          this.store.run(
            "UPDATE web_broadcasts SET state='cancelled',cancelled_at=? WHERE id=? AND state='scheduled'",
            this.now(),
            row.id,
          ).changes === 1,
          'BROADCAST_NOT_CANCELLABLE',
        );
        // The clips of a broadcast that never went out are not kept.
        this.store.run(
          "UPDATE web_broadcast_characters SET voice='none',audio=NULL,sha256=NULL,byte_length=NULL,duration_ms=NULL WHERE broadcast_id=?",
          row.id,
        );
        this.audit(actor.memberId, 'broadcast-cancel', 1);
        return { id: row.id };
      },
      (id) => ({ id }),
    );
    return this.viewOf(done.id);
  }

  // ---- the executor ----------------------------------------------------------------------------------------------------------
  /** When the executor must next wake: now while something is sending, else the earliest scheduled time. */
  nextDue(now = this.now()): number | null {
    if (!webBroadcastInstalled(this.store)) return null;
    if (this.store.get("SELECT 1 FROM web_broadcasts WHERE state='sending' LIMIT 1")) return now;
    const next = this.store.get<{ at: number | null }>(
      "SELECT min(send_at) at FROM web_broadcasts WHERE state='scheduled'",
    )?.at;
    return next === null || next === undefined ? null : Math.max(now, next);
  }

  /** Start every broadcast whose time has come: freeze its recipients (so a later registration never receives it). */
  private startDue() {
    const now = this.now();
    for (const due of this.store.all<{ id: string }>(
      "SELECT id FROM web_broadcasts WHERE state='scheduled' AND send_at<=? ORDER BY send_at,id LIMIT 8",
      now,
    ))
      this.store.transaction(() => {
        const row = this.store.get<Row>("SELECT * FROM web_broadcasts WHERE id=? AND state='scheduled'", due.id);
        if (!row) return; // cancelled or started in the meantime
        const live = new Set(this.live().map((c) => c.characterId));
        const ids = (JSON.parse(row.character_ids_json) as string[]).filter((id) => live.has(id));
        const q = this.recipientSql(now);
        this.store.run(
          `INSERT INTO web_broadcast_recipients(broadcast_id,ordinal,principal_id)
          SELECT ?,row_number() OVER (ORDER BY id),id FROM (${q.sql})`,
          row.id,
          ...q.args,
        );
        const recipients = this.store.get<{ n: number }>(
          'SELECT count(*) n FROM web_broadcast_recipients WHERE broadcast_id=?',
          row.id,
        )!.n;
        const empty = recipients === 0 || ids.length === 0;
        this.store.run(
          `UPDATE web_broadcasts SET state=?,recipients=?,total=?,started_at=?,finished_at=? WHERE id=? AND state='scheduled'`,
          empty ? 'sent' : 'sending',
          recipients,
          recipients * ids.length,
          now,
          empty ? now : null,
          row.id,
        );
      });
  }

  /** One batch of one sending broadcast. Returns whether it did any work (the executor calls again while it did). */
  private deliverBatch() {
    const sending = this.store.get<{ id: string }>(
      "SELECT id FROM web_broadcasts WHERE state='sending' ORDER BY started_at,id LIMIT 1",
    );
    if (!sending) return false;
    return this.store.transaction(() => {
      const now = this.now();
      const row = this.store.get<Row>("SELECT * FROM web_broadcasts WHERE id=? AND state='sending'", sending.id);
      if (!row) return false;
      const live = new Set(this.live().map((c) => c.characterId));
      const chars = this.store
        .all<{
          character_id: string;
          voice: 'none' | 'generated' | 'uploaded';
          duration_ms: number | null;
        }>(
          'SELECT character_id,voice,duration_ms FROM web_broadcast_characters WHERE broadcast_id=? ORDER BY ordinal',
          row.id,
        )
        .filter((c) => live.has(c.character_id));
      const texts = JSON.parse(row.bubbles_json) as string[];
      const batch = this.store.all<{ ordinal: number; principal_id: string }>(
        `SELECT ordinal,principal_id FROM web_broadcast_recipients WHERE broadcast_id=? AND ordinal>? ORDER BY ordinal LIMIT ?`,
        row.id,
        row.cursor,
        this.batch,
      );
      let delivered = 0;
      for (const recipient of batch) {
        // A player who was deleted, purged or is no longer registered since the freeze is skipped.
        const principal = this.store.get<{ world_id: string }>(
          'SELECT world_id FROM web_principals WHERE id=?',
          recipient.principal_id,
        );
        if (!principal || !this.isRecipient(recipient.principal_id, now)) continue;
        for (const character of chars)
          if (this.deliver(row.id, character, texts, principal.world_id, recipient.principal_id, now)) delivered++;
      }
      const cursor = batch.at(-1)?.ordinal ?? row.cursor;
      const more = !!this.store.get(
        'SELECT 1 FROM web_broadcast_recipients WHERE broadcast_id=? AND ordinal>? LIMIT 1',
        row.id,
        cursor,
      );
      this.store.run(
        `UPDATE web_broadcasts SET cursor=?,delivered=delivered+?,state=?,finished_at=? WHERE id=? AND state='sending'`,
        cursor,
        delivered,
        more ? 'sending' : 'sent',
        more ? null : now,
        row.id,
      );
      return true;
    });
  }
  /** One player, one character: the conversation (created if it does not exist), then the message rows, once. */
  private deliver(
    broadcastId: string,
    character: { character_id: string; voice: 'none' | 'generated' | 'uploaded'; duration_ms: number | null },
    texts: string[],
    worldId: string,
    principalId: string,
    now: number,
  ) {
    if (
      this.store.get(
        'SELECT 1 FROM web_broadcast_messages WHERE broadcast_id=? AND character_id=? AND principal_id=? AND ordinal=0',
        broadcastId,
        character.character_id,
        principalId,
      )
    )
      return false;
    // The player's own world only: its conversation with this character, created as admission creates it.
    this.store.run(
      "INSERT OR IGNORE INTO world_characters(world_id,character_id,relationship) VALUES (?,?,'new')",
      worldId,
      character.character_id,
    );
    let conversation = this.store.get<{ id: string }>(
      "SELECT id FROM conversations WHERE world_id=? AND private_character_id=? AND kind='private'",
      worldId,
      character.character_id,
    );
    if (!conversation) {
      conversation = { id: this.nextId() };
      this.store.run(
        "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?)",
        worldId,
        conversation.id,
        character.character_id,
      );
      this.store.run('INSERT INTO participants VALUES (?,?,?)', worldId, conversation.id, character.character_id);
      this.store.run(
        'INSERT INTO contacts VALUES (?,?,?,?)',
        worldId,
        conversation.id,
        character.character_id,
        JSON.stringify(emptySession()),
      );
    }
    // With a voice the broadcast is ONE voice bubble (its words are the transcript); without, one text message per bubble.
    const rows =
      character.voice === 'none'
        ? texts.map((body) => ({ body, kind: 'text' as const }))
        : [{ body: texts.join('\n'), kind: 'voice' as const }];
    rows.forEach((item, ordinal) => {
      const messageId = this.nextId();
      this.store.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,media_id)
        VALUES (?,?,?,'character',?,?,?,?,?)`,
        messageId,
        worldId,
        conversation!.id,
        character.character_id,
        item.body,
        now,
        item.kind,
        // The media id is the broadcast clip itself: one stored per character per broadcast, referenced by every message.
        item.kind === 'voice' ? `bc-${broadcastId}-${character.character_id}` : null,
      );
      this.store.run(
        `INSERT INTO web_broadcast_messages(message_id,broadcast_id,character_id,principal_id,world_id,conversation_id,ordinal,kind)
        VALUES (?,?,?,?,?,?,?,?)`,
        messageId,
        broadcastId,
        character.character_id,
        principalId,
        worldId,
        conversation!.id,
        ordinal,
        item.kind,
      );
    });
    return true;
  }

  /** Takes nobody used are dropped after a day. */
  private sweepTakes() {
    const cutoff = this.now() - 86_400_000;
    this.store.run(`DELETE FROM web_broadcast_takes WHERE created_at<?`, cutoff);
  }

  /**
   * One executor pass: start what is due, then work up to a few batches (yielding between them so chat is served). Returns when
   * nothing is left to do now. Safe to call at any time and from a restarted object: the cursor and the per-message keys make a
   * resumed send write each message once.
   */
  async pass(yieldNow: () => Promise<void> = () => new Promise((resolve) => setTimeout(resolve, 0))) {
    if (!webBroadcastInstalled(this.store)) return false;
    this.startDue();
    let worked = false;
    for (let i = 0; i < BROADCAST_BATCHES_PER_PASS; i++) {
      if (!this.deliverBatch()) break;
      worked = true;
      await yieldNow();
    }
    if (!worked) this.sweepTakes();
    return worked;
  }
}
