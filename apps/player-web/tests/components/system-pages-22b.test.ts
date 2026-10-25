import assert from 'node:assert/strict';
import test from 'node:test';
import { overviewView, warningLine } from '../../src/features/admin/overview-view.ts';
import { pointsView } from '../../src/features/admin/points-view.ts';
import { systemView } from '../../src/features/admin/system-view.ts';
import {
  canSeePage,
  firstAllowedPage,
  groupPages,
  navTree,
  visibleNav,
  type NavAccess,
} from '../../src/features/admin/shell/admin-nav.ts';
import type { SystemStatusView } from '../../src/services/account-admin-api.ts';
import type { PointsPreview, PointsResetResult } from '../../../../packages/contracts/web-system.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const none = { samples: 0, p50Ms: null, p95Ms: null };
const cache = { calls: 0, hitTokens: 0, missTokens: 0, hitRatio: null };
const status = (over: Partial<SystemStatusView> = {}): SystemStatusView => ({
  now: NOW,
  version: { commit: 'abc1234', migrationSteps: 51, schemaVersion: 126, matches: true },
  flags: {
    signupBonus: true,
    playerModelChoice: true,
    playerTextModels: ['deepseek', 'gemini'],
    fishVoiceModel: 's2.1-pro',
    chatReview: false,
    turnstile: true,
    alerts: true,
    alertMailBindingPresent: true,
    alertRecipientSet: true,
  },
  prices: [
    {
      provider: 'deepseek',
      model: 'deepseek-chat',
      phase: 'draft',
      unit: 'token',
      upperMicrosPerUnit: 2,
      version: 1,
      validUntil: NOW + 20 * DAY,
      state: 'in_force',
      daysLeft: 20,
      expiring: true,
    },
    {
      provider: 'fish',
      model: 's2.1-pro',
      phase: 'speech',
      unit: 'byte',
      upperMicrosPerUnit: 15,
      version: 3,
      validUntil: NOW + 80 * DAY,
      state: 'in_force',
      daysLeft: 80,
      expiring: false,
    },
  ],
  budget: {
    available: true,
    rows: [
      {
        provider: 'deepseek',
        policy: 'capped',
        spentMicros: 1_250_000,
        heldMicros: 250_000,
        allowanceMicros: 3_000_000,
        remainingMicros: 1_500_000,
      },
      {
        provider: 'fish',
        policy: 'unlimited',
        spentMicros: 400_000,
        heldMicros: 0,
        allowanceMicros: null,
        remainingMicros: null,
      },
    ],
  },
  unknown: [
    { kind: 'webProvider', count: 2, oldestAgeMs: 3 * 3_600_000 },
    { kind: 'external', count: 0, oldestAgeMs: null },
    { kind: 'embed', count: 0, oldestAgeMs: null },
  ],
  retention: {
    failing: 1,
    oldestAgeBucket: '1-7d',
    lastSuccessAt: NOW - 3_600_000,
    purging: 2,
    oldestPurgingMinutes: 5,
    failures: [
      {
        code: 'WEB_RETENTION_FAILED',
        phase: 'clearDatabase',
        sub: 'audit_source',
        errorName: 'Error',
        messageShape: 'not <tok>: <tok>',
        count: 3,
      },
    ],
  },
  metrics: [
    {
      day: '2026-10-21',
      operations: 4,
      textQueueWait: none,
      audioQueueWait: none,
      textStage: none,
      audioStage: none,
      rateLimitRetries: 0,
      fallbacks: 0,
      review: { samples: 0, changed: 0, rate: null },
      memoryDropped: { topics: 0, facts: 0 },
      cache: { draft: cache, review: cache },
      embedding: { calls: 0, texts: 0, failures: 0, unknowns: 0, queryFallbacks: 0, queryTimeouts: 0 },
    },
  ],
  security: { turnstile: true, failuresToday: 3, failuresLast7Days: 11, unavailableToday: 0, unavailableLast7Days: 1 },
  warnings: { priceExpiring: 1, retentionFailing: 1, unknownNew: 2 },
  ...over,
});

