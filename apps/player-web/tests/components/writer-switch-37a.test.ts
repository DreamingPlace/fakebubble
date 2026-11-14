import assert from 'node:assert/strict';
import test from 'node:test';
import { modelsView } from '../../src/features/admin/models-view.ts';
import type { ModelAdminView } from '../../../../packages/contracts/model-settings.ts';
import type { WriterChoice, WriterSettingView } from '../../../../packages/contracts/web-writer.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const models = (): ModelAdminView => ({
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
  ],
  recent: [],
});

function mount(t: test.TestContext, options: { owner?: boolean; confirm?: boolean; failSave?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  let state: WriterSettingView = { writer: 'v7', available: true };
  const saves: { requestId: string; writer: WriterChoice }[] = [];
  const confirms: { title: string; message: string }[] = [];
  const toasts: string[] = [];
  let fail = options.failSave === true,
    ids = 0;
  const api = modelsView(root, {
    load: async () => models(),
    save: async () => ({}),
    writer: {
      load: async () => state,
      save: async (input) => {
        saves.push(input);
        if (fail) {
          fail = false;
          throw new Error('network');
        }
        state = { writer: input.writer, available: true };
        return {};
      },
    },
    isOwner: () => options.owner !== false,
    run: async (work) => {
      try {
        await work();
      } catch {
        /* the page shows the message */
      }
    },
    confirm: async (o) => {
      confirms.push(o);
      return options.confirm !== false;
    },
    toast: (text) => toasts.push(text),
    newRequestId: () => `writer-${++ids}`,
    disposed: () => false,
  });
  const card = () => node.querySelector('.models-writer') as FakeElement;
  const button = (id: string) => card().querySelector(`[data-seg="${id}"]`) as FakeElement;
  return { api, node, saves, confirms, toasts, card, button };
}

test('回复写法: the owner sees 现行 / 新 with the live choice, and one short line', async (t) => {
  const f = mount(t);
  await f.api.load();
  assert.equal(f.card().hidden, false);
  assert.equal(f.button('v7').getAttribute('aria-pressed'), 'true');
  assert.equal(f.button('v8').getAttribute('aria-pressed'), 'false');
  assert.match(f.card().textContent, /当前：现行/);
  assert.match(f.card().textContent, /只影响此后发送的消息/);
  assert.doesNotMatch(f.card().textContent, /member|@/);
});

test('回复写法: anyone but the owner gets no card and no request', async (t) => {
  const f = mount(t, { owner: false });
  await f.api.load();
  assert.equal(f.card().hidden, true);
  assert.deepEqual(f.saves, []);
});

test('回复写法: one confirmation, then a save under a request id; the card shows the new live choice', async (t) => {
  const f = mount(t);
  await f.api.load();
  f.button('v8').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.confirms.length, 1);
  assert.match(f.confirms[0]!.message, /「现行」切换为「新」/);
  assert.match(f.confirms[0]!.message, /已在生成的回复不变/);
  assert.deepEqual(f.saves, [{ requestId: 'writer-1', writer: 'v8' }]);
  assert.match(f.card().textContent, /当前：新/);
  assert.deepEqual(f.toasts, ['已切换回复写法']);
});

test('回复写法: a declined confirmation changes nothing; a lost answer retries under the SAME request id', async (t) => {
  const declined = mount(t, { confirm: false });
  await declined.api.load();
  declined.button('v8').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(declined.saves, []);
  assert.equal(declined.button('v7').getAttribute('aria-pressed'), 'true');
  const lost = mount(t, { failSave: true });
  await lost.api.load();
  lost.button('v8').click();
  await new Promise((r) => setTimeout(r, 0));
  lost.button('v7').click();
  lost.button('v8').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(lost.saves.length >= 1, true);
  assert.equal(lost.saves[0]!.requestId, 'writer-1');
});
