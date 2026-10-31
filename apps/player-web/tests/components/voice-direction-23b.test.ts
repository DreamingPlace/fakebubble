import assert from 'node:assert/strict';
import test from 'node:test';
import { characterForm, DIRECTION_HINT, emptyCharacter } from '../../src/features/admin/character-form.ts';
import { dateTimeText } from '../../src/features/admin/system-format.ts';
import { characterAdminError, characterWorkbench } from '../../src/features/admin/character-workbench.ts';
import {
  CharacterAdminClient,
  type CharacterDetail,
  type CharacterProfile,
} from '../../src/services/character-admin-api.ts';
import type { AdminMember } from '../../src/services/account-admin-api.ts';
import { InviteLocalApiError } from '../../src/services/invite-local-api.ts';

// Minimal native-form model; real layout, validation and keyboard behavior are checked in the browser.
class Element extends EventTarget {
  tagName: string;
  children: Element[] = [];
  parent: Element | null = null;
  dataset: Record<string, string> = {};
  disabled = false;
  checked = false;
  readOnly = false;
  required = false;
  type = '';
  className = '';
  files: File[] | null = null;
  private text = '';
  private val: string | undefined;
  constructor(tag = 'div') {
    super();
    this.tagName = tag;
  }
  get textContent(): string {
    return this.text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.text = v;
    this.children = [];
  }
  get value(): string {
    return this.val ?? (this.tagName === 'select' ? (this.children[0]?.value ?? '') : '');
  }
  set value(v: string) {
    this.val = v;
  }
  get childElementCount() {
    return this.children.length;
  }
  append(...nodes: Element[]) {
    for (const n of nodes) {
      n.parent = this;
      this.children.push(n);
    }
  }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((n) => n !== this);
    this.parent = null;
  }
  replaceChildren(...nodes: Element[]) {
    this.children = [];
    this.text = '';
    this.append(...nodes);
  }
  contains(node: Element): boolean {
    return this === node || this.children.some((c) => c.contains(node));
  }
  querySelectorAll(selector: string) {
    const tags = selector.split(',');
    return all(this)
      .slice(1)
      .filter((n) => tags.includes(n.tagName));
  }
  reportValidity() {
    assert.ok(!this.querySelectorAll('input,textarea').every((n) => n.disabled), 'validate before disabling form');
    return !this.querySelectorAll('input,textarea').some((n) => !n.disabled && n.required && !n.value);
  }
  fire(kind = 'click') {
    const event = new Event(kind, { cancelable: true });
    this.dispatchEvent(event);
    if (kind === 'input' || kind === 'change') this.parent?.fire(kind);
  }
}
class Input extends Element {
  constructor() {
    super('input');
  }
}
class TextArea extends Element {
  constructor() {
    super('textarea');
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
function dom(t: test.TestContext, beforeRestore: () => void = () => {}) {
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: new EventTarget(),
    HTMLInputElement: Input,
    HTMLTextAreaElement: TextArea,
    document: {
      createElement: (tag: string) =>
        tag === 'input' ? new Input() : tag === 'textarea' ? new TextArea() : new Element(tag),
    },
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  t.after(() => {
    beforeRestore();
    for (const [key, value] of originals)
      if (value) Object.defineProperty(globalThis, key, value);
      else Reflect.deleteProperty(globalThis, key);
  });
}
function profile(): CharacterProfile {
  const p = emptyCharacter();
  Object.assign(p.template, {
    id: 'jojo',
    name: '测试人物',
    persona: '离线合成人设',
    birthDate: '2000-01-01',
    voice: { profileId: 'synthetic-voice', version: 1, speed: 1.03, messageProbability: 0.17 },
    authorCanon: {
      kind: 'author_canon',
      settings: {
        selfIdentity: { names: ['测试人物', '保留别名'], truthScope: 'fictional_world', representsRealPerson: false },
        basicInfo: { birthDate: '2000-01-01' },
        speechExamples: ['保留样例'],
      },
    },
  });
  p.template.schedule.days[0][0]!.probability = 1 / 3;
  p.presentation = {
    displayName: '合成人物',
    publicDescription: '仅供离线测试',
    welcome: { text: '欢迎', version: 'welcome-v1' },
  };
  return p;
}
const flush = () => new Promise<void>((r) => setTimeout(r, 0));
function fixture(t: test.TestContext) {
  let cleanup = () => {};
  dom(t, () => cleanup());
  const root = new Element();
  let disposed = false,
    status = '';
  const original = profile(),
    draft = structuredClone(original);
  draft.template.version = 2;
  const detail: CharacterDetail = {
    characterId: 'jojo',
    published: { version: 1, profile: original },
    draft: {
      characterId: 'jojo',
      revision: 3,
      baseVersion: 1,
      profile: draft,
      contentHash: 'a'.repeat(64),
      savedAt: 1,
    },
    previews: [],
    previewAvailable: true,
  };
  let member: AdminMember = {
    id: 'owner',
    role: 'owner',
    label: '合成主管理员',
    email: null,
    createdAt: 1,
    permissions: [],
  };
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let respond: ((path: string, body: Record<string, unknown>) => Promise<unknown>) | null = null;
  const client = new CharacterAdminClient(async (path, body) => {
    requests.push({ path, body: structuredClone(body) });
    if (respond) return respond(path, body);
    if (path === 'list')
      return {
        characters: [
          {
            characterId: 'jojo',
            displayName: '合成人物',
            publishedVersion: detail.published?.version ?? null,
            draftRevision: detail.draft?.revision ?? null,
          },
        ],
        deletions: [],
      };
    if (path.endsWith('/detail')) return structuredClone(detail);
    if (path.endsWith('/save')) {
      detail.draft = {
        characterId: 'jojo',
        revision: (detail.draft?.revision ?? 0) + 1,
        baseVersion: detail.published?.version ?? null,
        profile: body.profile as CharacterProfile,
        contentHash: 'b'.repeat(64),
        savedAt: 2,
      };
      return detail.draft;
    }
    if (path.endsWith('/preview'))
      return {
        kind: 'profile-preview',
        externalCalls: false,
        draft: detail.draft,
        published: detail.published?.profile ?? null,
      };
    if (path.endsWith('/material-list')) return [];
    throw Error('unexpected fixture route ' + path);
  });
  const errors: unknown[] = [];
  const wb = characterWorkbench(root as unknown as HTMLElement, {
    api: client,
    member: () => member,
    disposed: () => disposed,
    status: (s) => (status = s),
    run: async (work) => {
      wb.update(true);
      try {
        await work();
      } catch (e) {
        errors.push(e);
        status = characterAdminError(e) ?? String(e);
      } finally {
        wb.update(false);
      }
    },
  });
  const button = (text: string) => {
    const n = all(root).find((n) => n.tagName === 'button' && n.textContent === text);
    assert.ok(n, 'button ' + text);
    return n;
  };
  const input = (label: string) => {
    const row = all(root).find(
      (n) => n.tagName === 'label' && n.children.some((c) => c.tagName === 'span' && c.textContent === label),
    );
    assert.ok(row, 'label ' + label);
    return row.children.find((c) => ['input', 'textarea', 'select'].includes(c.tagName))!;
  };
  const click = async (text: string) => {
    const b = button(text);
    assert.equal(b.disabled, false, 'enabled ' + text);
    b.fire();
    await flush();
  };
  cleanup = () => wb.dispose();
  return {
    root,
    wb,
    detail,
    requests,
    errors,
    button,
    input,
    click,
    status: () => status,
    respond: (fn: typeof respond) => (respond = fn),
    setMember: (next: AdminMember) => {
      member = next;
      wb.update(false);
    },
    member: () => member,
    open: async () => {
      await wb.load();
      await click('打开资料');
    },
    dispose: () => {
      disposed = true;
      wb.dispose();
    },
  };
}

// Part 23b: one unstyled text field for the Drama 3 voice direction, saved with the draft and shown in 资料改动.
const LABEL = '语音指引（Drama 3）';
const DIRECTION = '语速舒缓，句尾常拖长。';
const submit = async (f: ReturnType<typeof fixture>) => {
  all(f.root)
    .find((n) => n.tagName === 'form')!
    .fire('submit');
  await flush();
};
const savedProfile = (f: ReturnType<typeof fixture>) => {
  const saves = f.requests.filter((r) => r.path.endsWith('/save'));
  assert.ok(saves.length > 0, 'a save request');
  return saves.at(-1)!.body.profile as CharacterProfile;
};

test('direction field: labelled, with the one-line hint, empty for a profile without a direction', async (t) => {
  const f = fixture(t);
  await f.open();
  assert.equal(f.input(LABEL).value, '');
  assert.ok(f.root.textContent.includes('只写说话节奏和语气，如：语速舒缓，句尾常拖长。不写音高、音色或数字。'));
  assert.equal(DIRECTION_HINT, '只写说话节奏和语气，如：语速舒缓，句尾常拖长。不写音高、音色或数字。');
});

test('direction field: saved with the draft (trimmed), reloaded, and cleared back to an absent key', async (t) => {
  const f = fixture(t);
  await f.open();
  f.input(LABEL).value = `  ${DIRECTION}  `;
  f.input(LABEL).fire('input');
  await submit(f);
  assert.equal(savedProfile(f).template.voice!.direction, DIRECTION);
  assert.equal(savedProfile(f).template.voice!.messageProbability, 0.17, 'the rest of the binding is kept');
  await f.click('返回人物目录');
  await f.click('打开资料');
  assert.equal(f.input(LABEL).value, DIRECTION, 'reloaded from the saved draft');
  f.input(LABEL).value = '   ';
  f.input(LABEL).fire('input');
  await submit(f);
  assert.equal('direction' in savedProfile(f).template.voice!, false, 'blank = never set');
});

test('direction field: invalid text is refused locally with the hint and nothing is sent', async (t) => {
  const f = fixture(t);
  await f.open();
  for (const bad of ['[x]', '<x>', '好'.repeat(41), '一\n二']) {
    const before = f.requests.length;
    f.input(LABEL).value = bad;
    f.input(LABEL).fire('input');
    await submit(f);
    assert.equal(f.requests.length, before, `no request for ${JSON.stringify(bad)}`);
    assert.ok(f.status().includes(DIRECTION_HINT), `hint shown for ${JSON.stringify(bad)}: ${f.status()}`);
  }
  // Exactly 40 characters is fine.
  f.input(LABEL).value = '好'.repeat(40);
  f.input(LABEL).fire('input');
  await submit(f);
  assert.equal(savedProfile(f).template.voice!.direction, '好'.repeat(40));
});

test('direction field: a server refusal shows the same hint', () => {
  assert.ok(characterAdminError(new InviteLocalApiError(400, 'INVALID_VOICE_BINDING'))!.includes(DIRECTION_HINT));
});

test('direction shows in 资料改动 when the draft differs from the published profile', async (t) => {
  const f = fixture(t);
  f.detail.draft!.profile.template.voice!.direction = DIRECTION;
  await f.open();
  await f.click('比较已存草稿与正式资料');
  const text = f.root.textContent;
  assert.ok(text.includes('语音指引'), 'its own group');
  assert.ok(text.includes(DIRECTION));
  assert.ok(text.includes('（无）'), 'the published side had none');
});

test('direction: a profile that never had one renders and reads back exactly as before', (t) => {
  dom(t);
  const root = new Element(),
    base = profile(),
    before = structuredClone(base),
    form = characterForm(
      root as unknown as HTMLElement,
      base,
      false,
      () => {},
      (e) => {
        throw e;
      },
    );
  assert.deepEqual(form.read(), before);
  assert.equal(JSON.stringify(form.read()).includes('direction'), false);
});
