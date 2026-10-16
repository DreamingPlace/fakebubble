import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderChatReview,
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderLogins,
  migrateWebProviderMemory,
  migrateWebProviderMemoryMetrics,
  migrateWebProviderMetrics,
  migrateWebProviderModelChoice,
  migrateWebProviderOffline,
  migrateWebProviderPreviewWorkbench,
  migrateWebProviderSignupBonus,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { WebProviderOffline } from '../../../apps/server/generation/web-provider-offline.ts';
import { renewProviderPrices } from '../../../apps/server/generation/web-provider-configuration.ts';
import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebProviderRunner, type FakeFish } from '../../../apps/server/generation/web-provider-runner.ts';
import { WebStageQueue } from '../../../apps/server/admission/web-stage-queue.ts';
import { WebDispatchLedger } from '../../../apps/server/budget/web-dispatch-ledger.ts';
import { budgetAttempt, type WebAttemptBudget } from '../../../apps/server/budget/web-provider-budget-contract.ts';
import { protocolFingerprint } from '../../../apps/server/generation/accepted-text-protocol.ts';
import { textPromptHash } from '../../../apps/server/generation/accepted-text-prompt.ts';
import { freezeInputSnapshot } from '../../../apps/server/generation/web-input-snapshot.ts';
import { sceneState } from '../../../apps/server/conversation/scenes.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import type { PlayerModelId } from '../../../packages/contracts/player-models.ts';
import type { BusinessStore } from '../../../apps/server/platform/store-contract.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { acceptedAuditEnvelope, draftEnvelope, textRequest, toolEnvelope } from '../../text-fixtures.ts';

export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export const NOW = 1_700_000_000_000;

/** The real schema through migration 123 on an in-memory Node database. */
export function schema123() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  migrateWebProviderMemory(store);
  migrateWebProviderEmbeddings(store);
  migrateWebProviderCocreation(store);
  migrateWebProviderLogins(store);
  migrateWebProviderPreviewWorkbench(store);
  migrateWebProviderMemoryMetrics(store);
  migrateWebProviderSignupBonus(store);
  migrateWebProviderChatReview(store);
  migrateWebProviderModelChoice(store);
  return store;
}

/** Switch the Part 21b feature on for a Node test store (the production stores take these from Worker vars). */
export function enableModelChoice(store: Store, models: readonly PlayerModelId[] = ['deepseek', 'gemini', 'xai']) {
  Object.assign(store, { publicFreeTier: true, playerModelChoice: models });
}

/**
 * Mirrors the shared budget authority with the REAL attempt id (so the generation suffix of a retried stage is exercised):
 * one reservation per id, settled once, never released.
 */
export class GenerationBudget implements WebAttemptBudget {
  readonly calls: string[] = [];
  readonly entries = new Map<string, { settled: boolean; charged: number | null; provider: string }>();
  beginAttempt(store: BusinessStore, key: { operationId: string; phase: string; ordinal: number }, resume = false) {
    const { id, row } = budgetAttempt(store, key);
    if (resume) {
      assert.equal(this.entries.get(id)?.settled, false);
      this.calls.push(`resume:${key.phase}`);
      return;
    }
    assert.equal(this.entries.has(id), false, 'a reservation is never made twice');
    this.entries.set(id, { settled: false, charged: null, provider: row.provider });
    this.calls.push(`begin:${key.phase}:${row.provider}`);
  }
  settleAttempt(store: BusinessStore, key: { operationId: string; phase: string; ordinal: number }) {
    const { id, row } = budgetAttempt(store, key);
    assert.equal(this.entries.get(id)?.settled, false, 'settled once');
    this.entries.set(id, { settled: true, charged: row.charged_micros, provider: row.provider });
    this.calls.push(`settle:${key.phase}:${row.provider}`);
  }
  recoverKnown() {}
}

