import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { localRuntime } from '../../cloudflare/runtime.ts';
import { csvCell, inviteCodesCsv } from '../../../apps/server/invites/web-invite-export.ts';
import type { BatchCodeView } from '../../../apps/server/invites/web-invite-tiers.ts';

const API = '/api/web/provider',
  origin = 'https://fixture.invalid';
const PASSWORD = 'correct horse battery';
type Client = { cookie: string; csrf: string; peer: string };
type Mail = { to: string; purpose: string; kind: 'code' | 'registered'; code: string | null };
type Row = {
  id: string;
  serial: number;
  state: string;
  redeemedAt: number | null;
  expiresAt: number | null;
  playerNumber: string | null;
  code: string | null;
  codeView: 'plain' | 'masked' | 'legacy';
};
let peers = 0;
const client = (): Client => ({ cookie: '', csrf: '', peer: `10.23.0.${++peers}` });
const a = (path: string) => `${API}/account${path}`;
const MASK = '********';
const LEGACY = '旧邀请码无法再次查看';

/**
 * Part 22a2, the old-and-new test. ONE real-HTTP workerd database holding a batch made BEFORE migration 127 (a digest, nothing
 * sealed), a batch made after it by the owner and a batch made after it by an administrator with invites.manage. Each is viewed as
 * the owner, as that administrator and as a second administrator, in the detail view AND in the CSV; a code of each still redeems
 * and revoking still ends access.
 */
