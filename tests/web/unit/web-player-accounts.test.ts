import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import {
  PLAYER_LIMITS,
  WebPlayerAccounts,
  playerNickname,
  type PlayerMailer,
} from '../../../apps/server/identity/web-player-accounts.ts';
import { routeWebPlayerAccounts } from '../../../apps/server/identity/web-player-routes.ts';
import { maskEmail, normalizeEmail } from '../../../apps/server/identity/email-address.ts';
import { playerMailText } from '../../../apps/server/cloudflare/web-player-mail.ts';
import { purgePlayerLogins, playerLoginsRemain } from '../../../apps/server/identity/web-player-purge.ts';
import { WebInvites } from '../../../apps/server/invites/web-invites.ts';
import { WebInviteActions } from '../../../apps/server/invites/web-invite-actions.ts';
import { webProviderHTTPError } from '../../../apps/server/platform/web-provider-http-error.ts';
import { playerIntroduction } from '../../../apps/server/conversation/player-profile.ts';
import { userStore } from '../../../apps/server/platform/store-boundary.ts';
import { DomainError, RetryAfterError } from '../../../packages/domain/errors.ts';

const origin = 'https://synthetic.local';
const T0 = 1_800_000_000_000;
const IP = 'a'.repeat(64);
const OTHER_IP = 'b'.repeat(64);
const PASSWORD = 'correct horse battery';
type Sent = Parameters<PlayerMailer['send']>[0];

/** A real identity, real invite core and real 118 SQL over an in-memory store; the clock and the mailer are the test's. */
function fixture(
  t: test.TestContext,
  options: { signupEnabled?: boolean; dailyCap?: number; failMail?: boolean } = {},
) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  Object.assign(store, { instanceId: 'synthetic-instance' });
  store.db.exec(`
    CREATE TABLE web_instance(singleton INTEGER PRIMARY KEY,recovery_epoch TEXT NOT NULL);
    INSERT INTO web_instance VALUES (1,'synthetic-epoch');
    CREATE TABLE web_principals(id TEXT PRIMARY KEY,player_id TEXT NOT NULL,world_id TEXT NOT NULL,
      kind TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE web_sessions(id TEXT PRIMARY KEY,token_digest TEXT NOT NULL UNIQUE,
      principal_id TEXT NOT NULL REFERENCES web_principals(id),account_id TEXT,recovery_epoch TEXT NOT NULL,
      security_revision INTEGER NOT NULL,csrf_seed BLOB NOT NULL,created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,revoked_at INTEGER);
    CREATE TABLE web_identity_receipts(old_session_id TEXT,new_session_id TEXT,revoked_at INTEGER,expires_at INTEGER,
      successful_retrievals INTEGER DEFAULT 0);
    CREATE TABLE web_guest_retention(principal_id TEXT PRIMARY KEY,world_id TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unstarted',revision INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER,expires_at INTEGER);
    CREATE TABLE web_provider_attempts(operation_id TEXT);
    PRAGMA user_version=112;
  `);
  for (const name of ['111_invite_core.sql', '112_invite_identity.sql', '118_player_logins.sql'])
    store.db.exec(readFileSync(new URL(`../../../apps/server/web-migrations/${name}`, import.meta.url), 'utf8'));
  store.db.exec('PRAGMA user_version=118');
  let now = T0,
    counter = 0;
  const clock = { now: () => now };
  const webStore = store as unknown as WebStore;
  const identity = new WebIdentity(webStore, {
    origin,
    cookieName: '__Host-synthetic',
    clock,
    keys: { keyId: 'synthetic-only', sealKey: Buffer.alloc(32, 1), requestKey: Buffer.alloc(32, 2) },
    nextId: () => `identity-${++counter}`,
  });
  const sent: Sent[] = [];
  const waits: Promise<void>[] = [];
  const mailer: PlayerMailer = {
    send: async (message) => {
      if (options.failMail) throw new Error('mail down');
      sent.push(message);
    },
    waitUntil: (task) => void waits.push(task),
  };
  const accountsWith = (signupEnabled: boolean, cap = options.dailyCap ?? PLAYER_LIMITS.defaultDailyCap) =>
    new WebPlayerAccounts(webStore, identity, {
      origin,
      requestKey: Buffer.alloc(32, 2),
      clock,
      mailer: signupEnabled ? mailer : null,
      signupEnabled,
      dailyCap: cap,
      nextId: () => `challenge-${++counter}`,
    });
  const accounts = accountsWith(options.signupEnabled ?? true);
  const adminCookie = 'D'.repeat(43);
  const invites = new WebInvites(store, {
    clock,
    codeKey: Buffer.alloc(32, 3),
    authorize: identity.authorizeInviteAction.bind(identity),
    identity,
    nextId: () => `invite-${++counter}`,
  });
  const actions = (requireLogin?: (token: string) => void) =>
    new WebInviteActions(store, clock, origin, invites, identity, { requireLogin });
  store.run(
    'INSERT INTO admin_sessions VALUES (?,?,?,?,NULL)',
    'admin',
    'x'.repeat(64),
    now,
    now + 10 * 24 * 3_600_000,
  );
  const guest = () => {
    // The base store owns api_players / worlds; the identity writes them in bootstrap.
    const boot = identity.bootstrap();
    return {
      token: boot.issuedToken!,
      csrf: boot.csrf,
      session: { token: boot.issuedToken!, csrf: boot.csrf, origin },
    };
  };
  const latestCode = () => {
    const mail = [...sent].reverse().find((m) => m.kind === 'code');
    assert.ok(mail?.code, 'a code mail was sent');
    return mail;
  };
  const flush = async () => {
    await Promise.all(waits.splice(0));
  };
  /** Request → verify → complete for a fresh guest; returns the signed-up actor. */
  const signUp = async (email = 'Player@Example.com', nickname = '阿泡', ip = IP) => {
    const actor = guest();
    const challenge = accounts.requestCode({ purpose: 'signup', email, ipHash: ip, origin, session: actor.session });
    await flush();
    accounts.verifyCode({
      challengeId: challenge.challengeId,
      code: latestCode().code!,
      origin,
      session: actor.session,
    });
    const done = await accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname,
      session: actor.session,
      purpose: 'signup',
    });
    return { ...actor, challenge, done };
  };
  const principalOf = (token: string) => identity.authenticate(token);
  return {
    store,
    identity,
    accounts,
    accountsWith,
    invites,
    actions,
    clock,
    sent,
    guest,
    flush,
    signUp,
    latestCode,
    principalOf,
    adminCookie,
    advance: (ms: number) => {
      now += ms;
    },
    set: (value: number) => {
      now = value;
    },
    issueInvite: () =>
      invites.issue({
        adminSessionId: 'admin',
        requestId: `issue-${++counter}`,
        redeemBy: null,
        accessDurationMs: null,
        batch: 'synthetic',
        note: null,
      }),
  };
}
const code = (name: string) => (error: unknown) => error instanceof DomainError && error.code === name;

