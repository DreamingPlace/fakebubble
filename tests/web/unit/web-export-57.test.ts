import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import * as migrations from '../../../apps/server/generation/web-provider-migration.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebExportAdmin, scrubText } from '../../../apps/server/export/web-export-admin.ts';
import { routeWebAdminExport } from '../../../apps/server/export/web-export-routes.ts';
import { cocreationSheets } from '../../../apps/server/cocreation/web-cocreation-export.ts';
import { ROWS_PER_PART, crc32, renderExport, xlsxOf, type Sheet } from '../../../apps/server/export/web-export-file.ts';
import { MESSAGES_HEADER, CONVERSATIONS_HEADER } from '../../../apps/server/export/web-export-conversations.ts';
import { CALLS_HEADER, FAILURES_HEADER } from '../../../apps/server/export/web-export-calls.ts';
import { ARCHIVE_TTL_MS, reviewCodeFor } from '../../../apps/server/review/web-chat-review.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

const origin = 'https://fixture.invalid';
const T0 = Date.UTC(2026, 9, 12, 2, 30); // 10:30 UTC+8
const DAY = 86_400_000;

function schema() {
  const store = new Store(':memory:');
  const folder = new URL('../../../apps/server/web-migrations/', import.meta.url);
  for (const file of readdirSync(folder).sort()) {
    if (Number(file.slice(0, 3)) > 112) break;
    store.db.exec(readFileSync(new URL(file, folder), 'utf8'));
  }
  store.db.exec('PRAGMA user_version=112');
  const m = migrations as unknown as Record<string, (s: Store, now?: number) => void>;
  for (const step of [
    'Offline',
    'Metrics',
    'Memory',
    'Embeddings',
    'Cocreation',
    'Logins',
    'PreviewWorkbench',
    'MemoryMetrics',
    'SignupBonus',
    'ChatReview',
    'ModelChoice',
    'ModelSettings',
    'InviteTiers',
    'LegacyInvites',
    'InviteCodes',
    'Stats',
    'Cast',
    'StatsExtras',
    'CocreationPoints',
  ])
    m[`migrateWebProvider${step}`]!(store, T0);
  return store;
}

const SECRET = 'sk-SECRET-VALUE-0123456789';
const EMAIL = 'someone@example.com';

