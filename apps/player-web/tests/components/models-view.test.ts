import assert from 'node:assert/strict';
import test from 'node:test';
import { describeChanges, changeLine, modelsView } from '../../src/features/admin/models-view.ts';
import {
  canSeePage,
  firstAllowedPage,
  navMarkup,
  visibleNav,
  type NavAccess,
} from '../../src/features/admin/shell/admin-nav.ts';
import {
  parseModelAdminView,
  type ModelAdminView,
  type ModelSaveInput,
} from '../../../../packages/contracts/model-settings.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const view = (over: Partial<ModelAdminView> = {}): ModelAdminView => ({
  featureOn: true,
  revision: 3,
  priceVersion: 2,
  voicePoints: 2,
  canManage: true,
  models: [
    {
      model: 'deepseek',
      label: 'DeepSeek',
      enabled: true,
      guest: true,
      registered: true,
      invited: true,
      points: 10,
      configured: true,
    },
    {
      model: 'gemini',
      label: 'Gemini 3.8 Flash',
      enabled: true,
      guest: false,
      registered: true,
      invited: true,
      points: 20,
      configured: true,
    },
    {
      model: 'xai',
      label: 'Grok 4.7',
      enabled: true,
      guest: false,
      registered: true,
      invited: true,
      points: 25,
      configured: false,
    },
  ],
  recent: [
    {
      at: Date.UTC(2026, 9, 16, 6, 3),
      admin: '主管理员',
      model: 'gemini',
      field: 'points_per_reply',
      from: 15,
      to: 20,
    },
  ],
  ...over,
});

function mount(t: test.TestContext, shown: ModelAdminView, options: { failSave?: boolean; confirm?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  const saves: ModelSaveInput[] = [];
  const confirms: { title: string; message: string }[] = [];
  const toasts: string[] = [];
  let ids = 0,
    failNext = options.failSave === true;
  const api = modelsView(root, {
    load: async () => shown,
    save: async (input) => {
      saves.push(input);
      if (failNext) {
        failNext = false;
        throw new Error('network');
      }
      return {};
    },
    run: async (work) => {
      try {
        await work();
      } catch {
        /* the page shows the message; the test looks at the request */
      }
    },
    confirm: async (o) => {
      confirms.push(o);
      return options.confirm !== false;
    },
    toast: (text) => toasts.push(text),
    newRequestId: () => `request-${++ids}`,
    disposed: () => false,
  });
  const box = (model: string, field: string) =>
    node.querySelector(`input[data-model="${model}"][data-field="${field}"]`) as FakeElement;
  const set = (model: string, field: 'enabled' | 'guest' | 'registered' | 'invited', on: boolean) => {
    box(model, field).checked = on;
    box(model, field).dispatch('change');
  };
  const type = (el: FakeElement, value: string) => {
    el.value = value;
    el.dispatch('input');
  };
  return { api, node, saves, confirms, toasts, box, set, type, save: () => node.querySelector('#models-save')! };
}

test('the table: one row per model with 总开关 / 游客 / 注册玩家 / 受邀玩家 / 每条点数 / 状态, 未配置 versus 可用, the voice field', async (t) => {
  const f = mount(t, view());
  await f.api.load();
  assert.deepEqual(
    f.node.querySelectorAll('thead th').map((th) => th.textContent),
    // Named exception (Part 24b-6): Models3 adds the 最近修改 column (the last change of each row, in the table).
    ['模型', '总开关', '游客', '注册玩家', '受邀玩家', '每条点数', '状态', '最近修改'],
  );
  assert.deepEqual(
    f.node.querySelectorAll('tbody tr').map((tr) => tr.querySelectorAll('th')[0]!.textContent),
    ['DeepSeek', 'Gemini 3.8 Flash', 'Grok 4.7'],
  );
  assert.deepEqual(
    f.node.querySelectorAll('tbody tr').map((tr) => tr.querySelector('.admin-badge')!.textContent),
    ['可用', '可用', '未配置'],
  );
  assert.equal(f.box('deepseek', 'guest').checked, true);
  assert.equal(f.box('gemini', 'guest').checked, false);
  assert.equal((f.node.querySelector('input[data-model="xai"][data-field="points"]') as FakeElement).value, '25');
  assert.equal((f.node.querySelector('#models-voice') as FakeElement).value, '2');
  // The last change of a row: label, model, field, before → after; no ids.
  // Named exception (Part 24b-6): the separate 最近修改 list became a column of the table; the whole line is its hover value.
  assert.match(
    f.node.querySelectorAll('.models-at')[1]!.textContent,
    /主管理员 · Gemini 3.8 Flash 每条点数：15 点 → 20 点/,
  );
  assert.equal(f.save().hidden === false && f.save().disabled, true, 'nothing to save yet');
});

test('保存 asks first, listing every change, and sends the whole table with the revision and one request id', async (t) => {
  const f = mount(t, view());
  await f.api.load();
  f.set('gemini', 'guest', true);
  f.type(f.node.querySelector('input[data-model="gemini"][data-field="points"]') as FakeElement, '30');
  f.type(f.node.querySelector('#models-voice') as FakeElement, '5');
  assert.equal(f.save().disabled, false);
  f.save().click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.confirms.length, 1);
  const message = f.confirms[0]!.message;
  assert.match(message, /3 项修改/);
  assert.match(message, /Gemini 3.8 Flash · 游客：关 → 开/);
  assert.match(message, /Gemini 3.8 Flash · 每条点数：20 点 → 30 点/);
  assert.match(message, /语音加点：2 点 → 5 点/);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0]!.expectedRevision, 3);
  assert.equal(f.saves[0]!.requestId, 'request-1');
  assert.equal(f.saves[0]!.voicePoints, 5);
  assert.deepEqual(
    f.saves[0]!.models.map((m) => [m.model, m.guest, m.points]),
    [
      ['deepseek', true, 10],
      ['gemini', true, 30],
      ['xai', false, 25],
    ],
  );
  assert.deepEqual(f.toasts, ['已保存']);
});

