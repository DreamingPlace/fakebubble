import assert from 'node:assert/strict';
import test from 'node:test';
import { castKnowledge, compileCastViewDetailed } from '../../../../apps/server/cast/cast-compile.ts';
import { prepareCastFile } from '../../../../apps/server/cast/cast-file.ts';
import { castEntryIds } from '../../../../apps/server/cast/cast-validation.ts';
import type { CastDoc } from '../../../../packages/contracts/web-cast.ts';
import { sampleCast } from '../../../../tests/web/fixtures/cast-sample.ts';
import { CastAdminClient } from '../../src/services/cast-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';
import { castView, type CastViewHost } from '../../src/features/admin/cast/cast-view.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

/** 关系与故事 with 导入文件 / 导出文件 (Part 24b-5) on a scripted server that answers the three file routes. */
function page(t: test.TestContext, options: { permissions?: string[]; stale?: boolean } = {}) {
  const document = installFakeDom(t);
  const root = document.createElement('div') as unknown as FakeElement;
  const doc: CastDoc = sampleCast();
  const server = { revision: 7, doc };
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const downloads: { name: string; text: string; type: string | undefined }[] = [];
  const toasts: string[] = [];
  const counts = { characters: 15, people: 6, groups: 3, stories: 6, memes: 0 };
  const summary = (file: Record<string, any>, problems: unknown[] = []) => ({
    revision: server.revision,
    importable: problems.length === 0,
    created: [{ name: '林小满', matched: false }],
    problems,
    publishBlockers: [],
    warnings: [],
    views: [],
    summary: {
      charactersAdded: ['林小满'],
      charactersChanged: ['甲'],
      charactersRemoved: [],
      people: 2,
      ratings: 7,
      directions: 2,
      groups: 1,
      stories: 2,
      memes: 0,
      unchanged: false,
    },
    file,
  });
  let planned: unknown[] = [];
  const send = async (path: string, body: Record<string, unknown>): Promise<unknown> => {
    calls.push({ path, body });
    if (path === 'draft')
      return {
        revision: server.revision,
        digest: 'd',
        updatedAt: 1,
        doc: server.doc,
        counts,
        validation: { errors: [], warnings: [] },
      };
    if (path === 'versions') return { versions: [], latest: null };
    if (path === 'validate') return { revision: server.revision, validation: { errors: [], warnings: [] } };
    if (path === 'compile-preview')
      return {
        source: { kind: 'draft', revision: server.revision },
        size: 100,
        view: compileCastViewDetailed(server.doc, String(body.characterId)).view,
        knowledge: castKnowledge(server.doc, String(body.characterId)),
        dropOrder: [],
      };
    if (path === 'export')
      return { revision: server.revision, digest: 'd', file: { format: 'burbur-cast', version: 1, schema: 1 } };
    if (path === 'import-preview') return summary(body.file as Record<string, any>, planned);
    if (path === 'import-file') {
      if (options.stale) throw new InviteLocalApiError(409, 'CAST_REVISION_CONFLICT');
      server.revision++;
      return { revision: server.revision, digest: 'd', counts, created: 1, unchanged: false };
    }
    throw new Error(`unscripted ${path}`);
  };
  const granted = options.permissions ?? ['cast.read', 'cast.edit', 'cast.publish'];
  const host: CastViewHost = {
    api: new CastAdminClient(send, () => 'req-1'),
    can: (permission) => granted.includes(permission),
    run: async (work) => {
      await work();
    },
    status: () => {},
    confirm: async () => true,
    toast: (text) => toasts.push(text),
    disposed: () => false,
    download: (name, text, type) => downloads.push({ name, text, type }),
  };
  const view = castView(root as unknown as HTMLElement, host);
  const buttons = (label: string) => root.querySelectorAll('button').filter((b) => b.textContent === label);
  const choose = async (text: string, size = text.length) => {
    const picker = root.querySelector('[data-cast-file]')! as unknown as {
      files: unknown[];
      value: string;
      dispatch(type: string): void;
    };
    picker.files = [{ size, text: async () => text }];
    picker.dispatch('change');
    await flush();
  };
  return {
    root,
    view,
    calls,
    downloads,
    toasts,
    buttons,
    choose,
    plan: (problems: unknown[]) => (planned = problems),
    server,
  };
}

test('buttons: 导出文件 for anyone who can read, 导入文件 only with cast.edit; both are standard bar buttons', async (t) => {
  const editor = page(t);
  await editor.view.load();
  assert.equal(editor.buttons('导出文件').length, 1);
  assert.equal(editor.buttons('导入文件').length, 1);
  const bar = editor.root.querySelector('.cs-bar')!;
  assert.ok(
    bar.querySelectorAll('button').some((b) => b.textContent === '导入文件'),
    'in the bar, beside 保存草稿 / 发布',
  );
  const reader = page(t, { permissions: ['cast.read'] });
  await reader.view.load();
  assert.equal(reader.buttons('导出文件').length, 1);
  assert.equal(reader.buttons('导入文件').length, 0, 'a control the administrator may not use is not drawn');
});

