import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes, scryptSync } from 'node:crypto';
import { Store } from '../../../apps/server/store.ts';
import { WebInviteAdmin } from '../../../apps/server/web-invite-admin.ts';
import { WebAccountAdmin, type AdminMailer } from '../../../apps/server/web-account-admin.ts';
import { requireWebAdminMembership } from '../../../apps/server/web-admin-schema.ts';
import { adminPasswords, validateAdminPassword } from '../../../apps/server/web-admin-password.ts';
import { ADMIN_CHARACTER_ACTIONS, ADMIN_PERMISSION_LIMIT } from '../../../packages/contracts/web-admin-permissions.ts';
import { cloudAdminMailer } from '../../../apps/server/cloudflare/web-admin-mail.ts';

const origin = 'https://admin.fixture.invalid',
  peer = 'a'.repeat(64),
  password = 'Offline test 123';
function fixture(
  t: test.TestContext,
  options: { mail?: boolean; passwords?: typeof adminPasswords; random?: (size: number) => Buffer } = {},
) {
  const store = new Store(':memory:');
  let now = 1_800_000_000_000;
  const mail: Parameters<AdminMailer['send']>[0][] = [],
    pending: Promise<void>[] = [];
  const clock = { now: () => now };
  const admin = new WebAccountAdmin(store, clock, origin, {
    ...(options.mail === false
      ? {}
      : {
          mailer: {
            send: async (message) => {
              mail.push(message);
            },
            waitUntil: (task) => {
              pending.push(task);
            },
          } as AdminMailer,
        }),
    ...(options.passwords ? { passwords: options.passwords } : {}),
    ...(options.random ? { random: options.random } : {}),
  });
  t.after(async () => {
    await Promise.all(pending);
    store.close();
  });
  const ownerGrant = admin.issueLoginGrant(),
    owner = admin.login(ownerGrant.token, origin);
  const auth = [owner.cookie, owner.csrf, origin] as const;
  const create = (label = '协作管理员') => {
    const grant = admin.issueMember(...auth, {
      requestId: crypto.randomUUID(),
      label,
      memberId: null,
      permissions: ['invites.issue', 'invites.revoke'],
    });
    assert.ok(grant.token);
    return { grant, session: admin.login(grant.token, origin) };
  };
  const bind = async (session: typeof owner, email = 'admin@example.com') => {
    const challenge = await admin.startBinding(session.cookie, session.csrf, origin, email);
    await Promise.all(pending);
    const message = mail.find((m) => m.id === challenge.challengeId)!;
    return admin.finishBinding(session.cookie, session.csrf, origin, challenge.challengeId, message.code, password);
  };
  return {
    store,
    admin,
    clock,
    mail,
    pending,
    owner,
    ownerGrant,
    auth,
    create,
    bind,
    advance(ms: number) {
      now += ms;
    },
  };
}

test('one-time credentials grant immediate access; binding optional; only private bootstrap creates owner', (t) => {
  const f = fixture(t),
    { session } = f.create();
  assert.equal(f.owner.member.role, 'owner');
  assert.equal(session.member.role, 'admin');
  assert.equal(session.member.email, null);
  const id = f.admin.authorize(session.cookie, session.csrf, origin).sessionId;
  requireWebAdminMembership(f.store, id, 'invites.issue');
  assert.throws(() => f.admin.login(f.ownerGrant.token, origin), /ADMIN_INVALID_GRANT/);
  assert.throws(() => f.admin.list(session.cookie, session.csrf, origin), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => f.admin.setPermissions(...f.auth, f.owner.member.id, []), /ADMIN_OWNER_PROTECTED/);
  assert.throws(() => f.admin.setPermissions(...f.auth, session.member.id, ['root']), /INVALID_REQUEST/);
});

