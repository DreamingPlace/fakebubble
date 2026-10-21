import assert from 'node:assert/strict';
import test from 'node:test';
import { claimRetention } from '../../../apps/server/admission/web-stage-queue.ts';
import { requireWebContent, webTierSql } from '../../../apps/server/admission/web-retention.ts';
import { effectiveTier, playerTier } from '../../../apps/server/admission/web-model-settings.ts';
import {
  applyDailyRefill,
  grantPoints,
  hasPoints,
  modelChoiceState,
  quote,
} from '../../../apps/server/admission/web-points.ts';
import { recallsMemory } from '../../../apps/server/admission/web-free-tier.ts';
import { inspectWebAuthority } from '../../../apps/server/cloudflare/web-inspect.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { DAY, T0, tiersFixture } from '../fixtures/invite-tiers.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    if (error instanceof Error) return error.message;
    throw error;
  }
  return 'ok';
};
const midnight = Math.floor(T0 / DAY) * DAY;

/** A signed-up player holding one redeemed daily_refill entitlement (N, cap) from a fresh batch. */
function refillPlayer(
  t: test.TestContext,
  o: { amount?: number; cap?: number; durationDays?: number | null; name?: string } = {},
) {
  const f = tiersFixture(t);
  f.setNow(midnight + 3_600_000); // 01:00 UTC
  const batch = f.create(f.owner, {
    tier: { kind: 'daily_refill', dailyAmount: o.amount ?? 50, cap: o.cap ?? 1000 },
    durationDays: o.durationDays ?? null,
    count: 3,
  });
  const who = f.player(o.name ?? 'ann', { signedUp: true });
  const redeemed = f.redeem(who, batch.codes![0]!);
  return { f, batch, who, redeemed };
}

test('22a a guest who enters a code is refused and the code is NOT consumed; signing up then redeems the same code', (t) => {
  const f = tiersFixture(t);
  const batch = f.create(f.owner);
  const guest = f.player('guest');
  assert.equal(
    code(() => f.redeem(guest, batch.codes![0]!)),
    'PLAYER_LOGIN_REQUIRED',
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_codes WHERE redeemed_count=1')!.n,
    0,
    'the refused code is untouched',
  );
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_entitlements')!.n, 0);
  // The same guest signs up (an email login) and the very same code works.
  f.store.run(
    'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
    guest.principalId,
    'g@example.com',
    'x',
    T0,
    T0,
    T0,
  );
  f.store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', guest.principalId, T0);
  const ok = f.redeem(guest, batch.codes![0]!);
  assert.equal(ok.duplicate, false);
  assert.equal(ok.entitlement.kind, 'daily_refill');
});

test('22a a redemption adds an entitlement and never changes principal kind or retention state', (t) => {
  const f = tiersFixture(t);
  const batch = f.create(f.owner, { tier: { kind: 'unlimited' } });
  const who = f.player('ann', { signedUp: true });
  const before = {
    principal: f.store.get('SELECT * FROM web_principals WHERE id=?', who.principalId),
    retention: f.store.get('SELECT * FROM web_guest_retention WHERE principal_id=?', who.principalId),
    sessions: f.store.all('SELECT * FROM web_sessions WHERE principal_id=?', who.principalId),
  };
  f.redeem(who, batch.codes![0]!, 'replay');
  assert.deepEqual(f.store.get('SELECT * FROM web_principals WHERE id=?', who.principalId), before.principal);
  assert.deepEqual(
    f.store.get('SELECT * FROM web_guest_retention WHERE principal_id=?', who.principalId),
    before.retention,
  );
  assert.deepEqual(f.store.all('SELECT * FROM web_sessions WHERE principal_id=?', who.principalId), before.sessions);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_grants')!.n, 0, 'no legacy grant is made');
  assert.equal(
    f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', who.principalId)!.kind,
    'guest',
  );
  // Replaying the same requestId is the same answer; another code needs another request.
  const again = f.tiers.redeem({
    token: who.token,
    csrf: 'c',
    origin: 'https://fixture.invalid',
    code: batch.codes![0]!,
    requestId: 'replay',
  });
  assert.equal(again.duplicate, true);
});

