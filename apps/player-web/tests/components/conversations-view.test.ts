import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationsView } from '../../src/features/admin/conversations-view.ts';
import { ConversationsAdminClient } from '../../src/services/conversations-admin-api.ts';
import type { ReviewDetail, ReviewKey, ReviewList, ReviewListRow } from '../../src/services/conversations-admin-api.ts';
import { canSeePage, navTree, visibleNav, type NavAccess } from '../../src/features/admin/shell/admin-nav.ts';
import { permissionMatrixEditor } from '../../src/features/admin/permission-matrix.ts';
import {
  ADMIN_PERMISSION_PRESETS,
  type AdminPermission,
} from '../../../../packages/contracts/web-admin-permissions.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

const row = (over: Partial<ReviewListRow> = {}): ReviewListRow => ({
  label: 'JOJO-K7M2',
  characterId: 'jojo',
  code: 'K7M2',
  archived: false,
  expiresOn: null,
  messages: 4,
  failed: 1,
  firstAt: '2026-10-12 10:30',
  lastAt: '2026-10-12 11:05',
  ...over,
});
const detail = (key: ReviewKey, over: Partial<ReviewDetail> = {}): ReviewDetail => ({
  label: `JOJO-${key.code}`,
  ...key,
  expiresOn: key.archived ? '2027-04-10' : null,
  total: 3,
  page: 0,
  pageSize: 100,
  lines: [
    {
      n: 1,
      time: '2026-10-12 10:30',
      speaker: 'player',
      text: '我是〔昵称〕',
      status: 'ok',
      errorCode: null,
      reviewChanged: false,
    },
    {
      n: 2,
      time: '2026-10-12 10:31',
      speaker: 'character',
      text: '你好〔昵称〕',
      status: 'ok',
      errorCode: null,
      reviewChanged: true,
    },
    {
      n: 3,
      time: '2026-10-12 10:40',
      speaker: 'character',
      text: '',
      status: 'failed',
      errorCode: 'PROVIDER_FAILED',
      reviewChanged: false,
    },
  ],
  ...over,
});

function setup(
  t: test.TestContext,
  rows: ReviewListRow[] = [row(), row({ label: 'JOJO-Q9ZZ', code: 'Q9ZZ', archived: true, expiresOn: '2027-04-10' })],
) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const calls: string[] = [];
  const saved: [string, string][] = [];
  const waiting: (() => Promise<void>)[] = [];
  let busy = false;
  const api = {
    list: async (input: { characterId: string | null; scope: string | null; page: number }) => {
      calls.push(`list:${input.characterId ?? '*'}:${input.scope ?? '*'}:${input.page}`);
      return {
        rows: rows.filter(
          (r) =>
            (!input.characterId || r.characterId === input.characterId) &&
            (!input.scope || (input.scope === 'archived') === r.archived),
        ),
        page: input.page,
        pageSize: 50,
        total: rows.length,
        characters: [{ characterId: 'jojo', label: 'JOJO' }],
      } satisfies ReviewList;
    },
    detail: async (input: ReviewKey & { page: number }) => {
      calls.push(`detail:${input.code}:${input.page}`);
      return detail(input);
    },
    export: async (input: ReviewKey | { characterId: string }) => {
      calls.push(`export:${'code' in input ? input.code : '*'}`);
      return { filename: 'JOJO.csv', lines: 3, csv: 'label,time\r\n' };
    },
  };
  // The page's own run / runLatest: one run at a time, the newest waiting click wins.
  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await work();
    } finally {
      busy = false;
      const next = waiting.pop();
      waiting.length = 0;
      if (next) void run(next);
    }
  };
  const runLatest = (work: () => Promise<void>) => {
    if (busy) {
      waiting.length = 0;
      waiting.push(work);
    } else void run(work);
  };
  const statuses: string[] = [];
  const view = conversationsView(root, {
    api,
    run,
    runLatest,
    status: (text) => statuses.push(text),
    disposed: () => false,
    save: (name, csv) => saved.push([name, csv]),
  });
  const el = root as unknown as FakeElement;
  return { doc, el, view, calls, saved, statuses, run, runLatest };
}

