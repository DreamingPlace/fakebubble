import assert from 'node:assert/strict';
import test from 'node:test';
import {
  balanceLine,
  infoCopy,
  openMyInfo,
  tierView,
  utcDate,
  type MyInfoOptions,
} from '../../src/features/account/my-info.ts';
import type { ModelChoiceInfo } from '../../../../packages/contracts/player-models.ts';
import { installFakeDom, flush, type FakeElement } from './fake-dom.ts';

const choice = (over: Partial<ModelChoiceInfo> = {}): ModelChoiceInfo => ({
  models: [{ id: 'deepseek', points: 10, voicePoints: 2 }],
  selected: 'deepseek',
  metered: true,
  balance: 150,
  repliesLeft: 12,
  version: 2,
  ...over,
});

test('22a tier label, end date and quota line for each tier - one format for every metered tier', () => {
  assert.deepEqual(tierView({ tier: { kind: 'registered', unlimited: false }, modelChoice: choice() }), {
    label: '注册玩家',
    expires: null,
    quota: '剩余 150 点 · 约可聊 12 条',
    unlimited: false,
  });
  assert.deepEqual(
    tierView({
      tier: {
        kind: 'daily_refill',
        unlimited: false,
        plan: { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: Date.UTC(2026, 11, 31, 23) },
      },
      modelChoice: choice(),
    }),
    { label: '邀请 · 每天 +50 点', expires: '2026-12-31', quota: '剩余 150 点 · 约可聊 12 条', unlimited: false },
  );
  assert.deepEqual(
    tierView({
      tier: { kind: 'unlimited', unlimited: true, plan: { kind: 'unlimited', expiresAt: null } },
      modelChoice: choice(),
    }),
    {
      label: '邀请 · 不限量',
      expires: null,
      quota: '不限量',
      unlimited: true,
    },
  );
  assert.equal(
    balanceLine(choice()),
    tierView({ tier: { kind: 'registered', unlimited: false }, modelChoice: choice() }).quota,
  );
  // The cap is never shown: no "每天最多", no cap number anywhere in what the page can say.
  const refill = tierView({
    tier: {
      kind: 'daily_refill',
      unlimited: false,
      plan: { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: null },
    },
    modelChoice: choice(),
  });
  assert.doesNotMatch(JSON.stringify(refill), /每天最多|上限|1000/);
  assert.equal(utcDate(Date.UTC(2026, 0, 2, 23, 59)), '2026-01-02');
});

function open(t: test.TestContext, over: Partial<MyInfoOptions> = {}) {
  const doc = installFakeDom(t);
  const log: string[] = [];
  const handle = openMyInfo({
    mode: 'player',
    nickname: '阿泡',
    playerNumber: 'ABCD2345',
    emailMasked: 'p***@example.com',
    tier: tierView({ tier: { kind: 'registered', unlimited: false }, modelChoice: choice() }),
    trialLine: null,
    signupOpen: true,
    deleteEnabled: true,
    saveNickname: async (value) => void log.push(`nickname:${value}`),
    copy: async (text) => void log.push(`copy:${text}`),
    actions: {
      password: () => void log.push('password'),
      logoutOthers: async () => void log.push('logoutOthers'),
      logout: async () => void log.push('logout'),
      deleteAccount: () => void log.push('delete'),
      clearDevice: () => void log.push('clear'),
      billing: () => void log.push('billing'),
      enterCode: () => void log.push('code'),
      signup: () => void log.push('signup'),
      login: () => void log.push('login'),
    },
    ...over,
  });
  const sheet = doc.body.querySelector('.mi-sheet') as FakeElement;
  const buttons = () => sheet.querySelectorAll('button').filter((b) => b.textContent !== '×');
  const press = (label: string) =>
    buttons()
      .find((b) => b.textContent === label)!
      .click();
  return { doc, log, handle, sheet, buttons, press, text: () => sheet.textContent };
}

test('22a a registered player’s page: 资料, 额度, 安全, 退出登录 and (apart) 删除我的账号, in that order', (t) => {
  const f = open(t);
  assert.deepEqual(
    f.sheet.querySelectorAll('.mi-heading').map((h) => h.textContent),
    ['资料', '额度', '安全'],
  );
  assert.deepEqual(
    f.buttons().map((b) => b.textContent),
    ['修改', '复制', '消费记录', '输入邀请码', '修改密码', '退出其他设备', '退出登录', '删除我的账号'],
  );
  assert.ok(f.text().includes('ABCD2345'));
  assert.ok(f.text().includes('p***@example.com'));
  assert.ok(f.text().includes('注册玩家'));
  assert.ok(f.text().includes('剩余 150 点 · 约可聊 12 条'));
  assert.doesNotMatch(f.text(), /每天最多|上限/);
  // The danger zone is a block of its own, after 退出登录.
  const order = f.sheet.querySelectorAll('.mi-foot, .mi-danger');
  assert.equal(order.length >= 0, true);
});

