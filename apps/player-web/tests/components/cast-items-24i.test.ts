import assert from 'node:assert/strict';
import test from 'node:test';
import { CAST_LIMITS, type CastText } from '../../../../packages/contracts/web-cast.ts';
import { sampleCast } from '../../../../tests/web/fixtures/cast-sample.ts';
import { itemCode, itemList } from '../../src/features/admin/cast/cast-items.ts';
import type { CastCtx } from '../../src/features/admin/cast/cast-ui.ts';
import { installFakeDom, type FakeElement } from './fake-dom.ts';

function editor(t: test.TestContext, texts: string[], options: { edit?: boolean; max?: number } = {}) {
  installFakeDom(t);
  const doc = sampleCast();
  const id = doc.characters[0]!.characterId;
  const items: CastText[] = texts.map((text, i) => ({ id: `i${i}`, text }));
  const calls = { edited: 0, structure: 0 };
  const ctx = {
    doc: () => doc,
    canEdit: () => options.edit !== false,
    edited: () => {
      calls.edited++;
    },
    paint: () => {},
    base: () => doc,
  } as unknown as CastCtx;
  const root = itemList({
    ctx,
    label: '别名',
    items,
    base: structuredClone(items),
    max: options.max ?? CAST_LIMITS.aliases,
    maxText: CAST_LIMITS.alias,
    blank: () => ({ id: '', text: '' }),
    path: (index) => `characters[${id}].identity.aliases[${index}].text`,
    listPath: `characters[${id}].identity.aliases`,
    structure: () => {
      calls.structure++;
    },
    testId: 'aliases',
  }) as unknown as FakeElement;
  const rows = () => root.querySelectorAll('.cs-item');
  const text = (selector: string) => root.querySelectorAll(selector).map((n) => n.textContent);
  const button = (label: string) =>
    root.querySelectorAll('button').filter((b) => b.getAttribute('aria-label')?.includes(label));
  return { root, items, calls, rows, text, button, name: doc.characters[0]!.identity.names[0]!.text };
}

test('rows show the live per-item count and the list count', (t) => {
  const e = editor(t, ['小满', '字'.repeat(16), 'Mary Jane']);
  assert.deepEqual(e.text('.cs-item-count'), ['2/25', '16/25', '9/25']);
  assert.deepEqual(e.text('.cs-items-count'), ['3/12']);
  assert.equal(e.rows().length, 3);
  assert.deepEqual(
    e.text('.cs-item-error').filter(Boolean),
    [],
    'a 16-unit item and an English name with a space have no error',
  );
});

// Part 24l (named exception): the alias cap is 25 (was 16), so the row counts /25 and the over-limit text is 26 units.
test('typing past 25 units is NOT cut: the row is flagged with the shared sentence, 26/25', (t) => {
  const e = editor(t, ['小满']);
  const input = e.root.querySelectorAll('.cs-item-text')[0]!;
  input.type_('字'.repeat(26));
  assert.equal(e.items[0]!.text.length, 26, 'the working copy holds all 26');
  assert.deepEqual(e.text('.cs-item-count'), ['26/25']);
  assert.equal(e.rows()[0]!.getAttribute('data-invalid'), 'true');
  assert.equal(e.text('.cs-item-error')[0], `${e.name} · 别名 第 1 项 — 超过 25 字`);
  assert.ok(e.calls.edited > 0);
  input.type_(' 小满');
  assert.match(e.text('.cs-item-error')[0]!, /开头或结尾有空格（不会自动去掉）/);
  assert.equal(e.items[0]!.text, ' 小满', 'never trimmed');
  input.type_('小满');
  assert.equal(e.rows()[0]!.getAttribute('data-invalid'), 'false');
});

test('a repeat marks the later row, and stops marking it once the text changes', (t) => {
  const e = editor(t, ['阿福', '阿福']);
  assert.equal(e.rows()[0]!.getAttribute('data-invalid'), 'false');
  assert.equal(e.text('.cs-item-error')[1], `${e.name} · 别名 第 2 项 — 与同一列表里的另一项重复`);
  e.root.querySelectorAll('.cs-item-text')[1]!.type_('阿福福');
  assert.equal(e.rows()[1]!.getAttribute('data-invalid'), 'false');
  assert.equal(
    itemCode(
      [
        { id: '', text: 'a' },
        { id: '', text: 'a' },
      ],
      1,
      16,
    ),
    'CAST_DUPLICATE_ITEM',
  );
});

test('add, move and delete change the list in place and keep order and ids; 加一项 stops at the cap', (t) => {
  const e = editor(t, ['甲', '乙', '丙'], { max: 4 });
  e.button('加一项')[0]!.click();
  assert.deepEqual(
    e.items.map((i) => i.text),
    ['甲', '乙', '丙', ''],
  );
  assert.equal(e.rows().length, 4);
  assert.match(e.text('.cs-item-error')[3]!, /不能为空/, 'an empty row is flagged, not dropped');
  assert.equal(e.button('加一项')[0]!.disabled, true, 'full at 4/4');
  assert.deepEqual(e.text('.cs-items-count'), ['4/4']);
  // move 丙 up: 甲 丙 乙
  e.button('把别名第 3 项上移')[0]!.click();
  assert.deepEqual(
    e.items.slice(0, 3).map((i) => [i.id, i.text]),
    [
      ['i0', '甲'],
      ['i2', '丙'],
      ['i1', '乙'],
    ],
  );
  assert.equal(e.button('把别名第 1 项上移')[0]!.disabled, true, 'the first row cannot go up');
  // delete the first
  e.button('删除别名第 1 项')[0]!.click();
  assert.deepEqual(
    e.items.map((i) => i.text),
    ['丙', '乙', ''],
  );
  assert.ok(e.calls.structure >= 3);
});

test('without cast.edit the rows are read-only and there are no tools', (t) => {
  const e = editor(t, ['小满'], { edit: false });
  assert.equal(e.root.querySelectorAll('.cs-item-text')[0]!.hasAttribute('readonly'), true);
  assert.equal(e.button('加一项').length, 0);
  assert.equal(e.root.querySelectorAll('.cs-item-tools').length, 0);
});