test('signup: email code → password + nickname binds a login to the CURRENT guest principal and keeps its session', async (t) => {
  const f = fixture(t);
  const actor = f.guest();
  const before = f.principalOf(actor.token);
  const challenge = f.accounts.requestCode({
    purpose: 'signup',
    email: '  Player@Example.COM ',
    ipHash: IP,
    origin,
    session: actor.session,
  });
  assert.deepEqual(Object.keys(challenge).sort(), ['challengeId', 'expiresAt', 'resendAfterMs']);
  assert.equal(challenge.expiresAt, T0 + 10 * 60_000);
  assert.equal(challenge.resendAfterMs, 60_000);
  await f.flush();
  const mail = f.latestCode();
  assert.match(mail.code!, /^[0-9]{6}$/);
  assert.equal(mail.to, 'player@example.com');
  // Plain Chinese text, the code only: no links.
  const text = playerMailText(mail);
  assert.match(text, /注册验证码是：[0-9]{6}/);
  assert.doesNotMatch(text, /https?:|<|www\./);
  f.accounts.verifyCode({ challengeId: challenge.challengeId, code: mail.code!, origin, session: actor.session });
  const done = await f.accounts.complete({
    challengeId: challenge.challengeId,
    password: PASSWORD,
    nickname: '  阿泡  ',
    session: actor.session,
    purpose: 'signup',
  });
  assert.equal(done.nickname, '阿泡');
  assert.equal(done.emailMasked, 'p***@example.com');
  // Same principal, same session, same kind: only a credential was added.
  assert.deepEqual(f.principalOf(actor.token), before);
  assert.equal(
    f.store.get<{ kind: string }>('SELECT kind FROM web_principals WHERE id=?', before.principalId)?.kind,
    'guest',
  );
  assert.equal(
    f.store.get('SELECT 1 FROM web_sessions WHERE account_id IS NOT NULL'),
    undefined,
    'logins create no account sessions',
  );
  const login = f.store.get<{ email_norm: string; password_hash: string }>('SELECT * FROM web_player_logins');
  assert.equal(login?.email_norm, 'player@example.com');
  assert.match(login!.password_hash, /^scrypt-16384-8-5\$[a-f0-9]{32}\$[a-f0-9]{64}$/);
  assert.ok(!login!.password_hash.includes(PASSWORD));
  // A second signup of a principal that already has a login is refused.
  assert.throws(
    () =>
      f.accounts.requestCode({
        purpose: 'signup',
        email: 'other@example.com',
        ipHash: IP,
        origin,
        session: actor.session,
      }),
    code('PLAYER_LOGIN_EXISTS'),
  );
  assert.deepEqual(f.accounts.info(actor.token), {
    signupEnabled: true,
    signedIn: true,
    kind: 'guest',
    hasLogin: true,
    emailMasked: 'p***@example.com',
    nickname: '阿泡',
    canBind: false,
  });
  assert.deepEqual(f.accounts.info(undefined), { signupEnabled: true, signedIn: false });
  assert.deepEqual(f.accounts.info('x'.repeat(43)), { signupEnabled: true, signedIn: false });
});

test('signup writes a new 名片 revision with name = nickname, which playerIntroduction hands to the character', async (t) => {
  const f = fixture(t);
  const actor = await f.signUp('card@example.com', '阿泡');
  const who = f.principalOf(actor.token);
  const revisions = () =>
    f.store.all<{ revision: number; profile_json: string }>(
      'SELECT revision,profile_json FROM player_profile_versions WHERE world_id=? ORDER BY revision',
      who.world_id,
    );
  assert.equal(revisions().length, 1);
  assert.deepEqual(JSON.parse(revisions()[0]!.profile_json), {
    name: '阿泡',
    age: null,
    city: '',
    occupation: '',
    familyBackground: '',
    sharedCharacterIds: [],
  });
  f.store.run("INSERT INTO character_templates VALUES ('wei-guagua',1,'{}')");
  f.store.run(
    "INSERT INTO world_characters(world_id,character_id,relationship) VALUES (?,'wei-guagua','new')",
    who.world_id,
  );
  f.store.run(
    "INSERT INTO conversations(id,world_id,kind,private_character_id) VALUES ('c1',?, 'private','wei-guagua')",
    who.world_id,
  );
  f.store.run(
    "INSERT INTO participants(world_id,conversation_id,character_id) VALUES (?,'c1','wei-guagua')",
    who.world_id,
  );
  const scope = { worldId: who.world_id, playerId: who.player_id, conversationId: 'c1', characterId: 'wei-guagua' };
  const intro = playerIntroduction(userStore(f.store as never), scope as never);
  assert.equal(intro?.name, '阿泡');
  assert.equal(intro?.source, 'player_setup');
  // 我的昵称: a new revision, none for an unchanged name, a fixed set of refusals.
  assert.deepEqual(f.accounts.setNickname({ nickname: ' 小泡 ', session: actor.session }), {
    nickname: '小泡',
    revision: 2,
  });
  assert.deepEqual(f.accounts.setNickname({ nickname: '小泡', session: actor.session }), {
    nickname: '小泡',
    revision: 2,
  });
  assert.equal(revisions().length, 2);
  assert.equal(playerIntroduction(userStore(f.store as never), scope as never)?.name, '小泡');
  for (const bad of ['', '   ', 'a'.repeat(21), 'line\nbreak', 'tab\there', 'nul\u0000', 'sep x', '‮flip', 5, null])
    assert.throws(() => playerNickname(bad), code('PLAYER_NICKNAME_INVALID'), String(bad));
  assert.equal(playerNickname('长'.repeat(20)), '长'.repeat(20));
  assert.equal(playerNickname('😀'.repeat(20)).length, 40, 'counted in code points, not UTF-16 units');
  assert.throws(
    () => f.accounts.setNickname({ nickname: 'x', session: { ...actor.session, csrf: 'c'.repeat(43) } }),
    code('CSRF_INVALID'),
  );
  assert.throws(
    () => f.accounts.setNickname({ nickname: 'x', session: { ...actor.session, origin: 'https://evil.invalid' } }),
    code('ORIGIN_INVALID'),
  );
});