function mountSystem(t: test.TestContext, shown: SystemStatusView, o: { owner?: boolean; confirm?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const calls: unknown[][] = [];
  const confirms: { title: string; message: string }[] = [];
  let ids = 0,
    loads = 0;
  const api = systemView(root, {
    load: async () => {
      loads++;
      return shown;
    },
    renewPrices: async (requestId) => {
      calls.push(['renew', requestId]);
      return {
        duplicate: false,
        rows: [
          {
            provider: 'deepseek',
            model: 'deepseek-chat',
            phase: 'draft',
            result: 'renewed',
            validUntil: NOW + 110 * DAY,
            upperMicrosPerUnit: 2,
            version: 2,
          },
          {
            provider: 'fish',
            model: 's2.1-pro',
            phase: 'speech',
            result: 'not-due',
            validUntil: NOW + 80 * DAY,
            upperMicrosPerUnit: 15,
            version: 3,
          },
        ],
      };
    },
    topUp: async (input) => {
      calls.push(['topup', input]);
      return {
        provider: input.provider,
        addedMicros: input.dollars * 1_000_000,
        allowanceMicros: 8_000_000,
        remainingMicros: 6_500_000,
        duplicate: false,
      };
    },
    isOwner: () => o.owner !== false,
    run: async (work) => {
      await work();
    },
    confirm: async (options) => {
      confirms.push(options);
      return o.confirm !== false;
    },
    toast: () => {},
    newRequestId: () => `request-${++ids}`,
    disposed: () => false,
  });
  return { api, node, calls, confirms, loads: () => loads };
}

test('系统状态 shows version, switches, prices, budget, UNKNOWN, 清理, 安全 and 技术指标 from one call, and no identity', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  assert.equal(f.loads(), 1, 'one server call');
  const text = f.node.textContent;
  for (const wanted of [
    'abc1234',
    '51 步',
    'matches: true',
    '126',
    'SIGNUP_BONUS_ENABLED',
    'PLAYER_MODEL_CHOICE_ENABLED',
    'PLAYER_TEXT_MODELS',
    'deepseek、gemini',
    'FISH_VOICE_MODEL',
    's2.1-pro',
    'CHAT_REVIEW_ENABLED',
    'Turnstile',
    '告警邮件绑定',
    'deepseek / deepseek-chat / draft',
    '2 µ$ / 令牌',
    'v3',
    '2026-11-11',
    '20 天后到期',
    '$1.25',
    '$1.50',
    '不限额',
    '供应商调用',
    '3 小时',
    '清理失败',
    '1–7 天',
    '最近 7 天未通过',
    '技术指标',
    '2026-10-21',
  ])
    assert.ok(text.includes(wanted), `missing: ${wanted}`);
  assert.doesNotMatch(text, /@|principal|玩家编号/);
});

test('系统状态: a price within 60 days of expiry is highlighted; the others are not', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  const rows = f.node.querySelectorAll('tbody tr[data-expiring="true"]');
  assert.equal(rows.length, 1);
  assert.ok(rows[0]!.textContent.includes('deepseek-chat'));
});

test('系统状态: 续期价格 and 预算充值 exist for the owner only; an unlimited provider shows 不限额 and no button', async (t) => {
  const other = mountSystem(t, status(), { owner: false });
  await other.api.load();
  assert.equal(other.node.querySelector('#system-renew'), null);
  assert.equal(other.node.querySelectorAll('button[data-provider]').length, 0);
  const f = mountSystem(t, status());
  await f.api.load();
  assert.ok(f.node.querySelector('#system-renew'));
  const buttons = f.node.querySelectorAll('button[data-provider]');
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('data-provider')),
    ['deepseek'],
    'only the capped provider',
  );
});

test('续期价格 confirms first, runs once per request id and shows each row renewed / not-due with its new numbers', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  (f.node.querySelector('#system-renew') as FakeElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /renew-prices/);
  assert.deepEqual(f.calls, [['renew', 'request-1']]);
  const text = f.node.querySelector('.system-result')!.textContent;
  assert.ok(text.includes('已续期') && text.includes('未到期') && text.includes('v2') && text.includes('2 µ$'), text);
  // Declining sends nothing.
  const declined = mountSystem(t, status(), { confirm: false });
  await declined.api.load();
  (declined.node.querySelector('#system-renew') as FakeElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(declined.calls, []);
});