test('per-feature removal/addition and all-permission removal preserve every session and login identity', async (t) => {
  const f = fixture(t),
    { session } = f.create(),
    bound = await f.bind(session);
  const second = await f.admin.emailLogin('ADMIN@example.com', password, origin, peer);
  const firstId = f.admin.authorize(bound.cookie, bound.csrf, origin).sessionId;
  f.admin.setPermissions(...f.auth, bound.member.id, ['invites.revoke']);
  assert.throws(() => requireWebAdminMembership(f.store, firstId, 'invites.issue'), /ADMIN_PERMISSION_REQUIRED/);
  requireWebAdminMembership(f.store, firstId, 'invites.revoke');
  f.admin.setPermissions(...f.auth, bound.member.id, []);
  for (const s of [bound, second]) assert.deepEqual(f.admin.session(s.cookie).member.permissions, []);
  const third = await f.admin.emailLogin('admin@example.com', password, origin, peer);
  assert.deepEqual(third.member.permissions, []);
  f.admin.setPermissions(...f.auth, bound.member.id, ['invites.issue']);
  requireWebAdminMembership(f.store, firstId, 'invites.issue');
  assert.equal(f.admin.session(second.cookie).member.id, bound.member.id);
});

test('permission changes do not invalidate pending email binding or restore removed privileges on completion', async (t) => {
  const f = fixture(t),
    { session } = f.create();
  const challenge = await f.admin.startBinding(session.cookie, session.csrf, origin, 'new@example.com');
  await Promise.all(f.pending);
  f.admin.setPermissions(...f.auth, session.member.id, []);
  const bound = await f.admin.finishBinding(
    session.cookie,
    session.csrf,
    origin,
    challenge.challengeId,
    f.mail[0]!.code,
    password,
  );
  assert.deepEqual(bound.member.permissions, []);
  assert.throws(
    () =>
      requireWebAdminMembership(
        f.store,
        f.admin.authorize(bound.cookie, bound.csrf, origin).sessionId,
        'invites.issue',
      ),
    /ADMIN_PERMISSION_REQUIRED/,
  );
});

test('email binding verifies recipient, stores only KDF/code digest, rotates session and survives reconstruction', async (t) => {
  const f = fixture(t),
    { session } = f.create(),
    bound = await f.bind(session);
  assert.equal(bound.member.email, 'admin@example.com');
  assert.notEqual(bound.cookie, session.cookie);
  assert.throws(() => f.admin.session(session.cookie), /ADMIN_UNAUTHORIZED/);
  const db = JSON.stringify([
    f.store.all('SELECT * FROM web_admin_members'),
    f.store.all('SELECT * FROM web_admin_challenges'),
  ]);
  assert.ok(!db.includes(password));
  assert.ok(!db.includes(f.mail[0]!.code));
  assert.ok(!db.includes(bound.cookie));
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  assert.equal(restarted.session(bound.cookie).member.id, session.member.id);
  assert.equal((await restarted.emailLogin('admin@example.com', password, origin, peer)).member.id, session.member.id);
  await assert.rejects(restarted.emailLogin('absent@example.com', password, origin, peer), /ADMIN_LOGIN_INVALID/);
  await assert.rejects(
    restarted.emailLogin('admin@example.com', 'different-password-123', origin, peer),
    /ADMIN_LOGIN_INVALID/,
  );
});

test('password reset is one-use, invalidates sessions for credential safety, never restores permissions', async (t) => {
  const f = fixture(t),
    { session } = f.create(),
    bound = await f.bind(session);
  f.admin.setPermissions(...f.auth, bound.member.id, []);
  const reset = await f.admin.startReset('admin@example.com', origin, peer);
  await Promise.all(f.pending);
  const message = f.mail.find((m) => m.id === reset.challengeId)!;
  await f.admin.finishReset(origin, peer, reset.challengeId, message.code, 'Replacement 456');
  assert.throws(() => f.admin.session(bound.cookie), /ADMIN_UNAUTHORIZED/);
  assert.deepEqual(
    (await f.admin.emailLogin('admin@example.com', 'Replacement 456', origin, peer)).member.permissions,
    [],
  );
  await assert.rejects(
    f.admin.finishReset(origin, peer, reset.challengeId, message.code, password),
    /ADMIN_CODE_INVALID/,
  );
  const absent = await f.admin.startReset('absent@example.com', origin, peer);
  assert.deepEqual(Object.keys(absent).sort(), Object.keys(reset).sort());
  await Promise.all(f.pending);
  assert.equal(f.mail.length, 2);
});

