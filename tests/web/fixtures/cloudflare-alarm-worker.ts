import { WebBusinessFixture } from './cloudflare-business-worker.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebCloudExecutor, webProviderNextDue } from '../../../apps/server/cloudflare/web-executor.ts';

/** Real platform alarms, fake transports and fixed fixture identity; never a deployment entry. */
export class WebAlarmFixture extends WebBusinessFixture {
  private readonly alarms: AlarmStorage;
  private readonly executor: WebCloudExecutor;
  private releaseSpeech: (() => void) | undefined;
  constructor(
    ctx: { storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void },
    env: { MEDIA: PrivateBucket },
  ) {
    super(ctx, env, { now: () => Date.now() });
    this.alarms = ctx.storage;
    this.store.run('CREATE TABLE IF NOT EXISTS cf_fixture_alarm(singleton INTEGER PRIMARY KEY,mode TEXT)');
    this.executor = new WebCloudExecutor(
      ctx,
      this.store,
      this.clock,
      this.createRunner(250, async (provider, signal) => {
        const mode = this.store.get<{ mode: string }>('SELECT mode FROM cf_fixture_alarm')?.mode;
        if (provider === 'speech' && mode === 'unknown') throw new Error('OFFLINE_SEND_UNCERTAIN');
        if (provider === 'speech' && mode === 'hold-speech') {
          this.store.run('DELETE FROM cf_fixture_alarm');
          await new Promise<void>((resolve, reject) => {
            this.releaseSpeech = () => {
              signal.removeEventListener('abort', abort);
              resolve();
            };
            const abort = () => reject(new Error('OFFLINE_ABORT'));
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        }
        if (provider === 'text' && mode === 'slow-text') {
          this.store.run('DELETE FROM cf_fixture_alarm');
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', abort);
              resolve();
            }, 32_000);
            const abort = () => {
              clearTimeout(timer);
              reject(new Error('OFFLINE_ABORT'));
            };
            signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
          });
        }
      }),
    );
  }
  alarm() {
    return this.executor.alarm();
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (path === '/release-speech') {
      this.releaseSpeech?.();
      return Response.json({ released: true });
    }
    if (path === '/alarm-status')
      return Response.json({
        alarm: await this.alarms.getAlarm(),
        due: webProviderNextDue(this.store, this.clock.now()),
        error: this.executor.executor.lastError,
        coordinator: this.store.get('SELECT epoch,coordinator_expires_at FROM web_scheduler_state'),
        operations: this.store.all(
          'SELECT id,status,deadline_at,quota_state FROM web_operations ORDER BY admission_seq',
        ),
        attempts: this.store.all(
          'SELECT phase,state,outcome,held_micros FROM web_provider_attempts ORDER BY operation_id,phase,ordinal',
        ),
        calls: this.store.all('SELECT * FROM cf_fixture_calls ORDER BY provider'),
        budgets: this.store.all(
          'SELECT provider,spent_micros,held_micros FROM web_provider_spending ORDER BY provider',
        ),
      });
    if (path === '/alarm-mode') {
      const { mode } = (await request.json()) as { mode: string };
      this.store.run(
        'INSERT INTO cf_fixture_alarm VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET mode=excluded.mode',
        mode,
      );
      return Response.json({ configured: true });
    }
    if (path === '/expire') {
      this.store.run(
        "UPDATE web_operations SET deadline_at=? WHERE status NOT IN ('published','cancelled','failed')",
        this.clock.now() - 1,
      );
      await this.executor.wake();
      return Response.json({ expired: true });
    }
    if (path === '/wake') {
      await this.executor.wake();
      return Response.json({ scheduled: true });
    }
    if (path === '/run') return new Response(null, { status: 404 });
    // Persist the wake before admission so a crash cannot strand a committed input.
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
    return env.STATE.get(env.STATE.idFromName('alarm')).fetch(request);
  },
};