test('22a unlimited: never charged, tier invited, the per-day reply cap still stops it with the existing message code', (t) => {
  const f = tiersFixture(t);
  const batch = f.create(f.owner, { tier: { kind: 'unlimited' } });
  const who = f.player('ann', { signedUp: true });
  f.redeem(who, batch.codes![0]!);
  const eff = effectiveTier(f.store, who.principalId, f.clock())!;
  assert.deepEqual([eff.tier, eff.kind, eff.unlimited], ['invited', 'unlimited', true]);
  assert.equal(playerTier(f.store, who.principalId, f.clock()), 'invited');
  Object.assign(f.store, { dailyReplyLimit: 2 });
  const state = modelChoiceState(f.store, f.clock(), who.principalId)!;
  assert.equal(state.plan?.kind, 'unlimited');
  const start = f.balance(who.principalId);
  assert.equal(start, 100);
  for (const i of [1, 2]) {
    const op = f.admit(who.principalId, `m-${i}`);
    f.finish(op.operationId, 'published');
  }
  assert.equal(f.balance(who.principalId), start, 'unlimited is never charged');
  assert.equal(
    f.events(who.principalId).some(([source]) => source === 'spend'),
    false,
  );
  assert.equal(
    code(() => f.admit(who.principalId, 'm-3')),
    'WEB_DAILY_LIMIT_REACHED',
  );
  assert.equal(quote(f.store, f.clock(), who.principalId, 'xai').ok, true);
});

test('22a daily_refill: +N on the first visit of each UTC day (not a top-up), one event, 150 then 200', (t) => {
  const { f, who } = refillPlayer(t);
  // The redemption was the first visit of day 1: signup 100 + 50.
  assert.equal(f.balance(who.principalId), 150);
  assert.deepEqual(f.events(who.principalId), [
    ['bonus', 100],
    ['daily_refill', 50],
  ]);
  // More visits the same day pay nothing.
  for (let i = 0; i < 3; i++) modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 150);
  f.setNow(midnight + DAY + 5_000);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 200);
  assert.equal(f.events(who.principalId).filter(([s]) => s === 'daily_refill').length, 2);
  // It is charged like any registered player and keeps tier 'invited'.
  assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.tier, 'invited');
  const op = f.admit(who.principalId, 'spend-1');
  assert.ok(f.balance(who.principalId)! < 200);
  f.finish(op.operationId, 'failed');
});

test('22a refill boundaries: 23:59:59.999 UTC is still the old day, 00:00:00.000 is the new one; a missed day is never paid later', (t) => {
  const { f, who } = refillPlayer(t);
  assert.equal(f.balance(who.principalId), 150);
  f.setNow(midnight + DAY - 1); // 23:59:59.999 of day 1
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 150, 'same UTC day: nothing');
  f.setNow(midnight + DAY); // 00:00:00.000 of day 2
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 200);
  // Days 3, 4 and 5 pass with no visit; day 6's visit pays ONE refill, not four.
  f.setNow(midnight + 5 * DAY + 60_000);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 250);
  assert.equal(f.events(who.principalId).filter(([s]) => s === 'daily_refill').length, 3);
  // No visit, no points: nothing touches the balance in the meantime.
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_entitlement_refills WHERE principal_id=?', who.principalId)!
      .n,
    3,
  );
});

test('22a cap: a refill that would pass it adds only up to it, at or above it adds nothing, held points are never taken away', (t) => {
  const { f, who } = refillPlayer(t, { amount: 50, cap: 180 });
  assert.equal(f.balance(who.principalId), 150, 'day 1: 100 + 50');
  f.setNow(midnight + DAY + 1000);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 180, 'day 2: only 30 of the 50 fit');
  assert.deepEqual(f.events(who.principalId).at(-1), ['daily_refill', 30]);
  f.setNow(midnight + 2 * DAY + 1000);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 180, 'at the cap: nothing');
  assert.equal(f.events(who.principalId).filter(([s]) => s === 'daily_refill').length, 2, 'no zero-point event');
  // Above the cap (a refund after the owner lowered it, or points held before): never reduced, no refill.
  f.store.run('UPDATE web_points_balance SET balance=400 WHERE principal_id=?', who.principalId);
  f.setNow(midnight + 3 * DAY + 1000);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 400);
});

