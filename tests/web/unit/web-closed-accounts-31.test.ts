import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import {
  migrateWebProviderChatReview,
  migrateWebProviderCocreation,
  migrateWebProviderEmbeddings,
  migrateWebProviderLogins,
  migrateWebProviderMemory,
  migrateWebProviderMemoryMetrics,
  migrateWebProviderMetrics,
  migrateWebProviderOffline,
  migrateWebProviderPreviewWorkbench,
  migrateWebProviderSignupBonus,
} from '../../../apps/server/generation/web-provider-migration.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebChatReviewAdmin } from '../../../apps/server/review/web-chat-review-admin.ts';
import { WebOwnerOps } from '../../../apps/server/admin/web-owner-ops.ts';
import { installWebOwnerOps } from '../../../apps/server/admin/web-owner-ops-schema.ts';
import { ARCHIVE_TTL_MS, archivePlayerChats, sweepReviewArchive } from '../../../apps/server/review/web-chat-review.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';

const origin = 'https://fixture.invalid';
const T0 = Date.UTC(2026, 9, 12, 2, 30); // 10:30 in Asia/Shanghai

/** The real schema through migration 122 on an in-memory Node database. */
function schema122() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  migrateWebProviderOffline(store);
  migrateWebProviderMetrics(store);
  migrateWebProviderMemory(store);
  migrateWebProviderEmbeddings(store);
  migrateWebProviderCocreation(store);
  migrateWebProviderLogins(store);
  migrateWebProviderPreviewWorkbench(store);
  migrateWebProviderMemoryMetrics(store);
  migrateWebProviderSignupBonus(store);
  migrateWebProviderChatReview(store);
  return store;
}

/**
 * A world with a private conversation per character. Foreign keys are off while seeding: this is a read-model test, and the
 * rows it needs (publications, jobs, ...) have deep parents that play no part in what a transcript reads.
 */
