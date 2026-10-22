import { WebRetentionWorldFixture } from './cloudflare-retention-world-worker.ts';

// Part 22a: the all-switches real-HTTP fixture plus routes (/fixture/cross/*) that put OLD data next to NEW data: an old invited
// player (with and without a login) in exactly the shape migration 126 leaves, and the switches / refill day / expiry that a
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
      // Named exception (Part 22x): the shape migration 126 leaves an old invited player in. Kind 'invite' no longer exists: with a
      // login the player is a guest holding the unlimited entitlement migration 125 backfilled for it (its old code row stays, as
      // the entitlement references it); without a login it is a guest whose window is over (no access).
      const { principalId, login } = input as { principalId: string; login: boolean };
      store.transaction(() => {
        if (login) {
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
            `INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,expires_at,created_at)
            VALUES (?,?,'invite',?,'legacy:old','unlimited',1,NULL,1)`,
            `legacy:grant-${principalId}`,
            principalId,
            `invite-${principalId}`,
          );
        } else
          store.run(
            "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=?,revision=revision+1 WHERE principal_id=?",
            now - 30 * 86_400_000,
            now - 23 * 86_400_000,
            principalId,
          );
      });
      return Response.json({ inviteId: `invite-${principalId}` });
    }
    if (path === '/fixture/cross/legacy-126') {
      // Part 22a2: a principal in EXACTLY the shape migration 126 leaves: a guest whose window is over, still holding the old
      // invite rows - an UNREVOKED grant, a credential, an identity receipt, a credential receipt, a redemption and the sessions
      // those receipts point at. (126 never touched these tables.)
      const { principalId } = input as { principalId: string };
      const p = store.get<{ player_id: string; world_id: string }>(
        'SELECT player_id,world_id FROM web_principals WHERE id=?',
        principalId,
      )!;
      const live = store.get<{ recovery_epoch: string; security_revision: number }>(
        'SELECT recovery_epoch,security_revision FROM web_sessions WHERE principal_id=? LIMIT 1',
        principalId,
      )!;
      const blob = (n: number) => new Uint8Array(n).fill(7);
      store.transaction(() => {
        store.run("INSERT OR IGNORE INTO admin_sessions VALUES ('legacy-admin','h',?,?,NULL)", now, now + 86_400_000);
        for (const name of ['old', 'new', 'rotated'])
          store.run(
            'INSERT INTO web_sessions(id,token_digest,principal_id,recovery_epoch,security_revision,csrf_seed,created_at,last_active_at,absolute_expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            `legacy-${name}-${principalId}`,
            `legacy-digest-${name}-${principalId}`,
            principalId,
            live.recovery_epoch,
            live.security_revision,
            blob(32),
            now - 30 * 86_400_000,
            now - 30 * 86_400_000,
            now + 86_400_000,
            name === 'old' ? now - 29 * 86_400_000 : null,
          );
        store.run(
          `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at)
          VALUES (?,?,?,?,1,1,'active','old','legacy-admin',1)`,
          `lc-${principalId}`,
          `lc-digest-${principalId}`,
          `lc-issue-${principalId}`,
          'd',
        );
        store.run(
          'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at) VALUES (?,?,?,?,?,?)',
          `lg-${principalId}`,
          `lc-${principalId}`,
          principalId,
          p.player_id,
          p.world_id,
          now - 30 * 86_400_000,
        );
        store.run(
          'INSERT INTO web_invite_credentials(grant_id,secret_digest,created_at) VALUES (?,?,?)',
          `lg-${principalId}`,
          `secret-${principalId}`,
          now - 30 * 86_400_000,
        );
        store.run(
          `INSERT INTO web_invite_identity_receipts(id,old_session_id,new_session_id,grant_id,request_id,code_digest,public_receipt,key_id,nonce,ciphertext,auth_tag,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          `lir-${principalId}`,
          `legacy-old-${principalId}`,
          `legacy-new-${principalId}`,
          `lg-${principalId}`,
          'req-1',
          `lc-digest-${principalId}`,
          'pub',
          'k',
          blob(12),
          blob(32),
          blob(16),
          now - 30 * 86_400_000,
          now - 29 * 86_400_000,
        );
        store.run(
          `INSERT INTO web_invite_credential_receipts(id,grant_id,request_id,old_secret_digest,new_secret_digest,new_session_id,key_id,nonce,ciphertext,auth_tag,created_at,expires_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          `lcr-${principalId}`,
          `lg-${principalId}`,
          'req-2',
          `secret-${principalId}`,
          `secret2-${principalId}`,
          `legacy-rotated-${principalId}`,
          'k',
          blob(12),
          blob(32),
          blob(16),
          now - 20 * 86_400_000,
          now - 19 * 86_400_000,
        );
        store.run(
          'INSERT INTO web_invite_redemptions(principal_id,request_id,code_digest,grant_id,redeemed_at) VALUES (?,?,?,?,?)',
          principalId,
          'req-1',
          `lc-digest-${principalId}`,
          `lg-${principalId}`,
          now - 30 * 86_400_000,
        );
        store.run(
          "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=?,revision=revision+1 WHERE principal_id=?",
          now - 30 * 86_400_000,
          now - 23 * 86_400_000,
          principalId,
        );
      });
      return Response.json({ shaped: true });
    }
    if (path === '/fixture/cross/legacy-rows') {
      // What the old invite tables still hold for this principal (counts only, by table) and whether any grant is unrevoked.
      const id = input.principalId as string;
      const count = (sql: string) => store.get<{ n: number }>(sql, id)!.n;
      return Response.json({
        grants: count('SELECT count(*) n FROM web_invite_grants WHERE principal_id=?'),
        unrevokedGrants: count('SELECT count(*) n FROM web_invite_grants WHERE principal_id=? AND revoked_at IS NULL'),
        redemptions: count('SELECT count(*) n FROM web_invite_redemptions WHERE principal_id=?'),
        credentials: count(
          'SELECT count(*) n FROM web_invite_credentials c JOIN web_invite_grants g ON g.id=c.grant_id WHERE g.principal_id=?',
        ),
        identityReceipts: count(
          'SELECT count(*) n FROM web_invite_identity_receipts c JOIN web_invite_grants g ON g.id=c.grant_id WHERE g.principal_id=?',
        ),
        credentialReceipts: count(
          'SELECT count(*) n FROM web_invite_credential_receipts c JOIN web_invite_grants g ON g.id=c.grant_id WHERE g.principal_id=?',
        ),
      });
    }
    if (path === '/fixture/cross/review-switch') {
      Object.assign(store, { chatReview: input.on === true });
      return Response.json({ on: input.on === true });
    }
    if (path === '/fixture/cross/trial-over') {
      // A guest whose trial window ended (nothing legacy about it).
      store.run(
        "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=?,revision=revision+1 WHERE principal_id=?",
        now - 30 * 86_400_000,
        now - 23 * 86_400_000,
        input.principalId,
      );
      return Response.json({ over: true });
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
