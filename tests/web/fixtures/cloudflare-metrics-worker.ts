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
    if (path === '/upgrade') {
      // An authority created before a later step existed: the steps up to `through` (default 113) exactly as the
      // constructor applied them; opening it applies every newer step.
      const params = new URL(request.url).searchParams;
      const r2Mode = params.get('mode') === 'r2';
      const through = Number(params.get('through') ?? 113);
      const list = r2Mode ? webR2Migrations : webMigrations;
      const sha = async (sql: string) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sql)))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      storage.sql.exec('CREATE TABLE cf_web_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
      for (const m of list.filter((step) => step.version <= through)) {
        storage.sql.exec(m.sql);
        storage.sql.exec('INSERT INTO cf_web_migrations VALUES (?,?)', m.version, await sha(m.sql));
      }
      storage.sql.exec(
        'INSERT INTO web_instance(singleton,instance_id,recovery_epoch) VALUES (1,?,?)',
        identity.instanceId,
        identity.recoveryEpoch,
      );
      const ledger = () =>
        storage.sql
          .exec('SELECT version,sha256 FROM cf_web_migrations ORDER BY version')
          .toArray()
          .map((row) => `${row.version}:${row.sha256}`);
      const before = ledger();
      const store = new WebDurableStore(
        storage,
        list,
        r2Mode
          ? { ...identity, providerAudio: new PrivateMediaObjects({ get: unavailable, put: unavailable }) }
          : identity,
      );
      return Response.json({
        before,
        after: ledger(),
        version: store.get('PRAGMA user_version'),
        metrics: names().includes('web_operation_metrics'),
        review: {
          importance: storage.sql
            .exec('PRAGMA table_info(memory_topics)')
            .toArray()
            .some((column) => column.name === 'importance'),
          facts: names().includes('memory_facts'),
          reviewChanged: storage.sql
            .exec('PRAGMA table_info(web_operation_metrics)')
            .toArray()
            .some((column) => column.name === 'review_changed'),
        },
        discardedColumn: storage.sql
          .exec('PRAGMA table_info(web_operation_metrics)')
          .toArray()
          .some((column) => column.name === 'discarded_audio_segments'),
      });
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
      hashes: storage.sql
        .exec('SELECT version,sha256 FROM cf_web_migrations ORDER BY version')
        .toArray()
        .map((row) => `${row.version}:${row.sha256}`),
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
