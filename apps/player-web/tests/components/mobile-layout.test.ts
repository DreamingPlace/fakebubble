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

test('phone card uses a bounded visible-viewport shell, internal scrolling and a non-shrinking composer', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
  const mobile = css.slice(css.indexOf('/* Part 15:'));
  assert.match(mobile, /@media \(max-width: 600px\)/);
  assert.match(mobile, /height: var\(--chat-height, 100dvh\)/);
  assert.match(mobile, /env\(safe-area-inset-bottom\)/);
  assert.match(
    mobile,
    /\.page-shell\[data-phase\] \.card-slot\.is-chat \{[^}]*position: absolute;[^}]*width: calc\(100% - 32px\);[^}]*height: 100%/,
  );
  assert.match(mobile, /\.page-shell \.chat-body \{[^}]*min-height: 0;[^}]*overflow-y: auto/);
  assert.match(css, /\.composer \{[^}]*flex: none/);
  assert.match(mobile, /\.page-shell\[data-phase\] \.composer \{[^}]*padding: 8px/);
  assert.match(mobile, /\.page-shell \.chat-head \{[^}]*height: 44px;[^}]*padding: 0 8px/);
  assert.match(mobile, /\.page-shell \.chat-head strong \{[^}]*font-size: 15px/);
  assert.match(mobile, /\.page-shell \.card-slot\.is-chat \.chat-body \{[^}]*padding-top: 12px/);
  assert.doesNotMatch(mobile, /\.admin|\.account-admin/);
});

test('mobile-only chrome keeps actions on row one, count beneath, and smaller circles with full hit areas', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8').split('/* Part 15:')[1]!;
  const mobile = css.slice(css.indexOf('@media (max-width: 600px)'));
  assert.match(mobile, /grid-template-rows: 44px auto/);
  assert.match(mobile, /\.page-shell \.head-actions \{[^}]*grid-row: 1/);
  assert.match(mobile, /\.page-shell \.site-head \.head-note \{[^}]*grid-column: 2 \/ 4;[^}]*grid-row: 2/);
  assert.match(mobile, /\.page-shell \.site-head \.head-hint \{[^}]*grid-row: 3/);
  assert.match(mobile, /\.page-shell \.desktop-account \{\s*display: none/);
  assert.match(mobile, /width: 45\.9px;\s*height: 45\.9px/);
  assert.match(mobile, /width: 48px;\s*height: 48px/);
  assert.match(mobile, /translateY\(calc\(var\(--avatar-y\) \* 0\.3\)\)/);
});

test('single-person chat hides the mobile carousel; only the home/browse surface has the switcher', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8').split('/* Part 15:')[1]!;
  assert.match(
    css,
    /\.page-shell\[data-phase="chat"\] \.avatar-nav,[\s\S]*?\.page-shell\[data-phase="collapsing"\] \.avatar-nav \{\s*display: none;/,
  );
  const source = readFileSync(new URL('../../src/features/prototype/preview.ts', import.meta.url), 'utf8');
  assert.match(source, /nav.inert = chatting;/);
  assert.match(source, /nav.setAttribute\('aria-hidden', String\(chatting\)\)/);
});