function fixture(t: test.TestContext) {
  const store = schema122();
  t.after(() => store.close());
  {
    const sql = readFileSync(
      new URL('../../../apps/server/web-migrations/125_invite_tiers.sql', import.meta.url),
      'utf8',
    );
    const from = sql.indexOf('CREATE TABLE web_player_numbers');
    store.db.exec(sql.slice(from, sql.indexOf(';', from) + 1));
  }
  store.db.exec('PRAGMA foreign_keys=OFF');
  for (const [id, name, zone] of [
    ['jojo', 'JOJO', 'Asia/Shanghai'],
    ['wei-guagua', '瓜瓜', 'Asia/Shanghai'],
    ['chen-jimi', '陈吉米', 'America/New_York'],
  ] as const)
    store.run(
      'INSERT INTO character_templates VALUES (?,1,?)',
      id,
      JSON.stringify({
        id,
        name,
        version: 1,
        fictional: true,
        persona: '合成角色',
        schedule: { ...defaultSchedule(), timeZone: zone },
      }),
    );
  let now = T0,
    seq = 0;
  const clock = { now: () => now };
  const accounts = new WebAccountAdmin(store, clock, origin, { features: { chatReview: true } });
  const review = new WebChatReviewAdmin(store, clock, accounts);
  installWebOwnerOps(store);
  const ops = new WebOwnerOps(store as never, clock, accounts);
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const member = (permissions: string[], label: string) => {
    const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
      requestId: `issue-${label}`,
      label,
      memberId: null,
      permissions,
    });
    const login = accounts.login(grant.token, origin);
    return { cookie: login.cookie, csrf: login.csrf, origin };
  };

  /** One player with a world; `chat` adds one private conversation. */
  const player = (name: string, retention: 'active' | 'protected' | 'purging' = 'active') => {
    const principalId = `principal-${name}`,
      worldId = `world-${name}`;
    store.run('INSERT INTO api_players VALUES (?,?)', `player-${name}`, now);
    store.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, `player-${name}`, 'UTC', '{}');
    store.run(
      'INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,?)',
      principalId,
      `player-${name}`,
      worldId,
      'guest',
    );
    store.run(
      'INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state) VALUES (?,?,?,?,?)',
      principalId,
      worldId,
      now - 1000,
      now + 3_600_000,
      retention,
    );
    store.run(
      'INSERT INTO player_profile_versions VALUES (?,1,?,?)',
      worldId,
      JSON.stringify({
        name: '阿泡',
        age: null,
        city: '',
        occupation: '',
        familyBackground: '',
        sharedCharacterIds: [],
      }),
      now,
    );
    return { principalId, worldId };
  };
  const message = (
    who: { worldId: string },
    characterId: string,
    authorKind: 'player' | 'character',
    body: string,
    at: number,
    over: { proactive?: boolean } = {},
  ) => {
    store.run("INSERT OR IGNORE INTO world_characters VALUES (?,?,'new')", who.worldId, characterId);
    const conversationId = `conv-${who.worldId}-${characterId}`;
    store.run("INSERT OR IGNORE INTO conversations VALUES (?,?,'private',?)", who.worldId, conversationId, characterId);
    const id = `m${++seq}`;
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive)
      VALUES (?,?,?,?,?,?,?,'text',?)`,
      id,
      who.worldId,
      conversationId,
      authorKind,
      authorKind === 'player' ? who.worldId : characterId,
      body,
      at,
      over.proactive ? 1 : 0,
    );
    return { id, conversationId };
  };
  /** A player message with its operation and (optionally) the published bubbles of the reply. */
  const round = (
    who: { principalId: string; worldId: string },
    characterId: string,
    text: string,
    reply: string[] | { failed: string },
    at: number,
    changed: boolean | null = null,
  ) => {
    const input = message(who, characterId, 'player', text, at);
    const op = `op${++seq}`;
    const failed = !Array.isArray(reply);
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,
        input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type,failure_code)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,'used',?,?, 'entitled',?)`,
      op,
      who.principalId,
      `req-${op}`,
      'p'.repeat(64),
      who.worldId,
      input.conversationId,
      characterId,
      input.id,
      failed ? 'failed' : 'published',
      at,
      at + 60_000,
      failed ? reply.failed : null,
    );
    if (Array.isArray(reply)) {
      store.run(
        `INSERT INTO web_publications VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        op,
        who.principalId,
        `player-${who.worldId}`,
        who.worldId,
        input.conversationId,
        characterId,
        input.id,
        `job-${op}`,
        'r'.repeat(64),
        'c'.repeat(64),
        at + 5000,
        '{}',
      );
      reply.forEach((bubble, ordinal) => {
        const m = message(who, characterId, 'character', bubble, at + 5000 + ordinal * 1000);
        store.run("INSERT INTO web_publication_items VALUES (?,?,?,'media','narrative')", op, ordinal, m.id);
      });
    }
    if (changed !== null)
      store.run(
        "INSERT INTO web_operation_metrics(operation_id,day,review_changed) VALUES (?,'2026-10-12',?)",
        op,
        changed ? 1 : 0,
      );
    return op;
  };
  return {
    store,
    ops,
    review,
    accounts,
    ownerAuth,
    member,
    player,
    message,
    round,
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
  };
}

const numberFor = (f: ReturnType<typeof fixture>, who: { principalId: string }, number: string) =>
  f.store.run('INSERT INTO web_player_numbers VALUES (?,?,?)', who.principalId, number, T0);
const closedRows = (f: ReturnType<typeof fixture>) =>
  f.store
    .all<Record<string, unknown>>('SELECT * FROM web_closed_accounts ORDER BY player_number')
    .map((r) => ({ ...r }));
const archived = (f: ReturnType<typeof fixture>) =>
  f.store.get<{ n: number }>('SELECT count(*) n FROM web_review_archive')!.n;

/** Two accounts with a number each, each with one chat; both closed (the transaction that starts a purge archives them). */
function closedPair(f: ReturnType<typeof fixture>) {
  const a = f.player('a', 'purging'),
    b = f.player('b', 'purging');
  numberFor(f, a, '0123ABCD');
  numberFor(f, b, '4567EFGH');
  f.round(a, 'jojo', '你好', ['在的'], T0);
  f.round(b, 'jojo', '早安', ['早'], T0 + 60_000);
  f.store.transaction(() => {
    archivePlayerChats(f.store, a.principalId, a.worldId, T0 + 120_000);
    archivePlayerChats(f.store, b.principalId, b.worldId, T0 + 120_000 + 86_400_000);
  });
  return { a, b };
}

test('default (按保留期): a closed account is listed by 玩家编号 and closure date only, and its text stays in the archive', (t) => {
  const f = fixture(t);
  closedPair(f);
  assert.equal(archived(f), 4, 'two lines each, as today');
  const view = f.ops.closedAccounts(f.ownerAuth);
  assert.equal(view.policy, 'retention');
  assert.deepEqual(view.rows, [
    { playerNumber: '4567EFGH', closedOn: '2026-10-13' },
    { playerNumber: '0123ABCD', closedOn: '2026-10-12' },
  ]);
  assert.deepEqual(
    Object.keys(view.rows[0]!).sort(),
    ['closedOn', 'playerNumber'],
    'nothing else: no email, nickname, id or code',
  );
  // the list is the owner's alone
  const reader = f.member(['conversations.read'], 'reader');
  assert.throws(() => f.ops.closedAccounts(reader), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => f.ops.closedAccounts({ ...f.ownerAuth, origin: 'https://evil.invalid' }), /ADMIN_UNAUTHORIZED/);
});

test("deleting one closed account's chats now removes its archive copy and its list row, nothing else, once per request id", (t) => {
  const f = fixture(t);
  closedPair(f);
  const body = { requestId: 'closed-1', playerNumber: '0123ABCD' };
  assert.deepEqual(f.ops.deleteClosedAccount(f.ownerAuth, body), { accounts: 1, lines: 2 });
  assert.equal(archived(f), 2, 'the other account keeps its copy');
  assert.deepEqual(
    closedRows(f).map((r) => r.player_number),
    ['4567EFGH'],
  );
  // a replay answers the first answer; another body under the same id is a conflict; an unknown number deletes nothing
  assert.deepEqual(f.ops.deleteClosedAccount(f.ownerAuth, body), { accounts: 1, lines: 2 });
  assert.throws(
    () => f.ops.deleteClosedAccount(f.ownerAuth, { requestId: 'closed-1', playerNumber: '4567EFGH' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.deepEqual(f.ops.deleteClosedAccount(f.ownerAuth, { requestId: 'closed-2', playerNumber: '0123ABCD' }), {
    accounts: 0,
    lines: 0,
  });
  assert.equal(archived(f), 2);
  // owner only, CSRF and Origin like every admin route
  const reader = f.member(['conversations.read'], 'reader2');
  assert.throws(
    () => f.ops.deleteClosedAccount(reader, { requestId: 'closed-3', playerNumber: '4567EFGH' }),
    /ADMIN_OWNER_REQUIRED/,
  );
  assert.throws(
    () =>
      f.ops.deleteClosedAccount(
        { ...f.ownerAuth, csrf: 'c'.repeat(64) },
        { requestId: 'closed-4', playerNumber: '4567EFGH' },
      ),
    /ADMIN_CSRF_REQUIRED/,
  );
  assert.equal(archived(f), 2);
  assert.deepEqual(
    f.store
      .all<Record<string, unknown>>(
        "SELECT action,target_id FROM web_admin_audit WHERE action='closed-account-chats-deleted'",
      )
      .map((r) => ({ ...r })),
    [
      { action: 'closed-account-chats-deleted', target_id: 'n=1' },
      { action: 'closed-account-chats-deleted', target_id: 'n=0' },
    ],
    'a count, never an id or text',
  );
});

test('立即: the closing transaction makes no archive copy and no list row; the live code still goes', (t) => {
  const f = fixture(t);
  assert.equal(f.ops.saveClosedPolicy(f.ownerAuth, { requestId: 'policy-1', policy: 'immediate' }).policy, 'immediate');
  const a = f.player('a', 'purging');
  numberFor(f, a, '0123ABCD');
  f.round(a, 'jojo', '你好', ['在的'], T0);
  reviewCodeForTest(f, a);
  const lines = f.store.transaction(() => archivePlayerChats(f.store, a.principalId, a.worldId, T0 + 1000));
  assert.equal(lines, 0);
  assert.equal(archived(f), 0);
  assert.deepEqual(closedRows(f), []);
  assert.equal(f.store.get('SELECT 1 FROM web_review_codes WHERE principal_id=?', a.principalId), undefined);
  // back to 按保留期: the next closing is archived again; the setting is idempotent per request id and owner-only
  assert.equal(f.ops.saveClosedPolicy(f.ownerAuth, { requestId: 'policy-1', policy: 'immediate' }).policy, 'immediate');
  assert.throws(
    () => f.ops.saveClosedPolicy(f.ownerAuth, { requestId: 'policy-1', policy: 'retention' }),
    /IDEMPOTENCY_CONFLICT/,
  );
  assert.throws(
    () =>
      f.ops.saveClosedPolicy(f.member(['conversations.read'], 'r3'), { requestId: 'policy-2', policy: 'retention' }),
    /ADMIN_OWNER_REQUIRED/,
  );
  assert.throws(
    () => f.ops.saveClosedPolicy(f.ownerAuth, { requestId: 'policy-3', policy: 'forever' }),
    /INVALID_REQUEST/,
  );
  f.ops.saveClosedPolicy(f.ownerAuth, { requestId: 'policy-4', policy: 'retention' });
  const b = f.player('b', 'purging');
  numberFor(f, b, '4567EFGH');
  f.round(b, 'jojo', '早安', ['早'], T0);
  f.store.transaction(() => archivePlayerChats(f.store, b.principalId, b.worldId, T0 + 2000));
  assert.equal(archived(f), 2);
  assert.equal(closedRows(f).length, 1);
});
function reviewCodeForTest(f: ReturnType<typeof fixture>, who: { principalId: string }) {
  f.store.run('INSERT INTO web_review_codes VALUES (?,?,?)', who.principalId, 'K7M2', T0);
}

test('a closed-account row never outlives its copy: the 180-day sweep removes both, and the audit stops a column that could name an account', (t) => {
  const f = fixture(t);
  closedPair(f);
  // one transcript deleted from the 测试对话 list (by code and character) takes the list row with it once nothing is left
  const code = f.store.get<{ review_code: string }>(
    'SELECT review_code FROM web_closed_accounts WHERE player_number=?',
    '0123ABCD',
  )!.review_code;
  assert.equal(
    f.ops.deleteConversations(f.ownerAuth, {
      requestId: 'conv-1',
      items: [{ characterId: 'jojo', code, archived: true }],
    }).deleted,
    1,
  );
  assert.deepEqual(
    closedRows(f).map((r) => r.player_number),
    ['4567EFGH'],
  );
  // the other row goes with its copy at the 180-day mark
  sweepReviewArchive(f.store, T0 + 120_000 + 86_400_000 + ARCHIVE_TTL_MS + 1);
  assert.equal(archived(f), 0);
  assert.deepEqual(closedRows(f), []);
  // the lifecycle audit fails closed on any extra column
  const empty = f.player('c', 'purging');
  f.store.db.exec('DELETE FROM player_profile_versions');
  const audit = () => auditWebLifecycleWorld(f.store as never, empty.worldId, 'cleared', 'synthetic');
  audit();
  f.store.db.exec('ALTER TABLE web_closed_accounts ADD COLUMN email TEXT');
  assert.throws(
    audit,
    (error: any) =>
      error.code === 'WEB_RETENTION_UNEXPECTED_WORLD_DATA' && error.detail?.table === 'closed_accounts_identity',
  );
});
