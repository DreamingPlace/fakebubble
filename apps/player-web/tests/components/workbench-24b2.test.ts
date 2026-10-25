import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AdminFormError,
  characterForm,
  colourField,
  editedCharacter,
  emptyCharacter,
  isColourOnlyChange,
} from '../../src/features/admin/character-form.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

const published = (): CharacterProfile => {
  const p = emptyCharacter();
  Object.assign(p.template, { id: 'jojo', name: 'JOJO', persona: '离线合成人设', version: 3 });
  p.presentation = { displayName: 'JOJO', publicDescription: '', welcome: { text: '你好', version: 'welcome-v1' } };
  return p;
};
/** The two element classes the form code tests with instanceof, matched by tag on the fake DOM. */
function elementClasses(t: test.TestContext) {
  const tagged = (tag: string) =>
    class {
      static [Symbol.hasInstance](value: unknown) {
        return (value as { tagName?: string } | null)?.tagName === tag;
      }
    };
  for (const [name, tag] of [
    ['HTMLInputElement', 'INPUT'],
    ['HTMLTextAreaElement', 'TEXTAREA'],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, value: tagged(tag) });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
}
const owner = { id: 'm', label: 'o', role: 'owner' as const, email: null, permissions: [], createdAt: 1 };

function bench(t: test.TestContext, detail: Partial<CharacterDetail> = {}) {
  const doc = installFakeDom(t);
  elementClasses(t);
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const root = doc.createElement('div') as unknown as FakeElement;
  const calls: { publish: unknown[]; roles: unknown[] } = { publish: [], roles: [] };
  const base = {
    characterId: 'jojo',
    previews: [],
    previewAvailable: true,
    published: { version: 3, profile: published() },
    draft: null,
    ...detail,
  } as CharacterDetail;
  const api = {
    list: async () => ({
      characters: [
        { characterId: 'jojo', displayName: 'JOJO', publishedVersion: 3, draftRevision: base.draft?.revision ?? null },
        { characterId: 'wei-guagua', displayName: '瓜瓜', publishedVersion: 1, draftRevision: null },
      ],
      deletions: [],
    }),
    detail: async () => base,
    materials: async () => [],
    profilePreview: async () => ({ draft: base.draft, published: base.published?.profile ?? null }),
    publish: async (_id: string, body: unknown) => {
      calls.publish.push(body);
      return { version: 4 };
    },
  };
  const workbench = characterWorkbench(root as unknown as HTMLElement, {
    api: api as never,
    member: () => owner,
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
    directory: 'none',
    onDirectory: (roles) => calls.roles.push(roles.map((r) => r.characterId)),
  });
  return { root, workbench, calls };
}
/** The publish step's confirmation box (the form has its own checkboxes too). */
const ackOf = (root: FakeElement) =>
  root
    .querySelectorAll('input')
    .find((i) => i.getAttribute('type') === 'checkbox' && /确认将本版本发布给玩家/.test(i.parent?.textContent ?? ''))!;
const buttons = (root: FakeElement) => root.querySelectorAll('button').map((b) => b.textContent);

test('角色工作台: the shell draws the list, so loading reads the roles for it and shows no directory and no 打开资料', async (t) => {
  const f = bench(t);
  await f.workbench.load();
  assert.deepEqual(f.calls.roles, [['jojo', 'wei-guagua']]);
  assert.ok(!buttons(f.root).includes('打开资料'));
  assert.equal(f.root.querySelectorAll('.character-directory-row').length, 0);
  assert.match(f.root.textContent, /从左边选一个角色/);
});

test('角色工作台: opening a role shows its editor with the folds open and no 返回 / 重新读取 buttons', async (t) => {
  const f = bench(t);
  await f.workbench.load();
  await f.workbench.open('jojo');
  assert.equal(f.root.querySelectorAll('form').length, 1, 'the editor');
  assert.ok(!buttons(f.root).includes('返回人物目录'));
  assert.ok(!buttons(f.root).includes('重新读取资料'));
  assert.ok(!buttons(f.root).includes('比较已存草稿与正式资料'), 'loaded on open, not behind a button');
});

test('主色: hex or r, g, b, normalised; empty is allowed; nonsense is refused and flagged', (t) => {
  const doc = installFakeDom(t);
  const host = doc.createElement('div') as unknown as FakeElement;
  let changed = 0;
  const field = colourField(host as unknown as HTMLElement, undefined, () => changed++);
  const set = (value: string) => {
    field.input.value = value;
    (field.input as unknown as FakeElement).dispatch('input');
  };
  assert.equal(field.read(), '', 'no colour is a valid state');
  set('#e8561e');
  assert.equal(field.read(), '#E8561E');
  set('232, 86, 30');
  assert.equal(field.read(), '#E8561E');
  assert.equal(host.querySelectorAll('.colour-chip')[0]!.getAttribute('data-state'), 'ok');
  set('rgb(47,123,234)');
  assert.equal(field.read(), '#2F7BEA');
  for (const bad of ['#fff', '300, 0, 0', 'blue', '#12345G']) {
    set(bad);
    assert.throws(() => field.read(), AdminFormError, bad);
    assert.equal(field.input.getAttribute('aria-invalid'), 'true');
    assert.equal(host.querySelectorAll('.colour-chip')[0]!.getAttribute('data-state'), 'invalid');
  }
  assert.ok(changed >= 6, 'every keystroke marks the draft changed');
});

