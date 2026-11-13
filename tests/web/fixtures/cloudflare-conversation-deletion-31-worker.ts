import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { installWebOwnerOps } from '../../../apps/server/admin/web-owner-ops-schema.ts';
import {
  deleteLiveConversation,
  eraseDeletedConversationAudio,
  installWebConversationDeletion,
} from '../../../apps/server/characters/web-conversation-deletion.ts';
import { guardedTables } from '../../../apps/server/characters/web-character-deletion-schema.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { WebCharacterDeletionFixture } from './cloudflare-character-deletion-worker.ts';

/** Part 31: the owner's deletion of ONE live conversation, on the real Cloudflare store with R2. Never reachable through a deployable entry. */
export class WebConversationDeletion31Fixture extends WebCharacterDeletionFixture {
  constructor(ctx: { storage: DurableSQLStorage }, env: { MEDIA: PrivateBucket }) {
    super(ctx, env);
    installWebOwnerOps(this.store);
    installWebConversationDeletion(this.store);
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/conv/')) return super.fetch(request);
    try {
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
      let value: unknown;
      if (path === '/conv/delete') {
        const principal = this.store.get<{ world_id: string }>(
          'SELECT world_id FROM web_principals WHERE id=?',
          body.principalId,
        )!;
        const conversation = this.store.get<{ id: string }>(
          "SELECT id FROM conversations WHERE world_id=? AND kind='private' AND private_character_id=?",
          principal.world_id,
          body.characterId,
        )!;
        value = {
          messages: deleteLiveConversation(this.store, this.clock, {
            principalId: body.principalId,
            worldId: principal.world_id,
            conversationId: conversation.id,
            characterId: body.characterId,
          }),
        };
      } else if (path === '/conv/sweep')
        value = { erased: await eraseDeletedConversationAudio(this.store, this.clock) };
      else if (path === '/conv/state')
        value = {
          gates: this.store.all('SELECT * FROM web_conversation_purge_gate'),
          deletions: this.store.all('SELECT audio_cleared_at IS NOT NULL done FROM web_conversation_deletions'),
          fk: this.store.all('PRAGMA foreign_key_check'),
          triggers: this.store
            .all<{ name: string; sql: string }>(
              `SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name IN (${guardedTables.map(() => '?').join(',')})`,
              ...guardedTables.map((entry) => entry[1]),
            )
            .map((t) => ({ name: t.name, widened: t.sql.includes('web_conversation_purge_gate') })),
          operations: this.store.all(
            'SELECT status,quota_state,input_message_id IS NULL scrubbed FROM web_operations ORDER BY id',
          ),
        };
      else return new Response(null, { status: 404 });
      return Response.json(value);
    } catch (error) {
      return Response.json({ error: error instanceof DomainError ? error.code : String(error) }, { status: 409 });
    }
  }
}
export { default } from './cloudflare-business-worker.ts';