test('codes: six digits, ten minutes, five attempts, and a new challenge supersedes the previous one', async (t) => {
  const f = fixture(t);
  const actor = f.guest();
  const ask = (email = 'code@example.com') =>
    f.accounts.requestCode({ purpose: 'signup', email, ipHash: IP, origin, session: actor.session });
  const verify = (challengeId: string, value: string) =>
    f.accounts.verifyCode({ challengeId, code: value, origin, session: actor.session });
  const first = ask();
  await f.flush();
  const firstCode = f.latestCode().code!;
  // Wrong codes spend attempts; the fifth wrong one kills the challenge even for the right code.
  const wrong = firstCode === '000000' ? '111111' : '000000';
  for (let i = 0; i < 5; i++) assert.throws(() => verify(first.challengeId, wrong), code('PLAYER_CODE_INVALID'));
  assert.throws(() => verify(first.challengeId, firstCode), code('PLAYER_CODE_INVALID'));
  // The fifth attempt may still be the right one.
  f.advance(PLAYER_LIMITS.resendMs);
  const second = ask();
  await f.flush();
  const secondCode = f.latestCode().code!;
  for (let i = 0; i < 4; i++) assert.throws(() => verify(second.challengeId, wrong === secondCode ? '222222' : wrong));
  verify(second.challengeId, secondCode);
  // A challenge verifies once.
  assert.throws(() => verify(second.challengeId, secondCode), code('PLAYER_CODE_INVALID'));
  // Malformed input is the same refusal.
  for (const bad of ['12345', '1234567', 'abcdef', '12 456', ''])
    assert.throws(() => verify(second.challengeId, bad), code('PLAYER_CODE_INVALID'));
  // Expiry after ten minutes.
  f.advance(PLAYER_LIMITS.resendMs);
  const third = ask();
  await f.flush();
  const thirdCode = f.latestCode().code!;
  f.advance(10 * 60_000);
  assert.throws(() => verify(third.challengeId, thirdCode), code('PLAYER_CODE_INVALID'));
  // Supersede: asking again invalidates the previous live challenge for the same email and purpose.
  f.advance(PLAYER_LIMITS.resendMs);
  const older = ask();
  await f.flush();
  const olderCode = f.latestCode().code!;
  f.advance(PLAYER_LIMITS.resendMs);
  const newer = ask();
  await f.flush();
  assert.throws(() => verify(older.challengeId, olderCode), code('PLAYER_CODE_INVALID'));
  verify(newer.challengeId, f.latestCode().code!);
  // The digest is an HMAC; the code never sits in the table.
  const dump = JSON.stringify(f.store.all('SELECT * FROM web_email_challenges'));
  for (const secret of [firstCode, secretOf(f.sent, 'code')]) assert.ok(!dump.includes(`"${secret}"`));
});
const secretOf = (sent: Sent[], key: 'code') => sent.at(-1)![key] ?? '';

test('a challenge belongs to the session that asked for it and to its purpose', async (t) => {
  const f = fixture(t);
  const a = f.guest(),
    b = f.guest();
  const challenge = f.accounts.requestCode({
    purpose: 'signup',
    email: 'a@example.com',
    ipHash: IP,
    origin,
    session: a.session,
  });
  await f.flush();
  const value = f.latestCode().code!;
  assert.throws(
    () => f.accounts.verifyCode({ challengeId: challenge.challengeId, code: value, origin, session: b.session }),
    code('PLAYER_CODE_INVALID'),
  );
  assert.throws(
    () => f.accounts.verifyCode({ challengeId: challenge.challengeId, code: value, origin }),
    code('PLAYER_CODE_INVALID'),
  );
  // Not verified yet: completing is refused, and so is completing with another session after verifying.
  await assert.rejects(
    f.accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: 'x',
      session: a.session,
      purpose: 'signup',
    }),
    code('PLAYER_CODE_INVALID'),
  );
  f.accounts.verifyCode({ challengeId: challenge.challengeId, code: value, origin, session: a.session });
  await assert.rejects(
    f.accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: 'x',
      session: b.session,
      purpose: 'signup',
    }),
    code('PLAYER_CODE_INVALID'),
  );
  await assert.rejects(
    f.accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: 'x',
      session: a.session,
      purpose: 'bind',
    }),
    code('PLAYER_CODE_INVALID'),
  );
  // Bad password / nickname are refused before anything is written.
  for (const password of ['short', 'x'.repeat(129)])
    await assert.rejects(
      f.accounts.complete({
        challengeId: challenge.challengeId,
        password,
        nickname: 'x',
        session: a.session,
        purpose: 'signup',
      }),
      code('PLAYER_PASSWORD_INVALID'),
    );
  await assert.rejects(
    f.accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: '',
      session: a.session,
      purpose: 'signup',
    }),
    code('PLAYER_NICKNAME_INVALID'),
  );
  assert.equal(f.store.get('SELECT 1 FROM web_player_logins'), undefined);
  // Exactly 8 and 128 bytes are fine (bytes, not characters).
  await f.accounts.complete({
    challengeId: challenge.challengeId,
    password: '12345678',
    nickname: 'x',
    session: a.session,
    purpose: 'signup',
  });
  assert.ok(f.store.get('SELECT 1 FROM web_player_logins'));
});

test('send limits: 60 s per email, 5 per hour per email, 10 per hour per IP, checked before anything is sent', async (t) => {
  const f = fixture(t);
  const ask = (email: string, ip = IP, who = f.guest()) =>
    f.accounts.requestCode({ purpose: 'signup', email, ipHash: ip, origin, session: who.session });
  ask('one@example.com');
  await f.flush();
  const sentBefore = f.sent.length;
  // 60 s cooldown per email, any purpose; the answer says when.
  let blocked: unknown;
  try {
    ask('one@example.com');
  } catch (error) {
    blocked = error;
  }
  assert.ok(blocked instanceof RetryAfterError && blocked.code === 'PLAYER_RATE_LIMITED');
  assert.equal((blocked as RetryAfterError).retryAfterMs, 60_000);
  assert.throws(
    () => f.accounts.requestCode({ purpose: 'reset', email: 'ONE@example.com', ipHash: OTHER_IP, origin }),
    code('PLAYER_RATE_LIMITED'),
  );
  await f.flush();
  assert.equal(f.sent.length, sentBefore, 'a blocked request sent nothing');
  f.advance(59_999);
  assert.throws(() => ask('one@example.com'), code('PLAYER_RATE_LIMITED'));
  f.advance(1);
  ask('one@example.com');
  // Five an hour per email.
  for (let i = 0; i < 3; i++) {
    f.advance(60_000);
    ask('one@example.com');
  }
  f.advance(60_000);
  let hourly: unknown;
  try {
    ask('one@example.com');
  } catch (error) {
    hourly = error;
  }
  assert.ok(hourly instanceof RetryAfterError && hourly.code === 'PLAYER_RATE_LIMITED');
  assert.ok((hourly as RetryAfterError).retryAfterMs > 60_000, 'waits for the oldest send to leave the hour');
  f.advance(60 * 60_000);
  ask('one@example.com');
  // Ten an hour per IP, whatever the address.
  f.advance(60 * 60_000);
  for (let i = 0; i < PLAYER_LIMITS.ipPerHour; i++) ask(`ip${i}@example.com`, OTHER_IP);
  assert.throws(() => ask('ip-extra@example.com', OTHER_IP), code('PLAYER_RATE_LIMITED'));
  ask('ip-extra@example.com', IP);
});

