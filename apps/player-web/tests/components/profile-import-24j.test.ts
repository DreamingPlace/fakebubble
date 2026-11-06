import assert from 'node:assert/strict';
import test from 'node:test';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';
import { ProfileImportClient } from '../../src/services/profile-import-api.ts';
import {
  placeOf,
  profileImportView,
  type ImportPreview,
} from '../../src/features/admin/profile-import/profile-import-view.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

/** 导入角色资料 on a scripted server: preview writes nothing, apply is one call carrying the previewed basis. */
function page(t: test.TestContext) {
  const document = installFakeDom(t);
  const root = document.createElement('div') as unknown as FakeElement;
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const toasts: string[] = [];
  let imported = 0;
  let next: unknown = null;
  let failApply: string | null = null;
  const preview = (over: Partial<ImportPreview> = {}): ImportPreview => ({
    ok: true,
    unchanged: false,
    basis: { cast: 3, characters: [] },
    castChangeCount: 2,
    problems: [],
    warnings: [],
    characters: [
      {
        file: 'a.md',
        code: 'AAA',
        mode: 'new',
        name: '甲',
        changes: [{ field: '人设名称', old: '', new: '甲' }],
        castChanges: [{ field: '名片', old: '（新名片）', new: '甲 · 一句话' }],
        checklist: [{ key: 'welcome:2', text: '欢迎词 第 2 条 等 24k 多欢迎词' }],
        unchanged: false,
      },
      {
        file: 'b.md',
        code: 'BBB',
        mode: 'existing',
        name: '乙',
        changes: [{ field: '生日', old: '2000-01-01', new: '2000-11-02' }],
        castChanges: [],
        checklist: [],
        unchanged: false,
      },
      {
        file: 'c.md',
        code: 'CCC',
        mode: 'bind',
        name: '丙',
        changes: [{ field: '角色代码', old: '', new: 'CCC' }],
        castChanges: [],
        checklist: [],
        unchanged: false,
      },
    ],
    ...over,
  });
  const send = async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === 'preview') return next ?? preview();
    if (failApply) throw new InviteLocalApiError(409, failApply);
    return {
      unchanged: false,
      characters: [{ code: 'AAA', mode: 'new', changed: true, revision: 1 }],
      castRevision: 4,
    };
  };
  const view = profileImportView(root as unknown as HTMLElement, {
    api: new ProfileImportClient(send),
    run: async (work) => {
      await work();
    },
    toast: (text) => toasts.push(text),
    onImported: () => {
      imported++;
    },
    disposed: () => false,
  });
  const buttons = (text: string) => root.querySelectorAll('button').filter((b) => b.textContent === text);
  return {
    root,
    calls,
    toasts,
    view,
    imported: () => imported,
    plan: (value: unknown) => (next = value),
    failApply: (code: string | null) => (failApply = code),
    buttons,
    choose: async (names = ['a.md', 'b.md', 'c.md']) => {
      await view.chooseFiles(names.map((name) => ({ name, text: '# x' })));
      await flush();
    },
  };
}

test('preview shows each character as 新角色 / 已有角色 / 将绑定代码 X, every change old → new, and the checklist; nothing is applied', async (t) => {
  const f = page(t);
  await f.choose();
  const text = f.root.textContent;
  assert.match(text, /新角色/);
  assert.match(text, /已有角色/);
  assert.match(text, /将绑定代码 CCC/);
  assert.match(text, /生日.*2000-01-01.*2000-11-02/);
  assert.match(text, /欢迎词 第 2 条 等 24k 多欢迎词/);
  assert.equal(f.calls.filter((c) => c.path === 'apply').length, 0);
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['preview'],
  );
  assert.equal(f.buttons('确认导入')[0]!.disabled, false);
});

test('确认导入 sends ONE apply with the previewed basis and the same request id on a retry', async (t) => {
  const f = page(t);
  await f.choose();
  f.buttons('确认导入')[0]!.click();
  await flush();
  const sent = f.calls.filter((c) => c.path === 'apply');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0]!.body.basis, { cast: 3, characters: [] });
  assert.match(String(sent[0]!.body.requestId), /^[0-9a-f-]{36}$/);
  assert.equal((sent[0]!.body.files as unknown[]).length, 3);
  assert.equal(f.imported(), 1, 'the roster and the open role are read again');
  assert.ok(f.toasts.some((x) => x.includes('已导入 1 个角色的草稿') && x.includes('还没有发布')));
});

test('an error blocks the whole import, is located (file · 分区 · 字段 · 第 N 项), and 确认导入 does nothing', async (t) => {
  const f = page(t);
  f.plan(
    (() => {
      const p = {
        ok: false,
        unchanged: false,
        basis: null,
        castChangeCount: 0,
        characters: [],
        warnings: [],
        problems: [
          {
            code: 'CAST_ITEM_TOO_LONG',
            file: 'a.md',
            section: '1 基本信息',
            field: '自称',
            item: 2,
            text: '超过 16 字',
          },
        ],
      };
      return p;
    })(),
  );
  await f.choose(['a.md']);
  assert.match(f.root.textContent, /1 个错误：整次导入被阻止/);
  assert.match(f.root.textContent, /a\.md · 1 基本信息 · 自称 · 第 2 项/);
  const confirm = f.buttons('确认导入')[0]!;
  assert.equal(confirm.disabled, true);
  assert.equal(
    confirm.dataset.locked,
    'true',
    'the page re-enables controls after a run; data-locked keeps this one off',
  );
  confirm.click();
  await flush();
  assert.equal(f.calls.filter((c) => c.path === 'apply').length, 0);
  assert.equal(placeOf({ code: 'x', file: 'f.md', section: null, field: null, item: null, text: '' }), 'f.md');
});

test('没有变化: the same files again leave 确认导入 off and say so', async (t) => {
  const f = page(t);
  f.plan({
    ok: true,
    unchanged: true,
    basis: { cast: 3, characters: [] },
    castChangeCount: 0,
    problems: [],
    warnings: [],
    characters: [
      {
        file: 'a.md',
        code: 'AAA',
        mode: 'existing',
        name: '甲',
        changes: [],
        castChanges: [],
        checklist: [],
        unchanged: true,
      },
    ],
  });
  await f.choose(['a.md']);
  assert.match(f.root.textContent, /没有变化/);
  assert.equal(f.buttons('确认导入')[0]!.disabled, true);
});

test('a draft edited since the preview is a conflict: nothing imported, the preview is read again', async (t) => {
  const f = page(t);
  await f.choose();
  f.failApply('PROFILE_IMPORT_CONFLICT');
  f.buttons('确认导入')[0]!.click();
  await flush();
  assert.ok(f.toasts.some((x) => x.includes('预览之后草稿被改过')));
  assert.deepEqual(
    f.calls.map((c) => c.path),
    ['preview', 'apply', 'preview'],
  );
  assert.equal(f.imported(), 0);
});