function fixture(t: test.TestContext) {
  const store = schema();
  t.after(() => store.close());
  store.db.exec('PRAGMA foreign_keys=OFF');
  for (const [id, name] of [
    ['jojo', 'JOJO'],
    ['guagua', '瓜瓜'],
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
        schedule: { ...defaultSchedule(), timeZone: 'Asia/Shanghai' },
      }),
    );
  let now = T0,
    seq = 0;
  const clock = { now: () => now };
  const accounts = new WebAccountAdmin(store, clock, origin, { features: { chatReview: true } });
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
  const player = (name: string) => {
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
      'active',
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
  ) => {
    store.run("INSERT OR IGNORE INTO world_characters VALUES (?,?,'new')", who.worldId, characterId);
    const conversationId = `conv-${who.worldId}-${characterId}`;
    store.run("INSERT OR IGNORE INTO conversations VALUES (?,?,'private',?)", who.worldId, conversationId, characterId);
    const id = `m${++seq}`;
    store.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,?,?,?,?,'text',0)`,
      id,
      who.worldId,
      conversationId,
      authorKind,
      authorKind === 'player' ? who.worldId : characterId,
      body,
      at,
    );
    return { id, conversationId };
  };
  type Round = {
    status?: 'published' | 'failed' | 'unknown';
    code?: string;
    writer?: object;
    draft?: string;
    review?: string;
    reasons?: string[];
    voice?: boolean;
    stage?: 'draft' | 'review' | 'speech';
  };
  const round = (
    who: { principalId: string; worldId: string },
    characterId: string,
    text: string,
    reply: string[],
    at: number,
    over: Round = {},
  ) => {
    const input = message(who, characterId, 'player', text, at);
    const op = `op${++seq}`;
    const status = over.status ?? 'published';
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type,failure_code)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,'used',?,?, 'entitled',?)`,
      op,
      who.principalId,
      `req-${op}`,
      'p'.repeat(64),
      who.worldId,
      input.conversationId,
      characterId,
      input.id,
      status,
      at,
      at + 60_000,
      over.code ?? null,
    );
    if (status === 'published') {
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
        if (over.voice)
          store.run("INSERT INTO web_publication_items VALUES (?,?,?,'media','narrative')", op, ordinal, m.id);
        else store.run("INSERT INTO web_publication_items VALUES (?,?,?,NULL,'text_fallback')", op, ordinal, m.id);
      });
    }
    if (over.draft)
      store.run(
        `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,draft_provider,draft_model,review_provider,review_model,created_at)
        VALUES (?,'deepseek',0,1,1,'deepseek',?,'deepseek',?,?)`,
        op,
        over.draft,
        over.review ?? over.draft,
        at,
      );
    store.run(
      `INSERT INTO web_v7_requests(operation_id,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,request_json,request_digest,protocol_digest,prompt_digest,memory_version,player_context_key,relationship_version,scene_revision,voice_version,frozen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,1,'k',1,1,'v',?)`,
      op,
      who.principalId,
      `player-${who.worldId}`,
      who.worldId,
      input.conversationId,
      characterId,
      input.id,
      JSON.stringify(over.writer ?? { text }),
      'd'.repeat(64),
      'd'.repeat(64),
      'd'.repeat(64),
      at,
    );
    if (over.reasons)
      store.run(
        `INSERT INTO web_provider_candidates(operation_id,request_digest,candidate_json,candidate_digest,voice_version,draft_output_digest,review_output_digest,reviewed_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        op,
        'd'.repeat(64),
        JSON.stringify({ guardReasons: over.reasons, bubbles: [{ text: '秘密文本不应出现' }] }),
        'd'.repeat(64),
        'v',
        'd'.repeat(64),
        'd'.repeat(64),
        at,
      );
    if (over.reasons)
      store.run(
        "INSERT INTO web_operation_metrics(operation_id,day,review_changed) VALUES (?,'2026-10-12',?)",
        op,
        over.reasons.length ? 1 : 0,
      );
    if (over.stage)
      store.run(
        `INSERT INTO web_provider_attempts(operation_id,phase,ordinal,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,request_digest,policy_hash,wire_request_hash,voice_version,provider,model,price_id,max_units,held_micros,state,sent_at,settled_at,outcome,usage_units,charged_micros,receipt_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'known',?,?,'failed',0,0,?,?)`,
        op,
        over.stage,
        over.stage === 'speech' ? 0 : -1,
        who.principalId,
        `player-${who.worldId}`,
        who.worldId,
        input.conversationId,
        characterId,
        input.id,
        'a',
        'a',
        'a',
        'v',
        'deepseek',
        over.draft ?? 'm',
        'price',
        10,
        5,
        at,
        at + 1,
        JSON.stringify({ errorCode: 'DEEPSEEK_RATE_LIMITED', status: 429, apiKey: SECRET, body: EMAIL }),
        at,
      );
    return op;
  };
  return {
    store,
    clock,
    accounts,
    owner,
    ownerAuth,
    member,
    player,
    message,
    round,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;
const seedChats = (f: Fixture) => {
  const a = f.player('a'),
    b = f.player('b');
  const codeA = reviewCodeFor(f.store, a.principalId, f.now()),
    codeB = reviewCodeFor(f.store, b.principalId, f.now());
  f.round(a, 'jojo', `你好阿泡，我的邮箱是 ${EMAIL}`, ['你好呀', '今天怎么样'], T0, {
    draft: 'deepseek-v4-pro',
    review: 'deepseek-v4-flash',
    writer: { writer: 'v8', writerProfile: true },
    reasons: ['distress', 'denied_ai'],
    voice: true,
  });
  f.round(a, 'jojo', '再说一句', [], T0 + 60_000, {
    status: 'failed',
    code: 'DEEPSEEK_TIMEOUT',
    draft: 'deepseek-v4-pro',
    stage: 'review',
  });
  f.round(b, 'guagua', '在吗', ['在的'], T0 + 3 * DAY, { draft: 'gemini-3-flash', review: 'gemini-3-flash' });
  f.round(b, 'guagua', '又是我', [], T0 + 3 * DAY + 60_000, { status: 'unknown', draft: 'gemini-3-flash' });
  return { a, b, codeA, codeB };
};
const exporter = (f: Fixture, extra: Partial<ConstructorParameters<typeof WebExportAdmin>[3]> = {}) =>
  new WebExportAdmin(f.store, f.clock, f.accounts, { chatReview: true, ...extra });
const call = (e: WebExportAdmin, auth: object, kind: string, filters: object = {}, over: object = {}) =>
  e.export(auth as never, { kind, format: 'csv', part: 1, sheet: 0, filters, ...over });
/** The rows of a CSV file as arrays (a minimal RFC 4180 reader). */
function parseCsv(text: string) {
  assert.equal(text.charCodeAt(0), 0xfeff, 'UTF-8 BOM');
  const rows: string[][] = [];
  let row: string[] = [],
    cell = '',
    quoted = false;
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(cell), (cell = '');
    else if (c === '\r') continue;
    else if (c === '\n') row.push(cell), rows.push(row), (row = []), (cell = '');
    else cell += c;
  }
  return rows;
}
const col = (header: readonly string[], name: string) => header.indexOf(name);

// ---- the file side --------------------------------------------------------------------------------------------------------

test('a CSV has a UTF-8 BOM, CRLF line ends, and a cell that could be a formula stays text', () => {
  const file = renderExport(
    'csv',
    'x',
    [
      {
        name: 't',
        header: ['甲', '乙'],
        rows: [
          ['=1+1', '你好, "世界"'],
          [null, 3],
        ],
      },
    ],
    { part: 1, sheet: 0 },
  );
  assert.equal(file.encoding, 'utf8');
  assert.ok(file.content.startsWith('﻿'));
  assert.match(file.content, /\r\n/);
  const rows = parseCsv(file.content);
  assert.deepEqual(rows[0], ['甲', '乙']);
  assert.equal(rows[1]![0], '\t=1+1', 'a leading tab keeps the formula text');
  assert.equal(rows[1]![1], '你好, "世界"');
  assert.deepEqual(rows[2], ['', '3']);
});

/** Reads the entries of a zip written by zipFiles (central directory, deflate) and checks every CRC. */
function unzip(bytes: Buffer) {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const files = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    const crc = bytes.readUInt32LE(at + 16),
      packed = bytes.readUInt32LE(at + 20),
      size = bytes.readUInt32LE(at + 24),
      nameLength = bytes.readUInt16LE(at + 28),
      offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
    const data = inflateRawSync(bytes.subarray(start, start + packed));
    assert.equal(data.length, size);
    assert.equal(crc32(data), crc, `crc of ${name}`);
    files.set(name, data.toString('utf8'));
    at += 46 + nameLength;
  }
  return files;
}

test('a .xlsx is a valid zip with one worksheet per sheet, inline strings, numbers as numbers and no control characters', () => {
  const file = renderExport(
    'xlsx',
    'book',
    [
      { name: '每条消息', header: ['说话人', '内容', '数'], rows: [['玩家', 'a & <b>\u0001', 7]] },
      { name: '按对话汇总', header: ['对话编号'], rows: [] },
    ],
    { part: 1, sheet: 0 },
  );
  assert.equal(file.encoding, 'base64');
  assert.match(file.filename, /\.xlsx$/);
  const files = unzip(Buffer.from(file.content, 'base64'));
  assert.ok(files.has('[Content_Types].xml') && files.has('xl/workbook.xml') && files.has('xl/styles.xml'));
  assert.match(files.get('xl/workbook.xml')!, /name="每条消息"[\s\S]*name="按对话汇总"/);
  const sheet = files.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet, /<t xml:space="preserve">a &amp; &lt;b&gt;<\/t>/);
  assert.match(sheet, /<c r="C2"><v>7<\/v><\/c>/);
  assert.ok(!sheet.includes('\u0001'));
  assert.ok(xlsxOf([{ name: 'a', header: ['h'], rows: [] }]).length > 100);
});

test('more than 50,000 rows are split into parts of 50,000: each part is one file, and the last holds the rest', () => {
  const rows = Array.from({ length: ROWS_PER_PART * 2 + 17 }, (_, i) => [i]);
  const sheets: Sheet[] = [{ name: 'n', header: ['i'], rows }];
  const parts = [1, 2, 3].map((part) => renderExport('csv', 'big', sheets, { part, sheet: 0 }));
  assert.deepEqual(
    parts.map((p) => p.parts),
    [3, 3, 3],
  );
  assert.deepEqual(
    parts.map((p) => p.rows),
    [ROWS_PER_PART, ROWS_PER_PART, 17],
  );
  assert.deepEqual(
    parts.map((p) => p.filename),
    ['big-1of3.csv', 'big-2of3.csv', 'big-3of3.csv'],
  );
  assert.equal(parseCsv(parts[2]!.content)[1]![0], String(ROWS_PER_PART * 2), 'part 3 starts where part 2 ended');
  const book = renderExport('xlsx', 'big', sheets, { part: 3, sheet: 0 });
  assert.equal(book.rows, 17);
  assert.equal(
    renderExport('csv', 'one', [{ name: 'n', header: ['i'], rows: [[1]] }], { part: 9, sheet: 0 }).filename,
    'one.csv',
    'a single part has no suffix',
  );
});

// ---- conversations --------------------------------------------------------------------------------------------------------

test('conversations: one row per message with the review columns; the second sheet summarises each conversation', (t) => {
  const f = fixture(t);
  const { codeA, codeB } = seedChats(f);
  const e = exporter(f);
  const file = call(e, f.ownerAuth, 'conversations');
  const rows = parseCsv(file.content);
  assert.deepEqual(rows[0], [...MESSAGES_HEADER]);
  const body = rows.slice(1);
  assert.equal(body.length, 9, '4 player messages, 3 published bubbles and the failed / unknown placeholders');
  const h = MESSAGES_HEADER;
  const first = body.find((r) => r[col(h, '说话人')] === '角色' && r[col(h, '内容')] === '你好呀')!;
  assert.equal(first[col(h, '对话编号')], `JOJO-${codeA}`);
  assert.equal(first[col(h, '时间（UTC+8）')], '2026-10-12 10:30:05');
  assert.equal(first[col(h, '角色')], 'JOJO');
  assert.equal(first[col(h, '回复写法')], '新+档案');
  assert.equal(first[col(h, '草稿模型')], 'deepseek-v4-pro');
  assert.equal(first[col(h, '审核模型')], 'deepseek-v4-flash');
  assert.equal(first[col(h, '审核改动')], '是');
  assert.equal(first[col(h, '改动原因')], 'distress、denied_ai');
  assert.equal(first[col(h, '状态')], '已发布');
  assert.equal(first[col(h, '方式')], '语音');
  const player = body.find((r) => r[col(h, '说话人')] === '玩家' && r[col(h, '内容')]!.startsWith('你好'))!;
  assert.ok(player[col(h, '内容')]!.includes('〔昵称〕'), 'the nickname is replaced as on the review page');
  assert.ok(
    player[col(h, '内容')]!.includes('〔邮箱〕') && !player[col(h, '内容')]!.includes(EMAIL),
    'an email a player typed is replaced',
  );
  const failed = body.find((r) => r[col(h, '状态')] === '失败' && r[col(h, '说话人')] === '角色')!;
  assert.equal(failed[col(h, '错误代码')], 'DEEPSEEK_TIMEOUT');
  assert.equal(failed[col(h, '内容')], '');
  const unknown = body.find((r) => r[col(h, '状态')] === '结果未知' && r[col(h, '说话人')] === '角色')!;
  assert.equal(unknown[col(h, '对话编号')], `瓜瓜-${codeB}`);
  assert.equal(unknown[col(h, '草稿模型')], 'gemini-3-flash');
  assert.ok(!file.content.includes('秘密文本'), 'the candidate text is never read, only its reason codes');
  // the summary sheet
  const summary = parseCsv(call(e, f.ownerAuth, 'conversations', {}, { sheet: 1 }).content);
  assert.deepEqual(summary[0], [...CONVERSATIONS_HEADER]);
  assert.equal(summary.length, 3);
  const jojo = summary.find((r) => r[0] === `JOJO-${codeA}`)!;
  assert.deepEqual(
    [jojo[1], jojo[2], jojo[3], jojo[4], jojo[5]],
    ['JOJO', '4', '2026-10-12 10:30:00', '2026-10-12 10:31:00', '1'],
  );
  assert.match(call(e, f.ownerAuth, 'conversations', {}, { sheet: 1 }).filename, /-summary\.csv$/);
  // the workbook carries both
  const book = e.export(f.ownerAuth as never, {
    kind: 'conversations',
    format: 'xlsx',
    part: 1,
    sheet: 0,
    filters: {},
  });
  const files = unzip(Buffer.from(book.content, 'base64'));
  assert.match(files.get('xl/workbook.xml')!, /每条消息[\s\S]*按对话汇总/);
});

test('conversations: every filter narrows the rows (dates in UTC+8 days, character, 回复写法, model, status, players)', (t) => {
  const f = fixture(t);
  const { codeA, codeB } = seedChats(f);
  const e = exporter(f);
  const rowsOf = (filters: object) => parseCsv(call(e, f.ownerAuth, 'conversations', filters).content).slice(1);
  const h = MESSAGES_HEADER;
  assert.equal(rowsOf({ characterId: 'guagua' }).length, 4);
  assert.equal(rowsOf({ from: '2026-10-15', to: '2026-10-15' }).length, 4, 'the day three days later');
  assert.equal(rowsOf({ from: '2026-10-12', to: '2026-10-12' }).length, 5);
  assert.equal(rowsOf({ to: '2026-10-11' }).length, 0);
  // 10:30 on the 12th UTC+8 is 02:30 UTC: a range that starts at 2026-10-12 UTC+8 includes it, one that starts the next day does not.
  assert.equal(rowsOf({ from: '2026-10-13', to: '2026-10-14' }).length, 0);
  assert.equal(rowsOf({ writer: 'v8p' }).length, 3);
  assert.equal(rowsOf({ writer: 'v7' }).length, 6);
  assert.equal(rowsOf({ writer: 'v8m' }).length, 0);
  assert.equal(rowsOf({ model: 'gemini-3-flash' }).length, 4);
  assert.equal(rowsOf({ model: 'deepseek-v4-flash' }).length, 3, 'the review model counts');
  assert.deepEqual(new Set(rowsOf({ status: 'failed' }).map((r) => r[col(h, '状态')])), new Set(['失败']));
  assert.equal(rowsOf({ status: 'failed' }).length, 2, 'the player message and the failed reply');
  assert.equal(rowsOf({ status: 'unknown' }).length, 2);
  assert.equal(rowsOf({ status: 'published' }).length, 5);
  assert.equal(rowsOf({ players: [codeB] }).length, 4);
  assert.equal(rowsOf({ players: [codeA, codeB] }).length, 9);
  assert.ok(rowsOf({ players: [codeB] }).every((r) => r[0]!.endsWith(codeB)));
  for (const bad of [
    { from: '2026/10/12' },
    { writer: 'v9' },
    { status: 'ok' },
    { players: ['ab'] },
    { model: 'x y' },
    { from: '2026-10-13', to: '2026-10-12' },
    { nope: 1 },
  ])
    assert.throws(() => rowsOf(bad), /INVALID_REQUEST/, JSON.stringify(bad));
});

test('conversations: archived transcripts are included under their archive code, with their time moved to UTC+8', (t) => {
  const f = fixture(t);
  seedChats(f);
  f.store.run(
    `INSERT INTO web_review_archive(label,review_code,character_id,line_order,at_local,speaker,text,status,error_code,review_changed,archived_at,expires_at)
    VALUES ('JOJO-ZZZZ','ZZZZ','jojo',0,'2026-09-01 08:00','player','旧的话','ok',NULL,0,?,?),
    ('JOJO-ZZZZ','ZZZZ','jojo',1,'2026-09-01 08:01','character','旧的回复','failed','DEEPSEEK_TIMEOUT',0,?,?)`,
    T0,
    T0 + ARCHIVE_TTL_MS,
    T0,
    T0 + ARCHIVE_TTL_MS,
  );
  const rows = parseCsv(call(exporter(f), f.ownerAuth, 'conversations', { players: ['ZZZZ'] }).content).slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]![1], '2026-09-01 08:00:00', 'jojo lives in Asia/Shanghai: already UTC+8');
  assert.equal(rows[1]![11], '失败');
  assert.equal(rows[1]![12], 'DEEPSEEK_TIMEOUT');
});

test('conversations: the owner only; a delegated 测试对话 reader and every other administrator is refused', (t) => {
  const f = fixture(t);
  seedChats(f);
  const e = exporter(f);
  const reader = f.member(['conversations.read'], 'reader');
  assert.throws(() => call(e, reader, 'conversations'), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => call(e, f.member(['stats.read'], 'stats'), 'conversations'), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => call(e, { cookie: 'x', csrf: 'y', origin }, 'conversations'), /ADMIN_/);
  assert.throws(() => call(exporter(f, { chatReview: false }), f.ownerAuth, 'conversations'), /NOT_FOUND/);
});

// ---- calls and failures -------------------------------------------------------------------------------------------------------

test('calls: model, external and embedding calls and the UNKNOWN ledger - only the whitelisted columns, never a receipt body', (t) => {
  const f = fixture(t);
  const { a } = seedChats(f);
  f.round(a, 'jojo', 'x', [], T0 + 10 * 60_000, { status: 'failed', code: 'X_Y', draft: 'm', stage: 'draft' });
  f.store.run(
    `INSERT INTO web_external_attempts(operation_id,stage,phase,ordinal,provider,provider_request_id,dispatch_state,stage_version,lease_epoch,lease_token,principal_id,world_id,conversation_id,input_message_id,created_at,sent_at,receipt_json)
    VALUES ('ext1','audio','speech',0,'fish','req-1','unknown',1,1,'tok',?,?,?,?,?,?,?)`,
    a.principalId,
    a.worldId,
    'c',
    'm',
    T0,
    T0,
    JSON.stringify({ code: 'FISH_TIMEOUT', httpStatus: 504, token: SECRET }),
  );
  f.store.run(
    `INSERT INTO web_embed_attempts(id,kind,world_id,conversation_id,character_id,model,texts,max_units,price_micros_per_million,held_micros,state,lease_expires_at,created_at,sent_at)
    VALUES ('emb1','index','w','c','jojo','embed-3',2,10,5,7,'unknown',?,?,?)`,
    T0 + 1,
    T0,
    T0,
  );
  const e = exporter(f);
  const sheets = [0, 1, 2, 3].map((sheet) => parseCsv(call(e, f.ownerAuth, 'calls', {}, { sheet }).content));
  for (const sheet of sheets) assert.deepEqual(sheet[0], [...CALLS_HEADER]);
  const h = CALLS_HEADER;
  const model = sheets[0]!.slice(1);
  assert.equal(model.length, 2);
  const row = model[0]!;
  assert.equal(row[col(h, '供应商')], 'deepseek');
  assert.equal(row[col(h, '阶段')], '草稿');
  assert.equal(row[col(h, '状态')], '已确认');
  assert.equal(row[col(h, '结果')], '失败');
  assert.equal(row[col(h, '错误代码')], 'DEEPSEEK_RATE_LIMITED');
  assert.equal(row[col(h, 'HTTP 状态')], '429');
  assert.equal(row[col(h, '预留金额（美元）')], '0.000005');
  assert.equal(row[col(h, '实际扣款（美元）')], '0');
  const external = sheets[1]!.slice(1)[0]!;
  assert.deepEqual(
    [external[col(h, '供应商')], external[col(h, '错误代码')], external[col(h, 'HTTP 状态')], external[col(h, '状态')]],
    ['fish', 'FISH_TIMEOUT', '504', '结果未确认'],
  );
  assert.equal(sheets[2]!.length, 2);
  const unknown = sheets[3]!.slice(1);
  assert.equal(unknown.length, 2, 'the UNKNOWN ledger: the external and the embedding call');
  assert.deepEqual(new Set(unknown.map((r) => r[col(h, '种类')])), new Set(['外部调用', '向量调用']));
  assert.ok(Number(unknown[0]![col(h, '已过时间（分钟）')]) >= 0);
  const all = sheets.map((s) => s.map((r) => r.join('|')).join('\n')).join('\n');
  assert.ok(!all.includes(SECRET) && !all.includes(EMAIL) && !all.includes('tok'), 'no secret, body or lease token');
  // filters
  assert.equal(
    parseCsv(call(e, f.ownerAuth, 'calls', { provider: 'fish' }).content).length,
    1,
    'the model sheet has no fish',
  );
  assert.equal(parseCsv(call(e, f.ownerAuth, 'calls', { state: 'unknown' }, { sheet: 1 }).content).length, 2);
  assert.equal(parseCsv(call(e, f.ownerAuth, 'calls', { from: '2026-12-01' }).content).length, 1);
  assert.throws(() => call(e, f.member(['system.read'], 's'), 'calls'), /ADMIN_OWNER_REQUIRED/);
});

test('failures: failed and unknown replies with character, 回复写法, models and the stage that failed', (t) => {
  const f = fixture(t);
  seedChats(f);
  const e = exporter(f);
  const rows = parseCsv(call(e, f.ownerAuth, 'failures').content);
  assert.deepEqual(rows[0], [...FAILURES_HEADER]);
  const h = FAILURES_HEADER;
  assert.equal(rows.length, 3);
  const failed = rows.find((r) => r[col(h, '状态')] === '失败')!;
  assert.deepEqual(
    [
      failed[col(h, '角色')],
      failed[col(h, '回复写法')],
      failed[col(h, '草稿模型')],
      failed[col(h, '失败阶段')],
      failed[col(h, '错误代码')],
      failed[col(h, '时间（UTC+8）')],
    ],
    ['JOJO', '旧写法', 'deepseek-v4-pro', '审核', 'DEEPSEEK_TIMEOUT', '2026-10-12 10:31:00'],
  );
  const unknown = rows.find((r) => r[col(h, '状态')] === '结果未知')!;
  assert.equal(unknown[col(h, '失败阶段')], '未到模型调用');
  assert.equal(parseCsv(call(e, f.ownerAuth, 'failures', { characterId: 'guagua' }).content).length, 2);
  assert.equal(parseCsv(call(e, f.ownerAuth, 'failures', { model: 'nope' }).content).length, 1);
  assert.throws(() => call(e, f.member(['stats.read'], 's'), 'failures'), /ADMIN_OWNER_REQUIRED/);
});

// ---- statistics -------------------------------------------------------------------------------------------------------------

test('stats: per day, per hour, costs and spend by player type, as 总览 and 消耗表 show them', (t) => {
  const f = fixture(t);
  const today = new Date(T0).toISOString().slice(0, 10);
  const hour = `${today}T02`;
  f.store.run('DELETE FROM web_stats_daily');
  f.store.run(
    "INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?, 'stats_started','','',1),(?, 'extras_started','','',1)",
    today,
    today,
  );
  f.store.run(
    "INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?, 'reply_published','jojo','deepseek',5),(?, 'reply_failed','jojo','deepseek',1),(?,'signups','','',2)",
    today,
    today,
    today,
  );
  f.store.run(
    "INSERT INTO web_stats_hourly(hour,metric,character_id,value) VALUES (?,'reply_published','jojo',4),(?,'chat_users','',3)",
    hour,
    hour,
  );
  f.store.run(
    "INSERT INTO web_stats_spend(day,user_type,kind,calls,charged_micros) VALUES (?,'registered','text',3,1500000),(?,'guest','voice',1,250000)",
    today,
    today,
  );
  f.store.run(
    "INSERT INTO web_provider_usage(day,provider,model,phase,calls,input_tokens,cached_input_tokens,output_tokens,bytes,cost_micros,replies) VALUES (?,'deepseek','v4','draft',5,100,10,50,0,2000000,5)",
    today,
  );
  const e = exporter(f);
  const names = ['每日统计', '按角色', '按模型', '每小时', '每日消耗', '消耗明细', '按玩家类型'];
  const sheet = (n: number) => parseCsv(call(e, f.ownerAuth, 'stats', { range: 7 }, { sheet: n }).content);
  assert.equal(call(e, f.ownerAuth, 'stats', { range: 7 }, { sheet: 3 }).filename.includes('-hourly'), true);
  const daily = sheet(0);
  assert.equal(daily[1]![0], today);
  assert.equal(daily[1]![daily[0]!.indexOf('回复（成功）')], '5');
  assert.equal(daily[1]![daily[0]!.indexOf('新注册')], '2');
  assert.equal(sheet(1)[1]![1], '5');
  const hourly = sheet(3);
  assert.deepEqual(hourly[0], ['小时（UTC）', '指标', '角色', '数值']);
  assert.ok(
    hourly.some((r) => r[0] === `${today} 02:00` && r[1] === '回复（成功）' && r[2] === 'JOJO' && r[3] === '4'),
  );
  assert.ok(hourly.some((r) => r[1] === '聊天人数' && r[2] === '全部' && r[3] === '3'));
  assert.equal(sheet(5)[1]![sheet(5)[0]!.indexOf('列表价（美元）')], '2');
  const spend = sheet(6);
  assert.ok(spend.some((r) => r[1] === '注册玩家' && r[3] === '1.5'));
  assert.ok(spend.some((r) => r[1] === '访客' && r[4] === '0.25'));
  assert.equal(names.length, 7);
  assert.throws(() => call(e, f.ownerAuth, 'stats', { range: 5 }), /INVALID_REQUEST/);
  // stats.read is the page's permission; another administrator has none
  assert.ok(call(e, f.member(['stats.read'], 'st'), 'stats', { range: 7 }).rows > 0);
  assert.throws(() => call(e, f.member(['system.read'], 'sy'), 'stats', { range: 7 }), /ADMIN_PERMISSION_REQUIRED/);
});

// ---- the other pages ----------------------------------------------------------------------------------------------------------

test('invites: batches, masked codes and allowances - never a code, a digest, a player number or an id', (t) => {
  const f = fixture(t);
  f.store.run(
    "INSERT INTO web_invite_batches(id,name,tier,created_at) VALUES ('batch-1','内测一组','unlimited',?)",
    T0,
  );
  f.store.run(
    `INSERT INTO web_invite_codes(id,code_digest,issue_request_id,issue_digest,status,batch,created_by,created_at,batch_id,redeemed_count)
    VALUES ('inv-1','digest-SECRETDIGEST','r1','i1','active','内测一组','sess',?, 'batch-1',1),('inv-2','digest-2','r2','i2','active','内测一组','sess',?,'batch-1',0)`,
    T0,
    T0,
  );
  f.store.run(
    `INSERT INTO web_entitlements(id,principal_id,source,invite_id,batch_id,kind,starts_at,created_at) VALUES ('ent-1','principal-secret','invite','inv-1','batch-1','unlimited',?,?)`,
    T0,
    T0,
  );
  const e = exporter(f);
  const read = (sheet: number) => call(e, f.ownerAuth, 'invites', {}, { sheet }).content;
  assert.deepEqual(parseCsv(read(0))[1]!.slice(0, 2), ['内测一组', '不限额']);
  const codes = parseCsv(read(1));
  assert.deepEqual(
    codes.slice(1).map((r) => [r[1], r[2], r[3]]),
    [
      ['1', '********', '已兑换'],
      ['2', '********', '未使用'],
    ],
  );
  assert.equal(parseCsv(read(2)).length, 2);
  const text = [read(0), read(1), read(2)].join();
  assert.ok(!/SECRETDIGEST|principal-secret|ent-1|inv-1/.test(text));
  assert.throws(() => call(e, f.member(['points.grant'], 'p'), 'invites'), /ADMIN_PERMISSION_REQUIRED/);
  assert.ok(call(e, f.member(['invites.read'], 'i'), 'invites').rows >= 0);
});

test('shares, broadcasts and 网络梗: counts only, the library with its filters', (t) => {
  const f = fixture(t);
  const e = exporter(f, {
    shareStats: () => ({ created: 5, opened: 3, expired: 2, active: 1 }),
    broadcast: {
      list: () => ({
        broadcasts: [
          {
            id: 'bc-SECRET',
            state: 'sent',
            sendAt: T0,
            createdAt: T0,
            startedAt: T0,
            finishedAt: T0 + 1000,
            characters: [{ characterId: 'jojo', name: 'JOJO' }],
            recipients: 10,
            delivered: 9,
            percent: 100,
          },
        ],
        recipients: 10,
      }),
    } as never,
  });
  assert.deepEqual(parseCsv(call(e, f.ownerAuth, 'shares').content), [
    ['指标', '数量'],
    ['已创建', '5'],
    ['已打开', '3'],
    ['已过期', '2'],
    ['仍有效', '1'],
  ]);
  const broadcast = call(e, f.ownerAuth, 'broadcast').content;
  assert.deepEqual(parseCsv(broadcast)[1], [
    '已发送',
    '2026-10-12 10:30:00',
    '2026-10-12 10:30:00',
    '2026-10-12 10:30:00',
    '2026-10-12 10:30:01',
    'JOJO',
    '10',
    '9',
    '100',
  ]);
  assert.ok(!broadcast.includes('SECRET'));
  const memes = parseCsv(call(e, f.ownerAuth, 'memes').content);
  assert.deepEqual(memes[0], ['词', '释义', '年份', '标签', '状态', '默认关闭']);
  assert.ok(memes.length > 1000, 'the whole library, not one page');
  const filtered = parseCsv(call(e, f.ownerAuth, 'memes', { year: 2023, state: 'on' }).content);
  assert.ok(filtered.length > 1 && filtered.length < memes.length);
  assert.ok(filtered.slice(1).every((r) => r[2] === '2023' && r[4] === '已开启'));
});

test('rehearsal: the lines and the scores of every run of one character, through the page’s own reader', (t) => {
  const f = fixture(t);
  const info = {
    runId: 'run-SECRET',
    createdAt: T0,
    scriptName: '日常',
    models: ['deepseek'],
    turns: 1,
    withCast: false,
    status: 'done',
    estimatedMicros: 2000,
    chargedMicros: 1500,
    liveVersion: 1,
  };
  const detail = {
    run: info,
    reviewer: 'x',
    turns: [{ text: '早上好', role: null, item: null }],
    columns: [
      {
        key: 'deepseek',
        label: '旧 · DeepSeek',
        cells: [{ state: 'done', errorCode: null, bubbles: ['早呀', '睡得好吗'], answered: true }],
        counts: {
          replies: 1,
          answeredAll: 1,
          unaskedAdvice: 0,
          endsWithQuestion: 1,
          avgChars: 6,
          avgBubbles: 2,
          customerService: 0,
          repeated: 0,
          unconfirmed: 0,
          failed: 0,
          codes: {},
        },
        style: { state: 'judged', sharedOwn: 1, startedTopic: 0, showedEmotion: 1 },
        netMemes: null,
      },
    ],
    memes: null,
  };
  const seen: string[] = [];
  const e = exporter(f, {
    characters: {
      rehearsalList: (_a: unknown, id: string) => (seen.push(id), { runs: [info] }),
      rehearsalDetail: () => detail,
    } as never,
  });
  const sheet = (n: number) =>
    parseCsv(call(e, f.ownerAuth, 'rehearsal', { characterId: 'jojo' }, { sheet: n }).content);
  assert.equal(sheet(0)[1]![2], '日常');
  assert.deepEqual(seen, ['jojo']);
  assert.deepEqual(sheet(1)[1]!.slice(2), ['旧 · DeepSeek', '1', '早上好', '', '早呀\n睡得好吗', 'done', '']);
  assert.equal(sheet(2)[1]![3], '1');
  assert.ok(![sheet(0), sheet(1), sheet(2)].flat(2).join().includes('SECRET'));
});

test('co-creation: one row per answer with the inbox’s anonymous code, never an id, an email or the administrators’ note', (t) => {
  const f = fixture(t);
  const p = f.player('c');
  f.store.run(
    `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at,status,starred,admin_note) VALUES ('sub-SECRET','jojo',?, 'r1', ?,?, 'new',1,'备注-不导出')`,
    p.principalId,
    'h'.repeat(64),
    T0,
  );
  f.store.run(
    `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json,adopted_at,adopted_by,paid_points) VALUES ('sub-SECRET',0,'persona','persona','text',?,?,?,?)`,
    JSON.stringify(`喜欢猫，联系 ${EMAIL}`),
    T0 + 1000,
    'admin',
    20,
  );
  const sheets = (filters: Record<string, unknown> = {}) =>
    cocreationSheets(f.store, f.accounts, (id) => `玩家#${id.length}`, f.ownerAuth, filters);
  const [sheet] = sheets();
  assert.equal(sheet!.rows.length, 1);
  const row = sheet!.rows[0]!;
  assert.equal(row[1], '玩家#11');
  assert.equal(row[2], '角色');
  assert.equal(row[3], 'JOJO');
  assert.equal(row[8], '新');
  assert.equal(row[9], '是');
  assert.equal(row[10], '是');
  assert.equal(row[12], 20);
  assert.equal(sheets({ status: 'processed' })[0]!.rows.length, 0);
  assert.equal(sheets({ characterId: 'guagua' })[0]!.rows.length, 0);
  assert.equal(sheets({ query: '喜欢猫' })[0]!.rows.length, 1);
  const e = exporter(f, {
    cocreation: {
      exportSheets: (auth, filters) => cocreationSheets(f.store, f.accounts, () => '玩家#abcd', auth, filters as never),
    },
  });
  const text = call(e, f.ownerAuth, 'cocreation').content;
  assert.ok(!/sub-SECRET|principal-c|备注-不导出/.test(text) && !text.includes(EMAIL), 'no id, no note, no email');
  assert.ok(text.includes('玩家#abcd'));
  assert.throws(() => call(e, f.member(['stats.read'], 'x'), 'cocreation'), /ADMIN_PERMISSION_REQUIRED/);
  assert.ok(call(e, f.member(['cocreation.read'], 'y'), 'cocreation').rows === 1);
});

