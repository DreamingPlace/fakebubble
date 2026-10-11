import assert from 'node:assert/strict';
import test from 'node:test';
import { confirmDialog } from '../../src/features/admin/ui/confirm-dialog.ts';
import { dataTable } from '../../src/features/admin/ui/data-table.ts';
import { drawer } from '../../src/features/admin/ui/drawer.ts';
import { keyValuePanel } from '../../src/features/admin/ui/key-value-panel.ts';
import { sectionIndex } from '../../src/features/admin/ui/section-index.ts';
import { splitPane } from '../../src/features/admin/ui/split-pane.ts';
import { statusBadge } from '../../src/features/admin/ui/status-badge.ts';
import { toastHost } from '../../src/features/admin/ui/toast.ts';
import { toolbar } from '../../src/features/admin/ui/toolbar.ts';
import { rolePicker } from '../../src/features/admin/shell/role-picker.ts';
import type { FakeElement } from './fake-dom.ts';
import { installFakeDom } from './fake-dom.ts';

type Row = { id: string; name: string; count: number | null };
const rows: Row[] = [
  { id: 'a', name: '丙', count: 3 },
  { id: 'b', name: '甲', count: 10 },
  { id: 'c', name: '乙', count: null },
];
const el = (node: unknown) => node as FakeElement;
const bodyIds = (table: ReturnType<typeof dataTable<Row>>) =>
  el(table.root)
    .querySelectorAll('tbody tr')
    .map((tr) => tr.getAttribute('data-row'));
function table(onBulk: (rows: Row[]) => void = () => {}) {
  return dataTable<Row>({
    columns: [
      { key: 'name', label: '名称', sortable: true },
      {
        key: 'count',
        label: '数量',
        sortable: true,
        align: 'end',
        sortValue: (r) => r.count,
        render: (r) => String(r.count ?? '—'),
      },
    ],
    rowKey: (r) => r.id,
    emptyText: '没有数据',
    bulkActions: [{ label: '处理所选', run: onBulk }],
  });
}

test('data table: empty state, sortable columns with aria-sort, numbers sorted numerically and empty values last', (t) => {
  installFakeDom(t);
  const view = table();
  assert.equal(el(view.root).querySelector('.admin-empty')!.hidden, false);
  assert.equal(el(view.root).querySelector('.admin-empty')!.textContent, '没有数据');
  assert.equal(el(view.root).querySelector('table')!.hidden, true);
  view.setRows(rows);
  assert.equal(el(view.root).querySelector('.admin-empty')!.hidden, true);
  assert.deepEqual(bodyIds(view), ['a', 'b', 'c']);
  const sortButtons = el(view.root).querySelectorAll('th .admin-sort');
  assert.equal(el(view.root).querySelector('th[aria-sort]')!.getAttribute('aria-sort'), 'none');
  sortButtons[1]!.click();
  assert.deepEqual(bodyIds(view), ['a', 'b', 'c'], '3 < 10, empty last');
  assert.equal(el(view.root).querySelectorAll('th')[2]!.getAttribute('aria-sort'), 'ascending');
  el(view.root).querySelectorAll('th .admin-sort')[1]!.click();
  assert.deepEqual(bodyIds(view), ['b', 'a', 'c'], 'descending keeps the empty value last');
  assert.equal(el(view.root).querySelectorAll('th')[2]!.getAttribute('aria-sort'), 'descending');
  el(view.root).querySelectorAll('th .admin-sort')[0]!.click();
  assert.deepEqual(bodyIds(view), ['a', 'b', 'c'], 'pinyin order: 丙 bing < 甲 jia < 乙 yi');
});

test('data table: selection shows the bulk bar, select-all and clear work, selection is pruned when rows change', (t) => {
  installFakeDom(t);
  let got: string[] = [];
  const view = table((chosen) => (got = chosen.map((r) => r.id)));
  view.setRows(rows);
  const bar = el(view.root).querySelector('.admin-bulk-bar')!;
  assert.equal(bar.hidden, true);
  const boxes = () => el(view.root).querySelectorAll('tbody input');
  boxes()[0]!.checked = true;
  boxes()[0]!.dispatch('change');
  assert.equal(bar.hidden, false);
  assert.equal(el(view.root).querySelector('.admin-bulk-count')!.textContent, '已选 1 项');
  bar.querySelectorAll('button')[0]!.click();
  assert.deepEqual(got, ['a']);
  const all = el(view.root).querySelector('thead input')!;
  all.checked = true;
  all.dispatch('change');
  assert.equal(el(view.root).querySelector('.admin-bulk-count')!.textContent, '已选 3 项');
  view.setRows(rows.slice(0, 2));
  assert.equal(el(view.root).querySelector('.admin-bulk-count')!.textContent, '已选 2 项');
  view.clearSelection();
  assert.equal(bar.hidden, true);
  assert.deepEqual(view.selected(), []);
});

