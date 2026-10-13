import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { Store, type WebStore } from '../../../apps/server/platform/store.ts';
import { WebIdentity } from '../../../apps/server/identity/web-identity.ts';
import { WebPlayerAccounts, type PlayerMailer } from '../../../apps/server/identity/web-player-accounts.ts';
import { requireWebContent } from '../../../apps/server/admission/web-retention.ts';
import { guestInGrace, guestPurgeDue, GUEST_GRACE_MS } from '../../../apps/server/identity/web-player-purge.ts';
import { webPublicFromEnv } from '../../../config/web-public.ts';
import { DomainError } from '../../../packages/domain/errors.ts';

const origin = 'https://synthetic.local';
const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const IP = 'a'.repeat(64);
const PASSWORD = 'correct horse battery';
type Sent = Parameters<PlayerMailer['send']>[0];

/** A real identity and real 118 SQL over an in-memory store; the clock and the mailer are the test's. */
function fixture(t: test.TestContext, graceMs: number) {
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
    ...(graceMs ? { guestGraceMs: graceMs } : {}),
  });
  const sent: Sent[] = [];
  const waits: Promise<void>[] = [];
  const mailer: PlayerMailer = {
    send: async (message) => void sent.push(message),
    waitUntil: (task) => void waits.push(task),
  };
  const accounts = new WebPlayerAccounts(webStore, identity, {
    origin,
    requestKey: Buffer.alloc(32, 2),
    clock,
    mailer,
    signupEnabled: true,
    dailyCap: 100,
    nextId: () => `challenge-${++counter}`,
    ...(graceMs ? { graceMs } : {}),
  });
  /** A guest whose trial started at T0 and ends at T0 + 2 h (the admission rule), with one stored message. */
  const guest = () => {
    const boot = identity.bootstrap();
    const principal = identity.authenticate(boot.issuedToken!);
    store.run(
      "UPDATE web_guest_retention SET state='active',started_at=?,expires_at=? WHERE principal_id=?",
      now,
      now + 2 * HOUR,
      principal.principalId,
    );
    return {
      token: boot.issuedToken!,
      csrf: boot.csrf,
      principalId: principal.principalId,
      worldId: principal.world_id,
    };
  };
  const session = (g: { token: string; csrf: string }) => ({ token: g.token, csrf: g.csrf, origin });
  const flush = () => Promise.all(waits.splice(0));
  const signUp = async (g: ReturnType<typeof guest>, email = 'grace@example.com') => {
    const challenge = accounts.requestCode({ purpose: 'signup', email, ipHash: IP, origin, session: session(g) });
    await flush();
    const code = [...sent].reverse().find((m) => m.kind === 'code')!.code!;
    accounts.verifyCode({ challengeId: challenge.challengeId, code, origin, session: session(g) });
    return accounts.complete({
      challengeId: challenge.challengeId,
      password: PASSWORD,
      nickname: '阿泡',
      session: session(g),
      purpose: 'signup',
    });
  };
  return {
    store,
    identity,
    accounts,
    guest,
    session,
    signUp,
    flush,
    sent,
    at: (value: number) => void (now = value),
    now: () => now,
    clock,
    webStore,
  };
}
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    return error instanceof DomainError ? error.code : String(error);
  }
  return null;
};

test('flag off: signup is refused once the trial ended and the old rules hold', (t) => {
  const f = fixture(t, 0);
  const g = f.guest();
  f.at(T0 + 3 * HOUR); // trial over (2 h), the 24 h cookie still alive
  assert.equal(
    code(() =>
      f.accounts.requestCode({ purpose: 'signup', email: 'a@example.com', ipHash: IP, origin, session: f.session(g) }),
    ),
    'TRIAL_EXPIRED',
  );
  assert.equal(guestInGrace(f.webStore, g.principalId, f.now(), 0), false);
  f.at(T0 + 25 * HOUR); // cookie dead
  assert.equal(f.identity.peekSession(g.token), null);
  assert.equal(
    code(() => f.identity.bootstrap(g.token)),
    'SESSION_EXPIRED',
  );
  // No extra keys appear on GET /account while every flag is off.
  const info = f.accounts.info(undefined);
  assert.deepEqual(info, { signupEnabled: true, signedIn: false });
});