// ---- privacy, audit, routes ---------------------------------------------------------------------------------------------------

test('no file of any export holds an id, an email, a nickname, an IP hash or a token (every kind, both formats scanned)', (t) => {
  const f = fixture(t);
  const { a } = seedChats(f);
  f.store.run("UPDATE web_principals SET player_id='player-LEAK-1' WHERE id=?", a.principalId);
  const ipHash = 'a1b2c3d4'.repeat(8);
  const p = f.player('c');
  f.store.run(
    `INSERT INTO web_cocreation_submissions(id,character_id,principal_id,request_id,request_hash,created_at) VALUES ('sub-1','jojo',?, 'r1', ?,?)`,
    p.principalId,
    ipHash,
    T0,
  );
  f.store.run(
    `INSERT INTO web_cocreation_answers(submission_id,ordinal,card_id,target_field,kind,text_json) VALUES ('sub-1',0,'persona','persona','text',?)`,
    JSON.stringify(`我叫阿泡，ip ${ipHash}，id 123e4567-e89b-42d3-a456-426614174000`),
  );
  f.store.run(
    "INSERT INTO web_stats_daily(day,metric,character_id,model,value) VALUES (?, 'reply_published','jojo','deepseek',5)",
    new Date(T0).toISOString().slice(0, 10),
  );
  const e = exporter(f, {
    shareStats: () => ({ created: 1, opened: 1, expired: 0, active: 1 }),
    cocreation: {
      exportSheets: (auth, filters) => cocreationSheets(f.store, f.accounts, () => '玩家#abcd', auth, filters as never),
    },
  });
  const forbidden = [
    /principal-[a-z]/,
    /world-[a-z]/,
    /player-[a-zA-Z]/,
    /\bm\d+\b/,
    /\bop\d+\b/,
    /conv-/,
    /@/,
    /阿泡/,
    /[0-9a-f]{32,}/i,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i,
    /SECRET|sk-|token/i,
  ];
  const kinds: Array<[string, object, number]> = [
    ['conversations', {}, 2],
    ['calls', {}, 4],
    ['failures', {}, 1],
    ['stats', { range: 30 }, 7],
    ['cocreation', {}, 1],
    ['memes', {}, 1],
    ['invites', {}, 3],
    ['shares', {}, 1],
  ];
  let files = 0;
  for (const [kind, filters, sheets] of kinds)
    for (let sheet = 0; sheet < sheets; sheet++) {
      let text: string;
      try {
        text = call(e, f.ownerAuth, kind, filters, { sheet }).content;
      } catch (error) {
        if (/STATS_UNAVAILABLE|NOT_FOUND/.test(String(error))) continue;
        throw error;
      }
      files++;
      // The library's own meanings use words like "token"; the secret-word check is for the data exports.
      const patterns = kind === 'memes' ? forbidden.slice(0, -1) : forbidden;
      for (const pattern of patterns) assert.ok(!pattern.test(text), `${kind}#${sheet} matches ${pattern}`);
      const book = unzip(
        Buffer.from(
          e.export(f.ownerAuth as never, { kind, format: 'xlsx', part: 1, sheet, filters }).content,
          'base64',
        ),
      );
      for (const [name, xml] of book)
        for (const pattern of patterns)
          assert.ok(
            !pattern.test(xml.replace(/xmlns="[^"]+"/g, '').replace(/http[^"]+/g, '')),
            `${kind}.xlsx ${name} matches ${pattern}`,
          );
    }
  assert.ok(files > 15, `${files} files scanned`);
  assert.equal(scrubText(`a@b.co ${ipHash} 123e4567-e89b-42d3-a456-426614174000 ok`), '〔邮箱〕 〔编号〕 〔编号〕 ok');
});

