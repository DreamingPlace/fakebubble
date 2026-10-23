import assert from 'node:assert/strict';
import { createDecipheriv, createHash, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { migrateWebProviderInviteCodes } from '../../../apps/server/generation/web-provider-migration.ts';
import { csvCell, inviteCodesCsv } from '../../../apps/server/invites/web-invite-export.ts';
import { DomainError } from '../../../packages/domain/errors.ts';
import { registerSqlTextLoader } from '../../../scripts/web-sql-text.ts';
import { schema126, tiersFixture } from '../fixtures/invite-tiers.ts';

registerSqlTextLoader();
const { expectedWebMigrations } = await import('../../../workers/web-cloudflare/migrations.ts');

const SEAL_KEY = Buffer.alloc(32, 5);
const sql127 = () =>
  readFileSync(new URL('../../../apps/server/web-migrations/127_invite_codes_viewable.sql', import.meta.url), 'utf8');
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return 'ok';
};

/** Part 22a2. An owner, two administrators with invites.manage (A and B), a batch made before 127 and one by each of owner / A. */
function world(t: test.TestContext) {
  const f = tiersFixture(t, { sealKey: SEAL_KEY });
  const A = f.member(['invites.manage'], 'A');
  const B = f.member(['invites.manage'], 'B');
  const reader = f.member(['invites.read'], 'reader');
  const sid = {
    owner: f.sessionIdOf(f.owner),
    A: f.sessionIdOf(A),
    B: f.sessionIdOf(B),
    reader: f.sessionIdOf(reader),
  };
  const unlimited = { tier: { kind: 'unlimited' as const } };
  // A batch from before migration 127: it has a digest and nothing sealed, and no creating member.
  const old = f.create(A, { name: '旧批次', count: 2, ...unlimited });
  f.store.run('UPDATE web_invite_codes SET code_sealed=NULL WHERE batch_id=?', old.batchId);
  f.store.run('UPDATE web_invite_batches SET created_by_member=NULL WHERE id=?', old.batchId);
  const byOwner = f.create(f.owner, { name: '主管理员批次', count: 2, ...unlimited });
  const byA = f.create(A, { name: '管理员A批次', count: 2, ...unlimited });
  return { f, A, B, reader, sid, old, byOwner, byA, unlimited };
}
const cells = (rows: { code: string | null; codeView: string }[]) => rows.map((r) => [r.codeView, r.code]);

test('127 is its own step, the same SQL on both authorities, adds two nullable columns and changes no row', (t) => {
  const store = schema126();
  t.after(() => store.close());
  const columns = (table: string) => store.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
  assert.equal(columns('web_invite_codes').includes('code_sealed'), false);
  const before = JSON.stringify([
    store.all('SELECT * FROM web_invite_codes'),
    store.all('SELECT * FROM web_invite_batches'),
  ]);
  migrateWebProviderInviteCodes(store);
  assert.equal(store.get<{ user_version: number }>('PRAGMA user_version')?.user_version, 127);
  assert.equal(columns('web_invite_codes').at(-1), 'code_sealed');
  assert.equal(columns('web_invite_batches').at(-1), 'created_by_member');
  assert.equal(store.get('PRAGMA foreign_key_check'), undefined);
  assert.equal(
    JSON.stringify([store.all('SELECT * FROM web_invite_codes'), store.all('SELECT * FROM web_invite_batches')]),
    before,
  );
  assert.throws(() => migrateWebProviderInviteCodes(store), /WEB_PROVIDER_INVITE_CODES_MIGRATION_REQUIRED/);
  const { inline, r2 } = expectedWebMigrations();
  // Named exception (Part 22c, migration 128): the ledger has 53 steps and 128 is the newest, so step counts, positions counted from the end of the ledger and expected versions moved by one again. No assertion was weakened.
  assert.equal(inline.length, 53);
  assert.equal(inline.at(-2)!.version, 127);
  assert.equal(inline.at(-2)!.sha256, createHash('sha256').update(sql127()).digest('hex'));
  assert.deepEqual(r2.at(-2), inline.at(-2));
  // 1-126 are byte for byte what they were (126 is the hash the 22x deployment recorded).
  assert.equal(
    inline.find((m) => m.version === 126)!.sha256,
    '68526f0cfc26957124a4a2f7ea9bcc600cc11c6ba0fcb3702b866aba67efec4e',
  );
  assert.equal(
    inline.find((m) => m.version === 125)!.sha256,
    '9e7d9ca7a596747e399a6e69640785015fbd57339ef886dd17945386d7e85a1d',
  );
});

