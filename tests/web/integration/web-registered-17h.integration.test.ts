import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { WebAdmission } from '../../../apps/server/admission/web-admission.ts';
import { hasPoints, modelChoiceState } from '../../../apps/server/admission/web-points.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import type { WebStore } from '../../../apps/server/platform/store.ts';
import { enableModelChoice } from '../fixtures/model-choice.ts';
import { schema124 } from '../fixtures/model-settings.ts';
import { ensureRegisteredBonus, signupBonusEmailKey } from '../../../apps/server/admission/web-registered.ts';

const ip = 'a'.repeat(64);
const characterId = 'fixture-character';
const T0 = 1_700_000_000_000;
const DAY = 86_400_000;

/**
 * Part 17h. Real schema-123 store, free tier + model choice on, lifecycle on (in-memory = provider runtime). Players are
 * built in the state production holds them in: a guest past its 7-day window, with or without a signup bonus row, a
 * login, a balance row, or an invite grant.
 */
function world(t: TestContext, options: { key?: boolean } = {}) {
  const store = schema124();
  t.after(() => store.close());
  Object.assign(store, { webIpKeyFingerprint: () => 'f'.repeat(64) });
  enableModelChoice(store);
  let now = T0,
    seq = 0;
  const bonusKey = signupBonusEmailKey(Buffer.alloc(32, 7));
  const admission = new WebAdmission(
    store as WebStore,
    { now: () => now },
    () => `id-${++seq}`,
    options.key === false ? undefined : bonusKey,
  );
  store.run('INSERT INTO character_templates(id,version,config_json) VALUES (?,?,?)', characterId, 1, '{}');
  const player = (
    name: string,
    o: { bonus?: boolean; login?: string; trialEnded?: boolean; trialUsed?: number } = {},
  ) => {
    const playerId = `player-${name}`,
      worldId = `world-${name}`,
      principalId = `principal-${name}`;
    store.transaction(() => {
      store.run('INSERT INTO api_players VALUES (?,?)', playerId, now);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, playerId, 'Asia/Singapore', '{}');
      store.run("INSERT INTO world_characters VALUES (?,?,'new')", worldId, characterId);
    });
    admission.registerGuest({ principalId, playerId, worldId });
    if (o.trialUsed) store.run('UPDATE web_principals SET trial_used=? WHERE id=?', o.trialUsed, principalId);
    if (o.bonus) store.run('INSERT INTO web_signup_bonus(principal_id,granted_at) VALUES (?,?)', principalId, now);
    if (o.login)
      store.run(
        'INSERT INTO web_player_logins(principal_id,email_norm,password_hash,created_at,password_changed_at,last_seen_at) VALUES (?,?,?,?,?,?)',
        principalId,
        o.login,
        'x',
        now,
        now,
        now,
      );
    if (o.trialEnded)
      store.run(
        "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=?",
        now - 30 * DAY,
        now - 23 * DAY,
        principalId,
      );
    return principalId;
  };
  /** The principal is an invited player; the grant is active, revoked or expired. */
  const invite = (principalId: string, grant: 'active' | 'revoked' | 'expired') => {
    store.run("UPDATE web_principals SET kind='invite',revision=revision+1 WHERE id=?", principalId);
    store.run(
      "UPDATE web_guest_retention SET state='protected',started_at=NULL,expires_at=NULL,revision=revision+1 WHERE principal_id=?",
      principalId,
    );
    store.db.exec('PRAGMA foreign_keys=OFF');
    store.run(
      'INSERT INTO web_invite_grants(id,invite_id,principal_id,player_id,world_id,redeemed_at,expires_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)',
      `grant-${principalId}`,
      `invite-${principalId}`,
      principalId,
      principalId.replace('principal', 'player'),
      principalId.replace('principal', 'world'),
      1,
      grant === 'expired' ? now - DAY : null,
      grant === 'revoked' ? now - DAY : null,
    );
  };
  const admit = (principalId: string, requestId: string) =>
    admission.admit({ principalId, requestId, characterId, text: '你好', ipHash: ip });
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      if (error instanceof DomainError) return error.code;
      throw error;
    }
    return 'ok';
  };
  const balanceRows = () =>
    store.all<{ principal_id: string; balance: number }>('SELECT principal_id,balance FROM web_points_balance');
  const events = (principalId: string) =>
    store
      .all<{ source: string; delta: number }>(
        'SELECT source,delta FROM web_points_events WHERE principal_id=? ORDER BY id',
        principalId,
      )
      .map((e) => [e.source, e.delta]);
  const balance = (principalId: string) =>
    store.get<{ balance: number }>('SELECT balance FROM web_points_balance WHERE principal_id=?', principalId)?.balance;
  const bonusRows = () =>
    store.all<{ principal_id: string }>('SELECT principal_id FROM web_signup_bonus').map((r) => r.principal_id);
  return {
    store,
    bonusKey,
    events,
    balance,
    bonusRows,
    admission,
    player,
    invite,
    admit,
    code,
    balanceRows,
    now: () => now,
    advance: (ms: number) => void (now += ms),
  };
}

