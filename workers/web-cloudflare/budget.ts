import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import { ensure } from '../../packages/domain/errors.ts';
import { WebCloudBudget } from '../../apps/server/cloudflare/web-budget.ts';
import type { DurableSQLStorage } from '../../apps/server/cloudflare/store.ts';
import type {
  CloudBudgetTarget,
  CloudBudgetAuthorization,
  Provider,
} from '../../apps/server/budget/web-provider-budget-contract.ts';
import type { WebBudgetRPC, WebBudgetStatusRPC } from '../../apps/server/cloudflare/web-budget-client.ts';

export interface BudgetEnvironment {
  ACCOUNT_ID: string;
  BUDGET_NAMESPACE_ID: string;
  BUDGET_OBJECT_ID: string;
  OPERATOR_ENABLED?: string;
  BUDGET: { idFromString(id: string): unknown; get(id: unknown): WebBudgetStatusRPC };
}
const target = (env: BudgetEnvironment): CloudBudgetTarget => ({
  accountId: env.ACCOUNT_ID,
  namespaceId: env.BUDGET_NAMESPACE_ID,
  objectId: env.BUDGET_OBJECT_ID,
});

/** No public HTTP API and no business database/credentials in this separate Worker. */
export class WebBudgetObject extends DurableObject<BudgetEnvironment> {
  private readonly ledger: WebCloudBudget;
  private readonly operator: boolean;
  constructor(ctx: { storage: DurableSQLStorage; id: { toString(): string } }, env: BudgetEnvironment) {
    super(ctx, env);
    this.ledger = new WebCloudBudget(ctx.storage, { now: () => Date.now() }, target(env), ctx.id.toString());
    this.operator = env.OPERATOR_ENABLED === 'true';
  }
  initialize(grants: CloudBudgetAuthorization[]) {
    ensure(this.operator, 'WEB_CLOUD_BUDGET_OPERATOR_DISABLED');
    return this.ledger.initialize(grants);
  }
  summary() {
    return this.ledger.summary();
  }
  read(id: string, fingerprint: string) {
    return this.ledger.read(id, fingerprint);
  }
  reserve(id: string, provider: Provider, fingerprint: string, micros: number) {
    this.ledger.reserve(id, provider, fingerprint, micros);
  }
  settle(id: string, fingerprint: string, micros: number, receipt: unknown) {
    this.ledger.settle(id, fingerprint, micros, receipt);
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}

export class WebBudgetService extends WorkerEntrypoint<BudgetEnvironment> implements WebBudgetRPC {
  private authority() {
    return this.env.BUDGET.get(this.env.BUDGET.idFromString(this.env.BUDGET_OBJECT_ID));
  }
  async summary() {
    return this.authority().summary();
  }
  async read(id: string, fingerprint: string) {
    return this.authority().read(id, fingerprint);
  }
  async reserve(id: string, provider: Provider, fingerprint: string, micros: number) {
    await this.authority().reserve(id, provider, fingerprint, micros);
  }
  async settle(id: string, fingerprint: string, micros: number, receipt: unknown) {
    await this.authority().settle(id, fingerprint, micros, receipt);
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
interface BudgetOperatorEnvironment extends Omit<BudgetEnvironment, 'BUDGET'> {
  BUDGET: {
    idFromName(name: string): { toString(): string };
    idFromString(id: string): unknown;
    get(id: unknown): WebBudgetStatusRPC & { initialize(grants: CloudBudgetAuthorization[]): Promise<unknown> };
  };
}
export class WebBudgetOperatorService extends WorkerEntrypoint<BudgetOperatorEnvironment> {
  private enabled() {
    ensure(this.env.OPERATOR_ENABLED === 'true', 'WEB_CLOUD_BUDGET_OPERATOR_DISABLED');
  }
  objectId(name: string) {
    this.enabled();
    ensure(/^[A-Za-z0-9_-]{1,128}$/.test(name), 'WEB_CLOUD_OBJECT_NAME_INVALID');
    return this.env.BUDGET.idFromName(name).toString();
  }
  async initialize(grants: CloudBudgetAuthorization[]) {
    this.enabled();
    return this.env.BUDGET.get(this.env.BUDGET.idFromString(this.env.BUDGET_OBJECT_ID)).initialize(grants);
  }
  async summary() {
    this.enabled();
    return this.env.BUDGET.get(this.env.BUDGET.idFromString(this.env.BUDGET_OBJECT_ID)).summary();
  }
  fetch() {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
