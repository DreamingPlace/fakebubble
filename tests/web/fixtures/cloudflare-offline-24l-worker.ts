import { WebCharacterDeletion24gFixture } from './cloudflare-character-deletion-24g-worker.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { PrivateBucket } from '../../../apps/server/cloudflare/media-objects.ts';
import { lockedCharacterIds } from '../../../apps/server/admission/web-guest-lock.ts';
import {
  installWebAvailability,
  setWebCharacterAvailability,
} from '../../../apps/server/characters/web-character-availability.ts';
import { characterProfileHash, publishedWebCharacters } from '../../../apps/server/characters/web-character-catalog.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

/** Part 24l test operators: 下线 / 重新上线 as the owner, what survives, the guest lock, an in-flight operation. Never deployable. */
export class WebOffline24lFixture extends WebCharacterDeletion24gFixture {
  private readonly owner: { memberId: string };
  constructor(ctx: { storage: DurableSQLStorage }, env: { MEDIA: PrivateBucket }) {
    super(ctx, env);
    installWebAvailability(this.store);
    this.owner = this.store.get<{ memberId: string }>(
      'SELECT member_id memberId FROM web_admin_session_members LIMIT 1',
    )!;
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/offline/')) return super.fetch(request);
    try {
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
      let value: unknown;
      if (path === '/offline/set')
        value = setWebCharacterAvailability(
          this.store,
          this.clock.now(),
          this.owner,
          body.characterId,
          body.action,
          body.input,
        );
      else if (path === '/offline/state')
        value = {
          catalog: publishedWebCharacters(this.store).map((c) => [c.characterId, c.position, c.version]),
          templates: this.store.all('SELECT id,version FROM character_templates ORDER BY id'),
          versions: this.store.get<{ n: number }>('SELECT count(*) n FROM web_character_versions')!.n,
          bindings: this.store.get<{ n: number }>('SELECT count(*) n FROM web_provider_voice_bindings')!.n,
          audit: this.store.all<{ action: string; target_id: string }>(
            "SELECT action,target_id FROM web_admin_audit WHERE action LIKE 'character-o%' ORDER BY seq",
          ),
          requests: this.store.get<{ n: number }>('SELECT count(*) n FROM web_availability_requests')!.n,
          conversations: this.store.all(
            "SELECT private_character_id id FROM conversations WHERE kind='private' ORDER BY id",
          ),
          messages: this.store.get<{ n: number }>('SELECT count(*) n FROM messages')!.n,
        };
      else if (path === '/offline/lock') {
        Object.assign(this.store, { guestOneCharacter: body.on !== false });
        value = lockedCharacterIds(this.store, body.principalId, this.clock.now());
      } else if (path === '/offline/untrial') {
        // Test operator: the legacy counted-trial lock (trial_character_id, TRIAL_CHARACTER_LOCKED) is a different rule from the
        // Part 26a guest lock; this stands for a guest that is not on the counted trial, so only the 26a lock is under test.
        this.store.run('UPDATE web_principals SET trial_character_id=NULL WHERE id=?', body.principalId);
        value = { cleared: true };
      } else if (path === '/offline/inflight') {
        // The operation is left exactly as admitted (status 'accepted' or later, never published): it is in flight.
        value = this.store.all(
          'SELECT status FROM web_operations WHERE character_id=? ORDER BY created_at',
          body.characterId,
        );
      } else if (path === '/offline/fill') {
        // Fill every free slot with a throwaway but internally consistent catalog row, so a 重新上线 finds none free.
        const base = publishedWebCharacters(this.store)[0]!;
        const free = Array.from({ length: 15 }, (_, i) => i).filter(
          (i) => !this.store.get('SELECT 1 FROM web_character_catalog WHERE position=?', i),
        );
        for (const position of free) {
          const profile = structuredClone({ template: base.template, presentation: base.presentation });
          profile.template.id = `filler-${position}`;
          this.store.run(
            'INSERT INTO character_templates VALUES (?,?,?)',
            profile.template.id,
            profile.template.version,
            JSON.stringify(profile.template),
          );
          this.store.run(
            'INSERT INTO web_character_versions VALUES (?,?,?,?,NULL)',
            profile.template.id,
            profile.template.version,
            JSON.stringify(profile),
            characterProfileHash(profile),
          );
          this.store.run(
            'INSERT INTO web_character_catalog VALUES (?,?,?)',
            profile.template.id,
            profile.template.version,
            position,
          );
        }
        value = { filled: free.length };
      } else if (path === '/offline/force') {
        // Test operator only: take the catalog row away without the guarded action (an offline character with work in flight).
        this.store.run('DELETE FROM web_character_catalog WHERE character_id=?', body.characterId);
        value = { forced: true };
      } else return new Response(null, { status: 404 });
      return Response.json(value);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof DomainError ? error.code : String(error),
          detail: (error as { detail?: unknown }).detail,
        },
        { status: 409 },
      );
    }
  }
}
export { default } from './cloudflare-business-worker.ts';
