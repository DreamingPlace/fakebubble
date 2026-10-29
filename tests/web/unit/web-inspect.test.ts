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
  // Extended for migration 123 (Part 21b named exception): schema 123, 48 steps.
  // Named exception (Part 21g, migration 124): the ledger now has 49 steps and 124 is the newest, so step counts, positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts and expected versions moved by one again. No assertion was weakened.
  // (Part 22a, migration 125): the ledger had 50 steps; positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24c, migration 131): the ledger has 56 steps and 131 is the newest, so step counts and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(report.schemaVersion, 131);
  assert.equal(report.migrations.applied.length, 56);
  assert.deepEqual(
    report.migrations.applied,
    webR2Migrations.map((m) => ({ version: m.version, sha256: sha(m.sql) })),
  );
  assert.deepEqual(report.migrations.expected.r2, report.migrations.applied);
  // Named exception (Part 22x, migration 126): the ledger has 51 steps and 126 is the newest, so step counts and expected versions moved by one again. No assertion was weakened.
  // (Part 22a, migration 125): the ledger had 50 steps; positions
  // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
  // Named exception (Part 22a2, migration 127): the ledger has 52 steps and 127 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  // Named exception (Part 24a, migration 129): the ledger has 54 steps and 129 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 22d, migration 130): the ledger has 55 steps and 130 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  // Named exception (Part 24c, migration 131): the ledger has 56 steps and 131 is the newest, so step counts, positions counted from the end of the ledger and the expected user_version moved by one again. No assertion was weakened.
  assert.equal(report.migrations.expected.inline.length, 56);
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
    // Named exception (Part 22a, migration 125): the ledger now has 50 steps and 125 is the newest, so step counts, positions
    // counted from the end of the ledger and expected user_versions in this test moved by one again. No assertion was weakened.
    // Extended for migration 124 (Part 21g named exception): 124 is a real step now, so the extra step is 125. Part 22a: 125 is a real step now; Part 22x: 126 is a real step now, so the extra step is 127.
    // Named exception (Part 22a2, migration 127): 127 is a real step now, so the extra step is 128. No assertion was weakened.
    // Named exception (Part 22c, migration 128): 128 is a real step now, so the extra step is 129. No assertion was weakened.
    // Named exception (Part 24a, migration 129): 129 is a real step now, so the extra step is 130. No assertion was weakened.
    // Named exception (Part 22d, migration 130): 130 is a real step now, so the extra step is 131. No assertion was weakened.
    // Named exception (Part 24c, migration 131): 131 is a real step now, so the extra step is 132. No assertion was weakened.
    hit((db) => db.exec("INSERT INTO cf_web_migrations VALUES (132,'" + 'a'.repeat(64) + "')")),
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

test('inspect reports the player-account configuration: signup flag, daily cap and whether the mail binding exists, never an address', () => {
  const { reader } = authority();
  const players = (input: Parameters<typeof inspectWebAuthority>[4]) =>
    inspectWebAuthority(reader, expected, flags, budget, input).players;
  assert.deepEqual(players(undefined), {
    PLAYER_SIGNUP_ENABLED: null,
    PLAYER_EMAIL_DAILY_CAP: null,
    PLAYER_EMAIL_BINDING_PRESENT: false,
  });
  assert.deepEqual(
    players({ PLAYER_SIGNUP_ENABLED: 'true', PLAYER_EMAIL_DAILY_CAP: '250', emailBindingPresent: true }),
    {
      PLAYER_SIGNUP_ENABLED: 'true',
      PLAYER_EMAIL_DAILY_CAP: 250,
      PLAYER_EMAIL_BINDING_PRESENT: true,
    },
  );
  assert.deepEqual(
    players({ PLAYER_SIGNUP_ENABLED: 'false', PLAYER_EMAIL_DAILY_CAP: '0', emailBindingPresent: false }),
    {
      PLAYER_SIGNUP_ENABLED: 'false',
      PLAYER_EMAIL_DAILY_CAP: 'other',
      PLAYER_EMAIL_BINDING_PRESENT: false,
    },
  );
  // Any other value is only ever reported as 'other': an address or secret pasted into a variable cannot leak.
  const leaked = JSON.stringify(
    players({
      PLAYER_SIGNUP_ENABLED: SECRET.email,
      PLAYER_EMAIL_DAILY_CAP: SECRET.passwordHash,
      emailBindingPresent: true,
    }),
  );
  assert.ok(!leaked.includes(SECRET.email) && !leaked.includes(SECRET.passwordHash));
  assert.ok(leaked.includes('"PLAYER_SIGNUP_ENABLED":"other"') && leaked.includes('"PLAYER_EMAIL_DAILY_CAP":"other"'));
});

test('inspect reports, per provider/model/phase, the price row in force now and the latest valid_until (numbers and ids only)', () => {
  const { db, reader } = authority();
  db.exec("INSERT INTO web_provider_spending VALUES ('deepseek','USD',NULL,0,0)");
  const price = db.prepare("INSERT INTO web_provider_prices VALUES (?,'deepseek','m','draft','USD','token',2,?,?,?)");
  price.run('p-1', 1000, 2000, 1);
  price.run('p-2', 2000, 3000, 2);
  const at = (now: number) => inspectWebAuthority(reader, expected, flags, budget, {}, now).prices;
  assert.deepEqual(at(1500), [
    {
      provider: 'deepseek',
      model: 'm',
      phase: 'draft',
      // Part 17i (named exception to this exact-shape assertion): inForce also names the row's version and upper_micros_per_unit.
      inForce: { id: 'p-1', validUntil: 2000, version: 1, upperMicrosPerUnit: 2 },
      latestValidUntil: 3000,
    },
  ]);
  assert.equal(at(2000)[0]!.inForce!.id, 'p-2', 'the boundary instant belongs to the next row');
  assert.equal(at(3000)[0]!.inForce, null, 'expired: nothing in force, the latest valid_until is still shown');
  assert.equal(at(3000)[0]!.latestValidUntil, 3000);
});
