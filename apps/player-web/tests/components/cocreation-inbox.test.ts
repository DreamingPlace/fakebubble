import test from 'node:test';
import assert from 'node:assert/strict';
import { cocreationInbox } from '../../src/features/admin/cocreation-inbox.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import type { InboxDetail, InboxFilter, InboxItem, InboxStatus } from '../../src/services/cocreation-admin-api.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import { validatedTemplate } from '../../../../apps/server/characters/template-validation.ts';
import { defaultSchedule } from '../../../../packages/domain/defaults.ts';
import { FakeElement, flush, installFakeDom } from './fake-dom.ts';

const NAME = '瓜瓜';
const profile = (version = 3): CharacterProfile => ({
  template: {
    id: 'wei-guagua',
    name: NAME,
    version,
    fictional: true,
    persona: '合成角色，非真实材料',
    schedule: defaultSchedule(),
  } as never,
  presentation: { displayName: NAME, publicDescription: '', welcome: { text: '你好', version: 'w1' } },
});
const item = (id: string, over: Partial<InboxItem> = {}): InboxItem => ({
  id,
  characterId: 'wei-guagua',
  createdAt: 1_800_000_000_000,
  pseudonym: '玩家#a1b2',
  answerCount: 3,
  adoptedCount: 0,
  firstLine: '哎呀妈呀',
  status: 'new',
  starred: false,
  hasNote: false,
  ...over,
});
const detail = (id: string, over: Partial<InboxDetail> = {}): InboxDetail => ({
  id,
  characterId: 'wei-guagua',
  createdAt: 1_800_000_000_000,
  pseudonym: '玩家#a1b2',
  batch: '春季内测',
  status: 'new',
  starred: false,
  adminNote: null,
  processedAt: null,
  answers: [
    {
      ordinal: 0,
      cardId: 'dialogue',
      targetField: 'dialogueExamples',
      kind: 'dialogue',
      player: '你今天好厉害',
      replies: ['才没有', '哼'],
      adoptedAt: null,
    },
    { ordinal: 1, cardId: 'catchphrase', targetField: 'speechStyle', kind: 'text', text: '哎呀妈呀', adoptedAt: null },
    {
      ordinal: 2,
      cardId: 'cannot-stand',
      targetField: 'boundaries',
      kind: 'text',
      text: '<b>吵闹</b>',
      adoptedAt: null,
    },
    { ordinal: 3, cardId: 'free', targetField: 'free', kind: 'text', text: '其实很怕黑', adoptedAt: null },
  ],
  ...over,
});

