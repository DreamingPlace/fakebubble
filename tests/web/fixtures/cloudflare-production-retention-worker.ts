import { WebBusinessObject as ProductionObject, type WebBusinessEnvironment } from '../../../workers/web-cloudflare/business.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import { WebDurableStore } from '../../../apps/server/cloudflare/web-store.ts';
import { PrivateMediaObjects } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebCloudRetention } from '../../../apps/server/cloudflare/web-retention.ts';
import { webR2Migrations } from '../../../workers/web-cloudflare/migrations.ts';
export { WebOperatorService } from '../../../workers/web-cloudflare/business.ts';
type Context = { id: { toString(): string }; storage: DurableSQLStorage & AlarmStorage; waitUntil(task: Promise<void>): void };

/** Only the local test graph exports this inspector; the production class/Alarm are inherited unchanged. */
export class WebBusinessObject extends ProductionObject {
  private readonly inspectStorage: Context['storage'];
  private readonly inspectRetention: WebCloudRetention;
  constructor(ctx: Context, env: WebBusinessEnvironment) {
    super(ctx,env); this.inspectStorage=ctx.storage;
    const store=new WebDurableStore(ctx.storage,webR2Migrations,{ instanceId:env.INSTANCE_ID,recoveryEpoch:env.RECOVERY_EPOCH,
      keys:{ ipKey:Buffer.from(env.IP_KEY,'base64url'),requestKey:Buffer.from(env.REQUEST_KEY,'base64url') },
      providerAudio:new PrivateMediaObjects(env.MEDIA) });
    this.inspectRetention=new WebCloudRetention(store,{ now:()=>Date.now() });
  }
  async fetch(request: Request) {
    const path=new URL(request.url).pathname, sql=this.inspectStorage.sql;
    if (path==='/__test/diagnose') {
      try {
        const row=sql.exec("SELECT principal_id FROM web_guest_retention WHERE state='purging' LIMIT 1").toArray()[0]!;
        this.inspectRetention.clearDatabase(row.principal_id as string);
        await this.inspectRetention.eraseAudio(row.principal_id as string);
        return Response.json({ cleared:true });
      } catch (error) { return Response.json({ error:String(error),stack:error instanceof Error?error.stack:null,
        platformTables:sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name GLOB '_cf*'").toArray() }); }
    }
    if (path==='/__test/expire') {
      sql.exec("UPDATE web_guest_retention SET started_at=?,expires_at=? WHERE state='active'",Date.now()-2,Date.now()-1);
      await this.inspectStorage.setAlarm(Date.now()+1000);
      return Response.json({ scheduled:true });
    }
    if (path==='/__test/spending') {
      // Prove the real production SQL/runner passes USD3 without making paid requests.
      sql.exec('UPDATE web_provider_spending SET spent_micros=4000000');
      return Response.json(sql.exec('SELECT provider,limit_micros,spent_micros,held_micros FROM web_provider_spending').toArray());
    }
    if (path==='/__test/state') return Response.json({
      alarm:await this.inspectStorage.getAlarm(),
      retention:sql.exec('SELECT state,expires_at,db_cleared_at FROM web_guest_retention').toArray(),
      messages:sql.exec('SELECT count(*) n FROM messages').toArray()[0]!.n,
      outputs:sql.exec('SELECT count(*) n FROM web_provider_outputs').toArray()[0]!.n,
      pendingObjects:sql.exec('SELECT count(*) n FROM cf_web_audio_objects WHERE erased_at IS NULL').toArray()[0]!.n,
      operations:sql.exec('SELECT status FROM web_operations').toArray(),
      spending:sql.exec('SELECT provider,limit_micros,spent_micros,held_micros FROM web_provider_spending').toArray(),
    });
    return super.fetch(request);
  }
}
export default { fetch(request:Request,env:WebBusinessEnvironment & { BUSINESS:{ idFromString(id:string):unknown;
  get(id:unknown):{ fetch(request:Request):Promise<Response> } } }) {
  if (!new URL(request.url).pathname.startsWith('/__test/')) return new Response(null,{ status:404 });
  return env.BUSINESS.get(env.BUSINESS.idFromString(env.BUSINESS_OBJECT_ID)).fetch(request);
} };