test('主色: a profile without a colour keeps no colour key (so its hash does not move); with one it is written', () => {
  const base = published();
  const values = {
    id: 'jojo',
    name: 'JOJO',
    birthDate: '',
    persona: base.template.persona,
    displayName: 'JOJO',
    publicDescription: '',
    welcomeText: '你好',
    welcomeVersion: 'welcome-v1',
    canon: '{}',
    voice: null,
  };
  assert.equal('color' in editedCharacter(base, { ...values, color: '' }).presentation, false);
  assert.equal(editedCharacter(base, values).presentation.color, undefined);
  assert.equal(editedCharacter(base, { ...values, color: '#E8561E' }).presentation.color, '#E8561E');
});

test('主色: only a draft that differs from the published profile in the colour alone counts as colour-only', () => {
  const live = published();
  const next = structuredClone(live);
  next.presentation.color = '#2BA84A';
  next.template.version = 4;
  assert.equal(isColourOnlyChange(live, next), true);
  assert.equal(isColourOnlyChange(null, next), false, 'a new role needs its 预演');
  assert.equal(isColourOnlyChange(live, live), false, 'nothing changed');
  for (const edit of [
    (p: CharacterProfile) => void (p.template.persona += '新'),
    (p: CharacterProfile) => void (p.presentation.displayName = '别名'),
    (p: CharacterProfile) => void (p.presentation.welcome.version = 'welcome-v2'),
    (p: CharacterProfile) => void (p.template.voice = { profileId: 'x', version: 1, speed: 1 }),
  ]) {
    const changed = structuredClone(next);
    edit(changed);
    assert.equal(isColourOnlyChange(live, changed), false);
  }
});

test('角色工作台: a colour-only draft is published without choosing a 预演; any other draft still needs one', async (t) => {
  const live = published();
  const colour = structuredClone(live);
  colour.template.version = 4;
  colour.presentation.color = '#2BA84A';
  const draft = {
    characterId: 'jojo',
    revision: 2,
    baseVersion: 3,
    profile: colour,
    contentHash: 'b'.repeat(64),
    savedAt: 1,
  };
  const f = bench(t, { draft });
  await f.workbench.load();
  await f.workbench.open('jojo');
  const publishButton = () => f.root.querySelectorAll('button').find((b) => b.textContent === '确认发布此版本')!;
  assert.match(f.root.textContent, /只改了主色，不需要预演/);
  const ack = ackOf(f.root);
  ack.checked = true;
  ack.dispatch('change');
  publishButton().click();
  await flush();
  assert.equal(f.calls.publish.length, 1);
  const body = f.calls.publish[0] as Record<string, unknown>;
  assert.equal('previewId' in body, false);
  assert.equal(body.acknowledgeReview, true);

  const persona = structuredClone(colour);
  persona.template.persona += '新';
  const other = bench(t, { draft: { ...draft, profile: persona } });
  await other.workbench.load();
  await other.workbench.open('jojo');
  assert.match(other.root.textContent, /尚无匹配当前草稿的成功预演，不能发布/);
  const ack2 = ackOf(other.root);
  ack2.checked = true;
  ack2.dispatch('change');
  other.root
    .querySelectorAll('button')
    .find((b) => b.textContent === '确认发布此版本')!
    .click();
  await flush();
  assert.equal(other.calls.publish.length, 0, 'without a successful 预演 nothing is sent');
});

test('characterForm: an invalid colour stops the save before anything is sent', (t) => {
  const doc = installFakeDom(t);
  elementClasses(t);
  const host = doc.createElement('div') as unknown as FakeElement;
  const form = characterForm(
    host as unknown as HTMLElement,
    published(),
    false,
    () => {},
    () => {},
  );
  const input = host.querySelectorAll('.colour-field input[type="text"]')[0]!;
  input.value = 'nope';
  input.dispatch('input');
  (host.querySelectorAll('form')[0] as unknown as { reportValidity: () => boolean }).reportValidity = () => true;
  assert.throws(() => form.read(), /主色/);
});

test('the console writes every time as YYYY-MM-DD HH:mm UTC, whatever the browser locale or zone', async () => {
  const { when } = await import('../../src/features/admin/preview/copy.ts');
  const { dateTimeText } = await import('../../src/features/admin/system-format.ts');
  const at = Date.UTC(2026, 9, 23, 5, 12);
  assert.equal(dateTimeText(at), '2026-10-23 05:12 UTC');
  assert.equal(when(at), '2026-10-23 05:12 UTC');
});