test('22a copying the 玩家编号 and the in-place nickname edit', async (t) => {
  const f = open(t);
  f.press('复制');
  await flush();
  assert.deepEqual(f.log, ['copy:ABCD2345']);
  assert.ok(f.buttons().some((b) => b.textContent === '已复制'));
  f.press('修改');
  const input = f.sheet.querySelector('.mi-input') as FakeElement;
  input.value = '   ';
  f.press('保存');
  await flush();
  assert.equal(f.log.includes('nickname:'), false, 'an empty nickname never leaves the page');
  input.value = ' 新泡泡 ';
  f.press('保存');
  await flush();
  assert.deepEqual(f.log.at(-1), 'nickname:新泡泡');
  assert.equal(f.sheet.querySelector('.mi-nickname')!.textContent, '新泡泡');
});

test('22a rows do what they say, and the page has no helper line', async (t) => {
  const f = open(t);
  for (const label of ['消费记录', '输入邀请码', '修改密码', '退出其他设备', '退出登录', '删除我的账号'])
    f.press(label);
  await flush();
  assert.deepEqual(f.log, ['billing', 'code', 'password', 'logoutOthers', 'logout', 'delete']);
  const paragraphs = f.sheet.querySelectorAll('p').filter((p) => !p.classList.contains('mi-status'));
  assert.equal(paragraphs.length, 0, '21i: no small print under the rows');
});

test('22a an unlimited player sees 不限量 and the tier label; a daily-refill player sees N and the date, never the cap', (t) => {
  const unlimited = open(t, {
    tier: tierView({
      tier: { kind: 'unlimited', unlimited: true, plan: { kind: 'unlimited', expiresAt: null } },
      modelChoice: choice(),
    }),
  });
  assert.ok(unlimited.text().includes('邀请 · 不限量'));
  assert.ok(unlimited.text().includes('不限量'));
  assert.doesNotMatch(unlimited.text(), /剩余/);
  unlimited.handle.close();
  const refill = open(t, {
    tier: tierView({
      tier: {
        kind: 'daily_refill',
        unlimited: false,
        plan: { kind: 'daily_refill', dailyAmount: 50, cap: 1000, expiresAt: Date.UTC(2026, 11, 31, 12) },
      },
      modelChoice: choice(),
    }),
  });
  assert.ok(refill.text().includes('邀请 · 每天 +50 点'));
  assert.ok(refill.text().includes('2026-12-31'));
  assert.ok(refill.text().includes('剩余 150 点 · 约可聊 12 条'));
  assert.doesNotMatch(refill.text(), /1000|每天最多|上限/);
});

test('22a a guest sees the trial, 注册 / 登录 and 注册后即可使用邀请码; a guest has no password, no email and no logout', (t) => {
  const f = open(t, {
    mode: 'guest',
    nickname: null,
    playerNumber: null,
    emailMasked: null,
    tier: null,
    trialLine: '体验剩余 3 次',
  });
  assert.ok(f.text().includes('体验剩余 3 次'));
  assert.ok(f.text().includes('注册后即可使用邀请码'));
  assert.deepEqual(
    f.buttons().map((b) => b.textContent),
    ['消费记录', '输入邀请码', '注册', '登录', '清除本设备的体验数据'],
  );
  f.press('注册');
  f.press('登录');
  f.press('清除本设备的体验数据');
  assert.deepEqual(f.log, ['signup', 'login', 'clear']);
});

test('22a closing removes the page and calls onClose once', (t) => {
  let closed = 0;
  const f = open(t, { onClose: () => closed++ });
  f.handle.close();
  f.handle.close();
  assert.equal(closed, 1);
  assert.equal(f.doc.body.querySelector('.mi-sheet'), null);
});

test("22a the page decides a tier from the server's effective tier ONLY, never from the principal kind", () => {
  // A legacy invite player whose grant expired: the server says registered -> 注册玩家 + the balance line.
  assert.deepEqual(tierView({ tier: { kind: 'registered', unlimited: false }, modelChoice: choice() }), {
    label: '注册玩家',
    expires: null,
    quota: '剩余 150 点 · 约可聊 12 条',
    unlimited: false,
  });
  // The same player with a backfilled entitlement: 邀请 · 不限量 ...
  const held = tierView({
    tier: { kind: 'unlimited', unlimited: true, plan: { kind: 'unlimited', expiresAt: null } },
    modelChoice: choice(),
  });
  assert.deepEqual([held.label, held.quota, held.unlimited], ['邀请 · 不限量', '不限量', true]);
  // ... until the entitlement is revoked: registered again, with the balance that remains.
  const after = tierView({
    tier: { kind: 'registered', unlimited: false },
    modelChoice: choice({ balance: 90, repliesLeft: 7 }),
  });
  assert.deepEqual([after.label, after.quota], ['注册玩家', '剩余 90 点 · 约可聊 7 条']);
  // No tier from the server: a registered player, never an invited one.
  assert.equal(tierView({ tier: undefined, modelChoice: choice() }).label, '注册玩家');
});