const reply = (w: ReturnType<typeof world>, principalId: string, requestId: string) => {
  const { operationId } = w.admit(principalId, requestId);
  return w.store.get<{ chosen: string; points_charged: number }>(
    'SELECT chosen,points_charged FROM web_operation_models WHERE operation_id=?',
    operationId,
  )!;
};

// ---- 2a ------------------------------------------------------------------------------------------------------------------
test('2a: a plain guest whose 7-day window is over is refused (TRIAL_EXPIRED); no balance, policy or event is created, no picker, not metered', (t) => {
  const w = world(t);
  // The owner allows guests a second model, so a trial guest normally HAS a picker: it must be gone once the trial is over.
  w.store.run("UPDATE web_model_settings SET allowed_guest=1 WHERE model='gemini'");
  const live = w.player('live');
  assert.ok(modelChoiceState(w.store, w.now(), live), 'a trial guest inside its window still sees the picker');
  const p = w.player('a', { trialEnded: true });
  assert.equal(
    w.code(() => w.admit(p, 'r1')),
    'TRIAL_EXPIRED',
  );
  assert.equal(hasPoints(w.store, p, w.now()), false);
  assert.equal(modelChoiceState(w.store, w.now(), p), null, 'no picker, no balance shown');
  assert.equal(w.balanceRows().length, 0, 'no balance row');
  assert.equal(w.store.get('SELECT 1 FROM web_points_policy'), undefined);
  assert.equal(w.store.get('SELECT 1 FROM web_points_events'), undefined);
});

// ---- 2b ------------------------------------------------------------------------------------------------------------------
test('2b: a signed-up guest (signup bonus) whose window ended long ago is admitted on points, also with no balance row yet (signed up before 123) and without a login row', (t) => {
  const w = world(t);
  const p = w.player('b', { bonus: true, login: 'b@example.com', trialEnded: true, trialUsed: 1 });
  assert.equal(w.balance(p), undefined, 'signed up before migration 123: no balance row yet');
  const charged = reply(w, p, 'r1');
  assert.equal(charged.points_charged, 12, 'deepseek 10 + voice 2');
  assert.equal(
    w.balance(p),
    100 + 4 * 10 - 12,
    'opening balance (21f: 100 + 4 unused trial replies x 10) less the reply',
  );
  // The same without any login row (the bonus row alone makes it a kept account).
  const q = w.player('q', { bonus: true, trialEnded: true });
  assert.equal(reply(w, q, 'r1').points_charged, 12);
});

// ---- 2c ------------------------------------------------------------------------------------------------------------------
test('2c: an invited player whose grant was revoked or expired (no login, no bonus) gets WEB_INVITE_ACCESS_REQUIRED - not the trial text - no balance, no picker', (t) => {
  const w = world(t);
  for (const [name, grant] of [
    ['r', 'revoked'],
    ['e', 'expired'],
  ] as const) {
    const p = w.player(name);
    w.invite(p, grant);
    assert.equal(
      w.code(() => w.admit(p, 'r1')),
      'WEB_INVITE_ACCESS_REQUIRED',
      grant,
    );
    assert.equal(modelChoiceState(w.store, w.now(), p), null, `${grant}: no picker`);
  }
  assert.equal(w.balanceRows().length, 0);
  // An invited player whose grant is active is unchanged: a picker, nothing charged.
  const ok = w.player('ok');
  w.invite(ok, 'active');
  assert.equal(reply(w, ok, 'r1').points_charged, 0);
});

// ---- 2d ------------------------------------------------------------------------------------------------------------------
test('2d: an old signed-in account (login, NO bonus row, window long over) is never TRIAL_EXPIRED: it is granted the bonus once and the reply is charged in points', (t) => {
  const w = world(t);
  const p = w.player('d', { login: 'old@example.com', trialEnded: true, trialUsed: 1 });
  assert.deepEqual(w.bonusRows(), []);
  const charged = reply(w, p, 'r1');
  assert.equal(charged.points_charged, 12);
  assert.deepEqual(w.bonusRows(), [p], 'the bonus row is written on the first touch');
  assert.equal(w.balance(p), 100 + 4 * 10 - 12, 'the 21f opening balance, less the reply');
  assert.deepEqual(w.events(p), [
    ['bonus', 140],
    ['spend', -12],
  ]);
  // A second reply and a second touch grant nothing again.
  reply(w, p, 'r2');
  assert.equal(ensureRegisteredBonus(w.store, w.bonusKey, w.now(), p), false);
  assert.equal(w.events(p).filter(([source]) => source === 'bonus').length, 1);
  assert.equal(w.store.all('SELECT 1 FROM web_bonus_emails').length, 1);
});

