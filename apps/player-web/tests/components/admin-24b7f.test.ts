import assert from 'node:assert/strict';
import test from 'node:test';
import { ICON_PATHS, iconTool } from '../../src/features/admin/ui/icon-tool.ts';
import { toolbar } from '../../src/features/admin/ui/toolbar.ts';
import { installFakeDom, type FakeElement } from './fake-dom.ts';
import { COPY_AUDIT_SOURCE } from '../../../../scripts/admin-copy-audit-24b7d.ts';

// Part 24b-7f: an icon tool is named by its aria-label and its hover tip; a toolbar title can carry what the page is as its tip;
// and the copy audit knows the standing no-explanation rule.

test('24b-7f an icon tool keeps its id and hidden state, is named by aria-label and has the console tip with the same name', (t) => {
  installFakeDom(t);
  const button = document.createElement('button');
  button.setAttribute('id', 'wb-new');
  button.hidden = true;
  button.textContent = '+ 新建角色';
  const same = iconTool(button, '新建角色', ICON_PATHS.add);
  assert.equal(same, button);
  assert.equal(button.getAttribute('id'), 'wb-new');
  assert.equal(button.hidden, true);
  assert.equal(button.getAttribute('aria-label'), '新建角色');
  assert.match((button as unknown as FakeElement).className, /ad-icon-tool/);
  const tip = (button as unknown as FakeElement).querySelector('.ad-tip') as FakeElement;
  assert.ok(tip, 'the hover tip is there');
  assert.equal(tip.textContent, '新建角色');
  assert.equal(button.getAttribute('aria-describedby'), tip.getAttribute('id'));
  assert.ok(button.querySelector('svg, i'), 'a glyph replaced the old text');
});

test('24b-7f the three tools have three different glyphs', () => {
  assert.equal(new Set(Object.values(ICON_PATHS)).size, 3);
});

test('24b-7f a toolbar title carries its explanation as a hover tip, and has none without one', (t) => {
  installFakeDom(t);
  const withTip = toolbar({ title: '测试对话', titleTip: '只显示匿名编号。' });
  const title = withTip.root.querySelector('.admin-bar-title') as unknown as FakeElement;
  assert.equal(title.querySelector('.ad-tip')?.textContent, '只显示匿名编号。');
  const plain = toolbar({ title: '测试对话' });
  assert.equal((plain.root.querySelector('.admin-bar-title') as unknown as FakeElement).querySelector('.ad-tip'), null);
});

test('24b-7f the copy audit has the sentences rule, its allowlist contexts and the standing-rule marks', () => {
  assert.match(COPY_AUDIT_SOURCE, /sentences: \[\]/);
  for (const context of ['[data-empty]', '[data-reason]', '[data-irreversible]', '.dz-note', '.ad-tip'])
    assert.ok(COPY_AUDIT_SOURCE.includes(context), `the allowlist names ${context}`);
});