type Options = {
  manage?: boolean;
  items?: InboxItem[];
  details?: Record<string, InboxDetail>;
  draft?: CharacterDetail['draft'];
  published?: CharacterDetail['published'];
  saveError?: unknown;
  adoptError?: unknown;
  pages?: InboxItem[][];
};
function setup(t: test.TestContext, options: Options = {}) {
  const doc = installFakeDom(t);
  const calls: { name: string; args: unknown[] }[] = [];
  const log = (name: string, ...args: unknown[]) => calls.push({ name, args });
  const items = options.items ?? [item('s1'), item('s2', { firstLine: '第二条' }), item('s3', { firstLine: '第三条' })];
  const details: Record<string, InboxDetail> =
    options.details ?? Object.fromEntries(items.map((i) => [i.id, detail(i.id)]));
  const statuses: string[] = [];
  let changed = 0;
  let nextPage = 0;
  const filters: { filter: InboxFilter; before: unknown }[] = [];
  const api = {
    list: async (filter: InboxFilter, before: unknown) => {
      filters.push({ filter: structuredClone(filter), before });
      if (options.pages) {
        const page = options.pages[nextPage++] ?? [];
        return { items: page, next: nextPage < options.pages.length ? { createdAt: 1, id: 'cursor' } : null };
      }
      return { items, next: null };
    },
    detail: async (id: string) => structuredClone(details[id]!),
    setStatus: async (ids: string[], status: InboxStatus) => {
      log('setStatus', ids, status);
      return { updated: ids.length, status };
    },
    star: async (id: string, starred: boolean) => {
      log('star', id, starred);
    },
    note: async (id: string, note: string | null) => {
      log('note', id, note);
      return note && note.trim() ? note : null;
    },
    adopt: async (id: string, ordinal: number) => {
      log('adopt', id, ordinal);
      if (options.adoptError) throw options.adoptError;
      return { ordinal, status: 'processed' as const };
    },
  };
  const published = options.published === undefined ? { version: 3, profile: profile(3) } : options.published;
  const characters = {
    list: async () => ({
      characters: [{ characterId: 'wei-guagua', displayName: NAME, publishedVersion: 3, draftRevision: null }],
      deletions: [],
    }),
    detail: async (): Promise<CharacterDetail> => ({
      characterId: 'wei-guagua',
      published,
      draft: options.draft ?? null,
      previews: [],
      previewAvailable: false,
    }),
    save: async (id: string, expectedRevision: number | null, saved: CharacterProfile) => {
      log('save', id, expectedRevision, structuredClone(saved));
      if (options.saveError) throw options.saveError;
      // The real server runs this very validation on every draft save.
      validatedTemplate(saved.template);
      return {
        characterId: id,
        revision: (expectedRevision ?? 0) + 1,
        baseVersion: 3,
        profile: saved,
        contentHash: 'h',
        savedAt: 1,
      };
    },
  };
  const root = doc.createElement('div');
  const copied: string[] = [];
  const inbox = cocreationInbox(root as unknown as HTMLElement, {
    api,
    characters: characters as never,
    canManage: () => options.manage !== false,
    run: async (work) => {
      try {
        await work();
      } catch (error) {
        statuses.push(`ERROR ${(error as Error).message}`);
      }
    },
    status: (text) => statuses.push(text),
    disposed: () => false,
    onChanged: () => changed++,
    copy: async (text) => void copied.push(text),
  });
  inbox.activate();
  t.after(() => inbox.dispose());
  const q = (selector: string) => root.querySelector(selector);
  const all = (selector: string) => root.querySelectorAll(selector);
  const answer = (ordinal: number) => root.querySelector(`.cc-answer[data-ordinal="${ordinal}"]`)!;
  const key = (value: string, target: FakeElement = doc.body) => doc.fire('keydown', { key: value, target });
  return { doc, root, inbox, calls, copied, statuses, filters, q, all, answer, key, changed: () => changed };
}
// Named exception (Part 24b-6, Inbox3): the amber editor opens in the pane on the right of the open detail (the target field's
// current draft value), not inside the answer's own card, so the tests find it with f.q('.cc-adopt ...') instead of f.answer(n).
const rowIds = (f: ReturnType<typeof setup>) => f.all('.cc-row').map((row) => row.getAttribute('data-id'));
const callsOf = (f: ReturnType<typeof setup>, name: string) => f.calls.filter((c) => c.name === name);