test('预算充值: the dialog names the provider, the amount and the new remaining; only $1–$50 whole dollars are sent', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  const input = f.node.querySelector('input[data-provider="deepseek"]') as FakeElement;
  const go = f.node.querySelector('button[data-provider="deepseek"]') as FakeElement;
  for (const bad of ['0', '51', '2.5', '']) {
    input.value = bad;
    go.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(f.confirms.length, 0, 'nothing is asked or sent for an invalid amount');
  assert.deepEqual(f.calls, []);
  input.value = '10';
  go.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /DeepSeek/);
  assert.match(f.confirms[0]!.message, /\$10/);
  assert.match(f.confirms[0]!.message, /\$11\.50/, 'the new remaining: 1.50 + 10');
  assert.deepEqual(f.calls, [['topup', { requestId: 'request-1', provider: 'deepseek', dollars: 10 }]]);
});

test('系统状态: an unreachable budget Worker and a missing source are said plainly, not guessed', async (t) => {
  const f = mountSystem(
    t,
    status({ budget: { available: false, error: 'WEB_CLOUD_BUDGET_NOT_INITIALIZED' }, flags: null, retention: null }),
  );
  await f.api.load();
  const text = f.node.textContent;
  assert.ok(text.includes('暂时读不到预算服务'));
  assert.ok(text.includes('没有提供开关信息'));
  assert.ok(text.includes('没有提供清理状态'));
});

function mountPoints(t: test.TestContext, o: { owner?: boolean; granted?: number; live?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const calls: unknown[][] = [];
  const confirms: { title: string; message: string }[] = [];
  let ids = 0;
  const preview = (over: Partial<PointsPreview> = {}): PointsPreview => ({
    amount: 20,
    players: 5,
    granted: o.granted ?? 3,
    totalPoints: 60,
    skipped: { guests: 4, unlimited: 2, atCap: 1 },
    duplicate: false,
    ...over,
  });
  const reset: PointsResetResult = {
    affected: 7,
    totalPoints: 350,
    skipped: { guests: 4, unlimited: 2, atCap: 0, alreadyFull: 3 },
    worstCaseMicros: 1_750_000,
    duplicate: false,
  };
  const api = pointsView(root, {
    preview: async (target, amount) => {
      calls.push(['preview', target, amount]);
      return target.kind === 'email' || target.kind === 'player'
        ? preview({
            players: 1,
            granted: 1,
            totalPoints: amount,
            player: { playerNumber: 'A1B2C3D4', tier: 'registered', balance: 40 },
          })
        : preview();
    },
    grant: async (input) => {
      calls.push(['grant', input]);
      return { ...preview(), duplicate: false };
    },
    resetPreview: async () => {
      calls.push(['reset-preview']);
      return reset;
    },
    reset: async (requestId) => {
      calls.push(['reset', requestId]);
      return reset;
    },
    isOwner: () => o.owner !== false,
    run: async (work) => {
      await work();
    },
    confirm: async (options) => {
      confirms.push(options);
      return true;
    },
    toast: () => {},
    newRequestId: () => `request-${++ids}`,
    disposed: () => false,
    // Part 24b-1 fix: the live count waits for a pause in typing; tests that do not look at it keep it out of the way.
    debounceMs: o.live ? 0 : 3_600_000,
  });
  const set = (id: string, value: string) => {
    const el = node.querySelector(id) as FakeElement;
    el.value = value;
    el.dispatch('input');
  };
  const pick = (kind: string) => {
    const el = node.querySelector(`#points-kind-${kind}`) as FakeElement;
    el.checked = true;
    for (const other of ['all', 'tier', 'player', 'email'])
      if (other !== kind) (node.querySelector(`#points-kind-${other}`) as FakeElement).checked = false;
    el.dispatch('change');
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { api, node, calls, confirms, set, pick, tick };
}

test('积分发放: the dialog shows the number of players and the total points, and the result shows the skipped counts', async (t) => {
  const f = mountPoints(t);
  await f.api.load();
  f.set('#points-amount', '20');
  (f.node.querySelector('#points-send') as FakeElement).click();
  await f.tick();
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /将发给 3 位玩家，共 60 点/);
  assert.match(f.confirms[0]!.message, /跳过：访客 4 · 不限量 2 · 已达上限 1/);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['preview', 'grant'],
  );
  assert.deepEqual((f.calls[1]![1] as { target: unknown }).target, { kind: 'all' });
  assert.match(f.node.querySelector('.system-result')!.textContent, /跳过：访客 4 · 不限量 2 · 已达上限 1/);
});

