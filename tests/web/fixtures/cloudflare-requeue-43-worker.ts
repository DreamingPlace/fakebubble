import { WebBusinessFixture } from './cloudflare-business-worker.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebCloudExecutor, webProviderNextDue } from '../../../apps/server/cloudflare/web-executor.ts';
import { WebCloudBudgetClient, type WebBudgetRPC } from '../../../apps/server/cloudflare/web-budget-client.ts';
import { ensure } from '../../../packages/domain/errors.ts';

/**
 * Part 43 fixture: a shared budget kept in the object's own SQL (it survives a real workerd restart) and a hook that
 * hangs the stage forever between the committed intent (local hold + ticket, optionally the shared reservation) and the
 * send gate, so the test can restart workerd exactly there.
 */
export class WebRequeueFixture extends WebBusinessFixture {
  private readonly alarms: AlarmStorage;
  private readonly executor: WebCloudExecutor;
  constructor(
    ctx: { storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void },
    env: { MEDIA: PrivateBucket },
  ) {
    super(ctx, env, { now: () => Date.now() });
    this.alarms = ctx.storage;
    this.store.run('CREATE TABLE IF NOT EXISTS cf_fixture_hold(singleton INTEGER PRIMARY KEY,mode TEXT NOT NULL)');
    this.store.run(`CREATE TABLE IF NOT EXISTS cf_fixture_shared(id TEXT PRIMARY KEY,provider TEXT NOT NULL,
      fingerprint TEXT NOT NULL,held_micros INTEGER NOT NULL,charged_micros INTEGER,receipt_hash TEXT)`);
    this.store.run(
      'CREATE TABLE IF NOT EXISTS cf_fixture_reserve_log(n INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL)',
    );
    const mode = () => this.store.get<{ mode: string }>('SELECT mode FROM cf_fixture_hold')?.mode;
    const hang = async () => {
      this.store.run('DELETE FROM cf_fixture_hold');
      await new Promise<void>(() => {});
    };
    const rpc: WebBudgetRPC = {
      read: async (id, fingerprint) => {
        const row = this.store.get<{
          provider: 'deepseek' | 'fish';
          fingerprint: string;
          held_micros: number;
          charged_micros: number | null;
          receipt_hash: string | null;
        }>('SELECT provider,fingerprint,held_micros,charged_micros,receipt_hash FROM cf_fixture_shared WHERE id=?', id);
        if (row) ensure(row.fingerprint === fingerprint, 'WEB_SHARED_REQUEST_CONFLICT');
        return row ? { ...row } : undefined;
      },
      reserve: async (id, provider, fingerprint, micros) => {
        if (mode() === 'before-reserve') await hang();
        ensure(!this.store.get('SELECT 1 FROM cf_fixture_shared WHERE id=?', id), 'WEB_SHARED_ATTEMPT_UNRESOLVED');
        this.store.run('INSERT INTO cf_fixture_shared VALUES (?,?,?,?,NULL,NULL)', id, provider, fingerprint, micros);
        this.store.run('INSERT INTO cf_fixture_reserve_log(id) VALUES (?)', id);
        if (mode() === 'after-reserve') await hang();
      },
      settle: async (id, fingerprint, micros, receipt) => {
        ensure(
          this.store.get('SELECT 1 FROM cf_fixture_shared WHERE id=? AND fingerprint=?', id, fingerprint),
          'WEB_SHARED_RECEIPT_INVALID',
        );
        this.store.run(
          'UPDATE cf_fixture_shared SET charged_micros=?,receipt_hash=? WHERE id=? AND charged_micros IS NULL',
          micros,
          JSON.stringify(receipt),
          id,
        );
      },
    };
    this.executor = new WebCloudExecutor(
      ctx,
      this.store,
      this.clock,
      this.createRunner(250, undefined, new WebCloudBudgetClient(rpc)),
    );
  }
  alarm() {
    return this.executor.alarm();
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/hold') {
      const { mode } = (await request.json()) as { mode: string };
      this.store.run(
        'INSERT INTO cf_fixture_hold VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET mode=excluded.mode',
        mode,
      );
      return Response.json({ configured: true });
    }
    if (path === '/requeue-status')
      return Response.json({
        alarm: await this.alarms.getAlarm(),
        due: webProviderNextDue(this.store, this.clock.now()),
        error: this.executor.executor.lastError,
        coordinator: this.store.get('SELECT epoch,coordinator_expires_at FROM web_scheduler_state'),
        operations: this.store.all('SELECT id,status,quota_state FROM web_operations ORDER BY admission_seq'),
        attempts: this.store.all(
          'SELECT phase,state,outcome,held_micros FROM web_provider_attempts ORDER BY operation_id,phase,ordinal',
        ),
        external: this.store.all(
          'SELECT phase,dispatch_state,outcome FROM web_external_attempts ORDER BY operation_id,stage,phase,ordinal',
        ),
        capacity: this.store.all(
          'SELECT provider,stage,phase,reserved FROM web_external_budgets ORDER BY provider,stage,phase',
        ),
        stageAttempts: this.store.all('SELECT stage,attempt,provider_request_id FROM web_stage_attempts'),
        publications: this.store.get<{ n: number }>('SELECT count(*) n FROM web_publications')!.n,
        shared: this.store.all('SELECT charged_micros IS NOT NULL settled FROM cf_fixture_shared'),
        reserveLog: this.store.get<{ n: number }>('SELECT count(*) n FROM cf_fixture_reserve_log')!.n,
        calls: this.store.all('SELECT * FROM cf_fixture_calls ORDER BY provider'),
        spending: this.store.all(
          'SELECT provider,spent_micros,held_micros FROM web_provider_spending ORDER BY provider',
        ),
      });
    if (path === '/wake') {
      await this.executor.wake();
      return Response.json({ scheduled: true });
    }
    if (path === '/run') return new Response(null, { status: 404 });
    if (path === '/admit') await this.executor.wake();
    return super.fetch(request);
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
    return env.STATE.get(env.STATE.idFromName('requeue')).fetch(request);
  },
};