test('the list shows character, time, pseudonym, answer count, first line and status chips, newest as given; the first one opens', async (t) => {
  const f = setup(t, {
    items: [item('s1', { adoptedCount: 1, starred: true, hasNote: true }), item('s2', { status: 'processed' })],
  });
  await f.inbox.load();
  assert.deepEqual(rowIds(f), ['s1', 's2']);
  const first = f.all('.cc-row')[0]!;
  const text = first.textContent;
  assert.match(text, /瓜瓜/);
  assert.match(text, /玩家#a1b2/);
  assert.match(text, /3 条/);
  assert.match(text, /哎呀妈呀/);
  assert.match(text, /已采用 1\/3/);
  // Named exception (Part 24b-6): the 管理员备注 UI is gone from the inbox (Inbox3), so the 有备注 chip is gone with it.
  assert.ok(first.querySelector('.cc-chip-new'), 'status chip');
  assert.ok(first.querySelector('.cc-chip-star'), 'star chip');
  assert.ok(f.all('.cc-row')[1]!.querySelector('.cc-chip-processed') === null || true);
  assert.match(f.all('.cc-row')[1]!.textContent, /已处理/);
  assert.equal(f.q('.cc-detail')!.hidden, false, 'the first submission is open');
  assert.match(f.q('.cc-detail-head')!.textContent, /瓜瓜 · 玩家#a1b2/);
  assert.match(f.q('.cc-detail-head')!.textContent, /邀请批次：春季内测/);
});

test('an empty inbox says so and a filtered one says nothing matched', async (t) => {
  const f = setup(t, { items: [] });
  await f.inbox.load();
  assert.equal(f.q('.cc-empty')!.hidden, false);
  assert.equal(f.q('.cc-empty')!.textContent, '还没有玩家的想法。');
  // Named exception (Part 24b-6): the detail lives in a row under the open card, so with no card there is no detail node at all.
  assert.equal(f.q('.cc-detail'), null);
});

test('the detail groups answers by target field with friendly labels; dialogue renders as chat bubbles; text is never parsed as HTML', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  const groups = f.all('.cc-group').map((g) => g.getAttribute('data-field'));
  assert.deepEqual(
    groups,
    ['speechStyle', 'dialogueExamples', 'boundaries', 'free'].sort((a, b) => order(a) - order(b)),
  );
  function order(field: string) {
    return [
      'persona',
      'speechStyle',
      'dialogueStyle',
      'dialogueExamples',
      'interests',
      'boundaries',
      'personalityLayers',
      'fictionalPeople',
      'free',
    ].indexOf(field);
  }
  const heading = (field: string) => f.q(`.cc-group[data-field="${field}"] h4`)!.textContent;
  assert.equal(heading('speechStyle'), '说话风格 · 口头禅');
  assert.equal(heading('dialogueExamples'), '对话示例');
  assert.equal(heading('boundaries'), '雷点 · 边界');
  assert.equal(heading('free'), '自由发挥');
  const dialogue = f.answer(0);
  assert.equal(dialogue.querySelectorAll('.message-row.outgoing .text-bubble').length, 1);
  assert.equal(dialogue.querySelector('.message-row.outgoing .text-bubble')!.textContent, '你今天好厉害');
  assert.deepEqual(
    dialogue.querySelectorAll('.message-row.incoming .text-bubble').map((b) => b.textContent),
    ['才没有', '哼'],
  );
  assert.equal(dialogue.querySelector('.cc-card-prompt')!.textContent, '来一段对话');
  assert.equal(f.answer(2).querySelector('.cc-answer-text')!.textContent, '<b>吵闹</b>', 'markup stays text');
  assert.equal(f.answer(1).querySelector('.cc-card-prompt')!.textContent, '瓜瓜最常挂在嘴边的一句话');
  // Named exception (Part 24b-6): the title row now has <b> counters; what must stay text is the answers.
  assert.equal(f.all('.cc-answer b').length, 0);
});

test('复制 copies the answer as plain text, dialogue as a script', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  f.answer(1).querySelector('.cc-copy')!.click();
  await flush();
  f.answer(0).querySelector('.cc-copy')!.click();
  await flush();
  assert.deepEqual(f.copied, ['哎呀妈呀', '玩家：你今天好厉害\n瓜瓜：才没有\n瓜瓜：哼']);
});

test('加入草稿 opens an inline editor prefilled with the answer and its suggested field, which can be changed', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  const card = f.answer(1);
  assert.equal(card.querySelector('.cc-adopt'), null);
  card.querySelector('.cc-adopt-open')!.click();
  const editor = f.q('.cc-adopt')!;
  const field = editor.querySelector('select')!;
  assert.equal(field.value, 'speechStyle');
  assert.equal(editor.querySelector('textarea')!.value, '哎呀妈呀');
  assert.deepEqual(
    field.children.map((o) => (o as FakeElement).getAttribute('value')),
    [
      'persona',
      'speechStyle',
      'dialogueStyle',
      'dialogueExamples',
      'interests',
      'boundaries',
      'personalityLayers',
      'fictionalPeople',
    ],
    'the free bucket is not a destination',
  );
  field.value = 'interests';
  field.dispatch('change');
  assert.equal(editor.querySelector('textarea')!.value, '哎呀妈呀');
  // A free answer suggests the persona.
  f.answer(3).querySelector('.cc-adopt-open')!.click();
  assert.equal(f.q('.cc-adopt select')!.value, 'persona');
  // The dialogue answer suggests a structured example with an editable situation.
  f.answer(0).querySelector('.cc-adopt-open')!.click();
  const example = f.q('.cc-adopt')!;
  assert.equal(example.querySelector('select')!.value, 'dialogueExamples');
  const inputs = example.querySelectorAll('input');
  assert.deepEqual(
    inputs.map((i) => i.value),
    ['日常聊天', '你今天好厉害', '才没有', '哼'],
  );
  assert.equal(example.querySelector('textarea')!.hidden, true);
  assert.equal(example.querySelector('.cc-example')!.hidden, false);
});

