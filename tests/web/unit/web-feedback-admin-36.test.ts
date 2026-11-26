import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { Store } from '../../../apps/server/platform/store.ts';
import * as migrations from '../../../apps/server/generation/web-provider-migration.ts';
import { WebAccountAdmin } from '../../../apps/server/admin/web-account-admin.ts';
import { WebExportAdmin } from '../../../apps/server/export/web-export-admin.ts';
import { reviewCodeFor } from '../../../apps/server/review/web-chat-review.ts';
import { WebFeedbackAdmin } from '../../../apps/server/turns/web-feedback-admin.ts';
import { routeWebFeedbackAdmin } from '../../../apps/server/turns/web-feedback-routes.ts';
import { installWebFeedback } from '../../../apps/server/turns/web-feedback-schema.ts';
import { installWebTurns } from '../../../apps/server/turns/web-turn-schema.ts';
import { defaultSchedule } from '../../../packages/domain/defaults.ts';

/**
 * Part 36: the 语音反馈 page's server side. Counts per character / 回复写法 / model over a range; the 👎 list, newest first,
 * filterable, in the pseudonymous form of the review transcripts; 「已听」; the voice; the export. Owner only; no id, email or nickname.
 */
const origin = 'https://fixture.invalid';
const T0 = Date.UTC(2026, 9, 12, 2, 30);
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
  installWebTurns(store as never);
  installWebFeedback(store as never);
  const clock = { now: () => T0 };
  const accounts = new WebAccountAdmin(store, clock, origin, { features: { chatReview: true } });
  const owner = accounts.login(accounts.issueLoginGrant().token, origin);
  const ownerAuth = { cookie: owner.cookie, csrf: owner.csrf, origin };
  const grant = accounts.issueMember(owner.cookie, owner.csrf, origin, {
    requestId: 'issue-x',
    label: '运营',
    memberId: null,
    permissions: ['stats.read', 'system.read'],
  });
  const login = accounts.login(grant.token, origin);
  const memberAuth = { cookie: login.cookie, csrf: login.csrf, origin };
  const reads: unknown[] = [];
  const feedback = new WebFeedbackAdmin(store as never, clock, accounts, async (scope, mediaId) => {
    reads.push({ scope, mediaId });
    return new Uint8Array([82, 73, 70, 70]);
  });
  let n = 0;
  /** One 👎 / 👍 on a reply of a turn the player made of `lines`. */
  const rated = (opts: {
    name: string;
    character: string;
    rating: 'up' | 'down';
    target?: 'voice' | 'content';
    writer: string;
    model: string;
    at: number;
    lines: string[];
    reply: string;
    voice?: boolean;
    heard?: boolean;
  }) => {
    const i = ++n;
    const principal = `principal-${opts.name}`,
      world = `world-${opts.name}`,
      conversation = `conversation-${opts.name}-${opts.character}`;
    if (!store.get('SELECT 1 FROM web_principals WHERE id=?', principal)) {
      store.run('INSERT INTO api_players VALUES (?,?)', `player-${opts.name}`, T0);
      store.run('INSERT INTO worlds VALUES (?,?,?,?)', world, `player-${opts.name}`, 'UTC', '{}');
      store.run(
        'INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,?)',
        principal,
        `player-${opts.name}`,
        world,
        'guest',
      );
      store.run(
        'INSERT INTO player_profile_versions VALUES (?,1,?,?)',
        world,
        JSON.stringify({
          name: '阿泡',
          age: null,
          city: '',
          occupation: '',
          hobbies: '',
          notes: '',
          association: null,
        }),
        T0,
      );
    }
    if (!store.get('SELECT 1 FROM conversations WHERE id=? AND world_id=?', conversation, world)) {
      store.run("INSERT OR IGNORE INTO world_characters VALUES (?,?,'new')", world, opts.character);
      store.run(
        "INSERT INTO conversations(world_id,id,kind,private_character_id) VALUES (?,?,'private',?)",
        world,
        conversation,
        opts.character,
      );
    }
    const message = (id: string, kind: 'player' | 'character', body: string) =>
      store.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,?,?,?,?,'text',0)`,
        id,
        world,
        conversation,
        kind,
        kind,
        body,
        opts.at,
      );
    const ids = opts.lines.map((line, at) => {
      const id = `m-${i}-${at}`;
      message(id, 'player', line);
      return id;
    });
    const replyId = `reply-${i}`;
    message(replyId, 'character', opts.reply);
    const op = `op-${i}`;
    store.run(
      `INSERT INTO web_operations(id,principal_id,request_id,payload_hash,world_id,conversation_id,character_id,input_message_id,ip_window_id,status,quota_state,created_at,deadline_at,metering_type)
      VALUES (?,?,?,?,?,?,?,?,NULL,'published','used',?,?,'entitled')`,
      op,
      principal,
      `req-${i}`,
      'h',
      world,
      conversation,
      opts.character,
      ids.at(-1)!,
      opts.at,
      opts.at + 100_000,
    );
    ids.forEach((id, at) =>
      store.run(
        `INSERT INTO web_turn_bubbles(message_id,principal_id,world_id,conversation_id,character_id,request_id,request_hash,quote_message_id,ip_hash,created_at,state,operation_id)
        VALUES (?,?,?,?,?,?,'h',NULL,?,?,'turn',?)`,
        id,
        principal,
        world,
        conversation,
        opts.character,
        `b-${i}-${at}`,
        'a'.repeat(64),
        opts.at,
        op,
      ),
    );
    store.run(
      `INSERT INTO web_publications(operation_id,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,job_id,request_digest,candidate_digest,published_at,receipt_json)
      VALUES (?,?,?,?,?,?,?,?,'d','d',?,'{}')`,
      op,
      principal,
      `player-${opts.name}`,
      world,
      conversation,
      opts.character,
      ids.at(-1)!,
      `job-${i}`,
      opts.at,
    );
    store.run(
      'INSERT INTO web_publication_items(operation_id,ordinal,message_id,media_id,origin) VALUES (?,0,?,?,?)',
      op,
      replyId,
      opts.voice === false ? null : `media-${i}`,
      opts.voice === false ? 'text_fallback' : 'narrative',
    );
    store.run(
      `INSERT INTO web_feedback(principal_id,message_id,world_id,conversation_id,character_id,operation_id,rating,target,writer,model,created_at,updated_at,heard_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      principal,
      replyId,
      world,
      conversation,
      opts.character,
      op,
      opts.rating,
      opts.rating === 'down' ? (opts.target ?? 'content') : null,
      opts.writer,
      opts.model,
      opts.at,
      opts.at,
      opts.heard ? opts.at : null,
    );
    return { principal, world, replyId };
  };
  return { store, feedback, ownerAuth, memberAuth, accounts, rated, reads, clock };
}

