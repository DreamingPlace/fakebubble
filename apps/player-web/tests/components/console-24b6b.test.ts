import assert from 'node:assert/strict';
import test from 'node:test';
import { canonEditors } from '../../src/features/admin/character-canon.ts';
import { boxKind, draftBox, withField } from '../../src/features/admin/cocreation-draft-box.ts';
import { historyList, HISTORY_SHOWN, type HistoryEntry } from '../../src/features/admin/history/history-list.ts';
import { parseRoute } from '../../src/features/admin/shell/admin-router.ts';
import { overviewView, warningLine } from '../../src/features/admin/overview-view.ts';
import { systemView } from '../../src/features/admin/system-view.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

// Part 24b-6b: the parts of this change that are not already guarded by the (renamed, narrowed) 24b-6 / 24f tests.
const all = (root: unknown, selector: string) => (root as FakeElement).querySelectorAll(selector);
const one = (root: unknown, selector: string) => (root as FakeElement).querySelector(selector) as FakeElement;

// ---- 角色工作台 → 经历 -------------------------------------------------------------------------------------------------------

test('24b-6b 经历: a character with none shows one empty card with a text box and "+ 经历"; an empty untouched card is not saved', (t) => {
  installFakeDom(t);
  const editors = canonEditors({ speechStyle: ['温柔'] } as never, () => {});
  assert.equal(all(editors.past, 'div.cn-card').length, 1, 'one empty card');
  assert.equal(all(editors.past, '.cn-card textarea').length, 1, 'with a text box');
  assert.equal(all(editors.past, 'button.cn-add').length, 1, '+ 经历 is there');
  // the untouched-key round trip: nothing is added to the character
  const out = editors.assemble(editors.rest);
  assert.deepEqual(out, { speechStyle: ['温柔'] });
  assert.ok(!('background' in out), 'no empty 经历 key appears');
  // "+ 经历" adds another card; both are empty and untouched, so still nothing is saved
  one(editors.past, 'button.cn-add').click();
  assert.equal(all(editors.past, 'div.cn-card').length, 2);
  assert.ok(!('background' in editors.assemble(editors.rest)));
  // writing in a card makes it real; the other empty one is still left out
  all(editors.past, '.cn-card textarea')[1]!.type_('在海边长大');
  const saved = editors.assemble(editors.rest).background as unknown[];
  assert.deepEqual(saved, [{ title: '', text: '在海边长大' }]);
});

test('24b-6b 经历: removing the last card leaves an empty one to write in, and an existing card still round-trips untouched', (t) => {
  installFakeDom(t);
  const input = { background: [{ title: '小时候', text: '住在海边' }, '后来搬了家'] };
  const editors = canonEditors(structuredClone(input) as never, () => {});
  assert.deepEqual(editors.assemble(editors.rest), input, 'untouched: deep-equal');
  for (let i = 0; i < 2; i++) one(editors.past, 'div.cn-card .cn-x').click();
  assert.equal(all(editors.past, 'div.cn-card').length, 1, 'an empty card is left to write in');
  assert.deepEqual(editors.assemble(editors.rest).background, [], 'the removal is saved as an empty list');
});

// ---- 共创收件箱: the draft box ----------------------------------------------------------------------------------------------

test('24b-6b the draft box: each field shows the shape it has, and one it cannot show is left alone', () => {
  const tpl = {
    persona: '人设',
    authorCanon: {
      settings: { interests: ['a'], speechStyle: { x: 1 }, dialogueExamples: [{ player: 'p', reply: ['r'] }] },
    },
  };
  assert.equal(boxKind(tpl, 'persona'), 'text');
  assert.equal(boxKind(tpl, 'interests'), 'strings');
  assert.equal(boxKind(tpl, 'boundaries'), 'strings', 'absent: one empty card');
  assert.equal(boxKind(tpl, 'speechStyle'), 'unsupported');
  assert.equal(boxKind(tpl, 'dialogueStyle'), 'text');
  assert.equal(boxKind(tpl, 'dialogueExamples'), 'examples');
  assert.equal(boxKind(null, 'persona'), 'text');
});

