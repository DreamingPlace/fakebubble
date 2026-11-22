import assert from 'node:assert/strict';
import test from 'node:test';
import { conversationsView } from '../../src/features/admin/conversations-view.ts';
import { speechPanel } from '../../src/features/admin/speech-profile/speech-panel.ts';
import { othersReader, independenceSentences } from '../../src/features/admin/speech-profile/profile-draft.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import type { ReviewDetail, ReviewKey } from '../../src/services/conversations-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

// ---- ⭐ on a character line of 测试对话 ------------------------------------------------------------------------------------------

const KEY: ReviewKey = { characterId: 'jojo', code: 'K7M2', archived: false };
const transcript = (): ReviewDetail => ({
  label: 'JOJO-K7M2',
  ...KEY,
  expiresOn: null,
  total: 4,
  page: 0,
  pageSize: 100,
  lines: [
    { n: 1, time: 't', speaker: 'player', text: '今天被老板骂了', status: 'ok', errorCode: null, reviewChanged: false },
    {
      n: 2,
      time: 't',
      speaker: 'character',
      text: '抱抱，晚上吃点好的',
      status: 'ok',
      errorCode: null,
      reviewChanged: false,
    },
    {
      n: 3,
      time: 't',
      speaker: 'character',
      text: '',
      status: 'failed',
      errorCode: 'PROVIDER_FAILED',
      reviewChanged: false,
    },
    { n: 4, time: 't', speaker: 'character', text: '我在呢', status: 'ok', errorCode: null, reviewChanged: false },
  ],
});
const viewOf = (
  t: test.TestContext,
  adoptLine?: (input: { characterId: string; player: string; reply: string }) => void,
) => {
  const doc = installFakeDom(t);
  const root = doc.createElement('div') as unknown as HTMLElement;
  const view = conversationsView(root, {
    api: {
      list: async () => ({
        rows: [
          {
            label: 'JOJO-K7M2',
            ...KEY,
            expiresOn: null,
            messages: 4,
            failed: 1,
            firstAt: 'a',
            lastAt: 'b',
          },
        ],
        page: 0,
        pageSize: 50,
        total: 1,
        characters: [{ characterId: 'jojo', label: 'JOJO' }],
      }),
      detail: async () => transcript(),
      export: async () => ({ filename: 'x.csv', lines: 0, csv: '' }),
    },
    run: (work) => work(),
    runLatest: (work) => void work(),
    status: () => {},
    disposed: () => false,
    ...(adoptLine ? { adoptLine } : {}),
  });
  return { el: root as unknown as FakeElement, view };
};

test('⭐ is on a character line that was written, opens the adopt box with the line and what the player said, and never on a failed one', async (t) => {
  const got: { characterId: string; player: string; reply: string }[] = [];
  const f = viewOf(t, (input) => got.push(input));
  await f.view.load();
  f.el.querySelectorAll('tbody tr')[0]!.click();
  await flush();
  const lines = f.el.querySelectorAll('.review-line');
  assert.equal(lines.length, 4);
  assert.deepEqual(
    lines.map((line) => line.querySelectorAll('.review-star').length),
    [0, 1, 0, 1],
  );
  lines[1]!.querySelector('.review-star')!.click();
  lines[3]!.querySelector('.review-star')!.click();
  assert.deepEqual(got, [
    { characterId: 'jojo', player: '今天被老板骂了', reply: '抱抱，晚上吃点好的' },
    // the line before it is a character line (the failed one is skipped as context), so there is no player line
    { characterId: 'jojo', player: '', reply: '我在呢' },
  ]);
});

test('without the adopt box (an administrator who may not edit) there is no ⭐', async (t) => {
  const f = viewOf(t);
  await f.view.load();
  f.el.querySelectorAll('tbody tr')[0]!.click();
  await flush();
  assert.equal(f.el.querySelectorAll('.review-star').length, 0);
});

// ---- 角色工作台 → 说话档案 --------------------------------------------------------------------------------------------------------

const profileOf = (settings: Record<string, unknown>): CharacterProfile =>
  ({
    template: {
      id: 'jojo',
      name: 'JOJO',
      version: 3,
      fictional: true,
      persona: '离线人设',
      authorCanon: { kind: 'author_canon', settings },
    },
    presentation: { displayName: 'JOJO', publicDescription: '', welcomes: [] },
  }) as unknown as CharacterProfile;
const snapshotOf = (settings: Record<string, unknown>): CharacterDetail => ({
  characterId: 'jojo',
  published: { version: 3, profile: profileOf(settings) },
  draft: {
    characterId: 'jojo',
    revision: 5,
    baseVersion: 3,
    profile: profileOf(settings),
    contentHash: 'h',
    savedAt: 0,
  },
  previews: [],
  previewAvailable: false,
});