test('积分发放 by email: sent in full, never shown back; the answer is 玩家编号, tier and balance only', async (t) => {
  const f = mountPoints(t, { live: true });
  await f.api.load();
  f.pick('email');
  f.set('#points-email', 'player@example.com');
  f.set('#points-amount', '15');
  // Named exception (Part 24b-1 fix): 核对 is gone; the same answer appears by itself while the inputs change (debounced, here 0 ms).
  await f.tick();
  await f.tick();
  const shown = f.node.textContent;
  assert.ok(shown.includes('玩家编号 A1B2C3D4 · 注册玩家 · 余额 40 点'));
  assert.ok(
    !shown.includes('player@example.com') ||
      (f.node.querySelector('#points-email') as FakeElement).value === 'player@example.com',
  );
  assert.doesNotMatch(f.node.querySelector('.system-result')!.textContent, /example|@/);
  (f.node.querySelector('#points-send') as FakeElement).click();
  await f.tick();
  assert.doesNotMatch(f.confirms.at(-1)!.message, /example|@/, 'the confirm dialog never echoes the email');
  assert.match(f.confirms.at(-1)!.message, /玩家编号 A1B2C3D4/);
  assert.equal((f.calls.at(-1)![1] as { target: { email: string } }).target.email, 'player@example.com');
  assert.equal(
    (f.node.querySelector('#points-email') as FakeElement).value,
    '',
    'the typed email is cleared after sending',
  );
});

test('积分发放: the form refuses what the server would (amount 1–10000, a full address or 8-character number, a 100-character note)', async (t) => {
  const f = mountPoints(t);
  await f.api.load();
  const send = () => (f.node.querySelector('#points-send') as FakeElement).click();
  for (const amount of ['', '0', '10001', '1.5']) {
    f.set('#points-amount', amount);
    send();
    await f.tick();
  }
  f.set('#points-amount', '10');
  f.set('#points-note', 'x'.repeat(101));
  send();
  await f.tick();
  f.set('#points-note', '');
  f.pick('email');
  f.set('#points-email', 'partial');
  send();
  await f.tick();
  f.pick('player');
  f.set('#points-number', 'abc');
  send();
  await f.tick();
  assert.deepEqual(f.calls, [], 'nothing was sent');
  assert.equal(f.confirms.length, 0);
});

test('积分发放: nobody to give to asks nothing and sends nothing', async (t) => {
  const f = mountPoints(t, { granted: 0 });
  await f.api.load();
  f.set('#points-amount', '20');
  (f.node.querySelector('#points-send') as FakeElement).click();
  await f.tick();
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['preview'],
  );
  assert.equal(f.confirms.length, 0);
});

test('重置全部额度: owner only; the dialog shows accounts, total points and the worst-case cost (暂无数据 without data)', async (t) => {
  const other = mountPoints(t, { owner: false });
  await other.api.load();
  assert.equal(other.node.querySelector('#points-reset') as FakeElement | null, null);
  const f = mountPoints(t);
  await f.api.load();
  (f.node.querySelector('#points-reset') as FakeElement).click();
  await f.tick();
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /影响 7 个账号，共补发 350 点/);
  assert.match(f.confirms[0]!.message, /最坏成本 \$1\.75/);
  assert.match(f.confirms[0]!.message, /不会降低任何人的点数/);
  assert.deepEqual(f.calls, [['reset-preview'], ['reset', 'request-1']]);
});