test('the global daily cap (PLAYER_EMAIL_DAILY_CAP) stops sending and resets at UTC midnight', async (t) => {
  const f = fixture(t, { dailyCap: 3 });
  f.set(Date.parse('2026-10-10T10:00:00Z'));
  const ask = (email: string, ip: string) =>
    f.accounts.requestCode({ purpose: 'signup', email, ipHash: ip, origin, session: f.guest().session });
  for (let i = 0; i < 3; i++) ask(`cap${i}@example.com`, String(i).repeat(64));
  await f.flush();
  assert.equal(f.sent.length, 3);
  let capped: unknown;
  try {
    ask('cap3@example.com', '3'.repeat(64));
  } catch (error) {
    capped = error;
  }
  assert.ok(capped instanceof RetryAfterError && capped.code === 'PLAYER_EMAIL_DAILY_CAP');
  assert.equal((capped as RetryAfterError).retryAfterMs, 14 * 3_600_000, 'until the next UTC midnight');
  await f.flush();
  assert.equal(f.sent.length, 3);
  assert.equal(webProviderHTTPError(capped).status, 429);
  f.set(Date.parse('2026-10-11T00:00:00Z'));
  ask('cap3@example.com', '3'.repeat(64));
  assert.equal(
    f.store.get<{ sends: number }>("SELECT sends FROM web_player_email_daily WHERE day='2026-10-11'")?.sends,
    1,
  );
  // The default is 200.
  assert.equal(PLAYER_LIMITS.defaultDailyCap, 200);
});

test('anti-enumeration: a registered and an unknown address get identical answers and identical limits', async (t) => {
  const f = fixture(t);
  await f.signUp('known@example.com');
  f.sent.length = 0;
  f.advance(PLAYER_LIMITS.resendMs);
  const a = f.guest(),
    b = f.guest();
  const known = f.accounts.requestCode({
    purpose: 'signup',
    email: 'known@example.com',
    ipHash: IP,
    origin,
    session: a.session,
  });
  const unknown = f.accounts.requestCode({
    purpose: 'signup',
    email: 'unknown@example.com',
    ipHash: IP,
    origin,
    session: b.session,
  });
  await f.flush();
  assert.deepEqual(Object.keys(known).sort(), Object.keys(unknown).sort());
  assert.equal(known.expiresAt, unknown.expiresAt);
  assert.equal(known.resendAfterMs, unknown.resendAfterMs);
  // The registered address got the "already registered" notice, with no code in it; the other got a code.
  const kinds = Object.fromEntries(f.sent.map((m) => [m.to, m.kind]));
  assert.deepEqual(kinds, { 'known@example.com': 'registered', 'unknown@example.com': 'code' });
  const registered = f.sent.find((m) => m.kind === 'registered')!;
  assert.equal(registered.code, null);
  const notice = playerMailText(registered);
  assert.match(notice, /你已注册，可直接登录或重置密码/);
  assert.doesNotMatch(notice, /[0-9]{6}|https?:/);
  // Nothing ever verifies against the registered address's challenge.
  for (const guess of ['000000', '123456', '999999'])
    assert.throws(
      () => f.accounts.verifyCode({ challengeId: known.challengeId, code: guess, origin, session: a.session }),
      code('PLAYER_CODE_INVALID'),
    );
  // Reset: an unknown address answers the same and sends nothing; a known one sends a code.
  f.sent.length = 0;
  f.advance(PLAYER_LIMITS.resendMs);
  const resetKnown = f.accounts.requestCode({ purpose: 'reset', email: 'known@example.com', ipHash: IP, origin });
  const resetUnknown = f.accounts.requestCode({ purpose: 'reset', email: 'nobody@example.com', ipHash: IP, origin });
  await f.flush();
  assert.deepEqual(Object.keys(resetKnown).sort(), Object.keys(resetUnknown).sort());
  assert.equal(resetKnown.expiresAt, resetUnknown.expiresAt);
  assert.deepEqual(
    f.sent.map((m) => m.to),
    ['known@example.com'],
  );
  assert.throws(
    () => f.accounts.verifyCode({ challengeId: resetUnknown.challengeId, code: '123456', origin }),
    code('PLAYER_CODE_INVALID'),
  );
  // Both spend the same slots: the unknown address is rate limited exactly like the known one.
  assert.throws(
    () => f.accounts.requestCode({ purpose: 'reset', email: 'nobody@example.com', ipHash: IP, origin }),
    code('PLAYER_RATE_LIMITED'),
  );
  assert.throws(
    () => f.accounts.requestCode({ purpose: 'reset', email: 'known@example.com', ipHash: IP, origin }),
    code('PLAYER_RATE_LIMITED'),
  );
});

test('a send that errors is recorded unknown and never retried; the resend counts toward the limits', async (t) => {
  const f = fixture(t, { failMail: true });
  const who = f.guest();
  let calls = 0;
  const failing: PlayerMailer = {
    send: async () => {
      calls++;
      throw new Error('boom');
    },
    waitUntil: (task) => void task,
  };
  const accounts = new WebPlayerAccounts(f.store as never, f.identity, {
    origin,
    requestKey: Buffer.alloc(32, 2),
    clock: f.clock,
    mailer: failing,
    signupEnabled: true,
    dailyCap: 5,
  });
  const challenge = accounts.requestCode({
    purpose: 'signup',
    email: 'down@example.com',
    ipHash: IP,
    origin,
    session: who.session,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  assert.equal(
    f.store.get<{ delivery: string }>('SELECT delivery FROM web_email_challenges WHERE id=?', challenge.challengeId)
      ?.delivery,
    'unknown',
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1, 'no automatic retry');
  assert.throws(
    () =>
      accounts.requestCode({ purpose: 'signup', email: 'down@example.com', ipHash: IP, origin, session: who.session }),
    code('PLAYER_RATE_LIMITED'),
  );
  f.advance(60_000);
  accounts.requestCode({ purpose: 'signup', email: 'down@example.com', ipHash: IP, origin, session: who.session });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  assert.equal(f.store.get<{ sends: number }>('SELECT sends FROM web_player_email_daily')?.sends, 2);
});

test('signup flag off: signup, reset and bind refuse, nothing is sent, and login still works', async (t) => {
  const f = fixture(t);
  const actor = await f.signUp('stay@example.com');
  const closed = f.accountsWith(false);
  f.sent.length = 0;
  for (const purpose of ['signup', 'reset', 'bind'] as const)
    assert.throws(
      () =>
        closed.requestCode({
          purpose,
          email: 'x@example.com',
          ipHash: IP,
          origin,
          session: purpose === 'reset' ? undefined : f.guest().session,
        }),
      code('PLAYER_SIGNUP_DISABLED'),
    );
  await assert.rejects(
    closed.complete({ challengeId: 'c', password: PASSWORD, nickname: 'x', session: actor.session, purpose: 'signup' }),
    code('PLAYER_SIGNUP_DISABLED'),
  );
  await assert.rejects(
    closed.reset({ challengeId: 'c', password: PASSWORD, origin, ipHash: IP }),
    code('PLAYER_SIGNUP_DISABLED'),
  );
  assert.equal(f.sent.length, 0);
  assert.equal(closed.info(undefined).signupEnabled, false);
  const session = await closed.login({ email: 'stay@example.com', password: PASSWORD, origin, ipHash: IP });
  assert.equal(f.identity.authenticate(session.issuedToken).principalId, f.principalOf(actor.token).principalId);
  // Constructing "enabled" without a mailer collapses to closed in the application; the class itself refuses it.
  assert.throws(
    () =>
      new WebPlayerAccounts(f.store as never, f.identity, {
        origin,
        requestKey: Buffer.alloc(32, 2),
        clock: f.clock,
        mailer: null,
        signupEnabled: true,
        dailyCap: 10,
      }),
    code('WEB_PLAYER_CONFIG_INVALID'),
  );
});

test('login: multi-device — logging in on B leaves A working; other sessions are untouched; guests never merge', async (t) => {
  const f = fixture(t);
  const a = await f.signUp('multi@example.com', '甲');
  const principal = f.principalOf(a.token);
  // Device B holds its own (different) guest with a chat row; login gives B the login's principal, not a merge.
  const deviceB = f.guest();
  const otherPrincipal = f.principalOf(deviceB.token);
  assert.notEqual(otherPrincipal.principalId, principal.principalId);
  f.advance(1000);
  const login = await f.accounts.login({ email: ' MULTI@example.com ', password: PASSWORD, origin, ipHash: IP });
  assert.deepEqual(Object.keys(login).sort(), ['csrf', 'issuedToken', 'sessionId']);
  assert.equal(f.principalOf(login.issuedToken).principalId, principal.principalId);
  // A still works; B's old guest session still works too (login revokes nothing).
  assert.equal(f.principalOf(a.token).principalId, principal.principalId);
  assert.equal(f.principalOf(deviceB.token).principalId, otherPrincipal.principalId);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_sessions WHERE revoked_at IS NOT NULL')?.n, 0);
  // The new session is a write-capable session with its own CSRF token.
  assert.equal(f.identity.authorizeWrite(login.issuedToken, login.csrf, origin).principalId, principal.principalId);
  assert.equal(f.identity.isDurableSession(login.issuedToken), true);
  assert.equal(f.identity.isDurableSession(deviceB.token), false);
  // No chat row, principal or login moved.
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_player_logins')?.n, 1);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_principals')?.n, 2);
});

