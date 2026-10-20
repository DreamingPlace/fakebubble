import assert from 'node:assert/strict';
import test from 'node:test';
import {
  codesCsv,
  editConfirmation,
  inviteTiersView,
  tierText,
  TIER_FORM,
  type InviteTiersDeps,
} from '../../src/features/admin/invite-tiers-view.ts';
import type { InviteBatch, InviteBatchCode } from '../../src/services/account-admin-api.ts';
import { installFakeDom, flush, type FakeElement } from './fake-dom.ts';

const batch = (over: Partial<InviteBatch> = {}): InviteBatch => ({
  id: 'b1',
  name: '春季内测',
  tier: 'daily_refill',
  dailyAmount: 50,
  cap: 1000,
  durationDays: 30,
  redeemBy: null,
  createdAt: Date.UTC(2026, 9, 1),
  codes: 3,
  redeemed: 1,
  revoked: 0,
  holders: 4,
  ...over,
});
const codes = (): InviteBatchCode[] => [
  {
    id: 'c1',
    serial: 1,
    state: 'redeemed',
    redeemedAt: Date.UTC(2026, 9, 2, 8, 5),
    expiresAt: Date.UTC(2026, 10, 1),
    playerNumber: 'K7M2P9QX',
  },
  { id: 'c2', serial: 2, state: 'unused', redeemedAt: null, expiresAt: null, playerNumber: null },
  { id: 'c3', serial: 3, state: 'revoked', redeemedAt: null, expiresAt: null, playerNumber: null },
];

function mount(t: test.TestContext, o: { owner?: boolean; confirm?: boolean; failCreate?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const calls: string[] = [];
  const created: unknown[] = [];
  const edits: unknown[] = [];
  const confirms: { title: string; message: string }[] = [];
  const downloads: { filename: string; text: string }[] = [];
  let ids = 0,
    failNext = o.failCreate === true;
  let list = [batch()];
  const deps: InviteTiersDeps = {
    port: {
      inviteBatches: async () => list,
      inviteBatchDetail: async () => codes(),
      createInviteBatch: async (input) => {
        created.push(input);
        if (failNext) {
          failNext = false;
          throw new Error('network');
        }
        list = [batch({ id: 'b2', name: input.name, codes: input.count, redeemed: 0, holders: 0 }), ...list];
        return {
          batchId: 'b2',
          duplicate: false,
          codes: Array.from({ length: input.count }, (_, i) => `CODE${i}`.padEnd(43, 'x')),
        };
      },
      editInviteBatch: async (input) => void edits.push(input),
      revokeInviteBatch: async (id) => void calls.push(`batch:${id}`),
      revokeTierCode: async (id) => void calls.push(`code:${id}`),
      revokeEntitlement: async (id) => void calls.push(`entitlement:${id}`),
    },
    isOwner: () => o.owner !== false,
    run: async (work) => {
      try {
        await work();
      } catch {
        /* the page shows the message */
      }
    },
    confirm: async (options) => {
      confirms.push(options);
      return o.confirm !== false;
    },
    toast: () => {},
    newRequestId: () => `req-${++ids}`,
    disposed: () => false,
    download: (filename, text) => void downloads.push({ filename, text }),
  };
  const view = inviteTiersView(root, deps);
  const q = (selector: string) => node.querySelector(selector) as FakeElement;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const find = (label: string) => node.querySelectorAll('button').find((b) => b.textContent === label)!;
  return {
    view,
    node,
    calls,
    created,
    edits,
    confirms,
    downloads,
    q,
    tick,
    find,
    setList: (next: InviteBatch[]) => (list = next),
  };
}

test('22a the form defaults to 每天补充 50 / 上限 1000 and creates with one request id, shows the codes once and clears them', async (t) => {
  const f = mount(t);
  await f.view.load();
  assert.equal(f.q('#tiers-amount').value, String(TIER_FORM.defaultAmount));
  assert.equal(f.q('#tiers-cap').value, String(TIER_FORM.defaultCap));
  f.q('#tiers-name').value = '夏季';
  f.q('#tiers-count').value = '2';
  f.q('#admin-tiers-create').dispatch('submit');
  await f.tick();
  assert.deepEqual(f.created, [
    {
      requestId: 'req-1',
      name: '夏季',
      count: 2,
      tier: { kind: 'daily_refill', dailyAmount: 50, cap: 1000 },
      durationDays: null,
      redeemBy: null,
    },
  ]);
  assert.equal(f.q('#tiers-shown').hidden, false);
  assert.equal(f.q('.tiers-codes').value.split('\n').length, 2);
  f.q('#tiers-download').click();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0]!.filename, '夏季.csv');
  assert.match(f.downloads[0]!.text, /^code\r\n/);
  // Codes only: a header and one code per line, nothing else.
  assert.equal(f.downloads[0]!.text.trim().split(/\r\n/).length, 3);
  f.q('#tiers-shown-close').click();
  assert.equal(f.q('#tiers-shown').hidden, true);
  assert.equal(f.q('.tiers-codes').value, '');
  // The new batch is in the list.
  assert.ok(f.node.querySelectorAll('tbody tr').some((tr) => tr.textContent.includes('夏季')));
});