function panelOf(
  t: test.TestContext,
  settings: Record<string, unknown>,
  over: { unsaved?: boolean; others?: Record<string, Record<string, unknown>> } = {},
) {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as HTMLElement;
  const saves: { revision: number | null; template: { authorCanon?: { settings: Record<string, unknown> } } }[] = [];
  const toasts: string[] = [];
  let reloads = 0;
  const others = over.others ?? { jojo2: { speechStyle: '完全不同的说法在这里' } };
  const api = {
    list: async () => ({
      characters: [
        { characterId: 'jojo', displayName: 'JOJO' },
        ...Object.keys(others).map((id) => ({ characterId: id, displayName: `角色${id}` })),
      ],
      deletions: [],
    }),
    detail: async (id: string) => (id === 'jojo' ? snapshotOf(settings) : snapshotOf(others[id] ?? {})),
    save: async (_id: string, revision: number | null, profile: CharacterProfile) => {
      saves.push({ revision, template: profile.template as never });
      return { characterId: 'jojo', revision: 6, baseVersion: 3, profile, contentHash: 'h2', savedAt: 1 };
    },
  } as never;
  const unsaved = { value: over.unsaved === true };
  const made = speechPanel(host, {
    snapshot: snapshotOf(settings),
    characters: api,
    others: othersReader(api),
    nameOf: (id) => (id === 'jojo' ? 'JOJO' : `角色${id}`),
    canEdit: () => true,
    unsaved: () => unsaved.value,
    run: (work) => work(),
    toast: (text) => toasts.push(text),
    errorText: () => null,
    disposed: () => false,
    reload: async () => {
      reloads++;
    },
  });
  return { el: host as unknown as FakeElement, made, saves, toasts, reloads: () => reloads, unsaved };
}
const EXAMPLES = [
  { situation: '调侃', player: '你好笨', reply: ['你才笨呢'] },
  { situation: '随便聊聊', player: '早上好', reply: ['早呀'] },
];

test('说话档案: four card fields (the current settings are the card), counts x/6 and 未分类 for an old situation', (t) => {
  const f = panelOf(t, { speechStyle: '短句，爱用叠词', dialogueExamples: EXAMPLES });
  const boxes = f.el.querySelectorAll('.sp-card textarea');
  assert.equal(boxes.length, 4);
  assert.deepEqual(
    boxes.map((box) => box.value),
    ['短句，爱用叠词', '', '', ''],
  );
  assert.equal(f.el.querySelectorAll('.sp-group').length, 9, 'eight situations and 未分类');
  assert.equal(f.el.querySelector('[data-count="调侃"]')!.textContent, '1/6');
  assert.equal(f.el.querySelector('[data-count="日常闲聊"]')!.textContent, '0/6');
  assert.equal(f.el.querySelector('[data-count="未分类"]')!.textContent, '1 条');
});

test('说话档案: 删除 takes one sample out of the draft (compare-and-swap on its revision) and nothing else', async (t) => {
  const f = panelOf(t, { dialogueExamples: EXAMPLES, interests: ['做饭'] });
  f.el.querySelector('[data-situation="调侃"] [data-sp="delete"]')!.click();
  await flush();
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0]!.revision, 5);
  assert.deepEqual(f.saves[0]!.template.authorCanon!.settings, {
    dialogueExamples: [EXAMPLES[1]],
    interests: ['做饭'],
  });
  assert.equal(f.reloads(), 1);
  assert.match(f.toasts[0]!, /草稿 6/);
});

test('说话档案: 移到 gives an old sample a situation; a full situation refuses', async (t) => {
  const f = panelOf(t, { dialogueExamples: EXAMPLES });
  const move = f.el.querySelector('[data-situation="未分类"] [data-sp="move"]')!;
  move.value = '安慰';
  move.dispatch('change');
  await flush();
  await flush();
  assert.deepEqual(f.saves[0]!.template.authorCanon!.settings.dialogueExamples, [
    EXAMPLES[0],
    { ...EXAMPLES[1], situation: '安慰' },
  ]);
});

test('说话档案: a card field over 300 characters cannot be saved; a short one is saved as text under its key', async (t) => {
  const f = panelOf(t, {});
  const humor = f.el.querySelector('textarea[data-field="humor"]')!;
  const save = f.el.querySelector('[data-sp="save"]')!;
  assert.equal(save.disabled, true, 'nothing changed');
  humor.value = '好'.repeat(301);
  humor.dispatch('input');
  assert.equal(save.disabled, true);
  assert.equal(f.el.querySelectorAll('.sp-count.is-over').length, 1);
  humor.value = '先怼再递台阶';
  humor.dispatch('input');
  assert.equal(save.disabled, false);
  save.click();
  await flush();
  await flush();
  assert.equal(f.saves[0]!.template.authorCanon!.settings.humorStyle, '先怼再递台阶');
});

