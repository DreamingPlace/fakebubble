// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { originText, versionHistory, type HistoryHost } from '../../src/features/admin/history/version-history.ts';
import { readableGroups } from '../../src/features/admin/history/readable.ts';
import { permissionMatrixEditor, PERMISSION_GROUPS } from '../../src/features/admin/permission-matrix.ts';
import { RESTORE_PROBLEM_TEXT, type VersionRow } from '../../../../packages/contracts/web-character-history.ts';
import type { CharacterProfile, VersionSnapshot } from '../../src/services/character-admin-api.ts';
import type { FakeElement } from './fake-dom.ts';
import { flush, installFakeDom } from './fake-dom.ts';

/** 版本历史 (Part 24f) on the fake DOM: what is listed, who sees 恢复此版本, the one confirm, the exact request. */
const el = (node: unknown) => node as FakeElement;
const AT = Date.parse('2026-10-24T09:30:00Z');
const rows: VersionRow[] = [
  {
    version: 3,
    publishedAt: AT,
    by: 'owner',
    origin: { kind: 'restore', from: 1 },
    summary: '改动：人设',
    live: true,
    restorable: false,
    problem: null,
  },
  {
    version: 2,
    publishedAt: AT - 86_400_000,
    by: 'admin',
    origin: { kind: 'colour' },
    summary: '只改了主色',
    live: false,
    restorable: true,
    problem: null,
  },
  {
    version: 1,
    publishedAt: null,
    by: 'system',
    origin: { kind: 'publish' },
    summary: '初始版本',
    live: false,
    restorable: false,
    problem: 'CLIP_MISSING',
  },
];
const profile = (persona: string, color?: string): CharacterProfile =>
  ({
    template: { id: 'jojo', name: '乔', version: 1, fictional: true, persona, schedule: {} },
    presentation: {
      displayName: '乔乔',
      publicDescription: '',
      welcomes: [{ id: 'w1', text: '来啦', weight: 100 }],
      ...(color ? { color } : {}),
    },
  }) as unknown as CharacterProfile;

function fixture(t: { after(fn: () => void): void }, owner: boolean, extra: Partial<HistoryHost['api']> = {}) {
  const doc = installFakeDom(t);
  const root = doc.createElement('div');
  const log = { restore: [] as unknown[], status: [] as string[], restored: [] as unknown[], loads: 0 };
  const api = {
    history: async () => {
      log.loads++;
      return { characterId: 'jojo', live: 3, versions: rows };
    },
    historyVersion: async (_id: string, version: number): Promise<VersionSnapshot> => ({
      ...rows.find((r) => r.version === version)!,
      characterId: 'jojo',
      profile: profile('第一版', '#112233'),
      profileHash: 'a'.repeat(64),
      contentKey: 'b'.repeat(64),
      liveProfile: profile('现在的人设'),
    }),
    restore: async (_id: string, input: unknown) => {
      log.restore.push(input);
      return { version: 4, restoredFrom: 2, publishedAt: AT };
    },
    ...extra,
  } as HistoryHost['api'];
  const host: HistoryHost = {
    api,
    isOwner: () => owner,
    status: (text) => void log.status.push(text),
    run: (work) => work(),
    disposed: () => false,
    onRestored: (id, version) => void log.restored.push([id, version]),
  };
  const view = versionHistory(root as unknown as HTMLElement, host);
  return { doc, root, view, log };
}
// Named exception (Part 24b-6b): the list is the console's open-below table (.ot-row), not a <table>; a row opens its detail below it.
const bodyRows = (root: unknown) => el(root).querySelectorAll('.vh .ot-row');
const openRow = async (root: unknown, index: number) => {
  bodyRows(root)[index]!.click();
  await flush();
  await flush();
};
const detailOf = (root: unknown, version: number) => el(root).querySelector(`[data-key="${version}"] .ot-panel`)!;
const ask = async (root: unknown, version: number) => {
  el(root).querySelector(`[data-restore="${version}"]`)!.click();
  await flush();
};

test('the list shows every version newest first: number, UTC time, role, origin, summary; the live one is marked', async (t) => {
  const f = fixture(t, true);
  await f.view.load('jojo');
  const lines = bodyRows(f.root).map((tr) => tr.textContent);
  assert.equal(lines.length, 3);
  assert.equal(el(f.root).querySelector('.vh-more')!.hidden, true, 'three versions: nothing was cut off');
  assert.match(lines[0]!, /v3当前2026-10-24 09:30 UTC主管理员恢复自 v1改动：人设/); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「v3现行」
  assert.match(lines[1]!, /v22026-10-23 09:30 UTC管理员仅改主色只改了主色/);
  assert.match(lines[2]!, /v1无记录系统导入发布初始版本/);
  assert.equal(originText({ kind: 'publish' }), '发布');
  assert.ok(!/@/.test(el(f.root).textContent));
});