test('login: generic failure for a wrong password, unknown email and malformed input; per-email and per-IP throttles', async (t) => {
  const f = fixture(t);
  await f.signUp('throttle@example.com');
  const attempt = (email: string, password: string, ip = IP) =>
    f.accounts.login({ email, password, origin, ipHash: ip });
  const generic = code('PLAYER_LOGIN_INVALID');
  await assert.rejects(attempt('throttle@example.com', 'wrong password'), generic);
  await assert.rejects(attempt('nobody@example.com', PASSWORD), generic);
  await assert.rejects(attempt('not-an-email', PASSWORD), generic);
  await assert.rejects(attempt('throttle@example.com', 'short'), generic);
  assert.equal(webProviderHTTPError(new DomainError('PLAYER_LOGIN_INVALID')).status, 401);
  // A success clears the email counter: ten wrong ones, a right one, then ten more wrong ones are all allowed to fail normally.
  for (let i = 0; i < 5; i++)
    await assert.rejects(attempt('throttle@example.com', `wrong password ${i}`, String(i).repeat(64)), generic);
  await attempt('throttle@example.com', PASSWORD, '7'.repeat(64));
  // 10 failures per email per 15 minutes, then wait — even for the right password.
  for (let i = 0; i < 10; i++)
    await assert.rejects(attempt('throttle@example.com', 'bad password!', `${i}`.repeat(64)), generic);
  let waiting: unknown;
  try {
    await attempt('throttle@example.com', PASSWORD, 'e'.repeat(64));
  } catch (error) {
    waiting = error;
  }
  assert.ok(waiting instanceof RetryAfterError && waiting.code === 'PLAYER_RATE_LIMITED');
  assert.ok((waiting as RetryAfterError).retryAfterMs > 0 && (waiting as RetryAfterError).retryAfterMs <= 15 * 60_000);
  assert.equal(webProviderHTTPError(waiting).status, 429);
  f.advance(15 * 60_000);
  await attempt('throttle@example.com', PASSWORD, 'e'.repeat(64));
  // Per IP: 30 failures in the window whatever the address, then wait.
  for (let i = 0; i < PLAYER_LIMITS.loginPerIp; i++)
    await assert.rejects(attempt(`ghost${i}@example.com`, 'bad password!', 'f'.repeat(64)), generic);
  await assert.rejects(attempt('throttle@example.com', PASSWORD, 'f'.repeat(64)), code('PLAYER_RATE_LIMITED'));
  await attempt('throttle@example.com', PASSWORD, 'c'.repeat(64));
  // Wrong origin is refused outright.
  await assert.rejects(
    f.accounts.login({ email: 'throttle@example.com', password: PASSWORD, origin: 'https://evil.invalid', ipHash: IP }),
    code('ORIGIN_INVALID'),
  );
});

test('forgot password: the code sets a new password, every other session ends and this device gets a fresh one', async (t) => {
  const f = fixture(t);
  const a = await f.signUp('reset@example.com');
  const principal = f.principalOf(a.token);
  const b = await f.accounts.login({ email: 'reset@example.com', password: PASSWORD, origin, ipHash: IP });
  f.advance(PLAYER_LIMITS.resendMs);
  const challenge = f.accounts.requestCode({ purpose: 'reset', email: 'reset@example.com', ipHash: IP, origin });
  await f.flush();
  const mail = f.latestCode();
  assert.equal(mail.purpose, 'reset');
  assert.match(playerMailText(mail), /重置密码验证码是：[0-9]{6}/);
  // Resetting before the code is verified, or with a signup challenge, is refused.
  await assert.rejects(
    f.accounts.reset({ challengeId: challenge.challengeId, password: 'brand new pass', origin, ipHash: IP }),
    code('PLAYER_CODE_INVALID'),
  );
  f.accounts.verifyCode({ challengeId: challenge.challengeId, code: mail.code!, origin });
  await assert.rejects(
    f.accounts.reset({ challengeId: challenge.challengeId, password: 'short', origin, ipHash: IP }),
    code('PLAYER_PASSWORD_INVALID'),
  );
  const fresh = await f.accounts.reset({
    challengeId: challenge.challengeId,
    password: 'brand new pass',
    origin,
    ipHash: IP,
  });
  // Everything signed in before is gone; the new session belongs to the same principal.
  for (const old of [a.token, b.issuedToken]) assert.throws(() => f.principalOf(old), code('SESSION_EXPIRED'));
  assert.equal(f.principalOf(fresh.issuedToken).principalId, principal.principalId);
  // Old password dead, new password works, the challenge is spent.
  await assert.rejects(
    f.accounts.login({ email: 'reset@example.com', password: PASSWORD, origin, ipHash: IP }),
    code('PLAYER_LOGIN_INVALID'),
  );
  await f.accounts.login({ email: 'reset@example.com', password: 'brand new pass', origin, ipHash: IP });
  await assert.rejects(
    f.accounts.reset({ challengeId: challenge.challengeId, password: 'another one!!', origin, ipHash: IP }),
    code('PLAYER_CODE_INVALID'),
  );
  // A reset challenge for an unknown address can never complete.
  f.advance(PLAYER_LIMITS.resendMs);
  const ghost = f.accounts.requestCode({ purpose: 'reset', email: 'ghost@example.com', ipHash: IP, origin });
  assert.throws(
    () => f.accounts.verifyCode({ challengeId: ghost.challengeId, code: '123456', origin }),
    code('PLAYER_CODE_INVALID'),
  );
});

