import { WebRetentionFixture } from './cloudflare-retention-worker.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { WebAccountAdmin } from '../../../apps/server/web-account-admin.ts';
import { installWebCharacterCatalog } from '../../../apps/server/web-character-catalog.ts';
import { installWebCharacterDeletion } from '../../../apps/server/web-character-deletion-schema.ts';
import { WebCharacterDeletion } from '../../../apps/server/web-character-deletion.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/** Offline operators for destructive/racing tests; never reachable through a deployable entry. */
export class WebCharacterDeletionFixture extends WebRetentionFixture {
  private readonly deletion: WebCharacterDeletion;
  private readonly actor: { memberId: string; sessionId: string };
  constructor(ctx: { storage: DurableSQLStorage }, env: { MEDIA: PrivateBucket }) {
    super(ctx, env);
    const accounts = new WebAccountAdmin(this.store, this.clock, 'https://fixture.invalid');
    installWebCharacterCatalog(this.store); installWebCharacterDeletion(this.store);
    this.deletion = new WebCharacterDeletion(this.store, this.clock);
    let actor = this.store.get<{ memberId: string; sessionId: string }>(
      'SELECT member_id memberId,session_id sessionId FROM web_admin_session_members LIMIT 1');
    if (!actor) {
      const login = accounts.login(accounts.issueLoginGrant().token, 'https://fixture.invalid');
      actor = accounts.authorize(login.cookie, login.csrf, 'https://fixture.invalid');
    }
    this.actor = actor;
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/deletion/')) return super.fetch(request);
    try {
      const body = request.method === 'POST' ? await request.json() as Record<string, any> : {};
      const id = body.characterId ?? 'wei-guagua';
      let value: unknown;
      if (path === '/deletion/preview') value = this.deletion.preview(id);
      else if (path === '/deletion/start') value = this.deletion.start(this.actor, id, body.input);
      else if (path === '/deletion/sweep') { await this.deletion.sweep(); value = this.deletion.status(id); }
      else if (path === '/deletion/status') value = this.deletion.status(id);
      else if (path === '/deletion/unknown') {
        this.store.all('CREATE TABLE IF NOT EXISTS cf_deletion_unknown(world_id TEXT,conversation_id TEXT,body TEXT)');
        if (body.clear) this.store.run('DELETE FROM cf_deletion_unknown');
        else this.store.run(`INSERT INTO cf_deletion_unknown SELECT world_id,conversation_id,'unexpected private content'
          FROM web_operations WHERE principal_id=? AND character_id=? LIMIT 1`, body.principalId,id);
        value = { changed: true };
      } else if (path === '/deletion/state') value = {
        scopes: this.store.all('SELECT * FROM web_character_deletion_scopes ORDER BY world_id,conversation_id'),
        gates: this.store.all('SELECT * FROM web_character_purge_gate'),
        catalog: this.store.all('SELECT character_id FROM web_character_catalog ORDER BY position'),
        fk: this.store.all('PRAGMA foreign_key_check'),
        external: this.store.all(`SELECT dispatch_state,receipt_json,usage_json,receipt_digest,usage_digest FROM web_external_attempts
          WHERE operation_id IN (SELECT id FROM web_operations WHERE principal_id=? AND character_id=?)`,body.principalId,id),
      };
      else return new Response(null, { status: 404 });
      return Response.json(value);
    } catch (error) { return Response.json({ error: error instanceof DomainError ? error.code : String(error) }, { status: 409 }); }
  }
}
export { default } from './cloudflare-business-worker.ts';
