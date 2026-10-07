import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  inspectBudget,
  inspectErrorCode,
  inspectWebAuthority,
  type WebInspectExpected,
} from '../../../apps/server/cloudflare/web-inspect.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';

registerSqlTextLoader();
const { webMigrations, webR2Migrations, expectedWebMigrations } = await import(
  '../../../workers/web-cloudflare/migrations.ts'
);
const sha = (sql: string) => createHash('sha256').update(sql).digest('hex');
const expected: WebInspectExpected = { active: 'r2', ...expectedWebMigrations() };
const SECRET = {
  email: 'owner-sentinel@example.invalid',
  passwordHash: 'PASSWORD_HASH_SENTINEL',
  inviteCode: 'INVITE_CODE_SENTINEL',
  text: 'MESSAGE_TEXT_SENTINEL',
  memory: 'MEMORY_SENTINEL',
};

/** The deployed shape: every cloud R2 step applied, the ledger written the way the store writes it. */
function authority(options: { owner?: boolean } = {}) {
  const db = new DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
  db.exec('CREATE TABLE cf_web_migrations(version INTEGER PRIMARY KEY,sha256 TEXT NOT NULL) STRICT');
  for (const m of webR2Migrations) {
    db.exec(m.sql);
    db.prepare('INSERT INTO cf_web_migrations VALUES (?,?)').run(m.version, sha(m.sql));
  }
  db.prepare('INSERT INTO web_instance(singleton,instance_id,recovery_epoch) VALUES (1,?,?)').run(
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
  );
  if (options.owner)
    db.exec(`CREATE TABLE web_admin_members(id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('owner','admin')),
      label TEXT NOT NULL,email TEXT UNIQUE,password_hash TEXT,credential_version INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,permissions_json TEXT NOT NULL,
      CHECK((email IS NULL AND password_hash IS NULL) OR (email IS NOT NULL AND password_hash IS NOT NULL))) STRICT;
      INSERT INTO web_admin_members VALUES ('member-1','owner','${SECRET.text}','${SECRET.email}','${SECRET.passwordHash}',1,1,'[]')`);
  const statements: string[] = [];
  return {
    db,
    statements,
    // Every statement inspect issues is recorded and must be a plain SELECT.
    reader: {
      all: <T>(sql: string, ...params: (string | number)[]) => {
        statements.push(sql);
        assert.match(sql, /^\s*SELECT\b/i, 'inspect may only SELECT');
        return db.prepare(sql).all(...params) as T[];
      },
    },
  };
}
const budget = inspectBudget([
  { provider: 'deepseek', spentMicros: 7, heldMicros: 3, grantHash: 'GRANT_HASH_SENTINEL', policy: 'x' },
  { provider: 'fish', spentMicros: 0, heldMicros: 0, grantHash: 'GRANT_HASH_SENTINEL', policy: 'x' },
]);
const flags = { PUBLIC_ENABLED: 'false', EXTERNAL_CALLS: 'true', OPERATOR_ENABLED: 'true' };
function snapshot(db: DatabaseSync) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
    name: string;
  }[];
  return JSON.stringify(
    {
      schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
      tables: tables.map((t) => [t.name, db.prepare(`SELECT * FROM "${t.name}" ORDER BY rowid`).all()]),
      changes: (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n,
    },
    (_key, value) =>
      typeof value === 'bigint'
        ? String(value)
        : value instanceof Uint8Array
          ? Buffer.from(value).toString('hex')
          : value,
  );
}
function seedUnknowns(db: DatabaseSync) {
  for (const [id, phase, ordinal, state] of [
    ['op-b', 'speech', 0, 'unknown'],
    ['op-a', 'draft', -1, 'unknown'],
    ['op-c', 'review', -1, 'known'],
    ['op-d', 'draft', -1, 'sent'],
  ] as const)
    db.prepare(
      `INSERT INTO web_provider_attempts(operation_id,phase,ordinal,principal_id,player_id,world_id,conversation_id,character_id,
        input_message_id,request_digest,policy_hash,wire_request_hash,voice_version,provider,model,price_id,max_units,held_micros,
        state,sent_at,settled_at,outcome,usage_units,charged_micros,created_at)
       VALUES (?,?,?, 'p','pl','w','c','ch','${SECRET.text}','r','po','wi','v','deepseek','m','price',1,1,
        ?,?,?,?,?,?,1)`,
    ).run(
      id,
      phase,
      ordinal,
      state,
      state === 'known' ? 1 : 1,
      state === 'known' ? 2 : null,
      state === 'known' ? 'succeeded' : null,
      state === 'known' ? 1 : null,
      state === 'known' ? 1 : null,
    );
  for (const [operation, stage, phase, ordinal, state] of [
    ['op-x', 'text', 'draft', -1, 'unknown'],
    ['op-y', 'audio', 'speech', 2, 'unknown'],
    ['op-z', 'text', 'review', -1, 'not_sent'],
  ] as const)
    db.prepare(
      `INSERT INTO web_external_attempts(operation_id,stage,phase,ordinal,provider,provider_request_id,dispatch_state,stage_version,
        lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id,created_at,sent_at)
       VALUES (?,?,?,?,'deepseek',?,?,1,1,'lease','p','w','c','${SECRET.text}',1,?)`,
    ).run(operation, stage, phase, ordinal, 'REQUEST_ID_SENTINEL-' + operation, state, state === 'not_sent' ? null : 1);
  db.exec(
    `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,operation_id,model,texts,max_units,price_micros_per_million,held_micros,items_json,state,lease_expires_at,created_at,sent_at)
     VALUES ('embed-2','index','w','c','ch',NULL,'m',1,10,5,5,'["${SECRET.memory}"]','unknown',1,1,1),
            ('embed-1','query','w','c','ch','op-q1','m',1,10,5,5,NULL,'unknown',1,1,1),
            ('embed-3','query','w','c','ch','op-q3','m',1,10,5,5,NULL,'sent',1,1,1)`,
  );
}