test('change password needs the current one; logout-others and logout end exactly what they say', async (t) => {
  const f = fixture(t);
  const a = await f.signUp('change@example.com');
  const b = await f.accounts.login({ email: 'change@example.com', password: PASSWORD, origin, ipHash: IP });
  const c = await f.accounts.login({ email: 'change@example.com', password: PASSWORD, origin, ipHash: IP });
  const sessionB = { token: b.issuedToken, csrf: b.csrf, origin };
  await assert.rejects(
    f.accounts.changePassword({
      current: 'not my password',
      next: 'a new password',
      logoutOthers: false,
      session: sessionB,
    }),
    code('PLAYER_LOGIN_INVALID'),
  );
  await assert.rejects(
    f.accounts.changePassword({ current: PASSWORD, next: 'short', logoutOthers: false, session: sessionB }),
    code('PLAYER_PASSWORD_INVALID'),
  );
  await assert.rejects(
    f.accounts.changePassword({
      current: PASSWORD,
      next: 'a new password',
      logoutOthers: 'yes' as never,
      session: sessionB,
    }),
    code('INVALID_REQUEST'),
  );
  // Without the option nothing else is touched.
  assert.deepEqual(
    await f.accounts.changePassword({
      current: PASSWORD,
      next: 'a new password',
      logoutOthers: false,
      session: sessionB,
    }),
    { changed: true, otherSessionsEnded: 0 },
  );
  for (const token of [a.token, b.issuedToken, c.issuedToken]) f.principalOf(token);
  // With it, every other session ends; this one stays.
  assert.deepEqual(
    await f.accounts.changePassword({
      current: 'a new password',
      next: 'newest password',
      logoutOthers: true,
      session: sessionB,
    }),
    { changed: true, otherSessionsEnded: 2 },
  );
  assert.throws(() => f.principalOf(a.token), code('SESSION_EXPIRED'));
  assert.throws(() => f.principalOf(c.issuedToken), code('SESSION_EXPIRED'));
  f.principalOf(b.issuedToken);
  // Five wrong current passwords in a window lock the check, even for the right one.
  for (let i = 0; i < 5; i++)
    await assert.rejects(
      f.accounts.changePassword({
        current: `wrong password ${i}`,
        next: 'another new one',
        logoutOthers: false,
        session: sessionB,
      }),
      code('PLAYER_LOGIN_INVALID'),
    );
  await assert.rejects(
    f.accounts.changePassword({
      current: 'newest password',
      next: 'another new one',
      logoutOthers: false,
      session: sessionB,
    }),
    code('PLAYER_RATE_LIMITED'),
  );
  // 退出其他设备 / 退出登录.
  const d = await f.accounts.login({
    email: 'change@example.com',
    password: 'newest password',
    origin,
    ipHash: 'd'.repeat(64),
  });
  assert.deepEqual(f.accounts.logoutOthers(sessionB), { ended: 1 });
  assert.throws(() => f.principalOf(d.issuedToken), code('SESSION_EXPIRED'));
  assert.deepEqual(f.accounts.logout(sessionB), { loggedOut: true });
  assert.throws(() => f.principalOf(b.issuedToken), code('SESSION_EXPIRED'));
  // A guest without a login can do none of it.
  const plain = f.guest();
  assert.throws(() => f.accounts.logoutOthers(plain.session), code('PLAYER_LOGIN_REQUIRED'));
  assert.throws(() => f.accounts.setNickname({ nickname: 'x', session: plain.session }), code('PLAYER_LOGIN_REQUIRED'));
  await assert.rejects(
    f.accounts.changePassword({ current: PASSWORD, next: 'x'.repeat(12), logoutOthers: false, session: plain.session }),
    code('PLAYER_LOGIN_REQUIRED'),
  );
});

test('invited players: login is refused once the grant is revoked (after the right password), and a bind revokes the recovery code', async (t) => {
  const f = fixture(t);
  // A legacy invited player: redeemed, has a recovery code, no login.
  const player = f.guest();
  const issued = f.issueInvite();
  const redeemed = f.invites.redeem({
    token: player.token,
    csrf: player.csrf,
    origin,
    code: issued.code!,
    requestId: 'redeem-1',
  });
  if (redeemed.duplicate) throw new Error('unexpected duplicate');
  const token = redeemed.identity!.issuedToken,
    csrf = redeemed.identity!.csrf;
  const session = { token, csrf, origin };
  const credential = f.identity.regenerateInviteCredential(token, csrf, origin);
  assert.deepEqual((({ canBind, hasLogin, kind }) => ({ canBind, hasLogin, kind }))(f.accounts.info(token) as never), {
    canBind: true,
    hasLogin: false,
    kind: 'invite',
  });
  // Signup is not for invited players; bind is.
  assert.throws(
    () => f.accounts.requestCode({ purpose: 'signup', email: 'legacy@example.com', ipHash: IP, origin, session }),
    code('PLAYER_SIGNUP_UNAVAILABLE'),
  );
  const guestSession = f.guest().session;
  assert.throws(
    () =>
      f.accounts.requestCode({
        purpose: 'bind',
        email: 'legacy@example.com',
        ipHash: IP,
        origin,
        session: guestSession,
      }),
    code('PLAYER_BIND_UNAVAILABLE'),
  );
  const challenge = f.accounts.requestCode({
    purpose: 'bind',
    email: 'legacy@example.com',
    ipHash: IP,
    origin,
    session,
  });
  await f.flush();
  f.accounts.verifyCode({ challengeId: challenge.challengeId, code: f.latestCode().code!, origin, session });
  const sessionsBefore = f.store.get<{ n: number }>('SELECT count(*) n FROM web_sessions WHERE revoked_at IS NULL')?.n;
  await f.accounts.complete({
    challengeId: challenge.challengeId,
    password: PASSWORD,
    nickname: '老玩家',
    session,
    purpose: 'bind',
  });
  // The recovery credential is revoked: using it anywhere fails, and no other session was revoked by the bind.
  assert.throws(
    () => f.identity.recoverInviteCredential({ origin, requestId: 'recover-1', secret: credential.secret, ipHash: IP }),
    code('WEB_INVITE_RECOVERY_UNAVAILABLE'),
  );
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_sessions WHERE revoked_at IS NULL')?.n,
    sessionsBefore,
  );
  f.identity.authenticate(token);
  // A player with a login keeps no recovery code: creating or regenerating one is refused.
  assert.throws(() => f.identity.regenerateInviteCredential(token, csrf, origin), code('PLAYER_LOGIN_EXISTS'));
  assert.throws(() => f.identity.createInviteCredential(token, csrf, origin), code('PLAYER_LOGIN_EXISTS'));
  assert.deepEqual((f.accounts.info(token) as { canBind: boolean }).canBind, false);
  // The invited session is durable (400-day cookie) as before.
  assert.equal(f.identity.isDurableSession(token), true);
  // Login works while the grant is live …
  const login = await f.accounts.login({ email: 'legacy@example.com', password: PASSWORD, origin, ipHash: IP });
  f.identity.authenticate(login.issuedToken);
  // … and an administrator revoking the grant ends every session and blocks future logins, after the password is right.
  const grant = f.store.get<{ id: string }>('SELECT id FROM web_invite_grants')!;
  f.invites.revokeGrant('admin', grant.id);
  assert.throws(() => f.identity.authenticate(login.issuedToken), code('SESSION_EXPIRED'));
  await assert.rejects(
    f.accounts.login({ email: 'legacy@example.com', password: PASSWORD, origin, ipHash: IP }),
    code('PLAYER_ACCESS_REVOKED'),
  );
  await assert.rejects(
    f.accounts.login({ email: 'legacy@example.com', password: 'wrong password', origin, ipHash: IP }),
    code('PLAYER_LOGIN_INVALID'),
  );
  assert.equal(webProviderHTTPError(new DomainError('PLAYER_ACCESS_REVOKED')).status, 403);
  // Reset cannot reopen a revoked principal either.
  f.advance(PLAYER_LIMITS.resendMs);
  const reset = f.accounts.requestCode({ purpose: 'reset', email: 'legacy@example.com', ipHash: IP, origin });
  await f.flush();
  f.accounts.verifyCode({ challengeId: reset.challengeId, code: f.latestCode().code!, origin });
  await assert.rejects(
    f.accounts.reset({ challengeId: reset.challengeId, password: 'brand new pass', origin, ipHash: IP }),
    code('PLAYER_ACCESS_REVOKED'),
  );
});

