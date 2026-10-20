import assert from 'node:assert/strict';
import test from 'node:test';
import { requireWebContent } from '../../../apps/server/admission/web-retention.ts';
import { effectiveTier } from '../../../apps/server/admission/web-model-settings.ts';
import { modelChoiceState } from '../../../apps/server/admission/web-points.ts';
import { endHolderAccess } from '../../../apps/server/invites/web-holder-access.ts';
import { WebInvites } from '../../../apps/server/invites/web-invites.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { DAY, T0, tiersFixture } from '../fixtures/invite-tiers.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'ok';
};
const MODELS = ['deepseek', 'gemini', 'xai'] as const;
type Switches = { signup: boolean; choice: boolean };
const COMBOS: [string, Switches][] = [
  ['both switches on', { signup: true, choice: true }],
  ['model choice off', { signup: true, choice: false }],
  ['signup bonus off', { signup: false, choice: true }],
  ['both off', { signup: false, choice: false }],
];
const set = (f: ReturnType<typeof tiersFixture>, s: Switches) =>
  Object.assign(f.store, { publicFreeTier: s.signup, playerModelChoice: s.choice ? MODELS : undefined });

/**
 * Part 22a follow-up: on a schema-125 database a code is ALWAYS an entitlement - never a legacy invite principal (a grant, kind
 * 'invite', retention 'protected') - whatever the two switches say. Only daily_refill needs points.
 */
for (const batchKind of ['unlimited', 'daily_refill'] as const)
  for (const [name, switches] of COMBOS)
    test(`22a matrix: ${batchKind} batch with ${name}`, (t) => {
      const f = tiersFixture(t);
      const owner = f.sessionIdOf(f.owner);
      const tier =
        batchKind === 'unlimited'
          ? ({ kind: 'unlimited' } as const)
          : ({ kind: 'daily_refill', dailyAmount: 50, cap: 1000 } as const);
      // Made while everything is on (so a refill batch exists), then the switches move.
      const batch = f.create(f.owner, { tier, count: 2 });
      set(f, switches);
      const who = f.player('ann', { signedUp: true });
      const principal = () =>
        f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', who.principalId)!.kind;
      const retention = () =>
        f.store.get(
          'SELECT state,started_at,expires_at FROM web_guest_retention WHERE principal_id=?',
          who.principalId,
        );
      const before = { retention: { ...retention()! } };
      const refillNeedsPoints = batchKind === 'daily_refill' && !switches.choice;

      if (refillNeedsPoints) {
        // 需要先开启模型选择/积分: no new refill batch while points are off ...
        assert.equal(
          code(() => f.create(f.owner, { tier, requestId: 'late' })),
          'WEB_INVITE_POINTS_REQUIRED',
        );
        // ... and an existing refill code is refused WITHOUT being consumed.
        assert.equal(
          code(() => f.redeem(who, batch.codes![0]!)),
          'WEB_INVITE_UNUSABLE',
        );
        assert.equal(
          f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_codes WHERE redeemed_count=1')!.n,
          0,
        );
        assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_entitlements')!.n, 0);
        assert.equal(principal(), 'guest');
        set(f, { ...switches, choice: true });
        assert.equal(
          code(() => f.redeem(who, batch.codes![0]!)),
          'ok',
          'the same code works once points are on',
        );
        set(f, switches);
      } else {
        assert.equal(
          code(() => f.redeem(who, batch.codes![0]!)),
          'ok',
        );
      }

      // NEVER a legacy invite principal.
      assert.equal(principal(), 'guest');
      assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')!.n, 0);
      assert.deepEqual({ ...retention()! }, before.retention);
      const eff = effectiveTier(f.store, who.principalId, f.clock())!;
      assert.deepEqual([eff.tier, eff.kind], ['invited', batchKind], 'the tier never depends on the switches');

      // Liveness never depends on the free-tier switch: past the trial window the holder is still live.
      f.store.run(
        "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=?",
        T0 - 30 * DAY,
        T0 - 23 * DAY,
        who.principalId,
      );
      assert.equal(
        code(() => requireWebContent(f.store, { now: f.clock }, who.principalId, who.worldId)),
        'ok',
      );

      // A reply: unlimited is never charged; a refill holder pays points (or, with points off, nothing: nothing to charge).
      const start = f.balance(who.principalId);
      const op = f.admit(who.principalId, 'm-1');
      f.finish(op.operationId, 'published');
      const spent = f.events(who.principalId).some(([source]) => source === 'spend');
      if (batchKind === 'unlimited' || !switches.choice) assert.equal(spent, false, 'not charged');
      else assert.equal(spent, true, 'a refill holder is charged like any registered player');
      if (batchKind === 'unlimited') assert.equal(f.balance(who.principalId), start);
      // The model row exists only while model choice does.
      const rows = f.store.get<{ n: number }>('SELECT count(*) n FROM web_operation_models')!.n;
      assert.equal(rows, switches.choice ? 1 : 0);
      assert.equal(principal(), 'guest');
      void owner;
    });