test('flag on: a guest past its trial can still sign up inside the 7-day grace period and its history comes back', async (t) => {
  const f = fixture(t, GUEST_GRACE_MS);
  const g = f.guest();
  f.store.run(
    "INSERT INTO player_profile_versions(world_id,revision,profile_json,updated_at) VALUES (?,1,'{}',?)",
    g.worldId,
    T0,
  );
  // 3 days after the trial ended: far beyond the 24 h cookie, inside the 7-day grace.
  f.at(T0 + 2 * HOUR + 3 * DAY);
  assert.ok(f.identity.peekSession(g.token), 'the session is still usable for signup');
  assert.equal(guestInGrace(f.webStore, g.principalId, f.now(), GUEST_GRACE_MS), true);
  // Still no chat and no history during grace.
  assert.equal(
    code(() => requireWebContent(f.webStore, f.clock, g.principalId, g.worldId)),
    'TRIAL_EXPIRED',
  );
  assert.equal(
    code(() => requireWebContent(f.webStore, f.clock, g.principalId, g.worldId, 'read')),
    'TRIAL_EXPIRED',
  );
  const info = f.accounts.info(g.token) as { grace?: { endsAt: number }; features?: { grace?: boolean } };
  assert.equal(info.grace?.endsAt, T0 + 2 * HOUR + GUEST_GRACE_MS);
  assert.equal(info.features?.grace, true);
  const done = await f.signUp(g);
  assert.equal(done.nickname, '阿泡');
  // Now a kept account: the history is readable again, and chat is still closed (admission is unchanged).
  assert.ok(requireWebContent(f.webStore, f.clock, g.principalId, g.worldId, 'read'));
  assert.equal(
    code(() => requireWebContent(f.webStore, f.clock, g.principalId, g.worldId)),
    'TRIAL_EXPIRED',
  );
  assert.equal((f.accounts.info(g.token) as { grace?: unknown }).grace, undefined, 'no grace line once signed up');
  // The cleaner's due predicate skips it at expires_at + grace, however late.
  const due = guestPurgeDue(f.webStore, T0 + 2 * HOUR + GUEST_GRACE_MS + DAY, GUEST_GRACE_MS);
  assert.deepEqual(f.store.all(`SELECT r.principal_id FROM web_guest_retention r WHERE ${due.sql}`, ...due.args), []);
});

test('flag on: after the grace period the cookie is dead and signup is impossible for the old guest', (t) => {
  const f = fixture(t, GUEST_GRACE_MS);
  const g = f.guest();
  f.at(T0 + 2 * HOUR + GUEST_GRACE_MS); // exactly at the end
  assert.equal(guestInGrace(f.webStore, g.principalId, f.now(), GUEST_GRACE_MS), false);
  assert.equal(f.identity.peekSession(g.token), null);
  assert.equal(f.identity.expiredGuest(g.token), true, 'bootstrap can tell it is a naturally expired guest cookie');
  assert.equal(
    code(() =>
      f.accounts.requestCode({
        purpose: 'signup',
        email: 'late@example.com',
        ipHash: IP,
        origin,
        session: f.session(g),
      }),
    ),
    'SESSION_EXPIRED',
  );
  // A fresh visit starts a brand new empty guest that can sign up normally.
  const fresh = f.guest();
  assert.notEqual(fresh.principalId, g.principalId);
  assert.ok(
    f.accounts.requestCode({
      purpose: 'signup',
      email: 'fresh@example.com',
      ipHash: IP,
      origin,
      session: f.session(fresh),
    }),
  );
});

test('purge timing: without a login at expires_at + 7 days, with a login not at all (180 idle days instead)', async (t) => {
  const f = fixture(t, GUEST_GRACE_MS);
  const plain = f.guest(),
    kept = f.guest();
  await f.signUp(kept);
  const dueAt = (now: number, grace: number) => {
    const due = guestPurgeDue(f.webStore, now, grace);
    return f.store
      .all<{ principal_id: string }>(`SELECT r.principal_id FROM web_guest_retention r WHERE ${due.sql}`, ...due.args)
      .map((row) => row.principal_id);
  };
  const end = T0 + 2 * HOUR;
  assert.deepEqual(dueAt(end, 0), [plain.principalId], 'flag off: purged right at expires_at (as before)');
  assert.deepEqual(dueAt(end + GUEST_GRACE_MS - 1, GUEST_GRACE_MS), [], 'flag on: not one millisecond early');
  assert.deepEqual(
    dueAt(end + GUEST_GRACE_MS, GUEST_GRACE_MS),
    [plain.principalId],
    'flag on: due at expires_at + 7 d',
  );
  assert.deepEqual(dueAt(end + 60 * DAY, GUEST_GRACE_MS), [plain.principalId], 'the signed-up guest is never due yet');
});

test('the flag parser: grace defaults to off and only the string "true" turns it on', () => {
  assert.equal(webPublicFromEnv({}).graceMs, 0);
  assert.equal(webPublicFromEnv({ GUEST_GRACE_ENABLED: 'false' }).graceMs, 0);
  assert.equal(webPublicFromEnv({ GUEST_GRACE_ENABLED: '1' }).graceMs, 0);
  assert.equal(webPublicFromEnv({ GUEST_GRACE_ENABLED: 'true' }).graceMs, GUEST_GRACE_MS);
});