test('a new code is stored sealed under an HKDF key from SEAL_KEY (label invite-code-v1); the digest still redeems; nothing in the database is plain', (t) => {
  const { f, byA } = world(t);
  const rows = f.store.all<{ id: string; code_digest: string; code_sealed: Uint8Array }>(
    'SELECT id,code_digest,code_sealed FROM web_invite_codes WHERE batch_id=? ORDER BY created_at,id',
    byA.batchId,
  );
  assert.equal(rows.length, 2);
  const key = Buffer.from(hkdfSync('sha256', SEAL_KEY, Buffer.alloc(0), 'invite-code-v1', 32));
  rows.forEach((row, i) => {
    const raw = Buffer.from(row.code_sealed);
    assert.equal(raw.length, 12 + 43 + 16, 'nonce + 43 bytes of code + GCM tag');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`invite-code-v1\0${row.id}`));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString();
    assert.equal(plain, byA.codes![i]);
    assert.equal(raw.includes(Buffer.from(plain)), false, 'the code is not in the blob');
  });
  // No column of any invite table, as text or hex, holds a plain code.
  const dump = JSON.stringify([
    f.store.all('SELECT * FROM web_invite_codes'),
    f.store.all('SELECT * FROM web_invite_batches'),
  ]);
  for (const plain of byA.codes!) assert.equal(dump.includes(plain), false);
  // Redemption is unchanged: it reads the digest only.
  const player = f.player('ann', { signedUp: true });
  assert.equal(f.redeem(player, byA.codes![0]!).entitlement.kind, 'unlimited');
  // A sealed code cannot be moved to another row: the row id is authenticated.
  f.store.run('UPDATE web_invite_codes SET code_sealed=? WHERE id=?', rows[1]!.code_sealed, rows[0]!.id);
  const seen = f.tiers.batchDetail(f.sessionIdOf(f.owner), byA.batchId).codes;
  assert.equal(seen[0]!.codeView, 'legacy', 'a swapped blob does not open');
  assert.equal(seen[1]!.codeView, 'plain');
});