test('24b-6b the draft box: withField replaces ONE field and nothing else, and adds no canon for nothing', () => {
  const tpl = { name: 'x', persona: '甲', authorCanon: { kind: 'author_canon', settings: { a: 1, interests: ['b'] } } };
  const next = withField(tpl, 'interests', ['b', 'c']);
  assert.deepEqual(next, { ...tpl, authorCanon: { kind: 'author_canon', settings: { a: 1, interests: ['b', 'c'] } } });
  assert.deepEqual(tpl.authorCanon.settings.interests, ['b'], 'the input is not changed');
  assert.equal((withField(tpl, 'persona', '乙') as { persona: string }).persona, '乙');
  const bare = { name: 'x', persona: '甲' };
  assert.deepEqual(withField(bare, 'interests', undefined), bare, 'no canon is made for an absent value');
  assert.deepEqual((withField(bare, 'interests', ['d']) as unknown as { authorCanon: unknown }).authorCanon, {
    kind: 'author_canon',
    settings: { interests: ['d'] },
  });
});

test('24b-6b the draft box: inserting mid-text leaves the text before and after exactly as it was; at the end it takes its own line', (t) => {
  installFakeDom(t);
  const make = (persona: string, source = { text: '新来的话' }) =>
    draftBox({ template: { persona }, field: 'persona', source, character: '瓜瓜', readOnly: false, onEdit: () => {} });
  const area = (box: { root: unknown }) => one(box.root, 'textarea');
  const mid = make('甲乙丙丁');
  area(mid).selectionStart = area(mid).selectionEnd = 2;
  area(mid).dispatch('click');
  assert.equal(mid.insert(), true);
  assert.equal(area(mid).value, '甲乙新来的话丙丁');
  assert.equal(all(mid.root, 'textarea').length, 1, 'no new box');
  assert.equal(mid.dirty(), true);
  const end = make('甲乙丙丁');
  end.insert();
  assert.equal(area(end).value, '甲乙丙丁\n新来的话', 'never clicked in: at the end, on its own line');
  const empty = make('');
  empty.insert();
  assert.equal(area(empty).value, '新来的话', 'an empty field gets the note without a blank line');
  const trailing = make('甲\n');
  trailing.insert();
  assert.equal(area(trailing).value, '甲\n新来的话', 'no second blank line');
});

// ---- 版本历史 / 整页版本: the shared list ----------------------------------------------------------------------------------

const entry = (version: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  version,
  live: false,
  when: `2026-10-${String(version).padStart(2, '0')} 09:30 UTC`,
  by: null,
  origin: '发布',
  summary: `第 ${version} 版`,
  problem: null,
  ...over,
});

test('24b-6b the shared version list: the latest 5, newest first, the live one marked, the cut is named; the data is not touched', async (t) => {
  installFakeDom(t);
  const input = Array.from({ length: 7 }, (_, i) => entry(i + 1, { live: i === 6 }));
  const copy = structuredClone(input);
  const restored: number[] = [];
  const list = historyList({
    label: '整页版本',
    detail: () =>
      (globalThis as unknown as { document: { createElement: (t: string) => Node } }).document.createElement('div'),
    canRestore: () => true,
    restore: async (row) => void restored.push(row.version),
  });
  list.setEntries(input, 7);
  const rows = all(list.root, '.ot-row').map((r) => r.textContent);
  assert.equal(rows.length, HISTORY_SHOWN);
  assert.match(rows[0]!, /^v7现行/);
  assert.match(rows[4]!, /^v3/);
  assert.deepEqual(input, copy, 'the input list is not changed or cut');
  assert.match(one(list.root, '.vh-more').textContent, /共 7 个/);
  // 恢复此版本 → the question in that row → 确认恢复
  one(list.root, '[data-restore="5"]').click();
  assert.equal(one(list.root, '.vh-confirm-text').textContent, '以 v8 重新发布 v5 的内容');
  assert.equal(all(list.root, '.vh-confirm').length, 1);
  one(list.root, '[data-restore="3"]').click();
  assert.equal(all(list.root, '.vh-confirm').length, 1, 'one question at a time');
  assert.equal(one(list.root, '.vh-confirm-text').textContent, '以 v8 重新发布 v3 的内容');
  one(list.root, '[data-restore-go]').click();
  await flush();
  assert.deepEqual(restored, [3]);
  assert.equal(all(list.root, '.vh-confirm').length, 0, 'the question closes after the answer');
});

test('24b-6b the shared version list: without the permission there is no restore anywhere; 不可恢复 says why', (t) => {
  installFakeDom(t);
  const list = historyList({
    label: '版本历史',
    detail: () =>
      (globalThis as unknown as { document: { createElement: (t: string) => Node } }).document.createElement('div'),
    canRestore: () => false,
    restore: async () => {},
  });
  list.setEntries([entry(2, { live: true }), entry(1, { problem: '配音已不在' })], 2);
  assert.equal(all(list.root, '[data-restore]').length, 0);
  assert.match(list.root.textContent, /不可恢复/);
  assert.match(list.root.textContent, /配音已不在/);
});