test('five incorrect codes lock verification; foreign member, expiry and cross-origin are rejected', async (t) => {
  const f = fixture(t),
    a = f.create('A').session,
    b = f.create('B').session;
  const challenge = await f.admin.startBinding(a.cookie, a.csrf, origin, 'a@example.com');
  await Promise.all(f.pending);
  await assert.rejects(
    f.admin.finishBinding(b.cookie, b.csrf, origin, challenge.challengeId, f.mail[0]!.code, password),
    /ADMIN_CODE_INVALID/,
  );
  for (let n = 0; n < 5; n++)
    await assert.rejects(
      f.admin.finishBinding(
        a.cookie,
        a.csrf,
        origin,
        challenge.challengeId,
        f.mail[0]!.code === '000000' ? '000001' : '000000',
        password,
      ),
      /ADMIN_CODE_INVALID/,
    );
  await assert.rejects(
    f.admin.finishBinding(a.cookie, a.csrf, origin, challenge.challengeId, f.mail[0]!.code, password),
    /ADMIN_CODE_INVALID/,
  );
  f.advance(10 * 60_000 + 1);
  await assert.rejects(
    f.admin.finishBinding(a.cookie, a.csrf, origin, challenge.challengeId, f.mail[0]!.code, password),
    /ADMIN_CODE_INVALID/,
  );
  await assert.rejects(
    f.admin.emailLogin('a@example.com', password, 'https://evil.invalid', peer),
    /ADMIN_UNAUTHORIZED/,
  );
  assert.throws(() => f.admin.setPermissions(a.cookie, a.csrf, origin, b.member.id, []), /ADMIN_OWNER_REQUIRED/);
});

test('existing email never silently merges administrator identities', async (t) => {
  const f = fixture(t),
    a = f.create('A').session,
    b = f.create('B').session;
  await f.bind(a);
  await assert.rejects(f.bind(b), /ADMIN_EMAIL_UNAVAILABLE_FOR_BINDING/);
  assert.equal(f.admin.session(b.cookie).member.email, null);
});

test('grant revocation is separate from permission removal; exact issuance replay never returns another secret', (t) => {
  const f = fixture(t),
    input = { requestId: 'one-request', label: 'Pending', memberId: null, permissions: ['invites.issue'] };
  const grant = f.admin.issueMember(...f.auth, input),
    duplicate = f.admin.issueMember(...f.auth, input);
  assert.equal(duplicate.token, null);
  assert.equal(duplicate.memberId, grant.memberId);
  assert.throws(() => f.admin.issueMember(...f.auth, { ...input, permissions: [] }), /IDEMPOTENCY_CONFLICT/);
  f.admin.setPermissions(...f.auth, grant.memberId, []);
  assert.deepEqual(f.admin.login(grant.token, origin).member.permissions, []);
  const pending = f.admin.issueMember(...f.auth, { ...input, requestId: 'another', memberId: grant.memberId });
  f.admin.revokeGrant(...f.auth, pending.grantId);
  assert.throws(() => f.admin.login(pending.token, origin), /ADMIN_INVALID_GRANT/);
  assert.ok(!JSON.stringify(f.admin.list(...f.auth)).includes(grant.token!));
});