test('counts per character, per 回复写法 and per model over a range; an older rating is outside it', (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0 - DAY,
    lines: ['在吗'],
    reply: '嗯',
  });
  f.rated({
    name: 'b',
    character: 'guagua',
    rating: 'up',
    writer: 'v8',
    model: 'deepseek',
    at: T0 - 2 * DAY,
    lines: ['你好'],
    reply: '你好呀',
  });
  f.rated({
    name: 'c',
    character: 'jojo',
    rating: 'down',
    target: 'content',
    writer: 'v7',
    model: 'gemini',
    at: T0 - 3 * DAY,
    lines: ['哈喽'],
    reply: '哈喽',
  });
  f.rated({
    name: 'd',
    character: 'jojo',
    rating: 'down',
    target: 'content',
    writer: 'v7',
    model: 'gemini',
    at: T0 - 40 * DAY,
    lines: ['很久以前'],
    reply: '嗯',
  });
  const seven = f.feedback.counts(f.ownerAuth, { range: 7 });
  assert.deepEqual(seven.total, { up: 1, down: 2, downVoice: 1, downContent: 1 });
  assert.deepEqual(seven.byCharacter.map((r) => [r.label, r.up, r.down]).sort(), [
    ['JOJO', 0, 1],
    ['瓜瓜', 1, 1],
  ]);
  assert.deepEqual(seven.byWriter.map((r) => [r.writer, r.up, r.down]).sort(), [
    ['v7', 0, 1],
    ['v8', 1, 1],
  ]);
  assert.deepEqual(seven.byModel.map((r) => [r.model, r.up, r.down]).sort(), [
    ['deepseek', 1, 1],
    ['gemini', 0, 1],
  ]);
  assert.equal(f.feedback.counts(f.ownerAuth, { range: 90 }).total.down, 3, 'the 90-day range reaches the old one');
  assert.equal(
    f.feedback.counts(f.ownerAuth, { range: 7, characterId: 'jojo' }).total.down,
    1,
    'filtered by character',
  );
  assert.throws(() => f.feedback.counts(f.ownerAuth, { range: 5 }), /INVALID_REQUEST/);
  assert.throws(() => f.feedback.counts(f.ownerAuth, { range: 7, extra: 1 }), /INVALID_REQUEST/);
});