test('22a other grants (the signup bonus and an administrator grant) never push a daily_refill player above the cap', (t) => {
  const { f, who } = refillPlayer(t, { amount: 50, cap: 160 });
  assert.equal(f.balance(who.principalId), 150);
  assert.equal(grantPoints(f.store, f.clock(), who.principalId, 'admin-1', 100), 10, 'only up to the cap');
  assert.equal(f.balance(who.principalId), 160);
  assert.equal(grantPoints(f.store, f.clock(), who.principalId, 'admin-1', 5), 0, 'at the cap: nothing');
  assert.deepEqual(f.events(who.principalId).at(-1), ['grant', 10]);
  // The opening balance is a grant too: a player whose balance row does not exist yet when the entitlement starts is clamped.
  const f2 = tiersFixture(t);
  const batch = f2.create(f2.owner, { tier: { kind: 'daily_refill', dailyAmount: 10, cap: 60 } });
  const late = f2.player('late', { signedUp: true, opening: false });
  f2.redeem(late, batch.codes![0]!);
  assert.equal(f2.balance(late.principalId), 60, 'opening 100 stops at the cap of 60 (the refill then adds nothing)');
  // A lowered cap never removes what is held.
  const owner = f2.sessionIdOf(f2.owner);
  assert.ok(owner);
  f2.tiers.editBatch({ adminSessionId: owner, requestId: 'lower', batchId: batch.batchId, dailyAmount: 10, cap: 20 });
  f2.setNow(f2.clock() + DAY);
  modelChoiceState(f2.store, f2.clock(), late.principalId);
  assert.equal(f2.balance(late.principalId), 60);
});

test('22a expiry and revocation fall back to a registered player with the balance that remains - never TRIAL_EXPIRED', (t) => {
  for (const ending of ['expiry', 'revocation'] as const) {
    const { f, who, batch } = refillPlayer(t, { durationDays: 3, name: `p-${ending}` });
    // Window long over: the player is a registered player past the 7-day trial.
    f.store.run(
      "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=?",
      T0 - 30 * DAY,
      T0 - 23 * DAY,
      who.principalId,
    );
    assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.kind, 'daily_refill');
    if (ending === 'expiry') f.setNow(f.clock() + 3 * DAY + 1);
    else {
      const detail = f.tiers.batchDetail(f.sessionIdOf(f.owner), batch.batchId);
      const redeemed = detail.codes.find((c) => c.state === 'redeemed')!;
      f.tiers.revokeEntitlement(f.sessionIdOf(f.owner), redeemed.id);
    }
    const eff = effectiveTier(f.store, who.principalId, f.clock())!;
    assert.deepEqual([eff.tier, eff.kind], ['registered', 'registered'], ending);
    assert.equal(hasPoints(f.store, who.principalId, f.clock()), true);
    // No refill any more, the balance stays, content stays live, and a reply is charged like any registered player's.
    const held = f.balance(who.principalId)!;
    assert.equal(applyDailyRefill(f.store, f.clock(), who.principalId), 0);
    assert.equal(f.balance(who.principalId), held);
    const verdict = code(() => requireWebContent(f.store, { now: f.clock }, who.principalId, who.worldId));
    assert.equal(verdict, 'ok', `${ending}: ${verdict}`);
    const op = f.admit(who.principalId, `after-${ending}`);
    assert.ok(f.balance(who.principalId)! < held, 'charged as a registered player');
    f.finish(op.operationId, 'published');
    assert.equal(
      f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', who.principalId)!.kind,
      'guest',
    );
  }
});

test('22a an expired entitlement of a player with NO balance left is told its free replies are used up, not that a trial ended', (t) => {
  const { f, who } = refillPlayer(t, { durationDays: 1 });
  f.store.run('UPDATE web_points_balance SET balance=0 WHERE principal_id=?', who.principalId);
  f.setNow(f.clock() + 2 * DAY);
  assert.equal(
    code(() => f.admit(who.principalId, 'broke')),
    'TRIAL_EXHAUSTED',
  );
});