test('legacy sessions/grants never become owner; schema extension is additive and hash-checked', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const clock = { now: () => 1_800_000_000_000 },
    old = new WebInviteAdmin(store, clock, origin);
  const grant = old.issueLoginGrant(),
    session = old.login(grant.token, origin),
    unused = old.issueLoginGrant();
  const version = store.get('PRAGMA user_version'),
    admin = new WebAccountAdmin(store, clock, origin);
  assert.deepEqual(store.get('PRAGMA user_version'), version);
  assert.throws(() => admin.session(session.cookie), /ADMIN_UNAUTHORIZED/);
  assert.throws(() => admin.login(unused.token, origin), /ADMIN_INVALID_GRANT/);
  assert.equal(store.get<{ n: number }>('SELECT count(*) n FROM admin_sessions')!.n, 1);
  store.run("UPDATE web_admin_schema SET sha256='bad'");
  assert.throws(() => new WebAccountAdmin(store, clock, origin), /WEB_ADMIN_SCHEMA_MISMATCH/);
});

test('persistent rate gates survive reconstruction; missing delivery is explicitly unavailable', async (t) => {
  const f = fixture(t, { mail: false });
  await assert.rejects(f.admin.startBinding(...f.auth, 'owner@example.com'), /ADMIN_EMAIL_UNAVAILABLE/);
  assert.equal(f.admin.session(f.owner.cookie).emailDeliveryAvailable, false);
  for (let i = 0; i < 6; i++) f.admin.guard('login', peer);
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  assert.throws(() => restarted.guard('login', peer), /RATE_LIMITED/);
  f.advance(60_001);
  restarted.guard('login', peer);
});

test('logout during password hashing cannot create a new binding session', async (t) => {
  let release!: () => void, enter!: () => void;
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const f = fixture(t, {
    passwords: {
      ...adminPasswords,
      hash: async (password) => {
        enter();
        await gate;
        return adminPasswords.hash(password);
      },
    },
  });
  const challenge = await f.admin.startBinding(...f.auth, 'owner@example.com');
  await Promise.all(f.pending);
  const finish = f.admin.finishBinding(...f.auth, challenge.challengeId, f.mail[0]!.code, password);
  const rejection = assert.rejects(finish, /ADMIN_UNAUTHORIZED/);
  await entered;
  f.admin.logout(f.owner.cookie);
  release();
  await rejection;
  assert.equal(
    f.store.get<{ email: string | null }>('SELECT email FROM web_admin_members WHERE id=?', f.owner.member.id)!.email,
    null,
  );
});

test('Cloudflare mail adapter has bounded plain-text content and does not retry rejected sends', async () => {
  let calls = 0;
  const mailer = cloudAdminMailer(
    {
      send: async (message) => {
        calls++;
        assert.equal(message.from, 'no-reply@mail.example.com');
        assert.equal(message.to, 'admin@example.com');
        assert.ok(!('html' in message));
        assert.match(message.text, /不会授予或恢复管理权限/);
        throw Error('ambiguous');
      },
    },
    'no-reply@mail.example.com',
    () => {},
  );
  await assert.rejects(
    mailer.send({ id: 'request', to: 'admin@example.com', purpose: 'bind', code: '123456', expiresAt: 0 }),
    /ambiguous/,
  );
  assert.equal(calls, 1);
});

