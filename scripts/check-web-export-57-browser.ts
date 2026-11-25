import './player-build-guard.ts';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { startConsoleFixture } from './console-fixture-24b6.ts';
import { reviewCodeFor } from '../apps/server/review/web-chat-review.ts';

/**
 * Part 57 in a REAL browser (Chromium), on the synthetic site of console-fixture-24b6.ts: the one 导出 button of each page (top right of
 * its title row), the dialog it opens (格式, 内容, 范围, the page's filters), the files the browser saves (a CSV with a BOM, a .xlsx that
 * is a real zip with its sheets) and what a delegated 测试对话 reader does NOT see. 测试对话 carries 50,010 messages so the split into
 * two files of at most 50,000 rows is seen end to end. Every saved file is scanned: no id, email, nickname, IP hash or token.
 *
 * usage: node scripts/check-web-export-57-browser.ts [screenshot-dir]   (run `pnpm web:player:build` first)
 */
const shots = process.argv[2] ? resolve(process.argv[2]) : null;
if (shots) mkdirSync(shots, { recursive: true });
// biome-ignore lint/suspicious/noExplicitAny: untyped optional tool
type Page = any;
const NICKNAME = '阿泡';
const f = await startConsoleFixture({ provider: { draftMs: 80, reviewMs: 80 }, chatReview: true });
const errors: string[] = [];
let failure: unknown = null;
try {
  const T = Date.parse('2026-11-20T02:00:00Z');
  // ---- 测试对话: two players, a few real rounds, and one long chat that needs two files ----
  const db = f.store;
  db.db.exec('PRAGMA foreign_keys=OFF');
  let seq = 0;
  const player = (name: string) => {
    const principalId = `principal-${name}`,
      worldId = `world-${name}`;
    db.run('INSERT INTO api_players VALUES (?,?)', `player-${name}`, T);
    db.run('INSERT INTO worlds VALUES (?,?,?,?)', worldId, `player-${name}`, 'UTC', '{}');
    db.run(
      'INSERT INTO web_principals(id,player_id,world_id,kind) VALUES (?,?,?,?)',
      principalId,
      `player-${name}`,
      worldId,
      'guest',
    );
    db.run(
      'INSERT INTO web_guest_retention(principal_id,world_id,started_at,expires_at,state) VALUES (?,?,?,?,?)',
      principalId,
      worldId,
      T - 1000,
      T + 3_600_000,
      'active',
    );
    db.run(
      'INSERT INTO player_profile_versions VALUES (?,1,?,?)',
      worldId,
      JSON.stringify({
        name: NICKNAME,
        age: null,
        city: '',
        occupation: '',
        familyBackground: '',
        sharedCharacterIds: [],
      }),
      T,
    );
    return { principalId, worldId };
  };
  const message = (
    who: { worldId: string },
    characterId: string,
    kind: 'player' | 'character',
    body: string,
    at: number,
  ) => {
    db.run("INSERT OR IGNORE INTO world_characters VALUES (?,?,'new')", who.worldId, characterId);
    const conversationId = `conv-${who.worldId}-${characterId}`;
    db.run("INSERT OR IGNORE INTO conversations VALUES (?,?,'private',?)", who.worldId, conversationId, characterId);
    const id = `m${++seq}`;
    db.run(
      `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,?,?,?,?,'text',0)`,
      id,
      who.worldId,
      conversationId,
      kind,
      kind === 'player' ? who.worldId : characterId,
      body,
      at,
    );
    return { id, conversationId };
  };
  const round = (
    who: { principalId: string; worldId: string },
    characterId: string,
    text: string,
    reply: string[] | 'failed',
    at: number,
  ) => {
    const input = message(who, characterId, 'player', text, at);
    const op = `op${++seq}`;
    db.run(
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
      reply === 'failed' ? 'failed' : 'published',
      at,
      at + 60_000,
      reply === 'failed' ? 'DEEPSEEK_TIMEOUT' : null,
    );
    db.run(
      `INSERT INTO web_operation_models(operation_id,chosen,voice,points_charged,price_version,draft_provider,draft_model,review_provider,review_model,created_at)
      VALUES (?,'deepseek',0,1,1,'deepseek','deepseek-v4-pro','deepseek','deepseek-v4-flash',?)`,
      op,
      at,
    );
    if (reply === 'failed') return;
    db.run(
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
      db.run("INSERT INTO web_publication_items VALUES (?,?,?,NULL,'text_fallback')", op, ordinal, m.id);
    });
  };
  const a = player('a'),
    b = player('b'),
    long = player('long');
  round(a, 'jojo', `你好${NICKNAME}，邮箱 someone@example.com`, ['你好呀', '今天怎么样'], T);
  round(a, 'jojo', '再说一句', 'failed', T + 60_000);
  round(b, 'wei-guagua', '在吗', ['在的'], T + 3_600_000);
  db.transaction(() => {
    for (let i = 0; i < 50_010; i++)
      db.run(
        `INSERT INTO messages(id,world_id,conversation_id,author_kind,author_id,body,created_at,delivery,proactive) VALUES (?,?,?,?,?,?,?,'text',0)`,
        `long${i}`,
        long.worldId,
        `conv-${long.worldId}-chen-jimi`,
        i % 2 ? 'character' : 'player',
        i % 2 ? 'chen-jimi' : long.worldId,
        `第${i}句`,
        T + i,
      );
  });
  db.run("INSERT OR IGNORE INTO world_characters VALUES (?,?,'new')", long.worldId, 'chen-jimi');
  db.run(
    "INSERT OR IGNORE INTO conversations VALUES (?,?,'private',?)",
    long.worldId,
    `conv-${long.worldId}-chen-jimi`,
    'chen-jimi',
  );
  db.transaction(() => {
    for (const who of [a, b, long]) reviewCodeFor(db, who.principalId, T);
  });
  db.run(
    `INSERT INTO web_provider_attempts(operation_id,phase,ordinal,principal_id,player_id,world_id,conversation_id,character_id,input_message_id,request_digest,policy_hash,wire_request_hash,voice_version,provider,model,price_id,max_units,held_micros,state,sent_at,settled_at,outcome,usage_units,charged_micros,receipt_json,created_at)
    SELECT id,'review',-1,principal_id,'player-a',world_id,conversation_id,character_id,input_message_id,'a','a','a','v','deepseek','deepseek-v4-pro','price',10,5,'known',created_at,created_at+1,'failed',0,0,?,created_at
    FROM web_operations WHERE status='failed'`,
    JSON.stringify({ errorCode: 'DEEPSEEK_TIMEOUT', apiKey: 'sk-SECRET-VALUE', body: 'someone@example.com' }),
  );

  const watch = (page: Page) => {
    page.on('pageerror', (error: unknown) => errors.push(String(error)));
    page.on('console', (m: { type: () => string; text: () => string }) => {
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource')) errors.push(`console: ${m.text()}`);
    });
  };
  const open = async (context: typeof f.context, route: string, width = 1440, height = 900) => {
    const page: Page = await context.newPage();
    watch(page);
    await page.setViewportSize({ width, height });
    await page.goto(`${f.origin}/?mode=provider-admin#/${route}`);
    await page.locator('.admin-content').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(900);
    return page;
  };
  const snap = async (page: Page, name: string) => {
    await page.waitForTimeout(300);
    if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  };
  const forbidden = [
    /principal-[a-z]/,
    /world-[a-z]/,
    /player-[a-z]/,
    /\bop\d+\b/,
    /conv-/,
    /@/,
    /阿泡/,
    /[0-9a-f]{32,}/i,
    /sk-SECRET/,
  ];
  const textOf = (path: string) => readFileSync(path);
  /** Opens the dialog, picks the options, saves every file the browser is handed; returns the files (path + suggested name). */
  const exportFiles = async (page: Page, choose: (dialog: Page) => Promise<void>, expected: number) => {
    await page.getByRole('button', { name: '导出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '导出' });
    await dialog.waitFor();
    await choose(dialog);
    const downloads: { path: () => Promise<string>; suggestedFilename: () => string }[] = [];
    page.on('download', (d: (typeof downloads)[number]) => downloads.push(d));
    await dialog.getByRole('button', { name: '导出', exact: true }).click();
    await page.waitForFunction(
      (n: number) => document.querySelectorAll('.ex-dialog').length === 0 || n === 0,
      expected,
      { timeout: 60_000 },
    );
    await dialog.waitFor({ state: 'detached', timeout: 60_000 });
    assert.equal(downloads.length, expected, `${expected} file(s)`);
    return Promise.all(downloads.map(async (d) => ({ name: d.suggestedFilename(), bytes: textOf(await d.path()) })));
  };
  const csvOf = (bytes: Buffer) => {
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'a UTF-8 BOM');
    return bytes.toString('utf8').slice(1).trimEnd().split('\r\n');
  };
  const entries = (bytes: Buffer) => {
    assert.equal(bytes.readUInt32LE(0), 0x04034b50, 'a zip');
    const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const count = bytes.readUInt16LE(end + 10);
    let at = bytes.readUInt32LE(end + 16);
    const out = new Map<string, string>();
    for (let i = 0; i < count; i++) {
      const packed = bytes.readUInt32LE(at + 20),
        nameLength = bytes.readUInt16LE(at + 28),
        offset = bytes.readUInt32LE(at + 42);
      const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28);
      out.set(name, inflateRawSync(bytes.subarray(start, start + packed)).toString('utf8'));
      at += 46 + nameLength;
    }
    return out;
  };
  const scan = (name: string, text: string) => {
    for (const pattern of forbidden) assert.ok(!pattern.test(text), `${name} matches ${pattern}`);
  };
  /** The button sits at the top right of the title row, and its hover tip is the console's own bubble. */
  const checkButton = async (page: Page, panel: string) => {
    const button = page.locator(`${panel} .page-export, ${panel} .admin-bar .page-export`).first();
    await button.waitFor({ timeout: 15_000 });
    const box = await button.boundingBox();
    const view = page.viewportSize();
    assert.ok(box && box.x > view.width * 0.5 && box.y < 200, `${panel}: 导出 is top right (${JSON.stringify(box)})`);
    await button.hover();
    await page.waitForTimeout(150);
    assert.match((await button.locator('.ad-tip').textContent()) ?? '', /CSV 或 Excel/, 'the hover tip');
    await page.mouse.move(5, 5);
  };

  // =============== 测试对话 ===============
  const owner = await open(f.context, 'conversations');
  await checkButton(owner, '#admin-conversations');
  await owner.getByRole('button', { name: '导出', exact: true }).click();
  await snap(owner, 'export-dialog-conversations');
  await owner.keyboard.press('Escape');
  // the whole table, CSV: two files (50,000 + the rest), each with a BOM, the header first
  const parts = await exportFiles(
    owner,
    async (dialog) => {
      await dialog.getByRole('button', { name: 'CSV', exact: true }).click();
    },
    2,
  );
  assert.deepEqual(
    parts.map((p) => p.name.replace(/\d{4}-\d{2}-\d{2}/, 'DATE')),
    ['conversations-DATE-messages-1of2.csv', 'conversations-DATE-messages-2of2.csv'],
  );
  const first = csvOf(parts[0]!.bytes),
    second = csvOf(parts[1]!.bytes);
  assert.equal(first.length - 1, 50_000, 'the first file holds 50,000 rows');
  assert.equal(first.length - 1 + (second.length - 1), 50_010 + 7, 'every message of every conversation, once');
  assert.match(
    first[0]!,
    /^对话编号,时间（UTC\+8）,说话人,角色,内容,方式,回复写法,草稿模型,审核模型,审核改动,改动原因,状态,错误代码$/,
  );
  for (const part of parts) scan(part.name, part.bytes.toString('utf8'));
  // a filtered workbook: the failed replies of the page's own character filter, .xlsx with both sheets
  const book = await exportFiles(
    owner,
    async (dialog) => {
      await dialog.getByRole('button', { name: '失败的回复', exact: true }).click();
    },
    1,
  );
  const failures = entries(book[0]!.bytes);
  assert.ok(failures.has('xl/worksheets/sheet1.xml'));
  assert.match(failures.get('xl/worksheets/sheet1.xml')!, /DEEPSEEK_TIMEOUT/);
  assert.match(failures.get('xl/worksheets/sheet1.xml')!, /审核/, 'the stage that failed');
  scan(book[0]!.name, [...failures.values()].join('\n'));
  const messages = await exportFiles(
    owner,
    async (dialog) => {
      await dialog.locator('select[data-ex="status"]').selectOption('failed');
      await dialog.locator('input[data-ex="model"]').fill('deepseek-v4-pro');
    },
    1,
  );
  const sheets = entries(messages[0]!.bytes);
  assert.match(sheets.get('xl/workbook.xml')!, /每条消息[\s\S]*按对话汇总/);
  const sheet1 = sheets.get('xl/worksheets/sheet1.xml')!;
  assert.match(sheet1, /DEEPSEEK_TIMEOUT/);
  assert.ok(!sheet1.includes('第1句'), 'the status filter left the long chat out');
  scan(messages[0]!.name, [...sheets.values()].join('\n'));
  await snap(owner, 'export-done-conversations');

  // a delegated 测试对话 reader has no button and the server refuses the route
  const grant = await (
    await f.post('members/issue', {
      requestId: crypto.randomUUID(),
      label: '只读',
      memberId: null,
      permissions: ['conversations.read'],
    })
  ).json();
  const helper = await f.browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
  const login = await helper.request.post(`${f.API}/admin/login`, {
    data: { token: grant.token },
    headers: { origin: f.config.origin },
  });
  assert.equal(login.status(), 200);
  const helperCsrf = (await login.json()).csrf as string;
  const reader = await open(helper, 'conversations');
  assert.equal(
    await reader.locator('#admin-conversations .page-export').isVisible(),
    false,
    'no 导出 for a delegated reader',
  );
  const refused = await helper.request.post(`${f.API}/admin/export/file`, {
    data: { kind: 'conversations', format: 'csv', part: 1, sheet: 0, filters: {} },
    headers: { origin: f.config.origin, 'x-csrf-token': helperCsrf },
  });
  assert.equal(refused.status(), 403);

  // =============== 总览 and 消耗表: the daily table, the hourly one, the spend ===============
  for (const [route, panel, shotName] of [
    ['overview', '#admin-overview', 'export-dialog-overview'],
    ['costs', '#admin-costs', 'export-dialog-costs'],
  ] as const) {
    const page = await open(f.context, route);
    await checkButton(page, panel);
    await page.getByRole('button', { name: '导出', exact: true }).click();
    await snap(page, shotName);
    await page.keyboard.press('Escape');
    const files = await exportFiles(
      page,
      async (dialog) => {
        await dialog.getByRole('button', { name: 'Excel（.xlsx）', exact: true }).click();
        await dialog.getByRole('button', { name: '7 天', exact: true }).click();
      },
      1,
    );
    const book = entries(files[0]!.bytes);
    assert.match(book.get('xl/workbook.xml')!, /每日统计[\s\S]*每小时[\s\S]*按玩家类型/);
    scan(files[0]!.name, [...book.values()].join('\n'));
  }

  // =============== 系统状态: calls, failures, share counts ===============
  const system = await open(f.context, 'system');
  await checkButton(system, '#admin-system');
  const calls = await exportFiles(
    system,
    async (dialog) => {
      await dialog.getByRole('button', { name: 'CSV', exact: true }).click();
      await dialog.getByRole('button', { name: '结果未知的调用', exact: true }).click();
    },
    1,
  );
  const unknownLines = csvOf(calls[0]!.bytes);
  assert.equal(
    unknownLines[0],
    '时间（UTC+8）,种类,供应商,模型,阶段,状态,结果,错误代码,HTTP 状态,预留金额（美元）,实际扣款（美元）,已过时间（分钟）',
  );
  scan(calls[0]!.name, calls[0]!.bytes.toString('utf8'));
  await snap(system, 'export-dialog-system');

  // =============== 网络梗, 邀请与额度, 广播: one button each, files with no player in them ===============
  for (const [route, panel, kind] of [
    ['cocreation', '#admin-cocreation', 'cocreation'],
    ['memes', '#admin-memes', 'memes'],
    ['invites', '#admin-invites', 'invites'],
    ['broadcast', '#admin-broadcast', 'broadcast'],
  ] as const) {
    const page = await open(f.context, route);
    await checkButton(page, panel);
    const files = await exportFiles(
      page,
      async (dialog) => {
        await dialog.getByRole('button', { name: 'CSV', exact: true }).click();
      },
      1,
    );
    const lines = csvOf(files[0]!.bytes);
    assert.ok(lines.length >= 1, `${kind}: a header`);
    if (kind !== 'memes') scan(files[0]!.name, files[0]!.bytes.toString('utf8'));
    if (kind === 'invites')
      assert.ok(!files[0]!.bytes.toString('utf8').match(/[A-Za-z0-9_-]{20,}/), 'no invite code in the file');
    await snap(page, `export-dialog-${kind}`);
  }

  // the audit rows: one per export, no content
  const audit = f.store.all<{ action: string; target_id: string }>(
    "SELECT action,target_id FROM web_admin_audit WHERE action LIKE 'export:%' ORDER BY seq",
  );
  assert.ok(audit.length >= 10, `${audit.length} audit rows`);
  for (const row of audit) assert.ok(!/你好|在吗|someone@|阿泡/.test(row.target_id), 'no content in the audit row');
  assert.ok(
    audit.some((row) => row.action === 'export:conversations' && /part 2\/2/.test(row.target_id)),
    'the second part is audited too',
  );
  assert.deepEqual(errors, [], 'no uncaught page errors');
  process.stdout.write('export browser check: PASS\n');
} catch (error) {
  failure = error;
} finally {
  await f.close();
}
if (failure) {
  console.error(failure);
  process.exitCode = 1;
}