test('inspect reports the deployed ledger next to the expected steps and matches only when every step is identical', () => {
  const { reader } = authority();
  const report = inspectWebAuthority(reader, expected, flags, budget);
  assert.equal(report.schemaVersion, 116);
  assert.equal(report.migrations.applied.length, 41);
  assert.deepEqual(
    report.migrations.applied,
    webR2Migrations.map((m) => ({ version: m.version, sha256: sha(m.sql) })),
  );
  assert.deepEqual(report.migrations.expected.r2, report.migrations.applied);
  assert.equal(report.migrations.expected.inline.length, 41);
  assert.deepEqual(
    report.migrations.expected.inline.map((m, i) => m.sha256 === report.migrations.expected.r2[i]!.sha256),
    report.migrations.expected.inline.map((m) => m.version !== 113),
    'only the R2 schema-113 step differs from the inline list',
  );
  assert.deepEqual(
    report.migrations.expected.inline,
    webMigrations.map((m) => ({ version: m.version, sha256: sha(m.sql) })),
  );
  assert.equal(report.migrations.matches, true);
  assert.deepEqual(report.instance, {
    instanceId: '00000000-0000-4000-8000-000000000001',
    recoveryEpoch: '00000000-0000-4000-8000-000000000002',
  });
  assert.deepEqual(report.flags, {
    PUBLIC_ENABLED: 'false',
    EXTERNAL_CALLS: 'true',
    OPERATOR_ENABLED: 'true',
    EMBEDDINGS_ENABLED: null,
  });
  assert.equal(report.ownerAdminExists, false);
  for (const ledger of Object.values(report.unknownAttempts))
    assert.deepEqual(ledger, { tablePresent: true, count: 0, ids: [], truncated: false });
  // Tampered, missing, extra and inline-vs-R2 ledgers do not match.
  const hit = (change: (db: DatabaseSync) => void) => {
    const f = authority();
    change(f.db);
    return inspectWebAuthority(f.reader, expected, flags, budget).migrations.matches;
  };
  assert.equal(
    hit((db) => db.exec("UPDATE cf_web_migrations SET sha256='" + 'f'.repeat(64) + "' WHERE version=116")),
    false,
  );
  assert.equal(
    hit((db) => db.exec("UPDATE cf_web_migrations SET sha256='" + 'f'.repeat(64) + "' WHERE version=113")),
    false,
  );
  assert.equal(
    hit((db) => db.exec('DELETE FROM cf_web_migrations WHERE version=116')),
    false,
  );
  assert.equal(
    hit((db) => db.exec("INSERT INTO cf_web_migrations VALUES (117,'" + 'a'.repeat(64) + "')")),
    false,
  );
  assert.equal(
    inspectWebAuthority(authority().reader, { ...expected, active: 'inline' }, flags, budget).migrations.matches,
    false,
  );
  // A database that never had a ledger reports no schema version rather than failing.
  const bare = new DatabaseSync(':memory:');
  const empty = inspectWebAuthority(
    { all: <T>(sql: string, ...p: (string | number)[]) => bare.prepare(sql).all(...p) as T[] },
    expected,
    {},
    { available: false, error: 'X' },
  );
  assert.equal(empty.schemaVersion, null);
  assert.equal(empty.instance, null);
  assert.equal(empty.migrations.matches, false);
  assert.equal(empty.unknownAttempts.embed.tablePresent, false);
});