test("the 👎 list: only 👎, newest first, filters, the player's lines of the turn in order, pseudonymous", (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0 - 10 * DAY,
    lines: ['在吗', '我刚下班', '联系我 someone@example.com'],
    reply: '先把鞋脱了',
  });
  f.rated({
    name: 'b',
    character: 'jojo',
    rating: 'down',
    target: 'content',
    writer: 'v7',
    model: 'gemini',
    at: T0 - 2 * DAY,
    lines: ['阿泡说你好'],
    reply: '你好阿泡',
    voice: false,
  });
  f.rated({
    name: 'b',
    character: 'guagua',
    rating: 'up',
    writer: 'v8',
    model: 'deepseek',
    at: T0 - DAY,
    lines: ['谢谢'],
    reply: '不客气',
  });
  const all = f.feedback.list(f.ownerAuth, { range: 30 });
  assert.equal(all.items.length, 2, 'the 👍 is not listed');
  assert.deepEqual(
    all.items.map((i) => i.target),
    ['content', 'voice'],
    'newest first',
  );
  const voice = all.items[1]!;
  assert.deepEqual(voice.playerLines, ['在吗', '我刚下班', '联系我 〔邮箱〕'], 'the whole turn, in order, scrubbed');
  assert.equal(voice.writerLabel, '新写法');
  assert.equal(voice.hasVoice, true);
  assert.equal(all.items[0]!.hasVoice, false, 'a text-fallback reply has no voice');
  assert.equal(all.items[0]!.playerLines[0], '〔昵称〕说你好', 'the nickname is replaced');
  assert.equal(all.items[0]!.replyText, '你好〔昵称〕');
  assert.match(voice.label, /^瓜瓜-[A-Z2-9]{4}$/);
  assert.equal(
    voice.label,
    `瓜瓜-${reviewCodeFor(f.store as never, 'principal-a', T0)}`,
    'the SAME anonymous code as 测试对话',
  );
  assert.equal(f.feedback.list(f.ownerAuth, { range: 30, characterId: 'jojo' }).items.length, 1);
  assert.equal(f.feedback.list(f.ownerAuth, { range: 30, writer: 'v8' }).items.length, 1);
  assert.equal(f.feedback.list(f.ownerAuth, { range: 30, model: 'gemini' }).items.length, 1);
  assert.equal(f.feedback.list(f.ownerAuth, { range: 7 }).items.length, 1, 'range');
  // nothing in what is returned names a principal, a world, a player, a conversation, an operation or an email
  const text = JSON.stringify(all);
  for (const forbidden of ['principal-', 'world-', 'player-', 'conversation-', 'op-', 'someone@example.com', '阿泡'])
    assert.ok(!text.includes(forbidden), forbidden);
  // paging
  assert.equal(f.feedback.list(f.ownerAuth, { range: 30, before: all.items[0]!.itemId }).items.length, 1);
});

