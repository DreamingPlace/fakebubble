import { createHash } from 'node:crypto';
import type { CharacterScope, Clock } from '../../packages/contracts/index.ts';
import type { CostCallInput, CostFunction, CostScope } from '../../packages/contracts/admin-costs.ts';
import type { ProviderDeclaration, SynchronousProviderMeter, ProviderStage, ProviderUsage } from '../../packages/contracts/provider-calls.ts';
import { DomainError, ensure } from '../../packages/domain/errors.ts';
import { BetaCosts } from './beta-costs.ts';
import type { BusinessStore as Store } from './store-contract.ts';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const missingUsage = (unit: 'tokens' | 'utf8_bytes'): ProviderUsage => unit === 'tokens' ?
  { unit, inputTokens: null, cacheHitInputTokens: null, cacheMissInputTokens: null, outputTokens: null } : { unit, bytes: null };
export const providerCallId = (scope: CostScope, taskId: string, stage: ProviderStage) => 'call-' + digest([scope, taskId, stage]);
export function playerProviderMeter(store: Store, clock: Clock, generator: ProviderDeclaration, scope: CharacterScope,
  taskId: string, parentJobId = taskId): SynchronousProviderMeter | undefined {
  if (!store.beta) return undefined;
  return providerMeter(store, clock, generator, { scope: { kind: 'player', playerId: scope.playerId, worldId: scope.worldId,
    conversationId: scope.conversationId, characterId: scope.characterId }, taskId, function: playerCostFunction(store, scope, parentJobId) });
}
export function playerCostFunction(store: Store, scope: CharacterScope, jobId: string): CostFunction {
  const row = store.get<{ kind: string; surface: string; post: number }>(`SELECT j.kind,c.kind surface,
    EXISTS(SELECT 1 FROM moment_post_days d WHERE d.world_id=j.world_id AND d.conversation_id=j.conversation_id AND d.character_id=j.character_id) post
    FROM jobs j JOIN conversations c ON c.world_id=j.world_id AND c.id=j.conversation_id
    WHERE j.id=? AND j.world_id=? AND j.conversation_id=? AND j.character_id=?`, jobId, scope.worldId, scope.conversationId, scope.characterId);
  ensure(row, 'COST_TASK_NOT_ACTIVE'); return row.post ? 'moment_post' : row.surface === 'moment' ? 'moment_reply' : row.kind === 'proactive' ? 'proactive_chat' : 'chat';
}
export function assertProviderTaskActive(store: Store, clock: Clock, attribution: { scope: CostScope; taskId: string; function: CostFunction }, stage: ProviderStage) {
  const { scope: s, taskId, function: feature } = attribution, now = clock.now();
  if (s.kind === 'player') {
    const table = stage === 'speech' ? 'speech_tasks' : 'jobs', id = stage === 'speech' ? 'media_id' : 'id', status = stage === 'speech' ? "state='generating'" : "status='leased'";
    ensure(store.get(`SELECT 1 FROM ${table} WHERE ${id}=? AND world_id=? AND conversation_id=? AND character_id=? AND ${status} AND lease_until>?`,
      taskId, s.worldId, s.conversationId, s.characterId, now), 'COST_TASK_NOT_ACTIVE');
  } else if (feature === 'character_preview') ensure(store.get("SELECT 1 FROM admin_previews WHERE id=? AND character_id=? AND status='generating' AND lease_until>?", taskId, s.characterId, now), 'COST_TASK_NOT_ACTIVE');
  else if (feature === 'voice_preview') ensure(store.get("SELECT 1 FROM admin_voice_previews WHERE id=? AND state='generating' AND lease_until>?", taskId, now), 'COST_TASK_NOT_ACTIVE');
  else ensure(feature === 'source_summary' && store.get("SELECT 1 FROM source_summaries WHERE attempt_id=? AND status='running' AND lease_until>?", taskId, now), 'COST_TASK_NOT_ACTIVE');
}

/** All database mutations stay in the business process; a provider sees only a no-money observer. */
export function providerMeter(store: Store, clock: Clock, generator: ProviderDeclaration,
  attribution: { scope: CostScope; taskId: string; function: CostFunction }): SynchronousProviderMeter | undefined {
  if (!store.beta) return undefined;
  ensure(generator.providerCalls === 'external' || generator.providerCalls === 'fixture', 'BETA_METERING_REQUIRED');
  if (generator.providerCalls === 'fixture') return undefined;
  ensure(store.betaExternalCalls, 'BETA_GENERATION_PAUSED');
  if ('textProtocol' in generator) ensure(generator.textProtocol === 'accepted-v7', 'BETA_TEXT_PROTOCOL_REQUIRED');
  const frozen = structuredClone(attribution), ledger = new BetaCosts(store, clock);
  return { reserve(specs) {
    ensure(specs.length > 0 && specs.length <= 2 && new Set(specs.map(s => s.stage)).size === specs.length, 'INVALID_COST_INPUT');
    ensure(!specs.some(spec => spec.stage === 'draft' || spec.stage === 'review') ||
      'textProtocol' in generator && generator.textProtocol === 'accepted-v7', 'BETA_TEXT_PROTOCOL_REQUIRED');
    const calls = store.transaction(() => specs.map(spec => {
      assertProviderTaskActive(store, clock, frozen, spec.stage);
      const input: CostCallInput = { ...frozen, provider: spec.provider, model: spec.model, stage: spec.stage,
        bounds: structuredClone(spec.bounds), id: providerCallId(frozen.scope, frozen.taskId, spec.stage) };
      const result = ledger.reserve(input); ensure(!result.duplicate, 'COST_CALL_ALREADY_RESERVED'); return result.call;
    }));
    return {
      start(stage) {
        const call = calls.find(c => c.stage === stage); ensure(call, 'INVALID_COST_INPUT'); assertProviderTaskActive(store, clock, frozen, stage);
        ledger.dispatch(call.id);
        return { finish(value) {
          try { ledger.observe(call.id, 'observed-' + digest(value), value); }
          catch { throw new DomainError('COST_RECORDING_FAILED'); }
        } };
      },
      close() {
        try {
          for (const prepared of calls) {
            const call = ledger.call(prepared.id);
            if (call.state === 'reserved') ledger.cancelReserved(call.id, 'not-dispatched');
            else if (call.state === 'dispatched') ledger.observe(call.id, 'missing-result', { outcome: 'interrupted', providerRequestId: null, reportedModel: null,
              usage: missingUsage(call.bounds.unit), errorCode: 'COST_RESULT_UNAVAILABLE' });
          }
        } catch { throw new DomainError('COST_RECORDING_FAILED'); }
      },
    };
  } };
}
