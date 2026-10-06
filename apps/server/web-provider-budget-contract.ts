import { createHash } from 'node:crypto';
import { ensure } from '../../packages/domain/errors.ts';
import type { BusinessStore } from './store-contract.ts';

export type Provider = 'deepseek' | 'fish';
export type BudgetAttemptKey = { operationId: string; phase: string; ordinal: number };
export interface WebAttemptBudget {
  beginAttempt(store: BusinessStore, key: BudgetAttemptKey): void | Promise<void>;
  settleAttempt(store: BusinessStore, key: BudgetAttemptKey): void | Promise<void>;
  recoverKnown(store: BusinessStore): void | Promise<void>;
}
export const budgetHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Stable full-scope identity, shared by local and remote cumulative authorities. */
export function budgetAttempt(store: BusinessStore, key: BudgetAttemptKey) {
  const row = store.get<Record<string, any>>(
    `SELECT * FROM web_provider_attempts
    WHERE operation_id=? AND phase=? AND ordinal=?`,
    key.operationId,
    key.phase,
    key.ordinal,
  );
  const instance = store.get<{ instance_id: string }>('SELECT instance_id FROM web_instance WHERE singleton=1');
  ensure(row && instance, 'WEB_SHARED_INSTANCE_INVALID');
  const id = JSON.stringify([instance.instance_id, key.operationId, key.phase, key.ordinal]);
  const fingerprint = budgetHash([
    row.principal_id,
    row.player_id,
    row.world_id,
    row.conversation_id,
    row.character_id,
    row.input_message_id,
    row.request_digest,
    row.policy_hash,
    row.wire_request_hash,
    row.voice_version,
    row.provider,
    row.model,
    row.price_id,
    row.max_units,
    row.held_micros,
  ]);
  return { row, id, fingerprint };
}

export interface CloudBudgetGrant {
  version: 1;
  id: string;
  accountId: string;
  namespaceId: string;
  objectId: string;
  provider: Provider;
  micros: number;
  priorSpentMicros: number;
  priorHeldMicros: number;
  createdAt: number;
}
export type WebBudgetPolicy = 'test-cumulative' | 'production-unlimited';
/** Explicit operator authorization, not an allocation from the cumulative test ledger. */
export interface CloudProductionBudgetAuthorization extends CloudBudgetTarget {
  version: 2;
  id: string;
  provider: Provider;
  purpose: 'production';
  limit: 'unlimited';
  createdAt: number;
}
export type CloudBudgetAuthorization = CloudBudgetGrant | CloudProductionBudgetAuthorization;
export type CloudBudgetTarget = Pick<CloudBudgetGrant, 'accountId' | 'namespaceId' | 'objectId'>;
export function validateCloudBudgetTarget(target: CloudBudgetTarget) {
  ensure(
    /^[a-f0-9]{32}$/.test(target.accountId) &&
      /^[a-f0-9]{32}$/.test(target.namespaceId) &&
      /^[a-f0-9]{64}$/.test(target.objectId),
    'WEB_CLOUD_BUDGET_TARGET_INVALID',
  );
}
export function validateCloudBudgetGrant(grant: CloudBudgetGrant) {
  validateCloudBudgetTarget(grant);
  ensure(
    grant.version === 1 &&
      /^[A-Za-z0-9_-]{1,128}$/.test(grant.id) &&
      ['deepseek', 'fish'].includes(grant.provider) &&
      [grant.micros, grant.priorSpentMicros, grant.priorHeldMicros, grant.createdAt].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      grant.micros > 0 &&
      grant.micros + grant.priorSpentMicros + grant.priorHeldMicros <= 3_000_000,
    'WEB_CLOUD_BUDGET_GRANT_INVALID',
  );
}
export function validateCloudBudgetAuthorization(value: CloudBudgetAuthorization) {
  if (value.version === 1) return validateCloudBudgetGrant(value);
  validateCloudBudgetTarget(value);
  ensure(
    value.version === 2 &&
      value.purpose === 'production' &&
      value.limit === 'unlimited' &&
      Object.keys(value).sort().join(',') ===
        'accountId,createdAt,id,limit,namespaceId,objectId,provider,purpose,version' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value.id) &&
      ['deepseek', 'fish'].includes(value.provider) &&
      Number.isSafeInteger(value.createdAt) &&
      value.createdAt >= 0,
    'WEB_CLOUD_BUDGET_AUTHORIZATION_INVALID',
  );
}
