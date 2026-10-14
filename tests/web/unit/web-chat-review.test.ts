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
import { routeWebAccountAdmin } from '../../../apps/server/admin/web-account-admin-routes.ts';
import { WebChatReviewAdmin } from '../../../apps/server/review/web-chat-review-admin.ts';
import {
  ARCHIVE_TTL_MS,
  REVIEW_ALPHABET,
  archiveHasIdentityColumn,
  archivePlayerChats,
  nextReviewArchiveExpiry,
  nicknamesOfWorld,
  purgeReviewRows,
  readTranscript,
  redactNicknames,
  reviewCodeFor,
  reviewRowsRemain,
  sweepReviewArchive,
} from '../../../apps/server/review/web-chat-review.ts';
import { isReadOnlyAdminPost } from '../../../apps/server/cloudflare/web-admin-read.ts';
import { auditWebLifecycleWorld } from '../../../apps/server/admission/web-lifecycle-audit.ts';
import { ADMIN_PERMISSION_PRESETS, itemPermission } from '../../../packages/contracts/web-admin-permissions.ts';

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
const list = (f: ReturnType<typeof fixture>, auth: object, over: Record<string, unknown> = {}) =>
  f.review.list(auth as never, { characterId: null, scope: null, page: 0, ...over });
const codeOf = (label: string) => label.slice(-4);

// ---- nickname replacement ---------------------------------------------------------------------------------------------

test('nicknames - the current one and every past one - become 〔昵称〕, whatever the case, width or spacing', () => {
  const names = ['阿泡', 'Bubble'];
  assert.equal(redactNicknames('你好阿泡，我是Bubble', names), '你好〔昵称〕，我是〔昵称〕');
  assert.equal(
    redactNicknames('bubble BUBBLE ｂｕｂｂｌｅ', names),
    '〔昵称〕 〔昵称〕 〔昵称〕',
    'case and full-width',
  );
  assert.equal(redactNicknames('阿 泡', names), '〔昵称〕', 'a space inside the name');
  assert.equal(redactNicknames('阿​泡', names), '〔昵称〕', 'an invisible character inside the name');
  assert.equal(redactNicknames('阿泡阿泡', names), '〔昵称〕', 'neighbouring matches are one placeholder');
  assert.equal(redactNicknames('没有名字', names), '没有名字');
  assert.equal(redactNicknames('阿泡', []), '阿泡', 'no known nickname, nothing to hide');
  // Single pass: the placeholder itself is never searched, even for a nickname that is part of it.
  assert.equal(redactNicknames('我叫昵称，叫我阿泡', ['昵称', '阿泡']), '我叫〔昵称〕，叫我〔昵称〕');
  assert.equal(redactNicknames('ab', ['b', 'ab']), '〔昵称〕', 'the longer name wins');
});

test('nicknamesOfWorld reads every 名片 revision, not only the latest', (t) => {
  const f = fixture(t);
  const p = f.player('a');
  f.store.run('INSERT INTO player_profile_versions VALUES (?,2,?,?)', p.worldId, '{"name":"新昵称"}', f.now());
  f.store.run('INSERT INTO player_profile_versions VALUES (?,3,?,?)', p.worldId, 'not json', f.now());
  assert.deepEqual(nicknamesOfWorld(f.store, p.worldId).sort(), ['新昵称', '阿泡'].sort());
});

// ---- codes ---------------------------------------------------------------------------------------------------------------

test('a code is 4 characters from an alphabet without look-alikes, random, and stable across one player’s characters', (t) => {
  const f = fixture(t);
  assert.ok(!/[01OIL]/.test(REVIEW_ALPHABET), 'no 0/O, 1/I/L');
  const a = f.player('a'),
    b = f.player('b');
  const first = reviewCodeFor(f.store, a.principalId, f.now());
  assert.match(first, /^[ABCDEFGHJKMNPQRSTUVWXYZ2-9]{4}$/);
  assert.equal(reviewCodeFor(f.store, a.principalId, f.now() + 5), first, 'assigned once, then stable');
  // Nothing in the code comes from an id: ten fresh players all draw independently of their ids.
  const seen = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const who = f.player(`x${i}`);
    seen.add(reviewCodeFor(f.store, who.principalId, f.now()));
  }
  assert.ok(seen.size >= 38, 'random: 40 draws over 31^4 codes practically never collide');
  assert.match(reviewCodeFor(f.store, b.principalId, f.now()), /^[A-Z2-9]{4}$/);
  // The CHECK in the table refuses an alphabet violation too.
  assert.throws(() => f.store.run("INSERT INTO web_review_codes VALUES ('principal-a2','AX01',1)"));
});