test('22a the form checks what the server checks: name, 1-500 codes, cap not below the daily amount; unlimited needs no amounts', async (t) => {
  const f = mount(t);
  await f.view.load();
  const submit = async () => {
    f.q('#admin-tiers-create').dispatch('submit');
    await f.tick();
    return f.q('.tiers-problem').textContent;
  };
  assert.match(await submit(), /批次名称/);
  f.q('#tiers-name').value = 'x';
  f.q('#tiers-count').value = '501';
  assert.match(await submit(), /1–500/);
  f.q('#tiers-count').value = '3';
  f.q('#tiers-amount').value = '60';
  f.q('#tiers-cap').value = '50';
  assert.match(await submit(), /总上限/);
  assert.equal(f.created.length, 0);
  // (the in-memory DOM has no radio groups: switch both buttons)
  f.q('#tiers-kind-refill').checked = false;
  f.q('#tiers-kind-unlimited').checked = true;
  f.q('#tiers-kind-unlimited').dispatch('change');
  f.q('#tiers-duration').value = '7';
  f.q('#tiers-redeem-by').value = '2099-01-01';
  await submit();
  assert.deepEqual((f.created[0] as { tier: unknown; durationDays: number; redeemBy: number }).tier, {
    kind: 'unlimited',
  });
  assert.equal((f.created[0] as { durationDays: number }).durationDays, 7);
  assert.equal((f.created[0] as { redeemBy: number }).redeemBy, Date.parse('2099-01-01T23:59:59.999Z'));
});

test('22a a creation whose outcome was never seen is retried under the SAME request id', async (t) => {
  const f = mount(t, { failCreate: true });
  await f.view.load();
  f.q('#tiers-name').value = 'x';
  f.q('#admin-tiers-create').dispatch('submit');
  await f.tick();
  f.q('#admin-tiers-create').dispatch('submit');
  await f.tick();
  assert.deepEqual(
    f.created.map((c) => (c as { requestId: string }).requestId),
    ['req-1', 'req-1'],
  );
});

test('22a the list shows tier, N / cap, created, codes, redeemed, revoked and holders - counts only', async (t) => {
  const f = mount(t);
  await f.view.load();
  assert.deepEqual(
    f.node.querySelectorAll('thead th').map((th) => th.textContent),
    ['批次', '类型', '创建', '邀请码', '已兑换', '已撤销', '持有中', '操作'],
  );
  const row = f.node.querySelectorAll('tbody tr')[0]!;
  assert.match(row.textContent, /春季内测/);
  assert.match(row.textContent, /每天 \+50 点 · 上限 1000 点/);
  assert.match(row.textContent, /2026-10-01/);
  assert.equal(tierText(batch({ tier: 'unlimited', dailyAmount: null, cap: null })), '不限量');
});