/** Recorded-shape provider responses (see docs/PROVIDERS.md: derived from the providers' documentation, not live captures). */
export const wire = {
  /** xAI chat completions: reasoning tokens are reported BESIDE completion_tokens and are part of total_tokens. */
  xai(tool: string, args: unknown, usage = { prompt: 1000, completion: 300, reasoning: 700, cached: 400 }) {
    const base = toolEnvelope(tool, args);
    return {
      ...base,
      model: 'grok-4.7',
      choices: [{ ...base.choices[0]!, finish_reason: 'tool_calls' }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion + usage.reasoning,
        prompt_tokens_details: { cached_tokens: usage.cached },
        completion_tokens_details: { reasoning_tokens: usage.reasoning },
      },
    };
  },
  /** Gemini OpenAI-compatible endpoint: completion_tokens already include thinking tokens; the forced call reports "stop". */
  gemini(tool: string, args: unknown, usage = { prompt: 1200, completion: 900 }) {
    const base = toolEnvelope(tool, args);
    return {
      ...base,
      model: 'gemini-3.8-flash',
      choices: [{ ...base.choices[0]!, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: usage.prompt,
        completion_tokens: usage.completion,
        total_tokens: usage.prompt + usage.completion,
      },
    };
  },
  error: {
    xaiRateLimit: () => new Response('{"code":"Too Many Requests","error":"rate limit reached"}', { status: 429 }),
    geminiRateLimit: () =>
      new Response('{"error":{"code":429,"message":"Resource has been exhausted","status":"RESOURCE_EXHAUSTED"}}', {
        status: 429,
      }),
    geminiOverloaded: () =>
      new Response('{"error":{"code":503,"message":"The model is overloaded.","status":"UNAVAILABLE"}}', {
        status: 503,
      }),
    geminiRegion: () =>
      new Response(
        '{"error":{"code":400,"message":"User location is not supported for the API use.","status":"FAILED_PRECONDITION"}}',
        { status: 400 },
      ),
    xaiServerError: () => new Response('{"error":"internal"}', { status: 500 }),
  },
};

export type FetchCall = {
  url: string;
  provider: 'deepseek' | 'xai' | 'gemini';
  tool: string;
  body: Record<string, unknown>;
};
const providerOf = (url: string) => (url.includes('x.ai') ? 'xai' : url.includes('googleapis') ? 'gemini' : 'deepseek');

/**
 * A complete text stage on a schema-123 store: one queued operation of a guest, real runner + generator with an injected
 * fetch, a shared-budget mirror, prices/budgets seeded the way production does it (initial DeepSeek rows, then renew-prices).
 */
export function modelFixture(
  t: TestContext,
  options: {
    chosen?: PlayerModelId | null;
    offered?: readonly PlayerModelId[];
    flag?: boolean;
    keys?: { xai?: string; gemini?: string };
    seedNewProviders?: boolean;
    /** Earlier character messages of 8000 characters each (to build a request above the xAI size cap). */
    padMessages?: number;
    fetch: (call: FetchCall, n: number, request: ReturnType<typeof textRequest>) => Response | Promise<Response>;
  },
) {
  const store = schema123();
  t.after(() => store.close());
  if (options.flag !== false) enableModelChoice(store, options.offered);
  store.run('INSERT INTO web_instance(singleton,instance_id) VALUES (1,?)', 'fixture-instance');
  store.run(
    'INSERT INTO character_templates VALUES (?,?,?)',
    'character',
    1,
    JSON.stringify({ ...textRequest().character, id: 'character' }),
  );
  store.run('INSERT INTO api_players VALUES (?,?)', 'player', NOW);
  store.run('INSERT INTO worlds VALUES (?,?,?,?)', 'world', 'player', 'UTC', '{}');
  store.run("INSERT INTO world_characters VALUES ('world','character','new')");
  store.run(
    "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES ('world','conversation','private','character')",
  );
  store.run("INSERT INTO participants VALUES ('world','conversation','character')");
  store.run("INSERT INTO contacts VALUES ('world','conversation','character','{}')");
  store.run(
    "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES ('input','world','conversation','player','player','合成',?,'text',0)",
    NOW,
  );
  store.run("INSERT INTO web_principals(id,player_id,world_id,kind) VALUES ('principal','player','world','guest')");
  store.run(
    `INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state) VALUES ('principal','world',?,?,'active')`,
    NOW - 1,
    NOW + 999_999,
  );
  store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', 'principal', NOW);
  store.run(
    `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
    character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
    VALUES ('operation','principal','request','payload','world','conversation','character','input',
      NULL,'queued','reserved',?,?,'entitled')`,
    NOW,
    NOW + 100_000,
  );
  freezeInputSnapshot(store as WebStore, 'operation', NOW);
  const request = textRequest();
  request.jobId = 'operation';
  request.scope = { worldId: 'world', conversationId: 'conversation', characterId: 'character' };
  request.character.id = 'character';
  request.requiredMessageIds = ['input'];
  request.messages = [
    {
      ...request.messages[0]!,
      id: 'input',
      worldId: 'world',
      conversationId: 'conversation',
      authorId: 'player',
      text: '合成',
    },
  ];
  request.messages.unshift(
    ...Array.from({ length: options.padMessages ?? 0 }, (_, index) => ({
      ...request.messages[0]!,
      id: `pad-${index}`,
      authorKind: 'character' as const,
      authorId: 'character',
      text: '长'.repeat(8000),
    })),
  );
  request.deliveryMode = 'voice';
  request.sceneContext = sceneState(
    userStore(store),
    { playerId: 'player', worldId: 'world', conversationId: 'conversation', characterId: 'character' },
    NOW,
  );
  const requestJson = JSON.stringify(request);
  store.run(
    `INSERT INTO web_v7_requests VALUES ('operation','principal','player','world','conversation',
    'character','input',?,?,?,?,0,'0:0',0,0,?,?)`,
    requestJson,
    hash(requestJson),
    hash(JSON.stringify(protocolFingerprint())),
    textPromptHash(),
    'fixture-voice:v1',
    NOW,
  );
  if (options.chosen !== null)
    store.run(
      `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,created_at)
      VALUES ('operation',?,1,0,1,?)`,
      options.chosen ?? 'deepseek',
      NOW,
    );
  let clockNow = NOW;
  const clock = { now: () => clockNow };
  const calls: FetchCall[] = [];
  const generator = new DeepSeekTextGenerator({
    apiKey: 'offline-only',
    ...(options.keys ? { keys: options.keys } : { keys: { xai: 'offline-xai', gemini: 'offline-gemini' } }),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const call: FetchCall = {
        url: String(url),
        provider: providerOf(String(url)),
        tool: (body.tools as { function: { name: string } }[])[0]!.function.name,
        body,
      };
      calls.push(call);
      assert.equal(init?.redirect, 'manual', 'every provider fetch uses redirect:manual (workerd rejects "error")');
      return options.fetch(call, calls.length, request);
    },
  });
  const budget = new GenerationBudget();
  const fish: FakeFish = async (request) => ({
    audio: syntheticTone(),
    receipt: { id: 'fake-fish' },
    usageUnits: request.billedTextBytes,
  });
  const runner = new WebProviderRunner(store, clock, generator, fish, budget);
  const ledger = new WebProviderOffline(store, clock);
  const capacity = new WebDispatchLedger(store as WebStore, clock);
  // The state of a deployment initialized BEFORE this Part: DeepSeek and Fish only. renew-prices then seeds the new models.
  for (const provider of ['deepseek', 'fish']) ledger.configureBudget(provider, 3_000_000);
  for (const phase of ['draft', 'review'] as const) {
    ledger.configurePrice({
      id: `deepseek-${phase}`,
      provider: 'deepseek',
      model: phase === 'draft' ? generator.model : generator.reviewModel,
      phase,
      currency: 'USD',
      unit: 'token',
      upperMicrosPerUnit: 2,
      validFrom: NOW - 1,
      validUntil: NOW + 1_000_000,
      version: 1,
    });
    capacity.configureBudget({ provider: 'deepseek', stage: 'text', phase, capacity: 2 });
  }
  ledger.configurePrice({
    id: 'fish-speech',
    provider: 'fish',
    model: 's2.1-pro',
    phase: 'speech',
    currency: 'USD',
    unit: 'byte',
    upperMicrosPerUnit: 1,
    validFrom: NOW - 1,
    validUntil: NOW + 1_000_000,
    version: 1,
  });
  capacity.configureBudget({ provider: 'fish', stage: 'audio', phase: 'speech', capacity: 2 });
  ledger.configureVoice({
    characterId: 'character',
    voiceVersion: 'fixture-voice:v1',
    voiceRevision: 1,
    profileId: 'synthetic-profile',
    referenceId: 'synthetic-reference',
    model: 's2.1-pro',
    approved: true,
  });
  if (options.seedNewProviders !== false) renewProviderPrices(store as never, NOW);
  store.run(
    "UPDATE web_operations SET deadline_at=?,text_queued_at=?,admission_seq=1 WHERE id='operation'",
    NOW + 300_000,
    NOW,
  );
  let ids = 0;
  const queue = new WebStageQueue(store as WebStore, clock, () => `stage-id-${++ids}`);
  const lease = queue.acquireCoordinator('coordinator');
  const signal = () => new AbortController().signal;
  /** A later message of the same conversation, queued like production leaves it; its request is frozen by the claim itself. */
  const addOperation = (id: string, text: string, chosen: PlayerModelId) => {
    const inputId = `input-${id}`;
    store.run(
      "INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,'world','conversation','player','player',?,?,'text',0)",
      inputId,
      text,
      NOW + 1,
    );
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,
      character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
      VALUES (?,'principal',?,'payload','world','conversation','character',?,NULL,'queued','reserved',?,?,'entitled')`,
      id,
      `request-${id}`,
      inputId,
      NOW + 1,
      NOW + 400_000,
    );
    store.run('UPDATE web_operations SET text_queued_at=?,admission_seq=2 WHERE id=?', NOW + 1, id);
    freezeInputSnapshot(store as WebStore, id, NOW + 1);
    store.run(
      `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,created_at) VALUES (?,?,1,0,1,?)`,
      id,
      chosen,
      NOW + 1,
    );
  };
  const get = <T>(sql: string, ...params: (string | number)[]) => store.get<T>(sql, ...params);
  const all = <T>(sql: string, ...params: (string | number)[]) => store.all<T>(sql, ...params);
  /** Draft + review exactly as production runs them; the claim is the real queue claim. */
  const runText = async () => runner.runText(queue.claimText(lease, 'text-worker')!, signal());
  /** The reviewed reply as a player gets it: every voice segment, then the publication. */
  const finishReply = async (operationId: string) => {
    for (let claim = queue.claimAudio(lease, 'audio-worker'); claim; claim = queue.claimAudio(lease, 'audio-worker'))
      await runner.runSpeech(claim, signal());
    return runner.publishAsync(lease, operationId);
  };
  return {
    store,
    clock,
    calls,
    generator,
    budget,
    runner,
    ledger,
    queue,
    lease,
    request,
    addOperation,
    runText,
    finishReply,
    get,
    all,
    signal,
    advance: (ms: number) => {
      clockNow += ms;
    },
    attempts: () =>
      all<{
        phase: string;
        provider: string;
        model: string;
        state: string;
        outcome: string | null;
        held_micros: number;
        charged_micros: number | null;
      }>(
        'SELECT phase,provider,model,state,outcome,held_micros,charged_micros FROM web_provider_attempts ORDER BY phase',
      ),
    spending: (provider: string) =>
      get<{ held_micros: number; spent_micros: number }>(
        'SELECT held_micros,spent_micros FROM web_provider_spending WHERE provider=?',
        provider,
      )!,
    backups: () =>
      all<{ phase: string; generation: number; provider: string; model: string; code: string; held_micros: number }>(
        'SELECT phase,generation,provider,model,code,held_micros FROM web_provider_backups ORDER BY phase,generation',
      ),
    status: () => get<{ status: string }>("SELECT status FROM web_operations WHERE id='operation'")!.status,
    models: () =>
      get<Record<string, string | number | null>>("SELECT * FROM web_operation_models WHERE operation_id='operation'"),
  };
}

/** A reviewed answer of the house reviewer for the frozen request of the fixture. */
export function reviewArgs(request: ReturnType<typeof textRequest>) {
  const envelope = acceptedAuditEnvelope(request);
  return JSON.parse(envelope.choices[0]!.message.tool_calls[0]!.function.arguments) as Record<string, unknown>;
}
export function draftArgs(request: ReturnType<typeof textRequest>) {
  const envelope = draftEnvelope(request);
  return JSON.parse(envelope.choices[0]!.message.tool_calls[0]!.function.arguments) as Record<string, unknown>;
}