test('「已听」 is idempotent, undoable, audited by item number only; a switch of the rating clears it', (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0,
    lines: ['在吗'],
    reply: '嗯',
  });
  const [item] = f.feedback.list(f.ownerAuth, { range: 7 }).items;
  assert.deepEqual(f.feedback.markHeard(f.ownerAuth, { itemId: item!.itemId, heard: true }), {
    itemId: item!.itemId,
    heard: true,
  });
  f.feedback.markHeard(f.ownerAuth, { itemId: item!.itemId, heard: true });
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_admin_audit WHERE action='feedback-heard'")!.n,
    1,
    'one audit row, however often',
  );
  assert.equal(f.feedback.list(f.ownerAuth, { range: 7, unheardOnly: true }).items.length, 0);
  assert.equal(f.feedback.list(f.ownerAuth, { range: 7 }).items[0]!.heard, true);
  f.feedback.markHeard(f.ownerAuth, { itemId: item!.itemId, heard: false });
  assert.equal(f.feedback.list(f.ownerAuth, { range: 7, unheardOnly: true }).items.length, 1);
  const audit = f.store.all<{ target_id: string }>(
    "SELECT target_id FROM web_admin_audit WHERE action LIKE 'feedback-%'",
  );
  assert.ok(audit.every((row) => /^item \d+$/.test(row.target_id)));
  assert.throws(() => f.feedback.markHeard(f.ownerAuth, { itemId: 99999, heard: true }), /NOT_FOUND/);
  assert.throws(() => f.feedback.markHeard(f.ownerAuth, { itemId: item!.itemId }), /INVALID_REQUEST/);
});

test('owner only: another administrator is refused on every action, and a bad CSRF or Origin is refused first', async (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0,
    lines: ['在吗'],
    reply: '嗯',
  });
  for (const call of [
    () => f.feedback.counts(f.memberAuth, { range: 7 }),
    () => f.feedback.list(f.memberAuth, { range: 7 }),
    () => f.feedback.markHeard(f.memberAuth, { itemId: 1, heard: true }),
  ])
    assert.throws(call, /ADMIN_OWNER_REQUIRED/);
  await assert.rejects(() => f.feedback.audio(f.memberAuth, { itemId: 1 }), /ADMIN_OWNER_REQUIRED/);
  assert.throws(() => f.feedback.counts({ ...f.ownerAuth, csrf: 'wrong' }, { range: 7 }), /ADMIN_CSRF_REQUIRED|CSRF/);
  assert.throws(
    () => f.feedback.counts({ ...f.ownerAuth, origin: 'https://evil.invalid' }, { range: 7 }),
    /ORIGIN|ADMIN_/,
  );
  assert.equal(f.reads.length, 0);
});

test('her voice of a 👎 item is read from its own conversation and media; a text-only reply has none', async (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0,
    lines: ['在吗'],
    reply: '嗯',
  });
  f.rated({
    name: 'b',
    character: 'jojo',
    rating: 'down',
    target: 'content',
    writer: 'v7',
    model: 'gemini',
    at: T0 - 1,
    lines: ['哈喽'],
    reply: '哈喽',
    voice: false,
  });
  const items = f.feedback.list(f.ownerAuth, { range: 7 }).items;
  const withVoice = items.find((i) => i.hasVoice)!;
  const clip = await f.feedback.audio(f.ownerAuth, { itemId: withVoice.itemId });
  assert.equal(clip.contentType, 'audio/wav');
  assert.equal(Buffer.from(clip.base64, 'base64').toString(), 'RIFF');
  assert.equal(f.reads.length, 1);
  assert.deepEqual((f.reads[0] as { scope: { principalId: string; characterId: string } }).scope.characterId, 'guagua');
  await assert.rejects(
    () => f.feedback.audio(f.ownerAuth, { itemId: items.find((i) => !i.hasVoice)!.itemId }),
    /NOT_FOUND/,
  );
});