test('redeeming requires a signed-in login while signup is open; a guest signs up first and keeps its principal', async (t) => {
  const f = fixture(t);
  const gate = (token: string) => {
    if (!f.identity.hasLogin(f.identity.authenticate(token).principalId))
      throw new DomainError('PLAYER_LOGIN_REQUIRED');
  };
  const actions = f.actions(gate);
  const guest = f.guest();
  const issued = f.issueInvite();
  assert.throws(
    () => actions.redeem(guest.token, guest.csrf, origin, IP, { code: issued.code!, requestId: 'redeem-a' }),
    code('PLAYER_LOGIN_REQUIRED'),
  );
  assert.equal(f.store.get('SELECT 1 FROM web_invite_grants'), undefined, 'a refused redemption changed nothing');
  assert.equal(
    f.store.get<{ redeemed_count: number }>('SELECT redeemed_count FROM web_invite_codes')?.redeemed_count,
    0,
  );
  // Sign up with the SAME guest, then redeem: same principal, no recovery code to keep.
  const challenge = f.accounts.requestCode({
    purpose: 'signup',
    email: 'gate@example.com',
    ipHash: IP,
    origin,
    session: guest.session,
  });
  await f.flush();
  f.accounts.verifyCode({
    challengeId: challenge.challengeId,
    code: f.latestCode().code!,
    origin,
    session: guest.session,
  });
  await f.accounts.complete({
    challengeId: challenge.challengeId,
    password: PASSWORD,
    nickname: '玩家',
    session: guest.session,
    purpose: 'signup',
  });
  const principal = f.principalOf(guest.token).principalId;
  const result = actions.redeem(guest.token, guest.csrf, origin, IP, { code: issued.code!, requestId: 'redeem-b' });
  assert.equal(result.principalId, principal);
  if (result.duplicate) throw new Error('unexpected duplicate');
  assert.equal(f.identity.hasLogin(principal), true);
  assert.throws(
    () => f.identity.regenerateInviteCredential(result.identity!.issuedToken, result.identity!.csrf, origin),
    code('PLAYER_LOGIN_EXISTS'),
  );
  // With no gate (signup closed) redemption is exactly what it was.
  const plain = f.guest();
  const second = f.issueInvite();
  assert.equal(
    f.actions().redeem(plain.token, plain.csrf, origin, IP, { code: second.code!, requestId: 'redeem-c' }).duplicate,
    false,
  );
});

test('dead cookies: unknown, malformed and revoked ones are clearable, but a live redemption receipt keeps its cookie', async (t) => {
  const f = fixture(t);
  const guest = f.guest();
  assert.equal(f.identity.isDeadCookie(guest.token), false);
  assert.equal(f.identity.isDeadCookie('U'.repeat(43)), true);
  assert.equal(f.identity.isDeadCookie('not a token'), true);
  // An uncertain invite redemption: the old cookie is revoked but its sealed receipt is recoverable.
  const issued = f.issueInvite();
  f.invites.redeem({ token: guest.token, csrf: guest.csrf, origin, code: issued.code!, requestId: 'redeem-d' });
  assert.throws(() => f.principalOf(guest.token), code('SESSION_EXPIRED'));
  assert.equal(f.identity.isDeadCookie(guest.token), false, 'the receipt can still be fetched');
  // Once that receipt is gone (expired), it is dead like any other.
  f.advance(10 * 60_000);
  assert.equal(f.identity.isDeadCookie(guest.token), true);
  // A revoked ordinary session is dead.
  const other = f.guest();
  f.identity.logout(other.token, other.csrf, origin);
  assert.equal(f.identity.isDeadCookie(other.token), true);
});

test('a guest with a login keeps its session past 24 h like an invited player; a plain guest does not', async (t) => {
  const f = fixture(t);
  const signed = await f.signUp('long@example.com');
  const plain = f.guest();
  const login = await f.accounts.login({ email: 'long@example.com', password: PASSWORD, origin, ipHash: IP });
  f.advance(3 * 24 * 3_600_000);
  f.principalOf(signed.token);
  f.principalOf(login.issuedToken);
  assert.throws(() => f.principalOf(plain.token), code('SESSION_EXPIRED'));
  assert.equal(f.identity.isDurableSession(signed.token), true);
  f.advance(401 * 24 * 3_600_000);
  assert.throws(
    () => f.principalOf(login.issuedToken),
    code('SESSION_EXPIRED'),
    'but not forever: the 400-day cookie is the ceiling',
  );
  assert.throws(
    () => f.principalOf(signed.token),
    code('SESSION_EXPIRED'),
    'the session that signed up has the same ceiling',
  );
});

