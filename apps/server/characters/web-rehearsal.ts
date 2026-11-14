import { randomUUID } from 'node:crypto';
import type { Clock } from '../../../packages/contracts/index.ts';
import { PLAYER_MODEL_IDS, type PlayerModelId } from '../../../packages/contracts/player-models.ts';
import { writerDraftMessages, writerGuardMessages } from '../generation/writer-v8.ts';
import type { WriterDraft } from '../generation/writer-v8.ts';
import {
  REHEARSAL_COLUMN_KEYS,
  REHEARSAL_ITEMS_MAX,
  REHEARSAL_MODEL_LABELS,
  REHEARSAL_NAME_CHARS,
  REHEARSAL_PHRASE_CHARS,
  REHEARSAL_PHRASES_MAX,
  REHEARSAL_SET_LABELS,
  REHEARSAL_SCRIPTS_MAX,
  REHEARSAL_TURNS_MAX,
  REHEARSAL_TURNS_MIN,
  REHEARSAL_SETS,
  charLength,
  checkTurns,
  isRehearsalModels,
  parseRehearsalColumn,
  rehearsalColumnLabel,
  type RehearsalCell,
  type RehearsalEstimate,
  type RehearsalItems,
  type RehearsalLibrary,
  type RehearsalMemeCell,
  type RehearsalMemeRow,
  type RehearsalPhrases,
  type RehearsalRunDetail,
  type RehearsalRunInfo,
  type RehearsalScriptView,
  type RehearsalSource,
  type RehearsalTurn,
} from '../../../packages/contracts/web-rehearsal.ts';
import { REVIEW_MODEL_LABELS, type ReviewModelId } from '../../../packages/contracts/review-model.ts';
import type { CastView } from '../../../packages/contracts/web-cast.ts';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import { castForPreview } from '../cast/cast-store.ts';
import { currentReviewModel } from '../admission/web-review-model.ts';
import { promptMessages } from '../generation/accepted-text-prompt.ts';
import { listPriceMicros } from '../generation/model-list-prices.ts';
import { openingFrom } from '../generation/opening-line.ts';
import { modelUsableHere, draftModelRef } from '../generation/web-text-routing.ts';
import { contentHash } from './admin-content-hash.ts';
import { identifier, keys, record } from './template-validation.ts';
import { characterProfileHash, upgradedProfile, type StoredWebCharacterProfile } from './web-character-catalog.ts';
import { requirePreviewActor } from './web-character-preview.ts';
import { webCharacterDeleted } from './web-character-deleted.ts';
import { cleanPhrases, countReplies, DEFAULT_PHRASES, type AnalysedReply } from './web-rehearsal-analysis.ts';
import { rehearsalRequest, type RehearsalFrozen } from './web-rehearsal-request.ts';
import { installRehearsal } from './web-rehearsal-schema.ts';
import { builtinSet, builtinSets, itemSpec, memeItems, memeItemsAllowed, memeTurnPlan } from './web-rehearsal-sets.ts';

export interface RehearsalActor {
  memberId: string;
  sessionId: string;
}
const REQUEST_ID = /^[A-Za-z0-9_.-]{8,64}$/;
const natural = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
/** The clock every estimate is computed at, so a total is a function of the inputs alone. */
const ESTIMATE_AT = Date.parse('2026-11-04T04:00:00Z');
const REPLY_CHARS = 60;

export interface RehearsalPlan {
  turns: Array<{ text: string | null; role: 'hint' | 'negative' | null; item: string | null }>;
  scriptName: string;
  sourceKind: 'script' | 'set' | 'memes';
  models: string[];
  withCast: boolean;
  frozen: RehearsalFrozen;
  items: Array<{ key: string; kind: 'meme' | 'story'; label: string; spec: Record<string, unknown> }>;
  castView: CastView | null;
  profileHash: string;
  draftRevision: number;
  estimate: RehearsalEstimate;
}

