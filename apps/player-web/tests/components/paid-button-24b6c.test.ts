import assert from 'node:assert/strict';
import test from 'node:test';
import { paidButton } from '../../src/features/admin/ui/paid-button.ts';
import { progressText, stageOf } from '../../src/features/admin/preview/stage.ts';
import type { PreviewRow } from '../../src/services/preview-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

const el = (node: unknown) => node as FakeElement;

function setup(t: test.TestContext, over: { reason?: string; label?: string } = {}) {
  installFakeDom(t);
  const state = { reason: over.reason ?? '', label: over.label ?? '预演 1 条 · 2 次付费调用', sent: 0 };
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const b = paidButton({
    name: 'x',
    label: () => state.label,
    confirmLabel: () => '确认付费 · 2 次',
    reason: () => state.reason,
    onConfirm: () => {
      state.sent++;
    },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms, cleared: false });
      return timers.length - 1;
    },
    clearTimer: (handle) => {
      timers[handle as number]!.cleared = true;
    },
  });
  return {
    b,
    state,
    timers,
    button: el(b.button),
    cancel: el(b.cancel),
    reason: el(b.root.querySelector('.pw-reason')),
  };
}

test('paid button: the first click only arms (amber confirm + 取消 for 6 s), the second click sends', (t) => {
  const f = setup(t);
  assert.equal(f.button.textContent, '预演 1 条 · 2 次付费调用');
  f.button.click();
  assert.equal(f.state.sent, 0, 'a first click alone sends nothing');
  assert.equal(f.button.textContent, '确认付费 · 2 次');
  assert.equal(f.button.getAttribute('data-state'), 'confirm');
  assert.equal(f.cancel.hidden, false);
  assert.equal(f.timers.at(-1)!.ms, 6000);
  f.button.click();
  assert.equal(f.state.sent, 1);
  assert.equal(f.button.getAttribute('data-state'), 'idle');
  assert.equal(f.cancel.hidden, true);
  // Sending again needs a fresh first click.
  f.button.click();
  assert.equal(f.state.sent, 1);
});

test('paid button: 取消, the 6 s timeout, Escape and a changed label all put it back to idle without sending', (t) => {
  const f = setup(t);
  f.button.click();
  f.cancel.click();
  assert.equal(f.button.getAttribute('data-state'), 'idle');
  f.button.click();
  f.timers.at(-1)!.fn();
  assert.equal(f.button.getAttribute('data-state'), 'idle', 'timeout');
  f.button.click();
  el(f.b.root).dispatch('keydown', { key: 'Escape' });
  assert.equal(f.button.getAttribute('data-state'), 'idle', 'Escape');
  f.button.click();
  f.state.label = '运行 2 条 · 4 次付费调用';
  f.b.refresh();
  assert.equal(f.button.getAttribute('data-state'), 'idle', 'what would be sent changed');
  assert.equal(f.button.textContent, '运行 2 条 · 4 次付费调用');
  assert.equal(f.state.sent, 0);
});

test('paid button: never silent — an impossible send is off and the reason sits next to it', (t) => {
  const f = setup(t, { reason: '没有草稿' });
  assert.equal(f.button.disabled, true);
  assert.equal(f.reason.textContent, '没有草稿');
  assert.equal(f.reason.hidden, false);
  f.button.click();
  assert.equal(f.button.getAttribute('data-state'), 'idle');
  f.state.reason = '';
  f.b.refresh();
  assert.equal(f.button.disabled, false);
  assert.equal(f.reason.hidden, true);
  f.button.click();
  f.state.reason = '你没有预演权限';
  f.b.refresh();
  assert.equal(f.button.getAttribute('data-state'), 'idle', 'a reason appearing disarms');
  assert.equal(f.button.disabled, true);
});

test('stage: the status API only knows queued / generating; the draft wall time tells 生成草稿 from 审核中', () => {
  const row = (status: PreviewRow['status'], draftMs: number | null) =>
    ({ status, latency: { draftMs, reviewMs: null } }) as Pick<PreviewRow, 'status' | 'latency'>;
  assert.equal(stageOf(row('queued', null)), 'queued');
  assert.equal(stageOf(row('generating', null)), 'draft');
  assert.equal(stageOf(row('generating', 900)), 'review');
  assert.equal(stageOf(row('succeeded', 900)), 'done');
  assert.equal(stageOf(row('failed', null)), 'failed');
  assert.equal(progressText(3, 8, 0), '3 / 8 完成');
  assert.equal(progressText(8, 8, 1), '8 / 8 完成 · 1 失败');
});
