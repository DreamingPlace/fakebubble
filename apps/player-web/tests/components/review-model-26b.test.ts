import assert from 'node:assert/strict';
import test from 'node:test';
import { modelsView } from '../../src/features/admin/models-view.ts';
import type { ModelAdminView } from '../../../../packages/contracts/model-settings.ts';
import {
  parseReviewModelSave,
  parseReviewModelView,
  type ReviewModelId,
  type ReviewModelSaveInput,
  type ReviewModelView,
} from '../../../../packages/contracts/review-model.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const models = (canManage = true): ModelAdminView => ({
  featureOn: true,
  revision: 3,
  priceVersion: 2,
  voicePoints: 2,
  canManage,
  models: (
    [
      ['deepseek', 'DeepSeek', 10],
      ['gemini', 'Gemini 3.8 Flash', 20],
      ['xai', 'Grok 4.7', 25],
    ] as const
  ).map(([model, label, points]) => ({
    model,
    label,
    enabled: true,
    guest: model === 'deepseek',
    registered: true,
    invited: true,
    points,
    configured: true,
  })),
  recent: [],
});
const review = (current: ReviewModelId, revision: number, canManage = true): ReviewModelView => ({
  current,
  revision,
  canManage,
  recent: [{ at: Date.UTC(2026, 10, 4, 3, 0), admin: '主管理员', from: 'deepseek-v4-pro', to: 'deepseek-flash' }],
});

function mount(t: test.TestContext, options: { canManage?: boolean; confirm?: boolean; failSave?: boolean } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const node = root as unknown as FakeElement;
  let state = review('deepseek-v4-pro', 3, options.canManage !== false);
  const saves: ReviewModelSaveInput[] = [];
  const confirms: { title: string; message: string; confirmLabel?: string }[] = [];
  const toasts: string[] = [];
  let failNext = options.failSave === true,
    ids = 0;
  const api = modelsView(root, {
    load: async () => models(options.canManage !== false),
    save: async () => ({}),
    review: {
      load: async () => state,
      save: async (input) => {
        saves.push(input);
        if (failNext) {
          failNext = false;
          throw new Error('network');
        }
        state = review(input.reviewModel, input.expectedRevision + 1, options.canManage !== false);
        return {};
      },
    },
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
    newRequestId: () => `switch-${++ids}`,
    disposed: () => false,
  });
  const button = (id: string) => node.querySelector(`[data-seg="${id}"]`) as FakeElement;
  return { api, node, saves, confirms, toasts, button };
}

test('审核模型: a two-option segmented control showing the live choice, with 最近修改', async (t) => {
  const f = mount(t);
  await f.api.load();
  assert.equal(f.button('deepseek-v4-pro').getAttribute('aria-pressed'), 'true');
  assert.equal(f.button('deepseek-flash').getAttribute('aria-pressed'), 'false');
  assert.match(f.node.textContent, /当前：V4 Pro/);
  assert.match(f.node.textContent, /V4 Pro → V4\.1 Flash/, 'the change log line');
  assert.match(f.node.textContent, /此后发送的消息/, 'says a switch only affects later messages');
  assert.doesNotMatch(f.node.textContent, /member|@/);
});

test('审核模型: one confirmation, then a save with the page revision and a request id; the page shows the new live choice', async (t) => {
  const f = mount(t);
  await f.api.load();
  f.button('deepseek-flash').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.confirms.length, 1, 'exactly one confirm dialog');
  assert.match(f.confirms[0]!.message, /V4 Pro 切换为 V4\.1 Flash/);
  assert.match(f.confirms[0]!.message, /已在处理的消息仍用原来的模型和价格/);
  assert.deepEqual(f.saves, [{ requestId: 'switch-1', expectedRevision: 3, reviewModel: 'deepseek-flash' }]);
  assert.equal(f.button('deepseek-flash').getAttribute('aria-pressed'), 'true');
  assert.match(f.node.textContent, /当前：V4\.1 Flash/);
  assert.deepEqual(f.toasts, ['已切换审核模型']);
});

test('审核模型: cancelling the confirmation saves nothing and the control returns to the live choice', async (t) => {
  const f = mount(t, { confirm: false });
  await f.api.load();
  f.button('deepseek-flash').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.saves, []);
  assert.equal(f.button('deepseek-v4-pro').getAttribute('aria-pressed'), 'true');
  assert.equal(f.button('deepseek-flash').getAttribute('aria-pressed'), 'false');
});

test('审核模型: a save whose outcome was never seen is retried under the SAME request id', async (t) => {
  const f = mount(t, { failSave: true });
  await f.api.load();
  f.button('deepseek-flash').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(f.saves.length, 1);
  assert.equal(f.button('deepseek-v4-pro').getAttribute('aria-pressed'), 'true', 'still the live choice');
  f.button('deepseek-flash').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(
    f.saves.map((s) => s.requestId),
    ['switch-1', 'switch-1'],
  );
  assert.equal(f.button('deepseek-flash').getAttribute('aria-pressed'), 'true');
});

test('审核模型: without models.manage the control is there but off, and says why', async (t) => {
  const f = mount(t, { canManage: false });
  await f.api.load();
  assert.equal((f.button('deepseek-flash') as unknown as { disabled: boolean }).disabled, true);
  assert.match(f.node.textContent, /只读：需要“模型与价格”管理权限才能切换/);
  f.button('deepseek-flash').click();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(f.saves, []);
});

test('the review-model contract is strict: exact keys, known models, integer revision', () => {
  const ok = { requestId: 'switch-abcd', expectedRevision: 3, reviewModel: 'deepseek-flash' };
  assert.deepEqual(parseReviewModelSave(ok), ok);
  for (const bad of [
    { ...ok, extra: 1 },
    { ...ok, reviewModel: 'deepseek-v4-flash' },
    { ...ok, reviewModel: 'gemini' },
    { ...ok, expectedRevision: 0 },
    { ...ok, expectedRevision: 1.5 },
    { ...ok, requestId: 'short' },
    null,
    [],
  ])
    assert.equal(parseReviewModelSave(bad), undefined);
  assert.equal(parseReviewModelView({ ...review('deepseek-flash', 4), current: 'x' }), undefined);
  assert.deepEqual(parseReviewModelView(review('deepseek-flash', 4)), review('deepseek-flash', 4));
});
