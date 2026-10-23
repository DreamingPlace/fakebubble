import { WebCharacterDeletionFixture } from './cloudflare-character-deletion-worker.ts';

/** Part 22c: the character-deletion fixture plus a read of the statistics counters (a test route; it never ships). */
export class WebStatsDeletionFixture extends WebCharacterDeletionFixture {
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== '/stats/counters') return super.fetch(request);
    return Response.json(
      this.store.all(
        "SELECT day,metric,character_id characterId,model,value FROM web_stats_daily WHERE metric<>'stats_started' ORDER BY metric,day,character_id,model",
      ),
    );
  }
}
export { default } from './cloudflare-business-worker.ts';
