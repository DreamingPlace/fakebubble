import { hasInvitePermission, type InviteAdminPermission } from '../../../packages/contracts/web-admin-permissions.ts';
import { createHash } from 'node:crypto';
import { ensure } from '../../../packages/domain/errors.ts';
import type { BusinessStore } from '../platform/store-contract.ts';

// Versioned additive extension of the web authority, not a rewrite of deployed schema113.
const statements = [
  `CREATE TABLE web_admin_members(id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('owner','admin')),
    label TEXT NOT NULL,email TEXT UNIQUE,password_hash TEXT,credential_version INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,permissions_json TEXT NOT NULL CHECK(json_valid(permissions_json)),
    CHECK((email IS NULL AND password_hash IS NULL) OR (email IS NOT NULL AND password_hash IS NOT NULL))) STRICT`,
  `CREATE UNIQUE INDEX web_admin_one_owner ON web_admin_members(role) WHERE role='owner'`,
  `CREATE TABLE web_admin_session_members(session_id TEXT PRIMARY KEY REFERENCES admin_sessions(id),
    member_id TEXT NOT NULL REFERENCES web_admin_members(id)) STRICT`,
  `CREATE TABLE web_admin_grant_members(token_hash TEXT PRIMARY KEY REFERENCES admin_login_grants(token_hash),
    id TEXT NOT NULL UNIQUE,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    issued_by TEXT REFERENCES web_admin_members(id),request_key TEXT UNIQUE,request_hash TEXT,
    revoked_at INTEGER) STRICT`,
  `CREATE TABLE web_admin_challenges(id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES web_admin_members(id),
    purpose TEXT NOT NULL CHECK(purpose IN ('bind','reset')),email TEXT NOT NULL,code_hash TEXT NOT NULL,
    credential_version INTEGER NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER,delivery TEXT NOT NULL CHECK(delivery IN ('pending','accepted','unknown'))) STRICT`,
  `CREATE TABLE web_admin_rates(key TEXT PRIMARY KEY,until_ms INTEGER NOT NULL,count INTEGER NOT NULL) STRICT`,
  `CREATE TABLE web_admin_audit(seq INTEGER PRIMARY KEY AUTOINCREMENT,actor_id TEXT,
    action TEXT NOT NULL,target_id TEXT NOT NULL,created_at INTEGER NOT NULL) STRICT`,
] as const;
export function installWebAdminSchema(store: BusinessStore) {
  const digest = createHash('sha256').update(statements.join(';\n')).digest('hex');
  store.transaction(() => {
    if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_admin_schema'")) {
      ensure(!store.get("SELECT 1 FROM sqlite_master WHERE name GLOB 'web_admin_*'"), 'WEB_ADMIN_SCHEMA_MISMATCH');
      for (const sql of statements) store.all(sql);
      store.all('CREATE TABLE web_admin_schema(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
      store.run('INSERT INTO web_admin_schema VALUES (1,?)', digest);
    }
    const rows = store.all<{ version: number; sha256: string }>('SELECT * FROM web_admin_schema');
    ensure(rows.length === 1 && rows[0]!.version === 1 && rows[0]!.sha256 === digest, 'WEB_ADMIN_SCHEMA_MISMATCH');
  });
}

/** Legacy synthetic/original stores have no account extension. Provider sessions must be mapped. */
export function requireWebAdminMembership(
  store: BusinessStore,
  sessionId: string,
  permission: InviteAdminPermission | 'invites.revoke',
) {
  if (!store.get("SELECT 1 FROM sqlite_master WHERE name='web_admin_schema'")) return;
  const row = store.get<{ role: string; permissions_json: string }>(
    `SELECT m.role,m.permissions_json
    FROM web_admin_session_members s JOIN web_admin_members m ON m.id=s.member_id WHERE s.session_id=?`,
    sessionId,
  );
  ensure(row, 'ADMIN_UNAUTHORIZED');
  ensure(
    row.role === 'owner' || hasInvitePermission(JSON.parse(row.permissions_json) as string[], permission),
    'ADMIN_PERMISSION_REQUIRED',
  );
}
