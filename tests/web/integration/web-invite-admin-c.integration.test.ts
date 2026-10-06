import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { WebInviteAdmin } from '../../../apps/server/invites/web-invite-admin.ts';
import { routeWebInvite } from '../../../apps/server/invites/web-invite-routes.ts';
const origin = 'https://127.0.0.1:18452';

type Admin = {
  issueLoginGrant(): { token: string; expiresAt: number };
  login(token: unknown, origin: unknown): { cookie: string; csrf: string; expiresAt: number };
  authorize(cookie: unknown, csrf: unknown, origin: unknown): { sessionId: string; expiresAt: number };
  logout(cookie: unknown): void;
};
type AdminCtor = new (
  store: MemoryStore,
  clock: { now(): number },
  origin: string,
  random: (size: number) => Buffer,
  nextId: () => string,
) => Admin;
type Route = (
  actions: object,
  request: { method: string; path: string; origin?: string; csrf?: string; adminCookie?: string; body?: unknown },
  admin?: Admin,
) => { status: number; body: unknown; issuedAdminCookie?: string };

// Test the current source, not private repository history.
const newCode = { Admin: WebInviteAdmin as unknown as AdminCtor, route: routeWebInvite as unknown as Route };

class MemoryStore {
  readonly db = new DatabaseSync(':memory:');
  constructor() {
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE admin_sessions (
        id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, revoked_at INTEGER
      ) STRICT;
      CREATE TABLE admin_login_grants (
        token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL,
        consumed_session_id TEXT REFERENCES admin_sessions(id)
      ) STRICT;`);
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]) {
    return this.db.prepare(sql).run(...params);
  }
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() {
    this.db.close();
  }
}
function fixture(t: { after(callback: () => void): void }, Admin: AdminCtor, seed = 1) {
  const store = new MemoryStore();
  t.after(() => store.close());
  let now = 1_700_000_000_000,
    next = seed;
  const admin = new Admin(
    store,
    { now: () => now },
    origin,
    (size) => Buffer.alloc(size, next++),
    () => `admin-session-${next++}`,
  );
  return {
    store,
    admin,
    now: () => now,
    setNow: (value: number) => {
      now = value;
    },
  };
}
function code(expected: string) {
  return (error: unknown) => typeof error === 'object' && error !== null && 'code' in error && error.code === expected;
}

test('multibyte CSRF is rejected by domain code, never RangeError', (t) => {
  const fixed = fixture(t, newCode.Admin, 20);
  const grant = fixed.admin.issueLoginGrant(),
    login = fixed.admin.login(grant.token, origin);
  assert.throws(() => fixed.admin.authorize(login.cookie, '界'.repeat(64), origin), code('ADMIN_CSRF_REQUIRED'));
  assert.equal(fixed.admin.authorize(login.cookie, login.csrf, origin).expiresAt, login.expiresAt);
});

test('one grant is consumed once; unused grant and session expire at exact deadlines', (t) => {
  const f = fixture(t, newCode.Admin);
  const grant = f.admin.issueLoginGrant();
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(f.store.db.prepare('SELECT * FROM admin_login_grants').all()).includes(grant.token));
  assert.throws(() => f.admin.login(grant.token, 'https://wrong.local'), code('ADMIN_UNAUTHORIZED'));
  const first = f.admin.login(grant.token, origin);
  assert.throws(() => f.admin.login(grant.token, origin), code('ADMIN_INVALID_GRANT'));
  assert.equal(f.admin.authorize(first.cookie, first.csrf, origin).expiresAt, first.expiresAt);
  const unused = f.admin.issueLoginGrant();
  f.setNow(unused.expiresAt);
  assert.throws(() => f.admin.login(unused.token, origin), code('ADMIN_INVALID_GRANT'));
  f.setNow(first.expiresAt - 1);
  assert.equal(f.admin.authorize(first.cookie, first.csrf, origin).expiresAt, first.expiresAt);
  f.setNow(first.expiresAt);
  assert.throws(() => f.admin.authorize(first.cookie, first.csrf, origin), code('ADMIN_UNAUTHORIZED'));
});

test('logout revokes only its session, and separate in-memory Web instances reject each other', (t) => {
  const a = fixture(t, newCode.Admin, 1),
    b = fixture(t, newCode.Admin, 50);
  const grantA = a.admin.issueLoginGrant();
  assert.throws(() => b.admin.login(grantA.token, origin), code('ADMIN_INVALID_GRANT'));
  const loginA = a.admin.login(grantA.token, origin);
  assert.throws(() => b.admin.authorize(loginA.cookie, loginA.csrf, origin), code('ADMIN_UNAUTHORIZED'));
  const grantB = b.admin.issueLoginGrant(),
    loginB = b.admin.login(grantB.token, origin);
  a.admin.logout(loginA.cookie);
  assert.throws(() => a.admin.authorize(loginA.cookie, loginA.csrf, origin), code('ADMIN_UNAUTHORIZED'));
  assert.throws(() => a.admin.logout(loginA.cookie), code('ADMIN_UNAUTHORIZED'));
  assert.equal(b.admin.authorize(loginB.cookie, loginB.csrf, origin).expiresAt, loginB.expiresAt);
});

test('unserved route login/logout enforce Origin, CSRF, exact body and no token in body', (t) => {
  const f = fixture(t, newCode.Admin);
  const grant = f.admin.issueLoginGrant();
  const loginRequest = { method: 'POST', path: '/api/web/local/admin/login', origin, body: { token: grant.token } };
  assert.throws(
    () => newCode.route({}, { method: 'POST', path: '/api/web/local/admin/grant', origin, body: {} }, f.admin),
    code('NOT_FOUND'),
  );
  assert.throws(
    () => newCode.route({}, { ...loginRequest, path: '/api/web/local/admin/login?token=fake' }, f.admin),
    code('NOT_FOUND'),
  );
  assert.throws(
    () => newCode.route({}, { ...loginRequest, origin: 'https://wrong.local' }, f.admin),
    code('ADMIN_UNAUTHORIZED'),
  );
  assert.throws(
    () => newCode.route({}, { ...loginRequest, body: { token: grant.token, extra: 1 } }, f.admin),
    code('INVALID_REQUEST'),
  );
  const reply = newCode.route({}, loginRequest, f.admin);
  assert.equal(reply.status, 200);
  assert.ok(reply.issuedAdminCookie);
  assert.ok(!JSON.stringify(reply.body).includes(reply.issuedAdminCookie!));
  assert.ok(!JSON.stringify(reply.body).includes(grant.token));
  const csrf = (reply.body as { csrf: string }).csrf,
    adminCookie = reply.issuedAdminCookie!;
  const logout = { method: 'POST', path: '/api/web/local/admin/logout', origin, csrf, adminCookie, body: {} };
  assert.throws(
    () => newCode.route({}, { ...logout, origin: 'https://wrong.local' }, f.admin),
    code('ADMIN_UNAUTHORIZED'),
  );
  assert.throws(() => newCode.route({}, { ...logout, csrf: '界'.repeat(64) }, f.admin), code('ADMIN_CSRF_REQUIRED'));
  assert.throws(() => newCode.route({}, { ...logout, csrf: '0'.repeat(64) }, f.admin), code('ADMIN_CSRF_REQUIRED'));
  assert.equal(newCode.route({}, logout, f.admin).status, 200);
  assert.throws(() => newCode.route({}, logout, f.admin), code('ADMIN_UNAUTHORIZED'));
});