test('the owner sees 恢复此版本 on a restorable non-live version only; a lost version says 不可恢复 and the reason', async (t) => {
  const f = fixture(t, true);
  await f.view.load('jojo');
  const buttons = el(f.root).querySelectorAll('[data-restore]');
  assert.deepEqual(
    buttons.map((b) => b.getAttribute('data-restore')),
    ['2'],
  );
  assert.match(bodyRows(f.root)[2]!.textContent, /不可恢复/);
  assert.match(bodyRows(f.root)[2]!.textContent, new RegExp(RESTORE_PROBLEM_TEXT.CLIP_MISSING));
});

test('a non-owner sees the history and the same 不可恢复 note, but no restore button anywhere, not even in a snapshot', async (t) => {
  const f = fixture(t, false);
  await f.view.load('jojo');
  assert.equal(el(f.root).querySelectorAll('[data-restore]').length, 0);
  assert.equal(
    el(f.root).querySelector('.vh-note[role="status"]')!.hidden,
    true,
    'no explanatory sentence on the page',
  );
  await openRow(f.root, 1);
  assert.equal(el(f.root).querySelectorAll('[data-restore]').length, 0);
  assert.match(el(f.root).textContent, /完整快照（只读）/);
});

test('a snapshot is read only, with the 人设 / 网页展示 / 完整模板 groups against live and the version number set aside', async (t) => {
  const f = fixture(t, true);
  await f.view.load('jojo');
  await openRow(f.root, 1);
  // Named exception (Part 24b-6b): the snapshot opens BELOW its row (V3), not in a side drawer; the checks on its content are unchanged.
  const drawer = detailOf(f.root, 2);
  assert.equal(drawer.getAttribute('data-state'), 'open');
  assert.equal(
    el(f.root).querySelectorAll('.admin-drawer, [role="dialog"], .admin-dialog').length,
    0,
    'no drawer, no dialog',
  );
  assert.equal(drawer.querySelectorAll('textarea').length + drawer.querySelectorAll('input').length, 0);
  assert.equal(
    drawer.querySelectorAll('.pd-grid').length,
    2,
    '人设 and 网页展示 differ here; the template fields do not (the number is not content)',
  );
  assert.ok(!/[{}]|"displayName"|"template"/.test(drawer.textContent), 'readable fields, never raw JSON');
  assert.match(drawer.textContent, /网页展示名：|网页展示名/);
  assert.match(drawer.textContent, /设定生日/);
  assert.match(drawer.textContent, /与正式版本的差异/); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「与现行版本的差异」
  const groups = readableGroups(profile('甲'), {
    ...profile('甲'),
    template: { ...profile('甲').template, version: 9 },
  });
  assert.deepEqual(
    groups.filter(([, a, b]) => a !== b),
    [],
    'only the number differs: no difference',
  );
});

