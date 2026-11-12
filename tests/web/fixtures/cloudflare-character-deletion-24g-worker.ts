import { WebCharacterDeletionFixture } from './cloudflare-character-deletion-worker.ts';
import { playerBilling } from '../../../apps/server/admission/web-billing.ts';
import { accountLedgerColumns } from '../../../apps/server/characters/web-character-deletion-audit.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const ledgers = Object.keys(accountLedgerColumns);
/** Part 24g test operators: seed the six account-level ledgers, read them back, hold a retention gate, change a schema. */
export class WebCharacterDeletion24gFixture extends WebCharacterDeletionFixture {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/ledger/')) return super.fetch(request);
    try {
      const body = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
      const now = this.clock.now();
      let value: unknown;
      if (path === '/ledger/seed') {
        const op = this.store.get<{ id: string; world_id: string }>(
          'SELECT id,world_id FROM web_operations WHERE principal_id=? ORDER BY created_at LIMIT 1',
          body.principalId,
        )!;
        const rows: Record<string, () => void> = {
          player_profile_versions: () =>
            this.store.run(
              'INSERT INTO player_profile_versions VALUES (?,1,\'{"nickname":"小明"}\',?)',
              op.world_id,
              now,
            ),
          player_profile_requests: () =>
            this.store.run("INSERT INTO player_profile_requests VALUES (?,'req-24g','hash-24g',1)", op.world_id),
          web_free_operations: () =>
            this.store.run("INSERT INTO web_free_operations VALUES (?,?,'bonus',NULL)", op.id, body.principalId),
          web_points_events: () =>
            this.store.run(
              `INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at)
              VALUES (?,?,'spend','reply',-3,1,?)`,
              body.principalId,
              op.id,
              now,
            ),
          web_operation_models: () =>
            this.store.run(
              "INSERT INTO web_operation_models VALUES (?,'deepseek',?,3,1,1,'deepseek','m-draft','deepseek','m-review',1,?)",
              op.id,
              body.voice === 1 ? 1 : 0, // Part 27: a real operation orders the voice (1); the older seeds keep 0
              now,
            ),
          web_provider_backups: () =>
            this.store.run(
              "INSERT INTO web_provider_backups VALUES (?,'draft',0,'gemini','m-backup','HTTP_429',7,?)",
              op.id,
              now,
            ),
        };
        // A signed-up player: the bonus row makes the principal a points account (principal id only; no scoped column).
        this.store.run('INSERT OR IGNORE INTO web_signup_bonus VALUES (?,?)', body.principalId, now);
        // A request row needs its version (foreign key); the others stand alone.
        const wanted: string[] = body.tables ?? ledgers;
        if (wanted.includes('player_profile_requests') && !wanted.includes('player_profile_versions'))
          rows.player_profile_versions!();
        for (const table of ledgers) if (wanted.includes(table)) rows[table]!();
        value = { operationId: op.id, worldId: op.world_id };
      } else if (path === '/ledger/snapshot')
        value = Object.fromEntries(ledgers.map((t) => [t, this.store.all(`SELECT * FROM ${t} ORDER BY rowid`)]));
      else if (path === '/ledger/gate') {
        const world = this.store.get<{ world_id: string }>(
          'SELECT world_id FROM web_principals WHERE id=?',
          body.principalId,
        )!;
        if (body.on)
          this.store.run('INSERT INTO web_retention_purge_gate VALUES (?,?,1)', body.principalId, world.world_id);
        else this.store.run('DELETE FROM web_retention_purge_gate');
        value = { on: !!body.on };
      } else if (path === '/ledger/alter') {
        ledgers.includes(body.table) ||
          (() => {
            throw new Error('not a ledger');
          })();
        this.store.all(`ALTER TABLE ${body.table} ADD COLUMN extra_24g TEXT`);
        value = { altered: body.table };
      } else if (path === '/ledger/billing') {
        // The model-choice feature is a Worker var in production; switch it on for this one read only.
        const flags = this.store as unknown as { publicFreeTier?: boolean; playerModelChoice?: readonly string[] };
        const saved = { free: flags.publicFreeTier, models: flags.playerModelChoice };
        Object.assign(flags, { publicFreeTier: true, playerModelChoice: ['deepseek', 'gemini', 'xai'] });
        try {
          value = playerBilling(this.store as never, now, body.principalId, {});
        } finally {
          Object.assign(flags, { publicFreeTier: saved.free, playerModelChoice: saved.models });
        }
      } else return new Response(null, { status: 404 });
      return Response.json(value);
    } catch (error) {
      return Response.json(
        {
          error: error instanceof DomainError ? error.code : String(error),
          detail: (error as { detail?: unknown }).detail,
          retryAfterMs: (error as { retryAfterMs?: unknown }).retryAfterMs,
        },
        { status: 409 },
      );
    }
  }
}
export { default } from './cloudflare-business-worker.ts';
