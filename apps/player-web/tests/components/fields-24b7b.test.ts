import assert from 'node:assert/strict';
import test from 'node:test';
import { canonEditors } from '../../src/features/admin/character-canon.ts';
import { readableGroups } from '../../src/features/admin/history/readable.ts';
import { disclosureDetails } from '../../src/features/admin/ui/disclosure.ts';
import { growBox } from '../../src/features/admin/ui/grow-box.ts';
import { openTable } from '../../src/features/admin/ui/open-table.ts';
import { sentenceList } from '../../src/features/admin/ui/sentence-list.ts';
import { emptyCharacter } from '../../src/features/admin/character-form.ts';
import { installFakeDom, type FakeElement } from './fake-dom.ts';

// Part 24b-7b: fields take the shape of what they hold; one disclosure pattern; one overview table's sorting.
const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);

test('24b-7b a one-sentence box starts at one line, a paragraph at four, and a sentence takes no line break', (t) => {
  installFakeDom(t);
  const one = growBox(document.createElement('textarea'), 'one') as unknown as FakeElement & HTMLTextAreaElement;
  const para = growBox(document.createElement('textarea'), 'para') as unknown as HTMLTextAreaElement;
  assert.equal(one.rows, 1);
  assert.equal(one.dataset.grow, 'one');
  assert.equal(para.rows, 4);
  assert.equal(para.dataset.grow, 'para');
  const enter = one.dispatch('keydown', { key: 'Enter' } as never);
  void enter;
  one.value = '一句话\n被粘贴成两行';
  one.dispatch('input');
  assert.equal(one.value, '一句话被粘贴成两行', 'a pasted line break is dropped');
});

test('24b-7b a sentence list: one row per item, an empty list shows one empty row, empty rows are never data', (t) => {
  installFakeDom(t);
  let edits = 0;
  const empty = sentenceList([], { label: '说话风格', onChange: () => edits++ });
  assert.equal(all(empty.node, '.sl-row').length, 1, 'one empty row to type into');
  assert.deepEqual(empty.read(), []);
  assert.equal(empty.changed(), false);
  const filled = sentenceList(
    ['常用词与口头禅：「行吧行吧」「我跟你讲」「别客气，别站着」', '句子长短：短句为主，情绪上来时会连说三四个短句'],
    {
      label: '说话风格',
      onChange: () => edits++,
    },
  );
  assert.equal(all(filled.node, '.sl-row').length, 2);
  all(filled.node, 'button.sl-add')[0]!.click();
  assert.equal(all(filled.node, '.sl-row').length, 3);
  assert.deepEqual(filled.read().length, 2, 'the new empty row is not an item');
  all(filled.node, '.sl-row textarea')[2]!.type_('第三条');
  assert.equal(filled.read().length, 3);
  assert.equal(filled.changed(), true);
  all(filled.node, 'button.sl-del')[0]!.click();
  assert.equal(filled.read().length, 2);
  assert.ok(edits >= 3);
});

test('24b-7b 说话风格 of 40–80 characters is a row each (never a chip); empty 对话风格 and 对话样例 show one empty row to type into', (t) => {
  installFakeDom(t);
  const long = '开心时怎么说：「哎，这个可以。」然后悄悄多说两句，尾音往上扬，不会一下子说完。'.repeat(1);
  const editors = canonEditors({ speechStyle: [long, long + '。'] } as never, () => {});
  assert.equal(all(editors.speech, '.cn-chip').length, 0, 'no chips');
  const rows = all(editors.speech, '.sl-row textarea');
  assert.equal(rows.length >= 3, true, 'two items and the empty 对话风格 row');
  assert.equal(rows[0]!.value, long, 'the whole text is in its own box');
  assert.equal(all(editors.speech, '.cn-pair').length, 1, 'an empty 对话样例 shows one blank example');
  assert.equal(editors.assemble(editors.rest).dialogueExamples, undefined, 'the blank example is not saved');
});

test('24b-7b 资料改动 reads as fields: no braces and no quoted keys, no id', (t) => {
  installFakeDom(t);
  const live = emptyCharacter();
  const draft = structuredClone(live);
  draft.presentation.displayName = '青野';
  draft.presentation.welcomes[0]!.text = '来啦，先坐。';
  draft.template.authorCanon = {
    kind: 'author_canon',
    settings: { speechStyle: ['短句为主'], background: [{ id: 'abc', title: '小时候', text: '在夜市长大。' }] },
  } as never;
  for (const [, before, after] of readableGroups(live, draft)) {
    for (const side of [before, after]) {
      assert.doesNotMatch(side ?? '', /[{}]|"\w+"\s*:/, 'no JSON');
      assert.doesNotMatch(side ?? '', /\bid\b|abc/, 'no id');
    }
  }
});

test('24b-7b every collapsible shows a chevron and aria-expanded; a table sorts by a column and keeps 合计 last', (t) => {
  installFakeDom(t);
  const details = document.createElement('details') as unknown as HTMLDetailsElement;
  const { summary } = disclosureDetails(details, '草稿记录');
  assert.equal(summary.getAttribute('aria-expanded'), 'false');
  assert.equal(all(summary, '.dc-chev').length, 1);
  type Row = { key: string; n: number; total: boolean };
  const table = openTable<Row>({
    label: 't',
    rowKey: (r) => r.key,
    emptyText: '',
    pinLast: (r) => r.total,
    columns: [{ key: 'n', label: '数', cell: (r) => String(r.n), sortValue: (r) => r.n }],
  });
  table.setRows([
    { key: 'a', n: 3, total: false },
    { key: 'b', n: 1, total: false },
    { key: 't', n: 4, total: true },
  ]);
  const order = () => all(table.root, '.ot-row').map((r) => (r as FakeElement).textContent);
  assert.deepEqual(order(), ['3', '1', '4']);
  all(table.root, 'button.ot-sort')[0]!.click();
  assert.deepEqual(order(), ['1', '3', '4'], 'ascending, 合计 stays last');
  all(table.root, 'button.ot-sort')[0]!.click();
  assert.deepEqual(order(), ['3', '1', '4'], 'descending, 合计 stays last');
});