test('the export: the same items and filters with the rating columns, owner only, audited, no ids', (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0,
    lines: ['在吗', '来聊聊'],
    reply: '嗯',
    heard: true,
  });
  f.rated({
    name: 'b',
    character: 'jojo',
    rating: 'down',
    target: 'content',
    writer: 'v7',
    model: 'gemini',
    at: T0 - 1,
    lines: ['哈喽'],
    reply: '哈喽',
    voice: false,
  });
  const exporter = new WebExportAdmin(f.store as never, f.clock, f.accounts, {
    chatReview: true,
    feedback: f.feedback,
  });
  assert.ok(exporter.allowed(f.ownerAuth).includes('feedback'));
  assert.ok(!exporter.allowed(f.memberAuth).includes('feedback'));
  const file = exporter.export(f.ownerAuth, {
    kind: 'feedback',
    format: 'csv',
    part: 1,
    sheet: 0,
    filters: { range: 30 },
  });
  const text = Buffer.from(
    (file as { content: string }).content,
    (file as { encoding: string }).encoding === 'base64' ? 'base64' : 'utf8',
  ).toString('utf8');
  assert.ok(text.includes('时间（UTC+8）') && text.includes('评价') && text.includes('踩的是'));
  assert.ok(
    text.includes('在吗\n来聊聊') || text.includes('在吗\r\n来聊聊') || text.includes('在吗'),
    'the player lines',
  );
  for (const forbidden of ['principal-', 'world-', 'player-', 'conversation-', 'op-', 'someone@'])
    assert.ok(!text.includes(forbidden), forbidden);
  assert.throws(
    () => exporter.export(f.memberAuth, { kind: 'feedback', format: 'csv', part: 1, sheet: 0, filters: { range: 30 } }),
    /ADMIN_OWNER_REQUIRED/,
  );
  assert.throws(
    () =>
      exporter.export(f.ownerAuth, {
        kind: 'feedback',
        format: 'csv',
        part: 1,
        sheet: 0,
        filters: { range: 30, who: 'x' },
      }),
    /INVALID_REQUEST/,
  );
  assert.equal(
    f.store.get<{ n: number }>("SELECT count(*) n FROM web_admin_audit WHERE action='export:feedback'")!.n,
    1,
  );
  const only = exporter.export(f.ownerAuth, {
    kind: 'feedback',
    format: 'csv',
    part: 1,
    sheet: 0,
    filters: { range: 30, characterId: 'jojo' },
  });
  const small = Buffer.from((only as { content: string }).content, 'utf8').toString('utf8');
  assert.ok(small.includes('哈喽') && !small.includes('来聊聊'));
});

test("the routes: counts, list, heard, audio; any other path is not this router's", async (t) => {
  const f = fixture(t);
  f.rated({
    name: 'a',
    character: 'guagua',
    rating: 'down',
    target: 'voice',
    writer: 'v8',
    model: 'deepseek',
    at: T0,
    lines: ['在吗'],
    reply: '嗯',
  });
  const req = (path: string, body: unknown, method = 'POST') => ({
    method,
    path: `/api/web/local/admin/feedback/${path}`,
    adminCookie: f.ownerAuth.cookie,
    csrf: f.ownerAuth.csrf,
    origin,
    body,
  });
  assert.equal(await routeWebFeedbackAdmin(f.feedback, { method: 'POST', path: '/api/web/local/admin/other' }), null);
  const counts = await routeWebFeedbackAdmin(f.feedback, req('counts', { range: 7 }));
  assert.equal((counts!.body as { total: { down: number } }).total.down, 1);
  const list = (await routeWebFeedbackAdmin(f.feedback, req('list', { range: 7 })))!.body as {
    items: { itemId: number }[];
  };
  assert.equal(list.items.length, 1);
  await routeWebFeedbackAdmin(f.feedback, req('heard', { itemId: list.items[0]!.itemId, heard: true }));
  const audio = (await routeWebFeedbackAdmin(f.feedback, req('audio', { itemId: list.items[0]!.itemId })))!.body as {
    base64: string;
  };
  assert.ok(audio.base64.length > 0);
  await assert.rejects(() => routeWebFeedbackAdmin(f.feedback, req('counts', { range: 7 }, 'GET')), /NOT_FOUND/);
  await assert.rejects(() => routeWebFeedbackAdmin(f.feedback, req('nothing', {})), /NOT_FOUND/);
  await assert.rejects(
    () => routeWebFeedbackAdmin(f.feedback, { ...req('counts', { range: 7 }), adminCookie: undefined }),
    /ADMIN_UNAUTHORIZED/,
  );
  await assert.rejects(() => routeWebFeedbackAdmin(null, req('counts', { range: 7 })), /NOT_FOUND/);
});
