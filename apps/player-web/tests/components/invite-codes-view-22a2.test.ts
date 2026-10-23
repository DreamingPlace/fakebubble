import assert from 'node:assert/strict';
import test from 'node:test';
import { inviteTiersView, type InviteTiersDeps } from '../../src/features/admin/invite-tiers-view.ts';
import type { InviteBatch, InviteBatchCode } from '../../src/services/account-admin-api.ts';
import { installFakeDom, type FakeElement } from './fake-dom.ts';

// Part 22a2: the batch detail shows what the SERVER sent - plain (with its own 复制), ******** or 旧邀请码无法再次查看 - and
// 导出表格 downloads the server's CSV as it came (the BOM included). The page never decides who may see a code.
const batch: InviteBatch = {
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
  holders: 1,
};
const PLAIN = 'A'.repeat(43);
const row = (over: Partial<InviteBatchCode>): InviteBatchCode => ({
  id: 'c',
  serial: 1,
  state: 'unused',
  redeemedAt: null,
  expiresAt: null,
  playerNumber: null,
  ...over,
});

function mount(t: test.TestContext, rows: InviteBatchCode[], o: { copyFails?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const copied: string[] = [];
  const toasts: string[] = [];
  const downloads: { filename: string; text: string }[] = [];
  const exports: string[] = [];
  const deps: InviteTiersDeps = {
    port: {
      inviteBatches: async () => [batch],
      inviteBatchDetail: async () => rows,
      exportInviteBatch: async (id) => {
        exports.push(id);
        return { csv: '﻿序号,邀请码\r\n1,********\r\n', rows: 1 };
      },
    },
    isOwner: () => false,
    run: async (work) => {
      try {
        await work();
      } catch {
        /* shown by the page */
      }
    },
    confirm: async () => true,
    toast: (text) => void toasts.push(text),
    newRequestId: () => 'req',
    disposed: () => false,
    download: (filename, text) => void downloads.push({ filename, text }),
    copy: async (text) => {
      if (o.copyFails) throw new Error('denied');
      copied.push(text);
    },
  };
  const view = inviteTiersView(root, deps);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const open = async () => {
    await view.load();
    node
      .querySelectorAll('button')
      .find((b) => b.textContent === '查看')!
      .click();
    await tick();
  };
  return { node, copied, toasts, downloads, exports, open, tick };
}
const tableRows = (f: ReturnType<typeof mount>) => f.node.querySelectorAll('.tiers-codes-table tbody tr');

test('the detail columns are 序号, 邀请码, 状态, 兑换时间 (UTC), 玩家编号, 额度到期', async (t) => {
  const f = mount(t, [row({})]);
  await f.open();
  assert.deepEqual(
    f.node.querySelectorAll('.tiers-codes-table thead th').map((th) => th.textContent),
    ['序号', '邀请码', '状态', '兑换时间 (UTC)', '玩家编号', '额度到期', '操作'],
  );
});

test('a plain code is shown with its own 复制 button that copies exactly that code', async (t) => {
  const other = 'B'.repeat(43);
  const f = mount(t, [
    row({ id: 'c1', serial: 1, code: PLAIN, codeView: 'plain' }),
    row({ id: 'c2', serial: 2, code: other, codeView: 'plain' }),
  ]);
  await f.open();
  const rows = tableRows(f);
  assert.match(rows[0]!.textContent, new RegExp(PLAIN));
  const copyButtons = rows.map((r) => r.querySelectorAll('button').find((b) => b.textContent === '复制')!);
  assert.equal(copyButtons.every(Boolean), true, 'every visible code has a 复制 button');
  copyButtons[1]!.click();
  await f.tick();
  assert.deepEqual(f.copied, [other]);
  assert.deepEqual(f.toasts, ['已复制']);
});

test('a masked code shows ******** and has no 复制 button; the page says why; the code is not in the page at all', async (t) => {
  const f = mount(t, [
    row({ code: '********', codeView: 'masked' }),
    row({ id: 'c2', serial: 2, code: '********', codeView: 'masked' }),
  ]);
  await f.open();
  const rows = tableRows(f);
  assert.match(rows[0]!.textContent, /\*{8}/);
  assert.equal(
    rows.some((r) => r.querySelectorAll('button').some((b) => b.textContent === '复制')),
    false,
  );
  assert.match(f.node.textContent, /其他管理员创建/);
  assert.equal(f.node.textContent.includes(PLAIN), false);
});

test('a code made before codes were kept reads 旧邀请码无法再次查看, with or without the new fields', async (t) => {
  const f = mount(t, [row({ codeView: 'legacy', code: null }), row({ id: 'c2', serial: 2 })]);
  await f.open();
  for (const r of tableRows(f)) {
    assert.match(r.textContent, /旧邀请码无法再次查看/);
    assert.equal(
      r.querySelectorAll('button').some((b) => b.textContent === '复制'),
      false,
    );
  }
});

test('状态 reads 未使用 / 已兑换 / 已撤销 and the time columns are UTC', async (t) => {
  const f = mount(t, [
    row({ id: 'c1', serial: 1, state: 'unused' }),
    row({
      id: 'c2',
      serial: 2,
      state: 'redeemed',
      redeemedAt: Date.UTC(2026, 9, 2, 8, 5, 9),
      expiresAt: Date.UTC(2026, 10, 1, 8, 5, 9),
      playerNumber: 'K7M2P9QX',
    }),
    row({ id: 'c3', serial: 3, state: 'revoked' }),
    row({ id: 'c4', serial: 4, state: 'ended', redeemedAt: Date.UTC(2026, 9, 2), playerNumber: 'K7M2P9QY' }),
  ]);
  await f.open();
  const rows = tableRows(f);
  const text = rows.map((r) => r.textContent);
  assert.match(text[0]!, /未使用/);
  assert.match(text[1]!, /已兑换/);
  assert.match(text[1]!, /2026-10-02 08:05:09/);
  assert.match(text[1]!, /K7M2P9QX/);
  assert.match(text[1]!, /2026-11-01 08:05:09/);
  assert.match(text[2]!, /已撤销/);
  assert.match(text[3]!, /已撤销/);
});

test('导出表格 asks the server for the table and saves its text unchanged (the BOM included)', async (t) => {
  const f = mount(t, [row({ code: '********', codeView: 'masked' })]);
  await f.open();
  f.node
    .querySelectorAll('button')
    .find((b) => b.textContent === '导出表格')!
    .click();
  await f.tick();
  assert.deepEqual(f.exports, ['b1']);
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0]!.filename, '春季内测-邀请码.csv');
  assert.equal(f.downloads[0]!.text.charCodeAt(0), 0xfeff);
  assert.equal(f.downloads[0]!.text, '﻿序号,邀请码\r\n1,********\r\n');
});