// ---- Round 2: 其余设定 as fields (个人资料 rows, four 边界 boxes), a lossless round trip, the JSON box only for what no editor owns ----
const FACTS = { 性别: '男', 身高: '176cm', Tag·A: '喜欢下雨前的味道' };
const BOUNDS = { 知道但不会说出口的事: '其实一直偷偷送糖人。', 不可改变的核心设定: '2001-06-18 生。' };
const ROUND = {
  selfIdentity: { names: ['林青野'] },
  profileFacts: FACTS,
  speechStyle: ['短句为主'],
  boundaries: BOUNDS,
  extra: { keep: [1, 2, { a: null }] },
};

test('24b-7b r2 其余设定: untouched, the settings come back byte-identical (keys, order, shapes); 个人资料 is rows and 边界 four fixed boxes', (t) => {
  installFakeDom(t);
  const editors = canonEditors(structuredClone(ROUND) as never, () => {});
  assert.equal(JSON.stringify(editors.assemble(editors.rest)), JSON.stringify(ROUND));
  assert.equal(all(editors.other, '.cn-fact').length, 3, 'one row per fact');
  assert.equal(all(editors.other, '.cn-boundary').length, 4, 'the four boundaries are always there, in this order');
  assert.deepEqual(
    all(editors.other, '.cn-boundary span').map((n) => (n as FakeElement).textContent),
    ['知道但不会说出口的事', '不可改变的核心设定', '不应擅自补充的事实', '不符合角色的行为·表达'],
  );
  assert.equal(editors.hasRest, true, 'selfIdentity and extra stay in the JSON box');
  assert.deepEqual(Object.keys(JSON.parse(editors.rest)), ['selfIdentity', 'extra']);
});

test('24b-7b r2 其余设定: edit one fact and one boundary: only those change; the other keys stay as they came', (t) => {
  installFakeDom(t);
  const editors = canonEditors(structuredClone(ROUND) as never, () => {});
  all(editors.other, '.cn-fact textarea')[1]!.type_('181cm');
  all(editors.other, '.cn-boundary textarea')[2]!.type_('不擅自添加恋爱史。');
  const out = editors.assemble(editors.rest) as typeof ROUND & { boundaries: Record<string, string> };
  assert.deepEqual(out.profileFacts, { ...FACTS, 身高: '181cm' });
  assert.deepEqual(out.boundaries, { ...BOUNDS, 不应擅自补充的事实: '不擅自添加恋爱史。' });
  assert.deepEqual({ ...out, profileFacts: 0, boundaries: 0 }, { ...ROUND, profileFacts: 0, boundaries: 0 });
  assert.deepEqual(Object.keys(out), Object.keys(ROUND), 'the key order is the original one');
});

test('24b-7b r2 其余设定: a shape the editors do not know stays in the JSON box, never dropped or rewritten; empty ones show empty fields', (t) => {
  installFakeDom(t);
  const odd = { profileFacts: ['not', 'a', 'map'], boundaries: { 知道但不会说出口的事: 'x', 别的: 'y' }, other: 1 };
  const editors = canonEditors(structuredClone(odd) as never, () => {});
  assert.equal(all(editors.other, '.cn-fact').length, 0, 'a list is not an object of facts');
  assert.deepEqual(JSON.parse(editors.rest), odd, 'all three keys wait in the JSON box');
  assert.deepEqual(editors.assemble(editors.rest), odd);
  const empty = canonEditors({} as never, () => {});
  assert.equal(all(empty.other, '.cn-fact').length, 1, 'one empty row to type into');
  assert.equal(all(empty.other, '.cn-boundary').length, 4, 'four empty boundary boxes');
  assert.equal(empty.hasRest, false, 'no JSON box when no other key exists');
  assert.deepEqual(empty.assemble(empty.rest), {}, 'nothing typed, nothing saved');
});

test('24b-7b r2 every row list uses the shared controls: one drag handle and one × per row, and a live region', (t) => {
  installFakeDom(t);
  const editors = canonEditors(
    {
      speechStyle: ['甲', '乙'],
      dialogueExamples: [{ player: 'a', reply: ['b'] }],
      background: [{ title: 't', text: 'x' }],
      profileFacts: { 性别: '男' },
    } as never,
    () => {},
  );
  for (const [root, row] of [
    [editors.speech, '.sl-row'],
    [editors.speech, '.cn-pair'],
    [editors.past, '.cn-card'],
    [editors.other, '.cn-fact'],
  ] as const) {
    const rows = all(root, row);
    assert.ok(rows.length >= 1, row);
    for (const r of rows) {
      assert.equal(all(r, '.ad-handle').length, 1, `${row}: one handle`);
      assert.equal(all(r, '.ad-remove').length, 1, `${row}: one ×`);
      assert.equal((r as FakeElement).getAttribute('data-drag-row'), '', `${row}: draggable`);
    }
    assert.ok(all(root, '[role="status"]').length >= 1, `${row}: a live region`);
  }
});