test('restore asks once IN THE ROW, in the words of the spec, then sends one request with the live version and the version asked for', async (t) => {
  const f = fixture(t, true);
  await f.view.load('jojo');
  await ask(f.root, 2);
  // Named exception (Part 24b-6b): the question is the row's own inline confirm (no dialog element); 确认恢复 is that row's solid button.
  const row = el(f.root).querySelector('[data-key="2"]')!;
  const confirm = row.querySelector('.vh-confirm')!;
  assert.equal(confirm.querySelector('.vh-confirm-text')!.textContent, '以 v4 重新发布 v2 的内容');
  assert.equal(el(f.root).querySelectorAll('.admin-dialog, dialog, [role="dialog"]').length, 0, 'no dialog is opened');
  assert.equal(f.log.restore.length, 0, 'nothing is sent before the answer');
  const go = confirm.querySelector('[data-restore-go]')!;
  assert.equal(go.className, 'admin-primary', '确认恢复 is the primary action');
  assert.equal(go.textContent, '确认恢复');
  assert.equal(confirm.querySelector('[data-restore-cancel]')!.textContent, '取消');
  go.click();
  await flush();
  await flush();
  assert.equal(f.log.restore.length, 1);
  assert.deepEqual({ ...(f.log.restore[0] as object), requestId: 'x' }, { requestId: 'x', version: 2, liveVersion: 3 });
  assert.match((f.log.restore[0] as { requestId: string }).requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(f.log.restored, [['jojo', 4]]);
  assert.match(f.log.status.at(-1)!, /v2 的内容已发布为新版本 v4/);
  assert.equal(f.log.loads, 2, 'the list is read again after the restore');
  // Cancel sends nothing, and closes the question.
  await ask(f.root, 2);
  el(f.root).querySelector('[data-restore-cancel]')!.click();
  await flush();
  assert.equal(f.log.restore.length, 1);
  assert.equal(el(f.root).querySelectorAll('.vh-confirm').length, 0);
  assert.ok(el(f.root).querySelector('[data-restore="2"]'), '恢复此版本 is back');
});

test('a character with 7 versions lists only the latest 5, newest first, and says the older ones are kept', async (t) => {
  const many: VersionRow[] = Array.from({ length: 7 }, (_, i) => ({
    version: 7 - i,
    publishedAt: AT - i * 86_400_000,
    by: 'admin' as const,
    origin: { kind: 'publish' as const },
    summary: `第 ${7 - i} 次`,
    live: i === 0,
    restorable: i !== 0,
    problem: null,
  }));
  const f = fixture(t, true, { history: async () => ({ characterId: 'jojo', live: 7, versions: many }) });
  await f.view.load('jojo');
  const lines = bodyRows(f.root).map((tr) => tr.textContent);
  assert.equal(lines.length, 5);
  assert.match(lines[0]!, /^v7当前/); // Named exception (Part 24b-7d round 2, docs/ADMIN_COPY.md): was 「v7现行」
  assert.match(lines[4]!, /^v3/);
  assert.ok(!lines.some((line) => /^v[12]/.test(line)), 'v1 and v2 are not listed');
  assert.match(el(f.root).querySelector('.vh-more')!.textContent, /只列出最近 5 个版本，共 7 个/);
  assert.equal(el(f.root).querySelector('.vh-more')!.hidden, false);
});

test('opening a second row closes the first; an unanswered restore question goes with it; the detail sits under its own row', async (t) => {
  const f = fixture(t, true);
  await f.view.load('jojo');
  await ask(f.root, 2);
  await openRow(f.root, 0);
  assert.equal(
    el(f.root).querySelectorAll('.vh-confirm').length,
    0,
    'the question is dropped when another row is looked at',
  );
  assert.equal(detailOf(f.root, 3).getAttribute('data-state'), 'open');
  await openRow(f.root, 1);
  assert.equal(detailOf(f.root, 3).getAttribute('data-state'), 'closed');
  assert.equal(detailOf(f.root, 2).getAttribute('data-state'), 'open');
});

test('an uncertain failure keeps the request id, so the same click asks the same question; a refusal ends the attempt and says why', async (t) => {
  const seen: string[] = [];
  let mode: 'lost' | 'busy' | 'ok' = 'lost';
  const f = fixture(t, true, {
    restore: async (_id: string, input: { requestId: string }) => {
      seen.push(input.requestId);
      if (mode === 'lost') throw new Error('network');
      if (mode === 'busy') throw Object.assign(new Error('x'), { code: 'CHARACTER_PUBLICATION_BUSY' });
      return { version: 4, restoredFrom: 2, publishedAt: AT };
    },
  });
  await f.view.load('jojo');
  // Named exception (Part 24b-6b): the answer is 确认恢复 in the row, not a dialog button.
  const again = async () => {
    el(f.root).querySelector('[data-restore]')!.click();
    await flush();
    el(f.root).querySelector('[data-restore-go]')!.click();
    await flush();
    await flush();
  };
  await again();
  await again();
  assert.equal(seen[0], seen[1], 'same id after a lost answer');
  assert.match(el(f.root).querySelector('.vh-note[role="status"]')!.textContent, /没有改动任何版本/);
  mode = 'busy';
  await again();
  assert.equal(seen[2], seen[0], 'still the same attempt');
  assert.match(el(f.root).querySelector('.vh-note[role="status"]')!.textContent, /未结束的玩家任务.*不会取消或重发/);
  mode = 'ok';
  await again();
  assert.notEqual(seen[3], seen[0], 'a definite refusal ended the attempt: the next one is a new request');
});

test('delete is no longer a permission row: 管理员与权限 has no 删除角色, an old stored grant is kept and shown as 已失效', (t) => {
  installFakeDom(t);
  assert.ok(!PERMISSION_GROUPS.flatMap((g) => g.items).some((i) => i.item === ('characters.delete' as never)));
  const doc = (globalThis as unknown as { document: { createElement: (t: string) => unknown } }).document;
  const root = doc.createElement('div') as FakeElement;
  const editor = permissionMatrixEditor(
    root as unknown as HTMLElement,
    ['characters.read:*', 'characters.delete:*'] as never,
  );
  assert.equal(root.querySelectorAll('[data-permission="characters.delete"]').length, 0);
  assert.match(root.textContent, /删除角色（已失效）/);
  assert.ok(!/characters\.delete/.test(root.textContent), 'never the raw key');
  assert.deepEqual(editor.value(), ['characters.delete:*', 'characters.read:*'], 'untouched: saved exactly as loaded');
  assert.equal(root.querySelectorAll('[data-permission="characters.delete"]').length, 0);
});