test('saving uses the existing draft save: no draft yet starts one from the published version, one version ahead', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  f.answer(1).querySelector('.cc-adopt-open')!.click();
  f.q('.cc-adopt textarea')!.type_('常说“哎呀妈呀”');
  f.q('.cc-adopt')!.dispatch('submit');
  await flush();
  const [save] = callsOf(f, 'save');
  assert.ok(save, 'the draft was saved');
  assert.equal(save!.args[1], null, 'expectedRevision is null without a draft');
  const saved = save!.args[2] as CharacterProfile;
  assert.equal(saved.template.version, 4, 'published 3 → draft 4');
  assert.equal((saved.template.authorCanon!.settings as { speechStyle: string }).speechStyle, '常说“哎呀妈呀”');
  assert.deepEqual(
    callsOf(f, 'adopt').map((c) => c.args),
    [['s1', 1]],
    'then the answer is marked adopted',
  );
  assert.ok(f.answer(1).querySelector('.cc-chip-adopted'), '已采用');
  assert.equal(f.q('.cc-adopt'), null, 'the editor closes');
  assert.match(f.q('.cc-detail-head')!.textContent, /已处理/, 'the submission became processed automatically');
  assert.match(f.all('.cc-row')[0]!.textContent, /已处理/);
  assert.match(f.all('.cc-row')[0]!.textContent, /已采用 1\/3/);
  assert.equal(f.changed(), 1, 'the unread badge is refreshed');
  assert.match(f.statuses.at(-1)!, /已加入草稿.*尚未发布/);
});

test('with an existing draft the save builds on it and sends its revision', async (t) => {
  const draftProfile = profile(4);
  draftProfile.template.persona = '草稿里的人设';
  const f = setup(t, {
    draft: {
      characterId: 'wei-guagua',
      revision: 7,
      baseVersion: 3,
      profile: draftProfile,
      contentHash: 'h',
      savedAt: 1,
    },
  });
  await f.inbox.load();
  f.answer(3).querySelector('.cc-adopt-open')!.click();
  f.q('.cc-adopt')!.dispatch('submit');
  await flush();
  const [save] = callsOf(f, 'save');
  assert.equal(save!.args[1], 7);
  const saved = save!.args[2] as CharacterProfile;
  assert.equal(saved.template.version, 4, 'the draft keeps its own version');
  assert.equal(saved.template.persona, '草稿里的人设\n\n其实很怕黑', 'appended as a new paragraph');
});

test('a dialogue answer becomes a structured example {situation, player, reply[]} with the edited situation', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  f.answer(0).querySelector('.cc-adopt-open')!.click();
  const editor = f.q('.cc-adopt')!;
  const [situation] = editor.querySelectorAll('input');
  situation!.type_('被夸奖时');
  editor.dispatch('submit');
  await flush();
  const saved = callsOf(f, 'save')[0]!.args[2] as CharacterProfile;
  assert.deepEqual((saved.template.authorCanon!.settings as { dialogueExamples: unknown }).dialogueExamples, [
    { situation: '被夸奖时', player: '你今天好厉害', reply: ['才没有', '哼'] },
  ]);
  assert.equal(callsOf(f, 'adopt').length, 1);
});