test('22a JS and SQL agree on the tier of every shape, and on content liveness (extends 17i)', (t) => {
  const f = tiersFixture(t);
  const unlimited = f.create(f.owner, { tier: { kind: 'unlimited' }, count: 6 });
  const refill = f.create(f.owner, { count: 6 });
  const shapes: { name: string; make: () => { principalId: string; worldId: string } }[] = [
    { name: 'plain guest', make: () => f.player('s1') },
    { name: 'guest+bonus', make: () => f.player('s2', { bonus: true }) },
    { name: 'guest+login', make: () => f.player('s3', { login: true }) },
    {
      name: 'registered+unlimited',
      make: () => {
        const p = f.player('s4', { signedUp: true });
        f.redeem(p, unlimited.codes![0]!);
        return p;
      },
    },
    {
      name: 'registered+refill',
      make: () => {
        const p = f.player('s5', { signedUp: true });
        f.redeem(p, refill.codes![0]!);
        return p;
      },
    },
    {
      name: 'registered+both (unlimited wins)',
      make: () => {
        const p = f.player('s6', { signedUp: true });
        f.redeem(p, refill.codes![1]!);
        f.redeem(p, unlimited.codes![1]!);
        return p;
      },
    },
    {
      name: 'registered+revoked',
      make: () => {
        const p = f.player('s7', { signedUp: true });
        f.redeem(p, unlimited.codes![2]!);
        f.store.run('UPDATE web_entitlements SET revoked_at=? WHERE principal_id=?', f.clock(), p.principalId);
        return p;
      },
    },
    {
      name: 'registered+expired',
      make: () => {
        const p = f.player('s8', { signedUp: true });
        f.redeem(p, unlimited.codes![3]!);
        f.store.run(
          'UPDATE web_entitlements SET starts_at=?,expires_at=? WHERE principal_id=?',
          f.clock() - 5,
          f.clock(),
          p.principalId,
        );
        return p;
      },
    },
    // Named exception (Part 22x): the 'legacy invite active' shape is gone with the kind; migration 126 makes it a guest (see
    // web-legacy-invites-126.integration.test.ts, which asserts the JS/SQL agreement for it).
  ];
  const clock = { now: f.clock };
  const schema = f.store.get<{ user_version: number }>('PRAGMA user_version')!.user_version;
  const seen = new Map<string, string>();
  for (const shape of shapes) {
    const p = shape.make();
    const js = effectiveTier(f.store, p.principalId, f.clock())!;
    const sql = webTierSql(schema, true, f.clock());
    const row = f.store.get<{ tier: string }>(
      `SELECT ${sql.sql} AS tier FROM web_principals p WHERE p.id=?`,
      ...sql.args,
      p.principalId,
    )!;
    assert.equal(row.tier, js.kind, `${shape.name}: SQL ${row.tier}, JS ${js.kind}`);
    // The tier readers all agree with the one function.
    assert.equal(playerTier(f.store, p.principalId, f.clock()), js.tier, shape.name);
    assert.equal(recallsMemory(f.store, 'guest', p.principalId), js.tier !== 'guest', shape.name);
    // Content liveness: JS verdict vs the stage queue's SQL.
    const retention = claimRetention(schema, f.clock(), true);
    const claim = !!f.store.get(
      `SELECT 1 FROM (SELECT ? AS principal_id, ? AS world_id) o WHERE 1=1 ${retention.sql}`,
      p.principalId,
      p.worldId,
      ...retention.args,
    );
    const live = code(() => requireWebContent(f.store, clock, p.principalId, p.worldId)) === 'ok';
    assert.equal(claim, live, `${shape.name}: claim ${claim}, live ${live}`);
    seen.set(shape.name, js.kind);
  }
  assert.deepEqual(
    [...seen.entries()],
    [
      ['plain guest', 'guest'],
      ['guest+bonus', 'registered'],
      ['guest+login', 'registered'],
      ['registered+unlimited', 'unlimited'],
      ['registered+refill', 'daily_refill'],
      ['registered+both (unlimited wins)', 'unlimited'],
      ['registered+revoked', 'registered'],
      ['registered+expired', 'registered'],
    ],
  );
});