test('every export writes one audit row (who, which export, filters, row count) and no content', (t) => {
  const f = fixture(t);
  const { codeA } = seedChats(f);
  const e = exporter(f);
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  const file = call(e, f.ownerAuth, 'conversations', { characterId: 'jojo', players: [codeA], status: 'published' });
  const rows = f.store.all<{ actor_id: string; action: string; target_id: string; created_at: number }>(
    'SELECT * FROM web_admin_audit ORDER BY seq',
  );
  assert.equal(rows.length - before, 1);
  const audit = rows.at(-1)!;
  assert.equal(audit.action, 'export:conversations');
  assert.equal(audit.created_at, T0);
  assert.ok(audit.actor_id && audit.actor_id.length > 0, 'who');
  assert.match(audit.target_id, /^csv\|part 1\/1\|rows 3\|/);
  assert.ok(
    audit.target_id.includes('characterId=jojo') &&
      audit.target_id.includes('status=published') &&
      audit.target_id.includes('players=1'),
  );
  assert.ok(!audit.target_id.includes(codeA), 'the players are counted, never listed');
  assert.ok(!/你好|在吗|阿泡/.test(audit.target_id), 'no content');
  assert.equal(file.rows, 3);
  // a refused export writes nothing
  const other = f.member(['stats.read'], 's');
  const count = f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  assert.throws(() => call(e, other, 'calls'));
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n, count);
  // an xlsx audit names the format and the part
  e.export(f.ownerAuth as never, { kind: 'failures', format: 'xlsx', part: 1, sheet: 0, filters: {} });
  assert.match(
    f.store.get<{ target_id: string }>('SELECT target_id FROM web_admin_audit ORDER BY seq DESC LIMIT 1')!.target_id,
    /^xlsx\|part 1\/1\|rows 2\|/,
  );
});

