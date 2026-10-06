import type { ProviderMeter } from '../../packages/contracts/provider-calls.ts';
import { createHash, randomUUID } from 'node:crypto';
import { playerSuspended } from './beta-accounts.ts';
import { playerProviderMeter } from './provider-meter.ts';
import { playerGenerationError } from './player-generation-error.ts';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CharacterScope,
  DialogueCandidate,
  Expression,
  PlayerContext,
  TextGenerationResult,
} from '../../packages/contracts/index.ts';
import type { SpeechGenerator } from '../../packages/contracts/audio.ts';
import type { VoiceMessageState, VoiceProfile, VoiceRetryReceipt } from '../../packages/contracts/media.ts';
import { ensure } from '../../packages/domain/errors.ts';
import { dialogueCandidate, dialogueWire } from '../../packages/domain/dialogue.ts';
import { audioGeneration, SpeechFailure } from '../../workers/audio/validation-error.ts';
import type { Engine } from './engine.ts';
import { VoiceCatalog } from './voices.ts';
import type { AudioStorage } from './audio-storage.ts';
import { runningAudioCount, safeAudioError, speechMetadata, validateSpeech } from './audio-validation.ts';
import { validateDialogueMemoryEvidence } from './memory.ts';
import { betaAudioQueue } from './audio-queue.ts';

const scopeValues = (scope: CharacterScope) => [scope.worldId, scope.conversationId, scope.characterId] as const;
const scoped = 'world_id=? AND conversation_id=? AND character_id=?';
interface SpeechTask extends CharacterScope {
  media_id: string;
  job_id: string;
  ordinal: number;
  attempt: number;
  profile_json: string;
  text: string;
  expression: Expression;
  delivery_style: import('../../packages/contracts/scenes.ts').SpeechDeliveryStyle;
  speed: number;
  retry: number;
  state: VoiceMessageState['state'];
  lease_until: number | null;
  generation_json: string | null;
  error_code: string | null;
  duration_ms: number | null;
  byte_length: number | null;
  sha256: string | null;
}
export interface PreparedVoice {
  mediaIds: (string | null)[];
}