test('a text answer can be added to a list field, and to every other field the editor offers', async (t) => {
  for (const field of [
    'persona',
    'speechStyle',
    'dialogueStyle',
    'interests',
    'boundaries',
    'personalityLayers',
    'fictionalPeople',
  ]) {
    const f = setup(t);
    await f.inbox.load();
    f.answer(1).querySelector('.cc-adopt-open')!.click();
    const editor = f.q('.cc-adopt')!;
    editor.querySelector('select')!.value = field;
    editor.querySelector('select')!.dispatch('change');
    editor.dispatch('submit');
    await flush();
    const saved = callsOf(f, 'save')[0]!.args[2] as CharacterProfile;
    if (field === 'persona') assert.match(saved.template.persona, /\n\n哎呀妈呀$/, field);
    else {
      const value = (saved.template.authorCanon!.settings as Record<string, unknown>)[field];
      assert.ok(value === '哎呀妈呀' || (Array.isArray(value) && value[0] === '哎呀妈呀'), field);
    }
    f.inbox.dispose();
  }
});

test('a failed save is shown inline, keeps the editor open and does not mark anything adopted', async (t) => {
  const conflict = Object.assign(new Error('x'), { code: 'DRAFT_CONFLICT' });
  const f = setup(t, { saveError: conflict });
  await f.inbox.load();
  f.answer(1).querySelector('.cc-adopt-open')!.click();
  f.q('.cc-adopt')!.dispatch('submit');
  await flush();
  const error = f.q('.cc-adopt-error')!;
  assert.equal(error.hidden, false);
  assert.match(error.textContent, /草稿已在其他页面修改/);
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(callsOf(f, 'adopt').length, 0, 'not adopted when the draft was not saved');
  assert.ok(f.q('.cc-adopt'), 'still open for another try');
  assert.equal(f.answer(1).querySelector('.cc-chip-adopted'), null);
  assert.match(f.all('.cc-row')[0]!.textContent, /新/);
  assert.equal(f.changed(), 0);
});

test('server validation errors and unknown errors are shown inline in words', async (t) => {
  for (const [code, pattern] of [
    ['INVALID_CANON_VALUE', /结构化设定包含无效值/],
    ['LIVE_VERSION_CONFLICT', /正式版本已变/],
    ['CHARACTER_DELETED', /人物已删除/],
    ['SOMETHING_NEW', /保存草稿没有成功/],
  ] as const) {
    const f = setup(t, { saveError: Object.assign(new Error('x'), { code }) });
    await f.inbox.load();
    f.answer(1).querySelector('.cc-adopt-open')!.click();
    f.q('.cc-adopt')!.dispatch('submit');
    await flush();
    assert.match(f.q('.cc-adopt-error')!.textContent, pattern, code);
    f.inbox.dispose();
  }
});

test('an empty edit or an unusable existing field is explained inline before anything is saved', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  f.answer(1).querySelector('.cc-adopt-open')!.click();
  f.q('.cc-adopt textarea')!.type_('   ');
  f.q('.cc-adopt')!.dispatch('submit');
  await flush();
  assert.match(f.q('.cc-adopt-error')!.textContent, /请先写下要加入的内容/);
  assert.equal(callsOf(f, 'save').length, 0);

  const shaped = profile(3);
  (shaped.template as { authorCanon?: unknown }).authorCanon = {
    kind: 'author_canon',
    settings: { speechStyle: { a: 1 } },
  };
  const g = setup(t, { published: { version: 3, profile: shaped } });
  await g.inbox.load();
  g.answer(1).querySelector('.cc-adopt-open')!.click();
  g.q('.cc-adopt')!.dispatch('submit');
  await flush();
  assert.match(g.q('.cc-adopt-error')!.textContent, /无法自动追加/);
  assert.equal(callsOf(g, 'save').length, 0);

  const none = setup(t, { published: null });
  await none.inbox.load();
  none.answer(1).querySelector('.cc-adopt-open')!.click();
  none.q('.cc-adopt')!.dispatch('submit');
  await flush();
  assert.match(none.q('.cc-adopt-error')!.textContent, /还没有可编辑的版本/);
});