test('a refused clipboard is told, not silent', async (t) => {
  const f = mount(t, [row({ code: PLAIN, codeView: 'plain' })], { copyFails: true });
  await f.open();
  tableRows(f)[0]!
    .querySelectorAll('button')
    .find((b) => b.textContent === '复制')!
    .click();
  await f.tick();
  assert.deepEqual(f.copied, []);
  assert.match(f.toasts.at(-1)!, /复制没有成功/);
});

test('the create result keeps the codes on screen with 复制 and 下载 CSV, and says they can be viewed again', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const copied: string[] = [];
  const view = inviteTiersView(root, {
    port: {
      inviteBatches: async () => [],
      createInviteBatch: async (input) => ({
        batchId: 'b9',
        duplicate: false,
        codes: Array.from({ length: input.count }, (_, i) => `${i}`.repeat(43)),
      }),
    },
    isOwner: () => true,
    run: async (work) => work(),
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'req',
    disposed: () => false,
    download: () => {},
    copy: async (text) => void copied.push(text),
  });
  await view.load();
  (node.querySelector('#tiers-name') as FakeElement).value = '夏季';
  (node.querySelector('#tiers-count') as FakeElement).value = '2';
  (node.querySelector('#admin-tiers-create') as FakeElement).dispatch('submit');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal((node.querySelector('#tiers-shown') as FakeElement).hidden, false);
  assert.match(node.querySelector('#tiers-shown')!.textContent, /之后可在批次的“查看”里再次查看/);
  (node.querySelector('#tiers-copy') as FakeElement).click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(copied, [`${'0'.repeat(43)}\n${'1'.repeat(43)}`]);
});
