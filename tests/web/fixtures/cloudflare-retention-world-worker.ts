import { fixtureOptions } from './cloudflare-business-worker.ts';
import { WebHTTPFixture } from './cloudflare-http-worker.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { WebCloudRetention, type RetentionReport } from '../../../apps/server/cloudflare/web-retention.ts';

// Part 17g: the production switches that touch the purge are ALL on - SIGNUP_BONUS_ENABLED, CHAT_REVIEW_ENABLED and
// PLAYER_MODEL_CHOICE_ENABLED - on top of the real-HTTP fixture, so one world holds a row in every feature table.
fixtureOptions.publicFreeTier = true;
fixtureOptions.chatReview = true;
fixtureOptions.playerModelChoice = ['deepseek', 'gemini', 'xai'];

/** Module-level on purpose: the base constructor builds the runner before any subclass field exists. */
const speech = { fail: false };
const DAY = 24 * 60 * 60_000;

/** Test-only routes (/fixture/world/*) that seed, age and inspect a world. They never ship. */
export class WebRetentionWorldFixture extends WebHTTPFixture {
  private readonly reports: RetentionReport[] = [];
  private retentionUnderTest: WebCloudRetention | undefined;
  protected createRunner(audioMs?: number, beforeResult?: (provider: string, signal: AbortSignal) => Promise<void>) {
    return super.createRunner(audioMs, async (provider, signal) => {
      if (provider === 'speech' && speech.fail) throw new DomainError('FISH_RATE_LIMITED');
      await beforeResult?.(provider, signal);
    });
  }
  /** Moves the sweeper's clock forward (the backoff is measured on it); nothing else reads it. */
  private skew = 0;
  private sweeper() {
    return (this.retentionUnderTest ??= new WebCloudRetention(
      this.store,
      { now: () => this.clock.now() + this.skew },
      DAY,
      (report) => this.reports.push(report),
    ));
  }
  private scopeOf(principalId: string) {
    return this.store.get<{ world_id: string; conversation_id: string; character_id: string; player_id: string }>(
      `SELECT o.world_id,o.conversation_id,o.character_id,p.player_id FROM web_operations o
      JOIN web_principals p ON p.id=o.principal_id WHERE o.principal_id=? ORDER BY o.created_at LIMIT 1`,
      principalId,
    )!;
  }
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/fixture/world/')) return super.fetch(request);
    const input = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
    const now = this.clock.now();
    if (path === '/fixture/world/speech-fail') {
      speech.fail = input.on === true;
      return Response.json({ speechFail: speech.fail });
    }
    if (path === '/fixture/world/sweep') {
      const result = await this.sweeper().sweep(16);
      return Response.json({ ...result, error: this.sweeper().lastError });
    }
    if (path === '/fixture/world/reports') return Response.json(this.reports);
    if (path === '/fixture/world/skew') {
      this.skew += input.ms as number;
      return Response.json({ skew: this.skew });
    }
    if (path === '/fixture/world/health') return Response.json(await this.sweeper().health());
    if (path === '/fixture/world/poison') {
      // A trigger that aborts the clear with a message that carries player data, the way a careless error text could.
      const { on, message } = input as { on: boolean; message?: string };
      this.store.run('DROP TRIGGER IF EXISTS cf_fixture_poison');
      if (on)
        this.store.run(
          `CREATE TRIGGER cf_fixture_poison BEFORE DELETE ON messages BEGIN SELECT RAISE(ABORT,'${String(message).replaceAll("'", "''")}'); END`,
        );
      return Response.json({ poisoned: on });
    }
    if (path === '/fixture/world/age') {
      // Let `ms` pass for one player: the trial window, the sessions and (if any) the login's last_seen_at.
      this.store.run(
        'UPDATE web_guest_retention SET started_at=started_at-?,expires_at=expires_at-? WHERE principal_id=? AND started_at IS NOT NULL',
        input.ms,
        input.ms,
        input.principalId,
      );
      this.store.run(
        'UPDATE web_sessions SET created_at=created_at-?,last_active_at=last_active_at-?,absolute_expires_at=absolute_expires_at-? WHERE principal_id=?',
        input.ms,
        input.ms,
        input.ms,
        input.principalId,
      );
      this.store.run(
        'UPDATE web_player_logins SET last_seen_at=last_seen_at-? WHERE principal_id=?',
        input.ms,
        input.principalId,
      );
      return Response.json({ aged: true });
    }
    if (path === '/fixture/world/seed') {
      const { principalId } = input as { principalId: string };
      const s = this.scopeOf(principalId);
      const job = this.store.get<{ job_id: string }>(
        `SELECT p.job_id FROM web_publications p JOIN web_operations o ON o.id=p.operation_id
        WHERE o.principal_id=? LIMIT 1`,
        principalId,
      )!.job_id;
      const message = this.store.get<{ id: string }>(
        "SELECT id FROM messages WHERE world_id=? AND author_kind='player' LIMIT 1",
        s.world_id,
      )!.id;
      const operation = this.store.get<{ id: string }>(
        'SELECT id FROM web_operations WHERE principal_id=? ORDER BY created_at LIMIT 1',
        principalId,
      )!.id;
      const scope = [s.world_id, s.conversation_id, s.character_id];
      const run = (sql: string, ...args: (string | number | Uint8Array | null)[]) => this.store.run(sql, ...args);
      this.store.transaction(() => {
        // Memory: topic, mention, evidence snapshot, episode, its sources, catalog entry, correction, context version, fact.
        run("INSERT INTO memory_topics VALUES (?,?,?,'猫','long',2,?,?,5)", ...scope, now, now + DAY);
        run("INSERT INTO memory_mentions VALUES (?,?,?,'猫',?)", ...scope, message);
        run("INSERT OR IGNORE INTO job_evidence_snapshots VALUES (?,?,?,?,'[]')", ...scope, job);
        run(
          "INSERT INTO memory_episodes VALUES (?,?,?,'猫',?,'玩家养了一只猫','player_statement','[]',?)",
          ...scope,
          job,
          now,
        );
        run("INSERT INTO memory_episode_sources VALUES (?,?,?,'猫',?,'[]')", ...scope, job);
        run(
          "INSERT OR IGNORE INTO memory_catalog(id,world_id,conversation_id,character_id,topic_key) VALUES (lower(hex(randomblob(16))),?,?,?,'猫')",
          ...scope,
        );
        run(
          "INSERT INTO memory_corrections(id,world_id,conversation_id,character_id,topic_key,revision,request_id,request_hash,summary,reason,evidence_ids_json,recorded_at) VALUES (lower(hex(randomblob(16))),?,?,?,'猫',1,?,'h','玩家养了两只猫','更正','[]',?)",
          ...scope,
          `fix-${principalId}`,
          now,
        );
        run('INSERT OR IGNORE INTO memory_context_versions VALUES (?,?,?,1)', ...scope);
        run(
          'INSERT INTO memory_facts VALUES (?,?,?,?,?,?,?,?,?,?,NULL,NULL)',
          ...scope,
          `fact-${principalId}`,
          '宠物',
          '玩家养了一只猫',
          8,
          '[]',
          now,
          now,
        );
        // Embeddings: a ready vector, one call that never left (hold 5) and one in flight (hold 3).
        run(
          "INSERT INTO memory_embeddings VALUES (?,?,?,'猫','@cf/baai/bge-m3',1024,?,?,1,'ready',?)",
          ...scope,
          new Uint8Array(4096),
          'a'.repeat(64),
          now,
        );
        run(
          "INSERT OR IGNORE INTO web_provider_spending(provider,currency,limit_micros) VALUES ('cloudflare','USD',1000000)",
        );
        for (const [id, state, held] of [
          [`index-${principalId}`, 'not_sent', 5],
          [`flight-${principalId}`, 'sent', 3],
        ] as const)
          run(
            `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,
            price_micros_per_million,held_micros,state,sent_at,lease_expires_at,created_at)
            VALUES (?,'index',?,?,?,'@cf/baai/bge-m3',1,10,11800,?,?,?,?,?)`,
            id,
            ...scope,
            held,
            state,
            state === 'sent' ? now : null,
            now + 60_000,
            now,
          );
        // Chat review: the live code and the closed-banner mark (the real flow draws them when the owner reads a list).
        run('INSERT OR IGNORE INTO web_review_codes VALUES (?,?,?)', principalId, String(input.code ?? 'K7M2'), now);
        run('INSERT OR IGNORE INTO web_review_notice VALUES (?,?)', principalId, now);
        // Points and billing rows of one operation (the real flow writes them when the player has points).
        run("INSERT OR IGNORE INTO web_player_model VALUES (?,'deepseek',NULL,?)", principalId, now);
        run("INSERT OR IGNORE INTO web_points_policy VALUES (?,'one_off',100,NULL,?,?)", principalId, now, now);
        run('INSERT OR IGNORE INTO web_points_balance VALUES (?,90,?,?)', principalId, now, now);
        run(
          "INSERT OR IGNORE INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at) VALUES (?,NULL,'bonus',NULL,100,NULL,1,?)",
          principalId,
          now,
        );
        run(
          "INSERT OR IGNORE INTO web_points_events(principal_id,operation_id,source,reason,delta,admin_id,price_version,created_at) VALUES (?,?,'spend','reply',-10,NULL,1,?)",
          principalId,
          operation,
          now,
        );
        run(
          "INSERT OR IGNORE INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,settled,created_at) VALUES (?,'deepseek',1,10,1,1,?)",
          operation,
          now,
        );
        run(
          "INSERT OR IGNORE INTO web_provider_backups VALUES (?,'draft',0,'xai','grok-4.7','XAI_RATE_LIMITED',0,?)",
          operation,
          now,
        );
      });
      return Response.json({ seeded: true });
    }
    if (path === '/fixture/world/state') {
      // Every table that names this player's world or principal, with the rows it still holds (names and counts only).
      const { principalId } = input as { principalId: string };
      const world = this.store.get<{ world_id: string }>(
        'SELECT world_id FROM web_principals WHERE id=?',
        principalId,
      )!.world_id;
      const rows: Record<string, number> = {};
      const tables = this.store
        .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB '_cf*'")
        .map((t) => t.name);
      for (const name of tables) {
        const columns = this.store.all<{ name: string }>(`PRAGMA table_info("${name}")`).map((c) => c.name);
        const where = columns.includes('world_id')
          ? ['world_id=?', world]
          : columns.includes('principal_id')
            ? ['principal_id=?', principalId]
            : null;
        if (!where) continue;
        const n = this.store.get<{ n: number }>(`SELECT count(*) n FROM "${name}" WHERE ${where[0]}`, where[1]!)!.n;
        if (n > 0) rows[name] = n;
      }
      return Response.json({
        rows,
        retention: this.store.get(
          'SELECT state,db_cleared_at FROM web_guest_retention WHERE principal_id=?',
          principalId,
        ),
        foreignKeyViolations: this.store.all('PRAGMA foreign_key_check').length,
      });
    }
    return new Response(null, { status: 404 });
  }
}
export { default } from './cloudflare-http-worker.ts';