test('22a the owner edits N and the cap behind a confirmation that names the change and the holders; nobody else sees the button', async (t) => {
  const f = mount(t);
  await f.view.load();
  f.find('修改额度').click();
  f.q('#tiers-edit-amount').value = '40';
  f.q('#tiers-edit-cap').value = '800';
  f.find('保存').click();
  await f.tick();
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /「春季内测」/);
  assert.match(f.confirms[0]!.message, /\+50 点 → \+40 点/);
  assert.match(f.confirms[0]!.message, /1000 点 → 800 点/);
  assert.match(f.confirms[0]!.message, /4 位玩家持有/);
  assert.match(f.confirms[0]!.message, /下一次每日补充/);
  assert.match(f.confirms[0]!.message, /不会收回/);
  assert.deepEqual(f.edits, [{ requestId: 'req-1', batchId: 'b1', dailyAmount: 40, cap: 800 }]);
  assert.equal(editConfirmation(batch(), 40, 800), f.confirms[0]!.message);
  const other = mount(t, { owner: false });
  await other.view.load();
  assert.equal(
    other.node.querySelectorAll('button').some((b) => b.textContent === '修改额度'),
    false,
  );
});

test('22a declining the owner’s confirmation changes nothing; a no-op or invalid edit never asks', async (t) => {
  const f = mount(t, { confirm: false });
  await f.view.load();
  f.find('修改额度').click();
  f.q('#tiers-edit-amount').value = '40';
  f.q('#tiers-edit-cap').value = '30';
  f.find('保存').click();
  await f.tick();
  assert.equal(f.confirms.length, 0, 'cap below the amount: no dialog');
  f.q('#tiers-edit-amount').value = '50';
  f.q('#tiers-edit-cap').value = '1000';
  f.find('保存').click();
  await f.tick();
  assert.equal(f.confirms.length, 0, 'no change: no dialog');
  f.q('#tiers-edit-amount').value = '40';
  f.q('#tiers-edit-cap').value = '800';
  f.find('保存').click();
  await f.tick();
  assert.equal(f.confirms.length, 1);
  assert.equal(f.edits.length, 0, 'declined');
});

test('22a codes by serial with the holder’s 玩家编号; every revoke asks first and does exactly what it says', async (t) => {
  const f = mount(t);
  await f.view.load();
  f.find('查看').click();
  await f.tick();
  const rows = f.node.querySelectorAll('.tiers-codes-table tbody tr');
  assert.equal(rows.length, 3);
  assert.match(rows[0]!.textContent, /#1/);
  assert.match(rows[0]!.textContent, /K7M2P9QX/);
  assert.match(rows[0]!.textContent, /2026-11-01/);
  assert.doesNotMatch(f.node.textContent, /@|principal|player-/);
  f.find('撤销该码').click();
  await f.tick();
  assert.equal(f.confirms.at(-1)!.title, '撤销邀请码');
  assert.deepEqual(f.calls, ['code:c2']);
  f.find('结束额度').click();
  await f.tick();
  assert.match(f.confirms.at(-1)!.message, /K7M2P9QX/);
  assert.deepEqual(f.calls, ['code:c2', 'entitlement:c1']);
  f.find('撤销整批').click();
  await f.tick();
  assert.equal(f.confirms.at(-1)!.title, '撤销整批');
  assert.match(f.confirms.at(-1)!.message, /还没兑换/);
  assert.deepEqual(f.calls.at(-1), 'batch:b1');
  assert.equal(f.confirms.length, 3);
  // Declined: nothing is sent.
  const declined = mount(t, { confirm: false });
  await declined.view.load();
  declined.find('撤销整批').click();
  await declined.tick();
  assert.deepEqual(declined.calls, []);
});

test('22a the CSV holds codes only', () => {
  assert.equal(codesCsv(['a', 'b']), 'code\r\na\r\nb\r\n');
});