test('22a a refill holder whose points are switched off keeps its tier, is not charged, and charging resumes when they are back', (t) => {
  const f = tiersFixture(t);
  const batch = f.create(f.owner, { count: 1 });
  const who = f.player('ann', { signedUp: true });
  f.redeem(who, batch.codes![0]!);
  const balance = () => f.balance(who.principalId)!;
  const after = balance();
  Object.assign(f.store, { playerModelChoice: undefined });
  assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.kind, 'daily_refill');
  f.finish(f.admit(who.principalId, 'off-1').operationId, 'published');
  assert.equal(balance(), after, 'points off: nothing to charge');
  Object.assign(f.store, { playerModelChoice: MODELS });
  f.finish(f.admit(who.principalId, 'on-1').operationId, 'published');
  assert.ok(balance() < after, 'points back: charged again');
  // A day later, on a visit, the refill resumes.
  f.setNow(f.clock() + DAY);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.ok(balance() > after - 100);
});

/** The shape migration 125 leaves for an old invited player: kind 'invite', protected, a grant, and (with a login) an entitlement. */
function legacyHolder(f: ReturnType<typeof tiersFixture>, name: string, o: { login: boolean }) {
  const p = f.player(name, { login: o.login, bonus: o.login });
  f.store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", p.principalId);
  f.store.run(
    "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL WHERE principal_id=?",
    p.principalId,
  );
  f.store.run("INSERT OR IGNORE INTO admin_sessions VALUES ('legacy-admin','h',?,?,NULL)", T0, T0 + 10 * DAY);
  f.store.run(
    "INSERT OR IGNORE INTO web_invite_batches(id,name,tier,created_at) VALUES ('legacy:old','old','unlimited',1)",
  );
  f.store.run(
    `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at,batch_id)
    VALUES (?,?,?,?,1,1,'active','old','legacy-admin',1,'legacy:old')`,
    `invite-${name}`,
    `digest-${name}`,
    `issue-${name}`,
    'd',
  );
  f.store.run(
    'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at) VALUES (?,?,?,?,?,1,NULL)',
    `grant-${name}`,
    `invite-${name}`,
    p.principalId,
    p.playerId,
    p.worldId,
  );
  if (o.login)
    f.store.run(
      `INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,expires_at,created_at)
      VALUES (?,?,'invite',?,'legacy:old','unlimited',1,NULL,1)`,
      `legacy:grant-${name}`,
      p.principalId,
      `invite-${name}`,
    );
  return { ...p, inviteId: `invite-${name}` };
}