test('declining the confirmation sends nothing', async (t) => {
  const f = mount(t, view(), { confirm: false });
  await f.api.load();
  f.set('gemini', 'enabled', false);
  f.save().click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.confirms.length, 1);
  assert.equal(f.saves.length, 0);
});

test('a save whose outcome was never seen is retried under the same request id; changing the form makes a new one', async (t) => {
  const f = mount(t, view(), { failSave: true });
  await f.api.load();
  f.set('gemini', 'enabled', false);
  f.save().click();
  await new Promise((r) => setTimeout(r, 0));
  f.save().click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.saves.map((s) => s.requestId),
    ['request-1', 'request-1'],
  );
  f.set('xai', 'enabled', false);
  f.save().click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.saves.at(-1)!.requestId, 'request-2');
});

test('a tier cannot be emptied: the page says which one and will not send', async (t) => {
  const f = mount(t, view());
  await f.api.load();
  f.set('deepseek', 'guest', false);
  assert.equal(f.save().disabled, true);
  assert.match(f.node.querySelector('.models-problem')!.textContent, /游客至少要保留一个已开启的模型/);
  f.set('deepseek', 'guest', true);
  f.set('deepseek', 'enabled', false);
  assert.match(f.node.querySelector('.models-problem')!.textContent, /游客/);
  f.set('deepseek', 'enabled', true);
  assert.equal(f.node.querySelector('.models-problem')!.hidden, true);
  // Out-of-range or empty prices do not send either.
  f.type(f.node.querySelector('input[data-model="gemini"][data-field="points"]') as FakeElement, '201');
  assert.equal(f.save().disabled, true);
  assert.match(f.node.querySelector('.models-problem')!.textContent, /1–200/);
  f.type(f.node.querySelector('input[data-model="gemini"][data-field="points"]') as FakeElement, '');
  assert.equal(f.save().disabled, true);
});

test('read access: an administrator without the permission sees the table but cannot change or save it', async (t) => {
  const f = mount(t, view({ canManage: false }));
  await f.api.load();
  assert.equal(f.save().hidden, true);
  for (const input of f.node.querySelectorAll('tbody input')) assert.equal(input.disabled, true);
  assert.equal((f.node.querySelector('#models-voice') as FakeElement).disabled, true);
  assert.match(f.node.textContent, /需要“模型与价格”管理权限/);
});

test('while the feature flag is off the page says players are not affected yet', async (t) => {
  const f = mount(t, view({ featureOn: false }));
  await f.api.load();
  assert.match(f.node.querySelector('.models-banner')!.textContent, /PLAYER_MODEL_CHOICE_ENABLED/);
});

test('describeChanges / changeLine are plain text with no ids', () => {
  const v = view();
  const labels = { deepseek: 'DeepSeek', gemini: 'Gemini', xai: 'Grok' } as const;
  const draft = { models: v.models.map((m) => ({ ...m })), voicePoints: 2 };
  assert.deepEqual(describeChanges(v, draft, labels), []);
  draft.models[2]!.enabled = false;
  assert.deepEqual(describeChanges(v, draft, labels), ['Grok · 总开关：开 → 关']);
  assert.match(changeLine(v.recent[0]!, labels), /^\d+月\d+日 \d\d:\d\d · 主管理员 · Gemini 每条点数：15 点 → 20 点$/);
});

test('navigation: 系统 → 模型与价格 is visible to every administrator whose page has the client, and only then', () => {
  const access = (over: Partial<NavAccess> = {}): NavAccess => ({
    owner: false,
    permissions: [],
    inbox: true,
    models: true,
    ...over,
  });
  assert.equal(canSeePage('models', access()), true, 'read access: no permission needed');
  assert.equal(canSeePage('models', access({ models: false })), false, 'a page without the client has no such page');
  assert.deepEqual(
    visibleNav(access({ owner: true }))
      .find((g) => g.id === 'system')!
      .items.map((i) => i.label),
    // Named exception (Part 22b): 系统状态 joins the system group (shown only when the page has its client; this access has none).
    ['模型与价格', '管理员与权限'],
  );
  assert.equal(firstAllowedPage(access()), 'models');
  assert.match(navMarkup(), /href="#\/models"/);
});

test('the server view is parsed strictly: anything off-shape is rejected', () => {
  const good = view();
  assert.deepEqual(parseModelAdminView(JSON.parse(JSON.stringify(good))), good);
  for (const bad of [
    null,
    [],
    { ...good, revision: 0 },
    { ...good, voicePoints: 21 },
    { ...good, models: good.models.slice(0, 2) },
    { ...good, models: good.models.map((m) => ({ ...m, points: 0 })) },
    { ...good, recent: [{ ...good.recent[0], field: 'password' }] },
  ])
    assert.equal(parseModelAdminView(bad), undefined);
});