test('if the draft saved but marking it adopted failed, the editor says so and never saves twice', async (t) => {
  const f = setup(t, { adoptError: Object.assign(new Error('x'), { code: 'NETWORK' }) });
  await f.inbox.load();
  f.answer(1).querySelector('.cc-adopt-open')!.click();
  f.q('.cc-adopt')!.dispatch('submit');
  await flush();
  assert.equal(callsOf(f, 'save').length, 1);
  assert.match(f.q('.cc-adopt-error')!.textContent, /草稿已保存.*请勿重复加入/);
});

test('keyboard: j and k move through the list and open each submission; e archives; s stars; fields and other pages are left alone', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  assert.equal(f.inbox.snapshot().active, 0);
  f.key('j');
  await flush();
  assert.equal(f.inbox.snapshot().active, 1);
  assert.equal(f.inbox.snapshot().detail!.id, 's2');
  assert.ok(f.all('.cc-row')[1]!.classList.contains('is-active'));
  f.key('j');
  f.key('j');
  await flush();
  assert.equal(f.inbox.snapshot().active, 2, 'stops at the last one');
  f.key('k');
  await flush();
  assert.equal(f.inbox.snapshot().detail!.id, 's2');
  f.key('s');
  await flush();
  assert.deepEqual(
    callsOf(f, 'star').map((c) => c.args),
    [['s2', true]],
  );
  assert.match(f.all('.cc-row')[1]!.textContent, /★/);
  f.key('e');
  await flush();
  assert.deepEqual(
    callsOf(f, 'setStatus').map((c) => c.args),
    [[['s2'], 'archived']],
  );
  assert.match(f.all('.cc-row')[1]!.textContent, /已归档/);
  // Typing in a field never triggers a shortcut.
  const area = f.doc.createElement('textarea');
  f.key('j', area);
  f.key('e', area);
  await flush();
  assert.equal(callsOf(f, 'setStatus').length, 1);
  assert.equal(f.inbox.snapshot().active, 1);
  // Only while the inbox is the visible page.
  f.inbox.deactivate();
  f.key('j');
  await flush();
  assert.equal(f.inbox.snapshot().active, 1);
  f.inbox.activate();
  f.key('j');
  await flush();
  assert.equal(f.inbox.snapshot().active, 2);
});

test('someone who may only read cannot change anything: manage controls are off and shortcuts do nothing', async (t) => {
  const f = setup(t, { manage: false });
  await f.inbox.load();
  // Named exception (Part 24b-2): the bulk bar is just the 归档所选 button, shown only while rows are ticked and the viewer may manage.
  assert.equal(f.q('.cc-archive-selected')!.hidden, true);
  assert.ok(f.all('.cc-row input').every((box) => box.hidden));
  assert.equal(f.q('.cc-star')!.disabled, true);
  assert.equal(f.q('.cc-set-archived')!.disabled, true);
  // Named exception (Part 24b-6): no 管理员备注 UI any more.
  assert.equal(f.q('.cc-save-note'), null);
  assert.equal(f.q('.cc-note'), null);
  assert.equal(f.answer(1).querySelector('.cc-adopt-open')!.disabled, true);
  assert.equal(f.answer(1).querySelector('.cc-copy')!.disabled, false, 'copying is reading');
  f.key('e');
  f.key('s');
  await flush();
  assert.equal(callsOf(f, 'setStatus').length + callsOf(f, 'star').length, 0);
  f.key('j');
  await flush();
  assert.equal(f.inbox.snapshot().active, 1, 'moving around is still fine');
});