test('export: the file the server builds is downloaded as it is, pretty-printed, named after the revision', async (t) => {
  const f = page(t);
  await f.view.load();
  f.buttons('导出文件')[0]!.click();
  await flush();
  assert.equal(f.downloads.length, 1);
  assert.equal(f.downloads[0]!.name, 'burbur-cast-修订7.json');
  assert.match(f.downloads[0]!.type ?? '', /application\/json/);
  assert.deepEqual(JSON.parse(f.downloads[0]!.text), { format: 'burbur-cast', version: 1, schema: 1 });
  assert.ok(f.calls.some((c) => c.path === 'export'));
});

test('import: choosing a file shows the summary and saves nothing; 确认导入 sends ONE import-file with the previewed revision', async (t) => {
  const f = page(t);
  await f.view.load();
  const file = { format: 'burbur-cast', version: 1, schema: 1, note: 'x' };
  await f.choose(JSON.stringify(file));
  const panel = f.root.querySelector('.cs-import')!;
  assert.equal(panel.hidden, false);
  const text = panel.textContent;
  assert.match(text, /新增角色 1：林小满/);
  assert.match(text, /改动的角色 1：甲/);
  assert.match(text, /人物 2 · 星级 7 条 · 称呼与相处 2 条 · 组合 1 · 故事 2 · 梗 0/);
  assert.match(text, /会同时建立 1 个角色草稿/);
  assert.match(text, /不会发布/);
  assert.deepEqual(
    f.calls.filter((c) => c.path === 'import-file'),
    [],
    'nothing was imported by choosing',
  );
  assert.deepEqual(f.calls.find((c) => c.path === 'import-preview')!.body, { file });
  f.buttons('确认导入')[0]!.click();
  await flush();
  const sent = f.calls.filter((c) => c.path === 'import-file');
  assert.equal(sent.length, 1);
  const { requestId, ...rest } = sent[0]!.body;
  assert.match(
    String(requestId),
    /^[0-9a-f-]{36}$/,
    'a request id chosen when the file was picked, so a retry is the same request',
  );
  assert.deepEqual(rest, { expectedRevision: 7, file });
  assert.equal(f.root.querySelector('.cs-import')!.hidden, true, 'the panel closes');
  assert.ok(f.calls.filter((c) => c.path === 'draft').length >= 2, 'the draft is read again after the import');
  assert.ok(f.toasts.some((x) => x.includes('已导入到草稿') && x.includes('还没有发布')));
});

test('import: problems are listed under the character’s name and block 确认导入', async (t) => {
  const f = page(t);
  await f.view.load();
  f.plan([
    {
      code: 'CAST_RATING_OUT_OF_GRID',
      path: 'ratings[c01][c02]',
      who: '甲',
      text: '评分必须在 0–5 星、以半星为单位（星级）',
    },
    { code: 'CAST_FILE_HEADER', path: 'file', who: null, text: '文件头不对' },
  ]);
  await f.choose('{"format":"x"}');
  const panel = f.root.querySelector('.cs-import')!;
  assert.match(panel.textContent, /2 个问题，必须先改文件/);
  assert.ok(panel.querySelectorAll('h4').some((h) => h.textContent === '甲'));
  assert.ok(panel.querySelectorAll('li').some((li) => li.textContent.includes('评分必须在')));
  const confirm = f.buttons('确认导入')[0]!;
  assert.equal(confirm.disabled, true);
  confirm.click();
  await flush();
  assert.equal(f.calls.filter((c) => c.path === 'import-file').length, 0);
  f.buttons('取消')[0]!.click();
  assert.equal(f.root.querySelector('.cs-import')!.hidden, true);
});

test('import: not a JSON file, too large, or unsaved edits - refused on the page, nothing sent', async (t) => {
  const f = page(t);
  await f.view.load();
  await f.choose('{not json');
  assert.ok(f.toasts.some((x) => x.includes('不是合法的 JSON')));
  await f.choose('{}', 2_000_000);
  assert.ok(f.toasts.some((x) => x.includes('文件太大')));
  f.view.state.dirty = true;
  await f.choose('{}');
  assert.ok(f.toasts.some((x) => x.includes('先保存草稿')));
  assert.equal(f.calls.filter((c) => c.path === 'import-preview').length, 0);
});

test('import: a stale revision is refused with a plain sentence and the page reloads the newer draft', async (t) => {
  const f = page(t, { stale: true });
  await f.view.load();
  await f.choose('{"format":"burbur-cast"}');
  f.buttons('确认导入')[0]!.click();
  await flush();
  assert.ok(f.toasts.some((x) => x.includes('被改过了') && x.includes('没有导入')));
  assert.equal(f.root.querySelector('.cs-import')!.hidden, true);
});

test('the shared preview speaks the same words as the page: a file problem names the character', () => {
  // The page prints what the server sends; this pins that what it sends for a real problem has a name and a sentence.
  const doc = sampleCast();
  const file = { format: 'burbur-cast', version: 1, ...structuredClone(doc) } as Record<string, any>;
  file.ratings.c01.c02 = 3.3;
  const prepared = prepareCastFile(file, {
    current: doc,
    known: castEntryIds(doc),
    lookup: { exists: () => true, deleted: () => false },
    newId: () => 'role-x',
  });
  const problem = prepared.problems.find((p) => p.code === 'CAST_RATING_OUT_OF_GRID')!;
  assert.equal(problem.who, doc.characters[0]!.identity.names[0]!.text);
  assert.match(problem.text, /半星/);
});
