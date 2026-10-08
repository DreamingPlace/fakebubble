import type { WebBusinessEnvironment } from '../../../workers/web-cloudflare/business.ts';
import { webR2Migrations } from '../../../workers/web-cloudflare/migrations.ts';
import type { WebProviderApplication } from '../../../apps/server/generation/web-provider-application.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { AlarmStorage } from '../../../apps/server/cloudflare/queue-alarm.ts';
import { WebBusinessObject as RetentionObject } from './cloudflare-production-retention-worker.ts';
export { WebOperatorService } from '../../../workers/web-cloudflare/business.ts';
export { default } from './cloudflare-production-retention-worker.ts';
type Context = {
  id: { toString(): string };
  storage: DurableSQLStorage & AlarmStorage;
  waitUntil(task: Promise<void>): void;
};
type Environment = WebBusinessEnvironment & { LEGACY_113?: string };

const guardedTriggers = [
  'web_input_snapshots_no_delete',
  'web_v7_requests_no_delete',
  'web_v7_candidates_no_delete',
  'web_publications_no_delete',
  'web_publication_items_no_delete',
  'web_local_text_outputs_no_delete',
  'web_local_audio_outputs_no_delete',
  'web_provider_outputs_no_delete',
  'web_provider_candidates_no_delete',
  'web_provider_media_no_delete',
];
/** The steps a database that production left at schema 113 does not have. */
const newer = new Set(webR2Migrations.filter((m) => m.version > 113).map((m) => m.sql));

/**
 * Test-only graph. With LEGACY_113=true this object behaves like the code that ran before migrations 114-116 existed:
 * those steps are not applied and the ledger stops at 113, so the real application (and its deletion schema) installs on
 * a genuine 113 database. Without it the production object runs unchanged and applies 114-116 on the next start.
 */
export class WebBusinessObject extends RetentionObject {
  private readonly upgradeStorage: Context['storage'];
  constructor(ctx: Context, env: Environment) {
    const sql = ctx.storage.sql,
      exec = sql.exec.bind(sql);
    if (env.LEGACY_113 === 'true')
      Object.defineProperty(sql, 'exec', {
        configurable: true,
        value: (query: string, ...bindings: unknown[]) =>
          (exec as (q: string, ...b: unknown[]) => unknown)(newer.has(query) ? 'SELECT 1' : query, ...bindings),
      });
    super(ctx, env);
    this.upgradeStorage = ctx.storage;
    if (env.LEGACY_113 === 'true') exec('DELETE FROM cf_web_migrations WHERE version>113');
  }
  async fetch(request: Request) {
    const url = new URL(request.url),
      sql = this.upgradeStorage.sql;
    const rows = (query: string, ...bindings: (string | number)[]) => sql.exec(query, ...bindings).toArray();
    if (url.pathname === '/__test/upgrade-state') {
      const guarded = rows(
        `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${guardedTriggers.map(() => '?').join(',')}) ORDER BY name`,
        ...guardedTriggers,
      );
      return Response.json({
        version: rows('SELECT max(version) v FROM cf_web_migrations')[0]!.v,
        triggers: guarded,
        schema: rows('SELECT type,name,sql FROM sqlite_master ORDER BY type,name'),
        deletionSchema: rows('SELECT * FROM web_character_deletion_schema'),
        items: rows('SELECT operation_id,ordinal,origin FROM web_publication_items ORDER BY operation_id,ordinal'),
        attempts: rows(
          'SELECT operation_id,phase,ordinal,state,held_micros,charged_micros,settled_at FROM web_provider_attempts ORDER BY operation_id,phase,ordinal',
        ),
        spending: rows('SELECT * FROM web_provider_spending ORDER BY provider'),
      });
    }
    if (url.pathname === '/__test/seed-unknown-speech') {
      // The same rows a lost response leaves: the attempt is UNKNOWN and its reservation is held again.
      const operation = url.searchParams.get('operation')!;
      const a = rows(
        "SELECT provider,held_micros,charged_micros FROM web_provider_attempts WHERE operation_id=? AND phase='speech' ORDER BY ordinal LIMIT 1",
        operation,
      )[0]!;
      sql.exec(
        `UPDATE web_provider_attempts SET state='unknown',settled_at=NULL,outcome=NULL,usage_units=NULL,charged_micros=NULL
        WHERE rowid=(SELECT rowid FROM web_provider_attempts WHERE operation_id=? AND phase='speech' ORDER BY ordinal LIMIT 1)`,
        operation,
      );
      sql.exec(
        'UPDATE web_provider_spending SET held_micros=held_micros+?,spent_micros=spent_micros-? WHERE provider=?',
        a.held_micros as number,
        a.charged_micros as number,
        a.provider as string,
      );
      return Response.json({ seeded: true });
    }
    if (url.pathname === '/__test/expire-character') {
      const now = Date.now();
      sql.exec(
        `UPDATE web_guest_retention SET started_at=?,expires_at=? WHERE state='active' AND principal_id IN
        (SELECT principal_id FROM web_operations WHERE character_id=?)`,
        now - 2,
        now - 1,
        url.searchParams.get('character')!,
      );
      await this.upgradeStorage.setAlarm(now + 500);
      return Response.json({ scheduled: true });
    }
    if (url.pathname === '/__test/delete-character') {
      const app = (this as unknown as { application(): WebProviderApplication }).application();
      const origin = 'https://fixture.invalid',
        id = url.searchParams.get('character')!;
      const login = app.inviteAdmin.login(app.inviteAdmin.issueLoginGrant().token, origin);
      const actor = app.inviteAdmin.authorize(login.cookie, login.csrf, origin);
      const preview = app.characterDeletion.preview(id);
      app.characterDeletion.start(actor, id, {
        requestId: crypto.randomUUID(),
        previewHash: preview.previewHash,
        acknowledgeDeleteAllChats: true,
      });
      await app.characterDeletion.sweep();
      return Response.json(app.characterDeletion.status(id));
    }
    return super.fetch(request);
  }
}