/** Business service owns task state and publication. SpeechGenerator has no database access. */
export class MediaServiceCore {
  readonly engine: Engine;
  readonly voices: VoiceCatalog;
  readonly generator: SpeechGenerator | null;
  #files: AudioStorage;
  #active = new Map<string, Promise<void>>();
  #controller = new AbortController();
  #timer: ReturnType<typeof setInterval> | undefined;
  #notify: (worldId: string) => void;
  #meter: ((scope: CharacterScope, taskId: string, parentJobId: string) => ProviderMeter | undefined) | undefined;
  constructor(
    engine: Engine,
    storage: AudioStorage,
    generator: SpeechGenerator | null = null,
    notify: (worldId: string) => void = () => {},
    options: { meter?: (scope: CharacterScope, taskId: string, parentJobId: string) => ProviderMeter | undefined } = {},
  ) {
    this.engine = engine;
    this.generator = generator;
    this.voices = new VoiceCatalog(engine.store, engine.clock);
    this.#notify = notify;
    this.#files = storage;
    this.#meter = options.meter;
    ensure(
      !engine.store.requiresAccessControl ||
        generator?.providerCalls !== 'external' ||
        (storage.kind === 'external' && options.meter),
      'GUARD_BINDING_REQUIRED',
    );
  }
  get store() {
    return this.engine.store;
  }
  cleanupResetMedia() {
    if (this.#files.kind === 'external') return; // Cloud deletion follows its separately approved tombstone/retention workflow.
    for (const row of this.store.all<{ media_id: string }>(
      'SELECT media_id FROM playtest_media_cleanup ORDER BY media_id LIMIT 256',
    )) {
      try {
        ensure(!this.store.get('SELECT 1 FROM media WHERE id=?', row.media_id), 'MEDIA_STILL_REFERENCED');
        this.#files.remove(row.media_id);
        this.store.run('DELETE FROM playtest_media_cleanup WHERE media_id=?', row.media_id);
      } catch (error) {
        this.store.run(
          'UPDATE playtest_media_cleanup SET error_code=? WHERE media_id=?',
          safeAudioError(error),
          row.media_id,
        );
      }
    }
  }
  desiredDelivery(scope: CharacterScope): 'text' | 'voice' {
    const contact = this.engine.inspect(scope);
    if (
      this.store.get(
        'SELECT 1 FROM moment_threads WHERE world_id=? AND conversation_id=?',
        scope.worldId,
        scope.conversationId,
      )
    )
      return 'text';
    const row = this.store.get<{ config_json: string }>(
      'SELECT config_json FROM character_templates WHERE id=?',
      scope.characterId,
    )!;
    const binding = (JSON.parse(row.config_json) as { voice?: { messageProbability?: number } }).voice;
    if (!binding) return 'text';
    const probability = binding.messageProbability ?? 1;
    const intent = this.store.get<{ id: string }>(
      "SELECT id FROM proactive_intents WHERE world_id=? AND conversation_id=? AND character_id=? AND status='pending' ORDER BY created_at,id LIMIT 1",
      ...scopeValues(scope),
    );
    const source = contact.pendingMessageIds[0] ?? intent?.id ?? 'idle';
    // This choice uses an existing operation identity, never the availability dice or polling time.
    const roll =
      createHash('sha256')
        .update(JSON.stringify([...scopeValues(scope), source, 'delivery']))
        .digest()
        .readUInt32BE(0) /
      2 ** 32;
    return roll < probability ? 'voice' : 'text';
  }
  async prepare(
    scope: CharacterScope,
    jobId: string,
    raw: DialogueCandidate,
    generation: Omit<TextGenerationResult, 'reply'>,
    version: number,
    signal: AbortSignal,
    options: { resume?: boolean; isCurrent?: () => boolean } = {},
  ): Promise<PreparedVoice> {
    const checkOwner = () => ensure(options.isCurrent?.() !== false, 'AUDIO_PREPARATION_SUPERSEDED');
    checkOwner();
    ensure(!options.resume || this.store.beta, 'BETA_DISABLED');
    ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
    const request = this.engine.deliveryRequest(scope, jobId);
    ensure(request.character.version === version && request.character.voice, 'VOICE_BINDING_CHANGED');
    const candidate = dialogueCandidate(
      dialogueWire(raw),
      request.requiredMessageIds,
      request.mustClose,
      request.deliveryMode,
    );
    const deliveryStyle = this.engine.sceneDelivery(scope, jobId, candidate, version);
    validateDialogueMemoryEvidence(this.store, scope, jobId, candidate);
    const profile = this.voices.resolve(request.character.voice);
    const tasks = this.store.transaction(() => {
      checkOwner();
      this.engine.work(scope, jobId);
      // Text usage is already known before synthesis and must survive a later process crash.
      this.store.run(
        `UPDATE text_attempts SET generation_json=? WHERE job_id=? AND ${scoped} AND status='running'`,
        JSON.stringify(generation),
        jobId,
        ...scopeValues(scope),
      );
      return candidate.bubbles.map((bubble, ordinal) => {
        const existing = options.resume
          ? this.store.get<{ media_id: string }>(
              `SELECT media_id FROM speech_tasks WHERE ${scoped} AND job_id=? AND ordinal=? AND attempt=1`,
              ...scopeValues(scope),
              jobId,
              ordinal,
            )
          : undefined;
        if (!existing)
          return this.enqueue(
            scope,
            jobId,
            ordinal,
            profile,
            bubble.text,
            bubble.expression,
            request.character.voice!.speed,
            false,
            deliveryStyle,
          );
        const task = this.task(scope, existing.media_id);
        ensure(
          task.profile_json === JSON.stringify(profile) &&
            task.text === bubble.text &&
            task.expression === bubble.expression &&
            task.speed === request.character.voice!.speed &&
            task.delivery_style === deliveryStyle &&
            task.retry === 0,
          'AUDIO_TEXT_MISMATCH',
        );
        // Resume the same IDs and states. Unknown/failed speech is never put back into the paid queue.
        return task;
      });
    });
    const remaining = this.engine.work(scope, jobId).leaseUntil - this.engine.clock.now() - 5000;
    const deadline = AbortSignal.timeout(Math.max(1, Math.min(180_000, remaining)));
    const combined = AbortSignal.any([signal, deadline, this.#controller.signal]);
    for (const task of tasks) {
      while (!combined.aborted) {
        checkOwner();
        ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
        this.engine.sceneDelivery(scope, jobId, candidate, version);
        this.recover();
        const current = this.task(scope, task.media_id);
        if (current.state === 'ready' || current.state === 'failed') break;
        const running = this.run(current, combined);
        if (running) await running;
        else await delay(50, undefined, { signal: combined }).catch(() => {});
      }
      if (combined.aborted) break;
    }
    ensure(!signal.aborted && !this.#controller.signal.aborted, 'AUDIO_REQUEST_ABORTED');
    this.store.transaction(() => {
      checkOwner();
      this.engine.work(scope, jobId);
      for (const task of tasks) {
        const current = this.task(scope, task.media_id);
        if (current.state === 'queued' || current.state === 'generating') this.fail(current, 'AUDIO_REQUEST_TIMEOUT');
      }
    });
    return {
      mediaIds: tasks.map((task) => (this.task(scope, task.media_id).state === 'ready' ? task.media_id : null)),
    };
  }
  state(context: PlayerContext, conversationId: string, messageId: string): VoiceMessageState {
    const { scope, task } = this.messageTask(context, conversationId, messageId);
    return this.stateDTO(scope, messageId, task);
  }
  retry(context: PlayerContext, conversationId: string, messageId: string, input: unknown): VoiceRetryReceipt {
    ensure(
      input &&
        typeof input === 'object' &&
        Object.keys(input).join(',') === 'requestId' &&
        'requestId' in input &&
        typeof input.requestId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(input.requestId),
      'INVALID_REQUEST',
    );
    return this.store.transaction(() => {
      const { scope, task } = this.messageTask(context, conversationId, messageId);
      ensure(task.error_code !== 'MEDIA_EXPIRED', 'MEDIA_EXPIRED');
      const prior = this.store.get<{ conversation_id: string; message_id: string; media_id: string }>(
        'SELECT * FROM speech_retry_receipts WHERE world_id=? AND request_id=?',
        context.worldId,
        input.requestId as string,
      );
      if (prior) {
        ensure(prior.conversation_id === conversationId && prior.message_id === messageId, 'IDEMPOTENCY_CONFLICT');
        return { voice: this.stateDTO(scope, messageId, this.task(scope, prior.media_id)), duplicate: true };
      }
      let selected = task;
      if (task.state === 'failed') {
        ensure(
          this.store.get<{ n: number }>(
            `SELECT count(*) n FROM speech_tasks WHERE world_id=? AND state IN ('queued','generating')`,
            scope.worldId,
          )!.n < 32,
          'AUDIO_QUEUE_FULL',
        );
        const profile = JSON.parse(task.profile_json) as VoiceProfile;
        this.voices.resolve({ profileId: profile.id, version: profile.version, speed: task.speed });
        selected = this.enqueue(
          scope,
          task.job_id,
          task.ordinal,
          profile,
          task.text,
          task.expression,
          task.speed,
          true,
          task.delivery_style,
        );
      }
      this.store.run(
        'INSERT INTO speech_retry_receipts VALUES (?,?,?,?,?)',
        context.worldId,
        conversationId,
        messageId,
        input.requestId as string,
        selected.media_id,
      );
      return { voice: this.stateDTO(scope, messageId, selected), duplicate: false };
    });
  }
  private readInfo(context: PlayerContext, conversationId: string, messageId: string, mediaId: string) {
    const { scope, task: current } = this.messageTask(context, conversationId, messageId);
    const task = this.task(scope, mediaId);
    ensure(
      task.job_id === current.job_id && task.ordinal === current.ordinal && task.state === 'ready',
      'MEDIA_NOT_READY',
    );
    const media = this.store.get<{ relative_path: string | null }>(
      `SELECT relative_path FROM media WHERE id=? AND world_id=? AND conversation_id=? AND job_id=? AND status='ready'`,
      mediaId,
      context.worldId,
      conversationId,
      task.job_id,
    );
    ensure(media?.relative_path === this.locator(mediaId), 'MEDIA_INTEGRITY_ERROR');
    return { scope, task };
  }
  private locator(id: string) {
    return this.#files.kind === 'external' ? 'r2:' + id : id + '.wav';
  }
  read(
    context: PlayerContext,
    conversationId: string,
    messageId: string,
    mediaId: string,
  ): { state: VoiceMessageState; bytes: Buffer } {
    ensure(this.#files.kind === 'local', 'ASYNC_MEDIA_READ_REQUIRED');
    const { scope, task } = this.readInfo(context, conversationId, messageId, mediaId);
    return {
      state: this.stateDTO(scope, messageId, task),
      bytes: this.#files.read(mediaId, { byteLength: task.byte_length, sha256: task.sha256 }),
    };
  }
  async readAsync(
    context: PlayerContext,
    conversationId: string,
    messageId: string,
    mediaId: string,
    authorize: () => Promise<void>,
  ) {
    await authorize();
    const { scope, task } = this.readInfo(context, conversationId, messageId, mediaId);
    const check = () => {
      ensure(!playerSuspended(this.store, scope.playerId), 'ACCOUNT_SUSPENDED');
      this.readInfo(context, conversationId, messageId, mediaId);
    };
    const expected = { byteLength: task.byte_length, sha256: task.sha256 };
    const bytes =
      this.#files.kind === 'local'
        ? this.#files.read(mediaId, expected)
        : await this.#files.read(scope, mediaId, expected, check);
    await authorize();
    check();
    return { state: this.stateDTO(scope, messageId, task), bytes };
  }
  start(onError: (code: string) => void = () => {}) {
    ensure(!this.#timer && !this.#controller.signal.aborted, 'WORKER_ALREADY_STARTED');
    this.#timer = setInterval(() => {
      void this.pump().catch((error) => onError(safeAudioError(error)));
    }, 1000);
  }
  async stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#controller.abort();
    await Promise.allSettled(this.#active.values());
  }
  async pump() {
    if (this.#controller.signal.aborted) return;
    this.cleanupResetMedia();
    this.recover();
    const selected = this.store.beta ? betaAudioQueue(this.store) : null;
    if (selected?.length === 0) return;
    const tasks = this.store.all<SpeechTask>(
      `SELECT t.*,t.world_id AS worldId,t.conversation_id AS conversationId,t.character_id AS characterId,w.owner_id AS playerId
      FROM speech_tasks t JOIN worlds w ON w.id=t.world_id WHERE t.state='queued' AND t.retry=1
      ${selected ? 'AND t.media_id IN (' + selected.map(() => '?').join(',') + ')' : ''}
      ORDER BY t.created_at,t.media_id LIMIT 32`,
      ...(selected ?? []),
    );
    if (selected) tasks.sort((a, b) => selected.indexOf(a.media_id) - selected.indexOf(b.media_id));
    const work: Promise<void>[] = [];
    for (const task of tasks) {
      const promise = this.run(task, this.#controller.signal);
      if (promise) work.push(promise);
      if (this.#active.size >= 2) break;
    }
    await Promise.all(work);
  }
  private enqueue(
    scope: CharacterScope,
    jobId: string,
    ordinal: number,
    profile: VoiceProfile,
    text: string,
    expression: SpeechTask['expression'],
    speed: number,
    retry: boolean,
    deliveryStyle: SpeechTask['delivery_style'],
  ): SpeechTask {
    const previous = this.store.get<{ n: number }>(
      `SELECT COALESCE(max(attempt),0) n FROM speech_tasks WHERE ${scoped} AND job_id=? AND ordinal=?`,
      ...scopeValues(scope),
      jobId,
      ordinal,
    )!.n;
    ensure(retry || previous === 0, 'SPEECH_ALREADY_PREPARED');
    const id = randomUUID();
    this.store.run("INSERT INTO media VALUES (?,?,?,?,'pending',NULL)", id, scope.worldId, scope.conversationId, jobId);
    this.store.run(
      `INSERT INTO speech_tasks(media_id,world_id,conversation_id,character_id,job_id,ordinal,attempt,profile_json,text,expression,speed,retry,state,created_at,delivery_style)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'queued',?,?)`,
      id,
      ...scopeValues(scope),
      jobId,
      ordinal,
      previous + 1,
      JSON.stringify(profile),
      text,
      expression,
      speed,
      retry ? 1 : 0,
      this.engine.clock.now(),
      deliveryStyle,
    );
    return this.task(scope, id);
  }
  private task(scope: CharacterScope, id: string): SpeechTask {
    const row = this.store.get<SpeechTask>(
      `SELECT *,world_id AS worldId,conversation_id AS conversationId,character_id AS characterId FROM speech_tasks WHERE ${scoped} AND media_id=?`,
      ...scopeValues(scope),
      id,
    );
    ensure(row, 'NOT_FOUND');
    return { ...row, playerId: scope.playerId };
  }
  private parentValid(task: SpeechTask): boolean {
    const job = this.store.get<{ status: string; lease_until: number }>(
      `SELECT status,lease_until FROM jobs WHERE ${scoped} AND id=?`,
      ...scopeValues(task),
      task.job_id,
    );
    if (!job) return false;
    if (!task.retry) return job.status === 'leased' && job.lease_until > this.engine.clock.now();
    // A published bubble survives a cancelled or unfinished tail; retry only that existing message.
    return !!this.store.get(
      `SELECT 1 FROM dialogue_bubbles b JOIN messages m
      ON m.world_id=b.world_id AND m.conversation_id=b.conversation_id AND m.id=b.message_id
      WHERE b.world_id=? AND b.conversation_id=? AND b.job_id=? AND b.ordinal=?
        AND m.author_kind='character' AND m.author_id=? AND m.body=? AND (m.delivery='voice' OR m.voice_fallback=1)`,
      task.worldId,
      task.conversationId,
      task.job_id,
      task.ordinal,
      task.characterId,
      task.text,
    );
  }
  private run(task: SpeechTask, signal: AbortSignal): Promise<void> | null {
    if (playerSuspended(this.store, task.playerId)) return null;
    if (signal.aborted || this.#active.has(task.media_id)) return null;
    const claimed = this.store.transaction(() => {
      const current = this.task(task, task.media_id);
      if (current.state !== 'queued') return false;
      if (!this.parentValid(current)) {
        this.fail(current, 'AUDIO_PARENT_EXPIRED');
        return false;
      }
      if (runningAudioCount(this.store) >= 2) return false;
      if (this.store.beta && !betaAudioQueue(this.store).includes(task.media_id)) return false;
      const now = this.engine.clock.now();
      this.store.run(
        `UPDATE speech_tasks SET state='generating',started_at=?,lease_until=?
        ${this.store.beta ? ',dispatch_seq=(SELECT coalesce(max(dispatch_seq),0)+1 FROM speech_tasks)' : ''}
        WHERE media_id=? AND ${scoped} AND state='queued'`,
        now,
        now + 125_000,
        task.media_id,
        ...scopeValues(task),
      );
      return true;
    });
    if (!claimed) return null;
    const promise = this.synthesize(task, signal).finally(() => {
      this.#active.delete(task.media_id);
      this.notify(task.worldId);
    });
    this.#active.set(task.media_id, promise);
    return promise;
  }
  private async synthesize(task: SpeechTask, signal: AbortSignal) {
    let generation: object | null = null;
    try {
      const check = () => {
        ensure(!signal.aborted, 'AUDIO_REQUEST_ABORTED');
        ensure(!playerSuspended(this.store, task.playerId), 'ACCOUNT_SUSPENDED');
        const current = this.task(task, task.media_id);
        ensure(current.state === 'generating' && this.parentValid(task), 'AUDIO_PARENT_EXPIRED');
        if (this.#files.kind === 'external')
          ensure(current.lease_until! > this.engine.clock.now(), 'AUDIO_WORKER_INTERRUPTED');
      };
      if (this.#files.kind === 'external') {
        await this.#files.authorize(task);
        check();
      }
      ensure(this.generator, 'VOICE_GENERATION_DISABLED');
      const profile = JSON.parse(task.profile_json) as VoiceProfile;
      this.voices.resolve({ profileId: profile.id, version: profile.version, speed: task.speed });
      const request = {
        jobId: task.media_id,
        text: task.text,
        expression: task.expression,
        speed: task.speed,
        model: profile.model,
        deliveryStyle: task.delivery_style,
        ...(profile.qualityGuard === undefined ? {} : { qualityGuard: profile.qualityGuard }),
        voice: { profileId: profile.id, version: profile.version, referenceId: profile.referenceId },
      };
      const result = await this.generator.generate(
        request,
        signal,
        this.#meter
          ? this.#meter(task, task.media_id, task.job_id)
          : playerProviderMeter(this.store, this.engine.clock, this.generator, task, task.media_id, task.job_id),
      );
      generation = speechMetadata(result);
      ensure(!signal.aborted, 'AUDIO_REQUEST_ABORTED');
      const info = validateSpeech(result, request);
      if (this.#files.kind === 'external') {
        check();
        await this.#files.stage(task, task.media_id, result.audio, check);
      }
      this.store.transaction(() => {
        check();
        if (this.#files.kind === 'local') this.#files.write(task.media_id, result.audio);
        this.store.run(
          `UPDATE media SET status='ready',relative_path=? WHERE id=? AND world_id=? AND conversation_id=? AND job_id=?`,
          this.locator(task.media_id),
          task.media_id,
          task.worldId,
          task.conversationId,
          task.job_id,
        );
        this.store.run(
          `UPDATE speech_tasks SET state='ready',finished_at=?,generation_json=?,duration_ms=?,byte_length=?,sha256=? WHERE media_id=? AND ${scoped}`,
          this.engine.clock.now(),
          JSON.stringify(generation),
          info.durationMs,
          info.byteLength,
          info.sha256,
          task.media_id,
          ...scopeValues(task),
        );
      });
    } catch (error) {
      if (error instanceof SpeechFailure) generation = audioGeneration(error.generation);
      this.store.transaction(() => {
        this.fail(task, safeAudioError(error), generation);
      });
    }
  }
  private fail(task: SpeechTask, code: string, generation: object | null = null) {
    this.store.run(
      `UPDATE speech_tasks SET state='failed',finished_at=?,error_code=?,generation_json=COALESCE(?,generation_json)
      WHERE media_id=? AND ${scoped} AND state IN ('queued','generating')`,
      this.engine.clock.now(),
      code,
      generation ? JSON.stringify(generation) : null,
      task.media_id,
      ...scopeValues(task),
    );
    // A late response can supply known usage after lease recovery, but cannot revive or republish the clip.
    if (generation)
      this.store.run(
        `UPDATE speech_tasks SET generation_json=COALESCE(generation_json,?) WHERE media_id=? AND ${scoped} AND state='failed'`,
        JSON.stringify(generation),
        task.media_id,
        ...scopeValues(task),
      );
    this.store.run(
      `UPDATE media SET status='failed' WHERE id=? AND world_id=? AND conversation_id=? AND job_id=? AND status='pending'`,
      task.media_id,
      task.worldId,
      task.conversationId,
      task.job_id,
    );
  }
  private recover() {
    const rows =
      this.store.all<SpeechTask>(`SELECT t.*,t.world_id AS worldId,t.conversation_id AS conversationId,t.character_id AS characterId,w.owner_id AS playerId
      FROM speech_tasks t JOIN worlds w ON w.id=t.world_id WHERE t.state IN ('queued','generating')`);
    this.store.transaction(() => {
      for (const task of rows) {
        if (!this.parentValid(task)) this.fail(task, 'AUDIO_PARENT_EXPIRED');
        else if (task.state === 'generating' && task.lease_until! <= this.engine.clock.now())
          this.fail(task, 'AUDIO_WORKER_INTERRUPTED');
      }
    });
  }
  private messageTask(
    context: PlayerContext,
    conversationId: string,
    messageId: string,
  ): { scope: CharacterScope; task: SpeechTask } {
    const message = this.engine.readMessage(context, conversationId, messageId);
    ensure(
      message.authorKind === 'character' && (message.delivery === 'voice' || message.voiceFallback),
      'NOT_VOICE_MESSAGE',
    );
    const scope = { ...context, conversationId, characterId: message.authorId };
    const row = this.store.get<{ media_id: string }>(
      `SELECT t.media_id FROM dialogue_bubbles b JOIN speech_tasks t
      ON t.job_id=b.job_id AND t.ordinal=b.ordinal AND t.world_id=b.world_id AND t.conversation_id=b.conversation_id
      WHERE b.world_id=? AND b.conversation_id=? AND b.message_id=? AND t.character_id=? ORDER BY t.attempt DESC LIMIT 1`,
      context.worldId,
      conversationId,
      messageId,
      message.authorId,
    );
    ensure(row, 'VOICE_ATTACHMENT_NOT_FOUND');
    return { scope, task: this.task(scope, row.media_id) };
  }
  private stateDTO(scope: CharacterScope, messageId: string, task: SpeechTask): VoiceMessageState {
    const profile = JSON.parse(task.profile_json) as VoiceProfile;
    return {
      worldId: scope.worldId,
      conversationId: scope.conversationId,
      messageId,
      mediaId: task.media_id,
      state: task.state,
      voice: { profileId: profile.id, version: profile.version },
      durationMs: task.duration_ms,
      byteLength: task.byte_length,
      sha256: task.sha256,
      mime: 'audio/wav',
      errorCode: this.store.beta ? playerGenerationError(task.error_code) : task.error_code,
    };
  }
  private notify(worldId: string) {
    try {
      this.#notify(worldId);
    } catch {
      /* File/task commit cannot be undone by a hint. */
    }
  }
}