test('who sees what: owner every plain code, the creating administrator their own batch, another administrator ********, an old code 旧邀请码无法再次查看', (t) => {
  const { f, sid, old, byOwner, byA } = world(t);
  const view = (who: keyof typeof sid, batchId: string) => f.tiers.batchDetail(sid[who], batchId);
  const plainOf = (batch: { codes: string[] | null }) =>
    cells(batch.codes!.map((c) => ({ code: c, codeView: 'plain' })));
  // A batch made before 127: nobody can read it, the owner included.
  for (const who of ['owner', 'A', 'B'] as const)
    assert.deepEqual(
      cells(view(who, old.batchId).codes),
      [
        ['legacy', null],
        ['legacy', null],
      ],
      who,
    );
  // The owner's batch: the owner plain; A and B masked.
  assert.deepEqual(cells(view('owner', byOwner.batchId).codes), plainOf(byOwner));
  for (const who of ['A', 'B'] as const)
    assert.deepEqual(
      cells(view(who, byOwner.batchId).codes),
      [
        ['masked', '********'],
        ['masked', '********'],
      ],
      who,
    );
  // A's batch: the owner and A plain; B masked.
  assert.deepEqual(cells(view('owner', byA.batchId).codes), plainOf(byA));
  assert.deepEqual(cells(view('A', byA.batchId).codes), plainOf(byA));
  assert.deepEqual(cells(view('B', byA.batchId).codes), [
    ['masked', '********'],
    ['masked', '********'],
  ]);
  assert.deepEqual(
    [view('owner', byA.batchId).canViewCodes, view('A', byA.batchId).canViewCodes, view('B', byA.batchId).canViewCodes],
    [true, true, false],
  );
  // The server never put a plain code in front of B: not in the detail, not in the export.
  const forB = JSON.stringify([
    view('B', byA.batchId),
    view('B', byOwner.batchId),
    view('B', old.batchId),
    f.tiers.exportBatch(sid.B, byA.batchId),
    f.tiers.exportBatch(sid.B, byOwner.batchId),
    f.tiers.listBatches(sid.B),
  ]);
  for (const plain of [...byA.codes!, ...byOwner.codes!, ...old.codes!]) assert.equal(forB.includes(plain), false);
  // B still sees the batch's name, tier, N / cap, count, redeemed and status.
  const listed = f.tiers.listBatches(sid.B).batches.find((b) => b.id === byA.batchId)!;
  assert.deepEqual(
    [listed.name, listed.tier, listed.codes, listed.redeemed, listed.revoked],
    ['管理员A批次', 'unlimited', 2, 0, 0],
  );
  // Nobody else sees the page at all.
  assert.equal(
    code(() => f.tiers.batchDetail(sid.reader, byA.batchId)),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(
    code(() => f.tiers.exportBatch(sid.reader, byA.batchId)),
    'ADMIN_PERMISSION_REQUIRED',
  );
  assert.equal(
    code(() => f.tiers.exportBatch('no-such-session', byA.batchId)),
    'ADMIN_UNAUTHORIZED',
  );
});

test('the creating administrator is a PERSON: a later login session of the same member still sees the batch; a different member does not', (t) => {
  const { f, A, B, byA } = world(t);
  const member = f.store.get<{ member_id: string }>(
    'SELECT member_id FROM web_admin_session_members WHERE session_id=?',
    f.sessionIdOf(A),
  )!.member_id;
  // A second login of the same member (the first session ended or A signs in on another device).
  f.store.run("INSERT INTO admin_sessions VALUES ('A-later','h-later',?,?,NULL)", f.clock(), f.clock() + 3_600_000);
  f.store.run("INSERT INTO web_admin_session_members VALUES ('A-later',?)", member);
  assert.deepEqual(
    cells(f.tiers.batchDetail('A-later', byA.batchId).codes),
    cells(byA.codes!.map((c) => ({ code: c, codeView: 'plain' }))),
  );
  assert.equal(f.tiers.batchDetail(f.sessionIdOf(B), byA.batchId).canViewCodes, false);
  assert.ok(A);
});

test('the CSV: UTF-8 BOM, the six columns, the same masking rule, a row per code; each export and each view of plain codes is audit-logged without the codes', (t) => {
  const { f, sid, old, byOwner, byA } = world(t);
  const lines = (csv: string) =>
    csv
      .replace(/^\uFEFF/, '')
      .trimEnd()
      .split('\r\n');
  const asOwner = f.tiers.exportBatch(sid.owner, byA.batchId);
  assert.equal(asOwner.csv.startsWith('\uFEFF'), true, 'a BOM so Excel reads the Chinese');
  assert.equal(Buffer.from(asOwner.csv).subarray(0, 3).toString('hex'), 'efbbbf');
  assert.deepEqual(lines(asOwner.csv)[0], '序号,邀请码,状态,兑换时间 (UTC),玩家编号,额度到期');
  assert.equal(asOwner.rows, 2);
  assert.deepEqual(
    lines(asOwner.csv)
      .slice(1)
      .map((l) => l.split(',').slice(0, 3)),
    [
      ['1', byA.codes![0]!, '未使用'],
      ['2', byA.codes![1]!, '未使用'],
    ],
  );
  assert.deepEqual(lines(f.tiers.exportBatch(sid.B, byA.batchId).csv).slice(1), [
    '1,********,未使用,,,',
    '2,********,未使用,,,',
  ]);
  assert.deepEqual(lines(f.tiers.exportBatch(sid.A, old.batchId).csv).slice(1), [
    '1,旧邀请码无法再次查看,未使用,,,',
    '2,旧邀请码无法再次查看,未使用,,,',
  ]);
  // Audit: who, which batch, how many rows - never a code.
  f.tiers.batchDetail(sid.owner, byOwner.batchId);
  f.tiers.batchDetail(sid.B, byOwner.batchId); // all masked: nothing plain left the server, so no 'viewed' entry
  const audit = f.store.all<{ actor_id: string; action: string; target_id: string }>(
    "SELECT actor_id,action,target_id FROM web_admin_audit WHERE action LIKE 'invite-codes-viewed%' OR action LIKE 'invite-batch-exported%' ORDER BY seq",
  );
  const memberOf = (s: string) =>
    f.store.get<{ member_id: string }>('SELECT member_id FROM web_admin_session_members WHERE session_id=?', s)!
      .member_id;
  assert.deepEqual(
    audit.map((a) => [a.actor_id, a.action, a.target_id]),
    [
      [memberOf(sid.owner), 'invite-batch-exported:2', byA.batchId],
      [memberOf(sid.B), 'invite-batch-exported:2', byA.batchId],
      [memberOf(sid.A), 'invite-batch-exported:2', old.batchId],
      [memberOf(sid.owner), 'invite-codes-viewed:2', byOwner.batchId],
    ],
  );
  const everything = JSON.stringify(f.store.all('SELECT * FROM web_admin_audit'));
  for (const plain of [...byA.codes!, ...byOwner.codes!, ...old.codes!])
    assert.equal(everything.includes(plain), false, 'no code in the audit');
});

test('a redeemed and a revoked code read 已兑换 / 已撤销 in the export, with the 玩家编号 and the end of the entitlement in UTC', (t) => {
  const { f, sid, byA } = world(t);
  const batch = f.create(f.member(['invites.manage'], 'C'), {
    name: 'C',
    count: 3,
    durationDays: 30,
    tier: { kind: 'unlimited' },
  });
  const ann = f.player('ann', { signedUp: true });
  f.redeem(ann, batch.codes![0]!);
  const detail = f.tiers.batchDetail(sid.owner, batch.batchId).codes;
  f.tiers.revokeCode(sid.owner, detail[1]!.id);
  const csv = f.tiers
    .exportBatch(sid.owner, batch.batchId)
    .csv.replace(/^\uFEFF/, '')
    .trimEnd()
    .split('\r\n')
    .slice(1);
  const redeemed = csv[0]!.split(',');
  assert.deepEqual([redeemed[0], redeemed[1], redeemed[2]], ['1', batch.codes![0]!, '已兑换']);
  assert.match(redeemed[3]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.match(redeemed[4]!, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  assert.match(redeemed[5]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
  assert.equal(csv[1]!.split(',')[2], '已撤销');
  assert.equal(csv[2]!.split(',')[2], '未使用');
  // Ending the entitlement reads 已撤销 too.
  f.tiers.revokeEntitlement(sid.owner, detail[0]!.id);
  assert.equal(f.tiers.exportBatch(sid.owner, batch.batchId).csv.includes(',已撤销,'), true);
  assert.ok(byA);
});

test('csvCell: a cell a spreadsheet could read as a formula is kept as text, quotes and commas are escaped', () => {
  assert.equal(csvCell('abc'), 'abc');
  assert.equal(csvCell('-abcDEF'), '"\t-abcDEF"', 'a code can begin with "-"');
  assert.equal(csvCell('=1+1'), '"\t=1+1"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  const csv = inviteCodesCsv([
    {
      id: 'x',
      serial: 1,
      state: 'unused',
      redeemedAt: null,
      expiresAt: null,
      playerNumber: null,
      code: '-'.repeat(43),
      codeView: 'plain',
    },
  ]);
  assert.equal(csv.split('\r\n')[1], `1,"\t${'-'.repeat(43)}",未使用,,,`);
});