test('data table without bulk actions has no selection column', (t) => {
  installFakeDom(t);
  const view = dataTable<Row>({ columns: [{ key: 'name', label: '名称' }], rowKey: (r) => r.id, emptyText: '空' });
  view.setRows(rows);
  assert.equal(el(view.root).querySelectorAll('input').length, 0);
  assert.equal(el(view.root).querySelector('.admin-bulk-bar')!.hidden, true);
});

test('toolbar reports every filter value after a change and runs its actions', (t) => {
  installFakeDom(t);
  const seen: Array<Record<string, string>> = [];
  let ran = 0;
  const bar = toolbar({
    title: '标题',
    filters: [
      { kind: 'search', id: 'q', label: '搜索' },
      {
        kind: 'select',
        id: 'state',
        label: '状态',
        options: [
          ['all', '全部'],
          ['on', '有效'],
        ],
      },
    ],
    actions: [{ label: '刷新', run: () => ran++ }],
    onChange: (values) => seen.push(values),
  });
  const input = el(bar.root).querySelector('input')!;
  input.type_('abc');
  assert.equal(seen.at(-1)?.q, 'abc');
  const select = el(bar.root).querySelector('select')!;
  select.value = 'on';
  select.dispatch('change');
  assert.deepEqual(seen.at(-1), { q: 'abc', state: 'on' });
  el(bar.root).querySelector('button')!.click();
  assert.equal(ran, 1);
  assert.equal(el(bar.root).getAttribute('role'), 'toolbar');
  assert.deepEqual(bar.values(), { q: 'abc', state: 'on' });
});

test('split pane: both panes exist, the divider is a labelled separator, arrow keys resize within bounds', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  const pane = splitPane(host as unknown as HTMLElement, { initial: 300, min: 250, max: 340 });
  assert.equal(el(pane.divider).getAttribute('role'), 'separator');
  assert.equal(el(pane.divider).getAttribute('aria-valuenow'), '300');
  assert.match(el(pane.root).getAttribute('style')!, /--split-list-width:300px/);
  el(pane.divider).dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(pane.width(), 316);
  for (let i = 0; i < 10; i++) el(pane.divider).dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(pane.width(), 340, 'clamped to max');
  for (let i = 0; i < 20; i++) el(pane.divider).dispatch('keydown', { key: 'ArrowLeft' });
  assert.equal(pane.width(), 250, 'clamped to min');
  assert.equal(el(pane.list).parent, pane.root);
  assert.equal(el(pane.detail).parent, pane.root);
});

test('drawer opens and closes by button, backdrop and Escape, and reports the close once', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  let closed = 0;
  const side = drawer(host as unknown as HTMLElement, { title: '记录', onClose: () => closed++ });
  const panel = el(host).querySelector('.admin-drawer')!;
  assert.equal(panel.hidden, true);
  side.open();
  assert.equal(panel.hidden, false);
  assert.equal(side.isOpen(), true);
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(panel.hidden, true);
  assert.equal(closed, 1);
  side.open();
  el(host).querySelector('.admin-backdrop')!.click();
  assert.equal(closed, 2);
  side.close();
  assert.equal(closed, 2, 'closing a closed drawer does nothing');
  side.setTitle('新标题');
  assert.equal(panel.getAttribute('aria-label'), '新标题');
});

