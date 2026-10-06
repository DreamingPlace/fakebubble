import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import { webMigrations, webR2Migrations } from '../../../workers/web-cloudflare/migrations.ts';
import { WebDurableStore } from '../../../apps/server/cloudflare/web-store.ts';
import { PrivateMediaObjects } from '../../../apps/server/cloudflare/media-objects.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const identity = {
  instanceId: '00000000-0000-4000-8000-000000000001',
  recoveryEpoch: '00000000-0000-4000-8000-000000000002',
};
const unavailable = async (): Promise<never> => {
  throw new Error('UNEXPECTED_MEDIA_IO');
};

/** Real workerd SQLite: the stage-metrics migration on the inline and the R2 authorities, and Worker-var validation. */
export class WebMetricsFixture {
  private readonly storage: DurableSQLStorage;
  constructor(ctx: { storage: DurableSQLStorage }) {
    this.storage = ctx.storage;
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    const storage = this.storage;
    const names = () =>
      storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' ORDER BY name")
        .toArray()
        .map((row) => String(row.name));
    if (path === '/invalid') {
      const errors: string[] = [];
      for (const concurrency of [
        { maxTextRunning: 0 },
        { maxTextRunning: 65 },
        { maxTextRunning: 1.5 },
        { maxAudioRunning: 0 },
        { maxAudioRunning: 49 },
        { audioFallbackWaitMs: 999 },
      ])
        try {
          new WebDurableStore(storage, webMigrations, { ...identity, concurrency: concurrency as never });
          errors.push('STARTED');
        } catch (error) {
          errors.push(error instanceof DomainError ? error.code : 'OTHER');
        }
      return Response.json({ errors, tables: names() });
    }
    const r2 = path === '/r2';
    const store = new WebDurableStore(
      storage,
      r2 ? webR2Migrations : webMigrations,
      r2
        ? {
            ...identity,
            providerAudio: new PrivateMediaObjects({ get: unavailable, put: unavailable }),
            concurrency: { maxTextRunning: 7, maxAudioRunning: 3 } as never,
          }
        : identity,
    );
    const tables = names();
    return Response.json({
      version: store.get('PRAGMA user_version'),
      metrics: tables.includes('web_operation_metrics') && tables.includes('web_attempt_rejections'),
      mediaIdNotNull: storage.sql
        .exec('PRAGMA table_info(web_publication_items)')
        .toArray()
        .find((column) => column.name === 'media_id')?.notnull,
      itemTriggers: storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='web_publication_items' ORDER BY name")
        .toArray()
        .map((row) => String(row.name)),
      ledger: storage.sql
        .exec('SELECT version FROM cf_web_migrations ORDER BY version')
        .toArray()
        .map((row) => row.version),
      concurrency: store.concurrency,
    });
  }
}
export default {
  fetch(
    request: Request,
    env: {
      STATE: {
        idFromName(name: string): unknown;
        get(id: unknown): { fetch(request: Request): Promise<Response> };
      };
    },
  ) {
    return env.STATE.get(env.STATE.idFromName(new URL(request.url).searchParams.get('object') ?? 'metrics')).fetch(
      request,
    );
  },
};
