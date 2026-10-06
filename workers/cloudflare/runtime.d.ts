// Minimal structural declarations used by our entrypoints; execution is verified in real workerd.
declare module 'cloudflare:workers' {
  export class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env;
  }
  export class RpcTarget {}
  export class DurableObject<Env = unknown> {
    constructor(ctx: unknown, env: Env);
  }
}

declare module '*.sql' {
  const sql: string;
  export default sql;
}