test('permission CAS rejects stale owner changes, validates 15-role matrix, preserves exact active sessions and restart', (t) => {
  const f = fixture(t),
    { session } = f.create();
  const old = session.member.permissions;
  const matrix = Array.from({ length: 15 }, (_, i) =>
    ADMIN_CHARACTER_ACTIONS.map((a) => `characters.${a}:role-${i}`),
  ).flat();
  const all = [
    ...matrix,
    'characters.create',
    'invites.read',
    'invites.issue',
    'invites.revoke-code',
    'invites.revoke-access',
  ];
  assert.equal(all.length, 125);
  f.admin.setPermissions(...f.auth, session.member.id, all, old);
  assert.throws(() => f.admin.setPermissions(...f.auth, session.member.id, [], old), /ADMIN_PERMISSIONS_CONFLICT/);
  assert.deepEqual(f.admin.session(session.cookie).member.permissions, all.sort());
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  assert.deepEqual(restarted.session(session.cookie).member.permissions, all);
  const tooMany = Array.from({ length: ADMIN_PERMISSION_LIMIT + 1 }, (_, i) => `characters.read:role-${i}`);
  assert.throws(() => f.admin.setPermissions(...f.auth, session.member.id, tooMany), /INVALID_REQUEST/);
  f.admin.setPermissions(...f.auth, session.member.id, [], all);
  assert.deepEqual(f.admin.session(session.cookie).member.permissions, []);
});

test('split invitation revocations are independent and legacy combined grants exactly the original two actions', (t) => {
  const f = fixture(t),
    { session } = f.create(),
    id = f.admin.authorize(session.cookie, session.csrf, origin).sessionId;
  for (const permission of ['invites.revoke-code', 'invites.revoke-access'] as const)
    requireWebAdminMembership(f.store, id, permission);
  assert.throws(() => requireWebAdminMembership(f.store, id, 'invites.read'), /ADMIN_PERMISSION_REQUIRED/);
  for (const permission of ['invites.revoke-code', 'invites.revoke-access'] as const) {
    f.admin.setPermissions(...f.auth, session.member.id, [permission]);
    requireWebAdminMembership(f.store, id, permission);
    for (const other of [
      'invites.issue',
      'invites.read',
      permission === 'invites.revoke-code' ? 'invites.revoke-access' : 'invites.revoke-code',
    ] as const)
      assert.throws(() => requireWebAdminMembership(f.store, id, other), /ADMIN_PERMISSION_REQUIRED/);
    assert.equal(f.admin.session(session.cookie).member.id, session.member.id);
  }
});

test('category grants are four product choices, not administrator roles; invitation category does not grant owner access', (t) => {
  const f = fixture(t),
    issued = f.admin.issueMember(...f.auth, {
      requestId: 'category-invite',
      label: '本机账号',
      memberId: null,
      permissions: ['category.invites'],
    });
  const member = f.admin.login(issued.token, origin),
    sessionId = f.admin.authorize(member.cookie, member.csrf, origin).sessionId;
  assert.deepEqual(member.member.permissions, ['category.invites']);
  assert.equal(member.member.role, 'admin');
  for (const permission of ['invites.read', 'invites.issue', 'invites.revoke-code', 'invites.revoke-access'] as const)
    requireWebAdminMembership(f.store, sessionId, permission);
  assert.throws(() => f.admin.list(member.cookie, member.csrf, origin), /OWNER_REQUIRED/);
  f.admin.setPermissions(...f.auth, member.member.id, []);
  assert.throws(() => requireWebAdminMembership(f.store, sessionId, 'invites.issue'), /PERMISSION_REQUIRED/);
  assert.equal(f.admin.session(member.cookie).member.id, member.member.id);
});

test('new passwords allow 8–18 Unicode characters; login accepts the existing 128-character hashes', async (t) => {
  for (const candidate of ['a'.repeat(7), 'a'.repeat(19), '', null])
    assert.throws(() => validateAdminPassword(candidate), /ADMIN_PASSWORD_INVALID/);
  for (const candidate of ['a'.repeat(8), 'a'.repeat(18), '泡'.repeat(8), '🫧'.repeat(18)])
    validateAdminPassword(candidate);
  const shortest = 'Newpwd12',
    encoded = await adminPasswords.hash(shortest);
  assert.equal(await adminPasswords.verify(shortest, encoded), true);
  await assert.rejects(adminPasswords.hash('a'.repeat(19)), /ADMIN_PASSWORD_INVALID/);
  const legacy = 'L'.repeat(128),
    salt = Buffer.alloc(16, 7);
  const oldHash = `scrypt-16384-8-5$${salt.toString('hex')}$${scryptSync(legacy, salt, 32, { N: 16384, r: 8, p: 5, maxmem: 32 * 1024 * 1024 }).toString('hex')}`;
  const f = fixture(t);
  f.store.run(
    'UPDATE web_admin_members SET email=?,password_hash=? WHERE id=?',
    'legacy@example.com',
    oldHash,
    f.owner.member.id,
  );
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  assert.equal((await restarted.emailLogin('legacy@example.com', legacy, origin, peer)).member.id, f.owner.member.id);
  await assert.rejects(
    restarted.emailLogin('legacy@example.com', legacy + 'x', origin, peer),
    /ADMIN_PASSWORD_INVALID/,
  );
});

