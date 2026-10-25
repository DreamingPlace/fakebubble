import { DeepSeekTextGenerator } from '../../../apps/server/generation/deepseek.ts';
import { WebProviderRunner } from '../../../apps/server/generation/web-provider-runner.ts';
import { readWebV7Request } from '../../../apps/server/generation/web-v7-request.ts';
import { syntheticTone } from '../../../apps/server/platform/web-local-fake.ts';
import { acceptedAuditEnvelope, draftEnvelope } from '../../text-fixtures.ts';
import { nextReviewArchiveExpiry } from '../../../apps/server/review/web-chat-review.ts';
import { fixtureClock } from './cloudflare-business-worker.ts';
import { WebSystemFixture } from './cloudflare-system-worker.ts';

export { PreviewBudgetFixture } from './cloudflare-http-worker.ts';
export { default } from './cloudflare-http-worker.ts';

/**
 * Part 22c: the all-switches real-HTTP fixture with the REAL reply pipeline (queue, runner, ledger, publisher) over a provider
 * whose answers the test picks: 'ok' = a reply, 'hold' = no answer yet, 'fail' = HTTP 402 from every model (a definite "not billed": the reply fails at
 * once), 'backup' = HTTP 429 from xAI only (the next model, DeepSeek, writes the reply). Module-level on purpose: the base
 * constructor builds the runner before any subclass field exists. The /fixture/stats/* routes read the counters and move the clock;
 * they never ship.
 */
const provider = { text: 'ok' as 'ok' | 'fail' | 'backup' | 'hold' };
/** 'hold': every text call waits here (a reply in flight) until /fixture/stats/provider {text:'release'}. */
const held: (() => void)[] = [];
const DAY = 86_400_000;