test('2d: the bonus is granted once per CANONICAL e-mail: a second principal behind the same address is refused the grant but still admitted as registered', (t) => {
  const w = world(t);
  const first = w.player('first', { login: 'a.b+one@gmail.com', trialEnded: true, trialUsed: 3 });
  const second = w.player('second', { login: 'ab+two@googlemail.com', trialEnded: true, trialUsed: 3 });
  reply(w, first, 'r1');
  assert.deepEqual(w.bonusRows(), [first]);
  // Out of window: never TRIAL_EXPIRED; no bonus, no points -> the "free replies used up" answer.
  assert.equal(
    w.code(() => w.admit(second, 'r1')),
    'TRIAL_EXHAUSTED',
  );
  assert.deepEqual(w.bonusRows(), [first], 'the address already received a bonus on another principal');
  // (The refusal is decided again on every touch, so nothing persists from the rejected request: balance 0 or no row.)
  assert.equal(w.balance(second) ?? 0, 0, 'registered with whatever it has: nothing');
  assert.equal(modelChoiceState(w.store, w.now(), second)!.metered, true);
  // Touching it again never opens a richer account.
  w.admit(first, 'r2');
  assert.equal(
    w.code(() => w.admit(second, 'r2')),
    'TRIAL_EXHAUSTED',
  );
  assert.equal(w.balance(second) ?? 0, 0);
});

test('2d: a refused principal whose window is still open keeps the value of its unused trial replies as points', (t) => {
  const w = world(t);
  w.store.run('INSERT INTO web_bonus_emails(email_hmac,granted_at) VALUES (?,?)', w.bonusKey('again@example.com'), 1);
  const p = w.player('again', { login: 'again@example.com', trialUsed: 1 });
  assert.equal(reply(w, p, 'r1').points_charged, 12);
  assert.equal(w.balance(p), 4 * 10 - 12, 'no signup balance (the address had it), but the 4 unused trial replies');
  assert.deepEqual(w.bonusRows(), []);
});

test('2d: an invited player whose grant lapsed but who has an email login chats as registered (points), not WEB_INVITE_ACCESS_REQUIRED; with the production shape (bonus + login + old invite) too', (t) => {
  const w = world(t);
  const login = w.player('l', { login: 'lapsed@example.com', trialEnded: true, trialUsed: 1 });
  w.invite(login, 'expired');
  assert.equal(reply(w, login, 'r1').points_charged, 12);
  assert.deepEqual(w.bonusRows(), [login]);
  // Production: signed up (bonus 140), redeemed an invite, the invite expired. The page showed 140 points and the picker, and
  // sending was answered 410.
  const shape = w.player('p', { bonus: true, login: 'prod@example.com', trialUsed: 1 });
  w.invite(shape, 'revoked');
  assert.equal(modelChoiceState(w.store, w.now(), shape)!.balance, 140);
  assert.equal(reply(w, shape, 'r1').points_charged, 12);
  assert.equal(w.balance(shape), 128);
  // Its grant still active: the invited player is unmetered, exactly as before, even with a login.
  const active = w.player('act', { login: 'active@example.com', bonus: true });
  w.invite(active, 'active');
  assert.equal(reply(w, active, 'r1').points_charged, 0);
});

test('2d: with the free tier OFF nothing changes: a login alone does not keep an ended trial', (t) => {
  const w = world(t);
  Object.assign(w.store, { publicFreeTier: false });
  const p = w.player('off', { login: 'off@example.com', trialEnded: true });
  assert.equal(
    w.code(() => w.admit(p, 'r1')),
    'TRIAL_EXPIRED',
  );
  assert.deepEqual(w.bonusRows(), []);
});

test('2d: a player with a login and no key available (no way to hash the address) is still never TRIAL_EXPIRED, and nothing is invented', (t) => {
  const w = world(t, { key: false });
  const p = w.player('nk', { login: 'nk@example.com', trialEnded: true });
  assert.equal(
    w.code(() => w.admit(p, 'r1')),
    'TRIAL_EXHAUSTED',
  );
  assert.deepEqual(w.bonusRows(), []);
  assert.equal(w.balanceRows().length, 0);
});