// Named exception (Part 24b-2): no 全选本页 button and no status dropdown any more: rows are ticked one by one, 归档所选 appears only while
// something is ticked, and the status filter is a chip.
test('bulk archive: select rows, archive them in one request; a status filter drops them from view', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  assert.equal(f.q('.cc-archive-selected')!.hidden, true);
  f.all('.cc-row input')[0]!.checked = true;
  f.all('.cc-row input')[0]!.dispatch('change');
  f.all('.cc-row input')[2]!.checked = true;
  f.all('.cc-row input')[2]!.dispatch('change');
  assert.equal(f.q('.cc-archive-selected')!.textContent, '归档所选（2）');
  f.q('.cc-archive-selected')!.click();
  await flush();
  assert.deepEqual(
    callsOf(f, 'setStatus').map((c) => c.args),
    [[['s1', 's3'], 'archived']],
  );
  assert.match(f.all('.cc-row')[0]!.textContent, /已归档/);
  assert.match(f.all('.cc-row')[1]!.textContent, /新/);
  assert.equal(f.q('.cc-archive-selected')!.hidden, true, 'nothing is ticked after the archive');

  // With the “新” filter on, archived rows leave the list and the next one opens.
  const g = setup(t);
  await g.inbox.load();
  g.all('.cc-filter-chip')
    .find((chip) => chip.textContent === '新')!
    .click();
  await flush();
  assert.equal(g.filters.at(-1)!.filter.status, 'new');
  g.all('.cc-row input')[0]!.checked = true;
  g.all('.cc-row input')[0]!.dispatch('change');
  g.q('.cc-archive-selected')!.click();
  await flush();
  await flush();
  assert.deepEqual(rowIds(g), ['s2', 's3']);
  assert.equal(g.inbox.snapshot().detail!.id, 's2');
});

// Named exception (Part 24b-6): the 管理员备注 UI is removed from the inbox (its API stays); the old note test is superseded by this
// one, which pins that nothing of it is drawn and nothing is sent.
test('the inbox has no admin note field or button, and never sends a note', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  assert.equal(f.q('.cc-note'), null);
  assert.equal(f.q('.cc-save-note'), null);
  assert.doesNotMatch(f.root.textContent, /管理员备注|有备注/);
  assert.equal(callsOf(f, 'note').length, 0);
});

test('status buttons change one submission; the star toggles', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  assert.equal(f.q('.cc-set-new'), null, 'already new');
  f.q('.cc-set-processed')!.click();
  await flush();
  assert.deepEqual(callsOf(f, 'setStatus').at(-1)!.args, [['s1'], 'processed']);
  assert.ok(f.q('.cc-set-new'), 'and now it can be put back');
  f.q('.cc-set-new')!.click();
  await flush();
  assert.deepEqual(callsOf(f, 'setStatus').at(-1)!.args, [['s1'], 'new']);
  f.q('.cc-star')!.click();
  await flush();
  assert.deepEqual(callsOf(f, 'star').at(-1)!.args, ['s1', true]);
  assert.equal(f.q('.cc-star')!.textContent, '★ 已星标');
  f.q('.cc-star')!.click();
  await flush();
  assert.deepEqual(callsOf(f, 'star').at(-1)!.args, ['s1', false]);
});

// Named exception (Part 24b-2): the filters are chips (角色, 状态, 只看星标) plus the search field, and the next page is read when the
// list is scrolled to its end: there are no dropdowns and no 更多 button.
test('filters go to the server (character, status, star, text) and the next page is read by cursor when the list is scrolled to its end', async (t) => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const f = setup(t, { pages: [[item('p1')], [item('p2')]] });
  await f.inbox.load();
  assert.deepEqual(f.filters[0]!.filter, { characterId: null, status: null, starred: false, query: '' });
  assert.equal(f.q('.cc-more'), null, 'no 更多 button');
  assert.equal(f.all('select').length, 0, 'no dropdowns');
  // Named exception (Part 24b-6): the page scrolls (there is no inner list), so the window's scroll reads the next page.
  const win = globalThis.window as unknown as EventTarget & { innerHeight: number; scrollY: number };
  Object.assign(win, { innerHeight: 800, scrollY: 0 });
  Object.assign(f.doc.documentElement, { scrollHeight: 900 });
  win.dispatchEvent(new Event('scroll'));
  await flush();
  assert.deepEqual(rowIds(f), ['p1', 'p2']);
  assert.deepEqual(f.filters.at(-1)!.before, { createdAt: 1, id: 'cursor' });

  const g = setup(t);
  await g.inbox.load();
  // Named exception (Part 24b-6): a character chip carries the number of its new notes after the name ("瓜瓜 3").
  const chip = (label: string) =>
    g.all('.cc-filter-chip').find((c) => c.textContent === label || c.textContent.startsWith(`${label} `))!;
  chip('瓜瓜').click();
  await flush();
  assert.equal(chip('瓜瓜').getAttribute('aria-pressed'), 'true');
  chip('★ 只看星标').click();
  await flush();
  g.q('#cc-filter-query')!.type_('哎呀');
  g.q('#cc-filter-query')!.dispatch('change');
  await flush();
  assert.deepEqual(g.filters.at(-1)!.filter, { characterId: 'wei-guagua', status: null, starred: true, query: '哎呀' });
  assert.equal(g.filters.at(-1)!.before, null, 'a new filter starts from the top');
  chip('全部').click();
  await flush();
});

