// Part 24k-2 (named exception): the welcome fixtures/assertions in this file moved from welcome {text,version} to welcomes [{id,text,weight}]; nothing else was changed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyCharacter } from '../../src/features/admin/character-form.ts';
import { characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import type { CharacterDetail, CharacterProfile } from '../../src/services/character-admin-api.ts';
import { flush, installFakeDom, type FakeElement } from './fake-dom.ts';

/** Part 24j: 身份与展示 carries the 角色代码 (its own save), the checklist of an import, and the Fish id is prefilled on 声音. */
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

function bench(
  t: test.TestContext,
  withDraft: boolean,
  meta: CharacterDetail['profileMeta'],
  who: typeof owner = owner,
) {
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
    profileMeta: meta,
  } as CharacterDetail;
  const calls: { op: string; args: unknown[] }[] = [];
  const api = {
    saveCode: async (id: string, code: string) => {
      calls.push({ op: 'saveCode', args: [id, code] });
      if (code === 'TAKEN') throw Object.assign(new Error('PROFILE_CODE_TAKEN'), { code: 'PROFILE_CODE_TAKEN' });
      detail.profileMeta = { ...detail.profileMeta!, code };
      return detail.profileMeta;
    },
    dismissChecklist: async (id: string, key: string) => {
      calls.push({ op: 'dismiss', args: [id, key] });
      detail.profileMeta = {
        ...detail.profileMeta!,
        checklist: detail.profileMeta!.checklist.map((c) =>
          c.key === key ? { ...c, state: 'dismissed' as const } : c,
        ),
      };
      return detail.profileMeta;
    },
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
  return {
    root,
    rail: root,
    header,
    workbench,
    calls,
    dirty: () => root.querySelectorAll('.wb-dot').some((d) => d.hidden === false),
  };
}

const meta = {
  available: true,
  code: 'SYZ',
  avatarFile: 'syz.png',
  voiceReferenceId: 'fish_ref_001',
  checklist: [
    { key: 'avatar:syz.png', text: '头像 syz.png 待 25e 上传', state: 'open' as const },
    { key: 'welcome:2', text: '欢迎词 第 2 条 等 24k 多欢迎词', state: 'open' as const },
    { key: 'old', text: '已处理过的', state: 'dismissed' as const },
  ],
};

test('身份与展示 shows the code, and only the open checklist items; 已处理 dismisses one', async (t) => {
  const f = bench(t, true, structuredClone(meta));
  await f.workbench.open('jojo');
  assert.equal(
    f.dirty(),
    false,
    'opening a role with a code must not light the unsaved dot (the code is not a field of the draft)',
  );
  const code = f.root.querySelector('[data-wb-code]')!;
  assert.equal(code.value, 'SYZ');
  const items = f.root.querySelectorAll('.wb-checklist li').map((li) => li.textContent);
  assert.equal(items.length, 2);
  assert.ok(items[0]!.includes('头像 syz.png 待 25e 上传'));
  assert.ok(!items.join().includes('已处理过的'));
  f.root.querySelectorAll('.wb-checklist button')[0]!.click();
  await flush();
  assert.deepEqual(f.calls.find((c) => c.op === 'dismiss')!.args, ['jojo', 'avatar:syz.png']);
  assert.equal(f.root.querySelectorAll('.wb-checklist li').length, 1);
});

test('the code is saved on its own: typing it does not mark the draft changed; a taken code shows its sentence', async (t) => {
  const f = bench(t, true, structuredClone(meta));
  await f.workbench.open('jojo');
  const code = f.root.querySelector('[data-wb-code]')!;
  code.value = 'NEWC';
  code.dispatch('input');
  assert.equal(f.workbench.canLeave(), true, 'no unsaved draft change');
  assert.equal(f.dirty(), false, 'and no dot on 身份与展示');
  f.root
    .querySelectorAll('button')
    .find((b) => b.textContent === '保存代码')!
    .click();
  await flush();
  assert.deepEqual(f.calls.find((c) => c.op === 'saveCode')!.args, ['jojo', 'NEWC']);
  code.value = 'TAKEN';
  f.root
    .querySelectorAll('button')
    .find((b) => b.textContent === '保存代码')!
    .click();
  await flush();
  assert.match(f.root.querySelector('.wb-code-note')!.textContent, /已被别的角色使用/);
});

test('without profile meta (an older answer, or the feature off) there is no code field and no checklist', async (t) => {
  for (const m of [undefined, { ...meta, available: false }]) {
    const f = bench(t, true, m as never);
    await f.workbench.open('jojo');
    assert.equal(f.root.querySelector('[data-wb-code]'), null);
    assert.equal(f.root.querySelectorAll('.wb-checklist').length, 0);
  }
});

test('the 声音 page offers the Fish id from the import prefilled; nothing is prepared until the administrator asks', async (t) => {
  const f = bench(t, true, structuredClone(meta));
  await f.workbench.open('jojo');
  await flush();
  const field = f.root.querySelectorAll('label').find((l) => l.textContent.includes('已有 Fish 音色 referenceId'))!;
  assert.equal(field.querySelector('input')!.value, 'fish_ref_001');
  assert.equal(f.calls.filter((c) => c.op === 'prepare').length, 0);
});

test('a user without character edit may read the code but not change it', async (t) => {
  const f = bench(t, true, structuredClone(meta), {
    ...owner,
    role: 'admin',
    permissions: ['characters.read:*'],
  } as never);
  await f.workbench.open('jojo');
  assert.equal(f.root.querySelector('[data-wb-code]')!.disabled, true);
});
