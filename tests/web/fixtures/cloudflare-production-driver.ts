import type { WebCloudMaterialPackage } from '../../../apps/server/cloudflare/web-setup.ts';
import type { CloudBudgetAuthorization } from '../../../apps/server/budget/web-provider-budget-contract.ts';
interface Environment {
  OPERATOR: {
    initialize(value: WebCloudMaterialPackage): Promise<unknown>;
    importFixed(kind: 'welcome' | 'footer', id: string, wav: Uint8Array): Promise<unknown>;
    status(): Promise<unknown>;
    inspect(): Promise<unknown>;
    adminGrant(): Promise<unknown>;
    inviteGrants(id: string): Promise<unknown>;
    objectId(name: string): Promise<string>;
    fetch(request: Request): Promise<Response>;
  };
  BUDGET_OPERATOR: { initialize(grants: CloudBudgetAuthorization[]): Promise<unknown>; summary(): Promise<unknown> };
  GENERATION: { configure(mode: string): Promise<void>; stats(): Promise<string[]> };
  EDGE: { fetch(request: Request): Promise<Response> };
  BUSINESS_HTTP: { fetch(request: Request): Promise<Response> };
  BUDGET_HTTP: { fetch(request: Request): Promise<Response> };
  GENERATION_HTTP: { fetch(request: Request): Promise<Response> };
}
/** Local test driver only. Deployed edge has none of these operator or test routes/bindings. */
export default {
  async fetch(request: Request, env: Environment) {
    const value = (await request.json()) as {
      action: string;
      body: any;
      path?: string;
      method?: string;
      headers?: Record<string, string>;
    };
    try {
      switch (value.action) {
        case 'initialize':
          return Response.json(await env.OPERATOR.initialize(value.body));
        case 'asset':
          return Response.json(
            await env.OPERATOR.importFixed(value.body.kind, value.body.characterId, Uint8Array.from(value.body.bytes)),
          );
        case 'status':
          return Response.json(await env.OPERATOR.status());
        case 'inspect':
          return Response.json(await env.OPERATOR.inspect());
        case 'grant':
          return Response.json(await env.OPERATOR.adminGrant());
        case 'invite-grants':
          return Response.json(await env.OPERATOR.inviteGrants(value.body));
        case 'object-id':
          return Response.json(await env.OPERATOR.objectId('business'));
        case 'budget-initialize':
          return Response.json(await env.BUDGET_OPERATOR.initialize(value.body));
        case 'budget-summary':
          return Response.json(await env.BUDGET_OPERATOR.summary());
        case 'generation-mode':
          await env.GENERATION.configure(value.body);
          return Response.json(null);
        case 'generation-stats':
          return Response.json(await env.GENERATION.stats());
      }
      const incoming = new Request('https://fixture.invalid' + (value.path ?? '/'), {
        method: value.method ?? 'GET',
        headers: { host: 'fixture.invalid', 'cf-connecting-ip': '192.0.2.1', ...value.headers },
        ...(value.body === undefined ? {} : { body: JSON.stringify(value.body) }),
      });
      if (value.action === 'business-http') return env.BUSINESS_HTTP.fetch(incoming);
      if (value.action === 'budget-http') return env.BUDGET_HTTP.fetch(incoming);
      if (value.action === 'generation-http') return env.GENERATION_HTTP.fetch(incoming);
      if (value.action === 'operator-http') return env.OPERATOR.fetch(incoming);
      return env.EDGE.fetch(incoming);
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'FAILED' }, { status: 409 });
    }
  },
};