test('six-digit codes preserve leading zeros, reject biased random tail and retain one-use expiry', async (t) => {
  let draws = 0;
  const f = fixture(t, {
    random: (size) =>
      size !== 4 ? randomBytes(size) : ++draws === 1 ? Buffer.alloc(4, 255) : Buffer.from([0, 0, 0, 7]),
  });
  const challenge = await f.admin.startBinding(...f.auth, 'owner@example.com');
  await Promise.all(f.pending);
  assert.equal(draws, 2);
  assert.equal(f.mail[0]!.code, '000007');
  for (const bad of ['7', '00007', '0000007', 'abcdef'])
    await assert.rejects(f.admin.finishBinding(...f.auth, challenge.challengeId, bad, password), /ADMIN_CODE_INVALID/);
  const result = await f.admin.finishBinding(...f.auth, challenge.challengeId, '000007', '12345678');
  const reset = await f.admin.startReset('owner@example.com', origin, peer);
  await Promise.all(f.pending);
  assert.match(f.mail[1]!.code, /^[0-9]{6}$/);
  f.advance(10 * 60_000);
  await assert.rejects(
    f.admin.finishReset(origin, peer, reset.challengeId, f.mail[1]!.code, password),
    /ADMIN_CODE_INVALID/,
  );
  assert.equal(f.admin.session(result.cookie).member.email, 'owner@example.com');
});

test('six-digit failed-attempt limit survives reconstruction and issuance never retries delivery', async (t) => {
  const f = fixture(t),
    challenge = await f.admin.startBinding(...f.auth, 'owner@example.com');
  await Promise.all(f.pending);
  const code = f.mail[0]!.code,
    bad = code === '000000' ? '000001' : '000000';
  for (let n = 0; n < 4; n++)
    await assert.rejects(f.admin.finishBinding(...f.auth, challenge.challengeId, bad, password), /ADMIN_CODE_INVALID/);
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  await assert.rejects(restarted.finishBinding(...f.auth, challenge.challengeId, bad, password), /ADMIN_CODE_INVALID/);
  await assert.rejects(restarted.finishBinding(...f.auth, challenge.challengeId, code, password), /ADMIN_CODE_INVALID/);
  assert.equal(f.mail.length, 1);
});

test('an in-flight legacy code still works only for its original challenge; no new legacy codes are issued', async (t) => {
  const f = fixture(t),
    challenge = await f.admin.startBinding(...f.auth, 'owner@example.com');
  await Promise.all(f.pending);
  assert.match(f.mail[0]!.code, /^[0-9]{6}$/);
  const legacy = 'ABCDEF0123456789';
  f.store.run(
    'UPDATE web_admin_challenges SET code_hash=? WHERE id=?',
    createHash('sha256').update(`${challenge.challengeId}\0${legacy}`).digest('hex'),
    challenge.challengeId,
  );
  const restarted = new WebAccountAdmin(f.store, f.clock, origin);
  const bound = await restarted.finishBinding(...f.auth, challenge.challengeId, legacy.toLowerCase(), password);
  assert.equal(bound.member.email, 'owner@example.com');
});