test('no secrets in logs, errors, rows, receipts or mail beyond the one code mail', async (t) => {
  const f = fixture(t);
  const logged: string[] = [];
  const originals = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
    debug: console.debug,
  };
  for (const name of Object.keys(originals) as (keyof typeof originals)[])
    console[name] = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  t.after(() => Object.assign(console, originals));
  const email = 'secret.person@example.com';
  const errors: string[] = [];
  const attempt = async (work: () => unknown) => {
    try {
      await work();
    } catch (error) {
      errors.push(`${(error as Error).name}:${(error as Error).message}:${(error as Error).stack ?? ''}`);
    }
  };
  const actor = f.guest();
  const challenge = f.accounts.requestCode({ purpose: 'signup', email, ipHash: IP, origin, session: actor.session });
  await f.flush();
  const real = f.latestCode().code!;
  const wrong = real === '123456' ? '654321' : '123456';
  await attempt(() =>
    f.accounts.verifyCode({ challengeId: challenge.challengeId, code: wrong, origin, session: actor.session }),
  );
  f.accounts.verifyCode({ challengeId: challenge.challengeId, code: real, origin, session: actor.session });
  await attempt(() =>
    f.accounts.complete({
      challengeId: challenge.challengeId,
      password: 'short',
      nickname: 'x',
      session: actor.session,
      purpose: 'signup',
    }),
  );
  await f.accounts.complete({
    challengeId: challenge.challengeId,
    password: PASSWORD,
    nickname: '昵称',
    session: actor.session,
    purpose: 'signup',
  });
  await attempt(() => f.accounts.login({ email, password: 'not the password', origin, ipHash: IP }));
  await attempt(() => f.accounts.login({ email: 'nobody@example.com', password: PASSWORD, origin, ipHash: IP }));
  await attempt(() => f.accounts.requestCode({ purpose: 'signup', email, ipHash: IP, origin, session: actor.session }));
  await attempt(() => f.accounts.requestCode({ purpose: 'reset', email, ipHash: IP, origin }));
  const secrets = [real, PASSWORD, 'not the password', email, 'nobody@example.com'];
  for (const secret of secrets) {
    for (const text of [...logged, ...errors])
      assert.ok(!text.includes(secret), `a log or error leaked ${secret.slice(0, 4)}…`);
    // Public failure bodies carry a code only.
    assert.ok(
      !JSON.stringify(webProviderHTTPError(new DomainError('PLAYER_CODE_INVALID', `x ${secret}`))).includes(secret),
    );
  }
  // Stored rows: no plaintext code or password, and the address only where a login / challenge needs it.
  for (const table of [
    'web_email_challenges',
    'web_player_logins',
    'web_player_throttle',
    'web_player_email_daily',
    'web_sessions',
  ]) {
    const dump = JSON.stringify(f.store.all(`SELECT * FROM ${table}`));
    assert.ok(!dump.includes(real) && !dump.includes(PASSWORD), `${table} holds no secret`);
    if (table === 'web_player_throttle' || table === 'web_player_email_daily' || table === 'web_sessions')
      assert.ok(!dump.includes('example.com'), `${table} holds no address`);
  }
  // The mail itself is the one place a code appears, and only the code mail.
  assert.deepEqual(
    f.sent.map((m) => [m.kind, m.kind === 'code' ? m.code === real : m.code === null]),
    [['code', true]],
  );
});

test('email helpers: masking, normalization, and the admin masked view', () => {
  assert.equal(maskEmail('player@example.com'), 'p***@example.com');
  assert.equal(maskEmail('a@b.co'), 'a***@b.co');
  assert.equal(maskEmail('张三@example.com'), '张***@example.com');
  assert.equal(normalizeEmail('  A.B+c@Example.COM ', 'E'), 'a.b+c@example.com');
  for (const bad of [
    '',
    'a',
    'a@b',
    '@x.com',
    'a b@x.com',
    'a@@x.com',
    '.a@x.com',
    'a..b@x.com',
    `${'a'.repeat(65)}@x.com`,
    5,
    null,
  ])
    assert.throws(() => normalizeEmail(bad, 'E'), code('E'));
});

test('purge: a purged player takes the login, challenges and 名片 with it; the audit sees what remains', async (t) => {
  const f = fixture(t);
  const a = await f.signUp('purge@example.com');
  const other = await f.signUp('keep@example.com');
  const who = f.principalOf(a.token),
    keep = f.principalOf(other.token);
  f.advance(PLAYER_LIMITS.resendMs);
  f.accounts.requestCode({ purpose: 'reset', email: 'purge@example.com', ipHash: IP, origin });
  assert.equal(playerLoginsRemain(f.store, [who.principalId]), true);
  purgePlayerLogins(f.store, { principalId: who.principalId, worldId: who.world_id });
  assert.equal(playerLoginsRemain(f.store, [who.principalId]), false);
  assert.equal(f.store.get('SELECT 1 FROM web_player_logins WHERE principal_id=?', who.principalId), undefined);
  assert.equal(f.store.get("SELECT 1 FROM web_email_challenges WHERE email_norm='purge@example.com'"), undefined);
  assert.equal(f.store.get('SELECT 1 FROM player_profile_versions WHERE world_id=?', who.world_id), undefined);
  // The other player is untouched, and the purged login can no longer sign in.
  assert.equal(playerLoginsRemain(f.store, [keep.principalId]), true);
  assert.ok(f.store.get('SELECT 1 FROM player_profile_versions WHERE world_id=?', keep.world_id));
  await assert.rejects(
    f.accounts.login({ email: 'purge@example.com', password: PASSWORD, origin, ipHash: IP }),
    code('PLAYER_LOGIN_INVALID'),
  );
});

test('routes: every account path is POST with exact bodies, and the signed-out ones need only the origin', async (t) => {
  const f = fixture(t);
  const actor = f.guest();
  const call = (action: string, body: unknown, extra: Record<string, unknown> = {}) =>
    routeWebPlayerAccounts(f.accounts, {
      method: 'POST',
      path: `/api/web/local/account/${action}`,
      origin,
      trustedIpHash: IP,
      body,
      ...extra,
    });
  const signed = { playerToken: actor.token, csrf: actor.csrf };
  assert.equal(
    await routeWebPlayerAccounts(f.accounts, { method: 'POST', path: '/api/web/local/invites/redeem', origin }),
    null,
  );
  await assert.rejects(
    routeWebPlayerAccounts(null, {
      method: 'POST',
      path: '/api/web/local/account/login',
      origin,
      trustedIpHash: IP,
      body: {},
    }),
    code('NOT_FOUND'),
  );
  await assert.rejects(call('nonsense', {}), code('NOT_FOUND'));
  await assert.rejects(call('login', { email: 'a@b.co' }), code('INVALID_REQUEST'));
  await assert.rejects(call('login', { email: 'a@b.co', password: 'x', extra: 1 }), code('INVALID_REQUEST'));
  await assert.rejects(call('nickname', { nickname: 'x' }), code('AUTH_REQUIRED'));
  await assert.rejects(call('nickname', { nickname: 'x' }, { playerToken: actor.token }), code('CSRF_INVALID'));
  const requested = await call('request-code', { purpose: 'signup', email: 'route@example.com' }, signed);
  assert.equal(requested?.status, 200);
  const logout = await call('logout', {}, signed);
  assert.equal(logout?.clearPlayerCookie, true);
  const abandon = await call('signed-out', {});
  assert.deepEqual([abandon?.clearPlayerCookie, abandon?.body], [true, { signedOut: true }]);
  await assert.rejects(
    routeWebPlayerAccounts(f.accounts, {
      method: 'POST',
      path: '/api/web/local/account/signed-out',
      origin: 'https://evil.invalid',
      trustedIpHash: IP,
      body: {},
    }),
    code('ORIGIN_INVALID'),
  );
  await assert.rejects(
    routeWebPlayerAccounts(f.accounts, {
      method: 'GET',
      path: '/api/web/local/account/login',
      origin,
      trustedIpHash: IP,
      body: {},
    }),
    code('NOT_FOUND'),
  );
});