test('a code is never reused while it is live or any archive row still carries it', (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b'),
    c = f.player('c');
  assert.equal(
    reviewCodeFor(f.store, a.principalId, f.now(), () => 'AAAA'),
    'AAAA',
  );
  // The archive keeps BBBB although no live row has it.
  f.store.run(
    `INSERT INTO web_review_archive VALUES ('JOJO-BBBB','BBBB','jojo',0,'2026-10-12 10:30','player','你好','ok',NULL,0,?,?)`,
    f.now(),
    f.now() + ARCHIVE_TTL_MS,
  );
  const draws = ['AAAA', 'BBBB', 'CCCC'];
  assert.equal(
    reviewCodeFor(f.store, b.principalId, f.now(), () => draws.shift()!),
    'CCCC',
    'AAAA is live, BBBB is archived: both are skipped',
  );
  // Once the archive row has been swept the code may come back.
  f.advance(ARCHIVE_TTL_MS + 1);
  sweepReviewArchive(f.store, f.now());
  assert.equal(
    reviewCodeFor(f.store, c.principalId, f.now(), () => 'BBBB'),
    'BBBB',
  );
});

// ---- transcripts ---------------------------------------------------------------------------------------------------------

test('a transcript holds the player text, final bubbles, proactive messages and failed replies in order, with local times', (t) => {
  const f = fixture(t);
  const p = f.player('a');
  f.round(p, 'jojo', '你好', ['在的', '怎么啦'], T0, true);
  f.message(p, 'jojo', 'character', '我刚想起你', T0 + 600_000, { proactive: true });
  f.round(p, 'jojo', '今天好累', { failed: 'TEXT_VALIDATION_FAILED' }, T0 + 3_600_000);
  f.round(p, 'jojo', '晚安', ['晚安～'], T0 + 7_200_000, false);
  f.round(p, 'wei-guagua', '另一位', ['嗯'], T0 + 60_000);
  const lines = readTranscript(f.store, p.worldId, 'jojo', ['阿泡']);
  assert.deepEqual(
    lines.map((l) => [l.order, l.speaker, l.status, l.text, l.errorCode, l.reviewChanged]),
    [
      [0, 'player', 'ok', '你好', null, false],
      [1, 'character', 'ok', '在的', null, true],
      [2, 'character', 'ok', '怎么啦', null, true],
      [3, 'proactive', 'ok', '我刚想起你', null, false],
      [4, 'player', 'ok', '今天好累', null, false],
      [5, 'character', 'failed', '', 'TEXT_VALIDATION_FAILED', false],
      [6, 'player', 'ok', '晚安', null, false],
      [7, 'character', 'ok', '晚安～', null, false],
    ],
  );
  assert.equal(lines[0]!.time, '2026-10-12 10:30', 'the character’s own clock (Asia/Shanghai)');
  assert.equal(lines[3]!.time, '2026-10-12 10:40');
  // The other character has its own transcript and its own time zone.
  const other = readTranscript(f.store, p.worldId, 'wei-guagua', []);
  assert.deepEqual(
    other.map((l) => l.text),
    ['另一位', '嗯'],
  );
});

// ---- the admin read model ---------------------------------------------------------------------------------------------------