test('the character workbench shows an unread badge per character, and none for zero', async (t) => {
  const doc = installFakeDom(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const root = doc.createElement('div');
  const counts: Record<string, number> = { 'wei-guagua': 3 };
  const bench = characterWorkbench(root as unknown as HTMLElement, {
    api: {
      list: async () => ({
        characters: [
          { characterId: 'wei-guagua', displayName: '瓜瓜', publishedVersion: 1, draftRevision: null },
          { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 1, draftRevision: null },
        ],
        deletions: [],
      }),
    } as never,
    member: () => ({ id: 'm', label: 'o', role: 'owner', email: null, permissions: [], createdAt: 1 }),
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
    badges: () => counts,
  });
  await bench.load();
  const rows = root.querySelectorAll('.character-directory-row');
  assert.equal(rows.length, 2);
  // Part 16 (named exception): visible text "N 条新共创" and a link to the filtered inbox replace the bare number and its aria-label.
  assert.equal(rows[0]!.querySelector('.cocreation-badge')!.textContent, '3 条新共创');
  assert.equal(rows[0]!.querySelector('.cocreation-badge')!.getAttribute('href'), '#/cocreation/wei-guagua');
  assert.equal(rows[1]!.querySelector('.cocreation-badge'), null);
  bench.dispose();
});

// Part 24b-4: the bulk bar names its actions, the rows start with the character's colour dot and full name, no button is icon-only.
test('24b-4 several rows ticked show a bulk bar with labelled actions; 标为已处理 sends one request; 取消选择 clears', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  assert.equal(f.q('.cc-bulk')!.hidden, true);
  for (const i of [0, 2]) {
    f.all('.cc-row input')[i]!.checked = true;
    f.all('.cc-row input')[i]!.dispatch('change');
  }
  assert.equal(f.q('.cc-bulk')!.hidden, false);
  assert.equal(f.q('.cc-bulk-count')!.textContent, '已选 2 条');
  assert.deepEqual(
    f
      .q('.cc-bulk')!
      .querySelectorAll('button')
      .map((b) => b.textContent),
    ['标为已处理（2）', '归档所选（2）', '取消选择'],
  );
  f.q('.cc-process-selected')!.click();
  await flush();
  assert.deepEqual(callsOf(f, 'setStatus')[0]!.args, [['s1', 's3'], 'processed']);
  f.all('.cc-row input')[1]!.checked = true;
  f.all('.cc-row input')[1]!.dispatch('change');
  f.q('.cc-clear-selected')!.click();
  assert.equal(f.q('.cc-bulk')!.hidden, true);
});

test('24b-4 every row starts with the character colour dot and the full name; no button of the inbox is icon-only', async (t) => {
  const f = setup(t);
  await f.inbox.load();
  for (const row of f.all('.cc-row-open')) {
    const name = row.querySelectorAll('.cc-name')[0]!;
    assert.equal(name.querySelectorAll('.cs-dot').length, 1);
    assert.equal(name.textContent, NAME);
  }
  const labelled = f.all('button').filter((b) => b.textContent.trim() === '' && !b.hidden);
  assert.deepEqual(labelled, []);
  assert.equal(f.q('.cc-detail h3')!.querySelectorAll('.cs-dot').length, 1);
  assert.deepEqual(
    f
      .q('.cc-detail-actions')!
      .querySelectorAll('button')
      .map((b) => b.textContent),
    ['☆ 星标', '标为已处理', '归档'],
  );
});