for (const entry of ['玩家授权 (revokeGrant)', '结束额度 (revokeEntitlement)'] as const)
  test(`22a one revoke, whichever page starts it: ${entry} ends the entitlement AND the grant; the player is registered with its balance`, (t) => {
    const f = tiersFixture(t);
    const sid = f.sessionIdOf(f.owner);
    const who = legacyHolder(f, 'old', { login: true });
    f.store.run(
      "INSERT INTO web_points_policy(principal_id,kind,amount,created_at,updated_at) VALUES (?,'one_off',100,1,1)",
      who.principalId,
    );
    f.store.run(
      'INSERT INTO web_points_balance(principal_id,balance,created_at,updated_at) VALUES (?,77,1,1)',
      who.principalId,
    );
    assert.equal(
      effectiveTier(f.store, who.principalId, f.clock())!.kind,
      'unlimited',
      'a backfilled holder is unlimited',
    );
    if (entry.startsWith('玩家授权')) {
      const invites = new WebInvites(f.store, {
        clock: { now: f.clock },
        codeKey: Buffer.alloc(32, 9),
        authorize: () => {
          throw new Error('unused');
        },
      });
      invites.revokeGrant(sid, 'grant-old');
    } else f.tiers.revokeEntitlement(sid, who.inviteId);
    const one = (sql: string) => f.store.get<{ revoked_at: number | null }>(sql, who.principalId)!.revoked_at;
    assert.notEqual(one('SELECT revoked_at FROM web_entitlements WHERE principal_id=?'), null);
    assert.notEqual(one('SELECT revoked_at FROM web_invite_grants WHERE principal_id=?'), null);
    assert.equal(
      f.store.get<{ n: number }>(
        'SELECT count(*) n FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL',
        who.principalId,
      )!.n,
      0,
      "the grant's sessions end, as the old revoke always did",
    );
    // The player signs in again (a login, no live grant): registered, with the balance it has - not unlimited.
    const eff = effectiveTier(f.store, who.principalId, f.clock())!;
    assert.deepEqual([eff.tier, eff.kind, eff.unlimited], ['registered', 'registered', false]);
    assert.equal(f.balance(who.principalId), 77);
    assert.equal(
      code(() => requireWebContent(f.store, { now: f.clock }, who.principalId, who.worldId)),
      'ok',
    );
    // Repeating either revoke is a no-op.
    assert.equal(endHolderAccess(f.store, f.clock(), who.inviteId).changed, false);
    f.finish(f.admit(who.principalId, 'after').operationId, 'published');
    assert.ok(f.balance(who.principalId)! < 77, 'now charged like any registered player');
  });

test('22a an old invite-only player (no login) is ended by the same function, with its sessions', (t) => {
  const f = tiersFixture(t);
  const sid = f.sessionIdOf(f.owner);
  const who = legacyHolder(f, 'only', { login: false });
  assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.kind, 'legacy_invite');
  f.tiers.revokeEntitlement(sid, who.inviteId);
  assert.equal(
    f.store.get<{ n: number }>(
      'SELECT count(*) n FROM web_sessions WHERE principal_id=? AND revoked_at IS NULL',
      who.principalId,
    )!.n,
    0,
  );
  assert.notEqual(
    f.store.get<{ revoked_at: number | null }>(
      'SELECT revoked_at FROM web_invite_grants WHERE principal_id=?',
      who.principalId,
    )!.revoked_at,
    null,
  );
});

test('22a the legacy redemption cannot be reached on schema 125', (t) => {
  const f = tiersFixture(t);
  const invites = new WebInvites(f.store, {
    clock: { now: f.clock },
    codeKey: Buffer.alloc(32, 9),
    authorize: () => ({ sessionId: 's', principalId: 'p', playerId: 'x', worldId: 'w', kind: 'guest' as const }),
  });
  assert.throws(
    () =>
      invites.redeem({
        token: 't',
        csrf: 'c',
        origin: 'https://fixture.invalid',
        code: 'A'.repeat(43),
        requestId: 'r',
      }),
    /WEB_INVITE_LEGACY_UNAVAILABLE/,
  );
});