test('list: one row per labelled conversation with messages; filters, sort and the 已删除 mark with its date', (t) => {
  const f = fixture(t);
  const a = f.player('a'),
    b = f.player('b');
  f.round(a, 'jojo', '甲', ['乙'], T0);
  f.round(a, 'wei-guagua', '甲2', { failed: 'PROVIDER_FAILED' }, T0 + 60_000);
  f.round(b, 'jojo', '丙', ['丁'], T0 + 120_000);
  f.player('empty'); // a player without any message has no row
  const all = list(f, f.ownerAuth);
  assert.equal(all.total, 3);
  assert.equal(
    new Set(all.rows.map((r) => r.code)).size,
    2,
    'one code per player: the same across a player’s characters',
  );
  assert.ok(all.rows.every((r) => !r.archived && r.expiresOn === null));
  assert.deepEqual(
    all.rows.map((r) => r.lastAt),
    [...all.rows.map((r) => r.lastAt)].sort().reverse(),
    'newest activity first',
  );
  const failedRow = all.rows.find((r) => r.characterId === 'wei-guagua')!;
  assert.equal(failedRow.failed, 1);
  assert.equal(failedRow.messages, 1, 'the failed reply is not a message');
  assert.match(failedRow.label, /^瓜瓜-[A-Z2-9]{4}$/);
  assert.deepEqual(
    list(f, f.ownerAuth, { characterId: 'jojo' }).rows.map((r) => r.characterId),
    ['jojo', 'jojo'],
  );
  // A removed player's chats are listed from the archive, marked 已删除 with the day they disappear.
  f.store.transaction(() => archivePlayerChats(f.store, a.principalId, a.worldId, f.now()));
  f.store.run("UPDATE web_guest_retention SET state='purging' WHERE principal_id=?", a.principalId);
  const after = list(f, f.ownerAuth);
  assert.equal(after.total, 3);
  const gone = after.rows.filter((r) => r.archived);
  assert.equal(gone.length, 2);
  assert.deepEqual(
    gone.map((r) => r.expiresOn),
    ['2027-04-10', '2027-04-10'],
    '180 days after 2026-10-12',
  );
  assert.equal(list(f, f.ownerAuth, { scope: 'live' }).total, 1);
  assert.equal(list(f, f.ownerAuth, { scope: 'archived' }).total, 2);
});

test('detail and CSV: both sides in order, the 审核改动 mark, 〔昵称〕 for current and past nicknames, and no identity at all', (t) => {
  const f = fixture(t);
  const p = f.player('secret');
  f.store.run('INSERT INTO player_profile_versions VALUES (?,2,?,?)', p.worldId, '{"name":"旧名字"}', f.now());
  f.round(p, 'jojo', '我是阿泡，以前叫旧名字', ['你好阿泡', '旧名字你好'], T0, true);
  f.round(p, 'jojo', '=HYPERLINK("http://x")', { failed: 'PROVIDER_FAILED' }, T0 + 60_000);
  const row = list(f, f.ownerAuth).rows[0]!;
  const detail = f.review.detail(f.ownerAuth as never, {
    characterId: row.characterId,
    code: row.code,
    archived: false,
    page: 0,
  });
  assert.equal(detail.total, 5);
  assert.deepEqual(
    detail.lines.map((l) => l.text),
    ['我是〔昵称〕，以前叫〔昵称〕', '你好〔昵称〕', '〔昵称〕你好', '=HYPERLINK("http://x")', ''],
  );
  assert.deepEqual(
    detail.lines.map((l) => l.reviewChanged),
    [false, true, true, false, false],
  );
  const exported = f.review.export(f.ownerAuth as never, { characterId: 'jojo', code: row.code, archived: false });
  const lines = exported.csv.replace(/^﻿/, '').trim().split('\r\n');
  assert.equal(lines[0], 'label,time,speaker,text,status,error_code,审核改动');
  assert.equal(lines.length, 6);
  assert.ok(
    lines.every((l) => l.startsWith(row.label) || l === lines[0]),
    'every row carries the label',
  );
  assert.ok(
    lines.some((l) => l.includes("'=HYPERLINK")),
    'a cell that starts with = cannot run as a formula',
  );
  // Nothing identifying anywhere in what is returned: not the nicknames, not an id of the player's.
  for (const text of [JSON.stringify(detail), exported.csv, JSON.stringify(list(f, f.ownerAuth))]) {
    for (const forbidden of ['阿泡', '旧名字', p.principalId, p.worldId, 'player-secret', 'secret'])
      assert.ok(!text.includes(forbidden), `must not contain ${forbidden}`);
  }
  // All conversations of a character: one CSV with each conversation’s label.
  const second = f.player('second');
  f.round(second, 'jojo', '第二个人', ['好的'], T0);
  const everything = f.review.export(f.ownerAuth as never, { characterId: 'jojo', code: null, archived: null });
  const labels = new Set(
    everything.csv
      .replace(/^﻿/, '')
      .trim()
      .split('\r\n')
      .slice(1)
      .map((l) => l.split(',')[0]),
  );
  assert.equal(labels.size, 2);
  assert.equal(everything.lines, 7);
});

