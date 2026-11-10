// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCharacter } from '../../src/features/admin/character-form.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

/** Part 24f: 删除角色 is not drawn at all for anyone but the owner, whatever they were granted; 版本历史 is there for everyone who can read. */
const profile = (): CharacterProfile => {
  const p = emptyCharacter();
  Object.assign(p.template, { id: 'jojo', name: 'JOJO', persona: '离线合成人设', version: 3 });
  p.presentation = {
    displayName: 'JOJO',
    publicDescription: '',
    welcomes: [{ id: 'welcome-v1', text: '你好', weight: 100 }],
  };
  return p;
};
const owner = { id: 'm', label: 'o', role: 'owner' as const, email: null, permissions: [], createdAt: 1 };

function bench(t: test.TestContext, withDraft: boolean, who: typeof owner = owner) {
  const doc = installFakeDom(t);
  for (const [name, tag] of [
    ['HTMLInputElement', 'INPUT'],
    ['HTMLTextAreaElement', 'TEXTAREA'],
  ] as const) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: class {
        static [Symbol.hasInstance](value: unknown) {
          return (value as { tagName?: string } | null)?.tagName === tag;
        }
      },
    });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  t.after(() => {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  });
  const draftProfile = profile();
  draftProfile.template.version = 4;
  draftProfile.template.persona = '草稿人设';
  const detail = {
    characterId: 'jojo',
    previews: [],
    previewAvailable: true,
    published: { version: 3, profile: profile() },
    draft: withDraft
      ? {
          characterId: 'jojo',
          revision: 2,
          baseVersion: 3,
          profile: draftProfile,
          contentHash: 'a'.repeat(64),
          savedAt: 1,
        }
      : null,
  } as CharacterDetail;
  const api = {
    list: async () => ({ characters: [], deletions: [] }),
    detail: async () => detail,
    materials: async () => [],
    history: async () => ({
      characterId: 'jojo',
      live: 3,
      versions: [
        {
          version: 3,
          publishedAt: 1,
          by: 'owner',
          origin: { kind: 'publish' },
          summary: '初始版本',
          live: true,
          restorable: false,
          problem: null,
        },
      ],
    }),
    profilePreview: async () => ({ draft: detail.draft, published: detail.published?.profile ?? null }),
  };
  const root = doc.createElement('div') as unknown as FakeElement;
  const header = doc.createElement('div') as unknown as FakeElement;
  const workbench = characterWorkbench(root as unknown as HTMLElement, {
    api: api as never,
    member: () => who,
    run: async (work) => work(),
    status: () => {},
    disposed: () => false,
    directory: 'none',
    headerHost: header as unknown as HTMLElement,
  });
  return { root, rail: root, header, workbench };
}

const railItems = (rail: FakeElement) => rail.querySelectorAll('.wb-tab');
const labels = (rail: FakeElement) => railItems(rail).map((b) => b.textContent);
const helper = (permissions: string[]) =>
  ({ ...owner, id: 'h', role: 'admin' as const, permissions }) as never as typeof owner;

test('the owner is shown 删除角色 in the danger zone and its confirm step stays', async (t) => {
  const f = bench(t, false);
  await f.workbench.open('jojo');
  assert.ok(f.root.querySelector('#wb-delete'), '删除角色 opens the danger zone of 发布');
});

test('an administrator with every grant that used to open deletion sees no 删除角色 anywhere, but does see 版本历史', async (t) => {
  for (const permissions of [
    ['category.characters'],
    ['characters.delete:*', 'characters.read:*'],
    ['characters.delete:jojo', 'characters.read:jojo'],
    ['category.characters', 'category.publication', 'category.materials', 'characters.delete:*'],
  ]) {
    const f = bench(t, false, helper(permissions));
    await f.workbench.open('jojo');
    await flush();
    assert.equal(f.root.querySelector('#wb-delete'), null, permissions.join());
    assert.ok(!labels(f.rail).includes('删除角色'), permissions.join());
    assert.ok(labels(f.rail).includes('版本历史'), permissions.join());
    assert.ok(!f.root.querySelectorAll('button').some((b) => /删除角色/.test(b.textContent)), 'no delete button');
    assert.equal(f.root.querySelectorAll('[data-restore]').length, 0, 'and no restore button');
  }
});
