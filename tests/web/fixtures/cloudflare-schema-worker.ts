import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import { webMigrations, webR2Migrations } from '../../../workers/web-cloudflare/migrations.ts';
import { WebDurableStore } from '../../../apps/server/cloudflare/web-store.ts';
import { PrivateMediaObjects } from '../../../apps/server/cloudflare/media-objects.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const identity = { instanceId: '00000000-0000-4000-8000-000000000001',
  recoveryEpoch: '00000000-0000-4000-8000-000000000002' };

export class WebSchemaFixture {
  private readonly storage: DurableSQLStorage;
  constructor(ctx: { storage: DurableSQLStorage }) { this.storage = ctx.storage; }
  async fetch(request: Request) {
    let query = '';
    try {
      const storage: DurableSQLStorage = { transactionSync: work => this.storage.transactionSync(work),
        sql: { exec: (sql, ...bindings) => { query = sql; return this.storage.sql.exec(sql, ...bindings); } } };
      const errorCode = (work: () => unknown) => {
        try { work(); return 'NO_ERROR'; } catch (error) {
          return error instanceof DomainError ? error.code : 'SQL_ERROR';
        }
      };
      const path = new URL(request.url).pathname;
      if (path === '/r2-without-storage' || path === '/inline-with-storage') {
        const unavailable = async (): Promise<never> => { throw new Error('UNEXPECTED_MEDIA_IO'); };
        const error = errorCode(() => new WebDurableStore(storage,
          path === '/r2-without-storage' ? webR2Migrations : webMigrations,
          path === '/r2-without-storage' ? identity : { ...identity,
            providerAudio: new PrivateMediaObjects({ get: unavailable, put: unavailable }) }));
        const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").toArray();
        new WebDurableStore(storage, webMigrations, identity);
        return Response.json({ error, tables });
      }
      if (path === '/foreign') {
        storage.sql.exec('CREATE TABLE beta_instance(singleton INTEGER PRIMARY KEY,instance_id TEXT)');
        storage.sql.exec("INSERT INTO beta_instance VALUES (1,'preserved')");
        const error = errorCode(() => new WebDurableStore(storage, webMigrations, identity));
        return Response.json({ error, rows: storage.sql.exec('SELECT * FROM beta_instance').toArray() });
      }
      if (path === '/fail-init') {
        const invalid = webMigrations.map(m => m.version === 110 ? { ...m, sql: m.sql + ';SELECT * FROM missing_table;' } : m);
        const error = errorCode(() => new WebDurableStore(storage, invalid, identity));
        const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'").toArray();
        new WebDurableStore(storage, webMigrations, identity);
        return Response.json({ error, tables });
      }
      const store = new WebDurableStore(storage, webMigrations, identity);
      if (path === '/contract') {
        store.run('CREATE TABLE cloud_test(id INTEGER PRIMARY KEY,value TEXT,bytes BLOB)');
        const result = store.run('INSERT INTO cloud_test(value,bytes) VALUES (?,?)', 'outer', new Uint8Array([1, 2, 3]));
        const rolledBack = errorCode(() => store.transaction(() => {
          store.run("UPDATE cloud_test SET value='rollback'"); throw new Error('rollback');
        }));
        const errors = [
          errorCode(() => store.run('UPDATE cloud_test SET id=?', 9007199254740992n)),
          errorCode(() => store.run('UPDATE cloud_test SET id=?', Infinity)),
          errorCode(() => store.transaction(async () => store.run("UPDATE cloud_test SET value='bad'"))),
          errorCode(() => store.transaction(() => {
            store.run("UPDATE cloud_test SET value='bad'"); return Promise.resolve();
          })),
          errorCode(() => new WebDurableStore(storage, webMigrations, { ...identity,
            instanceId: '00000000-0000-4000-8000-000000000003' })),
          errorCode(() => new WebDurableStore(storage, webMigrations, { ...identity,
            recoveryEpoch: '00000000-0000-4000-8000-000000000004' })),
          errorCode(() => new WebDurableStore(storage, webMigrations.map(m => ({ ...m, sql: m.sql + '\n' })), identity)),
        ];
        const row = store.get<{ value: string; bytes: Uint8Array }>('SELECT * FROM cloud_test')!;
        return Response.json({ result, rolledBack, errors, row: { value: row.value, bytes: [...row.bytes] } });
      }
      if (path === '/persisted') return Response.json(store.get('SELECT value FROM cloud_test'));
      const tables = store.all<{ name: string }>(`SELECT name FROM sqlite_master
        WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'cf_*' ORDER BY name`);
      return Response.json({ version: store.get('PRAGMA user_version'),
        budgets: store.all('SELECT * FROM web_provider_spending'),
        tables: tables.map(({ name }) => ({ name, columns: store.all(`PRAGMA table_info("${name}")`),
          foreignKeys: store.all(`PRAGMA foreign_key_list("${name}")`),
          indexes: store.all(`PRAGMA index_list("${name}")`) })),
        triggers: store.all("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name") });
    } catch (error) {
      return Response.json({ ok: false, query: query.slice(0, 180), error: String(error) }, { status: 500 });
    }
  }
}
export default { fetch(request: Request, env: { STATE: {
  idFromName(name: string): unknown; get(id: unknown): { fetch(request: Request): Promise<Response> };
} }) { return env.STATE.get(env.STATE.idFromName(new URL(request.url).searchParams.get('object') ?? 'schema')).fetch(request); } };
