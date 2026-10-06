import test from 'node:test';
import assert from 'node:assert/strict';
import { chatViewport, followChatViewport, swipeStep } from '../../src/features/prototype/mobile-layout.ts';
import { replyPauseMs } from '../../src/features/prototype/reply-presentation.ts';
import type { WebProviderMessage } from '../../../../packages/contracts/web-provider.ts';

test('horizontal content follows the finger; vertical/cancel/short gestures never select a role', () => {
  assert.equal(swipeStep(-100, 4), 1, 'finger left reveals the role on the right');
  assert.equal(swipeStep(100, 4), -1, 'finger right reveals the role on the left');
  for (const [x, y, cancel] of [
    [100, 4, true],
    [12, 0, false],
    [100, 200, false],
    [0, 100, false],
  ] as const)
    assert.equal(swipeStep(x, y, cancel), 0);
});

test('keyboard viewport includes Safari pan offset and preserves native pinch zoom', () => {
  assert.deepEqual(chatViewport({ width: 402, height: 300, offsetTop: 160, offsetLeft: 0, scale: 1 }, 402, 700), {
    width: 402,
    height: 300,
    top: 310,
    left: 201,
  });
  assert.deepEqual(chatViewport(null, 402, 700), { width: 402, height: 700, top: 350, left: 201 });
  assert.equal(chatViewport({ width: 201, height: 300, offsetTop: 0, offsetLeft: 100, scale: 2 }, 402, 700), null);
});

test('visual viewport resize/scroll updates the same chat rectangle through keyboard open/close and rotation', (t) => {
  const previous = globalThis.window;
  const events = new Map<string, () => void>(),
    style = new Map<string, string>();
  const viewport = {
    width: 402,
    height: 700,
    offsetTop: 0,
    offsetLeft: 0,
    scale: 1,
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
  };
  const win = { innerWidth: 402, innerHeight: 700, visualViewport: viewport, addEventListener: () => {} };
  Object.assign(globalThis, { window: win });
  t.after(() => Object.assign(globalThis, { window: previous }));
  followChatViewport({
    style: { setProperty: (key: string, value: string) => style.set(key, value) },
  } as unknown as HTMLElement);
  assert.equal(style.get('--chat-height'), '700px');
  Object.assign(viewport, { height: 300, offsetTop: 160 });
  events.get('resize')!();
  assert.equal(style.get('--chat-height'), '300px');
  assert.equal(style.get('--chat-top'), '310px');
  viewport.offsetTop = 180;
  events.get('scroll')!();
  assert.equal(style.get('--chat-top'), '330px');
  Object.assign(viewport, { scale: 2, height: 150 });
  events.get('resize')!();
  assert.equal(style.get('--chat-height'), '300px');
  Object.assign(viewport, { scale: 1, height: 700, offsetTop: 0 });
  events.get('resize')!();
  assert.equal(style.get('--chat-height'), '700px');
  assert.equal(style.get('--chat-top'), '350px');
  Object.assign(viewport, { width: 700, height: 402 });
  events.get('resize')!();
  assert.equal(style.get('--chat-left'), '350px');
});

test('reply spacing is deterministic and bounded for silence, long content and audio', () => {
  const m = (text: string, durationMs: number | null = null) => ({ text, audio: { durationMs } }) as WebProviderMessage;
  assert.equal(replyPauseMs(m('')), 1200);
  assert.equal(replyPauseMs(m('长'.repeat(5000))), 4000);
  assert.equal(replyPauseMs(m('语音', 2400)), 2400);
  assert.equal(replyPauseMs(m('语音', 300000)), 4000);
  assert.equal(replyPauseMs(m('相同消息')), replyPauseMs(m('相同消息')));
});