test('概览: today in UTC and the warnings in one line (no row of section links: the navigation has them)', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const api = overviewView(root, {
    load: async () => ({
      day: '2026-10-22',
      today: { replies: 12, voiceReplies: 9, failedReplies: 1, spendMicros: 2_500_000 },
      warnings: { priceExpiring: 2, retentionFailing: 0, unknownNew: 1 },
    }),
    run: async (work) => {
      await work();
    },
    disposed: () => false,
  });
  await api.load();
  const text = (root as unknown as FakeElement).textContent;
  for (const wanted of ['12', '9', '$2.50', '2026-10-22', '2 项价格即将到期', '近 24 小时新增 1 个 UNKNOWN 调用'])
    assert.ok(text.includes(wanted), wanted);
  assert.ok(!text.includes('清理失败'), 'only the warnings that apply');
  // Named exception (Part 24b-1 fix): the row of links under the chart repeated the navigation and is gone.
  assert.equal((root as unknown as FakeElement).querySelectorAll('.overview-links a').length, 0);
  assert.equal(warningLine({ priceExpiring: 0, retentionFailing: 0, unknownNew: 0 }), null);
  assert.equal(warningLine({ priceExpiring: 0, retentionFailing: 3, unknownNew: 0 }), '3 位玩家的清理失败');
});

const access = (permissions: string[], over: Partial<NavAccess> = {}): NavAccess => ({
  owner: false,
  permissions,
  inbox: true,
  system: true,
  conversations: true,
  ...over,
});
// Named exception (Part 24b-1): 预演测试 is listed UNDER 角色工作台, so the flat list walks the nested pages too.
const labels = (a: NavAccess) => visibleNav(a).flatMap((g) => groupPages(g).map((i) => i.label));

test('the new navigation: who sees 总览, 积分发放, 系统状态 and the 22c placeholders; 总览 first; 玩家统计, 消耗表, 测试对话 in 运营', () => {
  // Named exceptions (Part 24b-1): 概览 is called 总览, 角色资料 is 角色工作台, 玩家统计 moved to 运营 and 测试对话 now follows 消耗表.
  assert.deepEqual(labels(access([], { owner: true })), [
    '总览',
    '角色工作台',
    // Named exception (Part 24b-2): 预演测试 is not a nav item any more (this access has no cast client, so no 关系与故事 either).
    '共创收件箱',
    '邀请与额度',
    '积分发放',
    '玩家统计',
    '消耗表',
    '测试对话',
    '系统状态',
    '管理员与权限',
  ]);
  assert.deepEqual(labels(access([])), ['总览'], '总览 is for everyone who can log in');
  assert.deepEqual(labels(access(['points.grant'])), ['总览', '积分发放']);
  assert.deepEqual(labels(access(['system.read'])), ['总览', '系统状态']);
  assert.equal(canSeePage('stats', access(['points.grant', 'system.read'])), false, 'placeholders are the owner’s');
  assert.equal(canSeePage('costs', access(['points.grant', 'system.read'])), false);
  assert.equal(canSeePage('points', access(['system.read'])), false);
  assert.equal(canSeePage('system', access(['points.grant'])), false);
  assert.equal(
    canSeePage('overview', access([], { system: false })),
    false,
    'a page without the client has none of them',
  );
  assert.equal(firstAllowedPage(access(['invites.read'])), 'overview');
  assert.deepEqual(
    navTree().map((g) => g.label),
    ['', '角色', '玩家', '运营', '系统'],
  );
  assert.deepEqual(
    navTree()
      .flatMap((g) => g.items.map((i) => i.page))
      .filter((page) => page === ('ops' as string)),
    [],
    '运营数据 is not in the nav',
  );
});

test('系统状态 清理: each failing principal shows phase / sub / errorName / messageShape and the count, without any id', async (t) => {
  const f = mountSystem(t, status());
  await f.api.load();
  const cells = f.node.querySelectorAll('td').map((td) => td.textContent);
  const start = cells.indexOf('clearDatabase');
  assert.deepEqual(cells.slice(start, start + 5), [
    'clearDatabase',
    'audit_source',
    'Error',
    'not <tok>: <tok>',
    '3 次',
  ]);
  const none = mountSystem(
    t,
    status({
      retention: {
        failing: 0,
        oldestAgeBucket: null,
        lastSuccessAt: null,
        purging: 0,
        oldestPurgingMinutes: null,
        failures: [],
      },
    }),
  );
  await none.api.load();
  assert.ok(!none.node.textContent.includes('messageShape'), 'no failure table when nothing is failing');
});
