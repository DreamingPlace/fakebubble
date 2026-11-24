import { WebBusinessObject as Retention } from './cloudflare-production-retention-worker.ts';
export { WebOperatorService, default } from './cloudflare-production-retention-worker.ts';

/**
 * Part 54 TEST MODEL of Cloudflare's limit of 6 simultaneous outbound connections per invocation (workerd does not enforce it).
 *
 * What is modelled, from Cloudflare's documentation: an invocation may have 6 connections open; further attempts QUEUE until one
 * closes; a connection that can never make progress is eventually cancelled by the runtime ("the Worker's code had hung"), which
 * the model does after CONNECTION_HUNG_MS. Here a "connection" is one open generation session (it lives from open() to dispose)
 * and one in-flight budget RPC. Everything else (calls INTO this object, e.g. RPC callbacks from generation) is not counted.
 * CONNECTION_LIMIT=0 turns the model off. The model is shared by every call in the object, which matches production: the alarm
 * runs all stages of every reply inside one invocation (waitUntil).
 */
class Connections {
  inUse = 0;
  peak = 0;
  hungCount = 0;
  private readonly queue: { grant(): void; fail(): void }[] = [];
  readonly limit: number;
  readonly hungMs: number;
  constructor(limit: number, hungMs: number) {
    this.limit = limit;
    this.hungMs = hungMs;
  }
  acquire(): Promise<() => void> {
    const take = () => {
      this.inUse++;
      this.peak = Math.max(this.peak, this.inUse);
      let freed = false;
      const timer = setTimeout(() => {
        // The runtime cancels a connection that cannot progress; its holder sees an error.
        if (!freed) {
          this.hungCount++;
          free();
        }
      }, this.hungMs);
      const free = () => {
        if (freed) return;
        freed = true;
        clearTimeout(timer);
        this.inUse--;
        this.queue.shift()?.grant();
      };
      return free;
    };
    if (this.inUse < this.limit) return Promise.resolve(take());
    return new Promise((resolve, reject) => {
      const waiter = {
        grant: () => {
          clearTimeout(timer);
          resolve(take());
        },
        fail: () => reject(new Error('The Workers runtime canceled this request because it detected that your Worker had hung')),
      };
      const timer = setTimeout(() => {
        const at = this.queue.indexOf(waiter);
        if (at >= 0) this.queue.splice(at, 1);
        this.hungCount++;
        waiter.fail();
      }, this.hungMs);
      this.queue.push(waiter);
    });
  }
}
function limited<T extends object>(target: T, connections: Connections, mode: 'session' | 'call'): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver) as unknown;
      if (typeof property === 'symbol' || typeof value !== 'function') return value;
      if (mode === 'session' && property === 'open')
        return async () => {
          const free = await connections.acquire();
          try {
            const session = await (object as any).open();
            return new Proxy(session, {
              get(inner, key) {
                if (key === Symbol.dispose)
                  return () => {
                    free();
                    inner[Symbol.dispose]();
                  };
                const member = inner[key];
                return typeof member === 'function' ? (...args: unknown[]) => inner[key](...args) : member;
              },
            });
          } catch (error) {
            free();
            throw error;
          }
        };
      return async (...args: unknown[]) => {
        const free = await connections.acquire();
        try {
          return await (object as any)[property](...args);
        } finally {
          free();
        }
      };
    },
  });
}
export const connectionModel: { current: Connections | null } = { current: null };

export class WebBusinessObject extends Retention {
  constructor(ctx: never, env: Record<string, unknown>) {
    const limit = Number(env.CONNECTION_LIMIT ?? 0);
    let wrapped = env;
    if (limit > 0) {
      const connections = new Connections(limit, Number(env.CONNECTION_HUNG_MS ?? 90_000));
      connectionModel.current = connections;
      wrapped = {
        ...env,
        GENERATION: limited(env.GENERATION as object, connections, 'session'),
        BUDGET: limited(env.BUDGET as object, connections, 'call'),
      };
    }
    super(ctx, wrapped as never);
    this.connections = connectionModel.current;
    this.storage = (ctx as unknown as { storage: { sql: { exec(q: string, ...b: unknown[]): { toArray(): any[] } } } }).storage;
  }
  private readonly connections: Connections | null;
  private readonly storage: { sql: { exec(q: string, ...b: unknown[]): { toArray(): any[] } } };
  async fetch(request: Request) {
    if (new URL(request.url).pathname === '/__test/connections')
      return Response.json({
        limit: this.connections?.limit ?? 0,
        inUse: this.connections?.inUse ?? 0,
        peak: this.connections?.peak ?? 0,
        hung: this.connections?.hungCount ?? 0,
      });
    if (new URL(request.url).pathname === '/__test/tickets') {
      const rows = (query: string) => this.storage.sql.exec(query).toArray();
      return Response.json({
        budgets: rows('SELECT provider,stage,phase,capacity,reserved FROM web_external_budgets ORDER BY 1,2,3'),
        attempts: rows(
          'SELECT provider,phase,dispatch_state state,count(*) n FROM web_external_attempts GROUP BY 1,2,3 ORDER BY 1,2,3',
        ),
        operations: rows('SELECT status,count(*) n FROM web_operations GROUP BY 1 ORDER BY 1'),
      });
    }
    return super.fetch(request);
  }
}