// ---- 总览 warning → 系统状态 cleanup ------------------------------------------------------------------------------------------

test('24b-6b the route #/system/cleanup is only for 系统状态; no other page takes an id there', () => {
  assert.deepEqual(parseRoute('#/system/cleanup'), { page: 'system', id: 'cleanup' });
  assert.deepEqual(parseRoute('#/system/other'), { page: 'system', id: null });
  assert.deepEqual(parseRoute('#/overview/cleanup'), { page: 'overview', id: null });
  assert.deepEqual(parseRoute('#/characters/jojo'), { page: 'characters', id: 'jojo' });
  assert.equal(warningLine({ priceExpiring: 0, retentionFailing: 2, unknownNew: 0 }), '2 位玩家的清理失败');
});

test('24b-6b 总览: a failing cleanup links to the cleanup section of 系统状态; other warnings link to the page', async (t) => {
  const doc = installFakeDom(t);
  const mount = async (retentionFailing: number) => {
    const root = doc.createElement('div') as unknown as HTMLElement;
    const view = overviewView(root, {
      load: async () => ({
        day: '2026-11-20',
        today: { replies: 0, voiceReplies: 0, failedReplies: 0, spendMicros: 0 },
        warnings: { priceExpiring: 1, retentionFailing, unknownNew: 0 },
        stats: null as never,
      }),
      run: async (work) => {
        await work();
      },
      disposed: () => false,
    });
    await view.load();
    return root;
  };
  const failing = await mount(2);
  assert.equal(one(failing, 'a.ov-warn').getAttribute('href'), '#/system/cleanup');
  assert.match(one(failing, 'a.ov-warn').textContent, /2 位玩家的清理失败/);
  const other = await mount(0);
  assert.equal(one(other, 'a.ov-warn').getAttribute('href'), '#/system');
});

test('24b-6b 系统状态: the cleanup section is named, its table keeps no ids, and one plain line says what to do (no retry button)', async (t) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const scrolled: string[] = [];
  const view = systemView(root, {
    load: async () =>
      ({
        now: 1,
        version: { commit: 'abc1234', migrationSteps: 51, schemaVersion: 126, matches: true },
        flags: null,
        prices: [],
        budget: { available: false, error: 'x' },
        unknown: [],
        retention: {
          failing: 2,
          oldestAgeBucket: '1-7d',
          lastSuccessAt: 1,
          purging: 0,
          oldestPurgingMinutes: null,
          failures: [
            {
              code: 'WEB_RETENTION_FAILED',
              phase: 'clearDatabase',
              sub: 'audit_source',
              errorName: 'Error',
              messageShape: 'not <tok>',
              count: 3,
            },
          ],
        },
        metrics: [],
        security: {
          turnstile: true,
          failuresToday: 0,
          failuresLast7Days: 0,
          unavailableToday: 0,
          unavailableLast7Days: 0,
          rateOverflowToday: 0,
          unknownRefusals: 0,
        },
        warnings: { priceExpiring: 0, retentionFailing: 2, unknownNew: 0 },
      }) as never,
    renewPrices: async () => ({}) as never,
    topUp: async () => ({}) as never,
    isOwner: () => true,
    run: async (work) => {
      await work();
    },
    confirm: async () => true,
    toast: () => {},
    newRequestId: () => 'r',
    disposed: () => false,
  });
  await view.load();
  const section = one(root, '.system-section[data-section="cleanup"]');
  assert.ok(section, 'the cleanup section can be linked to');
  assert.equal(
    one(section, '.sys-cleanup-note').textContent,
    '系统每天会自动重试。连续失败说明需要修代码：把这张表交给开发。',
  );
  assert.equal(all(section, 'table tbody tr').length, 1, 'the failure table is there');
  assert.equal(all(section, 'button').length, 0, 'no retry button: the server has no retry action');
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}|@|玩家#/.test(section.textContent), 'no id, email or name');
  one(section, 'h3');
  (section as unknown as { scrollIntoView: () => void }).scrollIntoView = () => void scrolled.push('cleanup');
  view.reveal('cleanup');
  assert.deepEqual(scrolled, ['cleanup']);
});
