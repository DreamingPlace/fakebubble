// Part 39b: 题目, the wording pool view of the co-creation inbox, and the theme + wording lines of an inbox answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { wordingsView } from '../../src/features/admin/cocreation-wordings-view.ts';
import type { WordingEntry, WordingPool } from '../../src/services/cocreation-admin-api.ts';
import { COCREATION_THEMES } from '../../../../packages/contracts/cocreation-wordings.ts';
import { type FakeElement, flush, installFakeDom } from './fake-dom.ts';

const themes = COCREATION_THEMES.map(({ id, label }) => ({ id, label }));
const NAMES: Record<string, string> = { b: '乙', a: '甲' };

function setup(t: test.TestContext, over: { manage?: boolean; estimate?: unknown } = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as FakeElement;
  doc.body.append(root as never);
  const pool: WordingPool = {
    themes,
    order: ['b', 'a'],
    entries: [
      {
        id: 'w1',
        characterId: 'b',
        themeId: 'theme-know',
        text: '{name}是个怎样的人？',
        enabled: true,
        source: 'manual',
      },
      { id: 'w2', characterId: 'b', themeId: 'theme-know', text: '生成的一条', enabled: false, source: 'generated' },
    ],
  };
  const calls: string[] = [];
  let ids = 0;
  const view = wordingsView(root as unknown as HTMLElement, {
    api: {
      list: async () => structuredClone(pool),
      add: async (input) => {
        calls.push(`add:${input.characterId}:${input.themeId}:${input.text}:${input.enabled}`);
        return {
          id: `n${++ids}`,
          characterId: input.characterId,
          themeId: input.themeId,
          text: input.text,
          enabled: true,
          source: 'manual',
        } as WordingEntry;
      },
      edit: async (id, text) => {
        calls.push(`edit:${id}:${text}`);
        return { ...pool.entries[0]!, id, text };
      },
      toggle: async (id, enabled) => {
        calls.push(`toggle:${id}:${enabled}`);
        return { ...pool.entries[1]!, id, enabled };
      },
      remove: async (id) => void calls.push(`remove:${id}`),
      estimate: async () =>
        (over.estimate as never) ?? {
          ok: true,
          items: [
            { characterId: 'b', estimateMicros: 4_000_000 },
            { characterId: 'a', estimateMicros: 5_000_000 },
          ],
          totalMicros: 9_000_000,
        },
      generate: async (input) => {
        calls.push(`generate:${input.characterId}:${input.acknowledgeMicros}`);
        return { added: 40 };
      },
    },
    nameOf: (id) => NAMES[id] ?? id,
    colour: () => '#888',
    canManage: () => over.manage ?? true,
    newId: () => `req-${++ids}`,
    status: () => {},
  });
  return { root, view, calls };
}

test('题目: characters in the console order, five themes each, every wording editable with its switch; the first character is open', async (t) => {
  const s = setup(t);
  await s.view.load();
  await flush();
  const characters = s.root.querySelectorAll('.cw-character');
  assert.deepEqual(
    characters.map((c) => c.getAttribute('data-character')),
    ['b', 'a'],
    'console order, not the alphabet',
  );
  assert.equal(characters[0]!.querySelectorAll('.cw-theme').length, 5);
  assert.deepEqual(
    characters[0]!.querySelectorAll('.cw-theme h4').map((h) => h.textContent),
    ['认识这个人', '他的经历', '他的习惯', '他的口头禅', '他的近况'],
  );
  assert.equal(characters[0]!.querySelector('.cw-count')!.textContent, '2 条 · 启用 1');
  assert.equal(characters[0]!.querySelectorAll('.cw-row').length, 2);
  assert.equal(characters[0]!.querySelector('[data-wording="w2"] .cw-badge')!.textContent, '生成');
  assert.equal(
    characters[0]!.querySelector('[data-wording="w2"]')!.getAttribute('data-enabled'),
    'false',
    'a draft arrives switched off',
  );
});

test('题目: add, edit, switch and delete each go through the client; the counts follow', async (t) => {
  const s = setup(t);
  await s.view.load();
  await flush();
  const first = s.root.querySelector('.cw-character')!;
  const theme = first.querySelector('[data-theme="theme-habit"]')!;
  theme.querySelector('.cw-new')!.type_('{name}睡前做什么？');
  theme.querySelector('.cw-add')!.click();
  await flush();
  assert.deepEqual(s.calls, ['add:b:theme-habit:{name}睡前做什么？:true']);
  assert.equal(theme.querySelectorAll('.cw-row').length, 1);
  assert.equal(first.querySelector('.cw-count')!.textContent, '3 条 · 启用 2');
  const row = first.querySelector('[data-wording="w1"]')!;
  row.querySelector('.cw-text')!.type_('改过的');
  row.querySelector('.cw-text')!.dispatch('change');
  await flush();
  assert.ok(s.calls.includes('edit:w1:改过的'));
  first.querySelector('[data-wording="w2"] .cw-switch')!.click();
  await flush();
  assert.ok(s.calls.includes('toggle:w2:true'));
  assert.equal(first.querySelector('.cw-count')!.textContent, '3 条 · 启用 3');
  first.querySelector('[data-wording="w2"] .cw-del')!.click();
  await flush();
  assert.ok(s.calls.includes('remove:w2'));
  assert.equal(first.querySelector('[data-wording="w2"]'), null);
});

test('题目: 生成 shows its estimate and only the second click pays; 全部生成 is one call per character, in order, each confirming its own estimate', async (t) => {
  const s = setup(t);
  await s.view.load();
  await flush();
  const one = s.root.querySelector('[data-pw-send="wordings-b"]')!;
  assert.match(one.textContent, /生成 · 1 次付费调用 · 约 \$4/);
  one.click();
  assert.deepEqual(s.calls, [], 'the first click only asks');
  assert.match(one.textContent, /确认付费/);
  one.click();
  await flush();
  assert.deepEqual(s.calls, ['generate:b:4000000']);
  const all = s.root.querySelector('[data-pw-send="wordings-all"]')!;
  assert.match(all.textContent, /全部生成 · 2 次付费调用 · 约 \$9/);
  all.click();
  all.click();
  await flush();
  await flush();
  assert.deepEqual(s.calls.slice(1), ['generate:b:4000000', 'generate:a:5000000']);
});

test('题目: without the manage permission nothing can be changed or paid for; without a price the button says why', async (t) => {
  const ro = setup(t, { manage: false });
  await ro.view.load();
  await flush();
  assert.ok(ro.root.querySelectorAll('.cw-switch').every((b) => b.disabled));
  assert.ok(ro.root.querySelectorAll('.cw-del').every((b) => b.disabled));
  assert.equal(ro.root.querySelector('[data-pw-send="wordings-b"]')!.disabled, true);
  const none = setup(t, { estimate: { ok: false, reason: 'PRICE_MISSING' } });
  await none.view.load();
  await flush();
  assert.equal(none.root.querySelector('[data-pw-send="wordings-all"]')!.disabled, true);
  assert.match(none.root.querySelector('[data-pw-reason="wordings-all"]')!.textContent, /没有生效的模型价格/);
});
