import { WebRetentionWorldFixture } from './cloudflare-retention-world-worker.ts';

// Part 22a: the all-switches real-HTTP fixture plus routes (/fixture/cross/*) that put OLD data next to NEW data: an old invited
// player (with and without a login) in exactly the shape migration 125 leaves, and the switches / refill day / expiry that a
// real clock would move. They never ship.
const MODELS = ['deepseek', 'gemini', 'xai'] as const;

export class WebCrossPathFixture extends WebRetentionWorldFixture {
  async fetch(request: Request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/fixture/cross/')) return super.fetch(request);
    const input = request.method === 'POST' ? ((await request.json()) as Record<string, any>) : {};
    const store = this.store;
    const now = this.clock.now();
    if (path === '/fixture/cross/choice') {
      Object.assign(store, { playerModelChoice: input.on === true ? MODELS : undefined });
      return Response.json({ on: input.on === true });
    }
    if (path === '/fixture/cross/signup-switch') {
      Object.assign(store, { publicFreeTier: input.on === true });
      return Response.json({ on: input.on === true });
    }
    if (path === '/fixture/cross/legacy') {
      // The shape of an old invited player: kind 'invite', retention protected, a redeemed code and its grant; with a login also
      // the unlimited entitlement migration 125 backfills for it.
      const { principalId, login } = input as { principalId: string; login: boolean };
      const p = store.get<{ player_id: string; world_id: string }>(
        'SELECT player_id,world_id FROM web_principals WHERE id=?',
        principalId,
      )!;
      store.transaction(() => {
        store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", principalId);
        store.run(
          "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
          principalId,
        );
        store.run("INSERT OR IGNORE INTO admin_sessions VALUES ('legacy-admin','h',?,?,NULL)", now, now + 86_400_000);
        store.run(
          "INSERT OR IGNORE INTO web_invite_batches(id,name,tier,created_at) VALUES ('legacy:old','old','unlimited',1)",
        );
        store.run(
          `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at,batch_id)
          VALUES (?,?,?,?,1,1,'active','old','legacy-admin',1,'legacy:old')`,
          `invite-${principalId}`,
          `digest-${principalId}`,
          `issue-${principalId}`,
          'd',
        );
        store.run(
          'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at) VALUES (?,?,?,?,?,1,NULL)',
          `grant-${principalId}`,
          `invite-${principalId}`,
          principalId,
          p.player_id,
          p.world_id,
        );
        if (login)
          store.run(
            `INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,expires_at,created_at)
            VALUES (?,?,'invite',?,'legacy:old','unlimited',1,NULL,1)`,
            `legacy:grant-${principalId}`,
            principalId,
            `invite-${principalId}`,
          );
      });
      return Response.json({ grantId: `grant-${principalId}`, inviteId: `invite-${principalId}` });
    }
    if (path === '/fixture/cross/rewind-refill') {
      // A UTC midnight passed since the last refill: the (player, day) rows move one day back.
      store.run("UPDATE web_entitlement_refills SET day=date(day,'-1 day') WHERE principal_id=?", input.principalId);
      return Response.json({ rewound: true });
    }
    if (path === '/fixture/cross/expire') {
      store.run(
        'UPDATE web_entitlements SET starts_at=1,expires_at=? WHERE principal_id=?',
        now - 1000,
        input.principalId,
      );
      store.run(
        'UPDATE web_invite_grants SET redeemed_at=1,expires_at=? WHERE principal_id=?',
        now - 1000,
        input.principalId,
      );
      return Response.json({ expired: true });
    }
    if (path === '/fixture/cross/state') {
      const id = input.principalId as string;
      return Response.json({
        kind: store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', id)?.kind,
        retention: store.get<{ state: string }>('SELECT state FROM web_guest_retention WHERE principal_id=?', id)
          ?.state,
        spends: store.get<{ n: number }>(
          "SELECT count(*) n FROM web_points_events WHERE principal_id=? AND source='spend'",
          id,
        )!.n,
        refills: store.get<{ n: number }>(
          "SELECT count(*) n FROM web_points_events WHERE principal_id=? AND source='daily_refill'",
          id,
        )!.n,
        balance:
          store.get<{ balance: number }>('SELECT balance FROM web_points_balance WHERE principal_id=?', id)?.balance ??
          null,
        grants: store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants WHERE principal_id=?', id)!.n,
        liveSessions: store.get<{ n: number }>(
          'SELECT count(*) n FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL',
          id,
        )!.n,
      });
    }
    return new Response(null, { status: 404 });
  }
}
export { default } from './cloudflare-http-worker.ts';