test('测试对话 lists live and 已删除 conversations with the date an archived one disappears', async (t) => {
  const f = setup(t);
  await f.view.load();
  const headers = f.el.querySelectorAll('th').map((th) => th.textContent);
  for (const wanted of ['对话', '状态', '消息数', '开始（角色当地时间）', '最近（角色当地时间）', '失败回复'])
    assert.ok(
      headers.some((h) => h.includes(wanted)),
      wanted,
    );
  const rows = f.el.querySelectorAll('tbody tr').map((tr) => tr.querySelectorAll('td').map((td) => td.textContent));
  assert.deepEqual(rows[0], ['JOJO-K7M2', '进行中', '4', '2026-10-12 10:30', '2026-10-12 11:05', '1']);
  assert.equal(rows[1]![1], '已删除 · 2027-04-10 消失');
  // The screen never asks for, and the table never shows, an email, a nickname or an id.
  const text = f.el.textContent;
  assert.ok(!/@|principal|world|session|operation/.test(text));
});

test('filters go to the server: by character and by live / archived', async (t) => {
  const f = setup(t);
  await f.view.load();
  const [character, scope] = f.el.querySelectorAll('select');
  scope!.value = 'archived';
  scope!.dispatch('change');
  await flush();
  character!.value = 'jojo';
  character!.dispatch('change');
  await flush();
  assert.deepEqual(f.calls, ['list:*:*:0', 'list:*:archived:0', 'list:jojo:archived:0']);
  assert.equal(f.el.querySelectorAll('tbody tr').length, 1);
});

test('opening a transcript shows both sides in order, the 审核改动 mark, the failed reply with its code, and nothing is a nickname', async (t) => {
  const f = setup(t);
  await f.view.load();
  f.el.querySelectorAll('tbody tr')[0]!.click();
  await flush();
  const lines = f.el.querySelectorAll('.review-line');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((l) => l.querySelector('.review-speaker')!.textContent),
    ['玩家', '角色', '角色'],
  );
  assert.equal(lines[0]!.querySelector('.review-time')!.textContent, '2026-10-12 10:30');
  assert.equal(lines[1]!.querySelector('.review-changed')!.textContent, '审核改动');
  assert.equal(lines[0]!.querySelector('.review-changed'), null);
  assert.equal(lines[2]!.querySelector('.review-text')!.textContent, '回复失败 · PROVIDER_FAILED');
  assert.ok(lines[2]!.className.includes('is-failed'));
  assert.equal(lines[0]!.querySelector('.review-text')!.textContent, '我是〔昵称〕');
  assert.deepEqual(f.view.current(), { characterId: 'jojo', code: 'K7M2', archived: false });
});

test('an archived transcript says 已删除 with its date; 返回列表 goes back', async (t) => {
  const f = setup(t);
  await f.view.load();
  f.el.querySelectorAll('tbody tr')[1]!.click();
  await flush();
  assert.equal(f.el.querySelector('.review-state')!.textContent, '已删除 · 2027-04-10 消失');
  const back = f.el.querySelectorAll('button').find((b) => b.textContent === '返回列表')!;
  back.click();
  assert.equal(f.view.current(), null);
});

test('list → detail clicks are never dropped: while a load runs, the newest click waits and wins', async (t) => {
  const f = setup(t);
  await f.view.load();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Something else is running (a refresh): clicks queue instead of vanishing.
  const running = f.run(() => gate);
  const rows = f.el.querySelectorAll('tbody tr');
  rows[0]!.click();
  rows[1]!.click();
  assert.deepEqual(f.calls, ['list:*:*:0'], 'nothing opened while the other run is in flight');
  release();
  await running;
  await flush();
  await flush();
  assert.deepEqual(f.calls.slice(1), ['detail:Q9ZZ:0'], 'only the newest click ran, and it ran');
  assert.deepEqual(f.view.current(), { characterId: 'jojo', code: 'Q9ZZ', archived: true });
});

test('export: one conversation, or all conversations of the character, is handed to the browser as CSV', async (t) => {
  const f = setup(t);
  await f.view.load();
  f.el.querySelectorAll('tbody tr')[0]!.click();
  await flush();
  const button = (text: string) => f.el.querySelectorAll('button').find((b) => b.textContent === text)!;
  button('导出此对话 CSV').click();
  await flush();
  button('导出该角色全部对话 CSV').click();
  await flush();
  assert.deepEqual(f.calls.slice(-2), ['export:K7M2', 'export:*']);
  assert.equal(f.saved.length, 2);
  assert.equal(f.saved[0]![0], 'JOJO.csv');
  assert.match(f.statuses.at(-1)!, /已导出 JOJO\.csv（3 行）/);
});