test('the route: exact body keys, the admin session and CSRF, `allowed` lists what this administrator may export', (t) => {
  const f = fixture(t);
  seedChats(f);
  const e = exporter(f, { shareStats: () => ({ created: 0, opened: 0, expired: 0, active: 0 }) });
  const req = (path: string, auth: { cookie: string; csrf: string; origin: string } | null, body: unknown) =>
    routeWebAdminExport(e, {
      method: 'POST',
      path: `/api/web/local/admin/export/${path}`,
      ...(auth ? { adminCookie: auth.cookie, csrf: auth.csrf, origin: auth.origin } : {}),
      body,
    });
  assert.equal(
    routeWebAdminExport(e, { method: 'POST', path: '/api/web/local/admin/stats/players', body: {} }),
    null,
    'not this router',
  );
  const ok = req('file', f.ownerAuth, { kind: 'failures', format: 'csv', part: 1, sheet: 0, filters: {} })!;
  assert.equal(ok.status, 200);
  assert.match((ok.body as { filename: string }).filename, /^failures-2026-10-12\.csv$/);
  assert.throws(
    () => req('file', f.ownerAuth, { kind: 'failures', format: 'csv', part: 1, sheet: 0 }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => req('file', f.ownerAuth, { kind: 'failures', format: 'pdf', part: 1, sheet: 0, filters: {} }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => req('file', f.ownerAuth, { kind: 'nope', format: 'csv', part: 1, sheet: 0, filters: {} }),
    /INVALID_REQUEST/,
  );
  assert.throws(
    () => req('file', f.ownerAuth, { kind: 'failures', format: 'csv', part: 0, sheet: 0, filters: {} }),
    /INVALID_REQUEST/,
  );
  assert.throws(() => req('file', null, {}), /ADMIN_UNAUTHORIZED/);
  assert.throws(() =>
    req('file', { ...f.ownerAuth, csrf: 'wrong' }, { kind: 'failures', format: 'csv', part: 1, sheet: 0, filters: {} }),
  );
  assert.throws(() => req('nope', f.ownerAuth, {}), /NOT_FOUND/);
  const owner = (req('allowed', f.ownerAuth, {})!.body as { kinds: string[] }).kinds;
  assert.ok(
    ['conversations', 'calls', 'failures', 'stats', 'memes', 'invites', 'shares'].every((k) => owner.includes(k)),
  );
  const stats = (req('allowed', f.member(['stats.read'], 'st'), {})!.body as { kinds: string[] }).kinds;
  assert.deepEqual(stats, ['stats']);
});

test('an export over 500,000 rows is refused with a sentence asking for a narrower range, and nothing is audited', (t) => {
  const f = fixture(t);
  const big: Sheet = { name: '共创收件箱', header: ['i'], rows: Array.from({ length: 500_001 }, () => [1]) };
  const e = exporter(f, { cocreation: { exportSheets: () => [big] } });
  const before = f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n;
  assert.throws(() => call(e, f.ownerAuth, 'cocreation'), /EXPORT_TOO_LARGE/);
  assert.equal(f.store.get<{ n: number }>('SELECT count(*) n FROM web_admin_audit')!.n, before);
});
