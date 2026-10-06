import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';
import {
  budgetAttempt,
  type BudgetAttemptKey,
  type Provider,
  type WebAttemptBudget,
} from '../budget/web-provider-budget-contract.ts';
import type { CloudBudgetEntry, WebCloudBudget } from './web-budget.ts';

export interface WebBudgetRPC {
  reserve(id: string, provider: Provider, fingerprint: string, micros: number): Promise<void>;
  settle(id: string, fingerprint: string, micros: number, receipt: unknown): Promise<void>;
  read(id: string, fingerprint: string): Promise<CloudBudgetEntry | undefined>;
}
export interface WebBudgetStatusRPC extends WebBudgetRPC {
  summary(): Promise<ReturnType<WebCloudBudget['summary']>>;
}
/** Private service binding only. No caller-supplied authority/URL or default USD3 namespace. */
export class WebCloudBudgetClient implements WebAttemptBudget {
  private readonly rpc: WebBudgetRPC;
  constructor(rpc: WebBudgetRPC) {
    this.rpc = rpc;
  }
  async beginAttempt(store: BusinessStore, key: BudgetAttemptKey, resume = false) {
    const { row, id, fingerprint } = budgetAttempt(store, key);
    ensure(row.state === 'not_sent', 'WEB_SHARED_ATTEMPT_UNRESOLVED');
    if (resume) {
      const held = await this.rpc.read(id, fingerprint);
      ensure(held?.charged_micros === null && held.held_micros === row.held_micros, 'WEB_SHARED_ATTEMPT_UNRESOLVED');
      return;
    }
    await this.rpc.reserve(id, row.provider, fingerprint, row.held_micros);
  }
  async settleAttempt(store: BusinessStore, key: BudgetAttemptKey) {
    const { row, id, fingerprint } = budgetAttempt(store, key);
    ensure(row.state === 'known' && row.outcome !== 'not_dispatched', 'WEB_SHARED_RECEIPT_INVALID');
    await this.rpc.settle(id, fingerprint, row.charged_micros, JSON.parse(row.receipt_json));
  }
  async recoverKnown(store: BusinessStore) {
    for (const key of store.all<BudgetAttemptKey>(`SELECT operation_id operationId,phase,ordinal
      FROM web_provider_attempts WHERE state='known' AND outcome IN ('succeeded','failed')`)) {
      const { id, fingerprint } = budgetAttempt(store, key);
      ensure(await this.rpc.read(id, fingerprint), 'WEB_SHARED_RECEIPT_MISSING');
      await this.settleAttempt(store, key);
    }
  }
}
