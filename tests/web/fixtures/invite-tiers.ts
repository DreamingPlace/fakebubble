import { createHash } from 'node:crypto';
import type { TestContext } from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebInviteTiers } from '../../../apps/server/invites/web-invite-tiers.ts';
import { migrateWebProviderInviteTiers } from '../../../apps/server/generation/web-provider-migration.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { enableModelChoice } from './model-choice.ts';
import { schema124 } from './model-settings.ts';

export const origin = 'https://fixture.invalid';
export const T0 = 1_800_000_000_000;
export const DAY = 86_400_000;
export const characterId = 'fixture-character';
const ip = (digit: string) => digit.repeat(64);

/** The real schema through migration 125 on an in-memory Node database. */
export function schema125() {
  const store = schema124();
  migrateWebProviderInviteTiers(store);
  return store;
}

/**
 * Part 22a fixture: a schema-125 store with the free tier and model choice on, an admission, an owner and administrators, the
 * tiers object, and players who are signed up (a login, the signup bonus) or guests, each with a live session so a code can be
 * redeemed through the real WebInviteTiers.redeem.
 */
export function tiersFixture(t: TestContext) {
  const store = schema125();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store);
  let now = T0,
    seq = 0,
    ids = 0,
    rnd = 0;
  const clock = { now: () => now };
  const admission = new WebAdmission(store as WebStore, clock, () => `id-${++seq}`);
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  const accounts = new WebAccountAdmin(store, clock, origin);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const member = (permissions: string[], label = 'Staff') => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${label}-${++ids}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };
  const sessionIdOf = (auth: { cookie: string }) =>
    store.get<{ id: string }>(
      'SELECT id FROM admin_sessions WHERE secret_hash=?',
      createHash('sha256').update(auth.cookie).digest('hex'),
    )!.id;
  store.run("INSERT OR IGNORE INTO web_instance(singleton,instance_id) VALUES (1,'fixture-instance')");
  store.run("UPDATE web_instance SET recovery_epoch='fixture-epoch' WHERE singleton=1");
  const epoch = 'fixture-epoch';
  const sessions = new Map<string, string>();
  const tiers = new WebInviteTiers(store, {
    clock,
    codeKey: Buffer.alloc(32, 9),
    authorize: (token) => {
      const principalId = sessions.get(token);
      if (!principalId) throw new Error('SESSION_EXPIRED');
      const row = store.get<{ kind: 'guest' | 'invite'; player_id: string; world_id: string }>(
        'SELECT kind,player_id,world_id FROM web_principals WHERE id=?',
        principalId,
      )!;
      return {
        sessionId: `session-${token}`,
        principalId,
        playerId: row.player_id,
        worldId: row.world_id,
        kind: row.kind,
      };
    },
    nextId: () => `x-${++ids}`,
    random: () => Buffer.alloc(32, ++rnd),
  });

  /** A principal with a world and a live session. `signedUp` = an email login + the signup bonus (a registered player). */
  const player = (name: string, o: { signedUp?: boolean; login?: boolean; bonus?: boolean; opening?: number | false } = {}) => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`,
      token = `token-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (o.signedUp || o.login)
      store.run(
        'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
        principalId,
        `${name}@example.com`,
        'x',
        now,
        now,
        now,
      );
    if (o.signedUp || o.bonus)
      store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, now);
    // A signed-up player normally holds its 100-point signup balance already (created on its first touch in production).
    const opening = o.opening ?? (o.signedUp ? 100 : false);
    if (opening !== false && (o.signedUp || o.bonus)) {
      store.run(
        "INSERT INTO web_points_policy(principal_id,kind,amount,created_at,updated_at) VALUES (?,'one_off',100,?,?)",
        principalId,
        now,
        now,
      );
      store.run(
        'INSERT INTO web_points_balance(principal_id,balance,created_at,updated_at) VALUES (?,?,?,?)',
        principalId,
        opening,
        now,
        now,
      );
      if (opening > 0)
        store.run(
          "INSERT INTO web_points_events(principal_id,operation_id,source,reason,delta,price_version,created_at) VALUES (?,NULL,'bonus',NULL,?,2,?)",
          principalId,
          opening,
          now,
        );
    }
    store.run(
      `INSERT INTO web_sessions(id,token_digest,principal_id,account_id,recovery_epoch,security_revision,csrf_seed,created_at,last_active_at,absolute_expires_at)
      VALUES (?,?,?,NULL,?,1,x'00',?,?,?)`,
      `session-${token}`,
      `digest-${name}`,
      principalId,
      epoch,
      now,
      now,
      now + 365 * DAY,
    );
    sessions.set(token, principalId);
    return { name, principalId, playerId, worldId, token };
  };
  const redeem = (who: { token: string }, code: string, requestId = `r-${++ids}`) =>
    tiers.redeem({ token: who.token, csrf: 'csrf', origin, code, requestId });
  const create = (
    auth: { cookie: string; csrf: string; origin: string },
    over: Partial<Parameters<WebInviteTiers['createBatch']>[0]> = {},
  ) =>
    tiers.createBatch({
      adminSessionId: sessionIdOf(auth),
      requestId: `batch-${++ids}`,
      name: 'fixture batch',
      count: 2,
      tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
      durationDays: null,
      redeemBy: null,
      ...over,
    });
  const admit = (principalId: string, requestId: string, hashDigit = 'a') =>
    admission.admit({ principalId, requestId, characterId, text: '你好', ipHash: ip(hashDigit) });
  const finish = (operationId: string, status: string) =>
    store.run(
      'UPDATE web_operations SET status=?,quota_state=?,stage_version=stage_version+1 WHERE id=?',
      status,
      status === 'published' ? 'used' : 'released',
      operationId,
    );
  const balance = (principalId: string) =>
    store.get<{ balance: number }>('SELECT balance FROM web_points_balance WHERE principal_id=?', principalId)?.balance;
  const events = (principalId: string) =>
    store
      .all<{ source: string; delta: number }>(
        'SELECT source,delta FROM web_points_events WHERE principal_id=? ORDER BY id',
        principalId,
      )
      .map((e) => [e.source, e.delta] as const);
  return {
    store,
    admission,
    accounts,
    tiers,
    owner: ownerAuth,
    member,
    sessionIdOf,
    player,
    redeem,
    create,
    admit,
    finish,
    balance,
    events,
    clock: () => now,
    // Time moves; the administrators' sessions are kept alive so a test can act days later.
    advance: (ms: number) => {
      now += ms;
      store.run('UPDATE admin_sessions SET expires_at=?', now + 8 * 3_600_000);
    },
    setNow: (value: number) => {
      now = value;
      store.run('UPDATE admin_sessions SET expires_at=?', now + 8 * 3_600_000);
    },
  };
}