interface UnitRow {
  run_id: string;
  seq: number;
  kind: 'hint' | 'cell' | 'judge';
  model_key: string | null;
  turn: number | null;
  item_key: string | null;
  status: 'queued' | 'generating' | 'done' | 'failed' | 'unconfirmed' | 'skipped';
  error_code: string | null;
  result_json: string | null;
}

export class WebRehearsal {
  private readonly store: BusinessStore;
  private readonly clock: Clock;
  private readonly id: () => string;
  constructor(store: BusinessStore, clock: Clock, nextId: () => string = randomUUID) {
    this.store = store;
    this.clock = clock;
    this.id = nextId;
    installRehearsal(store);
  }
  private now() {
    const now = this.clock.now();
    ensure(natural(now), 'INVALID_TIME');
    return now;
  }

  // ---- phrase lists, scripts ---------------------------------------------------------------------------------------

  phrases(): RehearsalPhrases {
    const read = (kind: 'customerService' | 'advice') => {
      const row = this.store.get<{ phrases_json: string }>(
        'SELECT phrases_json FROM web_rehearsal_phrases WHERE kind=?',
        kind,
      );
      return row ? (JSON.parse(row.phrases_json) as string[]) : [...DEFAULT_PHRASES[kind]];
    };
    return { customerService: read('customerService'), advice: read('advice') };
  }
  private models(): RehearsalLibrary['models'] {
    const now = this.now();
    return PLAYER_MODEL_IDS.map((id) => ({
      id,
      label: REHEARSAL_MODEL_LABELS[id],
      available: modelUsableHere(this.store, id, now),
    }));
  }
  private scriptView(row: { id: string; name: string; turns_json: string; updated_at: number }): RehearsalScriptView {
    return { id: row.id, name: row.name, turns: JSON.parse(row.turns_json) as string[], updatedAt: row.updated_at };
  }
  library(): RehearsalLibrary {
    return {
      scripts: this.store
        .all<{ id: string; name: string; turns_json: string; updated_at: number }>(
          'SELECT id,name,turns_json,updated_at FROM web_rehearsal_scripts ORDER BY updated_at DESC,id',
        )
        .map((row) => this.scriptView(row)),
      sets: builtinSets(),
      phrases: this.phrases(),
      defaultPhrases: { customerService: [...DEFAULT_PHRASES.customerService], advice: [...DEFAULT_PHRASES.advice] },
      models: this.models(),
    };
  }
  /** A write that is idempotent per request id: the same id and body answers what it answered; another body is a conflict. */
  private once<T>(requestId: unknown, kind: string, body: unknown, work: (now: number) => T): T {
    ensure(typeof requestId === 'string' && REQUEST_ID.test(requestId), 'INVALID_REQUEST');
    const hash = contentHash([kind, body]);
    return this.store.transaction(() => {
      const prior = this.store.get<{ request_hash: string; result_json: string; kind: string }>(
        'SELECT request_hash,result_json,kind FROM web_rehearsal_requests WHERE request_id=?',
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash && prior.kind === kind, 'IDEMPOTENCY_CONFLICT');
        return JSON.parse(prior.result_json) as T;
      }
      const now = this.now();
      const result = work(now);
      this.store.run(
        'INSERT INTO web_rehearsal_requests(request_id,kind,request_hash,result_json,created_at) VALUES (?,?,?,?,?)',
        requestId,
        kind,
        hash,
        JSON.stringify(result),
        now,
      );
      return result;
    });
  }
  saveScript(actor: RehearsalActor, input: unknown): RehearsalScriptView {
    record(input);
    keys(input, ['requestId', 'id', 'name', 'turns']);
    const { requestId, id, name, turns } = input;
    ensure(
      typeof name === 'string' && name.trim().length > 0 && charLength(name.trim()) <= REHEARSAL_NAME_CHARS,
      'INVALID_REHEARSAL_SCRIPT',
    );
    ensure(checkTurns(turns), 'INVALID_REHEARSAL_SCRIPT');
    ensure(id === null || id === undefined || typeof id === 'string', 'INVALID_REHEARSAL_SCRIPT');
    if (typeof id === 'string') identifier(id);
    const clean = name.trim();
    return this.once(requestId, 'script-save', [id ?? null, clean, turns.map((t) => t.trim())], (now) => {
      const taken = this.store.get<{ id: string }>('SELECT id FROM web_rehearsal_scripts WHERE name=?', clean);
      let scriptId = typeof id === 'string' ? id : null;
      if (scriptId) {
        ensure(this.store.get('SELECT 1 FROM web_rehearsal_scripts WHERE id=?', scriptId), 'NOT_FOUND');
        ensure(!taken || taken.id === scriptId, 'REHEARSAL_NAME_TAKEN');
        this.store.run(
          'UPDATE web_rehearsal_scripts SET name=?,turns_json=?,updated_at=? WHERE id=?',
          clean,
          JSON.stringify(turns.map((t) => t.trim())),
          now,
          scriptId,
        );
      } else {
        ensure(!taken, 'REHEARSAL_NAME_TAKEN');
        ensure(
          this.store.get<{ n: number }>('SELECT count(*) n FROM web_rehearsal_scripts')!.n < REHEARSAL_SCRIPTS_MAX,
          'REHEARSAL_SCRIPTS_FULL',
        );
        scriptId = this.id();
        identifier(scriptId);
        this.store.run(
          'INSERT INTO web_rehearsal_scripts(id,name,turns_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)',
          scriptId,
          clean,
          JSON.stringify(turns.map((t) => t.trim())),
          actor.memberId,
          now,
          now,
        );
      }
      this.audit(actor, 'rehearsal-script-saved', scriptId, now);
      return this.scriptView(
        this.store.get<{ id: string; name: string; turns_json: string; updated_at: number }>(
          'SELECT id,name,turns_json,updated_at FROM web_rehearsal_scripts WHERE id=?',
          scriptId,
        )!,
      );
    });
  }
  deleteScript(actor: RehearsalActor, input: unknown) {
    record(input);
    keys(input, ['requestId', 'id']);
    identifier(input.id);
    const id = input.id;
    return this.once(input.requestId, 'script-delete', id, (now) => {
      this.store.run('DELETE FROM web_rehearsal_scripts WHERE id=?', id);
      this.audit(actor, 'rehearsal-script-deleted', id, now);
      return { id };
    });
  }
  savePhrases(actor: RehearsalActor, input: unknown): RehearsalPhrases {
    record(input);
    keys(input, ['requestId', 'customerService', 'advice']);
    const customerService = cleanPhrases(input.customerService, REHEARSAL_PHRASES_MAX, REHEARSAL_PHRASE_CHARS);
    const advice = cleanPhrases(input.advice, REHEARSAL_PHRASES_MAX, REHEARSAL_PHRASE_CHARS);
    ensure(customerService && advice, 'INVALID_REHEARSAL_PHRASES');
    return this.once(input.requestId, 'phrases-save', [customerService, advice], (now) => {
      for (const [kind, list] of [
        ['customerService', customerService],
        ['advice', advice],
      ] as const)
        this.store.run(
          `INSERT INTO web_rehearsal_phrases(kind,phrases_json,updated_by,updated_at) VALUES (?,?,?,?)
          ON CONFLICT(kind) DO UPDATE SET phrases_json=excluded.phrases_json,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
          kind,
          JSON.stringify(list),
          actor.memberId,
          now,
        );
      this.audit(actor, 'rehearsal-phrases-saved', 'phrases', now);
      return { customerService, advice };
    });
  }
  private audit(actor: RehearsalActor, action: string, target: string, now: number) {
    this.store.run(
      'INSERT INTO web_admin_audit(actor_id,action,target_id,created_at) VALUES (?,?,?,?)',
      actor.memberId,
      action,
      target,
      now,
    );
  }

  // ---- the plan of a run -------------------------------------------------------------------------------------------

  private draft(characterId: string, revision: number, profileHash: string) {
    const draft = this.store.get<{ profile_json: string; content_hash: string }>(
      `SELECT r.* FROM web_character_revisions r JOIN web_character_drafts d ON d.character_id=r.character_id AND d.revision=r.revision
      WHERE r.character_id=? AND r.revision=?`,
      characterId,
      revision,
    );
    ensure(draft?.content_hash === profileHash, 'DRAFT_CONFLICT');
    const stored = JSON.parse(draft.profile_json) as StoredWebCharacterProfile;
    ensure(characterProfileHash(stored) === profileHash, 'DRAFT_CONFLICT');
    return upgradedProfile(stored);
  }
  /** The cast view of the CURRENT cast file (the draft), whatever CAST_CONTEXT_ENABLED says for live chat. */
  private castOf(characterId: string) {
    return castForPreview(this.store, characterId, 'draft');
  }
  items(characterId: string): RehearsalItems {
    try {
      const cast = this.castOf(characterId);
      return { available: true, items: cast ? memeItems(cast.view) : [] };
    } catch {
      return { available: false, items: [] };
    }
  }
  private parseSource(value: unknown): RehearsalSource {
    record(value);
    ensure(typeof value.kind === 'string', 'INVALID_REHEARSAL_SOURCE');
    if (value.kind === 'script') {
      keys(value, ['kind', 'scriptId']);
      identifier(value.scriptId);
      return { kind: 'script', scriptId: value.scriptId };
    }
    if (value.kind === 'set') {
      keys(value, ['kind', 'set']);
      ensure((REHEARSAL_SETS as readonly unknown[]).includes(value.set), 'INVALID_REHEARSAL_SOURCE');
      return { kind: 'set', set: value.set as 'chat' | 'repeat' };
    }
    keys(value, ['kind', 'items']);
    ensure(
      value.kind === 'memes' &&
        Array.isArray(value.items) &&
        value.items.every((item) => typeof item === 'string' && item.length > 0 && item.length <= 100) &&
        new Set(value.items).size === value.items.length,
      'INVALID_REHEARSAL_SOURCE',
    );
    return { kind: 'memes', items: value.items as string[] };
  }

  /** What a run with these inputs would be, or why not. The estimate is a function of the plan alone. */
  plan(characterId: string, input: Record<string, unknown>): RehearsalPlan {
    identifier(characterId);
    ensure(
      Number.isSafeInteger(input.draftRevision) &&
        Number(input.draftRevision) > 0 &&
        typeof input.profileHash === 'string' &&
        /^[a-f0-9]{64}$/.test(input.profileHash),
      'INVALID_DRAFT_REVISION',
    );
    ensure(isRehearsalModels(input.models), 'INVALID_REHEARSAL_MODELS');
    ensure(typeof input.withCast === 'boolean', 'INVALID_REQUEST');
    const source = this.parseSource(input.source);
    // Column keys, in display order (each model's 现行 then 新). A rehearsal never reads the live 回复写法 switch.
    const models = REHEARSAL_COLUMN_KEYS.filter((key) => (input.models as string[]).includes(key));
    const now = this.now();
    for (const key of models)
      ensure(modelUsableHere(this.store, parseRehearsalColumn(key)!.model, now), 'REHEARSAL_MODEL_UNAVAILABLE');
    ensure(!webCharacterDeleted(this.store, characterId), 'CHARACTER_DELETED');
    const profile = this.draft(characterId, input.draftRevision as number, input.profileHash as string);
    const withCast = input.withCast as boolean;
    ensure(source.kind !== 'memes' || withCast, 'REHEARSAL_MEMES_NEED_CAST');
    const cast = withCast ? this.castOf(characterId) : undefined;
    let turns: RehearsalPlan['turns'];
    let scriptName: string;
    let items: RehearsalPlan['items'] = [];
    if (source.kind === 'script') {
      const row = this.store.get<{ name: string; turns_json: string }>(
        'SELECT name,turns_json FROM web_rehearsal_scripts WHERE id=?',
        source.scriptId,
      );
      ensure(row, 'NOT_FOUND');
      scriptName = row.name;
      turns = (JSON.parse(row.turns_json) as string[]).map((text) => ({ text, role: null, item: null }));
    } else if (source.kind === 'set') {
      scriptName = REHEARSAL_SET_LABELS[source.set];
      turns = builtinSet(source.set).map((text) => ({ text, role: null, item: null }));
    } else {
      ensure(cast, 'CAST_CHARACTER_NOT_IN_CAST');
      ensure(memeItemsAllowed(source.items.length), 'INVALID_REHEARSAL_SOURCE');
      ensure(source.items.length <= REHEARSAL_ITEMS_MAX, 'INVALID_REHEARSAL_SOURCE');
      const known = memeItems(cast.view);
      for (const key of source.items) {
        const found = known.find((item) => item.key === key);
        const spec = itemSpec(cast.view, key);
        ensure(found && spec, 'INVALID_REHEARSAL_SOURCE');
        items.push({ key, kind: found.kind, label: found.label, spec });
      }
      scriptName = '梗与故事';
      turns = memeTurnPlan(source.items).map((slot) => ({ text: null, role: slot.role, item: slot.item }));
      // Turns of one item keep their order: hint 1, look-alike, hint 2 (the plan is the slot order; texts come with the hints).
    }
    ensure(turns.length >= REHEARSAL_TURNS_MIN && turns.length <= REHEARSAL_TURNS_MAX, 'INVALID_REHEARSAL_SCRIPT');
    const frozen: RehearsalFrozen = {
      template: profile.template,
      ...(openingFrom(profile.presentation.welcomes[0]?.text)
        ? { opening: openingFrom(profile.presentation.welcomes[0]?.text)! }
        : {}),
      ...(cast ? { cast } : {}),
      baseAt: now,
    };
    return {
      turns,
      scriptName,
      sourceKind: source.kind,
      models,
      withCast,
      frozen,
      items,
      castView: cast?.view ?? null,
      profileHash: input.profileHash as string,
      draftRevision: input.draftRevision as number,
      estimate: this.estimateOf(frozen, turns, models, items.length),
    };
  }

  /**
   * About what the run costs, in micro-USD at LIST price: tokens estimated from the size of the prompt the first turn would send
   * (the character, the cast view, the history growing by what the lines and replies add) and typical output. A guide, not a promise;
   * what every call HOLDS is decided at its own reservation, from the real request.
   */
  private estimateOf(
    frozen: RehearsalFrozen,
    turns: RehearsalPlan['turns'],
    models: string[],
    itemCount: number,
  ): RehearsalEstimate {
    const reviewer = currentReviewModel(this.store);
    const fixed = { ...frozen, baseAt: ESTIMATE_AT };
    const players = turns.map((t) => t.text ?? '你知道那件事吧');
    const first = rehearsalRequest(fixed, 'estimate', 'estimate', 1, players, []);
    const baseBytes = Buffer.byteLength(JSON.stringify(promptMessages(first)), 'utf8');
    // Part 37a: a 新 column sends the v8 prompt (much shorter) and its second pass is the guard (a bigger prompt, a short answer).
    const v8First = rehearsalRequest(fixed, 'estimate', 'deepseek-v8', 1, players, []);
    const v8Draft = Buffer.byteLength(JSON.stringify(writerDraftMessages(v8First)), 'utf8');
    const v8Guard = Buffer.byteLength(
      JSON.stringify(writerGuardMessages(v8First, { mode: 'casual', bubbles: [], endsSession: false, markups: [] } as WriterDraft)),
      'utf8',
    );
    let total = 0;
    for (const key of models) {
      const column = parseRehearsalColumn(key)!;
      const ref = draftModelRef(column.model);
      // xAI and Gemini think before they answer: billed as output.
      const thinking = column.model === 'deepseek' ? 0 : 1200;
      for (let t = 1; t <= turns.length; t++) {
        const growth = (t - 1) * (REPLY_CHARS * 3 + 2 * 260);
        if (column.writer === 'v8') {
          total += listPriceMicros(ref.provider, ref.model, {
            inputTokens: Math.ceil((v8Draft + growth) / 2),
            outputTokens: 120 + thinking,
          });
          total += listPriceMicros('deepseek', reviewer, {
            inputTokens: Math.ceil((v8Guard + growth) / 2) + 150,
            outputTokens: 260,
          });
        } else {
          const inTokens = Math.ceil((baseBytes + growth) / 2);
          total += listPriceMicros(ref.provider, ref.model, { inputTokens: inTokens, outputTokens: 250 + thinking });
          total += listPriceMicros('deepseek', reviewer, { inputTokens: inTokens + 300, outputTokens: 600 });
        }
      }
    }
    // Judge calls, on the house reviewer: one hint writer per item, one verdict per model and item.
    const hint = listPriceMicros('deepseek', reviewer, { inputTokens: 700, outputTokens: 200 });
    const verdict = listPriceMicros('deepseek', reviewer, { inputTokens: 1200 + REPLY_CHARS * 6, outputTokens: 120 });
    const judgeCalls = itemCount * (1 + models.length);
    total += itemCount * hint + itemCount * models.length * verdict;
    const replyCalls = models.length * turns.length * 2;
    return { models, turns: turns.length, replyCalls, judgeCalls, calls: replyCalls + judgeCalls, totalMicros: total };
  }
  estimate(characterId: string, input: unknown): RehearsalEstimate {
    record(input);
    keys(input, ['draftRevision', 'profileHash', 'source', 'models', 'withCast']);
    return this.plan(characterId, input).estimate;
  }

  // ---- start, read ---------------------------------------------------------------------------------------------------

  start(actor: RehearsalActor, characterId: string, input: unknown) {
    record(input);
    keys(input, ['requestId', 'draftRevision', 'profileHash', 'source', 'models', 'withCast', 'acknowledgeMicros']);
    ensure(typeof input.requestId === 'string' && REQUEST_ID.test(input.requestId), 'INVALID_REQUEST');
    ensure(natural(input.acknowledgeMicros), 'INVALID_REQUEST');
    const requestId = input.requestId;
    const hash = contentHash([actor.memberId, characterId, 'rehearsal', input]);
    return this.store.transaction(() => {
      const now = this.now();
      requirePreviewActor(this.store, now, actor, characterId);
      const prior = this.store.get<{ id: string; request_hash: string }>(
        'SELECT id,request_hash FROM web_rehearsal_runs WHERE request_id=?',
        requestId,
      );
      if (prior) {
        ensure(prior.request_hash === hash, 'IDEMPOTENCY_CONFLICT');
        return { runId: prior.id, replayed: true };
      }
      const plan = this.plan(characterId, input);
      ensure(plan.estimate.totalMicros === input.acknowledgeMicros, 'REHEARSAL_ESTIMATE_CHANGED');
      ensure(
        !this.store.get("SELECT 1 FROM web_rehearsal_units WHERE status IN ('queued','generating') LIMIT 1"),
        'REHEARSAL_RUN_ACTIVE',
      );
      const runId = this.id();
      identifier(runId);
      const reviewer = currentReviewModel(this.store);
      const frozenJson = JSON.stringify(plan.frozen);
      this.store.run(
        `INSERT INTO web_rehearsal_runs(id,request_id,request_hash,character_id,draft_revision,profile_hash,script_name,source_kind,
        models_json,with_cast,frozen_json,frozen_digest,reviewer,estimated_micros,member_id,session_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        runId,
        requestId,
        hash,
        characterId,
        plan.draftRevision,
        plan.profileHash,
        plan.scriptName,
        plan.sourceKind,
        JSON.stringify(plan.models),
        plan.withCast ? 1 : 0,
        frozenJson,
        contentHash(plan.frozen),
        reviewer,
        plan.estimate.totalMicros,
        actor.memberId,
        actor.sessionId,
        now,
      );
      plan.turns.forEach((turn, index) =>
        this.store.run(
          'INSERT INTO web_rehearsal_turns(run_id,turn,text,role,item_key) VALUES (?,?,?,?,?)',
          runId,
          index + 1,
          turn.text,
          turn.role,
          turn.item,
        ),
      );
      for (const item of plan.items)
        this.store.run(
          'INSERT INTO web_rehearsal_items(run_id,item_key,kind,label,spec_json,state) VALUES (?,?,?,?,?,?)',
          runId,
          item.key,
          item.kind,
          item.label,
          JSON.stringify(item.spec),
          'pending',
        );
      let seq = 0;
      const unit = (
        kind: 'hint' | 'cell' | 'judge',
        model: string | null,
        turn: number | null,
        item: string | null,
      ) => {
        seq++;
        this.store.run(
          `INSERT INTO web_rehearsal_units(run_id,seq,kind,model_key,turn,item_key,status,deadline_at,retry_at)
          VALUES (?,?,?,?,?,?,'queued',?,?)`,
          runId,
          seq,
          kind,
          model,
          turn,
          item,
          now + 1_800_000 + seq * 90_000,
          now,
        );
      };
      for (const item of plan.items) unit('hint', null, null, item.key);
      for (let t = 1; t <= plan.turns.length; t++) for (const model of plan.models) unit('cell', model, t, null);
      for (const model of plan.models) for (const item of plan.items) unit('judge', model, null, item.key);
      this.audit(actor, 'rehearsal-queued', runId, now);
      return { runId, replayed: false };
    });
  }

  list(characterId: string): RehearsalRunInfo[] {
    identifier(characterId);
    return this.store
      .all<{ id: string }>(
        'SELECT id FROM web_rehearsal_runs WHERE character_id=? ORDER BY created_at DESC,id DESC LIMIT 20',
        characterId,
      )
      .map((row) => this.info(row.id)!);
  }
  private info(runId: string): RehearsalRunInfo | null {
    const run = this.store.get<{
      id: string;
      created_at: number;
      script_name: string;
      models_json: string;
      with_cast: number;
      estimated_micros: number;
    }>('SELECT * FROM web_rehearsal_runs WHERE id=?', runId);
    if (!run) return null;
    const turns = this.store.get<{ n: number }>('SELECT count(*) n FROM web_rehearsal_turns WHERE run_id=?', runId)!.n;
    const open = this.store.get(
      "SELECT 1 FROM web_rehearsal_units WHERE run_id=? AND status IN ('queued','generating')",
      runId,
    );
    const done = this.store.get("SELECT 1 FROM web_rehearsal_units WHERE run_id=? AND status='done'", runId);
    const charged = this.store.get<{ n: number | null }>(
      "SELECT sum(charged_micros) n FROM web_rehearsal_calls WHERE run_id=? AND state='known'",
      runId,
    )!.n;
    return {
      runId,
      createdAt: run.created_at,
      scriptName: run.script_name,
      models: JSON.parse(run.models_json) as string[],
      turns,
      withCast: run.with_cast === 1,
      status: open ? 'running' : done ? 'done' : 'failed',
      estimatedMicros: run.estimated_micros,
      chargedMicros: charged ?? 0,
    };
  }

  /** The whole run, computed from what is stored. `characterId` must be the run's: another character's run is not found. */
  detail(characterId: string, runId: unknown): RehearsalRunDetail {
    identifier(characterId);
    identifier(runId);
    const run = this.store.get<{ character_id: string; reviewer: string }>(
      'SELECT character_id,reviewer FROM web_rehearsal_runs WHERE id=?',
      runId,
    );
    ensure(run && run.character_id === characterId, 'NOT_FOUND');
    const info = this.info(runId)!;
    const turnRows = this.store.all<{
      turn: number;
      text: string | null;
      role: 'hint' | 'negative' | null;
      item_key: string | null;
    }>('SELECT turn,text,role,item_key FROM web_rehearsal_turns WHERE run_id=? ORDER BY turn', runId);
    const units = this.store.all<UnitRow>('SELECT * FROM web_rehearsal_units WHERE run_id=? ORDER BY seq', runId);
    const items = this.store.all<{ item_key: string; kind: 'meme' | 'story'; label: string; state: string }>(
      'SELECT item_key,kind,label,state FROM web_rehearsal_items WHERE run_id=? ORDER BY rowid',
      runId,
    );
    const lists = this.phrases();
    const turns: RehearsalTurn[] = turnRows.map((row) => ({
      text: row.text ?? '',
      role: row.role,
      item: row.item_key ? (items.find((i) => i.item_key === row.item_key)?.label ?? null) : null,
    }));
    const cellState = (status: UnitRow['status']): RehearsalCell['state'] =>
      status === 'queued' ? 'pending' : status === 'generating' ? 'running' : status;
    const columns = info.models.map((key) => {
      const column = parseRehearsalColumn(key)!;
      const cells: RehearsalCell[] = turnRows.map((turn) => {
        const unit = units.find((u) => u.kind === 'cell' && u.model_key === key && u.turn === turn.turn);
        const result = unit?.result_json
          ? (JSON.parse(unit.result_json) as { bubbles: string[]; answered: boolean | null })
          : null;
        return {
          state: unit ? cellState(unit.status) : 'pending',
          errorCode: unit?.error_code ?? null,
          bubbles: unit?.status === 'done' && result ? result.bubbles : null,
          answered: unit?.status === 'done' && result ? result.answered : null,
        };
      });
      const analysed: AnalysedReply[] = [];
      cells.forEach((cell, index) => {
        if (cell.state === 'done' && cell.bubbles) {
          analysed.push({
            player: turnRows[index]!.text ?? '',
            bubbles: cell.bubbles,
            answered: column.writer === 'v8' ? null : cell.answered === true,
          });
        }
      });
      return {
        key,
        model: column.model,
        writer: column.writer,
        label: rehearsalColumnLabel(key),
        cells,
        counts: countReplies(analysed, lists, {
          unconfirmed: cells.filter((c) => c.state === 'unconfirmed').length,
          failed: cells.filter((c) => c.state === 'failed').length,
        }),
      };
    });
    let memes: RehearsalMemeRow[] | null = null;
    if (items.length > 0)
      memes = items.map((item) => {
        const models: Record<string, RehearsalMemeCell> = {};
        for (const model of info.models) {
          const unit = units.find((u) => u.kind === 'judge' && u.model_key === model && u.item_key === item.item_key);
          const empty: RehearsalMemeCell = { hints: [null, null], falseTrigger: null, ownSide: null, state: 'pending' };
          if (!unit) {
            models[model] = empty;
            continue;
          }
          if (unit.status === 'done' && unit.result_json) {
            const verdict = JSON.parse(unit.result_json) as {
              hints: [boolean, boolean];
              negative: boolean;
              ownSide: boolean | null;
            };
            models[model] = {
              hints: verdict.hints,
              falseTrigger: verdict.negative,
              ownSide: verdict.ownSide,
              state: 'judged',
            };
          } else
            models[model] = {
              ...empty,
              state:
                unit.status === 'unconfirmed'
                  ? 'unconfirmed'
                  : unit.status === 'failed'
                    ? 'failed'
                    : unit.status === 'skipped'
                      ? 'skipped'
                      : 'pending',
            };
        }
        return { label: item.label, kind: item.kind, played: item.state !== 'dropped', models };
      });
    return {
      run: info,
      reviewer: REVIEW_MODEL_LABELS[run.reviewer as ReviewModelId] ?? run.reviewer,
      turns,
      columns,
      memes,
    };
  }
}