test('confirm dialog: only the confirm button resolves true; cancel, backdrop and Escape resolve false; focus starts on cancel', async (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  const open = () =>
    confirmDialog(host as unknown as HTMLElement, {
      title: '撤销',
      message: '确定？',
      confirmLabel: '确认撤销',
      danger: true,
    });
  let result = open();
  const buttons = () => el(host).querySelectorAll('.admin-dialog button');
  assert.equal(buttons().length, 2);
  assert.equal(doc.activeElement, buttons()[0], 'cancel has the focus');
  assert.equal(buttons()[1]!.textContent, '确认撤销');
  assert.equal(buttons()[1]!.className, 'admin-danger');
  buttons()[1]!.click();
  assert.equal(await result, true);
  assert.equal(el(host).querySelectorAll('.admin-dialog').length, 0, 'removed after answering');
  result = open();
  buttons()[0]!.click();
  assert.equal(await result, false);
  result = open();
  el(host).querySelector('.admin-backdrop')!.click();
  assert.equal(await result, false);
  result = open();
  doc.fire('keydown', { key: 'Escape' });
  assert.equal(await result, false);
});

test('toast shows a live-region message and removes it after its time; dispose clears pending timers', async (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  const toasts = toastHost(host as unknown as HTMLElement, { ttlMs: 5 });
  assert.equal(el(toasts.region).getAttribute('aria-live'), 'polite');
  toasts.show('已撤销', 'ok');
  assert.equal(el(host).querySelectorAll('.admin-toast').length, 1);
  assert.equal(el(host).querySelector('.admin-toast')!.getAttribute('data-tone'), 'ok');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(el(host).querySelectorAll('.admin-toast').length, 0);
  toasts.show('再来一条');
  toasts.dispose();
  assert.equal(el(host).querySelectorAll('.admin-toast').length, 0);
});

test('status badge says its state in text and carries the tone as data; key–value panel pairs labels with values', (t) => {
  installFakeDom(t);
  const badge = el(statusBadge('已撤销', 'danger'));
  assert.equal(badge.textContent, '已撤销');
  assert.equal(badge.getAttribute('data-tone'), 'danger');
  assert.equal(el(statusBadge('x')).getAttribute('data-tone'), 'neutral');
  const panel = el(
    keyValuePanel([
      ['批次', '春季'],
      ['状态', statusBadge('有效', 'ok')],
      ['备注', null],
    ]),
  );
  assert.deepEqual(
    panel.querySelectorAll('dt').map((n) => n.textContent),
    ['批次', '状态', '备注'],
  );
  assert.deepEqual(
    panel.querySelectorAll('dd').map((n) => n.textContent),
    ['春季', '有效', '—'],
  );
});

test('section index lists the sections, hides itself under two, and opens a collapsed section when jumped to', (t) => {
  const doc = installFakeDom(t);
  const nav = doc.createElement('nav');
  const first = doc.createElement('details');
  const second = doc.createElement('section');
  let scrolled = 0;
  second.scrollIntoView = () => void scrolled++;
  sectionIndex(nav as unknown as HTMLElement, [{ label: '资料', node: first as unknown as HTMLElement }]);
  assert.equal(nav.hidden, true);
  sectionIndex(nav as unknown as HTMLElement, [
    { label: '资料', node: first as unknown as HTMLElement },
    { label: '发布', node: second as unknown as HTMLElement },
  ]);
  assert.equal(nav.hidden, false);
  nav.querySelectorAll('button')[0]!.click();
  assert.equal((first as unknown as { open: boolean }).open, true);
  nav.querySelectorAll('button')[1]!.click();
  assert.equal(scrolled, 1);
});

test('role picker lists roles with their state, marks the open one and shows an empty state', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div');
  const picked: string[] = [];
  const picker = rolePicker(host as unknown as HTMLElement, {
    emptyText: '没有可预演的角色',
    onPick: (id) => picked.push(id),
  });
  picker.show([]);
  assert.equal(el(host).querySelector('.admin-empty')!.textContent, '没有可预演的角色');
  picker.show([
    { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 2, draftRevision: 4 },
    { characterId: 'new-one', displayName: '新角色', publishedVersion: null, draftRevision: null },
  ]);
  const rows = el(host).querySelectorAll('.admin-pick');
  assert.equal(rows.length, 2);
  assert.match(rows[0]!.textContent, /JOJO/);
  assert.match(rows[0]!.textContent, /正式 v2/);
  assert.match(rows[0]!.textContent, /草稿 4/);
  assert.match(rows[1]!.textContent, /未发布/);
  rows[1]!.click();
  assert.deepEqual(picked, ['new-one']);
  picker.select('jojo');
  assert.equal(el(host).querySelector('.admin-pick[aria-current="true"]')!.getAttribute('data-character'), 'jojo');
});