test('22a the operator inspect counts players by effective tier - numbers only', (t) => {
  const f = tiersFixture(t);
  const refill = f.create(f.owner, { count: 2 });
  const a = f.player('a', { signedUp: true });
  f.redeem(a, refill.codes![0]!);
  f.player('b', { signedUp: true });
  f.player('c');
  const report = inspectWebAuthority(
    { all: (sql, ...params) => f.store.all(sql, ...params) },
    { active: 'inline', inline: [], r2: [] },
    {},
    { available: true, providers: [] },
    {},
    f.clock(),
    null,
    { freeTier: true },
  ) as unknown as { tiers: Record<string, number> };
  assert.deepEqual(report.tiers, {
    guest: 1,
    registered: 1,
    unlimited: 0,
    daily_refill: 1,
    account: 0,
  });
  assert.equal(JSON.stringify(report.tiers).includes('principal'), false);
});

// ---- 邀请与额度 (admin) -------------------------------------------------------------------------------------------------

test('22a batches: codes are shown once and stored as digests, creation is idempotent per requestId, the list has counts only', (t) => {
  const f = tiersFixture(t);
  const sid = f.sessionIdOf(f.owner);
  const input = {
    adminSessionId: sid,
    requestId: 'req-1',
    name: '春季内测',
    count: 3,
    tier: { kind: 'daily_refill' as const, dailyAmount: 50, cap: 1000 },
    durationDays: 30,
    redeemBy: T0 + 10 * DAY,
  };
  const first = f.tiers.createBatch(input);
  assert.equal(first.duplicate, false);
  assert.equal(first.codes!.length, 3);
  assert.equal(new Set(first.codes).size, 3);
  for (const c of first.codes!) {
    assert.match(c, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      f.store.get('SELECT 1 FROM web_invite_codes WHERE code_digest=?', c),
      undefined,
      'the raw code is not stored',
    );
  }
  const replay = f.tiers.createBatch(input);
  assert.deepEqual([replay.duplicate, replay.codes, replay.batchId], [true, null, first.batchId]);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_invite_codes')!.n, 3, 'a replay makes no codes');
  assert.throws(() => f.tiers.createBatch({ ...input, count: 4 }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(() => f.tiers.createBatch({ ...input, requestId: 'req-2', count: 0 }), /WEB_INVITE_TERMS_REQUIRED/);
  assert.throws(
    () =>
      f.tiers.createBatch({ ...input, requestId: 'req-3', tier: { kind: 'daily_refill', dailyAmount: 60, cap: 50 } }),
    /WEB_INVITE_TERMS_REQUIRED/,
    'the cap cannot be below the daily amount',
  );
  // One code is redeemed, one revoked; the list counts them.
  const who = f.player('ann', { signedUp: true });
  f.redeem(who, first.codes![0]!);
  const detail = f.tiers.batchDetail(sid, first.batchId);
  f.tiers.revokeCode(sid, detail.codes.find((c) => c.state === 'unused')!.id);
  const list = f.tiers.listBatches(sid).batches;
  assert.equal(list.length, 1);
  assert.deepEqual(
    { ...list[0]! },
    {
      id: first.batchId,
      name: '春季内测',
      tier: 'daily_refill',
      dailyAmount: 50,
      cap: 1000,
      durationDays: 30,
      redeemBy: T0 + 10 * DAY,
      createdAt: T0,
      codes: 3,
      redeemed: 1,
      revoked: 1,
      holders: 1,
    },
  );
  // No player email, id or nickname anywhere an administrator can read; the holder is only a 玩家编号.
  const json = JSON.stringify([list, detail, f.tiers.batchDetail(sid, first.batchId)]);
  for (const secret of ['example.com', 'principal-', 'player-', 'world-', 'token-'])
    assert.equal(json.includes(secret), false, secret);
  const redeemed = f.tiers.batchDetail(sid, first.batchId).codes.find((c) => c.state === 'redeemed')!;
  assert.match(redeemed.playerNumber!, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.equal(redeemed.expiresAt, T0 + 30 * DAY);
});

test('22a permissions: create, list and revoke need the owner or invites.manage; editing N and cap is owner-only; everything is audit-logged', (t) => {
  const f = tiersFixture(t);
  const nobody = f.sessionIdOf(f.member(['invites.read'], 'reader'));
  const manager = f.sessionIdOf(f.member(['invites.manage'], 'manager'));
  const owner = f.sessionIdOf(f.owner);
  const base = {
    requestId: 'p-1',
    name: 'b',
    count: 1,
    tier: { kind: 'daily_refill' as const, dailyAmount: 50, cap: 1000 },
    durationDays: null,
    redeemBy: null,
  };
  assert.throws(() => f.tiers.createBatch({ ...base, adminSessionId: nobody }), /ADMIN_PERMISSION_REQUIRED/);
  assert.throws(() => f.tiers.listBatches(nobody), /ADMIN_PERMISSION_REQUIRED/);
  const made = f.tiers.createBatch({ ...base, adminSessionId: manager });
  assert.equal(f.tiers.listBatches(manager).batches.length, 1);
  assert.throws(() => f.tiers.revokeBatch(nobody, made.batchId), /ADMIN_PERMISSION_REQUIRED/);
  const edit = { requestId: 'e-1', batchId: made.batchId, dailyAmount: 40, cap: 800 };
  assert.throws(() => f.tiers.editBatch({ ...edit, adminSessionId: manager }), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => f.tiers.editBatch({ ...edit, adminSessionId: nobody }), /ADMIN_PERMISSION_REQUIRED/);
  assert.equal(f.store.get<{ daily_amount: number }>('SELECT daily_amount FROM web_invite_batches')!.daily_amount, 50);
  const done = f.tiers.editBatch({ ...edit, adminSessionId: owner });
  assert.deepEqual([done.duplicate, done.holders], [false, 0]);
  assert.deepEqual(f.tiers.editBatch({ ...edit, adminSessionId: owner }), { batchId: made.batchId, duplicate: true });
  assert.throws(() => f.tiers.editBatch({ ...edit, dailyAmount: 41, adminSessionId: owner }), /IDEMPOTENCY_CONFLICT/);
  assert.throws(
    () => f.tiers.editBatch({ ...edit, requestId: 'e-2', adminSessionId: owner }),
    /WEB_INVITE_TERMS_REQUIRED/,
    'changing nothing is refused',
  );
  assert.throws(
    () => f.tiers.editBatch({ ...edit, requestId: 'e-3', dailyAmount: 900, cap: 800, adminSessionId: owner }),
    /WEB_INVITE_TERMS_REQUIRED/,
  );
  f.tiers.revokeBatch(manager, made.batchId);
  const audit = f.store.all<{ action: string; target_id: string }>(
    'SELECT action,target_id FROM web_admin_audit ORDER BY seq',
  );
  const actions = audit.map((a) => a.action.split(':')[0]);
  for (const wanted of ['invite-batch-created', 'invite-batch-edited', 'invite-batch-revoked'])
    assert.ok(actions.includes(wanted), wanted);
  assert.equal(
    audit.some((a) => /principal|player|example/.test(a.action + a.target_id)),
    false,
  );
  const change = f.store.get<{ old_amount: number; new_amount: number; old_cap: number; new_cap: number }>(
    'SELECT old_amount,new_amount,old_cap,new_cap FROM web_invite_batch_changes',
  )!;
  assert.deepEqual({ ...change }, { old_amount: 50, new_amount: 40, old_cap: 1000, new_cap: 800 });
});

test('22a editing N and cap applies to every holder from their NEXT refill; lowering the cap removes nothing', (t) => {
  const { f, who, batch } = refillPlayer(t, { amount: 50, cap: 1000 });
  const owner = f.sessionIdOf(f.owner);
  const second = f.player('bob', { signedUp: true });
  f.redeem(second, batch.codes![1]!);
  assert.equal(f.balance(who.principalId), 150);
  const edit = f.tiers.editBatch({
    adminSessionId: owner,
    requestId: 'e',
    batchId: batch.batchId,
    dailyAmount: 30,
    cap: 160,
  });
  assert.equal(edit.holders, 2, 'the confirm dialog names how many players hold the batch');
  assert.equal(f.balance(who.principalId), 150, 'nothing changes at once');
  f.setNow(f.clock() + DAY);
  for (const p of [who, second]) modelChoiceState(f.store, f.clock(), p.principalId);
  assert.equal(f.balance(who.principalId), 160, 'new N=30 but only 10 fit under the new cap');
  f.setNow(f.clock() + DAY);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 160);
  // Lower the cap under the balance: nothing is taken away, there is just no refill.
  f.tiers.editBatch({ adminSessionId: owner, requestId: 'e2', batchId: batch.batchId, dailyAmount: 30, cap: 100 });
  f.setNow(f.clock() + DAY);
  modelChoiceState(f.store, f.clock(), who.principalId);
  assert.equal(f.balance(who.principalId), 160);
});

test('22a revoking: an unredeemed code, a whole batch (unredeemed codes only), and a redeemed code’s entitlement', (t) => {
  const f = tiersFixture(t);
  const sid = f.sessionIdOf(f.owner);
  const batch = f.create(f.owner, { count: 4 });
  const who = f.player('ann', { signedUp: true });
  f.redeem(who, batch.codes![0]!);
  let detail = f.tiers.batchDetail(sid, batch.batchId);
  assert.throws(
    () => f.tiers.revokeCode(sid, detail.codes.find((c) => c.state === 'redeemed')!.id),
    /WEB_INVITE_ALREADY_REDEEMED/,
  );
  f.tiers.revokeCode(sid, detail.codes.find((c) => c.state === 'unused')!.id);
  assert.equal(f.tiers.revokeBatch(sid, batch.batchId).revoked, 2, 'the two codes still unused');
  detail = f.tiers.batchDetail(sid, batch.batchId);
  assert.deepEqual(detail.codes.map((c) => c.state).sort(), ['redeemed', 'revoked', 'revoked', 'revoked']);
  assert.equal(
    code(() => f.redeem(f.player('bob', { signedUp: true }), batch.codes![1]!)),
    'WEB_INVITE_UNAVAILABLE',
  );
  assert.equal(
    effectiveTier(f.store, who.principalId, f.clock())!.kind,
    'daily_refill',
    'a revoked batch leaves its holders alone',
  );
  // Ending a redeemed code's entitlement: the player is a registered player at once.
  f.tiers.revokeEntitlement(sid, detail.codes.find((c) => c.state === 'redeemed')!.id);
  assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.kind, 'registered');
  assert.equal(f.tiers.batchDetail(sid, batch.batchId).codes.filter((c) => c.state === 'ended').length, 1);
  assert.equal(f.tiers.listBatches(sid).batches[0]!.holders, 0);
  assert.equal(
    f.tiers.revokeEntitlement(sid, detail.codes.find((c) => c.state === 'ended' || c.state === 'redeemed')!.id)
      .duplicate,
    true,
  );
});

test('22a a legacy unredeemed code (no batch of its own) grants unlimited, and every code can only be used once', (t) => {
  const f = tiersFixture(t);
  // A code issued before this Part: batch_id is set by migration 125 to the legacy batch of its name.
  f.store.run("INSERT INTO admin_sessions VALUES ('legacy-admin','h',?,?,NULL)", T0, T0 + DAY);
  const legacy = f.tiers['digest']('code-v1', 'L'.repeat(43));
  f.store.run(`INSERT INTO web_invite_batches(id,name,tier,created_at) VALUES ('legacy:old','old','unlimited',1)`);
  f.store.run(
    `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,capacity,redeemed_count,status,batch,created_by,created_at,batch_id)
    VALUES ('c-old',?,?,?,1,0,'active','old','legacy-admin',1,'legacy:old')`,
    legacy,
    'old-1',
    'd',
  );
  const who = f.player('ann', { signedUp: true });
  const done = f.redeem(who, 'L'.repeat(43));
  assert.equal(done.entitlement.kind, 'unlimited');
  assert.equal(
    code(() => f.redeem(f.player('bob', { signedUp: true }), 'L'.repeat(43))),
    'WEB_INVITE_UNAVAILABLE',
  );
  assert.equal(effectiveTier(f.store, who.principalId, f.clock())!.kind, 'unlimited');
});