function setup(t: test.TestContext) {
  const runtime = localRuntime(
    t,
    'tests/web/fixtures/cloudflare-cross-path-worker.ts',
    { STATE: 'WebCrossPathFixture' },
    ['MEDIA'],
    [],
    ['enable_request_signal'],
  );
  const texts: string[] = [];
  const call = async (path: string, actor: Client, body?: unknown, status = 200) => {
    const response = await runtime.request(origin + path, {
      headers: {
        ...(actor.cookie ? { cookie: actor.cookie } : {}),
        ...(body === undefined ? {} : { origin, 'content-type': 'application/json', 'x-csrf-token': actor.csrf }),
        'x-fixture-peer': actor.peer,
        'x-fixture-host': 'fixture.invalid',
      },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
    const text = await response.text();
    texts.push(text);
    assert.equal(response.status, status, text);
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) actor.cookie = setCookie.includes('Max-Age=0') ? '' : setCookie.split(';')[0]!;
    const result = JSON.parse(text);
    if (typeof result.csrf === 'string') actor.csrf = result.csrf;
    return result;
  };
  const signUp = async (actor: Client, email: string) => {
    const before = (await runtime.call<Mail[]>('/fixture/player-mail')).length;
    const challenge = await call(a('/request-code'), actor, { purpose: 'signup', email });
    let mail: Mail | undefined;
    for (let i = 0; i < 100 && !mail; i++) {
      const list = await runtime.call<Mail[]>('/fixture/player-mail');
      if (list.length > before) mail = list.at(-1);
      else await sleep(20);
    }
    await call(a('/verify-code'), actor, { challengeId: challenge.challengeId, code: mail!.code });
    return call(a('/signup'), actor, { challengeId: challenge.challengeId, password: PASSWORD, nickname: '阿泡' });
  };
  return { ...runtime, call, signUp, texts, fixture: runtime.call };
}

const csvRows = (csv: string) => {
  assert.equal(csv.charCodeAt(0), 0xfeff, 'the CSV starts with a UTF-8 BOM');
  const lines = csv.slice(1).trimEnd().split('\r\n');
  assert.equal(lines[0], '序号,邀请码,状态,兑换时间 (UTC),玩家编号,额度到期');
  return lines.slice(1).map((line) => line.split(','));
};

test('22a2 old and new together over real HTTP: owner / creating administrator / second administrator, detail AND CSV, per cell', async (t) => {
  const f = setup(t);
  await f.fixture('/fixture/assets');
  await f.fixture('/fixture/players', { signupEnabled: true });
  const owner = client(),
    adminA = client(),
    adminB = client();
  await f.call(`${API}/admin/login`, owner, { token: (await f.fixture<{ token: string }>('/fixture/grant')).token });
  for (const [actor, label] of [
    [adminA, 'A'],
    [adminB, 'B'],
  ] as const) {
    const issued = await f.call(`${API}/admin/members/issue`, owner, {
      requestId: randomUUID(),
      label,
      memberId: null,
      permissions: ['invites.manage'],
    });
    await f.call(`${API}/admin/login`, actor, { token: issued.token });
  }
  const make = (by: Client, name: string) =>
    f.call(
      `${API}/admin/invites/batch-create`,
      by,
      {
        requestId: randomUUID(),
        name,
        count: 2,
        tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
        durationDays: 30,
        redeemBy: null,
      },
      201,
    ) as Promise<{ batchId: string; codes: string[] }>;

  // ---- the three batches ----
  const oldBatch = await make(adminA, '旧批次');
  await f.fixture('/fixture/cross/old-batch', { batchId: oldBatch.batchId }); // = created before migration 127
  const ownerBatch = await make(owner, '主管理员批次');
  const aBatch = await make(adminA, '管理员A批次');
  const batches = { old: oldBatch, owner: ownerBatch, A: aBatch } as const;

  // ---- one code of each is redeemed by a signed-up player ----
  const players: Record<string, { actor: Client; number: string; code: string }> = {};
  for (const key of ['old', 'owner', 'A'] as const) {
    const actor = client();
    await f.call(`${API}/bootstrap`, actor);
    await f.signUp(actor, `${key}.holder@example.com`);
    const code = batches[key].codes[0]!;
    const redeemed = await f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code }, 201);
    assert.equal(redeemed.entitlement.kind, 'daily_refill', `a code of the ${key} batch redeems`);
    players[key] = {
      actor,
      number: (await f.call(a(''), actor)).modelChoice ? (await f.call(a(''), actor)).playerNumber : '',
      code,
    };
    assert.equal((await f.call(a(''), actor)).modelChoice.plan.kind, 'daily_refill');
  }

  // ---- expected cell per viewer and batch ----
  const expected = (viewer: 'owner' | 'A' | 'B', key: 'old' | 'owner' | 'A', i: number) => {
    if (key === 'old') return { view: 'legacy', code: null, text: LEGACY };
    const plain = viewer === 'owner' || (viewer === 'A' && key === 'A');
    return plain
      ? { view: 'plain', code: batches[key].codes[i]!, text: batches[key].codes[i]! }
      : { view: 'masked', code: MASK, text: MASK };
  };
  const actors = { owner, A: adminA, B: adminB } as const;
  const first = async (viewer: keyof typeof actors, key: keyof typeof batches) => {
    const detail = await f.call(`${API}/admin/invites/batch-detail`, actors[viewer], { batchId: batches[key].batchId });
    const exported = await f.call(`${API}/admin/invites/batch-export`, actors[viewer], {
      batchId: batches[key].batchId,
    });
    return { detail, exported };
  };
  const seenByB: string[] = [];
  for (const viewer of ['owner', 'A', 'B'] as const)
    for (const key of ['old', 'owner', 'A'] as const) {
      const { detail, exported } = await first(viewer, key);
      const rows = detail.codes as Row[];
      assert.equal(rows.length, 2);
      const table = csvRows(exported.csv as string);
      assert.equal(exported.rows, 2);
      rows.forEach((row, i) => {
        const want = expected(viewer, key, i);
        // The detail view: per cell.
        assert.deepEqual([row.codeView, row.code], [want.view, want.code], `${viewer} sees the ${key} batch #${i + 1}`);
        // The CSV: the same cell, the same rule.
        assert.equal(table[i]![0], String(i + 1));
        // Named fix of a flaky test (Part 26a fix): codes are random base64url, so one in 64 starts with '-' and the exporter writes
        // it formula-safe (a leading TAB, then quoted). The expectation applies the exporter's own rule (csvCell), not the raw code.
        assert.equal(table[i]![1], csvCell(want.text), `${viewer}'s CSV of the ${key} batch #${i + 1}`);
        // Redeemed vs unused.
        assert.equal(row.state, i === 0 ? 'redeemed' : 'unused');
        assert.equal(table[i]![2], i === 0 ? '已兑换' : '未使用');
        if (i === 0) {
          assert.match(table[i]![3]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
          assert.equal(table[i]![4], row.playerNumber);
          assert.match(table[i]![5]!, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/);
        } else assert.deepEqual(table[i]!.slice(3), ['', '', '']);
      });
      if (viewer === 'B') seenByB.push(JSON.stringify([detail, exported]));
    }
  // The server never sent B a plain code of a batch B may not read - in either view.
  for (const text of seenByB)
    for (const key of ['old', 'owner', 'A'] as const)
      for (const code of batches[key].codes) assert.equal(text.includes(code), false, 'a masked cell carries no code');
  // Listing is open to any invites.manage administrator: name, tier, N / cap, count, redeemed.
  const listed = (await f.call(`${API}/admin/invites/batch-list`, adminB, {})).batches as Record<string, unknown>[];
  const mine = listed.find((b) => b.id === aBatch.batchId)!;
  assert.deepEqual(
    [mine.name, mine.tier, mine.dailyAmount, mine.cap, mine.codes, mine.redeemed],
    ['管理员A批次', 'daily_refill', 50, 1000, 2, 1],
  );

  // ---- redeeming a second code of each batch still works; the first is already taken ----
  for (const key of ['old', 'owner', 'A'] as const) {
    const actor = client();
    await f.call(`${API}/bootstrap`, actor);
    await f.signUp(actor, `${key}.second@example.com`);
    assert.equal(
      (await f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code: batches[key].codes[1]! }, 201))
        .entitlement.kind,
      'daily_refill',
    );
    assert.equal(
      (await f.call(`${API}/invites/redeem`, actor, { requestId: randomUUID(), code: batches[key].codes[0]! }, 409))
        .error.code,
      'WEB_INVITE_UNAVAILABLE',
      'a redeemed code cannot be used twice',
    );
  }

  // ---- revoking ends access, for the old batch and the new ones ----
  for (const key of ['old', 'owner', 'A'] as const) {
    const rows = (await first('owner', key)).detail.codes as Row[];
    await f.call(`${API}/admin/invites/entitlement-revoke`, owner, { id: rows[0]!.id });
    const info = await f.call(a(''), players[key]!.actor);
    assert.equal(info.modelChoice.plan, undefined, `revoking a code of the ${key} batch ends the plan`);
    const after = await first('owner', key);
    assert.equal((after.detail.codes as Row[])[0]!.state, 'ended');
    assert.equal(csvRows(after.exported.csv)[0]![2], '已撤销');
  }
  // An unused code of a batch can be revoked too, and reads 已撤销.
  const unused = ((await first('A', 'A')).detail.codes as Row[]).find((row) => row.state === 'unused');
  if (unused) {
    await f.call(`${API}/admin/invites/tier-code-revoke`, adminA, { id: unused.id });
    assert.equal(
      csvRows((await first('A', 'A')).exported.csv).some((r) => r[2] === '已撤销'),
      true,
    );
  }

  // ---- the audit: administrator, batch and a row count - never a code ----
  const audit =
    await f.fixture<{ actor_id: string; action: string; target_id: string }[]>('/fixture/cross/invite-audit');
  const kinds = new Set(audit.map((row) => row.action.split(':')[0]));
  assert.ok(kinds.has('invite-batch-exported') && kinds.has('invite-codes-viewed'), [...kinds].join());
  assert.ok(
    audit.filter((row) => row.action === 'invite-batch-exported:2').length >= 9,
    'every export is logged with its row count',
  );
  const everything = JSON.stringify(audit);
  for (const key of ['old', 'owner', 'A'] as const)
    for (const code of batches[key].codes) assert.equal(everything.includes(code), false, 'no code in the audit');
  // B only ever exported: B's views were all masked / legacy, so none of B's calls is a 'viewed' entry.
  const members = new Set(
    audit.filter((row) => row.action.startsWith('invite-codes-viewed')).map((row) => row.actor_id),
  );
  assert.equal(
    members.size,
    2,
    'the owner and the creating administrator viewed plain codes; the second administrator did not',
  );
  // The CSV is a text the browser saves as UTF-8: the BOM encodes to EF BB BF.
  const { exported } = await first('owner', 'A');
  assert.equal(
    Buffer.from(exported.csv as string)
      .subarray(0, 3)
      .toString('hex'),
    'efbbbf',
  );
});

test('22a2 (named fix of a flaky test) a code that starts with "-" is exported formula-safe, every time', () => {
  const row = (code: string, serial: number) =>
    ({
      serial,
      code,
      codeView: 'plain',
      state: 'unused',
      redeemedAt: null,
      expiresAt: null,
      playerNumber: null,
    }) as unknown as BatchCodeView;
  const csv = inviteCodesCsv([row('-abcDEF_123', 1), row('=cmd', 2), row('plainCode', 3)]);
  const table = csvRows(csv);
  assert.equal(table[0]![1], '"\t-abcDEF_123"');
  assert.equal(table[0]![1], csvCell('-abcDEF_123'));
  assert.equal(table[1]![1], '"\t=cmd"');
  assert.equal(table[2]![1], 'plainCode', 'an ordinary code is written as it is');
});