test('every list, detail and export writes one audit row (actor, action, label, time) and no content', (t) => {
  const f = fixture(t);
  const p = f.player('a');
  f.round(p, 'jojo', '机密的话', ['回答'], T0);
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  const row = list(f, f.ownerAuth).rows[0]!;
  f.review.detail(f.ownerAuth as never, { characterId: 'jojo', code: row.code, archived: false, page: 0 });
  f.review.export(f.ownerAuth as never, { characterId: 'jojo', code: row.code, archived: false });
  f.review.export(f.ownerAuth as never, { characterId: 'jojo', code: null, archived: null });
  const rows = f.store.all<{ actor_id: string; action: string; target_id: string; created_at: number }>(
    'SELECT actor_id,action,target_id,created_at FROM web_admin_audit ORDER BY seq',
  );
  assert.deepEqual(
    rows.slice(before).map((r) => [r.action, r.target_id]),
    [
      ['chat-review-list', '*'],
      ['chat-review-detail', row.label],
      ['chat-review-export', row.label],
      ['chat-review-export', 'JOJO-*'],
    ],
  );
  assert.ok(rows.slice(before).every((r) => r.actor_id && r.created_at === f.now()));
  assert.ok(!JSON.stringify(rows).includes('机密的话'));
});

test('permission 查看测试对话: the owner and an explicit grant may read; the 共创写手 and 运营 presets, other members and the flag-off wiring may not', (t) => {
  const f = fixture(t);
  const p = f.player('a');
  f.round(p, 'jojo', '你好', ['在'], T0);
  const reader = f.member(['conversations.read'], 'reader');
  assert.equal(list(f, reader).total, 1);
  for (const preset of ['co-writer', 'operations']) {
    const items = ADMIN_PERMISSION_PRESETS.find((x) => x.id === preset)!.items;
    assert.ok(!items.includes('conversations.read' as never), `${preset} does not carry it`);
    const who = f.member(items.map(itemPermission), `preset-${preset}`);
    assert.throws(() => list(f, who), { code: 'ADMIN_PERMISSION_REQUIRED' });
    assert.throws(
      () => f.review.detail(who as never, { characterId: 'jojo', code: 'AAAA', archived: false, page: 0 }),
      { code: 'ADMIN_PERMISSION_REQUIRED' },
    );
    assert.throws(() => f.review.export(who as never, { characterId: 'jojo', code: null, archived: null }), {
      code: 'ADMIN_PERMISSION_REQUIRED',
    });
  }
  assert.throws(() => list(f, f.member(['category.characters', 'cocreation.manage'], 'other')), {
    code: 'ADMIN_PERMISSION_REQUIRED',
  });
  // No session at all, and a stale CSRF token, are refused before anything is read.
  assert.throws(() => list(f, { cookie: '', csrf: '', origin }), { code: 'ADMIN_UNAUTHORIZED' });
  assert.throws(() => list(f, { ...f.ownerAuth, csrf: 'x'.repeat(64) }));
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_admin_audit WHERE action LIKE 'chat-review-%'")!.n,
    1,
    'only the allowed call left an audit row',
  );
});