test('the client sends exactly the documented bodies and rejects a reply that is not the documented shape', async () => {
  const sent: [string, unknown][] = [];
  const client = new ConversationsAdminClient(async (path, body) => {
    sent.push([path, body]);
    if (path === 'list')
      return { rows: [row()], page: 0, pageSize: 50, total: 1, characters: [{ characterId: 'jojo', label: 'JOJO' }] };
    if (path === 'detail') return detail({ characterId: 'jojo', code: 'K7M2', archived: false });
    return { filename: 'a.csv', lines: 1, csv: 'x' };
  });
  await client.list({ characterId: null, scope: null, page: 0 });
  await client.detail({ characterId: 'jojo', code: 'K7M2', archived: false, page: 1 });
  await client.export({ characterId: 'jojo' });
  await client.export({ characterId: 'jojo', code: 'K7M2', archived: true });
  assert.deepEqual(sent, [
    ['list', { characterId: null, scope: null, page: 0 }],
    ['detail', { characterId: 'jojo', code: 'K7M2', archived: false, page: 1 }],
    ['export', { characterId: 'jojo', code: null, archived: null }],
    ['export', { characterId: 'jojo', code: 'K7M2', archived: true }],
  ]);
  const bad = new ConversationsAdminClient(async () => ({ rows: [{ label: 1 }] }));
  await assert.rejects(bad.list({ characterId: null, scope: null, page: 0 }), /PROTOCOL_INVALID/);
});

// ---- who sees the page -----------------------------------------------------------------------------------------------

const access = (permissions: string[], extra: Partial<NavAccess> = {}): NavAccess => ({
  owner: false,
  permissions,
  inbox: true,
  ...extra,
});

test('the sidebar item 运营 → 测试对话: hidden without the switch, for the presets and for members without the permission', () => {
  const ops = navTree().find((g) => g.id === 'ops')!;
  assert.deepEqual(
    ops.items.map((i) => [i.page, i.label]),
    // Named exception (Part 22b): 运营数据 left the nav (its numbers are 系统状态 → 技术指标).
    // Named exception (Part 24b-1): 运营 = 玩家统计, 消耗表, 测试对话 - 测试对话 moved from first to last (and 玩家统计 joined 运营).
    [
      ['stats', '玩家统计'],
      ['costs', '消耗表'],
      ['conversations', '测试对话'],
    ],
  );
  // The switch (CHAT_REVIEW_ENABLED) is the first condition.
  assert.equal(canSeePage('conversations', access([], { owner: true })), false);
  assert.equal(canSeePage('conversations', access([], { owner: true, conversations: false })), false);
  assert.equal(canSeePage('conversations', access([], { owner: true, conversations: true })), true);
  assert.equal(canSeePage('conversations', access(['conversations.read'], { conversations: true })), true);
  for (const preset of ['co-writer', 'operations'])
    assert.equal(
      canSeePage(
        'conversations',
        access([...ADMIN_PERMISSION_PRESETS.find((p) => p.id === preset)!.items], { conversations: true }),
      ),
      false,
      preset,
    );
  assert.equal(
    canSeePage('conversations', access(['category.characters', 'invites.read'], { conversations: true })),
    false,
  );
  assert.ok(
    visibleNav(access([], { owner: true, conversations: true })).some((g) =>
      g.items.some((i) => i.page === 'conversations'),
    ),
  );
});

test('the permission editor offers 查看测试对话 only with the switch on, and the presets never tick it (全部 does)', (t) => {
  const doc = installFakeDom(t);
  const mount = (initial: AdminPermission[], options: { conversations?: boolean } = {}) => {
    const host = doc.createElement('div');
    const editor = permissionMatrixEditor(host as unknown as HTMLElement, initial, options);
    return { host: host as unknown as FakeElement, editor };
  };
  const off = mount([]);
  assert.equal(off.host.querySelector('[data-permission="conversations.read"]'), null);
  const on = mount([], { conversations: true });
  const box = on.host.querySelector('[data-permission="conversations.read"]')!;
  assert.ok(box);
  for (const preset of ['co-writer', 'operations']) {
    on.host.querySelector(`[data-preset="${preset}"]`)!.click();
    assert.equal(box.checked, false, preset);
  }
  on.host.querySelector('[data-preset="all"]')!.click();
  assert.equal(box.checked, true);
  assert.ok(on.editor.value().includes('conversations.read'));
  // An existing grant is kept untouched even when the screen does not show it.
  assert.deepEqual(mount(['conversations.read']).editor.value(), ['conversations.read']);
});
