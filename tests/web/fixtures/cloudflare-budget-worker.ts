import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import budgetWorker, { WebBudgetObject } from '../../../workers/web-cloudflare/budget.ts';

type Namespace = {
  idFromName(name: string): { toString(): string };
  get(id: unknown): {
    fetch(request: Request): Promise<Response>;
    initialize(grants: unknown): Promise<unknown>;
    reserve(...args: unknown[]): Promise<void>;
    settle(...args: unknown[]): Promise<void>;
    read(...args: unknown[]): Promise<unknown>;
    summary(): Promise<unknown>;
  };
};
type Environment = { STATE: Namespace; DISABLED: Namespace };
const target = (namespace: Namespace) => ({
  accountId: 'a'.repeat(32),
  namespaceId: 'b'.repeat(32),
  objectId: namespace.idFromName('budget').toString(),
});
const config = (namespace: Namespace) => {
  const t = target(namespace);
  return {
    ACCOUNT_ID: t.accountId,
    BUDGET_NAMESPACE_ID: t.namespaceId,
    BUDGET_OBJECT_ID: t.objectId,
    BUDGET: {
      idFromString: (id: string) => id,
      get: () => {
        throw Error('unused');
      },
    },
  };
};

/** Test-only operator environment around the real production DurableObject/RPC class. */
export class WebBudgetFixture extends WebBudgetObject {
  constructor(ctx: { storage: DurableSQLStorage; id: { toString(): string } }, env: Environment) {
    super(ctx, { ...config(env.STATE), OPERATOR_ENABLED: 'true' });
  }
}
export class WebBudgetDisabledFixture extends WebBudgetObject {
  constructor(ctx: { storage: DurableSQLStorage; id: { toString(): string } }, env: Environment) {
    super(ctx, config(env.DISABLED));
  }
}
/** Never deployed: this bridge deliberately exposes test-only RPC actions over local HTTP. */
export default {
  async fetch(request: Request, env: Environment) {
    try {
      const url = new URL(request.url),
        path = url.pathname;
      if (path === '/target') return Response.json(target(env.STATE));
      if (path === '/public-worker') return budgetWorker.fetch();
      const stub = env.STATE.get(env.STATE.idFromName(url.searchParams.get('object') ?? 'budget'));
      const body = request.method === 'POST' ? ((await request.json()) as any) : {};
      let value: unknown;
      if (path === '/public-object') return stub.fetch(request);
      if (path === '/initialize') value = await stub.initialize(body.grants);
      else if (path === '/disabled')
        value = await env.DISABLED.get(env.DISABLED.idFromName('budget')).initialize(body.grants);
      else if (path === '/reserve') value = await stub.reserve(body.id, body.provider, body.fingerprint, body.micros);
      else if (path === '/settle') value = await stub.settle(body.id, body.fingerprint, body.micros, body.receipt);
      else if (path === '/read') value = await stub.read(body.id, body.fingerprint);
      else if (path === '/summary') value = await stub.summary();
      else return new Response('Not found', { status: 404 });
      return Response.json(value ?? null);
    } catch (error) {
      // workerd RPC serializes DomainError as Error; only the test bridge exposes its code.
      const message = error instanceof Error ? error.message : String(error);
      return Response.json({ error: message }, { status: /^WEB_/.test(message) ? 409 : 500 });
    }
  },
};
