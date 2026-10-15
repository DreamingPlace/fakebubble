import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
const rule = (selector: string) =>
  css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.>*]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

// Part 17f: the Turnstile check was parked at the bottom of the window; it is centred on both axes now, on every screen.
test('the human check box is centred in the window, not at the bottom', () => {
  const box = rule('.human-check');
  assert.match(box, /position:\s*fixed/);
  assert.match(box, /inset:\s*0/);
  assert.match(box, /display:\s*flex/);
  assert.match(box, /align-items:\s*center/);
  assert.match(box, /justify-content:\s*center/);
  assert.doesNotMatch(box, /\bbottom:/, 'no bottom anchoring');
  assert.match(rule('.human-check > *'), /pointer-events:\s*auto/, 'the widget itself stays clickable');
});