export class WebStatsFixture extends WebSystemFixture {
  protected override createRunner(
    audioMs = 250,
    beforeResult?: (provider: string, signal: AbortSignal) => Promise<void>,
  ) {
    const called = (name: string) =>
      this.store.run('INSERT INTO cf_fixture_calls VALUES (?,1) ON CONFLICT(provider) DO UPDATE SET n=n+1', name);
    const text = new DeepSeekTextGenerator({
      apiKey: 'offline-only',
      keys: { xai: 'offline-xai', gemini: 'offline-gemini' },
      fetch: async (url, init) => {
        called('text');
        const body = JSON.parse(String(init?.body));
        const which = String(url).includes('x.ai') ? 'xai' : String(url).includes('googleapis') ? 'gemini' : 'deepseek';
        await beforeResult?.('text', init!.signal!);
        if (provider.text === 'hold') await new Promise<void>((resolve) => held.push(resolve));
        if (provider.text === 'fail' || provider.text === 'hold')
          return new Response('{"error":"payment required"}', { status: 402 });
        if (provider.text === 'backup' && which === 'xai')
          return new Response('{"code":"Too Many Requests","error":"rate limit reached"}', { status: 429 });
        const current = this.store.get<{ id: string }>("SELECT id FROM web_operations WHERE status='text_running'")!;
        const { request } = readWebV7Request(this.store, current.id);
        const tool = body.tools[0].function.name;
        return Response.json(
          tool === 'submit_dialogue_draft' ? draftEnvelope(request) : acceptedAuditEnvelope(request),
        );
      },
    });
    return new WebProviderRunner(this.store, this.clock, text, async (wire, signal) => {
      called('speech');
      await beforeResult?.('speech', signal);
      return { audio: syntheticTone(audioMs), receipt: { offline: true }, usageUnits: wire.billedTextBytes };
    });
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/fixture/stats/')) return super.fetch(request);
    const input = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
    const store = this.store;
    if (path === '/fixture/stats/provider') {
      if (input.text === 'release') {
        provider.text = 'fail';
        for (const resolve of held.splice(0)) resolve();
      } else provider.text = input.text;
      return Response.json({ text: provider.text });
    }
    if (path === '/fixture/stats/clock') {
      // The UTC clock of the whole object moves forward (sessions made earlier stay valid for the days a test needs).
      fixtureClock.skewMs += input.days * DAY;
      store.run('UPDATE web_sessions SET absolute_expires_at=absolute_expires_at+?', input.days * DAY);
      store.run('UPDATE admin_sessions SET expires_at=expires_at+?', input.days * DAY);
      return Response.json({ now: this.clock.now() });
    }
    if (path === '/fixture/stats/counters')
      return Response.json(
        store.all(
          "SELECT day,metric,character_id characterId,model,value FROM web_stats_daily WHERE metric<>'stats_started' ORDER BY metric,day,character_id,model",
        ),
      );
    if (path === '/fixture/stats/markers')
      // What a leak would look like: the markers themselves (never returned by any real route).
      return Response.json({
        markers: store.all<{ marker: string }>('SELECT marker FROM web_daily_active').map((r) => r.marker),
        days: store.all(
          'SELECT day,kind,scope,count(*) n FROM web_daily_active GROUP BY day,kind,scope ORDER BY day,kind,scope',
        ),
      });
    if (path === '/fixture/stats/ledger')
      // The append-only points ledger as it is right now, per source and model (empty once a player has been purged).
      return Response.json(
        store.all(
          `SELECT e.source,coalesce(m.chosen,'') model,sum(abs(e.delta)) points FROM web_points_events e
          LEFT JOIN web_operation_models m ON m.operation_id=e.operation_id GROUP BY e.source,m.chosen ORDER BY e.source,m.chosen`,
        ),
      );
    if (path === '/fixture/stats/ops')
      return Response.json({
        operations: store.all(
          `SELECT o.status,o.character_id characterId,o.failure_code failureCode,coalesce(m.chosen,'') model FROM web_operations o
          LEFT JOIN web_operation_models m ON m.operation_id=o.id ORDER BY o.admission_seq`,
        ),
        attempts: store.all('SELECT phase,provider,state,outcome FROM web_provider_attempts ORDER BY rowid'),
      });
    // Part 22d: the extras tables as they are now, and what the retention alarm would wake for (null = idle).
    if (path === '/fixture/stats/extras')
      return Response.json({
        hourly: store.all(
          'SELECT hour,metric,character_id characterId,value FROM web_stats_hourly ORDER BY hour,metric,character_id',
        ),
        chatDays: store.all(
          'SELECT day,character_id characterId,count(*) n FROM web_chat_active GROUP BY day,character_id ORDER BY day,character_id',
        ),
        chatHours: store.all(
          'SELECT hour,character_id characterId,count(*) n FROM web_chat_active_hourly GROUP BY hour,character_id ORDER BY hour,character_id',
        ),
        userTypes: store.all(
          'SELECT user_type userType,count(*) n FROM web_operation_user_types GROUP BY user_type ORDER BY user_type',
        ),
        spend: store.all(
          'SELECT day,user_type userType,kind,calls,charged_micros chargedMicros FROM web_stats_spend ORDER BY day,user_type,kind',
        ),
        due: this.retention?.nextDue() ?? null,
        // Part 24b-1: where the wake comes from. The anonymous chat-review archive expires on its own clock (archived_at + 180 days).
        now: this.clock.now(),
        archive: store.get<{ n: number }>('SELECT count(*) n FROM web_review_archive')?.n ?? 0,
        archiveDue: nextReviewArchiveExpiry(store),
        archiveArchivedAt:
          store.get<{ at: number | null }>('SELECT min(archived_at) at FROM web_review_archive')?.at ?? null,
      });
    // Part 24b-1: a new version of one price row (a different number from today), or - with `same` - a renewal at the same number.
    if (path === '/fixture/stats/price-version') {
      const last = store.get<Record<string, any>>(
        'SELECT * FROM web_provider_prices WHERE provider=? AND model=? AND phase=? ORDER BY version DESC LIMIT 1',
        input.provider,
        input.model,
        input.phase,
      )!;
      const from = this.clock.now();
      store.run(
        `INSERT INTO web_provider_prices(id,provider,model,phase,currency,unit,upper_micros_per_unit,valid_from,valid_until,version)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        `${last.id}-v${last.version + 1}`,
        last.provider,
        last.model,
        last.phase,
        last.currency,
        last.unit,
        input.same === true ? last.upper_micros_per_unit : last.upper_micros_per_unit + 1,
        from,
        from + 90 * DAY,
        last.version + 1,
      );
      return Response.json({ version: last.version + 1 });
    }
    if (path === '/fixture/stats/reopen') {
      // A reply still in flight when its player is purged: the row of a finished one, put back to queued and reserved.
      store.run("UPDATE web_operations SET status='queued',quota_state='reserved' WHERE id=?", input.operationId);
      return Response.json({ reopened: true });
    }
    if (path === '/fixture/stats/state')
      return Response.json({
        usage: store.all(
          'SELECT day,provider,model,phase,calls,cost_micros costMicros,ledger_charged_micros ledgerMicros,replies FROM web_provider_usage ORDER BY day,provider,model,phase',
        ),
        attemptsCharged: store.get<{ n: number }>(
          'SELECT coalesce(sum(charged_micros),0) n FROM web_provider_attempts',
        )!.n,
      });
    return new Response(null, { status: 404 });
  }
}