test('inspect counts UNKNOWN attempts in every dispatch ledger with ids only, and flags an owner without any email', () => {
  const { db, reader } = authority({ owner: true });
  seedUnknowns(db);
  const report = inspectWebAuthority(reader, expected, { ...flags, EMBEDDINGS_ENABLED: 'true' }, budget);
  assert.deepEqual(report.unknownAttempts.webProvider, {
    tablePresent: true,
    count: 2,
    ids: ['op-a/draft/-1', 'op-b/speech/0'],
    truncated: false,
  });
  assert.deepEqual(report.unknownAttempts.external, {
    tablePresent: true,
    count: 2,
    ids: ['op-x/text/draft/-1', 'op-y/audio/speech/2'],
    truncated: false,
  });
  assert.deepEqual(report.unknownAttempts.embed, {
    tablePresent: true,
    count: 2,
    ids: ['embed-1', 'embed-2'],
    truncated: false,
  });
  assert.equal(report.ownerAdminExists, true);
  assert.equal(report.flags.EMBEDDINGS_ENABLED, 'true');
  assert.deepEqual(report.budget, {
    available: true,
    providers: [
      { provider: 'deepseek', spentMicros: 7, heldMicros: 3 },
      { provider: 'fish', spentMicros: 0, heldMicros: 0 },
    ],
  });
  // The id list is capped; the count stays exact.
  for (let n = 0; n < 205; n++)
    db.prepare(
      `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,price_micros_per_million,held_micros,state,lease_expires_at,created_at,sent_at)
       VALUES (?,'index','w','c','ch','m',1,10,5,5,'unknown',1,1,1)`,
    ).run('bulk-' + String(n).padStart(3, '0'));
  const capped = inspectWebAuthority(reader, expected, flags, budget).unknownAttempts.embed;
  assert.equal(capped.count, 207);
  assert.equal(capped.ids.length, 200);
  assert.equal(capped.truncated, true);
});

test('inspect is strictly read-only and never returns secrets, emails, invite codes, message text or memories', () => {
  const f = authority({ owner: true });
  seedUnknowns(f.db);
  f.db.exec(`CREATE TABLE web_invite_probe(code TEXT); INSERT INTO web_invite_probe VALUES ('${SECRET.inviteCode}')`);
  const before = snapshot(f.db);
  const text = JSON.stringify([
    inspectWebAuthority(f.reader, expected, flags, budget),
    inspectWebAuthority(f.reader, expected, { ...flags, EXTERNAL_CALLS: 'SECRET_FLAG_VALUE' }, budget),
  ]);
  assert.equal(snapshot(f.db), before, 'full table snapshot and total_changes are unchanged');
  assert.ok(f.statements.length > 10);
  for (const secret of [...Object.values(SECRET), 'REQUEST_ID_SENTINEL', 'GRANT_HASH_SENTINEL', 'SECRET_FLAG_VALUE'])
    assert.ok(!text.includes(secret), secret);
  assert.ok(text.includes('"EXTERNAL_CALLS":"other"'));
  // Anything the budget service throws is reduced to a bounded code.
  assert.equal(inspectErrorCode(new Error('WEB_CLOUD_BUDGET_NOT_INITIALIZED')), 'WEB_CLOUD_BUDGET_NOT_INITIALIZED');
  assert.equal(inspectErrorCode(new Error('contains ' + SECRET.email)), 'WEB_INSPECT_BUDGET_UNAVAILABLE');
  assert.equal(inspectErrorCode('nope'), 'WEB_INSPECT_BUDGET_UNAVAILABLE');
});