test('说话档案: the same line as another character is blocked, a close one asks twice, an own one saves', async (t) => {
  const f = panelOf(t, {}, { others: { jojo2: { humorStyle: '先怼两句再递台阶，嘴硬心软' } } });
  const humor = f.el.querySelector('textarea[data-field="humor"]')!;
  const save = f.el.querySelector('[data-sp="save"]')!;
  humor.value = '先怼两句，再递台阶，嘴硬心软！';
  humor.dispatch('input');
  save.click();
  await flush();
  await flush();
  assert.equal(f.saves.length, 0, 'blocked: nothing saved');
  assert.match(f.el.querySelector('.sp-error')!.textContent, /太像/);
  assert.match(f.el.querySelector('.sp-error')!.textContent, /角色jojo2/);
  // a close (not identical) line: the first click warns, the second saves
  humor.value = '先怼两句再递台阶，嘴硬心软，哼，我才不是关心你';
  humor.dispatch('input');
  save.click();
  await flush();
  await flush();
  assert.equal(f.saves.length, 0);
  assert.equal(f.el.querySelector('.sp-warn')!.hidden, false);
  save.click();
  await flush();
  await flush();
  assert.equal(f.saves.length, 1);
});

test('说话档案: while the form beside has unsaved changes the section is read-only', (t) => {
  const f = panelOf(t, { dialogueExamples: EXAMPLES }, { unsaved: true });
  for (const box of f.el.querySelectorAll('.sp-card textarea')) assert.equal(box.disabled, true);
  assert.equal(f.el.querySelector('[data-sp="delete"]')!.disabled, true);
  assert.match(f.el.querySelector('.sp-lock')!.textContent, /未保存/);
  f.unsaved.value = false;
  f.made.refresh();
  assert.equal(f.el.querySelector('[data-sp="delete"]')!.disabled, false);
});

test('the independence sentence names the other character and the percentage, never an id', () => {
  const sentences = independenceSentences(
    { level: 'block', hits: [{ characterId: 'someone-id-1', text: '一句话', own: '一句话', score: 0.95 }] },
    () => '小明',
  );
  assert.deepEqual(sentences, ['和小明的「一句话」几乎一样（95%）']);
});

test('说话档案 (Part 51): 外号 is added with an attitude and a note, saved into the draft, and nothing else changes', async (t) => {
  const f = panelOf(t, { interests: ['做饭'] });
  const name = f.el.querySelector('.sp-nick-add input[aria-label="外号名字"]')!;
  const note = f.el.querySelector('.sp-nick-add input[aria-label="备注"]')!;
  const attitude = f.el.querySelector('.sp-nick-add select')!;
  const save = f.el.querySelector('[data-sp="nick-save"]')!;
  assert.equal(save.disabled, true, 'nothing to save yet');
  name.value = '小废物';
  attitude.value = '讨厌';
  note.value = '被这样叫会不高兴';
  f.el.querySelector('[data-sp="nick-add"]')!.click();
  await flush();
  assert.equal(f.el.querySelectorAll('.sp-nick').length, 1);
  assert.equal(save.disabled, false);
  save.click();
  await flush();
  await flush();
  assert.equal(f.saves.length, 1);
  assert.deepEqual(f.saves[0]!.template.authorCanon!.settings, {
    interests: ['做饭'],
    nicknames: [{ name: '小废物', attitude: '讨厌', note: '被这样叫会不高兴' }],
  });
  assert.match(f.toasts[0]!, /外号已保存/);
});

test('说话档案 (Part 51): a repeated name, a bad note and a 21st nickname are refused before they are listed', async (t) => {
  const have = Array.from({ length: 19 }, (_, i) => ({ name: `外号${i}`, attitude: '无所谓' }));
  const f = panelOf(t, { nicknames: [...have, { name: '小废物', attitude: '讨厌' }] });
  assert.equal(f.el.querySelectorAll('.sp-nick').length, 20);
  const name = f.el.querySelector('.sp-nick-add input[aria-label="外号名字"]')!;
  name.value = '第二十一个';
  f.el.querySelector('[data-sp="nick-add"]')!.click();
  await flush();
  assert.equal(f.el.querySelectorAll('.sp-nick').length, 20, 'full');
  assert.match(f.el.querySelector('.sp-error')!.textContent, /最多 20/);
  // a stored value that is not a valid list is never rewritten
  const odd = panelOf(t, { nicknames: 'x' });
  assert.equal(odd.el.querySelector('[data-sp="nick-save"]')!.disabled, true);
  assert.equal(odd.el.querySelector('[data-sp="nick-add"]')!.disabled, true);
});