test('flag off: the routes are not routes, the session says nothing about it and the codes tables are not even asked', async (t) => {
  const f = fixture(t);
  const off = new WebAccountAdmin(f.store, { now: f.now }, origin);
  const grant = off.login(off.issueLoginGrant().token, origin);
  assert.equal('features' in off.session(grant.cookie), false);
  for (const action of ['list', 'detail', 'export']) {
    const result = await routeWebAccountAdmin(
      off,
      {
        method: 'POST',
        path: `/api/web/local/admin/conversations/${action}`,
        body: {},
        adminCookie: grant.cookie,
        csrf: grant.csrf,
        origin,
      } as never,
      undefined,
      undefined,
      null,
    );
    assert.equal(result, null, `${action} falls through exactly like an unknown path`);
  }
  assert.equal(
    await routeWebAccountAdmin(
      off,
      { method: 'POST', path: '/api/web/local/admin/nothing/list', body: {}, adminCookie: grant.cookie } as never,
      undefined,
      undefined,
      null,
    ),
    null,
  );
  assert.deepEqual((f.accounts.session(f.ownerAuth.cookie) as { features?: unknown }).features, { chatReview: true });
});

// ---- the archive ----------------------------------------------------------------------------------------------------------

test('archiving copies the transcript without any identity, replaces nicknames first and takes the live code with it', (t) => {
  const f = fixture(t);
  const p = f.player('a');
  f.round(p, 'jojo', '我是阿泡', ['你好阿泡'], T0, false);
  f.round(p, 'wei-guagua', '嗨', { failed: 'PROVIDER_FAILED' }, T0 + 60_000);
  f.store.run('INSERT INTO web_review_notice VALUES (?,?)', p.principalId, T0);
  const code = reviewCodeFor(f.store, p.principalId, T0);
  const lines = archivePlayerChats(f.store, p.principalId, p.worldId, T0 + 1000);
  assert.equal(lines, 4);
  const rows = f.store.all<Record<string, unknown>>('SELECT * FROM web_review_archive ORDER BY label,line_order');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => String(r.label).endsWith(`-${code}`) && r.review_code === code));
  assert.deepEqual(
    rows.filter((r) => r.character_id === 'jojo').map((r) => [r.speaker, r.text, r.review_changed]),
    [
      ['player', '我是〔昵称〕', 0],
      ['character', '你好〔昵称〕', 0],
    ],
  );
  assert.ok(rows.every((r) => r.expires_at === (r.archived_at as number) + ARCHIVE_TTL_MS));
  // No value anywhere in the archive is an id of the player's.
  const dump = JSON.stringify(rows);
  for (const id of [p.principalId, p.worldId, `player-a`, '阿泡']) assert.ok(!dump.includes(id), id);
  assert.equal(archiveHasIdentityColumn(f.store), false);
  // The live code and the banner mark went in the same step.
  assert.equal(reviewRowsRemain(f.store, [p.principalId]), false);
  assert.equal(f.store.get('SELECT 1 FROM web_review_codes'), undefined);
});

test('the archive has no column that joins to an account, and the audit fails closed if one appears', (t) => {
  const f = fixture(t);
  assert.equal(archiveHasIdentityColumn(f.store), false);
  const columns = f.store.all<{ name: string }>('PRAGMA table_info(web_review_archive)').map((c) => c.name);
  assert.deepEqual(columns.sort(), [
    'archived_at',
    'at_local',
    'character_id',
    'error_code',
    'expires_at',
    'label',
    'line_order',
    'review_changed',
    'review_code',
    'speaker',
    'status',
    'text',
  ]);
  const foreign = f.store.all('PRAGMA foreign_key_list(web_review_archive)');
  assert.deepEqual(foreign, [], 'no foreign key to any account table');
  for (const bad of [
    'principal_id',
    'world_id',
    'player_id',
    'conversation_id',
    'session_id',
    'operation_id',
    'email_hash',
  ]) {
    f.store.db.exec(`ALTER TABLE web_review_archive ADD COLUMN ${bad} TEXT`);
    assert.equal(archiveHasIdentityColumn(f.store), true, bad);
    f.store.db.exec(`ALTER TABLE web_review_archive DROP COLUMN ${bad}`);
  }
});

