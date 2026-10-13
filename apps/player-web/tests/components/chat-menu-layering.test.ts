import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountChatMenu } from '../../src/features/cocreation/chat-menu.ts';
import { installFakeDom } from './fake-dom.ts';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');

test('a host that is a stacking context is lifted while its menu is open and released when it closes', (t) => {
  const doc = installFakeDom(t);
  const head = doc.createElement('div'),
    button = doc.createElement('button');
  head.append(button);
  const menu = mountChatMenu(button as unknown as HTMLElement, head as unknown as HTMLElement, () => [
    { label: '我的昵称', sub: '角色怎么称呼你', onSelect: () => {} },
  ]);
  assert.equal(head.classList.contains('menu-open'), false);
  button.click();
  assert.equal(head.classList.contains('menu-open'), true);
  button.click();
  assert.equal(head.classList.contains('menu-open'), false);
  button.click();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(menu.isOpen(), false);
  assert.equal(head.classList.contains('menu-open'), false);
});

test('the lifted top bar sits above every card slot and the open chat', () => {
  const lifted = /\.site-head\.menu-open\s*\{[^}]*z-index:\s*(\d+)/.exec(css);
  assert.ok(lifted, '.site-head.menu-open must set a z-index');
  const cardLayers = [...css.matchAll(/\.card-slot[^{]*\{[^}]*?z-index:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(cardLayers.length > 0);
  assert.ok(Number(lifted[1]) > Math.max(...cardLayers));
});
