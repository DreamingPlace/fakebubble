import { createHash } from 'node:crypto';
import { WebBusinessFixture } from './cloudflare-business-worker.ts';
import { WebCloudRetention } from '../../../apps/server/cloudflare/web-retention.ts';
import { WebProviderOffline } from '../../../apps/server/web-provider-offline.ts';
import type { DurableSQLStorage } from '../../../apps/server/cloudflare/store.ts';
import type { PrivateBucket, MediaObjectReference } from '../../../apps/server/cloudflare/media-objects.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { syntheticTone } from '../../../apps/server/web-local-fake.ts';

/** Test-only fault injection around actual R2 operations. Never a production entrypoint. */
export class WebRetentionFixture extends WebBusinessFixture {
  private readonly cleaner: WebCloudRetention;
  private readonly rawBucket: PrivateBucket;
  private readonly control: { mode: string; waiting: boolean; release?: () => void };
  private replay: (() => unknown) | undefined;
  constructor(ctx: { storage: DurableSQLStorage }, env: { MEDIA: PrivateBucket }) {
    const control: WebRetentionFixture['control'] = { mode: '', waiting: false };
    const hold = async () => {
      control.waiting = true;
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
      control.waiting = false;
    };
    super(ctx, {
      MEDIA: {
        get: (key) => env.MEDIA.get(key),
        put: async (key, bytes, options) => {
          if (!bytes.length && control.mode === 'erase-fail') throw new DomainError('OFFLINE_ERASE_FAILED');
          const mode = control.mode;
          if (bytes.length && mode === 'put-before') {
            control.mode = '';
            await hold();
          }
          const result = await env.MEDIA.put(key, bytes, options);
          if (bytes.length && mode === 'put-after') {
            control.mode = '';
            await hold();
          }
          return result;
        },
      },
    });
    this.control = control;
    this.rawBucket = env.MEDIA;
    this.cleaner = new WebCloudRetention(this.store, this.clock);
  }
  protected createRunner(audioMs = 250) {
    return super.createRunner(audioMs, async (provider) => {
      if (provider === 'speech' && this.control.mode === 'unknown') throw new DomainError('OFFLINE_UNKNOWN');
      if (provider === 'text' && this.control.mode === 'text-late') {
        this.control.mode = '';
        this.control.waiting = true;
        await new Promise<void>((resolve) => {
          this.control.release = resolve;
        });
        this.control.waiting = false;
      }
    });
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/retention/')) return super.fetch(request);
    try {
      const input =
        request.method === 'POST'
          ? ((await request.json()) as { principalId: string; mode?: string })
          : { principalId: '' };
      const principal = this.store.get<{ world_id: string }>(
        'SELECT world_id FROM web_principals WHERE id=?',
        input.principalId,
      );
      let value: unknown;
      if (path === '/retention/expire') {
        this.store.run(
          "UPDATE web_guest_retention SET started_at=?,expires_at=? WHERE principal_id=? AND state='active'",
          this.clock.now() - 2,
          this.clock.now() - 1,
          input.principalId,
        );
        value = { expired: true };
      } else if (path === '/retention/sweep')
        value = { ...(await this.cleaner.sweep()), error: this.cleaner.lastError };
      else if (path === '/retention/mode') {
        this.control.mode = input.mode!;
        value = { configured: true };
      } else if (path === '/retention/waiting') value = this.control.waiting;
      else if (path === '/retention/release') {
        this.control.release?.();
        value = { released: true };
      } else if (path === '/retention/unsafe-delete') {
        this.store.run(
          'DELETE FROM web_provider_outputs WHERE operation_id IN (SELECT id FROM web_operations WHERE principal_id=?)',
          input.principalId,
        );
        value = { deleted: true };
      } else if (path === '/retention/unknown-table') {
        this.store.run('CREATE TABLE IF NOT EXISTS cf_fixture_unknown(world_id TEXT,body TEXT)');
        if (input.mode === 'clear')
          this.store.run('DELETE FROM cf_fixture_unknown WHERE world_id=?', principal!.world_id);
        else
          this.store.run("INSERT INTO cf_fixture_unknown VALUES (?,'unexpected private content')", principal!.world_id);
        value = { changed: true };
      } else if (path === '/retention/capture-replay') {
        const row = this.store.get<any>(
          `SELECT a.*,o.spoken_text,o.audio_ref_json FROM web_provider_attempts a
          JOIN web_provider_outputs o USING(operation_id,phase,ordinal) WHERE a.principal_id=? AND a.phase='speech' LIMIT 1`,
          input.principalId,
        )!;
        const key = { operationId: row.operation_id, phase: 'speech' as const, ordinal: row.ordinal };
        const scope = {
          principalId: row.principal_id,
          playerId: row.player_id,
          worldId: row.world_id,
          conversationId: row.conversation_id,
          characterId: row.character_id,
          inputMessageId: row.input_message_id,
        };
        const result = {
          outcome: 'succeeded' as const,
          receipt: JSON.parse(row.receipt_json),
          usageUnits: row.usage_units,
          output: syntheticTone(),
          spokenText: row.spoken_text,
          audioReference: JSON.parse(row.audio_ref_json),
        };
        this.replay = () => {
          const ledger = new WebProviderOffline(this.store, this.clock);
          const same = ledger.confirm(key, scope, result);
          let conflict: string | null = null;
          try {
            ledger.confirm(key, scope, { ...result, spokenText: result.spokenText + 'changed' });
          } catch (error) {
            conflict = error instanceof DomainError ? error.code : String(error);
          }
          return { same, conflict };
        };
        value = { captured: true };
      } else if (path === '/retention/replay') value = this.replay!();
      else if (path === '/retention/state') {
        const objects = [];
        for (const row of this.store.all<{ reference_json: string; erased_at: number | null }>(
          'SELECT * FROM cf_web_audio_objects WHERE principal_id=? ORDER BY operation_id,ordinal',
          input.principalId,
        )) {
          const ref = JSON.parse(row.reference_json) as MediaObjectReference;
          const key = `private/v1/${ref.kind}/${createHash('sha256')
            .update(JSON.stringify([ref.instanceId, ref.ownerId, ref.mediaId]))
            .digest('hex')}`;
          const object = await this.rawBucket.get(key);
          const bytes = object ? new Uint8Array(await object.arrayBuffer()) : null;
          objects.push({
            erased: row.erased_at !== null,
            size: bytes?.length ?? null,
            type: object?.httpMetadata.contentType ?? null,
          });
        }
        value = {
          retention: this.store.get(
            'SELECT state,db_cleared_at FROM web_guest_retention WHERE principal_id=?',
            input.principalId,
          ),
          messages: this.store.get<{ n: number }>(
            'SELECT count(*) n FROM messages WHERE world_id=?',
            principal!.world_id,
          )!.n,
          outputs: this.store.get<{ n: number }>(
            `SELECT count(*) n FROM web_provider_outputs WHERE operation_id IN
            (SELECT id FROM web_operations WHERE principal_id=?)`,
            input.principalId,
          )!.n,
          attempts: this.store.all(
            'SELECT phase,state,outcome,charged_micros FROM web_provider_attempts WHERE principal_id=? ORDER BY phase,ordinal',
            input.principalId,
          ),
          operations: this.store.all(
            'SELECT status,quota_state FROM web_operations WHERE principal_id=?',
            input.principalId,
          ),
          objects,
          due: this.cleaner.nextDue(),
        };
      } else return new Response(null, { status: 404 });
      return Response.json(value);
    } catch (error) {
      return Response.json({ error: error instanceof DomainError ? error.code : String(error) }, { status: 409 });
    }
  }
}
export { default } from './cloudflare-business-worker.ts';