test('the live code row is player data: purging the player removes it and the audit check fails closed while it remains', (t) => {
  const f = fixture(t);
  const p = f.player('a'),
    q = f.player('b');
  reviewCodeFor(f.store, p.principalId, T0);
  reviewCodeFor(f.store, q.principalId, T0);
  f.store.run('INSERT INTO web_review_notice VALUES (?,?)', p.principalId, T0);
  assert.equal(reviewRowsRemain(f.store, [p.principalId]), true);
  purgeReviewRows(f.store, p.principalId);
  assert.equal(reviewRowsRemain(f.store, [p.principalId]), false);
  assert.equal(reviewRowsRemain(f.store, [q.principalId]), true, 'another player’s rows stay');
});

test('the sweep deletes archive rows past 180 days in batches, idempotently, and nothing else', (t) => {
  const f = fixture(t);
  const insert = (label: string, i: number, archivedAt: number) =>
    f.store.run(
      `INSERT INTO web_review_archive VALUES (?,?,?,?,?,?,?,?,NULL,0,?,?)`,
      label,
      label.slice(-4),
      'jojo',
      i,
      '2026-10-12 10:30',
      'player',
      `第${i}行`,
      'ok',
      archivedAt,
      archivedAt + ARCHIVE_TTL_MS,
    );
  for (let i = 0; i < 450; i++) insert('JOJO-OLD1', i, T0);
  insert('JOJO-NEW1', 0, T0 + 24 * 3_600_000);
  assert.equal(nextReviewArchiveExpiry(f.store), T0 + ARCHIVE_TTL_MS);
  assert.equal(sweepReviewArchive(f.store, T0 + ARCHIVE_TTL_MS - 1), 0, 'a day early nothing goes');
  const now = T0 + ARCHIVE_TTL_MS;
  assert.equal(sweepReviewArchive(f.store, now), 200, 'at most one batch per call');
  assert.equal(sweepReviewArchive(f.store, now), 200);
  assert.equal(sweepReviewArchive(f.store, now), 50);
  assert.equal(sweepReviewArchive(f.store, now), 0, 'idempotent');
  assert.equal(
    f.store.get<{ n: number }>('SELECT count(*) n FROM web_review_archive')!.n,
    1,
    'the newer transcript stays',
  );
  assert.equal(nextReviewArchiveExpiry(f.store), T0 + 24 * 3_600_000 + ARCHIVE_TTL_MS);
});

test('the lifecycle audit of a cleared world fails closed on a live code, a banner mark or an archive column that names an account', (t) => {
  const f = fixture(t);
  const p = f.player('a', 'purging');
  f.store.run('DELETE FROM player_profile_versions WHERE world_id=?', p.worldId);
  const audit = () => auditWebLifecycleWorld(f.store as never, p.worldId, 'cleared', 'synthetic');
  audit();
  reviewCodeFor(f.store, p.principalId, T0);
  assert.throws(audit, { code: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA' }, 'a live code remains');
  purgeReviewRows(f.store, p.principalId);
  audit();
  f.store.run('INSERT INTO web_review_notice VALUES (?,?)', p.principalId, T0);
  assert.throws(audit, { code: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA' }, 'a banner mark remains');
  purgeReviewRows(f.store, p.principalId);
  audit();
  // The anonymous archive itself never fails the audit - it holds no account - until it grows a column that names one.
  f.store.run(
    `INSERT INTO web_review_archive VALUES ('JOJO-K7M2','K7M2','jojo',0,'2026-10-12 10:30','player','你好','ok',NULL,0,?,?)`,
    T0,
    T0 + ARCHIVE_TTL_MS,
  );
  audit();
  f.store.db.exec('ALTER TABLE web_review_archive ADD COLUMN world_id TEXT');
  assert.throws(audit, { code: 'WEB_RETENTION_UNEXPECTED_WORLD_DATA' });
});

test('the three review routes are read-only admin POSTs (300/min budget) and nothing next to them is', () => {
  for (const action of ['list', 'detail', 'export'])
    assert.equal(isReadOnlyAdminPost(`/admin/conversations/${action}`), true, action);
  for (const path of [
    '/admin/conversations/delete',
    '/admin/conversations/list/extra',
    '/admin/conversations',
    '/conversations/list',
  ])
    assert.equal(isReadOnlyAdminPost(path), false, path);
});
