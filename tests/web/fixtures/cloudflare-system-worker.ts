import type { WebSystemOps } from '../../../apps/server/admin/web-system-admin.ts';
import type { WebBudgetStatusRPC, WebBudgetTopUpRPC } from '../../../apps/server/cloudflare/web-budget-client.ts';
import { renewProviderPrices } from '../../../apps/server/generation/web-provider-configuration.ts';
import { expectedWebMigrations } from '../../../workers/web-cloudflare/migrations.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebCloudRetention, inMemoryRetention } from '../../../apps/server/cloudflare/web-retention.ts';
import { WebCrossPathFixture } from './cloudflare-cross-path-worker.ts';

type Namespace = {
  idFromName(name: string): { toString(): string };
  get(id: unknown): WebBudgetStatusRPC & WebBudgetTopUpRPC;
};

// Part 22b: the all-switches real-HTTP fixture with the console's system pages wired to the REAL budget Worker object
// (PreviewBudgetFixture is a WebBudgetObject holding two capped USD 3 grants) and the same price renewal the operator runs.
// /fixture/system/* routes set the facts only a real clock or deployment would: spend, UNKNOWN calls, an expiring price. They never ship.
export class WebSystemFixture extends WebCrossPathFixture {
  // A real WebCloudRetention over an in-memory ledger: /fixture/system/retention-fail writes failures into it like a failing sweep.
  private readonly ledger = inMemoryRetention();
  private readonly healthSource = new WebCloudRetention(this.store, this.clock, 0, undefined, this.ledger);
  private readonly budget: (WebBudgetStatusRPC & WebBudgetTopUpRPC) | undefined;
  constructor(
    ctx: { storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void },
    env: { MEDIA: PrivateBucket; PREVIEW_BUDGET?: Namespace },
  ) {
    super(ctx, env);
    this.budget = env.PREVIEW_BUDGET?.get(env.PREVIEW_BUDGET.idFromName('budget'));
  }
  protected override systemOps(): WebSystemOps {
    const budget = this.budget!;
    return {
      flags: () => ({
        signupBonus: this.store.publicFreeTier === true,
        playerModelChoice: this.store.playerModelChoice !== undefined,
        playerTextModels: this.store.playerModelChoice ? [...this.store.playerModelChoice] : null,
        fishVoiceModel: 's2.1-pro',
        chatReview: false,
        turnstile: this.human !== undefined,
        alerts: false,
        alertMailBindingPresent: false,
        alertRecipientSet: false,
      }),
      // This fixture authority applies the R2 list (a media bucket is bound).
      migrations: () => ({ active: 'r2', ...expectedWebMigrations() }),
      budget: () => budget.summary(),
      retention: () => this.healthSource.health(),
      renewPrices: () => renewProviderPrices(this.store, this.clock.now()),
      topUp: (requestId, provider, micros) => budget.topUp(requestId, provider, micros),
    };
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/fixture/system/')) return super.fetch(request);
    const input = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
    const store = this.store;
    if (path === '/fixture/system/prices') {
      // Every price row of the database as it is: provider, model, phase, unit, number, version, window.
      return Response.json(
        store.all(
          'SELECT provider,model,phase,unit,upper_micros_per_unit upper,version,valid_from validFrom,valid_until validUntil FROM web_provider_prices ORDER BY provider,model,phase,version',
        ),
      );
    }
    if (path === '/fixture/system/operator-renew') {
      // What `renew-prices` runs in the operator Worker: WebCloudSetup.renewPrices() is renewProviderPrices(store, now) behind a ready() check.
      return Response.json(renewProviderPrices(store, this.clock.now()));
    }
    if (path === '/fixture/system/retention-fail') {
      const ledger = await this.ledger.load();
      ledger.failures[input.principalId as string] = [input.count, this.clock.now(), input.detail];
      await this.ledger.save(ledger);
      return Response.json({ saved: true });
    }
    if (path === '/fixture/system/budget') return Response.json(await this.budget!.summary());
    if (path === '/fixture/system/local-limits')
      return Response.json(
        store.all('SELECT provider,limit_micros limitMicros FROM web_provider_spending ORDER BY provider'),
      );
    if (path === '/fixture/system/events') {
      const id = input.principalId as string;
      return Response.json(
        store.all('SELECT source,delta,admin_id adminId FROM web_points_events WHERE principal_id=? ORDER BY id', id),
      );
    }
    if (path === '/fixture/system/balance')
      return Response.json({
        balance:
          store.get<{ balance: number }>(
            'SELECT balance FROM web_points_balance WHERE principal_id=?',
            input.principalId,
          )?.balance ?? null,
      });
    if (path === '/fixture/system/set-balance') {
      // A level the real flow reaches through spending or earlier grants.
      store.run('UPDATE web_points_balance SET balance=? WHERE principal_id=?', input.balance, input.principalId);
      return Response.json({ set: true });
    }
    if (path === '/fixture/system/player-number') {
      const row = store.get<{ number: string }>(
        'SELECT number FROM web_player_numbers WHERE principal_id=?',
        input.principalId,
      );
      return Response.json({ number: row?.number ?? null });
    }
    if (path === '/fixture/system/audit')
      return Response.json(
        store.all('SELECT actor_id actorId,action,target_id targetId FROM web_admin_audit ORDER BY seq'),
      );
    if (path === '/fixture/system/unknown') {
      // An UNKNOWN provider attempt row as the ledger leaves one: counted by the page, never retried, never released.
      store.run(
        `UPDATE web_provider_attempts SET state='unknown',sent_at=?,settled_at=NULL,outcome=NULL,usage_units=NULL,charged_micros=NULL
        WHERE rowid=(SELECT rowid FROM web_provider_attempts LIMIT 1)`,
        this.clock.now() - 3 * 3_600_000,
      );
      return Response.json({
        n: store.get<{ n: number }>("SELECT count(*) n FROM web_provider_attempts WHERE state='unknown'")!.n,
      });
    }
    return new Response(null, { status: 404 });
  }
}
export { PreviewBudgetFixture } from './cloudflare-http-worker.ts';
export { default } from './cloudflare-http-worker.ts';
